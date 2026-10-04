/** N6.rank: exact kernel-influence coefficients, path bounds, and pruning certificates (memo §3.3, §4.3, §4.4, §5.2). */
import { describe, expect, it } from "vitest";
import { variableKeyString } from "../src/causal/index.js";
import type { Plan, VariableKey } from "../src/causal/index.js";
import {
  boundsArtifact,
  certifyRemovals,
  coefficients,
  declaredCoefficients,
  floatCoefficients,
  nodeCoefficients,
  nodeGroups,
  targetBounds,
} from "../src/compress/influence.js";
import type { Coefficients, TargetBounds } from "../src/compress/influence.js";
import { kernelHashes, pagerank, planVertices, rankEdges } from "../src/compress/ranking.js";
import { applyInterventions, exactQuery } from "../src/inference/index.js";
import type { HardIntervention } from "../src/inference/index.js";
import { constant, Rational, UNIT, verifyHash } from "../src/index.js";
import type { EnvelopeFields } from "../src/index.js";
import { bigBudget } from "./fixtures/causal.js";
import {
  BIT,
  diamondModel,
  ENTITY,
  exactRational,
  hubModel,
  key,
  modelPlan,
  ONE,
  priors,
  R,
  SCENARIO,
  tvRational,
  ZERO,
} from "./fixtures/rank.js";
import type { ExactModel } from "./fixtures/rank.js";
import { raises } from "./support.js";

const budget = bigBudget();
const EPS = R(1, 20);
const envelope: EnvelopeFields = { origin: "simulated", scenario_id: SCENARIO, run_id: null, version: "influence.v1" };

/** Exact coefficients for every writer of a fixture model, aligned with its plan. */
function exactCoefficients(model: ExactModel, plan: Plan): Coefficients[] {
  return plan.nodes.map((node) => {
    const spec = model.writers.find((w) => variableKeyString(key(w.name, w.tick)) === variableKeyString(node.output))!;
    return nodeCoefficients(node, spec.rows);
  });
}

function boundsOf(model: ExactModel): { plan: Plan; bounds: TargetBounds; w: Map<string, Rational> } {
  const plan = modelPlan(model);
  const bounds = targetBounds(plan, exactCoefficients(model, plan), key("T", 2));
  return { plan, bounds, w: new Map(bounds.bounds.map(([k, v]) => [k[1], v] as const)) };
}

const tickOf = (model: ExactModel, name: string): number =>
  (model.roots.find((r) => r.name === name) ?? model.writers.find((w) => w.name === name))!.tick;

const clampKernel = (value: number) => constant(UNIT, BIT, BIT.values[value]!);

function hard(model: ExactModel, name: string, value: number): HardIntervention {
  const tick = tickOf(model, name);
  return { kind: "hard", target_variable: name, entity_id: ENTITY, value: BIT.values[value]!, start_step: tick, end_step_exclusive: tick + 1 };
}

