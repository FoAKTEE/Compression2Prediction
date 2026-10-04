/** Hash and string helpers shared by the extraction pipeline. */
import { createHash } from "node:crypto";

/** `sha256:<hex>` of raw bytes. */
export function sha256Bytes(bytes: Uint8Array): string {
  return "sha256:" + createHash("sha256").update(bytes).digest("hex");
}

/** `sha256:<hex>` of a string's UTF-8 bytes. */
export function sha256Text(text: string): string {
  return "sha256:" + createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Deterministic identifier `<prefix>_<24 hex>` from an ordered list of parts.
 * The parts are JSON-encoded first, so `["a", "bc"]` and `["ab", "c"]` differ.
 */
export function stableId(prefix: string, parts: readonly (string | number)[]): string {
  const hex = createHash("sha256").update(JSON.stringify(parts), "utf8").digest("hex");
  return `${prefix}_${hex.slice(0, 24)}`;
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** False when `text` contains a lone UTF-16 surrogate (not representable as UTF-8). */
export function isWellFormedText(text: string): boolean {
  return !LONE_SURROGATE.test(text);
}

/** Replace lone surrogates with U+FFFD so the text survives canonical JSON. */
export function toWellFormedText(text: string): string {
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD");
}
