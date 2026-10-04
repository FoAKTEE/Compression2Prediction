/** Python-style ``repr`` for error messages, so they read like the oracle's. */

function reprString(s: string): string {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (ch === "\\") out += "\\\\";
    else if (ch === quote) out += "\\" + quote;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (code < 0x20 || code === 0x7f) out += "\\x" + code.toString(16).padStart(2, "0");
    else if (code >= 0xd800 && code <= 0xdfff) out += "\\u" + code.toString(16).padStart(4, "0");
    else out += ch;
  }
  return out + quote;
}

function reprValue(value: unknown, seen: Set<object>): string {
  if (value === null || value === undefined) return "None";
  switch (typeof value) {
    case "boolean":
      return value ? "True" : "False";
    case "number":
      if (Number.isNaN(value)) return "nan";
      if (value === Infinity) return "inf";
      if (value === -Infinity) return "-inf";
      return String(value);
    case "bigint":
      return value.toString();
    case "string":
      return reprString(value);
    case "function":
      return `<function ${value.name || "anonymous"}>`;
    case "symbol":
      return value.toString();
    default:
      break;
  }
  const obj = value as object;
  if (seen.has(obj)) return Array.isArray(obj) ? "[...]" : "{...}";
  seen.add(obj);
  try {
    if (Array.isArray(obj)) return `[${obj.map((item) => reprValue(item, seen)).join(", ")}]`;
    const proto: unknown = Object.getPrototypeOf(obj);
    if (proto === Object.prototype || proto === null) {
      const items = Object.entries(obj).map(([k, v]) => `${reprString(k)}: ${reprValue(v, seen)}`);
      return `{${items.join(", ")}}`;
    }
    const name = (obj as { constructor?: { name?: unknown } }).constructor?.name;
    return `<${typeof name === "string" && name ? name : "object"}>`;
  } finally {
    seen.delete(obj);
  }
}

export function repr(value: unknown): string {
  return reprValue(value, new Set());
}

/** A Python tuple repr: ``('a', 'b')``, ``('a',)``, ``()``. */
export function reprTuple(items: readonly unknown[]): string {
  const parts = items.map((item) => repr(item));
  return parts.length === 1 ? `(${parts[0]},)` : `(${parts.join(", ")})`;
}

/** Python ``type(value).__name__`` for JSON-like values. */
export function typeName(value: unknown): string {
  if (value === null || value === undefined) return "NoneType";
  if (Array.isArray(value)) return "list";
  switch (typeof value) {
    case "string":
      return "str";
    case "boolean":
      return "bool";
    case "number":
      return Number.isInteger(value) ? "int" : "float";
    case "bigint":
      return "int";
    case "function":
      return "function";
    case "symbol":
      return "symbol";
    default: {
      const proto: unknown = Object.getPrototypeOf(value);
      if (proto === Object.prototype || proto === null) return "dict";
      const name = (value as { constructor?: { name?: unknown } }).constructor?.name;
      return typeof name === "string" && name ? name : "object";
    }
  }
}
