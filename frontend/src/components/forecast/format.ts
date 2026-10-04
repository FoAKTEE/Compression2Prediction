/** Small display helpers shared by the forecast, report, and history views. */
import type { EvidenceObservation, Intervention } from "../../api/types";
import { htmlLang, isLocale } from "../../i18n";

/** `crew_capacity = high · ent_repair_crew · [0, 2)`: the half-open window as served. */
export function describeIntervention(iv: Intervention): string {
  const target = iv.kind === "hard" ? `${iv.target_variable} = ${iv.value ?? "?"}` : `${iv.target_variable} ← ${iv.mechanism_id ?? "?"}`;
  const entity = iv.target_entity_id ? ` · ${iv.target_entity_id}` : "";
  return `${target}${entity} · [${iv.start_step}, ${iv.end_step_exclusive})`;
}

/** `pump_alarm = on · ent_pump_station · t=1`: one observed key and its value. */
export function describeEvidence(e: EvidenceObservation): string {
  return `${e.variable} = ${e.value} · ${e.entity_id} · t=${e.time_index}`;
}

/** The first 12 hex digits of a `sha256:` hash (the full value goes in a title attribute). */
export function shortHash(hash: string | null | undefined): string {
  if (!hash) return "";
  const hex = hash.startsWith("sha256:") ? hash.slice(7) : hash;
  return hex.length > 12 ? `${hex.slice(0, 12)}…` : hex;
}

/** A timestamp in the UI locale; an unparsable value is shown as sent. */
export function formatTimestamp(iso: string, locale: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const tag = isLocale(locale) ? htmlLang(locale) : undefined;
  return new Intl.DateTimeFormat(tag, { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(date) + " UTC";
}
