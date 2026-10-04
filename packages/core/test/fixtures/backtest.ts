/** Backtest fixtures: a seeded test-only uniform stream and synthetic episodes. */
import { Space } from "../../src/kernels.js";
import type { BacktestEpisode, BacktestRecord } from "../../src/evaluate/backtest.js";

export const BINARY = new Space("Status", ["open", "resolved"]);
export const TERNARY = new Space("Level", ["low", "mid", "high"]);
export const TARGET2 = { scenario_id: "observed", variable_id: "incident_status", space: BINARY } as const;
export const TARGET3 = { scenario_id: "observed", variable_id: "load_level", space: TERNARY } as const;

const days = new Map<number, string>();

/** Midnight UTC, ``n`` days after 2026-01-01. */
export function day(n: number): string {
  let text = days.get(n);
  if (text === undefined) {
    text = new Date(Date.UTC(2026, 0, 1) + n * 86_400_000).toISOString().replace(".000Z", "Z");
    days.set(n, text);
  }
  return text;
}

/** Test-only seeded uniform stream on [0, 1) (mulberry32). */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Inverse-CDF draw from ``p`` with uniform ``u``. */
export function draw(p: readonly number[], u: number): number {
  let acc = 0;
  for (let i = 0; i < p.length; i++) {
    acc += p[i]!;
    if (u < acc) return i;
  }
  return p.length - 1;
}

/** An episode from ``states`` at times 0.. with per-record availability ``available(t)``. */
export function episode(
  id: string,
  states: readonly number[],
  available: (t: number) => string,
  over: Partial<Omit<BacktestEpisode, "records">> = {},
): BacktestEpisode {
  const records: BacktestRecord[] = states.map((state, t) => ({
    record_id: `${id}#${t}`,
    time_index: t,
    state,
    availability_time: available(t),
  }));
  return { episode_id: id, entity_id: `ent_${id}`, category: "incident", origin: "observed", records, ...over };
}

/** A chain of ``length`` states from ``kernel`` started at ``initial``. */
export function chain(kernel: readonly (readonly number[])[], initial: number, length: number, u: () => number): number[] {
  const states = [initial];
  while (states.length < length) states.push(draw(kernel[states[states.length - 1]!]!, u()));
  return states;
}
