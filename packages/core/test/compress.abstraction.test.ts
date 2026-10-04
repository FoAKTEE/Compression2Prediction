/** N6.3: lumpability defect and the TV horizon bound (memo §1.5, §4.3 LUMPABILITY, §4.4; guide §6.5). */
import { describe, expect, it } from "vitest";
import {
  aggregateBelief,
  blockSums,
  coarseRows,
  lumpability,
  pushExact,
  totalVariation,
  tvHorizonBound,
  tvScheduleBound,
} from "../src/compress/abstraction.js";
import type { ExactRows } from "../src/compress/abstraction.js";
import { Rational } from "../src/numeric/rational.js";
import { R } from "./fixtures/compress.js";
import { raises } from "./support.js";

// Memo appendix fixture.
const BLOCKS = [0, 0, 1];
const P: ExactRows = [
  [R(1, 2), R(0), R(1, 2)],
  [R(0), R(1, 4), R(3, 4)],
  [R(0), R(0), R(1)],
];
const COARSE: ExactRows = [
  [R(1, 2), R(1, 2)],
  [R(0), R(1)],
];
const LUMPABLE: ExactRows = [P[0]!, [R(0), R(1, 2), R(1, 2)], P[2]!];

// A 4-state chain with blocks {0, 1}, {2, 3}.
const BLOCKS4 = [0, 0, 1, 1];
const P4: ExactRows = [
  [R(1, 5), R(1, 5), R(1, 2), R(1, 10)],
  [R(1, 2), R(0), R(1, 4), R(1, 4)],
  [R(1, 3), R(1, 3), R(1, 6), R(1, 6)],
  [R(0), R(1, 10), R(0), R(9, 10)],
];

const str = (rows: ExactRows) => rows.map((r) => r.map(String));

/** Exact TV between b P^h C and b C Pbar^h for every point-mass start and h = 0..6. */
function horizonErrors(fine: ExactRows, block: readonly number[], coarse: ExactRows): Rational[][] {
  return fine.map((_, start) => {
    let b = fine.map((_, x) => (x === start ? Rational.ONE : Rational.ZERO));
    let small = aggregateBelief(b, block);
    const errors: Rational[] = [];
    for (let h = 0; h <= 6; h++) {
      errors.push(totalVariation(aggregateBelief(b, block), small));
      b = [...pushExact(b, fine)];
      small = pushExact(small, coarse);
    }
    return errors;
  });
}

