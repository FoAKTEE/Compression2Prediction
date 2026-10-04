/**
 * Display helpers for probabilities the server sent. They only format a
 * number for display; the UI never derives new claims from them.
 */

/**
 * A probability as a percent with at most one decimal (the server's statement
 * rule): a nonzero mass never prints as 0%, and a mass below one never as 100%.
 */
export function formatPercent(p: number): string {
  if (!Number.isFinite(p)) return "?";
  if (p <= 0) return "0%";
  if (p >= 1) return "100%";
  const x = p * 100;
  if (x < 0.05) return "<0.1%";
  if (x > 99.95) return ">99.9%";
  const s = x.toFixed(1);
  return `${s.endsWith(".0") ? s.slice(0, -2) : s}%`;
}

/** The signed difference `b - a` of two probabilities in percentage points, at most one decimal. */
export function formatPointDifference(a: number, b: number): string {
  const d = (b - a) * 100;
  const rounded = Math.round(d * 10) / 10;
  if (rounded === 0) return "0 pp";
  const s = Math.abs(rounded).toFixed(1);
  const text = s.endsWith(".0") ? s.slice(0, -2) : s;
  return `${rounded > 0 ? "+" : "−"}${text} pp`;
}

/** Clamps a probability into [0, 1] for drawing; labels always show the server's value. */
export function clampProbability(p: number): number {
  if (!Number.isFinite(p)) return 0;
  return Math.min(1, Math.max(0, p));
}
