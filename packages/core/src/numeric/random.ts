/**
 * Counter-based deterministic random streams (mission invariant 11).
 *
 * A stream seed is sha256 over the canonical JSON bytes of
 * ``["c2p.stream.v1", run_seed, lineage, key, purpose]``; process-dependent
 * hashing and the platform PRNG are never used. A stream is SplitMix64 (Steele,
 * Lea, Flood 2014; Vigna's ``splitmix64.c``): output i is
 * ``mix64(state + (i + 1) * 0x9E3779B97F4A7C15) mod 2^64``, so every draw is a
 * pure function of (seed, counter). The 64-bit state is the first 8 digest
 * bytes, big-endian. Streams run on 32-bit limbs; ``splitMix64At`` is the
 * BigInt reference they are tested against.
 */
import { createHash } from "node:crypto";
import { ValueError } from "../errors.js";
import { isWellFormed } from "../store/records.js";
import { repr } from "../store/repr.js";

export const STREAM_SCHEMA = "c2p.stream.v1";
export const SPLITMIX64_GAMMA = 0x9e3779b97f4a7c15n;
const MASK64 = (1n << 64n) - 1n;
const TWO_POW_MINUS_53 = 2 ** -53;

export type Lineage = readonly (string | number)[];

/** One counter-based stream; no ``then`` member. */
export interface RandomStream {
  /** Next raw 64-bit output. */
  nextUint64(): bigint;
  /** High 32 bits of the next output. */
  nextUint32(): number;
  /** 53-bit double in [0, 1) from the next output. */
  nextFloat(): number;
  /** Outputs consumed so far (the counter). */
  readonly draws: number;
}

function text(value: unknown, field: string, allowEmpty: boolean): string {
  if (typeof value !== "string" || (!allowEmpty && value === "")) {
    throw new ValueError(`${field}: expected a ${allowEmpty ? "" : "nonempty "}string, got ${repr(value)}`);
  }
  if (!isWellFormed(value)) throw new ValueError(`${field}: lone surrogate in ${repr(value)}`);
  return JSON.stringify(value);
}

function natural(value: unknown, field: string): string {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ValueError(`${field}: expected a nonnegative safe integer, got ${repr(value)}`);
  }
  return String(value === 0 ? 0 : value);
}

/**
 * sha256(canonical bytes of run seed, particle lineage, variable key, draw
 * purpose). The text is built directly; it equals ``canonicalJson`` of the
 * same array for these types (strings, nonnegative safe integers).
 */
export function streamSeed(runSeed: number, lineage: Lineage, keyString: string, purpose: string): Uint8Array {
  const seed = natural(runSeed, "run seed");
  if (!Array.isArray(lineage)) throw new ValueError(`lineage: expected an array, got ${repr(lineage)}`);
  const parts = lineage.map((item, i) => (typeof item === "string" ? text(item, `lineage[${i}]`, true) : natural(item, `lineage[${i}]`)));
  const bytes = `[${JSON.stringify(STREAM_SCHEMA)},${seed},[${parts.join(",")}],${text(keyString, "key", true)},${text(purpose, "purpose", false)}]`;
  return new Uint8Array(createHash("sha256").update(bytes, "utf8").digest());
}

/** SplitMix64 output at counter ``index`` (BigInt reference). */
export function splitMix64At(state: bigint, index: bigint): bigint {
  let z = (state + (index + 1n) * SPLITMIX64_GAMMA) & MASK64;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64;
  return z ^ (z >> 31n);
}

const G_HI = 0x9e3779b9;
const G_LO = 0x7f4a7c15;
const M1_HI = 0xbf58476d;
const M1_LO = 0x1ce4e5b9;
const M2_HI = 0x94d049bb;
const M2_LO = 0x133111eb;

/** SplitMix64 on two uint32 limbs; ``hi``/``lo`` hold the last output. */
class SplitMix64 implements RandomStream {
  private sHi: number;
  private sLo: number;
  private count = 0;
  private hi = 0;
  private lo = 0;

  constructor(state: bigint) {
    this.sHi = Number(state >> 32n);
    this.sLo = Number(state & 0xffffffffn);
  }

