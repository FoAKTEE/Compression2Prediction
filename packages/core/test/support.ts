/** Shared helpers for golden tests: fixture loading and exact float.hex() handling. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const goldenDir = fileURLToPath(new URL("./golden/", import.meta.url));

export function readGolden<T>(name: string): T {
  return JSON.parse(readFileSync(join(goldenDir, name), "utf8")) as T;
}

const view = new DataView(new ArrayBuffer(8));
const HEX_FLOAT = /^(-?)0x([01])\.([0-9a-f]{1,13})p([+-]\d+)$/;

/** Exact inverse of Python ``float.hex()``, built from the IEEE bits. */
export function parseHexFloat(text: string): number {
  if (text === "nan") return NaN;
  if (text === "inf") return Infinity;
  if (text === "-inf") return -Infinity;
  const m = HEX_FLOAT.exec(text);
  if (m === null) throw new Error(`not a float.hex() string: ${text}`);
  const [, sign, lead, digits, exp] = m;
  const fraction = BigInt("0x" + digits!.padEnd(13, "0"));
  const e = Number(exp);
  let bits: bigint;
  if (lead === "1") {
    if (e < -1022 || e > 1023) throw new Error(`exponent out of range: ${text}`);
    bits = (BigInt(e + 1023) << 52n) | fraction;
  } else {
    if (fraction !== 0n && e !== -1022) throw new Error(`bad subnormal: ${text}`);
    bits = fraction;
  }
  if (sign === "-") bits |= 1n << 63n;
  view.setBigUint64(0, bits);
  return view.getFloat64(0);
}

/** Python ``float.hex(x)``, for readable bit-exact comparisons. */
export function formatHexFloat(x: number): string {
  if (Number.isNaN(x)) return "nan";
  if (x === Infinity) return "inf";
  if (x === -Infinity) return "-inf";
  view.setFloat64(0, x);
  const bits = view.getBigUint64(0);
  const sign = bits >> 63n ? "-" : "";
  const biased = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & 0xfffffffffffffn;
  if (biased === 0 && fraction === 0n) return `${sign}0x0.0p+0`;
  const digits = fraction.toString(16).padStart(13, "0");
  const e = biased === 0 ? -1022 : biased - 1023;
  return `${sign}0x${biased === 0 ? 0 : 1}.${digits}p${e < 0 ? "-" : "+"}${Math.abs(e)}`;
}
