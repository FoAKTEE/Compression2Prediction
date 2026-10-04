/** N1 tests: guide §12.2 reference cases plus row-convention and product checks. */
import { describe, expect, it } from "vitest";
import {
  constant,
  copy,
  discard,
  fitCounts,
  forecast,
  identity,
  Kernel,
  kernelEquals,
  posterior,
  product,
  productAll,
  Space,
  spaceEquals,
  UNIT,
  ValueError,
} from "../src/index.js";

const BIT = new Space("Bit", ["0", "1"]);
const COIN = new Kernel(UNIT, BIT, [[0.5, 0.5]]);
const FLIP = new Kernel(BIT, BIT, [
  [0.8, 0.2],
  [0.1, 0.9],
]);

function approxVector(left: readonly number[], right: readonly number[]): void {
  expect(left.length).toBe(right.length);
  left.forEach((a, i) => {
    expect(Math.abs(a - right[i]!), `index ${i}: ${a} vs ${right[i]}`).toBeLessThanOrEqual(1e-12);
  });
}

// Guide §12.2 reference cases, same numbers and assertions.
describe("guide §12.2 reference cases", () => {
  it("reference: reject_unnormalized", () => {
    expect(() => new Kernel(UNIT, BIT, [[0.2, 0.2]])).toThrow(ValueError);
  });

  it("reference: reject_nan", () => {
    expect(() => new Kernel(UNIT, BIT, [[NaN, 1.0]])).toThrow(ValueError);
  });

  it("reference: reject_negative", () => {
    expect(() => new Kernel(UNIT, BIT, [[-0.1, 1.1]])).toThrow(ValueError);
  });

  it("reference: type_mismatch", () => {
    const other = new Space("NotBit", ["0", "1"]);
    expect(() => COIN.andThen(identity(other))).toThrow(ValueError);
  });

  it("reference: identity", () => {
    expect(kernelEquals(FLIP.andThen(identity(BIT)), FLIP)).toBe(true);
    expect(kernelEquals(identity(BIT).andThen(FLIP), FLIP)).toBe(true);
  });

  it("reference: associativity", () => {
    const left = COIN.andThen(FLIP).andThen(FLIP);
    const right = COIN.andThen(FLIP.andThen(FLIP));
    approxVector(left.rows[0]!, right.rows[0]!);
  });

  it("reference: discard", () => {
    expect(kernelEquals(FLIP.andThen(discard(BIT)), discard(BIT))).toBe(true);
  });

  it("reference: copy_is_not_resampling", () => {
    const copied = COIN.andThen(copy(BIT)).rows[0]!;
    const independent = COIN.tensor(COIN).rows[0]!;
    approxVector(copied, [0.5, 0.0, 0.0, 0.5]);
    approxVector(independent, [0.25, 0.25, 0.25, 0.25]);
  });

  it("reference: tensor_order", () => {
    expect(product(BIT, BIT).values).toEqual(['["0","0"]', '["0","1"]', '["1","0"]', '["1","1"]']);
    approxVector(FLIP.tensor(FLIP).rows[0]!, [0.64, 0.16, 0.16, 0.04]);
  });

  it("reference: hard_intervention_ignores_parents", () => {
    const replacement = constant(BIT, BIT, "1");
    expect(replacement.rows).toEqual([
      [0.0, 1.0],
      [0.0, 1.0],
    ]);
  });

  it("reference: bad_intervention", () => {
    expect(() => constant(BIT, BIT, "missing")).toThrow(ValueError);
  });

  it("reference: bayes_update", () => {
    const emission = new Kernel(BIT, new Space("Signal", ["absent", "present"]), [
      [0.9, 0.1],
      [0.2, 0.8],
    ]);
    approxVector(posterior([0.5, 0.5], emission, "present"), [1 / 9, 8 / 9]);
  });

  it("reference: zero_evidence_is_not_silently_repaired", () => {
    const emission = new Kernel(BIT, BIT, [
      [1.0, 0.0],
      [1.0, 0.0],
    ]);
    expect(() => posterior([0.5, 0.5], emission, "1")).toThrow(ValueError);
  });

  it("reference: prior_for_unseen_row", () => {
    const prior = new Kernel(BIT, BIT, [
      [0.5, 0.5],
      [0.5, 0.5],
    ]);
    const fitted = fitCounts(
      BIT,
      [
        [8, 2],
        [0, 0],
      ],
      prior,
      2.0,
    );
    approxVector(fitted.rows[0]!, [0.75, 0.25]);
    approxVector(fitted.rows[1]!, [0.5, 0.5]);
  });

  it("reference: zero_horizon", () => {
    approxVector(forecast([1.0, 0.0], FLIP, 0), [1.0, 0.0]);
  });

  it("reference: negative_horizon", () => {
    expect(() => forecast([1.0, 0.0], FLIP, -1)).toThrow(ValueError);
  });

  it("reference: illustrative_incident_forecast", () => {
    const incident = new Space("IncidentStatus", ["unacknowledged", "acknowledged", "resolved"]);
    const baseline = new Kernel(incident, incident, [
      [0.6, 0.3, 0.1],
      [0.0, 0.7, 0.3],
      [0.0, 0.0, 1.0],
    ]);
    const extraCrew = new Kernel(incident, incident, [
      [0.3, 0.4, 0.3],
      [0.0, 0.4, 0.6],
      [0.0, 0.0, 1.0],
    ]);
    approxVector(forecast([1, 0, 0], baseline, 2), [0.36, 0.39, 0.25]);
    approxVector(forecast([1, 0, 0], extraCrew, 2), [0.09, 0.28, 0.63]);
  });
});