  /** z = (aHi:aLo) * (bHi:bLo) mod 2^64 into hi/lo. */
  private mul(aHi: number, aLo: number, bHi: number, bLo: number): void {
    const a0 = aLo & 0xffff;
    const a1 = aLo >>> 16;
    const b0 = bLo & 0xffff;
    const b1 = bLo >>> 16;
    const p00 = a0 * b0;
    const p01 = a0 * b1;
    const p10 = a1 * b0;
    const mid = (p00 >>> 16) + (p01 & 0xffff) + (p10 & 0xffff);
    const lo = (((mid & 0xffff) << 16) | (p00 & 0xffff)) >>> 0;
    const hi = a1 * b1 + (p01 >>> 16) + (p10 >>> 16) + (mid >>> 16);
    this.hi = (hi + Math.imul(aHi, bLo) + Math.imul(aLo, bHi)) >>> 0;
    this.lo = lo;
  }

  private step(): void {
    const sum = this.sLo + G_LO;
    this.sLo = sum >>> 0;
    this.sHi = (this.sHi + G_HI + (sum > 0xffffffff ? 1 : 0)) >>> 0;
    this.count++;
    let hi = this.sHi;
    let lo = this.sLo;
    lo = (lo ^ ((lo >>> 30) | (hi << 2))) >>> 0;
    hi = (hi ^ (hi >>> 30)) >>> 0;
    this.mul(hi, lo, M1_HI, M1_LO);
    hi = this.hi;
    lo = this.lo;
    lo = (lo ^ ((lo >>> 27) | (hi << 5))) >>> 0;
    hi = (hi ^ (hi >>> 27)) >>> 0;
    this.mul(hi, lo, M2_HI, M2_LO);
    hi = this.hi;
    lo = this.lo;
    this.lo = (lo ^ ((lo >>> 31) | (hi << 1))) >>> 0;
    this.hi = (hi ^ (hi >>> 31)) >>> 0;
  }

  nextUint64(): bigint {
    this.step();
    return (BigInt(this.hi) << 32n) | BigInt(this.lo);
  }

  nextUint32(): number {
    this.step();
    return this.hi;
  }

  nextFloat(): number {
    this.step();
    return (this.hi * 2097152 + (this.lo >>> 11)) * TWO_POW_MINUS_53;
  }

  get draws(): number {
    return this.count;
  }
}

/** A stream from a digest (first 8 bytes, big-endian) or an explicit 64-bit state. */
export function createStream(seed: Uint8Array | bigint): RandomStream {
  if (typeof seed === "bigint") {
    if (seed < 0n || seed > MASK64) throw new ValueError(`stream state: expected a 64-bit unsigned integer, got ${seed}`);
    return new SplitMix64(seed);
  }
  if (!(seed instanceof Uint8Array)) throw new ValueError(`stream seed: expected bytes or a bigint, got ${repr(seed)}`);
  if (seed.length < 8) throw new ValueError(`stream seed: expected at least 8 bytes, got ${seed.length}`);
  let state = 0n;
  for (let i = 0; i < 8; i++) state = (state << 8n) | BigInt(seed[i]!);
  return new SplitMix64(state);
}

/**
 * Inverse-CDF draw: the first index whose cumulative mass exceeds u * total.
 * Weights must be finite and nonnegative with a positive sum; zero-weight
 * indices are never returned. Weights are first scaled by a power of two
 * near 1 / max (exact barring underflow, so draws of ordinary weights are
 * unchanged), so finite weights never overflow their sum.
 */
export function categorical(stream: RandomStream, probs: readonly number[]): number {
  if (!Array.isArray(probs) || probs.length === 0) throw new ValueError(`probabilities: expected a nonempty array, got ${repr(probs)}`);
  let max = 0;
  let last = -1;
  for (let j = 0; j < probs.length; j++) {
    const p = probs[j]!;
    if (typeof p !== "number" || !Number.isFinite(p) || p < 0) {
      throw new ValueError(`probabilities[${j}]: expected a finite nonnegative number, got ${repr(p)}`);
    }
    if (p > max) max = p;
    if (p > 0) last = j;
  }
  if (!(max > 0)) throw new ValueError("probabilities: total mass is zero");
  // 2^shift * max lies in [1/2, 4); |shift| <= 1023 keeps the factor finite.
  const shift = Math.min(1023, Math.max(-1023, -Math.floor(Math.log2(max))));
  const scale = 2 ** shift;
  const scaled = probs.map((p) => p * scale);
  let total = 0;
  for (const w of scaled) total += w;
  if (!Number.isFinite(total) || !(total > 0)) throw new ValueError(`probabilities: scaled total ${total} is not a positive finite number`);
  const u = stream.nextFloat() * total;
  let cum = 0;
  for (let j = 0; j < scaled.length; j++) {
    cum += scaled[j]!;
    if (u < cum) return j;
  }
  return last; // rounding left u at the total
}
