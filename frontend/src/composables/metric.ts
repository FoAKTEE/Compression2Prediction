import { readMetric } from "../api/types";

export interface MetricText {
  kind: "number" | "missing" | "infinite";
  text: string;
}

/**
 * Display text for a wire metric. `"missing"` and `"+inf"` become their
 * translated markers; only a finite number is ever formatted as a number.
 */
export function formatMetric(
  value: unknown,
  t: (key: string) => string,
  format: (value: number) => string = (n) => n.toFixed(3),
): MetricText {
  const reading = readMetric(value);
  if (reading.kind === "number") return { kind: "number", text: format(reading.value) };
  if (reading.kind === "infinite") return { kind: "infinite", text: t("metric.infinite") };
  return { kind: "missing", text: t("metric.missing") };
}
