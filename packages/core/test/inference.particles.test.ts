/** N6.5: coherent whole-trajectory particles (memo §2.6, §4.3 PARTICLES, §4.4; guide §3.3, §6.3). */
import { describe, expect, it } from "vitest";
import { variableKeyString } from "../src/causal/index.js";
import type { Plan } from "../src/causal/index.js";
import { exactQuery } from "../src/inference/index.js";
import type { EvidencePair } from "../src/inference/index.js";
import { rollout, sampleTrajectory } from "../src/inference/particles.js";
import type { ParameterDraw } from "../src/inference/particles.js";
import { Space } from "../src/index.js";
import type { Rational } from "../src/index.js";
import type { RandomStream } from "../src/numeric/random.js";
import { bigBudget } from "./fixtures/causal.js";
import { bern, key, modelPlan, NOISY_ROWS, ONE, pairModel, planOf, priors, R, ZERO } from "./fixtures/rank.js";
import type { ExactModel } from "./fixtures/rank.js";
import { raises } from "./support.js";

const budget = bigBudget({ max_particles: 40_000 });
const Z = key("Z", 0);
const A = key("A", 1);
const B = key("B", 1);
const P = key("P", 1);

/** Hoeffding plus a union bound over k outcomes: all within eps with probability >= 1 - beta. */
const hoeffding = (k: number, m: number, beta = 1e-6): number => Math.sqrt(Math.log((2 * k) / beta) / (2 * m));

const CLASS = new Space("Class", ["a", "b", "c"]);

/** Persistent class C at tick 0; x_t = f(x_{t-1}, C) and copies y_t = C at ticks 1..4. */
function classModel(): ExactModel {
  const third = R(1, 3);
  const copyRows = [0, 1, 2].map((c) => [0, 1, 2].map((j) => (j === c ? ONE : ZERO)));
  const stepRows = [0, 1].flatMap((x) => [0, 1, 2].map((c) => bern(R(1 + x + c, 6))));
  const writers = [1, 2, 3, 4].flatMap((t) => [
    { name: `x${t}`, tick: t, inputs: [[`x${t - 1}`, t - 1], ["C", 0]] as const, rows: stepRows },
    { name: `y${t}`, tick: t, inputs: [["C", 0]] as const, rows: copyRows, space: CLASS },
  ]);
  return {
    roots: [
      { name: "C", tick: 0, prior: [third, third, third], space: CLASS },
      { name: "x0", tick: 0, prior: bern(R(1, 2)) },
    ],
    writers,
  };
}

/** x0 fair, x_t = theta(x_{t-1}) for t = 1..4, theta's rows given. */
function thetaModel(rows: readonly (readonly Rational[])[]): ExactModel {
  return {
    roots: [{ name: "x0", tick: 0, prior: bern(R(1, 2)) }],
    writers: [1, 2, 3, 4].map((t) => ({ name: `x${t}`, tick: t, inputs: [[`x${t - 1}`, t - 1]] as const, rows })),
  };
}

