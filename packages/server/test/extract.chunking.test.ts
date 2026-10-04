import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { checkChunking, chunkSource, sampleEvenly, splitSpans } from "../src/extract/chunking.js";
import type { Chunk } from "../src/extract/chunking.js";

const HASH = "sha256:" + "cd".repeat(32);

/** Deterministic prose: sentences of varying length in paragraphs. */
function prose(sentences: number): string {
  const words = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota", "kappa"];
  const out: string[] = [];
  for (let i = 0; i < sentences; i++) {
    const len = 4 + ((i * 7) % 11);
    const s = Array.from({ length: len }, (_, k) => words[(i + k * 3) % words.length]).join(" ");
    out.push(`Sentence ${i} says ${s}.`);
    if (i % 6 === 5) out.push("\n\n");
    else out.push(" ");
  }
  return out.join("");
}

function reconstruct(chunks: readonly Chunk[]): string {
  let text = chunks[0]?.text ?? "";
  for (let i = 1; i < chunks.length; i++) {
    const prev = chunks[i - 1]!;
    const c = chunks[i]!;
    text += c.text.slice(prev.span[1] - c.span[0]);
  }
  return text;
}

const sha = (s: string): string => "sha256:" + createHash("sha256").update(s, "utf8").digest("hex");

describe("chunking", () => {
  const text = prose(120);

  it("spans reconstruct the source text exactly", () => {
    const plan = chunkSource({ source_file_id: "file_a", source_hash: HASH, text }, { maxChars: 300, overlapChars: 60, maxChunks: 1000 });
    expect(plan.sampled).toBe(false);
    expect(plan.chunks.length).toBeGreaterThan(5);
    const chunks = plan.chunks;
    expect(chunks[0]!.span[0]).toBe(0);
    expect(chunks.at(-1)!.span[1]).toBe(text.length);
    for (const [i, c] of chunks.entries()) {
      expect(c.text).toBe(text.slice(c.span[0], c.span[1]));
      expect(c.text.length).toBeLessThanOrEqual(300);
      expect(c.index).toBe(i);
      expect(c.source_hash).toBe(HASH);
      expect(c.source_file_id).toBe("file_a");
      if (i > 0) {
        expect(c.span[0]).toBeGreaterThan(chunks[i - 1]!.span[0]);
        expect(c.span[0]).toBeLessThanOrEqual(chunks[i - 1]!.span[1]);
      }
    }
    expect(reconstruct(chunks)).toBe(text);
  });

  it("cuts at sentence boundaries and starts overlaps at a sentence (else a word) start", () => {
    // Overlap window wider than any sentence: every chunk starts a sentence.
    const wide = chunkSource({ source_file_id: "f", source_hash: HASH, text }, { maxChars: 400, overlapChars: 150, maxChunks: 1000 });
    for (const c of wide.chunks.slice(0, -1)) expect(c.text.trimEnd()).toMatch(/\.$/);
    for (const c of wide.chunks.slice(1)) {
      expect(c.text).toMatch(/^Sentence \d+/);
      expect(c.span[0]).toBeLessThan(wide.chunks[c.index - 1]!.span[1]);
    }
    // Narrow window: the overlap starts at a word, never mid-word.
    const narrow = chunkSource({ source_file_id: "f", source_hash: HASH, text }, { maxChars: 300, overlapChars: 60, maxChunks: 1000 });
    for (const c of narrow.chunks.slice(0, -1)) expect(c.text.trimEnd()).toMatch(/\.$/);
    for (const c of narrow.chunks.slice(1)) expect(text[c.span[0] - 1]).toMatch(/\s/);
  });

  it("overlaps consecutive chunks by at most overlapChars", () => {
    const spans = splitSpans(text, 300, 60);
    const overlaps = spans.slice(1).map((s, i) => spans[i]![1] - s[0]);
    expect(overlaps.some((o) => o > 0)).toBe(true);
    for (const o of overlaps) {
      expect(o).toBeGreaterThanOrEqual(0);
      expect(o).toBeLessThanOrEqual(60);
    }
    const none = splitSpans(text, 300, 0);
    for (let i = 1; i < none.length; i++) expect(none[i]![0]).toBe(none[i - 1]![1]);
  });

  it("is deterministic, with IDs derived from the source hash and span", () => {
    const a = chunkSource({ source_file_id: "f", source_hash: HASH, text }, { maxChars: 250, overlapChars: 40 });
    const b = chunkSource({ source_file_id: "f", source_hash: HASH, text }, { maxChars: 250, overlapChars: 40 });
    expect(b).toEqual(a);
    const ids = a.chunks.map((c) => c.chunk_id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of a.chunks) {
      expect(c.chunk_id).toMatch(/^chk_[0-9a-f]{24}$/);
      expect(c.chunk_hash).toBe(sha(c.text));
    }
    const other = chunkSource({ source_file_id: "f", source_hash: "sha256:" + "ef".repeat(32), text }, { maxChars: 250, overlapChars: 40 });
    expect(other.chunks.map((c) => c.chunk_id)).not.toEqual(ids);
  });

  it("samples evenly above the cap and records it in the plan", () => {
    const full = chunkSource({ source_file_id: "f", source_hash: HASH, text }, { maxChars: 120, overlapChars: 0, maxChunks: 10_000 });
    const capped = chunkSource({ source_file_id: "f", source_hash: HASH, text }, { maxChars: 120, overlapChars: 0, maxChunks: 5 });
    expect(full.total_chunks).toBeGreaterThan(5);
    expect(capped.total_chunks).toBe(full.total_chunks);
    expect(capped.sampled).toBe(true);
    expect(capped.chunks).toHaveLength(5);
    expect(capped.selected_indices[0]).toBe(0);
    expect(capped.selected_indices.at(-1)).toBe(full.total_chunks - 1);
    for (const c of capped.chunks) expect(c).toEqual(full.chunks[c.index]);
    expect(sampleEvenly(9, 3)).toEqual([0, 4, 8]);
    expect(sampleEvenly(3, 5)).toEqual([0, 1, 2]);
    expect(sampleEvenly(7, 1)).toEqual([0]);
  });

  it("never splits a surrogate pair and handles CJK sentence ends", () => {
    const emoji = "\u{1F600}".repeat(40);
    for (const [s, e] of splitSpans(emoji, 7, 2)) {
      const piece = emoji.slice(s, e);
      expect(piece).toBe(Array.from(piece).join(""));
      expect(piece.length % 2).toBe(0);
    }
    const zh = "今天开会。".repeat(30);
    const spans = splitSpans(zh, 40, 0);
    for (const [, e] of spans.slice(0, -1)) expect(zh[e - 1]).toBe("。");
  });

  it("validates its options and handles empty text", () => {
    expect(() => checkChunking({ maxChars: 100, overlapChars: 100 })).toThrow(/smaller than maxChars/);
    expect(() => checkChunking({ maxChars: 0 })).toThrow(/maxChars/);
    expect(() => checkChunking({ maxChunks: 1.5 })).toThrow(/maxChunks/);
    const empty = chunkSource({ source_file_id: "f", source_hash: HASH, text: "" });
    expect(empty).toMatchObject({ total_chunks: 0, sampled: false, chunks: [] });
  });
});
