/** N6 fixtures: canonical transition IDs, count data, and the labeled well-mixed peer kernel. */
import { Space } from "../../src/kernels.js";
import type { CountDatum, FamilyKeyLike } from "../../src/learn/datasets.js";
import { SparseRows } from "../../src/learn/rows.js";
import { Rational } from "../../src/numeric/rational.js";
import { canonicalJson } from "../../src/store/records.js";
import type { Theta } from "../../src/compress/counts.js";

export const R = (n: number | bigint, d: number | bigint = 1) => Rational.of(n, d);

export const ACTIVITY = new Space("Activity", ["idle", "active", "offline"]);

export const KEY: FamilyKeyLike = Object.freeze({
  template: "tpl_activity",
  kind: "Person",
  role: "operator",
  interface_hash: "sha256:" + "a".repeat(64),
  regime: "normal",
  data_origin_partition: "simulated",
});

/** Canonical ``transition_record.v1`` ID (guide §9.3 idempotency key). */
export function tid(run: string, entity: string, round: number, seq = 0, platform = "reddit"): string {
  return canonicalJson([run, platform, round, entity, "transition", seq]);
}

/** Count data for ``entity`` in ``run``: one datum per [context, outcome], rounds from ``start``. */
export function data(
  run: string,
  entity: string,
  pairs: readonly (readonly [number, number])[],
  start = 0,
  extra: Partial<CountDatum> = {},
): CountDatum[] {
  return pairs.map(([context, outcome], i) => ({
    record_id: tid(run, entity, start + i),
    key: KEY,
    entity_id: entity,
    context,
    outcome,
    origin: "simulated",
    episode_id: run,
    ...extra,
  }));
}

/** Uniform prior over Activity, strength 3 (alpha q = 1 per outcome), no counts. */
export function uniformPrior(): SparseRows {
  return new SparseRows({
    source: ACTIVITY,
    target: ACTIVITY,
    support: [0, 1, 2],
    default_prior: [R(1, 3), R(1, 3), R(1, 3)],
    strength: R(3),
    prior_overrides: [],
    counts: [],
  });
}

function* sequences(choices: number, length: number): Generator<number[]> {
  if (length === 0) {
    yield [];
    return;
  }
  for (const rest of sequences(choices, length - 1)) for (let c = 0; c < choices; c++) yield [c, ...rest];
}

/**
 * Per-member next-state law in the labeled model: enumerate every sequence of
 * ``peers`` draws from the other members (uniform, with replacement); any
 * active draw selects theta[s][1], otherwise theta[s][0].
 */
export function memberLaw(state: readonly number[], i: number, theta: Theta, active: number, peers: number): Rational[] {
  const k = theta.length;
  const others = state.filter((_, j) => j !== i);
  const s = state[i]!;
  const out = Array.from({ length: k }, () => Rational.ZERO);
  let total = 0;
  for (const seq of sequences(others.length, peers)) {
    total++;
    const row = theta[s]![seq.some((j) => others[j] === active) ? 1 : 0];
    row.forEach((p, y) => (out[y] = out[y]!.add(p)));
  }
  return out.map((p) => p.div(R(total)));
}

/** Joint labeled law from independent member laws (member 0 most significant). */
export function jointLaw(laws: readonly (readonly Rational[])[], k: number): Rational[] {
  let joint: Rational[] = [Rational.ONE];
  for (const law of laws) {
    const next: Rational[] = [];
    for (const p of joint) for (let y = 0; y < k; y++) next.push(p.mul(law[y]!));
    joint = next;
  }
  return joint;
}

/** Deterministic test uniforms (32-bit LCG); core never uses Math.random. */
export function lcg(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 2 ** 32;
  };
}
