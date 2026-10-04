/** N5.1: budgeted exact enumeration (memo §2.6, §4.2; guide §3.3, §6.3, §8.1). */
import { describe, expect, it } from "vitest";
import { exactJoint, exactQuery } from "../src/inference/index.js";
import type { Prior } from "../src/inference/index.js";
import { copy, identity, Kernel, Rational, spaceEquals } from "../src/index.js";
import { bigBudget } from "./fixtures/causal.js";
import {
  announcement,
  BIT,
  bit,
  chainPlan,
  crew,
  FAIR,
  heard,
  INCIDENT_STATUS,
  incidentPlan,
  incidentPriors,
  P_BASELINE,
  P_EXTRA_CREW,
  PEOPLE,
  sharedCausePlan,
  status,
  supplies,
} from "./fixtures/inference.js";
import { bern, key, modelPlan, priors, R, ZERO } from "./fixtures/rank.js";
import type { ExactModel } from "./fixtures/rank.js";
import { raises } from "./support.js";

const budget = bigBudget();

function close(actual: readonly number[], expected: readonly number[]): void {
  expect(actual).toHaveLength(expected.length);
  expected.forEach((p, i) => expect(Math.abs(actual[i]! - p), `index ${i}`).toBeLessThanOrEqual(1e-12));
}

/** b P for a row vector b and a row-stochastic matrix P. */
function push(b: readonly number[], P: readonly (readonly number[])[]): number[] {
  return P[0]!.map((_, j) => b.reduce((acc, bi, i) => acc + bi * P[i]![j]!, 0));
}

describe("forecasts", () => {
  it("reproduces the guide §13 incident forecast through the compiled plan", () => {
    const plan = incidentPlan();
    const base = exactQuery(plan, { target: status(2), initial: incidentPriors(), budget });
    close(base.distribution, [0.36, 0.39, 0.25]);
    expect(Math.abs(base.distribution[2]! - 0.25)).toBeLessThanOrEqual(1e-12);
    expect(spaceEquals(base.space, INCIDENT_STATUS)).toBe(true);
    expect(base.query_kind).toBe("observational");
    expect(base.effect_status).toBe("not_applicable");
    expect(Object.isFrozen(base) && Object.isFrozen(base.distribution)).toBe(true);

    // A crew prior is a belief, not an intervention: high crew as a point-mass prior.
    close(exactQuery(plan, { target: status(2), initial: incidentPriors(2, [0, 1]), budget }).distribution, [0.09, 0.28, 0.63]);
    // An uncertain crew at each tick mixes the slices per step.
    const mix = P_BASELINE.map((row, i) => row.map((p, j) => 0.5 * p + 0.5 * P_EXTRA_CREW[i]![j]!));
    close(
      exactQuery(plan, { target: status(2), initial: incidentPriors(2, FAIR), budget }).distribution,
      push(push([1, 0, 0], mix), mix),
    );
  });

  it("enumerates only the ancestors of target and evidence", () => {
    const plan = incidentPlan();
    // status(1) needs no prior for the tick-1 crew or supplies.
    const partial: Prior[] = [
      [status(0), [1, 0, 0]],
      [crew(0), [1, 0]],
      [supplies(0), [1]],
    ];
    close(exactQuery(plan, { target: status(1), initial: partial, budget }).distribution, P_BASELINE[0]!);
    raises(() => exactQuery(plan, { target: status(2), initial: partial, budget }), /missing prior for source key .*"crew_capacity".*1\]/);
    // Priors for keys outside the plan are unused.
    const extra: Prior[] = [...partial, [crew(7), [0.5, 0.5]]];
    close(exactQuery(plan, { target: status(1), initial: extra, budget }).distribution, P_BASELINE[0]!);
  });

  it("does not depend on the order of priors or evidence", () => {
    const plan = incidentPlan();
    const evidence = [[status(1), "acknowledged"] as const, [crew(1), "high"] as const];
    const a = exactQuery(plan, { target: status(2), evidence, initial: incidentPriors(2, FAIR), budget });
    const b = exactQuery(plan, {
      target: status(2),
      evidence: [...evidence].reverse(),
      initial: [...incidentPriors(2, FAIR)].reverse(),
      budget,
    });
    expect(b.distribution).toStrictEqual(a.distribution);
    close(a.distribution, P_EXTRA_CREW[1]!);
  });
});

