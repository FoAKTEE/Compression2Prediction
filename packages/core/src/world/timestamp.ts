/**
 * Acceptance test of CPython 3.10 ``datetime.fromisoformat`` (the oracle's
 * interpreter), ported from ``Modules/_datetimemodule.c``. The C parser walks
 * NUL-terminated UTF-8 bytes, so this port does too; its quirks are kept.
 */
import { Buffer } from "node:buffer";
import { isWellFormed } from "../store/records.js";

const DAYS_IN_MONTH = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

function daysInMonth(year: number, month: number): number {
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return month === 2 && leap ? 29 : DAYS_IN_MONTH[month]!;
}

class Bytes {
  constructor(readonly data: Uint8Array) {}

  /** The byte at ``i``; NUL at and past the end, as in a C string. */
  at(i: number): number {
    return i < this.data.length ? this.data[i]! : 0;
  }

  /** ``parse_digits``: ``count`` ASCII digits from ``i``, or null. */
  digits(i: number, count: number): { value: number; next: number } | null {
    let value = 0;
    for (let k = 0; k < count; k++) {
      const d = this.at(i + k) - 0x30;
      if (d < 0 || d > 9) return null;
      value = value * 10 + d;
    }
    return { value, next: i + count };
  }
}

interface Clock {
  rv: number;
  vals: [number, number, number];
  micro: number;
}

/** ``parse_hh_mm_ss_ff`` over [start, end): -3/-4 on error, else 1 if not at the string end. */
function parseHhMmSsFf(b: Bytes, start: number, end: number): Clock {
  const vals: [number, number, number] = [0, 0, 0];
  let p = start;
  let i = 0;
  for (; i < 3; i++) {
    const parsed = b.digits(p, 2);
    if (parsed === null) return { rv: -3, vals, micro: 0 };
    vals[i] = parsed.value;
    const c = b.at(parsed.next);
    p = parsed.next + 1;
    if (p >= end) return { rv: c !== 0 ? 1 : 0, vals, micro: 0 };
    if (c === 0x3a /* : */) continue;
    if (c === 0x2e /* . */) break;
    return { rv: -4, vals, micro: 0 };
  }
  const remains = end - p;
  if (remains !== 6 && remains !== 3) return { rv: -3, vals, micro: 0 };
  const parsed = b.digits(p, remains);
  if (parsed === null) return { rv: -3, vals, micro: 0 };
  const micro = remains === 3 ? parsed.value * 1000 : parsed.value;
  return { rv: b.at(parsed.next) !== 0 ? 1 : 0, vals, micro };
}

/** True when CPython 3.10 ``datetime.fromisoformat(text)`` returns instead of raising. */
export function isPythonIsoformat(text: string): boolean {
  // _sanitize_isoformat_str: a surrogate separator at code point 10 becomes "T".
  const chars = Array.from(text);
  const sep = chars[10];
  if (sep !== undefined && sep.length === 1 && sep.charCodeAt(0) >= 0xd800 && sep.charCodeAt(0) <= 0xdfff) {
    chars[10] = "T";
  }
  const clean = chars.join("");
  if (!isWellFormed(clean)) return false; // UnicodeEncodeError: invalid string
  const b = new Bytes(Buffer.from(clean, "utf8"));
  const len = b.data.length;

  // parse_isoformat_date: YYYY-MM-DD.
  const year = b.digits(0, 4);
  if (year === null || b.at(4) !== 0x2d) return false;
  const month = b.digits(5, 2);
  if (month === null || b.at(7) !== 0x2d) return false;
  const day = b.digits(8, 2);
  if (day === null) return false;

  let clock: Clock = { rv: 0, vals: [0, 0, 0], micro: 0 };
  let tzSeconds = 0;
  let tzMicro = 0;
  if (len > 10) {
    // The separator is one character of 1-4 UTF-8 bytes, judged by its lead byte.
    const lead = b.at(10);
    const p = (lead & 0x80) === 0 ? 11 : (lead & 0xf0) === 0xe0 ? 13 : (lead & 0xf0) === 0xf0 ? 14 : 12;
    const end = len; // p + (len - p)

    // parse_isoformat_time: the offset starts at the first '+' or '-'.
    let tz = p;
    do {
      const c = b.at(tz);
      if (c === 0x2b || c === 0x2d) break;
    } while (++tz < end);

    clock = parseHhMmSsFf(b, p, tz);
    if (clock.rv < 0) return false;
    if (tz === end) {
      if (clock.rv === 1) return false;
    } else {
      const tzlen = end - tz;
      if (tzlen !== 6 && tzlen !== 9 && tzlen !== 16) return false;
      const sign = b.at(tz) === 0x2d ? -1 : 1;
      const offset = parseHhMmSsFf(b, tz + 1, end);
      if (offset.rv !== 0) return false;
      const [h, m, s] = offset.vals;
      tzSeconds = sign * (h * 3600 + m * 60 + s);
      tzMicro = sign * offset.micro;
      clock.rv = 1;
    }
  }

  // tzinfo_from_isoformat_results / new_timezone: strictly within ±24 h.
  if (clock.rv === 1 && tzSeconds !== 0) {
    const total = tzSeconds * 1_000_000 + tzMicro;
    if (!(total > -86_400_000_000 && total < 86_400_000_000)) return false;
  }
  // new_datetime: field ranges.
  const [hour, minute, second] = clock.vals;
  if (year.value < 1 || month.value < 1 || month.value > 12) return false;
  if (day.value < 1 || day.value > daysInMonth(year.value, month.value)) return false;
  return hour <= 23 && minute <= 59 && second <= 59;
}
