/**
 * Deterministic sentence-boundary chunking with overlap.
 *
 * A chunk is exactly `text.slice(start, end)` of the decoded source text (no
 * trimming), so spans reconstruct the source: the first chunk starts at 0,
 * the last ends at `text.length`, and each chunk starts inside or at the end
 * of the previous one. Offsets are UTF-16 code units of the decoded text, and
 * a cut never splits a surrogate pair.
 *
 * A chunk ends at the last sentence boundary within the character budget (or
 * the last whitespace, or a hard cut), and the next chunk starts at the first
 * sentence boundary inside the overlap window. When a document has more
 * chunks than `maxChunks`, an evenly spaced subset (always including the first
 * and last chunk) is selected and the plan says so.
 */
import { sha256Text, stableId } from "./hashing.js";

export interface ChunkingOptions {
  /** Character budget per chunk. */
  readonly maxChars: number;
  /** Maximum characters shared by consecutive chunks (< maxChars). */
  readonly overlapChars: number;
  /** Per-document cap; above it chunks are sampled evenly. */
  readonly maxChunks: number;
}

export const DEFAULT_CHUNKING: ChunkingOptions = Object.freeze({ maxChars: 4000, overlapChars: 400, maxChunks: 50 });

export const CHUNK_SCHEMA = "chunk.v1";

export interface SourceText {
  readonly source_file_id: string;
  /** `sha256:<hex>` of the file bytes. */
  readonly source_hash: string;
  readonly text: string;
}

export interface Chunk {
  readonly chunk_id: string;
  readonly source_file_id: string;
  readonly source_hash: string;
  /** Position among all chunks of the document (before sampling). */
  readonly index: number;
  /** Half-open `[start, end)` in the decoded source text. */
  readonly span: readonly [number, number];
  readonly text: string;
  /** `sha256:<hex>` of the chunk text. */
  readonly chunk_hash: string;
}

export interface ChunkPlan {
  readonly source_file_id: string;
  readonly source_hash: string;
  readonly text_length: number;
  /** Chunks before sampling. */
  readonly total_chunks: number;
  /** True when `total_chunks > maxChunks` and only a subset is kept. */
  readonly sampled: boolean;
  readonly selected_indices: readonly number[];
  readonly chunks: readonly Chunk[];
}

export function checkChunking(options: Partial<ChunkingOptions> = {}): ChunkingOptions {
  const o = { ...DEFAULT_CHUNKING, ...options };
  const int = (v: unknown, name: string, min: number): number => {
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min) {
      throw new RangeError(`chunking ${name}: expected an integer >= ${min}, got ${String(v)}`);
    }
    return v;
  };
  const maxChars = int(o.maxChars, "maxChars", 1);
  const overlapChars = int(o.overlapChars, "overlapChars", 0);
  if (overlapChars >= maxChars) throw new RangeError("chunking overlapChars must be smaller than maxChars");
  return Object.freeze({ maxChars, overlapChars, maxChunks: int(o.maxChunks, "maxChunks", 1) });
}

// A run of terminal punctuation (optionally closed by quotes/brackets) followed
// by whitespace, a CJK full stop, or a blank line. A boundary is the index just
// after the match, i.e. where the next sentence starts.
const SENTENCE_END = /[.!?…]+["'”’)\]]*\s+|[。！？]+["'”’」』)\]]*\s*|\n[ \t]*\n\s*/g;

function sentenceBoundaries(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(SENTENCE_END)) {
    const b = m.index + m[0].length;
    if (b > 0 && b <= text.length && out[out.length - 1] !== b) out.push(b);
  }
  return out;
}

/** Largest boundary in [lo, hi], or null. */
function lastIn(sorted: readonly number[], lo: number, hi: number): number | null {
  let left = 0;
  let right = sorted.length - 1;
  let found: number | null = null;
  while (left <= right) {
    const mid = (left + right) >> 1;
    if (sorted[mid]! <= hi) {
      if (sorted[mid]! >= lo) found = sorted[mid]!;
      left = mid + 1;
    } else {
      right = mid - 1;
    }
  }
  return found;
}

