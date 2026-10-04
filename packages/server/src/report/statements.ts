/**
 * Report statement templates (guide §10.9). Every statement is about
 * probability mass in the stated model, e.g. "In this model, 63% of the
 * two-step probability mass is in the resolved state." None claims a
 * real-world probability; the serializer rejects text that does.
 */
import type { HorizonDistribution, Intervention } from "../wire.js";
import type { ReportStatement } from "./serialize.js";

const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

export function stepPhrase(h: number): string {
  return `${WORDS[h] ?? String(h)}-step`;
}

/** Percent with at most one decimal; a nonzero mass never prints as 0% (or a non-unit one as 100%). */
export function percent(p: number): string {
  if (p === 0) return "0%";
  if (p === 1) return "100%";
  const x = p * 100;
  if (x < 0.05) return "less than 0.1%";
  if (x > 99.95) return "more than 99.9%";
  const s = x.toFixed(1);
  return `${s.endsWith(".0") ? s.slice(0, -2) : s}%`;
}

export function describeInterventions(interventions: readonly Intervention[]): string {
  return interventions
    .map((iv) => `${iv.target_variable} = ${iv.value ?? "?"} for ${iv.target_entity_id ?? "?"} over steps [${iv.start_step}, ${iv.end_step_exclusive})`)
    .join("; ");
}

export interface StatementInput {
  readonly horizon_steps: number;
  readonly baseline: { readonly scenario_id: string; readonly by_horizon: readonly HorizonDistribution[] };
  readonly intervention: { readonly scenario_id: string; readonly by_horizon: readonly HorizonDistribution[] } | null;
  readonly interventions: readonly Intervention[];
}

function last(by: readonly HorizonDistribution[], h: number): HorizonDistribution {
  const found = by.find((d) => d.horizon_step === h);
  if (found === undefined) throw new Error(`no distribution at horizon step ${h}`);
  return found;
}

/** One statement per target value at the final step for each scenario, then baseline-vs-intervention comparisons. */
export function buildStatements(input: StatementInput): ReportStatement[] {
  const h = input.horizon_steps;
  const phrase = stepPhrase(h);
  const base = last(input.baseline.by_horizon, h);
  const out: ReportStatement[] = base.distribution.map((e) => ({
    kind: "distribution",
    scenario_id: input.baseline.scenario_id,
    horizon_step: h,
    value: e.value,
    text: `In this model, ${percent(e.probability)} of the ${phrase} probability mass is in the ${e.value} state.`,
  }));
  if (input.intervention === null) return out;
  const scope = describeInterventions(input.interventions);
  const done = last(input.intervention.by_horizon, h);
  for (const e of done.distribution) {
    out.push({
      kind: "distribution",
      scenario_id: input.intervention.scenario_id,
      horizon_step: h,
      value: e.value,
      text: `In this model, under the model-based intervention (${scope}), ${percent(e.probability)} of the ${phrase} probability mass is in the ${e.value} state.`,
    });
  }
  done.distribution.forEach((e, i) => {
    const b = base.distribution[i]!;
    out.push({
      kind: "comparison",
      scenario_id: null,
      horizon_step: h,
      value: e.value,
      text:
        `In this model, the ${phrase} probability mass in the ${e.value} state is ${percent(e.probability)} under the ` +
        `model-based intervention and ${percent(b.probability)} without it; the difference follows from the stated ` +
        "kernels and is not an identified causal effect.",
    });
  });
  return out;
}

export function statementPolicy(validationStatus: string): string {
  return (
    "Statements describe probability mass in this model only. " +
    `Validation status: ${validationStatus}; parameter uncertainty and model error are missing, and no backtest exists. ` +
    "No statement is a probability about the actual world or an empirical frequency."
  );
}
