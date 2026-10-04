/** N5.2: finite Bayes filter and horizon forecasts (guide §6.2). */
import { describe, expect, it } from "vitest";
import { filterSequence, horizonForecast, predict, update } from "../src/inference/index.js";
import { identity, Kernel, posterior, Space } from "../src/index.js";
import { INCIDENT_STATUS, P_BASELINE, P_EXTRA_CREW } from "./fixtures/inference.js";
import { raises } from "./support.js";

const T_BASE = new Kernel(INCIDENT_STATUS, INCIDENT_STATUS, P_BASELINE);
const T_HIGH = new Kernel(INCIDENT_STATUS, INCIDENT_STATUS, P_EXTRA_CREW);
const REPORT = new Space("Report", ["quiet", "reported_resolved"]);
// E(o | s): a noisy resolution report.
const E = new Kernel(INCIDENT_STATUS, REPORT, [
  [0.9, 0.1],
  [0.8, 0.2],
  [0.1, 0.9],
]);
// Only a resolved incident is ever reported.
const E_STRICT = new Kernel(INCIDENT_STATUS, REPORT, [
  [1, 0],
  [1, 0],
  [0, 1],
]);

function close(actual: readonly number[], expected: readonly number[]): void {
  expect(actual).toHaveLength(expected.length);
  expected.forEach((p, i) => expect(Math.abs(actual[i]! - p), `index ${i}`).toBeLessThanOrEqual(1e-12));
}

describe("Bayes filter", () => {
  it("test_filter_update_matches_hand_computation", () => {
    // Predict: b̂ = (1, 0, 0) P_baseline = (0.6, 0.3, 0.1).
    const predicted = predict([1, 0, 0], T_BASE);
    close(predicted, [0.6, 0.3, 0.1]);
    // Update on "reported_resolved": weights (0.06, 0.06, 0.09), evidence 0.21.
    const filtered = update(predicted, E, "reported_resolved");
    close(filtered, [2 / 7, 2 / 7, 3 / 7]);
    expect(Object.isFrozen(filtered)).toBe(true);

    const steps = filterSequence([1, 0, 0], T_BASE, E, ["reported_resolved", "quiet"]);
    expect(steps).toHaveLength(2);
    close(steps[0]!.predicted, [0.6, 0.3, 0.1]);
    close(steps[0]!.filtered, [2 / 7, 2 / 7, 3 / 7]);
    // Predict: (2/7, 2/7, 3/7) P_baseline = (1.2, 2, 3.8) / 7.
    close(steps[1]!.predicted, [1.2 / 7, 2 / 7, 3.8 / 7]);
    // Update on "quiet": weights (1.08, 1.6, 0.38) / 7, evidence 3.06 / 7.
    close(steps[1]!.filtered, [6 / 17, 80 / 153, 19 / 153]);
    expect(filterSequence([1, 0, 0], T_BASE, E, [])).toStrictEqual([]);
  });

  it("test_impossible_observation_raises", () => {
    raises(() => update([1, 0, 0], E_STRICT, "reported_resolved"), /Observation has zero probability under this model/);
    raises(() => update([0, 0, 1], E_STRICT, "quiet"), /zero probability/);
    raises(() => update([1, 0, 0], E, "escalated"), /outside the emission support/);
    raises(
      () => filterSequence([1, 0, 0], identity(INCIDENT_STATUS), E_STRICT, ["quiet", "reported_resolved"]),
      /observation 1 \('reported_resolved'\): Observation has zero probability/,
    );
    // A possible observation under the same strict emission is fine.
    close(update([0.5, 0, 0.5], E_STRICT, "reported_resolved"), [0, 0, 1]);
  });

  it("validates beliefs and interfaces", () => {
    raises(() => predict([1, 0], T_BASE), /wrong size/);
    raises(() => predict([0.5, 0.5, 0.5], T_BASE), /normalization is not implicit/);
    raises(() => predict([1, 0, 0], P_BASELINE as never), /transition: expected a Kernel/);
    const OTHER = new Space("Other", ["a", "b", "c"]);
    raises(() => filterSequence([1, 0, 0], T_BASE, new Kernel(OTHER, REPORT, E.rows), ["quiet"]), /emission source 'Other' is not the state space 'IncidentStatus'/);
    raises(() => filterSequence([1, 0], new Kernel(INCIDENT_STATUS, REPORT, E.rows), E, ["quiet"]), /transition on one state space/);
  });
});

