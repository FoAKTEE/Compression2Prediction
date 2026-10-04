/** Counter-based random streams (mission invariant 11). */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { categorical, createStream, splitMix64At, STREAM_SCHEMA, streamSeed } from "../src/numeric/random.js";
import { canonicalJson } from "../src/store/records.js";
import { raises } from "./support.js";

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
const KEY = '["scn","x","ent",3]';

describe("streamSeed", () => {
  it("is sha256 over the canonical bytes (vector computed independently with Python hashlib)", () => {
    const seed = streamSeed(42, [0, 1], KEY, "draw");
    expect(hex(seed)).toBe("fd4aead0c0b1bdbc993a8a8c695d5879deb7d096c176c983372a3a26d4bdcedb");
    const text = '["c2p.stream.v1",42,[0,1],"[\\"scn\\",\\"x\\",\\"ent\\",3]","draw"]';
    expect(hex(seed)).toBe(createHash("sha256").update(text, "utf8").digest("hex"));
  });

  it("hashes exactly the canonical JSON array, escapes and non-ASCII included", () => {
    const cases: [number, (string | number)[], string, string][] = [
      [0, [], "", "draw"],
      [9007199254740991, ["r\u00e9plique", 3, "a\"b\\c"], '["scn","\u4e16\u754c","ent",0]', "parameter_draw"],
      [7, ["\n\t\u0001", 0], "\ud83d\ude00", "p"],
    ];
    for (const [seed, lineage, key, purpose] of cases) {
      const expected = createHash("sha256").update(canonicalJson([STREAM_SCHEMA, seed, lineage, key, purpose]), "utf8").digest("hex");
      expect(hex(streamSeed(seed, lineage, key, purpose))).toBe(expected);
    }
    raises(() => streamSeed(1, [], "\ud800", "draw"), /lone surrogate/);
  });

  it("changes with each of run seed, lineage, key, and purpose", () => {
    const base = hex(streamSeed(42, [0, 1], KEY, "draw"));
    const variants = [
      streamSeed(43, [0, 1], KEY, "draw"),
      streamSeed(42, [1, 0], KEY, "draw"),
      streamSeed(42, [0, 1, 0], KEY, "draw"),
      streamSeed(42, [0, 1], '["scn","x","ent",4]', "draw"),
      streamSeed(42, [0, 1], KEY, "parameter_draw"),
    ].map(hex);
    expect(new Set([base, ...variants]).size).toBe(6);
  });

  it("rejects non-canonical inputs", () => {
    raises(() => streamSeed(-1, [], KEY, "draw"), /run seed/);
    raises(() => streamSeed(1.5, [], KEY, "draw"), /run seed/);
    raises(() => streamSeed(1, [-1], KEY, "draw"), /lineage\[0\]/);
    raises(() => streamSeed(1, [], KEY, ""), /purpose/);
  });
});