describe("coefficients", () => {
  it("are exact maxima of TV over rows differing in one variable group", () => {
    const hub = hubModel();
    const t = hub.writers[2]!;
    const c = coefficients(t.rows, [2, 2, 2], [[0], [1], [2]]);
    expect(c.values.map(String)).toStrictEqual(["0", "0", "4/5"]);
    expect(c.source).toBe("exact");
    expect(c.unknown).toStrictEqual([false, false, false]);
    expect(c.comparisons).toBe(12);
    const identityRows = [
      [ONE, ZERO],
      [ZERO, ONE],
    ];
    expect(coefficients(identityRows, [2], [[0]]).values.map(String)).toStrictEqual(["1"]);
    // A ternary parent: the max is over every pair of its values, not adjacent ones.
    const third = [
      [R(1, 2), R(1, 2)],
      [R(3, 5), R(2, 5)],
      [R(9, 10), R(1, 10)],
    ];
    expect(coefficients(third, [3], [[0]]).values.map(String)).toStrictEqual(["2/5"]);
  });

  it("change ports bound to one variable together", () => {
    // Ports 0 and 1 both read X: only contexts (0,0) and (1,1) occur.
    const rows = [
      [R(9, 10), R(1, 10)], // (0, 0)
      [ZERO, ONE], // (0, 1): impossible
      [ONE, ZERO], // (1, 0): impossible
      [R(7, 10), R(3, 10)], // (1, 1)
    ];
    expect(coefficients(rows, [2, 2], [[0, 1]]).values.map(String)).toStrictEqual(["1/5"]);
    // Treating the copies as independently changeable ports reads impossible rows and gives other numbers.
    expect(coefficients(rows, [2, 2], [[0], [1]]).values.map(String)).toStrictEqual(["7/10", "9/10"]);
    // nodeGroups derives the grouping from a plan node's input keys.
    const plan = modelPlan({
      roots: [{ name: "X", tick: 0, prior: [R(1, 2), R(1, 2)] }],
      writers: [{ name: "Y", tick: 1, inputs: [["X", 0], ["X", 0]], rows }],
    });
    expect(nodeGroups(plan.nodes[0]!).groups).toStrictEqual([[0, 1]]);
    expect(nodeCoefficients(plan.nodes[0]!, rows).values.map(String)).toStrictEqual(["1/5"]);
  });

  it("count over-budget coefficients as 1 and reject bad rows", () => {
    const t = hubModel().writers[2]!;
    const c = coefficients(t.rows, [2, 2, 2], [[0], [1], [2]], { maxComparisons: 8 });
    expect(c.values.map(String)).toStrictEqual(["0", "0", "1"]);
    expect(c.unknown).toStrictEqual([false, false, true]);
    raises(() => coefficients([[R(1, 2), R(1, 3)]], [], []), /must sum to 1/);
    raises(() => coefficients([[ONE, ZERO]], [2], [[0]]), /expected 2 rows/);
    raises(() => coefficients(t.rows, [2, 2, 2], [[0], [1]]), /every port must be in exactly one group/);
    raises(() => coefficients(t.rows, [2, 2, 2], [[0, 1], [1, 2]]), /port 1 is in groups 0 and 1/);
    const plan = modelPlan(hubModel());
    const wrong = hubModel((_u, _v, s) => R(1, 10).add(R(7, 10).mul(R(s)))).writers[2]!.rows;
    raises(() => nodeCoefficients(plan.nodes[2]!, wrong), /does not match the frozen kernel/);
  });
});

describe("test_inert_hub", () => {
  it("memo §5.2: PPR ranks the hub above S, but its bound is 0 versus 0.8", () => {
    const { plan, bounds, w } = boundsOf(hubModel());
    const vertices = planVertices(plan);
    const T = key("T", 2);
    const r = pagerank(rankEdges(plan), vertices, [[T, 1]]);
    const ppr = new Map(vertices.map((k, i) => [k[1], r.scores[i]!] as const));
    const table: Record<string, number> = { T: 0.42887777, H: 0.206576126, S: 0.121515368, U: 0.121515368, V: 0.121515368 };
    for (const [name, value] of Object.entries(table)) expect(Math.abs(ppr.get(name)! - value), name).toBeLessThanOrEqual(1e-9);
    // Closed form at a stricter tolerance, as in the appendix script.
    const d = 0.85;
    const pT = 1 / (1 + d + (2 * d * d) / 3);
    const strict = pagerank(rankEdges(plan), vertices, [[T, 1]], { tolerance: 1e-12 });
    const closed: Record<string, number> = { T: pT, H: ((2 * d * d) / 3) * pT, S: (d / 3) * pT, U: (d / 3) * pT, V: (d / 3) * pT };
    vertices.forEach((k, i) => expect(Math.abs(strict.scores[i]! - closed[k[1]]!)).toBeLessThan(1e-12));
    expect(ppr.get("H")!).toBeGreaterThan(ppr.get("S")!);

    expect([...w.entries()].map(([k, v]) => [k, v.toString()])).toStrictEqual([
      ["H", "0"],
      ["S", "4/5"],
      ["T", "1"],
      ["U", "0"],
      ["V", "0"],
    ]);
    expect(bounds.source).toBe("exact");

    const model = hubModel();
    const base = exactRational(model, "T");
    expect(base[1]!.toString()).toBe("1/2");
    const clampH = exactRational(model, "T", new Map([["H", 0]]));
    const clampS = exactRational(model, "T", new Map([["S", 0]]));
    expect(clampH[1]!.toString()).toBe("1/2");
    expect(clampS[1]!.toString()).toBe("1/10");
    expect(tvRational(base, clampH).toString()).toBe("0");
    expect(tvRational(base, clampS).toString()).toBe("2/5");

    const hubCert = certifyRemovals(bounds, [[key("H", 0), ONE]], EPS, { replacements: [[key("H", 0), clampKernel(0)]] });
    expect(hubCert.bound.toString()).toBe("0");
    expect(hubCert.accepted).toBe(true);
    const sCert = certifyRemovals(bounds, [[key("S", 0), ONE]], EPS, { replacements: [[key("S", 0), clampKernel(0)]] });
    expect(sCert.bound.toString()).toBe("4/5");
    expect(sCert.accepted).toBe(false);
  });
});