// Additional N1 acceptance checks (memo §1.2 and §4.4, init.md §1.4).
describe("oracle extra cases", () => {
  it("extra: tensor_order", () => {
    expect(product(BIT, BIT).values).toEqual(['["0","0"]', '["0","1"]', '["1","0"]', '["1","1"]']);
    approxVector(COIN.andThen(copy(BIT)).rows[0]!, [0.5, 0, 0, 0.5]);
  });

  it("extra: product_all_unit_single_and_left_fold", () => {
    const a = new Space("A", ["a0", "a1"]);
    const b = new Space("B", ["b0", "b1", "b2"]);
    const c = new Space("C", ["c0", "c1"]);
    expect(spaceEquals(productAll([]), UNIT)).toBe(true);
    expect(productAll([])).toBe(UNIT);
    expect(productAll([a])).toBe(a);
    expect(spaceEquals(productAll([a]), a)).toBe(true);
    const folded = productAll([a, b, c]);
    expect(folded.name).toBe("((A*B)*C)");
    expect(folded.values).toEqual(product(product(a, b), c).values);
    expect(spaceEquals(folded, product(product(a, b), c))).toBe(true);
    expect(folded.values).not.toEqual(product(a, product(b, c)).values);
  });

  it("extra: composition_matches_matrix_product", () => {
    const x = new Space("X", ["x0", "x1", "x2"]);
    const y = new Space("Y", ["y0", "y1", "y2"]);
    const z = new Space("Z", ["z0", "z1"]);
    const k = new Kernel(x, y, [
      [0.5, 0.25, 0.25],
      [0.1, 0.6, 0.3],
      [0.0, 0.2, 0.8],
    ]);
    const l = new Kernel(y, z, [
      [0.9, 0.1],
      [0.3, 0.7],
      [0.4, 0.6],
    ]);
    const composed = k.andThen(l);
    expect(spaceEquals(composed.source, x)).toBe(true);
    expect(spaceEquals(composed.target, z)).toBe(true);
    const expected = [0, 1, 2].map((i) =>
      [0, 1].map((m) => [0, 1, 2].reduce((acc, j) => acc + k.rows[i]![j]! * l.rows[j]![m]!, 0)),
    );
    expect(composed.rows.length).toBe(3);
    composed.rows.forEach((row, i) => approxVector(row, expected[i]!));
    // Row 0 by hand: 0.5*0.9 + 0.25*0.3 + 0.25*0.4 = 0.625.
    approxVector(composed.rows[0]!, [0.625, 0.375]);
    // The other order does not typecheck, so a silent transpose cannot slip in.
    expect(() => l.andThen(k)).toThrow(ValueError);
  });

  it("extra: forecast_rejects_bool_steps", () => {
    expect(() => forecast([1.0, 0.0], FLIP, true as unknown as number)).toThrow(ValueError);
  });
});

describe("TypeScript port details", () => {
  it("instances and their arrays are frozen", () => {
    expect(Object.isFrozen(BIT)).toBe(true);
    expect(Object.isFrozen(BIT.values)).toBe(true);
    expect(Object.isFrozen(FLIP)).toBe(true);
    expect(Object.isFrozen(FLIP.rows)).toBe(true);
    expect(FLIP.rows.every((row) => Object.isFrozen(row))).toBe(true);
    expect(Object.isFrozen(FLIP.push([0.5, 0.5]))).toBe(true);
    expect(Object.isFrozen(forecast([1, 0], FLIP, 3))).toBe(true);
  });

  it("validates spaces like the oracle", () => {
    expect(() => new Space("", ["a"])).toThrow(ValueError);
    expect(() => new Space("S", [])).toThrow(ValueError);
    expect(() => new Space("S", ["a", "a"])).toThrow(ValueError);
    expect(() => new Space("S", ["a", 1 as unknown as string])).toThrow(ValueError);
    expect(() => new Space("S", 5 as unknown as string[])).toThrow(TypeError);
    // A string is an iterable of characters, as in Python.
    expect(new Space("S", "ab").values).toEqual(["a", "b"]);
  });

  it("rejects wrong sizes, bad horizons, and bad counts", () => {
    expect(() => new Kernel(BIT, BIT, [[0.5, 0.5]])).toThrow(ValueError);
    expect(() => FLIP.push([1.0])).toThrow(ValueError);
    expect(() => forecast([1.0, 0.0], FLIP, 1.5)).toThrow(ValueError);
    expect(() => forecast([1.0, 0.0], FLIP, NaN)).toThrow(ValueError);
    expect(() => forecast([1.0, 0.0], COIN, 1)).toThrow(ValueError);
    const prior = new Kernel(BIT, BIT, [
      [0.5, 0.5],
      [0.5, 0.5],
    ]);
    expect(() => fitCounts(BIT, [[1, 2], [3, -1]], prior, 1)).toThrow(ValueError);
    expect(() => fitCounts(BIT, [[1, 2], [3, 0.5]], prior, 1)).toThrow(ValueError);
    expect(() => fitCounts(BIT, [[1, 2]], prior, 1)).toThrow(ValueError);
    expect(() => fitCounts(BIT, [[1, 2], [3, 4]], prior, 0)).toThrow(ValueError);
    expect(() => fitCounts(BIT, [[1, 2], [3, 4]], prior, Infinity)).toThrow(ValueError);
    expect(() => fitCounts(BIT, [[1, 2], [3, 4]], identity(BIT), 1)).toThrow(ValueError);
  });

  it("kernel is not thenable", async () => {
    expect("then" in FLIP).toBe(false);
    expect(await Promise.resolve(FLIP)).toBe(FLIP);
    const load = async (): Promise<Kernel> => FLIP;
    expect(await load()).toBe(FLIP);
  });

  it("andThen rejects a non-kernel argument", () => {
    expect(() => FLIP.andThen({} as unknown as Kernel)).toThrow(TypeError);
  });
});
