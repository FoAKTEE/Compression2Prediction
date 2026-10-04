/** Server configuration: data root, examples directory, upload limits, request, compile, and backtest bounds, rank settings. */
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root (same depth from `src/` and `dist/`). */
export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
/** Default data root; `data/` is gitignored. */
export const DEFAULT_DATA_DIR = path.join(REPO_ROOT, "data");
/** Bundled examples (`examples/<name>/{example,world,model}.json`), validated at startup. */
export const DEFAULT_EXAMPLES_DIR = path.join(REPO_ROOT, "examples");

const MiB = 1024 * 1024;

export interface UploadLimits {
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  /** Lowercase, with the leading dot. */
  readonly allowedExtensions: readonly string[];
}

export interface Bounds {
  readonly maxHorizonSteps: number;
  readonly maxParticles: number;
  readonly maxInterventions: number;
  /** Body limit for JSON routes (world and model import). */
  readonly maxJsonBodyBytes: number;
  /** Compile budget (core `Budget`); `maxParticles` is shared. */
  readonly maxContexts: number;
  readonly maxFactorEntries: number;
  readonly maxPlanNodes: number;
  /** Synthetic backtest (`POST .../backtests`): generated episodes, rolling origins, and largest horizon. */
  readonly maxBacktestEpisodes: number;
  readonly maxBacktestOrigins: number;
  readonly maxBacktestHorizon: number;
}

/** Rank/influence diagnostics (memo §3.2, §3.3). */
export interface RankConfig {
  /** Single-node pruning budget ε_TV in (0, 1]; read back exactly from its decimal form. */
  readonly pruneEpsTv: number;
  /** PageRank iteration cap. */
  readonly maxIterations: number;
  /** Row-pair comparisons per rank request; past it a coefficient is unknown (counted as 1). */
  readonly maxComparisons: number;
}

export interface ServerConfig {
  readonly dataDir: string;
  readonly examplesDir: string;
  readonly upload: UploadLimits;
  readonly bounds: Bounds;
  readonly rank: RankConfig;
}

export const DEFAULT_UPLOAD: UploadLimits = Object.freeze({
  maxFiles: 20,
  maxFileBytes: 10 * MiB,
  maxTotalBytes: 50 * MiB,
  allowedExtensions: Object.freeze([".txt", ".md", ".json", ".csv"]),
});

export const DEFAULT_BOUNDS: Bounds = Object.freeze({
  maxHorizonSteps: 1000,
  maxParticles: 100_000,
  maxInterventions: 64,
  maxJsonBodyBytes: 16 * MiB,
  maxContexts: 65_536,
  maxFactorEntries: 1_048_576,
  maxPlanNodes: 100_000,
  maxBacktestEpisodes: 2000,
  maxBacktestOrigins: 20,
  maxBacktestHorizon: 24,
});

export const DEFAULT_RANK: RankConfig = Object.freeze({
  pruneEpsTv: 0.05,
  maxIterations: 10_000,
  maxComparisons: 1_000_000,
});

export interface ConfigOverrides {
  readonly dataDir?: string;
  readonly examplesDir?: string;
  readonly upload?: Partial<UploadLimits>;
  readonly bounds?: Partial<Bounds>;
  readonly rank?: Partial<RankConfig>;
}

/** Env var → config key; values must be positive integers. */
const UPLOAD_ENV = {
  C2P_MAX_UPLOAD_FILES: "maxFiles",
  C2P_MAX_UPLOAD_FILE_BYTES: "maxFileBytes",
  C2P_MAX_UPLOAD_TOTAL_BYTES: "maxTotalBytes",
} as const;
const BOUNDS_ENV = {
  C2P_MAX_HORIZON_STEPS: "maxHorizonSteps",
  C2P_MAX_PARTICLES: "maxParticles",
  C2P_MAX_INTERVENTIONS: "maxInterventions",
  C2P_MAX_JSON_BODY_BYTES: "maxJsonBodyBytes",
  C2P_MAX_CONTEXTS: "maxContexts",
  C2P_MAX_FACTOR_ENTRIES: "maxFactorEntries",
  C2P_MAX_PLAN_NODES: "maxPlanNodes",
  C2P_MAX_BACKTEST_EPISODES: "maxBacktestEpisodes",
  C2P_MAX_BACKTEST_ORIGINS: "maxBacktestOrigins",
  C2P_MAX_BACKTEST_HORIZON: "maxBacktestHorizon",
} as const;
const RANK_ENV = {
  C2P_RANK_MAX_ITER: "maxIterations",
  C2P_RANK_MAX_COMPARISONS: "maxComparisons",
} as const;
const EPS_ENV = "C2P_PRUNE_EPS_TV";
const DECIMAL = /^(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][-+]?[0-9]+)?$/;

