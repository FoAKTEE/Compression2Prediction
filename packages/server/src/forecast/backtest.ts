/**
 * Synthetic backtest of the guide §13 incident chain (D24).
 *
 * Core `runSyntheticBacktest` generates episodes from the hand-specified
 * kernels (origin `simulated`) and scores five forecasters by horizon. It also
 * runs the frozen gate "plain_markov vs historical_base_rate". The summary is
 * stored as an immutable `synthetic_backtest` artifact in the project's
 * namespace, with envelope origin `simulated`. The generator does not read the
 * project's model. It validates the software pipeline on simulated data, never
 * real-world accuracy.
 */
import { isPlainObject, runSyntheticBacktest } from "@c2p/core";
import { integrity } from "../api/common.js";
import { as422, unprocessable } from "../api/errors.js";
import type { Bounds } from "../config.js";
import type { AppContext } from "../context.js";
import type { ProjectState } from "../repos/projects.js";
import { BACKTEST_LIST_LIMIT } from "../wire.js";
import type { SyntheticBacktestArtifact, SyntheticBacktestRequest, SyntheticBacktestResponse, SyntheticBacktestSummary } from "../wire.js";

export const BACKTEST_KIND = "synthetic_backtest";
export const BACKTEST_VERSION = "synthetic_backtest.v1";

const FIELDS = ["episodes", "seed", "origins", "horizons"] as const;

const invalid = (message: string) => unprocessable("invalid_request", message);
const outOfBounds = (message: string) => unprocessable("out_of_bounds", message);

function int(v: unknown, field: string): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v)) throw invalid(`${field}: expected an integer`);
  return v;
}

function within(v: unknown, field: string, min: number, max: number): number {
  const n = int(v, field);
  if (n < min || n > max) throw outOfBounds(`${field}: ${n} is outside [${min}, ${max}]`);
  return n;
}

/** Validate `{episodes, seed, origins, horizons}` against the config bounds; every failure is a 422. */
export function validateBacktestRequest(body: unknown, bounds: Bounds): SyntheticBacktestRequest {
  if (!isPlainObject(body)) throw invalid("expected a JSON object");
  const unknown = Object.keys(body).filter((k) => !(FIELDS as readonly string[]).includes(k));
  if (unknown.length) throw invalid(`backtest request: unknown field(s) ${unknown.sort().join(", ")}`);
  for (const f of FIELDS) if (!(f in body)) throw invalid(`missing field ${f}`);
  const origins = within(body.origins, "origins", 1, bounds.maxBacktestOrigins);
  const episodes = within(body.episodes, "episodes", origins + 1, bounds.maxBacktestEpisodes);
  const seed = within(body.seed, "seed", 0, Number.MAX_SAFE_INTEGER);
  if (!Array.isArray(body.horizons) || body.horizons.length === 0) throw invalid("horizons: expected a nonempty array of integers");
  if (body.horizons.length > bounds.maxBacktestHorizon) throw outOfBounds(`horizons: at most ${bounds.maxBacktestHorizon} entries`);
  const horizons = body.horizons.map((h, i) => within(h, `horizons[${i}]`, 1, bounds.maxBacktestHorizon));
  if (new Set(horizons).size !== horizons.length) throw invalid("horizons: duplicate entries");
  return { episodes, seed, origins, horizons };
}

type DeepMutable<T> = T extends readonly (infer U)[]
  ? DeepMutable<U>[]
  : T extends object
    ? { -readonly [K in keyof T]: DeepMutable<T[K]> }
    : T;

/** A plain JSON copy; the target type checks the core summary against the wire contract. */
function jsonCopy<T>(value: T): DeepMutable<T> {
  return JSON.parse(JSON.stringify(value)) as DeepMutable<T>;
}

export interface BacktestOptions {
  readonly repoSha: string;
}

/** Run, store, and return one synthetic backtest for `project`. */
export function runBacktest(
  ctx: AppContext,
  project: ProjectState,
  req: SyntheticBacktestRequest,
  options: BacktestOptions,
): SyntheticBacktestResponse {
  const run = as422("invalid_request", () => runSyntheticBacktest(req));
  const summary: SyntheticBacktestSummary = jsonCopy(run.summary);
  const payload: SyntheticBacktestArtifact = { ...summary, repo_sha: options.repoSha };
  const ref = ctx.artifacts.put(BACKTEST_KIND, payload, {
    origin: "simulated",
    scenario_id: project.project_id,
    run_id: null,
    version: BACKTEST_VERSION,
  });
  return { project_id: project.project_id, artifact_hash: ref.content_hash, ...payload };
}

/** Stored backtests of `project`, newest first; a tampered artifact is a 500 `integrity_error`. */
export function listBacktests(ctx: AppContext, project: ProjectState): SyntheticBacktestResponse[] {
  const scenario = project.project_id;
  // Simulated artifacts only: the explicit origin filter is the store's separation rule.
  const refs = ctx.artifacts.listRefs(BACKTEST_KIND, { scenario_id: scenario, origin: "simulated" });
  return refs
    .slice(-BACKTEST_LIST_LIMIT)
    .reverse()
    .map((ref) => {
      const art = integrity(() => ctx.artifacts.get(ref, { scenario_id: scenario }));
      return { project_id: scenario, artifact_hash: ref.content_hash, ...(art.payload as unknown as SyntheticBacktestArtifact) };
    });
}