describe("test_shared_cache", () => {
  it("reversing consumer order preserves seeded outputs", () => {
    const model = pairModel(NOISY_ROWS);
    const forward = modelPlan(model);
    const [a, b, p] = forward.nodes as [Plan["nodes"][number], Plan["nodes"][number], Plan["nodes"][number]];
    const reversed = planOf([b, a, p]);
    expect(reversed.graph_hash).toBe(forward.graph_hash);
    const options = { target: P, initial: priors(model), particles: 200, seed: 11, budget, replicates: 4 };
    const r1 = rollout(forward, options);
    const r2 = rollout(reversed, options);
    expect(r2).toStrictEqual(r1);
    expect(r1.seed).toBe(11);
    for (let i = 0; i < 50; i++) {
      const opts = { keys: [P], initial: priors(model), seed: 11, replicate: i % 4, particle: i };
      expect([...sampleTrajectory(reversed, opts).values].sort()).toStrictEqual([...sampleTrajectory(forward, opts).values].sort());
    }
    // A different seed changes the realizations.
    expect(rollout(forward, { ...options, seed: 12 }).probabilities).not.toStrictEqual(r1.probabilities);
  });

  it("copied children always equal their shared draw", () => {
    const model = pairModel();
    const plan = modelPlan(model);
    let ones = 0;
    for (let i = 0; i < 300; i++) {
      const t = sampleTrajectory(plan, { keys: [P], initial: priors(model), seed: 5, replicate: 0, particle: i });
      const z = t.values.get(variableKeyString(Z))!;
      expect(t.values.get(variableKeyString(A))).toBe(z);
      expect(t.values.get(variableKeyString(B))).toBe(z);
      expect(t.values.get(variableKeyString(P))).toBe(`["${z}","${z}"]`);
      if (z === "1") ones++;
    }
    expect(ones > 100 && ones < 200).toBe(true);
    const result = rollout(plan, { target: P, initial: priors(model), particles: 500, seed: 5, budget });
    expect(result.space.values).toStrictEqual(['["0","0"]', '["0","1"]', '["1","0"]', '["1","1"]']);
    expect(result.probabilities[1]).toBe(0);
    expect(result.probabilities[2]).toBe(0);
  });

  it("a persistent class never changes across ticks", () => {
    const model = classModel();
    const plan = modelPlan(model);
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const t = sampleTrajectory(plan, { keys: [key("x4", 4), key("y4", 4), key("y1", 1)], initial: priors(model), seed: 3, replicate: 1, particle: i });
      const c = t.values.get(variableKeyString(key("C", 0)))!;
      seen.add(c);
      for (const tick of [1, 4]) expect(t.values.get(variableKeyString(key(`y${tick}`, tick)))).toBe(c);
      expect(t.log_weight).toBe(0);
    }
    expect([...seen].sort()).toStrictEqual(["a", "b", "c"]);
    // Through rollout: the last copy is the class, so its estimate matches the uniform class law.
    const r = rollout(plan, { target: key("y4", 4), initial: priors(model), particles: 3000, seed: 3, budget });
    r.probabilities.forEach((p) => expect(Math.abs(p - 1 / 3)).toBeLessThanOrEqual(hoeffding(3, 3000 * 8)));
  });

  it("parameterDraw is called once per trajectory and reused at every tick", () => {
    const stay = modelPlan(thetaModel([bern(ZERO), bern(ONE)]));
    const toOne = modelPlan(thetaModel([bern(ONE), bern(ONE)]));
    expect(toOne.graph_hash).toBe(stay.graph_hash);
    expect(toOne.model_hash).not.toBe(stay.model_hash);
    const calls: number[] = [];
    const draw: ParameterDraw = (trajectory: number, stream: RandomStream) => {
      calls.push(trajectory);
      return stream.nextFloat() < 0.5 ? stay : toOne;
    };
    const initial = priors(thetaModel([bern(ZERO), bern(ONE)]));
    const result = rollout(stay, { target: key("x4", 4), initial, particles: 250, replicates: 4, seed: 9, budget, parameterDraw: draw });
    expect(calls).toHaveLength(1000);
    expect([...calls].sort((a, b) => a - b)).toStrictEqual(Array.from({ length: 1000 }, (_, i) => i));
    // P(x4 = 1) = 1/2 * 1/2 + 1/2 * 1 = 3/4 under a per-trajectory draw.
    expect(Math.abs(result.probabilities[1]! - 0.75)).toBeLessThanOrEqual(hoeffding(2, 1000));
    const keys = [1, 2, 3, 4].map((t) => key(`x${t}`, t));
    for (let i = 0; i < 100; i++) {
      const t = sampleTrajectory(stay, { keys, initial, seed: 9, replicate: 0, particle: i, particles: 250, parameterDraw: draw });
      const xs = [0, 1, 2, 3, 4].map((tick) => t.values.get(variableKeyString(key(`x${tick}`, tick))));
      // One theta for the whole trajectory: either every x_t copies x_0, or every x_t (t >= 1) is 1.
      expect(xs.every((x) => x === xs[0]) || xs.slice(1).every((x) => x === "1")).toBe(true);
    }
    const other = modelPlan(pairModel());
    raises(() => rollout(stay, { target: key("x4", 4), initial, particles: 2, seed: 9, budget, parameterDraw: () => other }), /same graph/);
  });
});