describe("createStream", () => {
  it("reproduces the published SplitMix64 vectors", () => {
    const s0 = createStream(0n);
    expect([s0.nextUint64(), s0.nextUint64(), s0.nextUint64(), s0.nextUint64()]).toStrictEqual([
      0xe220a8397b1dcdafn,
      0x6e789e6aa1b965f4n,
      0x06c45d188009454fn,
      0xf88bb8a8724c81ecn,
    ]);
    const s1 = createStream(1234567n);
    expect(s1.nextUint64()).toBe(6457827717110365317n);
    expect(s1.nextUint64()).toBe(3203168211198807973n);
    expect(s1.draws).toBe(2);
    // Counter-based: output i depends only on (state, i).
    expect(splitMix64At(1234567n, 1n)).toBe(3203168211198807973n);
  });

  it("the 32-bit limb stream equals the BigInt reference", () => {
    const states = [0n, 1n, 0xffffffffn, 0x100000000n, (1n << 64n) - 1n, 0x8000000080000000n, 0xfd4aead0c0b1bdbcn];
    const pick = createStream(streamSeed(1, ["states"], "", "test"));
    for (let i = 0; i < 40; i++) states.push(pick.nextUint64());
    for (const state of states) {
      const s = createStream(state);
      for (let i = 0n; i < 64n; i++) {
        const z = splitMix64At(state, i);
        expect(s.nextUint64()).toBe(z);
      }
      const f = createStream(state);
      const w = createStream(state);
      for (let i = 0n; i < 8n; i++) {
        const z = splitMix64At(state, i);
        expect(f.nextFloat()).toBe(Number(z >> 11n) * 2 ** -53);
        expect(w.nextUint32()).toBe(Number(z >> 32n));
      }
    }
  });

  it("fixed digest seeds give fixed floats and words (vectors from the Python reference)", () => {
    const a = createStream(streamSeed(42, [0, 1], KEY, "draw"));
    expect([a.nextFloat(), a.nextFloat(), a.nextFloat()]).toStrictEqual([0.2360730865747973, 0.7735433424342357, 0.5748455889181042]);
    const b = createStream(streamSeed(42, [0, 1], KEY, "draw"));
    expect([b.nextUint32(), b.nextUint32(), b.nextUint32()]).toStrictEqual([1013926186, 3322343357, 2468943004]);
  });

  it("passes a cheap uniformity check", () => {
    const s = createStream(streamSeed(7, ["uniformity"], "", "test"));
    const n = 100_000;
    const bins = new Array<number>(10).fill(0);
    let sum = 0;
    let lo = 1;
    let hi = 0;
    let inRange = true;
    for (let i = 0; i < n; i++) {
      const u = s.nextFloat();
      inRange &&= u >= 0 && u < 1;
      bins[Math.floor(u * 10)]!++;
      sum += u;
      lo = Math.min(lo, u);
      hi = Math.max(hi, u);
    }
    expect(inRange).toBe(true);
    const chi2 = bins.reduce((acc, c) => acc + (c - n / 10) ** 2 / (n / 10), 0);
    expect(chi2).toBeLessThan(37.7); // chi-square, 9 dof, p = 1e-5
    expect(Math.abs(sum / n - 0.5)).toBeLessThan(0.005);
    expect(lo).toBeLessThan(1e-3);
    expect(hi).toBeGreaterThan(1 - 1e-3);
    const w = createStream(9n);
    const words = Array.from({ length: 1000 }, () => w.nextUint32());
    expect(words.every((x) => Number.isInteger(x) && x >= 0 && x < 2 ** 32)).toBe(true);
  });

  it("rejects short or bad seeds", () => {
    raises(() => createStream(new Uint8Array(7)), /at least 8 bytes/);
    raises(() => createStream(-1n), /64-bit/);
    raises(() => createStream(1n << 64n), /64-bit/);
  });
});

describe("categorical", () => {
  it("is inverse-CDF sampling and never returns a zero-probability index", () => {
    // u = 0.2360..., 0.7735..., 0.5748...
    const draw = () => createStream(streamSeed(42, [0, 1], KEY, "draw"));
    expect(categorical(draw(), [0.2, 0.8])).toBe(1);
    expect(categorical(draw(), [0.3, 0.7])).toBe(0);
    expect(categorical(draw(), [0, 0.2360730865747973, 0, 0.7639269134252027])).toBe(3);
    expect(categorical(draw(), [0, 1, 0])).toBe(1);
    const s = createStream(streamSeed(3, [], "", "freq"));
    const counts = [0, 0, 0, 0];
    const p = [0.1, 0, 0.6, 0.3];
    const n = 50_000;
    for (let i = 0; i < n; i++) counts[categorical(s, p)]!++;
    expect(counts[1]).toBe(0);
    counts.forEach((c, j) => expect(Math.abs(c / n - p[j]!)).toBeLessThan(0.01));
  });

  it("rejects invalid weights", () => {
    const s = createStream(1n);
    raises(() => categorical(s, []), /nonempty/);
    raises(() => categorical(s, [0, 0]), /total mass is zero/);
    raises(() => categorical(s, [0.5, -0.1]), /nonnegative/);
    raises(() => categorical(s, [NaN, 1]), /finite/);
  });
});