describe("LUMPABILITY", () => {
  it("test_lumpability", () => {
    // Equal block sums: delta = 0, certified.
    expect(lumpability(LUMPABLE, BLOCKS, COARSE)).toEqual({ delta: R(0), witness: 0, checked_rows: 3, certified: true });
    expect(str(coarseRows(LUMPABLE, BLOCKS, [R(1, 3), R(2, 3), R(1)]))).toEqual(str(COARSE));
    // Unequal block sums: delta > 0 (memo: 1/4 at row 1).
    const defect = lumpability(P, BLOCKS, COARSE);
    expect(defect).toEqual({ delta: R(1, 4), witness: 1, checked_rows: 3, certified: true });
    expect(str(blockSums(P, BLOCKS))).toEqual([["1/2", "1/2"], ["1/4", "3/4"], ["0", "1"]]);
    // Weighted coarse rows average block sums: (1/2)(1/2, 1/2) + (1/2)(1/4, 3/4).
    const averaged = coarseRows(P, BLOCKS, [R(1, 2), R(1, 2), R(1)]);
    expect(str(averaged)).toEqual([["3/8", "5/8"], ["0", "1"]]);
    expect(lumpability(P, BLOCKS, averaged).delta).toEqual(R(1, 8));

    // From every point mass, horizons 0..6 satisfy TV <= min(1, h delta), exactly.
    const cases: [ExactRows, number[], ExactRows][] = [
      [P, BLOCKS, COARSE],
      [P, BLOCKS, averaged],
      [LUMPABLE, BLOCKS, COARSE],
      [P4, BLOCKS4, coarseRows(P4, BLOCKS4, [R(1, 2), R(1, 2), R(1, 4), R(3, 4)])],
      [P4, BLOCKS4, coarseRows(P4, BLOCKS4, [R(1), R(0), R(0), R(1)])],
    ];
    for (const [fine, block, coarse] of cases) {
      const { delta, certified } = lumpability(fine, block, coarse);
      expect(certified).toBe(true);
      for (const errors of horizonErrors(fine, block, coarse)) {
        errors.forEach((e, h) => expect(e.cmp(tvHorizonBound(delta, h))).toBeLessThanOrEqual(0));
      }
    }
    // The lumpable chain propagates with zero error; the memo chain does not.
    expect(horizonErrors(LUMPABLE, BLOCKS, COARSE).flat().every((e) => e.isZero())).toBe(true);
    expect(horizonErrors(P, BLOCKS, COARSE)[1]![1]).toEqual(R(1, 4));
    expect(lumpability(P4, BLOCKS4, coarseRows(P4, BLOCKS4, [R(1, 2), R(1, 2), R(1, 4), R(3, 4)])).delta.isZero()).toBe(false);

    // Bounds.
    expect(tvHorizonBound(R(1, 4), 0)).toEqual(R(0));
    expect(tvHorizonBound(R(1, 4), 3)).toEqual(R(3, 4));
    expect(tvHorizonBound(R(1, 4), 6)).toEqual(R(1));
    expect(tvScheduleBound([R(1, 4), R(0), R(1, 8)])).toEqual(R(3, 8));
    expect(tvScheduleBound([R(1, 2), R(1, 2), R(1, 2)])).toEqual(R(1));
    raises(() => tvHorizonBound(R(-1, 4), 1), /nonnegative/);
    raises(() => tvHorizonBound(R(1, 4), -1), /nonnegative integer/);
  });

  it("test_sampled_defect", () => {
    // A sample is an uncertified lower bound: row 2 alone misses the 1/4 at row 1.
    expect(lumpability(P, BLOCKS, COARSE, [2])).toEqual({ delta: R(0), witness: 2, checked_rows: 1, certified: false });
    expect(lumpability(P, BLOCKS, COARSE, [1, 0])).toEqual({ delta: R(1, 4), witness: 1, checked_rows: 2, certified: false });
    // Checking every row, even explicitly, certifies.
    expect(lumpability(P, BLOCKS, COARSE, [2, 0, 1]).certified).toBe(true);
    raises(() => lumpability(P, BLOCKS, COARSE, []), /nonempty/);
    raises(() => lumpability(P, BLOCKS, COARSE, [0, 0]), /duplicate/);
    raises(() => lumpability(P, BLOCKS, COARSE, [3]), /row index/);
  });

  it("validates rows, blocks, and weights", () => {
    raises(() => coarseRows(P, [0, 0, 2], [R(1, 2), R(1, 2), R(1)]), /block 1 is empty/);
    raises(() => coarseRows(P, BLOCKS, [R(1, 2), R(1, 3), R(1)]), /block 0 sum to 5\/6/);
    raises(() => coarseRows(P, BLOCKS, [R(3, 2), R(-1, 2), R(1)]), /nonnegative/);
    raises(() => coarseRows(P, [0, 0], [R(1, 2), R(1, 2)]), /3 block indices/);
    raises(() => lumpability([[R(1, 2), R(1, 3), R(1, 6)], P[1]!], BLOCKS, COARSE), /square/);
    raises(() => lumpability([[R(1, 2), R(1, 3), R(0)], P[1]!, P[2]!], BLOCKS, COARSE), /sums to 5\/6/);
    raises(() => lumpability(P, BLOCKS, [[R(1)], [R(1)]]), /coarse\[0\]/);
    raises(() => lumpability(P, BLOCKS, [COARSE[0]!]), /one per block/);
  });
});
