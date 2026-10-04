/** The five workflow steps, in order. Components are bound in ProcessView. */
export const STEP_NUMBERS = [1, 2, 3, 4, 5] as const;
export type StepNumber = (typeof STEP_NUMBERS)[number];
export const STEP_COUNT = STEP_NUMBERS.length;

export type StepKey = "world" | "model" | "forecast" | "report" | "interaction";

export const STEP_KEYS: Readonly<Record<StepNumber, StepKey>> = {
  1: "world",
  2: "model",
  3: "forecast",
  4: "report",
  5: "interaction",
};

export function isStepNumber(value: number): value is StepNumber {
  return (STEP_NUMBERS as readonly number[]).includes(value);
}

/** Two-digit step badge: 1 -> "01". */
export function padStep(value: number): string {
  return String(value).padStart(2, "0");
}