describe("test_particle_oracle", () => {
  it("unconditioned estimates are within the Hoeffding bound of the exact oracle, shared-child covariance included", () => {
    const model = pairModel(NOISY_ROWS);
    const plan = modelPlan(model);
    const initial = priors(model);
    const particles = 4000;
    const replicates = 8;
    const m = particles * replicates;
    const result = rollout(plan, { target: P, initial, particles, replicates, seed: 2026, budget });
    const oracle = exactQuery(plan, { target: P, initial, budget }).distribution;
    const eps = hoeffding(4, m);
    result.probabilities.forEach((p, j) => expect(Math.abs(p - oracle[j]!), `outcome ${j}`).toBeLessThanOrEqual(eps));
    expect(result.mc_se_method).toBe("binomial");
    result.mc_se.forEach((se, j) => expect(Math.abs(se - Math.sqrt((result.probabilities[j]! * (1 - result.probabilities[j]!)) / m))).toBeLessThan(1e-15));
    expect(Math.abs(result.ess - m)).toBeLessThan(1e-6 * m);
    expect(result.particles).toBe(particles);
    expect(result.replicates).toBe(replicates);

    // Shared-child covariance: with every joint cell within eps, |Δcov| <= 5 eps.
    const cov = (q: readonly number[]): number => q[3]! - (q[2]! + q[3]!) * (q[1]! + q[3]!);
    const exactCov = cov(oracle);
    expect(Math.abs(exactCov - 0.1225)).toBeLessThan(1e-12);
    expect(Math.abs(cov(result.probabilities) - exactCov)).toBeLessThanOrEqual(5 * eps);
    // Independent resampling per consumer (covariance 0) is rejected by the same bound.
    expect(cov(result.probabilities)).toBeGreaterThan(5 * eps);

    // A single child against its own oracle.
    const ra = rollout(plan, { target: A, initial, particles, replicates, seed: 2026, budget });
    const oa = exactQuery(plan, { target: A, initial, budget }).distribution;
    ra.probabilities.forEach((p, j) => expect(Math.abs(p - oa[j]!)).toBeLessThanOrEqual(hoeffding(2, m)));
  });

  it("weighted estimates fall within independent-replicate error intervals", () => {
    const model = pairModel(NOISY_ROWS);
    const plan = modelPlan(model);
    const initial = priors(model);
    const evidence: EvidencePair[] = [[B, "1"]];
    const hash = plan.model_hash;
    const result = rollout(plan, { target: A, evidence, initial, particles: 2000, replicates: 8, seed: 77, budget });
    const oracle = exactQuery(plan, { target: A, evidence, initial, budget }).distribution;
    expect(result.mc_se_method).toBe("replicate_ratio_delta");
    result.probabilities.forEach((p, j) => {
      expect(result.mc_se[j]!).toBeGreaterThan(0);
      expect(Math.abs(p - oracle[j]!)).toBeLessThanOrEqual(6 * result.mc_se[j]!);
    });
    // The estimate is the pooled ratio of the replicate sums, not a mean of replicate ratios.
    const A1 = result.replicate_numerators.reduce((s, a) => s + a[1]!, 0);
    const B1 = result.replicate_masses.reduce((s, b) => s + b, 0);
    expect(Math.abs(A1 / B1 - result.probabilities[1]!)).toBeLessThan(1e-12);
    expect(result.ess).toBeLessThan(16_000);
    expect(result.ess).toBeGreaterThan(1);
    expect(plan.model_hash).toBe(hash);
  });

  it("pools trajectory weights across replicates, with ESS and SE of that same ratio", () => {
    const model = pairModel(NOISY_ROWS);
    const plan = modelPlan(model);
    const initial = priors(model);
    const evidence: EvidencePair[] = [[B, "1"]];
    const particles = 5;
    const replicates = 3;
    const result = rollout(plan, { target: A, evidence, initial, particles, replicates, seed: 4, budget });
    // Independent recomputation from the same streams.
    const draws = Array.from({ length: replicates }, (_, r) =>
      Array.from({ length: particles }, (_, p) => {
        const t = sampleTrajectory(plan, { keys: [A], evidence, initial, seed: 4, replicate: r, particle: p, particles });
        return { w: Math.exp(t.log_weight), one: t.values.get(variableKeyString(A)) === "1" };
      }),
    );
    const flat = draws.flat();
    const mass = flat.reduce((s, d) => s + d.w, 0);
    const p1 = flat.reduce((s, d) => s + (d.one ? d.w : 0), 0) / mass;
    expect(Math.abs(result.probabilities[1]! - p1)).toBeLessThan(1e-12);
    expect(Math.abs(result.ess - mass ** 2 / flat.reduce((s, d) => s + d.w ** 2, 0))).toBeLessThan(1e-9);
    // Delta-method SE of the pooled ratio from replicate numerator/denominator pairs.
    const a = draws.map((ds) => ds.reduce((s, d) => s + (d.one ? d.w : 0), 0));
    const b = draws.map((ds) => ds.reduce((s, d) => s + d.w, 0));
    const se = Math.sqrt(a.reduce((s, ar, r) => s + (ar - p1 * b[r]!) ** 2, 0) / (replicates * (replicates - 1))) / (mass / replicates);
    expect(Math.abs(se - result.mc_se[1]!)).toBeLessThan(1e-12);
  });

  it("C5: one particle per replicate keeps the likelihood information", () => {
    // Prior 1/2, likelihoods 1/100 and 99/100; exact posterior 99/100.
    const model: ExactModel = {
      roots: [{ name: "X", tick: 0, prior: bern(R(1, 2)) }],
      writers: [{ name: "E", tick: 1, inputs: [["X", 0]], rows: [bern(R(1, 100)), bern(R(99, 100))] }],
    };
    const plan = modelPlan(model);
    const initial = priors(model);
    const evidence: EvidencePair[] = [[key("E", 1), "1"]];
    const big = bigBudget({ max_particles: 100_000 });
    const exact = exactQuery(plan, { target: key("X", 0), initial, evidence, budget: big }).distribution[1]!;
    expect(Math.abs(exact - 0.99)).toBeLessThan(1e-15);
    const weighted = rollout(plan, { target: key("X", 0), initial, evidence, budget: big, particles: 1, replicates: 4096, seed: 1907 });
    const prior = rollout(plan, { target: key("X", 0), initial, budget: big, particles: 1, replicates: 4096, seed: 1907 });
    // Before: 0.496826171875, the no-evidence value, 63 SE from the truth.
    expect(prior.probabilities[1]).toBe(0.496826171875);
    expect(weighted.probabilities[1]).not.toBe(prior.probabilities[1]);
    expect(Math.abs(weighted.probabilities[1]! - exact)).toBeLessThanOrEqual(3 * weighted.mc_se[1]!);
    expect(weighted.mc_se[1]!).toBeLessThan(1e-3);
    expect(weighted.ess).toBeGreaterThan(1000);
    expect(weighted.ess).toBeLessThan(4096);
  });

  it("the reported SE covers the true error at the nominal rate over 200 seeded runs", () => {
    const model: ExactModel = {
      roots: [{ name: "X", tick: 0, prior: bern(R(1, 2)) }],
      writers: [{ name: "E", tick: 1, inputs: [["X", 0]], rows: [bern(R(1, 100)), bern(R(99, 100))] }],
    };
    const plan = modelPlan(model);
    const initial = priors(model);
    const evidence: EvidencePair[] = [[key("E", 1), "1"]];
    const exact = exactQuery(plan, { target: key("X", 0), initial, evidence, budget }).distribution[1]!;
    let within1 = 0;
    let within2 = 0;
    const runs = 200;
    for (let seed = 0; seed < runs; seed++) {
      const r = rollout(plan, { target: key("X", 0), initial, evidence, budget, particles: 4, replicates: 16, seed });
      const z = Math.abs(r.probabilities[1]! - exact) / r.mc_se[1]!;
      if (z <= 1) within1++;
      if (z <= 2) within2++;
    }
    // Nominal 0.68 and 0.95 (t with 15 df: 0.67, 0.94); loose bounds both ways.
    expect(within1 / runs).toBeGreaterThan(0.5);
    expect(within1 / runs).toBeLessThan(0.85);
    expect(within2 / runs).toBeGreaterThan(0.85);
    expect(within2 / runs).toBeLessThan(0.995);
  });

  it("matches sampleTrajectory draw for draw", () => {
    const model = pairModel(NOISY_ROWS);
    const plan = modelPlan(model);
    const initial = priors(model);
    const result = rollout(plan, { target: A, initial, particles: 5, replicates: 2, seed: 4, budget });
    for (let r = 0; r < 2; r++) {
      const ones = [0, 1, 2, 3, 4].filter(
        (p) => sampleTrajectory(plan, { keys: [A], initial, seed: 4, replicate: r, particle: p }).values.get(variableKeyString(A)) === "1",
      ).length;
      expect(Math.abs(result.replicate_probabilities[r]![1]! - ones / 5)).toBeLessThan(1e-15);
    }
  });
});

