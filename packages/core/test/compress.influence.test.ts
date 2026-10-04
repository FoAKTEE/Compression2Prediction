/** N6.rank: exact kernel-influence coefficients, path bounds, and pruning certificates (memo §3.3, §4.3, §4.4, §5.2; D23). */
import { describe, expect, it } from "vitest";
import { variableKeyString } from "../src/causal/index.js";
import type { Plan, VariableKey } from "../src/causal/index.js";
import {
  boundsArtifact,
  certificateScope,
  certifyRemovals,
  coefficients,
  declaredCoefficients,
  floatCoefficients,
  initialLawHash,
  nodeCoefficients,
  nodeGroups,
  targetBounds,
} from "../src/compress/influence.js";
import type { CertificateScopeInput, Coefficients, TargetBounds } from "../src/compress/influence.js";
import { kernelHashes, pagerank, planVertices, rankEdges } from "../src/compress/ranking.js";
import { applyInterventions, exactQuery, runQuery } from "../src/inference/index.js";
import type { HardIntervention, Prior } from "../src/inference/index.js";
import { constant, Kernel, Rational, Space, UNIT, verifyHash } from "../src/index.js";
import type { EnvelopeFields } from "../src/index.js";
import { bigBudget } from "./fixtures/causal.js";
import { bit, modelA } from "./fixtures/inference.js";
import {
  bern,
  BIT,
  binaryRows,
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

/** ``w``: exact-row bounds; ``wu``: bounds with the float allowance (what certificates use). */
function boundsOf(model: ExactModel, target = key("T", 2)): { plan: Plan; bounds: TargetBounds; w: Map<string, Rational>; wu: Map<string, Rational> } {
  const plan = modelPlan(model);
  const bounds = targetBounds(plan, exactCoefficients(model, plan), target);
  const named = (pairs: TargetBounds["bounds"]) => new Map(pairs.map(([k, v]) => [k[1], v] as const));
  return { plan, bounds, w: named(bounds.exact_bounds), wu: named(bounds.bounds) };
}

/** Unconditioned scope of a fixture model: its priors, no interventions. */
const scopeOf = (model: ExactModel, horizon = 2): CertificateScopeInput => ({ initial: priors(model), interventions: [], horizon, conditioning: "none" });

const tickOf = (model: ExactModel, name: string): number =>
  (model.roots.find((r) => r.name === name) ?? model.writers.find((w) => w.name === name))!.tick;

const clampKernel = (value: number) => constant(UNIT, BIT, BIT.values[value]!);

function hard(model: ExactModel, name: string, value: number): HardIntervention {
  const tick = tickOf(model, name);
  return { kind: "hard", target_variable: name, entity_id: ENTITY, value: BIT.values[value]!, start_step: tick, end_step_exclusive: tick + 1 };
}

/** Upper bound on float noise in these fixtures: η of a decimal row is below 2^-53. */
const TINY = Rational.of(1n, 2n ** 50n);

describe("coefficients", () => {
  it("are exact maxima of TV over rows differing in one variable group", () => {
    const hub = hubModel();
    const t = hub.writers[2]!;
    const c = coefficients(t.rows, [2, 2, 2], [[0], [1], [2]]);
    expect(c.values.map(String)).toStrictEqual(["0", "0", "4/5"]);
    expect(c.source).toBe("exact");
    expect(c.unknown).toStrictEqual([false, false, false]);
    expect(c.comparisons).toBe(12);
    // A bare table is not tied to any node.
    expect(c.binding).toBeNull();
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

  it("node coefficients carry their binding, exact rows, and the exact float discrepancy η", () => {
    const model = hubModel();
    const plan = modelPlan(model);
    const [u, , t] = exactCoefficients(model, plan);
    // Identity rows are binary fractions: no discrepancy.
    expect(u!.allowance.toString()).toBe("0");
    // 1/10 and 9/10 are not: η = max_x TV(exact row, float row read exactly).
    const eta = tvRational(bern(R(1, 10)), [Rational.fromNumber(0.9), Rational.fromNumber(0.1)]);
    expect(t!.allowance.equals(eta)).toBe(true);
    expect(t!.allowance.cmp(ZERO) > 0 && t!.allowance.cmp(TINY) < 0).toBe(true);
    expect(t!.binding).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(t!.exact_rows!.map((r) => r.map(String))).toStrictEqual(model.writers[2]!.rows.map((r) => r.map(String)));
    expect(t!.binding).not.toBe(u!.binding);
  });
});

describe("test_inert_hub", () => {
  it("memo §5.2: PPR ranks the hub above S, but its bound is 0 versus 0.8", () => {
    const { plan, bounds, w, wu } = boundsOf(hubModel());
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

    // Exact-row model: the memo's numbers.
    expect([...w.entries()].map(([k, v]) => [k, v.toString()])).toStrictEqual([
      ["H", "0"],
      ["S", "4/5"],
      ["T", "1"],
      ["U", "0"],
      ["V", "0"],
    ]);
    expect(bounds.source).toBe("exact");
    // Executed float kernels: T's rows 1/10, 9/10 are not binary fractions, so the float kernel may vary with
    // U and V by up to 2η; the hub's bound is a few ulps above 0, never below the exact one.
    for (const [name, v] of w) {
      expect(wu.get(name)!.cmp(v) >= 0, name).toBe(true);
      expect(wu.get(name)!.sub(v).cmp(TINY) < 0, name).toBe(true);
    }
    expect(wu.get("H")!.cmp(ZERO) > 0).toBe(true);

    const model = hubModel();
    const base = exactRational(model, "T");
    expect(base[1]!.toString()).toBe("1/2");
    const clampH = exactRational(model, "T", new Map([["H", 0]]));
    const clampS = exactRational(model, "T", new Map([["S", 0]]));
    expect(clampH[1]!.toString()).toBe("1/2");
    expect(clampS[1]!.toString()).toBe("1/10");
    expect(tvRational(base, clampH).toString()).toBe("0");
    expect(tvRational(base, clampS).toString()).toBe("2/5");

    // H and S are fair: replacing either prior by a point mass has local defect 1/2.
    const hubCert = certifyRemovals(bounds, { replacements: [[key("H", 0), clampKernel(0)]], scope: scopeOf(model) }, EPS);
    expect(hubCert.defects.map(([k, e]) => [k[1], e.toString()])).toStrictEqual([["H", "1/2"]]);
    expect(hubCert.bound.cmp(TINY) < 0).toBe(true);
    expect(hubCert.accepted).toBe(true);
    const sCert = certifyRemovals(bounds, { replacements: [[key("S", 0), clampKernel(0)]], scope: scopeOf(model) }, EPS);
    expect(sCert.bound.cmp(R(2, 5)) >= 0 && sCert.bound.sub(R(2, 5)).cmp(TINY) < 0).toBe(true);
    expect(sCert.accepted).toBe(false);
  });
});

describe("test_two_path_bound", () => {
  it("both paths add: w_R = 0.2 + 0.3 = 0.5, the exact root-flip TV", () => {
    const model = diamondModel();
    const { w, wu } = boundsOf(model);
    expect(w.get("A")!.toString()).toBe("1/5");
    expect(w.get("B")!.toString()).toBe("3/10");
    expect(w.get("R")!.toString()).toBe("1/2");
    const flip = tvRational(exactRational(model, "T", new Map([["R", 1]])), exactRational(model, "T", new Map([["R", 0]])));
    expect(flip.toString()).toBe("1/2");
    expect(w.get("R")!.equals(flip)).toBe(true);
    // The float allowance only adds.
    expect(wu.get("R")!.cmp(flip) >= 0 && wu.get("R")!.sub(flip).cmp(TINY) < 0).toBe(true);
  });
});

describe("test_pruning_certificate", () => {
  for (const [name, make, nonempty] of [
    ["inert hub", hubModel, true],
    ["two-path diamond", diamondModel, false],
  ] as const) {
    it(`${name}: every clamp set and assignment has exact target TV <= certificate; accepted sets have TV < eps`, () => {
      const model = make();
      const { plan, bounds } = boundsOf(model);
      const ancestors = [...model.roots.map((r) => r.name), ...model.writers.map((w) => w.name)].filter((n) => n !== "T");
      const base = exactRational(model, "T");
      const floatBase = exactQuery(plan, { target: key("T", 2), initial: priors(model), budget }).distribution;
      let accepted = 0;
      let acceptedNonempty = 0;
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
        const cert = certifyRemovals(bounds, { replacements: keys.map((k) => [k, clampKernel(clamps.get(k[1])!)] as const), scope: scopeOf(model) }, EPS);
        const tv = tvRational(base, exactRational(model, "T", clamps));
        expect(tv.cmp(cert.bound) <= 0, `${[...clamps]}`).toBe(true);
        if (cert.accepted) {
          accepted++;
          if (clamps.size > 0) acceptedNonempty++;
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
      // The hub's inert writers are certified as a set; nothing nonempty is certifiable in the diamond at 1/20.
      expect(acceptedNonempty > 0).toBe(nonempty);
    });
  }

  it("computed defects stay sound on all 16 binary Boolean targets with a shared cause (nonempty sets accepted)", () => {
    let cases = 0;
    let acceptedNonempty = 0;
    for (let mask = 0; mask < 16; mask++) {
      // A dyadic prior, so the executed float law is the exact one.
      const model: ExactModel = {
        roots: [{ name: "X", tick: 0, prior: bern(R(1, 4)) }],
        writers: [
          { name: "A", tick: 1, inputs: [["X", 0]], rows: [bern(ZERO), bern(ONE)] },
          { name: "B", tick: 1, inputs: [["X", 0]], rows: [bern(ZERO), bern(ONE)] },
          { name: "T", tick: 2, inputs: [["A", 1], ["B", 1]], rows: binaryRows(2, (a, b) => R((mask >> (2 * a + b)) & 1)) },
        ],
      };
      const { bounds } = boundsOf(model);
      const names = ["X", "A", "B", "T"];
      const base = exactRational(model, "T");
      for (let code = 0; code < 3 ** names.length; code++) {
        let rest = code;
        const clamps = new Map<string, number>();
        for (const n of names) {
          const v = rest % 3;
          rest = Math.floor(rest / 3);
          if (v > 0) clamps.set(n, v - 1);
        }
        const replacements = [...clamps].map(([n, v]) => [key(n, tickOf(model, n)), clampKernel(v)] as const);
        const cert = certifyRemovals(bounds, { replacements, scope: scopeOf(model) }, EPS);
        const tv = tvRational(base, exactRational(model, "T", clamps));
        expect(tv.cmp(cert.bound) <= 0, `mask ${mask} ${[...clamps]}`).toBe(true);
        if (cert.accepted) {
          expect(tv.cmp(EPS) < 0).toBe(true);
          if (clamps.size > 0) acceptedNonempty++;
        }
        cases++;
      }
    }
    expect(cases).toBe(16 * 81);
    expect(acceptedNonempty).toBeGreaterThan(0);
  });

  it("refuses conditioning and non-certifiable coefficients; unknown coefficients count as 1", () => {
    const model = hubModel();
    const { plan, bounds } = boundsOf(model);
    const H: [VariableKey, Kernel | null] = [key("H", 0), null];
    const candidate = { replacements: [H], scope: scopeOf(model) };
    raises(() => certifyRemovals(bounds, candidate, EPS, { evidencePresent: true }), /no pruning certificate for a filtering or conditioning query/);
    raises(
      () => certifyRemovals(bounds, { ...candidate, scope: { ...scopeOf(model), conditioning: "evidence" as "none" } }, EPS),
      /no pruning certificate for a filtering or conditioning query/,
    );

    const exact = exactCoefficients(model, plan);
    const floats = [...exact];
    floats[2] = floatCoefficients(plan.nodes[2]!);
    expect(floats[2]!.values[2]!.toNumber()).toBeCloseTo(0.8, 12);
    const fb = targetBounds(plan, floats, key("T", 2));
    expect(fb.source).toBe("float");
    raises(() => certifyRemovals(fb, candidate, EPS), /float maxima are diagnostics, not certificates/);
    const sampled = [...exact];
    sampled[2] = declaredCoefficients(plan.nodes[2]!, [ZERO, ZERO, R(4, 5)], "sampled");
    raises(() => certifyRemovals(targetBounds(plan, sampled, key("T", 2)), candidate, EPS), /sampled maxima/);
    // Proved upper bounds for a node's executed kernel certify; they carry no float allowance.
    const proved = [...exact];
    proved[2] = declaredCoefficients(plan.nodes[2]!, [R(1, 100), ZERO, R(4, 5)], "proved_bound");
    const pb = targetBounds(plan, proved, key("T", 2));
    expect(pb.source).toBe("proved_bound");
    expect(certifyRemovals(pb, candidate, EPS).bound.toString()).toBe("1/100");
    raises(() => declaredCoefficients(plan.nodes[2]!, [ZERO], "proved_bound"), /1 coefficients for 3 distinct parent variables/);
    // A forged bounds object is not accepted.
    raises(() => certifyRemovals({ ...bounds }, candidate, EPS), /expected TargetBounds from targetBounds/);

    // Missing coefficients: every coefficient of that writer counts as 1 (conservative, still exact).
    const unknown = targetBounds(plan, [exact[0]!, exact[1]!, null], key("T", 2));
    const w = new Map(unknown.bounds.map(([k, v]) => [k[1], v.toString()] as const));
    expect(Object.fromEntries(w)).toStrictEqual({ H: "2", S: "1", T: "1", U: "1", V: "1" });
    expect(unknown.unknown_writers).toBe(1);
    const capped = certifyRemovals(unknown, candidate, EPS);
    expect(capped.bound.toString()).toBe("1");
    expect(capped.accepted).toBe(false);
    raises(() => targetBounds(plan, exact.slice(1), key("T", 2)), /one entry per plan node/);
    raises(() => targetBounds(plan, [exact[0]!, exact[1]!, { ...exact[2]! } as Coefficients], key("T", 2)), /expected Coefficients/);
    // A bare table, or another node's coefficients, are refused.
    const bare = coefficients(model.writers[2]!.rows, [2, 2, 2], [[0], [1], [2]]);
    raises(() => targetBounds(plan, [exact[0]!, exact[1]!, bare], key("T", 2)), /unbound coefficients/);
    raises(() => targetBounds(plan, [exact[1]!, exact[0]!, exact[2]!], key("T", 2)), /binding mismatch/);
  });

  it("records the removal set, replacement kernels, scope, epsilon, and the exact cumulative bound", () => {
    const model = diamondModel();
    const { plan, bounds, w } = boundsOf(model);
    const before = kernelHashes(plan).map((p) => [...p]);
    const replacements: [VariableKey, Kernel | null][] = [
      [key("B", 1), null],
      [key("A", 1), clampKernel(1)],
    ];
    const cert = certifyRemovals(bounds, { replacements, scope: scopeOf(model) }, EPS);
    // A = R replaced by the constant 1 has local defect 1; B's unknown replacement counts as 1.
    expect(cert.defects.map(([k, e]) => [k[1], e.toString()])).toStrictEqual([
      ["A", "1"],
      ["B", "1"],
    ]);
    // Exact part 1/5 + 3/10 = 1/2, plus the float allowance.
    expect(cert.bound.sub(cert.numerical_allowance).toString()).toBe("1/2");
    expect(cert.numerical_allowance.cmp(TINY) < 0).toBe(true);
    expect(cert.accepted).toBe(false);
    expect(cert.removal_set.map((k) => k[1])).toStrictEqual(["A", "B"]);
    expect(cert.replacement_kernels.map(([k, kernel]) => [k[1], kernel === null ? null : kernel.rows[0]])).toStrictEqual([
      ["A", [0, 1]],
      ["B", null],
    ]);
    expect(cert.eps_tv.toString()).toBe("1/20");
    expect(cert.model_hash).toBe(plan.model_hash);
    expect(cert.scope).toStrictEqual(certificateScope(scopeOf(model)));
    expect(cert.conditional).toBeNull();
    expect(w.get("A")!.add(w.get("B")!).toString()).toBe("1/2");
    const looser = certifyRemovals(bounds, { replacements, scope: scopeOf(model) }, R(3, 5));
    expect(looser.accepted).toBe(true);
    expect(looser.content_hash).not.toBe(cert.content_hash);
    expect(certifyRemovals(bounds, { replacements: [...replacements].reverse(), scope: scopeOf(model) }, EPS).content_hash).toBe(cert.content_hash);
    const scope = scopeOf(model);
    raises(() => certifyRemovals(bounds, { replacements: [[key("Q", 0), null]], scope }, EPS), /not a key of the bounded plan/);
    raises(() => certifyRemovals(bounds, { replacements: [[key("A", 1), null], [key("A", 1), null]], scope }, EPS), /duplicate removal/);
    raises(() => certifyRemovals(bounds, { replacements: [], scope }, ZERO), /positive Rational/);
    raises(() => certifyRemovals(bounds, { replacements: [[key("A", 1), "kernel" as never]], scope }, EPS), /expected a Kernel or null/);
    raises(() => certifyRemovals(bounds, { replacements: [] } as never, EPS), /missing field\(s\) scope/);
    // Replacement interfaces: a writer's reads its inputs or nothing; a source's is a prior from Unit.
    const OTHER = new Space("Other", ["a", "b"]);
    raises(() => certifyRemovals(bounds, { replacements: [[key("A", 1), new Kernel(UNIT, OTHER, [[1, 0]])]], scope }, EPS), /replacement target/);
    raises(() => certifyRemovals(bounds, { replacements: [[key("T", 2), new Kernel(BIT, BIT, [[1, 0], [0, 1]])]], scope }, EPS), /must read the writer's inputs/);
    raises(() => certifyRemovals(bounds, { replacements: [[key("R", 0), new Kernel(BIT, BIT, [[1, 0], [0, 1]])]], scope }, EPS), /from Unit/);
    // Same-interface replacement: defect is the worst context. Identity -> noisy copy.
    const noisy = new Kernel(BIT, BIT, [[0.75, 0.25], [0.25, 0.75]]);
    const soft = certifyRemovals(bounds, { replacements: [[key("A", 1), noisy]], scope }, EPS);
    expect(soft.defects[0]![1].toString()).toBe("1/4");

    // The tv_path_bound artifact points at the certificate.
    const artifact = boundsArtifact(bounds, envelope, { certificate: looser, horizon: 2 });
    verifyHash(artifact);
    expect(artifact.algorithm).toBe("tv_path_bound");
    expect(artifact.certificate_ref).toBe(looser.content_hash);
    expect(artifact.residual_bound).toBeNull();
    // Scores are float views of the executed bounds: T's decimal rows add 2η, one ulp above 0.5 here.
    const rScore = new Map(artifact.scores.map(([k, v]) => [k[1], v])).get("R")!;
    expect(rScore).toBeGreaterThanOrEqual(0.5);
    expect(rScore - 0.5).toBeLessThan(1e-15);
    // Influence computations never touch a kernel.
    expect(kernelHashes(plan).map((p) => [...p])).toStrictEqual(before);
  });
});

describe("F01: certificates bind their premises", () => {
  // X ~ point mass at 0; Y reads X.
  const oldModel: ExactModel = {
    roots: [{ name: "X", tick: 0, prior: bern(ZERO) }],
    writers: [{ name: "Y", tick: 1, inputs: [["X", 0]], rows: [bern(ZERO), bern(ZERO)] }],
  };
  const newModel: ExactModel = { ...oldModel, writers: [{ ...oldModel.writers[0]!, rows: [bern(ZERO), bern(ONE)] }] };

  it("C1: a coefficient computed for a former kernel raises instead of certifying the new one", () => {
    const oldPlan = modelPlan(oldModel);
    const newPlan = modelPlan(newModel);
    expect(oldPlan.model_hash).not.toBe(newPlan.model_hash);
    const stale = exactCoefficients(oldModel, oldPlan);
    // Before: accepted with bound 0 at 1/20 while the clamp's true TV is 1. Now: the binding does not match.
    raises(() => targetBounds(newPlan, stale, key("Y", 1)), /binding mismatch/);
    // Fresh coefficients give the honest answer.
    const fresh = targetBounds(newPlan, exactCoefficients(newModel, newPlan), key("Y", 1));
    const cert = certifyRemovals(fresh, { replacements: [[key("X", 0), clampKernel(1)]], scope: scopeOf(newModel, 1) }, EPS);
    const trueTV = tvRational(exactRational(newModel, "Y"), exactRational(newModel, "Y", new Map([["X", 1]])));
    expect(trueTV.toString()).toBe("1");
    expect(cert.bound.toString()).toBe("1");
    expect(cert.accepted).toBe(false);
  });

  it("C3: caller-declared defects are an unverified diagnostic, never an accepted certificate", () => {
    const model = diamondModel();
    const { bounds } = boundsOf(model);
    const cert = certifyRemovals(
      bounds,
      { replacements: [[key("A", 1), clampKernel(1)], [key("B", 1), null]], scope: scopeOf(model) },
      R(1, 10),
      { declaredDefects: [[key("A", 1), R(1, 10)], [key("B", 1), R(1, 10)]] },
    );
    // Before: accepted with bound 1/20 at 1/10. Clamping A and B to 1 has true TV 1/4.
    const trueTV = tvRational(exactRational(model, "T"), exactRational(model, "T", new Map([["A", 1], ["B", 1]])));
    expect(trueTV.toString()).toBe("1/4");
    expect(cert.accepted).toBe(false);
    expect(trueTV.cmp(cert.bound) <= 0).toBe(true);
    expect(cert.conditional!.status).toBe("unverified");
    expect(cert.conditional!.below_eps).toBe(true);
    expect(cert.conditional!.bound.sub(R(1, 20)).cmp(TINY) < 0).toBe(true);
    raises(
      () => certifyRemovals(bounds, { replacements: [[key("A", 1), null]], scope: scopeOf(model) }, R(1, 10), { declaredDefects: [[key("B", 1), ZERO]] }),
      /not in the removal set/,
    );
    raises(
      () => certifyRemovals(bounds, { replacements: [[key("A", 1), null]], scope: scopeOf(model) }, R(1, 10), { declaredDefects: [[key("A", 1), R(3, 2)]] }),
      /outside \[0, 1\]/,
    );
    raises(
      () => certifyRemovals(bounds, { replacements: [[key("A", 1), null], [key("B", 1), null]], scope: scopeOf(model) }, R(1, 10), { declaredDefects: [[key("A", 1), ZERO]] }),
      /one defect per removed key/,
    );
  });

  it("C4: model_hash ignores priors, so the scope carries an initial-law hash; opposite laws give different scopes", () => {
    const plan = modelA();
    const target = bit("y", 0);
    const law = (p: number[]): Prior[] => [[bit("x", 0), p]];
    const q0 = runQuery(plan, { query_kind: "observational", target, initial: law([1, 0]), budget });
    const q1 = runQuery(plan, { query_kind: "observational", target, initial: law([0, 1]), budget });
    expect(q0.model_hash).toBe(q1.model_hash);
    expect([q0.distribution, q1.distribution]).toStrictEqual([
      [1, 0],
      [0, 1],
    ]);
    expect(initialLawHash(law([1, 0]))).not.toBe(initialLawHash(law([0, 1])));
    // Query results name the law they used.
    expect([q0.initial_law_hash, q1.initial_law_hash]).toStrictEqual([initialLawHash(law([1, 0])), initialLawHash(law([0, 1]))]);
    expect(initialLawHash([[bit("y", 0), [0.5, 0.5]], ...law([1, 0])])).toBe(initialLawHash([...law([1, 0]), [bit("y", 0), [0.5, 0.5]]]));
    raises(() => initialLawHash([...law([1, 0]), ...law([0, 1])]), /duplicate prior/);
    raises(() => initialLawHash(law([0.5, 0.6])), /normalization is not implicit/);

    const identityRows = [bern(ZERO), bern(ONE)];
    const bounds = targetBounds(plan, [nodeCoefficients(plan.nodes[0]!, identityRows)], target);
    const scope = (p: number[]): CertificateScopeInput => ({ initial: law(p), interventions: [], horizon: 0, conditioning: "none" });
    const clamp0: [VariableKey, Kernel][] = [[bit("x", 0), clampKernel(0)]];
    const a = certifyRemovals(bounds, { replacements: clamp0, scope: scope([1, 0]) }, EPS);
    const b = certifyRemovals(bounds, { replacements: clamp0, scope: scope([0, 1]) }, EPS);
    // Same plan and model hash; the initial law decides the defect and is part of the scope.
    expect([a.model_hash, a.graph_hash]).toStrictEqual([b.model_hash, b.graph_hash]);
    expect([a.accepted, a.bound.toString(), b.accepted, b.bound.toString()]).toStrictEqual([true, "0", false, "1"]);
    expect(a.scope.initial_law_hash).toBe(initialLawHash(law([1, 0])));
    expect(a.scope.scope_hash).not.toBe(b.scope.scope_hash);
    expect(a.content_hash).not.toBe(b.content_hash);
  });

  it("checks the scope against the bounded plan: initial law, interventions, horizon", () => {
    const model = hubModel();
    const { plan, bounds } = boundsOf(model);
    const replacements: [VariableKey, Kernel | null][] = [[key("H", 0), null]];
    raises(
      () => certifyRemovals(bounds, { replacements, scope: { ...scopeOf(model), initial: priors(model).slice(1) } }, EPS),
      /initial law has no prior for source .*"H"/,
    );
    raises(
      () => certifyRemovals(bounds, { replacements: [[key("S", 0), clampKernel(0)]], scope: { ...scopeOf(model), initial: priors(model).slice(0, 1) } }, EPS),
      /no prior/,
    );
    raises(() => certifyRemovals(bounds, { replacements, scope: scopeOf(model, 1) }, EPS), /past the horizon 1/);
    raises(() => certifyRemovals(bounds, { replacements, scope: { ...scopeOf(model), horizon: -1 } }, EPS), /nonnegative/);
    raises(
      () => certifyRemovals(bounds, { replacements, scope: { ...scopeOf(model), interventions: [hard(model, "S", 0)] } }, EPS),
      /interventions are listed, but the bounded plan carries none/,
    );
    // An intervened plan needs its interventions in the scope.
    const iv = hard(model, "S", 1);
    const cut = applyInterventions(plan, [iv]);
    const coefficientsCut = cut.nodes.map((node) => {
      const spec = model.writers.find((w) => variableKeyString(key(w.name, w.tick)) === variableKeyString(node.output));
      return spec === undefined ? null : nodeCoefficients(node, spec.rows);
    });
    const cb = targetBounds(cut, coefficientsCut, key("T", 2));
    raises(() => certifyRemovals(cb, { replacements, scope: scopeOf(model) }, EPS), /carries interventions, but the scope lists none/);
    const ok = certifyRemovals(cb, { replacements, scope: { ...scopeOf(model), interventions: [iv] } }, EPS);
    expect(ok.scope.interventions_hash).not.toBe(certificateScope(scopeOf(model)).interventions_hash);
  });
});

describe("F02: certificates cover the executed float kernel", () => {
  it("C2: a 2^-40 row submitted as zero is refused at eps 2^-42; at a looser eps the bound covers the true TV", () => {
    const tiny = Rational.of(1n, 2n ** 40n);
    const model: ExactModel = {
      roots: [{ name: "X", tick: 0, prior: bern(ZERO) }],
      writers: [{ name: "Y", tick: 1, inputs: [["X", 0]], rows: [bern(ZERO), bern(tiny)] }],
    };
    const plan = modelPlan(model);
    // The submitted table is constant zero; it is within the 1e-12 matching rule.
    const c = nodeCoefficients(plan.nodes[0]!, [bern(ZERO), bern(ZERO)]);
    expect(c.values[0]!.toString()).toBe("0");
    expect(c.allowance.equals(tiny)).toBe(true);
    const bounds = targetBounds(plan, [c], key("Y", 1));
    expect(bounds.exact_bounds.find(([k]) => k[1] === "X")![1].toString()).toBe("0");
    expect(bounds.bounds.find(([k]) => k[1] === "X")![1].equals(tiny.mul(R(2)))).toBe(true);
    const candidate = { replacements: [[key("X", 0), clampKernel(1)]] as [VariableKey, Kernel][], scope: scopeOf(model, 1) };
    const trueTV = tvRational(exactRational(model, "Y"), exactRational(model, "Y", new Map([["X", 1]])));
    expect(trueTV.equals(tiny)).toBe(true);
    // Before: accepted with bound 0 at eps 2^-42. Now: eps is below the numerical allowance.
    raises(() => certifyRemovals(bounds, candidate, Rational.of(1n, 2n ** 42n)), /at or below the numerical allowance/);
    const loose = certifyRemovals(bounds, candidate, Rational.of(1n, 2n ** 38n));
    expect(loose.accepted).toBe(true);
    expect(loose.bound.equals(tiny.mul(R(2)))).toBe(true);
    expect(loose.numerical_allowance.equals(loose.bound)).toBe(true);
    expect(trueTV.cmp(loose.bound) <= 0).toBe(true);
  });

  it("adds η to a replaced writer's defect and leaves one-value variables at exactly 0", () => {
    // Y reads X (binary) and K (one value); P(Y=1 | x) = 1/10 + 4/5 x.
    const ONE_VALUE = new Space("Only", ["*"]);
    const model: ExactModel = {
      roots: [
        { name: "X", tick: 0, prior: bern(R(1, 2)) },
        { name: "K", tick: 0, prior: [ONE], space: ONE_VALUE },
      ],
      writers: [{ name: "Y", tick: 1, inputs: [["X", 0], ["K", 0]], rows: [bern(R(1, 10)), bern(R(9, 10))] }],
    };
    const plan = modelPlan(model);
    const c = nodeCoefficients(plan.nodes[0]!, model.writers[0]!.rows);
    const bounds = targetBounds(plan, [c], key("Y", 1));
    expect(bounds.bounds.find(([k]) => k[1] === "K")![1].toString()).toBe("0");
    expect(bounds.bounds.find(([k]) => k[1] === "X")![1].equals(R(4, 5).add(c.allowance.mul(R(2))))).toBe(true);
    // Replacing Y by its first float row: the exact defect is at the second row, the executed one adds η.
    const firstRow = new Kernel(UNIT, BIT, [[0.9, 0.1]]);
    const cert = certifyRemovals(bounds, { replacements: [[key("Y", 1), firstRow]], scope: scopeOf(model, 1) }, R(9, 10));
    const exactDefect = tvRational(bern(R(9, 10)), [Rational.fromNumber(0.9), Rational.fromNumber(0.1)]);
    expect(exactDefect.sub(R(4, 5)).cmp(TINY) < 0).toBe(true);
    expect(cert.defects[0]![1].equals(exactDefect.add(c.allowance))).toBe(true);
    expect(cert.numerical_allowance.equals(c.allowance)).toBe(true);
  });
});