function positiveInt(value: unknown, name: string): number {
  const n = typeof value === "string" && /^[0-9]+$/.test(value.trim()) ? Number(value.trim()) : value;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 1) {
    throw new Error(`config ${name}: expected a positive integer, got ${JSON.stringify(value)}`);
  }
  return n;
}

/** A decimal in (0, 1]; its shortest decimal form is the exact ε. */
function epsTv(value: unknown, name: string): number {
  const n = typeof value === "string" && DECIMAL.test(value.trim()) ? Number(value.trim()) : value;
  if (typeof n !== "number" || !Number.isFinite(n) || !(n > 0 && n <= 1)) {
    throw new Error(`config ${name}: expected a decimal in (0, 1], got ${JSON.stringify(value)}`);
  }
  return n;
}

function fromEnv<K extends string>(env: NodeJS.ProcessEnv, table: Readonly<Record<string, K>>): Partial<Record<K, number>> {
  const out: Partial<Record<K, number>> = {};
  for (const [name, key] of Object.entries(table)) {
    const raw = env[name];
    if (raw !== undefined && raw !== "") out[key] = positiveInt(raw, name);
  }
  return out;
}

function extensions(list: readonly string[]): readonly string[] {
  return Object.freeze(
    list.map((ext) => {
      if (!/^\.[a-z0-9]{1,16}$/.test(ext)) throw new Error(`config allowedExtensions: invalid ${JSON.stringify(ext)}`);
      return ext;
    }),
  );
}

/** Defaults, then `C2P_*` env vars, then explicit overrides (tests). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: ConfigOverrides = {}): ServerConfig {
  const envDir = env.C2P_DATA_DIR;
  const dataDir = path.resolve(overrides.dataDir ?? (envDir !== undefined && envDir !== "" ? envDir : DEFAULT_DATA_DIR));
  const envExamples = env.C2P_EXAMPLES_DIR;
  const examplesDir = path.resolve(
    overrides.examplesDir ?? (envExamples !== undefined && envExamples !== "" ? envExamples : DEFAULT_EXAMPLES_DIR),
  );
  const upload = { ...DEFAULT_UPLOAD, ...fromEnv(env, UPLOAD_ENV), ...overrides.upload };
  const bounds = { ...DEFAULT_BOUNDS, ...fromEnv(env, BOUNDS_ENV), ...overrides.bounds };
  for (const key of ["maxFiles", "maxFileBytes", "maxTotalBytes"] as const) positiveInt(upload[key], key);
  for (const key of Object.keys(DEFAULT_BOUNDS) as (keyof Bounds)[]) positiveInt(bounds[key], key);
  const rawEps = env[EPS_ENV];
  const rank = {
    ...DEFAULT_RANK,
    ...fromEnv(env, RANK_ENV),
    ...(rawEps !== undefined && rawEps !== "" ? { pruneEpsTv: epsTv(rawEps, EPS_ENV) } : {}),
    ...overrides.rank,
  };
  positiveInt(rank.maxIterations, "maxIterations");
  positiveInt(rank.maxComparisons, "maxComparisons");
  epsTv(rank.pruneEpsTv, "pruneEpsTv");
  return Object.freeze({
    dataDir,
    examplesDir,
    upload: Object.freeze({ ...upload, allowedExtensions: extensions(upload.allowedExtensions) }),
    bounds: Object.freeze(bounds),
    rank: Object.freeze(rank),
  });
}