describe("conditioning", () => {
  it("conditions by Bayes, including on descendants, without touching the plan", () => {
    const plan = incidentPlan();
    const hash = plan.model_hash;
    const nodes = [...plan.nodes];
    // Forward: P(status2 | status1 = acknowledged) is the baseline row.
    const forward = exactQuery(plan, { target: status(2), evidence: [[status(1), "acknowledged"]], initial: incidentPriors(), budget });
    close(forward.distribution, P_BASELINE[1]!);
    expect(forward.query_kind).toBe("conditional");
    expect(forward.effect_status).toBe("not_applicable");
    // Backward: P(status1 | status2 = resolved) ∝ (0.6·0.1, 0.3·0.3, 0.1·1) = (0.06, 0.09, 0.1) / 0.25.
    const backward = exactQuery(plan, { target: status(1), evidence: [[status(2), "resolved"]], initial: incidentPriors(), budget });
    close(backward.distribution, [0.24, 0.36, 0.4]);
    // Evidence on the target itself.
    close(
      exactQuery(plan, { target: status(1), evidence: [[status(1), "resolved"]], initial: incidentPriors(), budget }).distribution,
      [0, 0, 1],
    );
    // Evidence on an uncertain exogenous parent: P(crew0 | status1 = resolved) ∝ (0.5·0.1, 0.5·0.3).
    const crewPosterior = exactQuery(plan, {
      target: crew(0),
      evidence: [[status(1), "resolved"]],
      initial: incidentPriors(2, FAIR),
      budget,
    });
    close(crewPosterior.distribution, [0.25, 0.75]);
    expect(plan.model_hash).toBe(hash);
    plan.nodes.forEach((node, i) => expect(node).toBe(nodes[i]));
  });

  it("test_zero_evidence_raises", () => {
    // An identity chain from x0 = 0 never reaches x1 = 1.
    const plan = chainPlan(1, identity(BIT));
    const initial: Prior[] = [[bit("x", 0), [1, 0]]];
    raises(
      () => exactQuery(plan, { target: bit("x", 0), evidence: [[bit("x", 1), "1"]], initial, budget }),
      /the evidence has zero probability under this model; it is not repaired/,
    );
    // Resolved is absorbing: it never returns to unacknowledged.
    raises(
      () =>
        exactQuery(incidentPlan(), {
          target: status(2),
          evidence: [[status(1), "unacknowledged"]],
          initial: [[status(0), [0, 0, 1]], ...incidentPriors().slice(1)],
          budget,
        }),
      /zero probability/,
    );
    // Contradictory evidence on a source and its prior.
    raises(() => exactQuery(plan, { target: bit("x", 1), evidence: [[bit("x", 0), "1"]], initial, budget }), /zero probability/);
  });
});

