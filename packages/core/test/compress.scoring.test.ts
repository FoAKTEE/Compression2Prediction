import { describe, expect, it } from "vitest";
import {
  dirichletMultinomialBits,
  modelBits,
  prequentialBits,
  prequentialCodeLengths,
  structureBits,
} from "../src/compress/index.js";
import type { FamilyPrior } from "../src/compress/index.js";
import { Space } from "../src/kernels.js";
import { SparseRows } from "../src/learn/index.js";
import type { CountDatum, FamilyKeyLike } from "../src/learn/index.js";
import { lgamma } from "../src/numeric/lgamma.js";
import { Rational } from "../src/numeric/rational.js";
import { raises } from "./support.js";

const R = (n: number, d = 1) => Rational.of(n, d);

function familyKey(template: string): FamilyKeyLike {
  return {
    template,
    kind: "Person",
    role: "operator",
    interface_hash: "sha256:" + "c".repeat(64),
    regime: "normal",
    data_origin_partition: "simulated",
  };
}

const KEY_A = familyKey("tpl_a");
const KEY_B = familyKey("tpl_b");

function datum(i: number, key: FamilyKeyLike, context: number, outcome: number, extra: Partial<CountDatum> = {}): CountDatum {
  return { record_id: `r${i}`, key, entity_id: `e${i % 5}`, context, outcome, origin: "simulated", episode_id: "run", ...extra };
}