describe("horizon forecasts", () => {
  it("test_horizon_forecast_order", () => {
    const b = [1, 0, 0];
    // The transitions do not commute, and the forecast applies them in the given order.
    const baseThenHigh = horizonForecast(b, [T_BASE, T_HIGH]);
    const highThenBase = horizonForecast(b, [T_HIGH, T_BASE]);
    close(baseThenHigh, [0.18, 0.36, 0.46]);
    close(highThenBase, [0.18, 0.37, 0.45]);
    expect(baseThenHigh).not.toStrictEqual(highThenBase);
    expect(baseThenHigh).toStrictEqual(T_BASE.andThen(T_HIGH).push(b));
    expect(highThenBase).toStrictEqual(T_HIGH.andThen(T_BASE).push(b));
    // b P_T0 P_T1 P_E: the emission comes last.
    expect(horizonForecast(b, [T_BASE, T_HIGH], E)).toStrictEqual(E.push(baseThenHigh));
    close(horizonForecast(b, [T_BASE, T_HIGH], E), T_BASE.andThen(T_HIGH).andThen(E).push(b));
    // The guide §13 horizons.
    close(horizonForecast(b, [T_BASE, T_BASE]), [0.36, 0.39, 0.25]);
    close(horizonForecast(b, [T_HIGH, T_HIGH]), [0.09, 0.28, 0.63]);
    // Horizon zero.
    expect(horizonForecast(b, [])).toStrictEqual(b);
    expect(horizonForecast(b, [], E)).toStrictEqual(E.push(b));
    raises(() => horizonForecast([0.5, 0.6], []), /must sum to one/);
  });

  it("rejects mismatched interfaces", () => {
    raises(() => horizonForecast([1, 0, 0], [T_BASE, E, T_BASE]), /step 2: 'IncidentStatus' does not accept 'Report'/);
    raises(() => horizonForecast([1, 0], [T_BASE]), /wrong size/);
    raises(() => horizonForecast([1, 0, 0], [T_BASE], identity(REPORT)), /step 1: 'Report' does not accept 'IncidentStatus'/);
    raises(() => horizonForecast([1, 0, 0], "T" as never), /transitions: expected an array/);
  });
});

describe("F04: underflow-safe updates", () => {
  const BIT = new Space("Bit", ["0", "1"]);
  const MIN = Number.MIN_VALUE;
  // P(o = 1 | s) = MIN, 2 MIN: representable, but 0.5 * MIN rounds to 0.
  const TINY = new Kernel(BIT, BIT, [
    [1, MIN],
    [1, 2 * MIN],
  ]);

  it("B3: update keeps the likelihood ratio of subnormal likelihoods: [1/3, 2/3], not [0, 1]", () => {
    close(update([0.5, 0.5], TINY, "1"), [1 / 3, 2 / 3]);
    close(posterior([0.5, 0.5], TINY, "1"), [1 / 3, 2 / 3]);
    // A structural zero stays zero; only true zero evidence raises.
    const strict = new Kernel(BIT, BIT, [
      [1, 0],
      [1, 2 * MIN],
    ]);
    expect(update([0.5, 0.5], strict, "1")).toStrictEqual([0, 1]);
    raises(() => update([1, 0], strict, "1"), /Observation has zero probability under this model/);
  });

  it("filterSequence carries the belief in log space once a step would underflow", () => {
    // Identity transition: after two '1' observations the posterior is ∝ (MIN^2, 4 MIN^2).
    const steps = filterSequence([0.5, 0.5], identity(BIT), TINY, ["1", "1"]);
    close(steps[0]!.filtered, [1 / 3, 2 / 3]);
    close(steps[1]!.predicted, [1 / 3, 2 / 3]);
    close(steps[1]!.filtered, [1 / 5, 4 / 5]);
    // An ordinary step before the switch is unchanged; a later impossible observation still raises.
    const mixed = filterSequence([0.5, 0.5], identity(BIT), TINY, ["0", "1", "1"]);
    close(mixed[0]!.filtered, [0.5, 0.5]);
    close(mixed[2]!.filtered, [1 / 5, 4 / 5]);
    // 'b' is possible only from state 0 (likelihood MIN); after it, 'c' (state 1 only) has zero evidence.
    const OBS = new Space("Obs", ["a", "b", "c"]);
    const strict = new Kernel(BIT, OBS, [
      [1, MIN, 0],
      [0.5, 0, 0.5],
    ]);
    close(filterSequence([0.5, 0.5], identity(BIT), strict, ["b"])[0]!.filtered, [1, 0]);
    raises(() => filterSequence([0.5, 0.5], identity(BIT), strict, ["b", "c"]), /observation 1 \('c'\): Observation has zero probability/);
    raises(() => filterSequence([0.5, 0.5], identity(BIT), TINY, ["1", "2"]), /observation 1 \('2'\): Observation is outside the emission support/);
  });
});