describe("shared causes", () => {
  it("test_copy_preserves_shared_cause", () => {
    const plan = sharedCausePlan();
    const [p1, p2] = PEOPLE as [string, string];
    const initial: Prior[] = [[announcement(), FAIR]];
    const joint = exactJoint(plan, { targets: [heard(p1), heard(p2)], initial, budget });
    expect(joint.space.name).toBe("(Bit*Bit)");
    expect(joint.space.values).toStrictEqual(['["0","0"]', '["0","1"]', '["1","0"]', '["1","1"]']);
    // Mass only on equal pairs: one announcement, copied, never resampled per recipient.
    close(joint.distribution, [0.5, 0, 0, 0.5]);
    expect(joint.distribution).toStrictEqual(copy(BIT).push(FAIR));
    // Each marginal is fair, so the independent product would be uniform.
    const m1 = exactQuery(plan, { target: heard(p1), initial, budget }).distribution;
    const m2 = exactQuery(plan, { target: heard(p2), initial, budget }).distribution;
    const independent = m1.flatMap((a) => m2.map((b) => a * b));
    close(independent, [0.25, 0.25, 0.25, 0.25]);
    expect(joint.distribution).not.toStrictEqual(independent);
    // Evidence on one branch moves the other through the root.
    close(exactQuery(plan, { target: heard(p2), evidence: [[heard(p1), "1"]], initial, budget }).distribution, [0, 1]);

    // A noisy channel keeps the dependence: sum_z p(z) K(a|z) K(b|z).
    const K = [
      [0.9, 0.1],
      [0.2, 0.8],
    ];
    const noisy = sharedCausePlan(new Kernel(BIT, BIT, K));
    const expected = [0, 1].flatMap((a) => [0, 1].map((b) => 0.5 * K[0]![a]! * K[0]![b]! + 0.5 * K[1]![a]! * K[1]![b]!));
    close(exactJoint(noisy, { targets: [heard(p1), heard(p2)], initial, budget }).distribution, expected);
    const marginal = push(FAIR, K);
    expect(Math.abs(expected[0]! - marginal[0]! * marginal[0]!)).toBeGreaterThan(0.01);
  });
});

describe("budgets and validation", () => {
  it("test_budget_overflow_raises", () => {
    const plan = incidentPlan();
    // 3 x 2 x 1 x 3 x 2 x 1 x 3 = 108 joint entries over the seven ancestors of status(2).
    const query = (max: number) =>
      exactQuery(plan, { target: status(2), initial: incidentPriors(), budget: bigBudget({ max_factor_entries: max }) });
    raises(() => query(107), /over 7 ancestor variables needs 108 joint entries, exceeding max_factor_entries 107/);
    close(query(108).distribution, [0.36, 0.39, 0.25]);

    // 2^61 entries: the check runs before any enumeration, or this would never return.
    const chain = chainPlan(60);
    const initial: Prior[] = [[bit("x", 0), [1, 0]]];
    raises(
      () => exactQuery(chain, { target: bit("x", 60), initial, budget }),
      /over 61 ancestor variables needs 2305843009213693952 joint entries, exceeding max_factor_entries 10000/,
    );
    // An early tick of the same long chain has few ancestors.
    const early = exactQuery(chain, { target: bit("x", 3), initial, budget: bigBudget({ max_factor_entries: 16 }) });
    expect(early.distribution).toHaveLength(2);
    raises(() => exactQuery(chain, { target: bit("x", 3), initial, budget: bigBudget({ max_factor_entries: 15 }) }), /needs 16 joint entries/);
    // Evidence ancestors count too.
    raises(
      () => exactQuery(chain, { target: bit("x", 0), evidence: [[bit("x", 4), "1"]], initial, budget: bigBudget({ max_factor_entries: 16 }) }),
      /over 5 ancestor variables needs 32 joint entries/,
    );
  });

  it("rejects malformed queries", () => {
    const plan = incidentPlan();
    const initial = incidentPriors();
    raises(() => exactQuery(plan, { target: status(9), initial, budget }), /target .* is not a key of this plan/);
    raises(() => exactQuery(plan, { target: ["scn", "x"] as never, initial, budget }), /expected \(scenario_id, variable_id, entity_id, time_index\)/);
    raises(() => exactQuery(plan, { target: status(2), initial: [...initial, [status(1), [1, 0, 0]]], budget }), /is written by mechanism 'mechanism_incident_progress'; priors are for source keys only/);
    raises(() => exactQuery(plan, { target: status(2), initial: [...initial, initial[0]!], budget }), /duplicate prior/);
    raises(() => exactQuery(plan, { target: status(2), initial: [[status(0), [1, 0]], ...initial.slice(1)], budget }), /prior for .* over IncidentStatus: Probability vector has the wrong size/);
    raises(() => exactQuery(plan, { target: status(2), initial: [[status(0), [0.5, 0.25, 0.2]], ...initial.slice(1)], budget }), /normalization is not implicit/);
    raises(() => exactQuery(plan, { target: status(2), evidence: [[status(1), "lost"]], initial, budget }), /'lost' is outside IncidentStatus/);
    raises(() => exactQuery(plan, { target: status(2), evidence: [[status(9), "resolved"]], initial, budget }), /evidence\[0\]: .* is not a key of this plan/);
    raises(
      () => exactQuery(plan, { target: status(2), evidence: [[status(1), "resolved"], [status(1), "resolved"]], initial, budget }),
      /duplicate evidence/,
    );
    raises(() => exactQuery(plan, { target: status(2), evidence: [status(1)] as never, initial, budget }), /expected a \(key, value\) pair/);
    raises(() => exactQuery(plan, { target: status(2), initial, budget, extra: 1 } as never), /unknown field\(s\) 'extra'/);
    raises(() => exactQuery(plan, { target: status(2), initial, budget: {} as never }), /budget: expected Budget/);
    raises(() => exactQuery({ nodes: [] } as never, { target: status(2), initial, budget }), /expected a compiled Plan/);
    raises(() => exactJoint(plan, { targets: [status(1), status(1)], initial, budget }), /duplicate keys/);
    raises(() => exactJoint(plan, { targets: [], initial, budget }), /nonempty array/);
  });
});

