/** pythonJsonString parity with Python json.dumps (ensure_ascii=True). */
import { describe, expect, it } from "vitest";
import { pythonJsonPair, pythonJsonString } from "../src/index.js";
import { readGolden } from "./support.js";

interface JsonFixture {
  strings: { input: string; json: string }[];
  pairs: { left: string; right: string; json: string }[];
}

const fixture = readGolden<JsonFixture>("kernels_products.json");

describe("pythonJsonString", () => {
  it.each(fixture.strings.map((c) => [JSON.stringify(c.input), c] as const))("json.dumps(%s)", (_label, c) => {
    expect(pythonJsonString(c.input)).toBe(c.json);
    expect(JSON.parse(pythonJsonString(c.input))).toBe(c.input);
  });

  it("covers non-ASCII, quotes, backslashes, controls, DEL, and astral characters", () => {
    const inputs = fixture.strings.map((c) => c.input);
    expect(inputs).toContain("café");
    expect(inputs.some((s) => s.includes('"'))).toBe(true);
    expect(inputs.some((s) => s.includes("\\"))).toBe(true);
    expect(inputs).toContain("\x00");
    expect(inputs).toContain("\x7f");
    expect(inputs).toContain("\u{1F600}");
  });

  it("escapes each half of a lone or paired surrogate", () => {
    // Python: json.dumps('\ud800x\U0001F600\x7f\x00')
    expect(pythonJsonString("\ud800x\u{1F600}\x7f\x00")).toBe('"\\ud800x\\ud83d\\ude00\\u007f\\u0000"');
    expect(pythonJsonString("\udfff")).toBe('"\\udfff"');
  });

  it("rejects non-strings", () => {
    expect(() => pythonJsonString(1 as unknown as string)).toThrow(TypeError);
  });
});

describe("pythonJsonPair", () => {
  it.each(fixture.pairs.map((c) => [JSON.stringify([c.left, c.right]), c] as const))("%s", (_label, c) => {
    expect(pythonJsonPair(c.left, c.right)).toBe(c.json);
    expect(JSON.parse(pythonJsonPair(c.left, c.right))).toEqual([c.left, c.right]);
  });

  it("keeps the oracle's café example", () => {
    expect(pythonJsonPair("café", "x")).toBe('["caf\\u00e9","x"]');
  });
});