describe("validation", () => {
  it("raises when every weight vanishes and on budget or replicate violations", () => {
    const model = pairModel(undefined, bern(ZERO));
    const plan = modelPlan(model);
    const initial = priors(model);
    raises(
      () => rollout(plan, { target: B, evidence: [[A, "1"]], initial, particles: 10, seed: 1, budget }),
      /every trajectory weight vanished/,
    );
    raises(() => rollout(plan, { target: B, initial, particles: 101, seed: 1, budget: bigBudget(), replicates: 1 }), /exceeds max_particles 100/);
    raises(() => rollout(plan, { target: B, initial, particles: 13, seed: 1, budget: bigBudget() }), /104 exceeds max_particles 100/);
    raises(() => rollout(plan, { target: B, evidence: [[A, "0"]], initial, particles: 10, seed: 1, budget, replicates: 1 }), /at least 2 replicates/);
    raises(() => rollout(plan, { target: B, initial: [], particles: 10, seed: 1, budget }), /missing prior for source key/);
    raises(() => rollout(plan, { target: key("nope", 0), initial, particles: 10, seed: 1, budget }), /is not a key of this plan/);
    raises(() => rollout(plan, { target: B, initial, particles: 0, seed: 1, budget }), /particles: expected a positive integer/);
    raises(() => rollout(plan, { target: B, initial, particles: 1, seed: -1, budget }), /seed/);
    raises(() => rollout(plan, { target: B, initial, particles: 1, seed: 1, budget, extra: 1 } as never), /unknown field/);
  });
});