/** Deterministic linear congruential stream for fixtures. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const BIT = new Space("Bit", ["0", "1"]);
const TRI = new Space("Tri", ["a", "b", "c"]);

describe("prequential scoring", () => {
  it("reproduces the memo appendix sequence (0,1,1,0,1), q = (1/2, 1/2), alpha = 2", () => {
    const prior = new SparseRows({
      source: BIT,
      target: BIT,
      support: [0, 1],
      default_prior: [R(1, 2), R(1, 2)],
      strength: R(2),
      prior_overrides: [],
      counts: [],
    });
    const data = [0, 1, 1, 0, 1].map((y, i) => datum(i, KEY_A, 0, y));
    const priors: FamilyPrior[] = [[KEY_A, prior]];
    // Predictives 1/2, 1/3, 2/4, 2/5, 3/6.
    const expected = [1 / 2, 1 / 3, 2 / 4, 2 / 5, 3 / 6].map((p) => -Math.log2(p));
    expect(prequentialCodeLengths(data, priors)).toEqual(expected);
    const sequential = prequentialBits(data, priors);
    expect(Math.abs(sequential - dirichletMultinomialBits(data, priors))).toBeLessThan(1e-12);
    expect(sequential).toBeCloseTo(-Math.log2(1 / 2 * 1 / 3 * 2 / 4 * 2 / 5 * 3 / 6), 12);
  });

  it("test_prequential_gamma", () => {
    // Family A: 3 contexts x 3 outcomes, full support. Family B: support {0, 2}, one row override.
    const tableA = new SparseRows({
      source: TRI,
      target: TRI,
      support: [0, 1, 2],
      default_prior: [R(1, 2), R(1, 3), R(1, 6)],
      strength: R(3, 2),
      prior_overrides: [],
      counts: [],
    });
    const tableB = new SparseRows({
      source: BIT,
      target: TRI,
      support: [0, 2],
      default_prior: [R(1, 2), R(0), R(1, 2)],
      strength: R(5),
      prior_overrides: [[1, [R(9, 10), R(0), R(1, 10)]]],
      counts: [],
    });
    const priors: FamilyPrior[] = [
      [KEY_A, tableA],
      [KEY_B, tableB],
    ];
    const next = lcg(20261004);
    const data: CountDatum[] = [];
    for (let i = 0; i < 600; i++) {
      if (next() < 0.5) {
        const c = Math.floor(next() * 3);
        const u = next();
        data.push(datum(i, KEY_A, c, u < 0.6 ? c : u < 0.85 ? (c + 1) % 3 : (c + 2) % 3));
      } else {
        const c = Math.floor(next() * 2);
        data.push(datum(i, KEY_B, c, next() < (c === 0 ? 0.3 : 0.8) ? 0 : 2));
      }
    }
    const contexts = new Set(data.map((d) => `${d.key.template}:${d.context}`));
    expect(contexts.size).toBe(5); // interleaved across both families and all contexts

    const sequential = prequentialBits(data, priors);
    const closed = dirichletMultinomialBits(data, priors);
    expect(Math.abs(sequential - closed)).toBeLessThanOrEqual(1e-9);
    // Exchangeable: any order gives the same total.
    expect(Math.abs(prequentialBits([...data].reverse(), priors) - closed)).toBeLessThanOrEqual(1e-9);

    // No count coefficient: adding log2(N_c! / prod_y N_cy!) per row breaks the agreement.
    const rows = new Map<string, number[]>();
    for (const d of data) {
      const key = `${d.key.template}:${d.context}`;
      const counts = rows.get(key) ?? [0, 0, 0];
      counts[d.outcome]!++;
      rows.set(key, counts);
    }
    let coefficientBits = 0;
    for (const counts of rows.values()) {
      const total = counts.reduce((a, b) => a + b, 0);
      coefficientBits += (lgamma(total + 1) - counts.reduce((acc, n) => acc + lgamma(n + 1), 0)) / Math.LN2;
    }
    const withCoefficient = closed - coefficientBits; // code for the count vector, not the sequence
    expect(coefficientBits).toBeGreaterThan(100);
    expect(Math.abs(withCoefficient - sequential)).toBeGreaterThan(100);
    expect(Math.abs(sequential - withCoefficient - coefficientBits)).toBeLessThanOrEqual(1e-9);
  });

  it("codes the first datum of a row with its prior predictive", () => {
    const table = new SparseRows({
      source: BIT,
      target: TRI,
      support: [0, 2],
      default_prior: [R(1, 4), R(0), R(3, 4)],
      strength: R(1),
      prior_overrides: [],
      counts: [],
    });
    const lengths = prequentialCodeLengths([datum(0, KEY_A, 1, 2), datum(1, KEY_A, 0, 0)], [[KEY_A, table]]);
    expect(lengths).toEqual([-Math.log2(0.75), -Math.log2(0.25)]);
  });

  it("rejects support violations, unknown families, counted priors, and pooled origins", () => {
    const table = new SparseRows({
      source: BIT,
      target: TRI,
      support: [0, 2],
      default_prior: [R(1, 2), R(0), R(1, 2)],
      strength: R(1),
      prior_overrides: [],
      counts: [],
    });
    const priors: FamilyPrior[] = [[KEY_A, table]];
    for (const score of [prequentialBits, dirichletMultinomialBits]) {
      raises(() => score([datum(0, KEY_A, 0, 1)], priors), /outside the declared support/);
      raises(() => score([datum(0, KEY_A, 0, 3)], priors), /outside Tri/);
      raises(() => score([datum(0, KEY_A, 2, 0)], priors), /outside Bit/);
      raises(() => score([datum(0, KEY_B, 0, 0)], priors), /no prior for family/);
      raises(() => score([datum(0, KEY_A, 0, 0), datum(0, KEY_A, 0, 2)], priors), /duplicate record_id/);
      raises(() => score([datum(0, KEY_A, 0, 0), datum(1, KEY_A, 0, 0, { origin: "observed" })], priors), /mixes origins/);
      raises(() => score([], [[KEY_A, table], [KEY_A, table]]), /duplicate family key/);
      const counted = new SparseRows({ ...table, counts: [[0, [1, 0, 0]]] });
      raises(() => score([], [[KEY_A, counted]]), /carries no counts/);
    }
    expect(prequentialBits([], priors)).toBe(0);
    expect(dirichletMultinomialBits([], priors)).toBe(0);
  });
});

describe("structure code", () => {
  /** Elias-gamma code of n >= 1: floor(log2 n) zeros, then n in binary. */
  function eliasGamma(n: number): string {
    const binary = n.toString(2);
    return "0".repeat(binary.length - 1) + binary;
  }

  it("test_structure_code", () => {
    const sizes = Array.from({ length: 4100 }, (_, B) => B);
    for (let k = 13; k <= 40; k++) sizes.push(2 ** k - 2, 2 ** k - 1, 2 ** k);
    const mismatches = sizes.filter((B) => {
      const bitLength = (B + 1).toString(2).length;
      const bits = modelBits(B);
      return (
        bits !== 2 * bitLength - 1 + 8 * B ||
        bits !== 2 * Math.floor(Math.log2(B + 1)) + 1 + 8 * B ||
        bits !== eliasGamma(B + 1).length + 8 * B
      );
    });
    expect(mismatches).toEqual([]);
    expect([0, 1, 2, 3, 7, 8].map(modelBits)).toEqual([1, 11, 19, 29, 63, 71]);
    // Canonical UTF-8 JSON bytes: '{}' is 2 bytes; '{"a":"é"}' is 10 bytes.
    expect(structureBits({})).toBe(modelBits(2));
    expect(structureBits({ a: "é" })).toBe(modelBits(10));
    expect(structureBits({ b: 1, a: [1, 2] })).toBe(structureBits({ a: [1, 2], b: 1 }));
    raises(() => modelBits(-1), /byteLength/);
    raises(() => modelBits(1.5), /byteLength/);
    raises(() => modelBits(NaN), /byteLength/);
  });
});