describe("F04: underflow-safe likelihoods", () => {
  /** X fair; E1, E2 read X with P(E = 1 | x) = rows[x]. */
  const emissions = (rows: readonly (readonly [Rational, Rational])[]): ExactModel => ({
    roots: [{ name: "X", tick: 0, prior: bern(R(1, 2)) }],
    writers: rows.map((r, i) => ({ name: `E${i + 1}`, tick: 1, inputs: [["X", 0] as const], rows: [bern(r[0]), bern(r[1])] })),
  });
  const a = Rational.parse("2e-162");
  const b = a.mul(R(2));

  it("C6: two tiny positive emissions keep their ratio: [1/5, 4/5], not [0, 1]", () => {
    const model = emissions([
      [a, b],
      [a, b],
    ]);
    const plan = modelPlan(model);
    const evidence = [[key("E1", 1), "1"] as const, [key("E2", 1), "1"] as const];
    const got = exactQuery(plan, { target: key("X", 0), initial: priors(model), evidence, budget }).distribution;
    // Each product 2^-1 * 2e-162 * 2e-162 is below the double range; the ratio a^2 : b^2 is not.
    close(got, [1 / 5, 4 / 5]);
    const joint = exactJoint(plan, { targets: [key("X", 0), key("E1", 1)], initial: priors(model), evidence: evidence.slice(1), budget }).distribution;
    expect(joint.reduce((s, p) => s + p, 0)).toBeCloseTo(1, 12);
    // P(X = x, E1 = 1 | E2 = 1) ∝ row_x^2: the tiny joint cells keep the ratio a^2 : b^2.
    expect(joint[1]! / joint[3]!).toBeCloseTo(1 / 4, 12);
  });

  it("keeps structural zeros and raises only for true zero evidence", () => {
    // X = 0 cannot emit E1 = 1; X = 1 emits both with tiny positive likelihoods.
    const model = emissions([
      [ZERO, a],
      [b, a],
    ]);
    const plan = modelPlan(model);
    const evidence = [[key("E1", 1), "1"] as const, [key("E2", 1), "1"] as const];
    expect(exactQuery(plan, { target: key("X", 0), initial: priors(model), evidence, budget }).distribution).toStrictEqual([0, 1]);
    const impossible = emissions([[ZERO, ZERO], [a, b]]);
    raises(
      () =>
        exactQuery(modelPlan(impossible), {
          target: key("X", 0),
          initial: priors(impossible),
          evidence: [[key("E1", 1), "1"], [key("E2", 1), "1"]],
          budget,
        }),
      /the evidence has zero probability under this model; it is not repaired/,
    );
  });
});
