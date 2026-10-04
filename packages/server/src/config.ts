/** Server configuration: data root, upload limits, request bounds. */
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root (same depth from `src/` and `dist/`). */
export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
/** Default data root; `data/` is gitignored. */
export const DEFAULT_DATA_DIR = path.join(REPO_ROOT, "data");

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
  /** Body limit for JSON routes (world import). */
  readonly maxJsonBodyBytes: number;
}

export interface ServerConfig {
  readonly dataDir: string;
  readonly upload: UploadLimits;
  readonly bounds: Bounds;
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
});

export interface ConfigOverrides {
  readonly dataDir?: string;
  readonly upload?: Partial<UploadLimits>;
  readonly bounds?: Partial<Bounds>;
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
} as const;

function positiveInt(value: unknown, name: string): number {
  const n = typeof value === "string" && /^[0-9]+$/.test(value.trim()) ? Number(value.trim()) : value;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 1) {
    throw new Error(`config ${name}: expected a positive integer, got ${JSON.stringify(value)}`);
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
  const upload = { ...DEFAULT_UPLOAD, ...fromEnv(env, UPLOAD_ENV), ...overrides.upload };
  const bounds = { ...DEFAULT_BOUNDS, ...fromEnv(env, BOUNDS_ENV), ...overrides.bounds };
  for (const key of ["maxFiles", "maxFileBytes", "maxTotalBytes"] as const) positiveInt(upload[key], key);
  for (const key of ["maxHorizonSteps", "maxParticles", "maxInterventions", "maxJsonBodyBytes"] as const) {
    positiveInt(bounds[key], key);
  }
  return Object.freeze({
    dataDir,
    upload: Object.freeze({ ...upload, allowedExtensions: extensions(upload.allowedExtensions) }),
    bounds: Object.freeze(bounds),
  });
}
