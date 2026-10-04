/** Python-compatible JSON string encoding, so product value strings match the oracle. */

const SHORT_ESCAPES: ReadonlyMap<number, string> = new Map([
  [0x5c, "\\\\"],
  [0x22, '\\"'],
  [0x08, "\\b"],
  [0x0c, "\\f"],
  [0x0a, "\\n"],
  [0x0d, "\\r"],
  [0x09, "\\t"],
]);

/**
 * ``json.dumps(s)`` with ``ensure_ascii=True``: printable ASCII as is, short
 * escapes for backslash, quote, and \b \f \n \r \t, and lowercase ``\uXXXX``
 * for every other UTF-16 code unit (so astral characters become pairs).
 */
export function pythonJsonString(s: string): string {
  if (typeof s !== "string") throw new TypeError("pythonJsonString needs a string");
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const unit = s.charCodeAt(i);
    const short = SHORT_ESCAPES.get(unit);
    if (short !== undefined) out += short;
    else if (unit >= 0x20 && unit <= 0x7e) out += s[i];
    else out += "\\u" + unit.toString(16).padStart(4, "0");
  }
  return out + '"';
}

/** ``json.dumps([a, b], separators=(",", ":"))`` for two strings. */
export function pythonJsonPair(a: string, b: string): string {
  return "[" + pythonJsonString(a) + "," + pythonJsonString(b) + "]";
}