/** Smallest boundary in [lo, hi], or null. */
function firstIn(sorted: readonly number[], lo: number, hi: number): number | null {
  let left = 0;
  let right = sorted.length - 1;
  let found: number | null = null;
  while (left <= right) {
    const mid = (left + right) >> 1;
    if (sorted[mid]! >= lo) {
      if (sorted[mid]! <= hi) found = sorted[mid]!;
      right = mid - 1;
    } else {
      left = mid + 1;
    }
  }
  return found;
}

const isSpace = (ch: string | undefined): boolean => ch !== undefined && /\s/.test(ch);

/** A position p in [lo, hi] just after whitespace (scanning down or up), or null. */
function wordBoundary(text: string, lo: number, hi: number, fromEnd: boolean): number | null {
  if (fromEnd) {
    for (let p = hi; p >= lo; p--) if (p > 0 && isSpace(text[p - 1]) && !isSpace(text[p])) return p;
  } else {
    for (let p = lo; p <= hi; p++) if (p > 0 && isSpace(text[p - 1]) && !isSpace(text[p])) return p;
  }
  return null;
}

/** Move a cut off the middle of a surrogate pair (backwards, staying above `floor`). */
function safeCut(text: string, i: number, floor: number): number {
  if (i <= 0 || i >= text.length) return i;
  const hi = text.charCodeAt(i - 1);
  const lo = text.charCodeAt(i);
  const splits = hi >= 0xd800 && hi <= 0xdbff && lo >= 0xdc00 && lo <= 0xdfff;
  if (!splits) return i;
  return i - 1 > floor ? i - 1 : i + 1;
}

/** `[start, end)` spans covering `text` (empty text gives no spans). */
export function splitSpans(text: string, maxChars: number, overlapChars: number): [number, number][] {
  const n = text.length;
  const spans: [number, number][] = [];
  if (n === 0) return spans;
  const sentences = sentenceBoundaries(text);
  const minLen = Math.max(1, Math.floor(maxChars * 0.3));
  let start = 0;
  for (;;) {
    if (n - start <= maxChars) {
      spans.push([start, n]);
      return spans;
    }
    const hard = safeCut(text, start + maxChars, start);
    const end =
      lastIn(sentences, start + minLen, hard) ?? wordBoundary(text, start + minLen, hard, true) ?? hard;
    spans.push([start, end]);
    // Overlap window [lo, end): never step back more than half the chunk, so
    // every chunk advances by at least half its length.
    const lo = Math.max(end - overlapChars, start + Math.ceil((end - start) / 2));
    let next = end;
    if (overlapChars > 0 && lo < end) {
      next = firstIn(sentences, lo, end - 1) ?? wordBoundary(text, lo, end - 1, false) ?? safeCut(text, lo, start);
    }
    start = next > start ? next : end;
  }
}

/** `cap` indices spread evenly over `0..total-1`, first and last included. */
export function sampleEvenly(total: number, cap: number): number[] {
  if (total <= cap) return Array.from({ length: total }, (_, i) => i);
  if (cap === 1) return [0];
  const out: number[] = [];
  for (let i = 0; i < cap; i++) {
    const idx = Math.round((i * (total - 1)) / (cap - 1));
    if (out[out.length - 1] !== idx) out.push(idx);
  }
  return out;
}

export function chunkId(sourceHash: string, span: readonly [number, number]): string {
  return stableId("chk", [CHUNK_SCHEMA, sourceHash, span[0], span[1]]);
}

/** Chunk one decoded document; sampling is applied above `maxChunks`. */
export function chunkSource(source: SourceText, options: Partial<ChunkingOptions> = {}): ChunkPlan {
  const o = checkChunking(options);
  const spans = splitSpans(source.text, o.maxChars, o.overlapChars);
  const selected = sampleEvenly(spans.length, o.maxChunks);
  const chunks = selected.map((index): Chunk => {
    const span = spans[index]!;
    const text = source.text.slice(span[0], span[1]);
    return Object.freeze({
      chunk_id: chunkId(source.source_hash, span),
      source_file_id: source.source_file_id,
      source_hash: source.source_hash,
      index,
      span: Object.freeze([span[0], span[1]] as const),
      text,
      chunk_hash: sha256Text(text),
    });
  });
  return Object.freeze({
    source_file_id: source.source_file_id,
    source_hash: source.source_hash,
    text_length: source.text.length,
    total_chunks: spans.length,
    sampled: selected.length < spans.length,
    selected_indices: Object.freeze(selected),
    chunks: Object.freeze(chunks),
  });
}
