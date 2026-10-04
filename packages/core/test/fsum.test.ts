/** fsum parity with Python math.fsum on adversarial golden inputs. */
import { describe, expect, it } from "vitest";
import { fsum, ValueError } from "../src/index.js";
import { formatHexFloat, parseHexFloat, readGolden } from "./support.js";

interface FsumCase {
  name: string;
  inputs: string[];
  result_hex?: string;
  result?: number | null;
  raises?: "ValueError" | "OverflowError";
}

const fixture = readGolden<{ cases: FsumCase[] }>("fsum_cases.json");
const finite = fixture.cases.filter((c) => c.raises === undefined && c.result !== null);

describe("fsum_cases.json", () => {
  it("has at least 25 finite adversarial cases and the special cases", () => {
    expect(finite.length).toBeGreaterThanOrEqual(25);
    expect(fixture.cases.some((c) => c.raises === "ValueError")).toBe(true);
    expect(fixture.cases.some((c) => c.raises === "OverflowError")).toBe(true);
  });

  it("hex inputs and outputs round-trip through the helpers", () => {
    for (const c of fixture.cases) {
      for (const h of c.inputs) expect(formatHexFloat(parseHexFloat(h))).toBe(h);
      if (c.result_hex !== undefined) {
        expect(formatHexFloat(parseHexFloat(c.result_hex))).toBe(c.result_hex);
        if (c.result !== null && c.result !== undefined) {
          expect(Object.is(parseHexFloat(c.result_hex), c.result), c.name).toBe(true);
        }
      }
    }
  });

  it.each(fixture.cases.map((c) => [c.name, c] as const))("%s", (name, c) => {
    const inputs = c.inputs.map(parseHexFloat);
    if (c.raises === "ValueError") {
      expect(() => fsum(inputs), name).toThrow(ValueError);
    } else if (c.raises === "OverflowError") {
      expect(() => fsum(inputs), name).toThrow(RangeError);
    } else {
      const result = fsum(inputs);
      expect(formatHexFloat(result), name).toBe(c.result_hex);
      if (!Number.isNaN(result)) expect(Object.is(result, parseHexFloat(c.result_hex!)), name).toBe(true);
    }
  });
});

describe("fsum special cases", () => {
  it("mirrors Python's nonfinite handling", () => {
    expect(() => fsum([Infinity, -Infinity])).toThrow(ValueError);
    expect(() => fsum([Infinity, -Infinity])).toThrow("-inf + inf in fsum");
    expect(() => fsum([1e308, 1e308])).toThrow(RangeError);
    expect(() => fsum([1e308, 1e308])).toThrow("intermediate overflow in fsum");
    expect(fsum([NaN, 1])).toBeNaN();
    expect(fsum([Infinity, 1])).toBe(Infinity);
    expect(fsum([-Infinity, -Infinity])).toBe(-Infinity);
  });

  it("returns +0 for empty and all-negative-zero input, as Python 3.10 does", () => {
    expect(Object.is(fsum([]), 0)).toBe(true);
    expect(Object.is(fsum([-0, -0]), 0)).toBe(true);
  });

  it("is exactly rounded where naive summation is not", () => {
    const tenths = Array.from({ length: 10 }, () => 0.1);
    expect(tenths.reduce((a, b) => a + b, 0)).not.toBe(1);
    expect(fsum(tenths)).toBe(1);
    expect(fsum([1e100, 1.0, -1e100, 1e-100])).toBe(1);
  });

  it("accepts any iterable and rejects non-numbers", () => {
    function* tenths(): Generator<number> {
      for (let i = 0; i < 10; i++) yield 0.1;
    }
    expect(fsum(tenths())).toBe(1);
    expect(fsum(new Set([0.25, 0.5]))).toBe(0.75);
    expect(() => fsum(["1" as unknown as number])).toThrow(TypeError);
  });
});