describe("test_two_path_bound", () => {
  it("both paths add: w_R = 0.2 + 0.3 = 0.5, the exact root-flip TV", () => {
    const model = diamondModel();
    const { w } = boundsOf(model);
    expect(w.get("A")!.toString()).toBe("1/5");
    expect(w.get("B")!.toString()).toBe("3/10");
    expect(w.get("R")!.toString()).toBe("1/2");
    const flip = tvRational(exactRational(model, "T", new Map([["R", 1]])), exactRational(model, "T", new Map([["R", 0]])));
    expect(flip.toString()).toBe("1/2");
    expect(w.get("R")!.equals(flip)).toBe(true);
  });
});

describe("test_pruning_certificate", () => {
  for (const [name, make] of [
    ["inert hub", hubModel],
    ["two-path diamond", diamondModel],
  ] as const) {
    it(`${name}: every clamp set and assignment has exact target TV <= certificate; accepted sets have TV < eps`, () => {
      const model = make();
      const { plan, bounds } = boundsOf(model);
      const ancestors = [...model.roots.map((r) => r.name), ...model.writers.map((w) => w.name)].filter((n) => n !== "T");
      const base = exactRational(model, "T");
      const floatBase = exactQuery(plan, { target: key("T", 2), initial: priors(model), budget }).distribution;
      let accepted = 0;
      let checked = 0;
      const total = 3 ** ancestors.length;
      for (let code = 0; code < total; code++) {
        const clamps = new Map<string, number>();
        let rest = code;
        for (const v of ancestors) {
          const choice = rest % 3;
          rest = Math.floor(rest / 3);
          if (choice > 0) clamps.set(v, choice - 1);
        }
        const keys = [...clamps.keys()].map((v) => key(v, tickOf(model, v)));
        const cert = certifyRemovals(
          bounds,
          keys.map((k) => [k, ONE] as const),
          EPS,
          { replacements: keys.map((k) => [k, clampKernel(clamps.get(k[1])!)] as const) },
        );
        const tv = tvRational(base, exactRational(model, "T", clamps));
        expect(tv.cmp(cert.bound) <= 0, `${[...clamps]}`).toBe(true);
        if (cert.accepted) {
          accepted++;
          expect(tv.cmp(EPS) < 0).toBe(true);
        }
        // Same answer through diagram surgery on the float plan.
        if (clamps.size > 0) {
          const cut = applyInterventions(plan, [...clamps].map(([v, value]) => hard(model, v, value)));
          const p = exactQuery(cut, { target: key("T", 2), initial: priors(model), budget }).distribution;
          expect(Math.abs(Math.abs(p[1]! - floatBase[1]!) - tv.toNumber())).toBeLessThanOrEqual(1e-12);
        }
        checked++;
      }
      expect(checked).toBe(total);
      expect(accepted).toBeGreaterThan(0);
    });
  }

  it("refuses a filtering request and non-certifiable coefficients; unknown coefficients count as 1", () => {
    const model = hubModel();
    const { plan, bounds } = boundsOf(model);
    raises(() => certifyRemovals(bounds, [[key("H", 0), ONE]], EPS, { evidencePresent: true }), /no pruning certificate for a filtering or conditioning query/);

    const exact = exactCoefficients(model, plan);
    const floats = [...exact];
    floats[2] = floatCoefficients(plan.nodes[2]!.operator.rows, [2, 2, 2], [[0], [1], [2]]);
    expect(floats[2]!.values[2]!.toNumber()).toBeCloseTo(0.8, 12);
    const fb = targetBounds(plan, floats, key("T", 2));
    expect(fb.source).toBe("float");
    raises(() => certifyRemovals(fb, [[key("H", 0), ONE]], EPS), /float maxima are diagnostics, not certificates/);
    const sampled = [...exact];
    sampled[2] = declaredCoefficients([ZERO, ZERO, R(4, 5)], "sampled");
    raises(() => certifyRemovals(targetBounds(plan, sampled, key("T", 2)), [[key("H", 0), ONE]], EPS), /sampled maxima/);
    // Proved upper bounds certify.
    const proved = [...exact];
    proved[2] = declaredCoefficients([R(1, 100), ZERO, R(4, 5)], "proved_bound");
    const pb = targetBounds(plan, proved, key("T", 2));
    expect(pb.source).toBe("proved_bound");
    expect(certifyRemovals(pb, [[key("H", 0), ONE]], EPS).bound.toString()).toBe("1/100");
    // A forged bounds object is not accepted.
    raises(() => certifyRemovals({ ...bounds }, [[key("H", 0), ONE]], EPS), /expected TargetBounds from targetBounds/);

    // Missing coefficients: every coefficient of that writer counts as 1 (conservative, still exact).
    const unknown = targetBounds(plan, [exact[0]!, exact[1]!, null], key("T", 2));
    const w = new Map(unknown.bounds.map(([k, v]) => [k[1], v.toString()] as const));
    expect(Object.fromEntries(w)).toStrictEqual({ H: "2", S: "1", T: "1", U: "1", V: "1" });
    expect(unknown.unknown_writers).toBe(1);
    const capped = certifyRemovals(unknown, [[key("H", 0), ONE]], EPS);
    expect(capped.bound.toString()).toBe("1");
    expect(capped.accepted).toBe(false);
    raises(() => targetBounds(plan, exact.slice(1), key("T", 2)), /one entry per plan node/);
    raises(() => targetBounds(plan, [exact[0]!, exact[1]!, { ...exact[2]! } as Coefficients], key("T", 2)), /expected Coefficients/);
  });

  it("records the removal set, replacement kernels, epsilon, and the exact cumulative bound", () => {
    const model = diamondModel();
    const { plan, bounds } = boundsOf(model);
    const before = kernelHashes(plan).map((p) => [...p]);
    const removal: [VariableKey, Rational][] = [
      [key("B", 1), R(1, 10)],
      [key("A", 1), R(1, 10)],
    ];
    const cert = certifyRemovals(bounds, removal, EPS, { replacements: [[key("A", 1), clampKernel(1)]] });
    // Cumulative: 0.2 * 0.1 + 0.3 * 0.1 = 0.05, which is not < 0.05.
    expect(cert.bound.toString()).toBe("1/20");
    expect(cert.accepted).toBe(false);
    expect(cert.removal_set.map((k) => k[1])).toStrictEqual(["A", "B"]);
    expect(cert.replacement_kernels.map(([k, kernel]) => [k[1], kernel === null ? null : kernel.rows[0]])).toStrictEqual([
      ["A", [0, 1]],
      ["B", null],
    ]);
    expect(cert.eps_tv.toString()).toBe("1/20");
    expect(cert.model_hash).toBe(plan.model_hash);
    const looser = certifyRemovals(bounds, removal, R(1, 10), { replacements: [[key("A", 1), clampKernel(1)]] });
    expect(looser.accepted).toBe(true);
    expect(looser.content_hash).not.toBe(cert.content_hash);
    expect(certifyRemovals(bounds, [...removal].reverse(), EPS, { replacements: [[key("A", 1), clampKernel(1)]] }).content_hash).toBe(cert.content_hash);
    raises(() => certifyRemovals(bounds, [[key("A", 1), R(3, 2)]], EPS), /outside \[0, 1\]/);
    raises(() => certifyRemovals(bounds, [[key("Q", 0), ONE]], EPS), /not a key of the bounded plan/);
    raises(() => certifyRemovals(bounds, [[key("A", 1), ONE], [key("A", 1), ONE]], EPS), /duplicate removal/);
    raises(() => certifyRemovals(bounds, [], ZERO), /positive Rational/);

    // The tv_path_bound artifact points at the certificate.
    const artifact = boundsArtifact(bounds, envelope, { certificate: looser, horizon: 2 });
    verifyHash(artifact);
    expect(artifact.algorithm).toBe("tv_path_bound");
    expect(artifact.certificate_ref).toBe(looser.content_hash);
    expect(artifact.residual_bound).toBeNull();
    expect(new Map(artifact.scores.map(([k, v]) => [k[1], v])).get("R")).toBe(0.5);
    // Influence computations never touch a kernel.
    expect(kernelHashes(plan).map((p) => [...p])).toStrictEqual(before);
  });
});
