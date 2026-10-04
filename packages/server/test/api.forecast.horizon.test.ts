/** D25: a forecast whose exact enumeration exceeds the budget runs by frontier elimination, with an unchanged API. */
import { exactQuery } from "@c2p/core";
import type { Prior, VariableKey } from "@c2p/core";
import { afterEach, describe, expect, it } from "vitest";
import { loadCompiledPlan } from "../src/forecast/plan.js";
import type { ForecastResult } from "../src/forecast/types.js";
import { budgetFrom } from "../src/model/compile.js";
import { ALARM0, alarmRows, LOAD, LOAD0, loadRows, PUMP, PUMP_SCENARIO, pumpModel, pumpWorld } from "./fixtures/pumpModel.js";
import { cleanup, createProject, makeApp } from "./helpers.js";

afterEach(cleanup);

const H = 26;
const loadKey = (k: number): VariableKey => [PUMP_SCENARIO, "pump_load", PUMP, k];

/** Hand-written forward recursion over the 12 joint states (load, alarm); returns the load marginal per step 1..h. */
function loadMarginals(h: number): number[][] {
  const kl = loadRows();
  const ka = alarmRows();
  let p = LOAD0.flatMap((l) => ALARM0.map((a) => l * a));
  const out: number[][] = [];
  for (let k = 1; k <= h; k++) {
    const next = new Array<number>(12).fill(0);
    for (let s = 0; s < 12; s++) for (let l = 0; l < 6; l++) for (let a = 0; a < 2; a++) next[l * 2 + a]! += p[s]! * kl[s]![l]! * ka[s]![a]!;
    p = next;
    out.push([0, 1, 2, 3, 4, 5].map((l) => p[2 * l]! + p[2 * l + 1]!));
  }
  return out;
}

describe("forecast past the enumeration budget", () => {
  it("a 26-step two-variable model forecasts every step and matches the core frontier computation", async () => {
    const app = await makeApp();
    const id = await createProject(app);
    const world = await app.inject({ method: "PUT", url: `/api/world/projects/${id}/world`, payload: pumpWorld() });
    expect(world.statusCode, world.body).toBe(200);
    const model = await app.inject({ method: "PUT", url: `/api/model/projects/${id}/model`, payload: pumpModel(H) });
    expect(model.statusCode, model.body).toBe(200);
    const compiled = await app.inject({ method: "POST", url: `/api/model/projects/${id}/compile`, payload: {} });
    expect(compiled.statusCode, compiled.body).toBe(200);
    expect(compiled.json().ok).toBe(true);

    const res = await app.inject({
      method: "POST",
      url: `/api/forecast/projects/${id}/forecasts`,
      payload: { query_kind: "observational", target_entity_id: PUMP, target_variable: "pump_load", horizon_steps: H, interventions: [] },
    });
    expect(res.statusCode, res.body).toBe(201);
    const run = res.json() as ForecastResult;
    expect([run.status, run.query_kind, run.effect_status]).toEqual(["completed", "observational", "not_applicable"]);
    expect(run.baseline.by_horizon.map((h) => h.horizon_step)).toEqual(Array.from({ length: H }, (_, i) => i + 1));
    expect(run.baseline.by_horizon[H - 1]!.distribution.map((e) => e.value)).toEqual([...LOAD.values]);

    // The same plan, budget, and priors, queried directly in core.
    const c = loadCompiledPlan(app.c2p, app.c2p.projects.get(id)!);
    expect(c.plan.nodes).toHaveLength(2 * H);
    const budget = budgetFrom(app.c2p.config.bounds);
    expect(budget.max_factor_entries).toBe(1_048_576);
    const initial: Prior[] = c.model.model.initial.map((p) => [p.key, p.distribution] as const);
    const expected = loadMarginals(H);
    const methods = run.baseline.by_horizon.map((h, i) => {
      const direct = exactQuery(c.plan, { target: loadKey(i + 1), initial, budget });
      expect(h.distribution.map((e) => e.probability), `step ${i + 1}`).toStrictEqual([...direct.distribution]);
      direct.distribution.forEach((p, j) => expect(Math.abs(p - expected[i]![j]!), `step ${i + 1} value ${j}`).toBeLessThanOrEqual(1e-12));
      return direct.method;
    });
    // 6^(k+1) * 2^k full-joint entries: 124416 at step 4, 1492992 at step 5; frontier from step 5 on.
    expect(methods.slice(0, 4)).toEqual(Array(4).fill("enumeration"));
    expect(methods.slice(4)).toEqual(Array(H - 4).fill("frontier"));
    expect(() => exactQuery(c.plan, { target: loadKey(H), initial, budget, method: "enumeration" })).toThrow(
      /over 53 ancestor variables needs \d+ joint entries, exceeding max_factor_entries 1048576/,
    );
    const forced = exactQuery(c.plan, { target: loadKey(H), initial, budget, method: "frontier" });
    expect(run.baseline.by_horizon[H - 1]!.distribution.map((e) => e.probability)).toStrictEqual([...forced.distribution]);
  });
});
