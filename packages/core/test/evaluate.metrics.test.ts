import { describe, expect, it } from "vitest";
import { brier as gateBrier, nll } from "../src/evaluate/gate.js";
import {
  brier,
  calibrationBins,
  meanBrier,
  meanNll,
  nllBits,
  reliabilityByStratum,
  strata,
  toWireMetric,
} from "../src/evaluate/metrics.js";
import type { ReliabilityItem } from "../src/evaluate/metrics.js";
import { raises } from "./support.js";

describe("evaluation metrics", () => {
  it("test_report", () => {
    // NLL is in bits: p = 1/4 costs 2 bits, p = 1/2 one bit, p = 1 zero.
    expect(nllBits([0.25, 0.75], 0)).toBe(2);
    expect(nllBits([0.5, 0.5], 1)).toBe(1);
    expect(nllBits([0, 1], 1)).toBe(0);
    expect(nllBits([0.3, 0.7], 1)).toBe(nll([0.3, 0.7], 1));
    // An impossible observed outcome is +Infinity and stays visible in the mean.
    expect(nllBits([1, 0], 1)).toBe(Infinity);
    expect(meanNll([1, 2, Infinity])).toBe(Infinity);
    expect(meanNll([1, 2])).toBe(1.5);
    expect(meanNll([0.1, 0.2, 0.3])).toBe(0.6 / 3); // exactly rounded sum

    // Binary Brier is the mean squared error.
    expect(brier).toBe(gateBrier);
    expect(meanBrier([0.75, 0.25, 0.5, 1], [1, 0, 0, 1])).toBe((1 / 16 + 1 / 16 + 1 / 4 + 0) / 4);
    expect(meanBrier([0.8, 0.3], [1, 0])).toBeCloseTo((0.2 ** 2 + 0.3 ** 2) / 2, 15);

    // Missing calibration is literally missing, never 0.
    const bins = calibrationBins([0.05, 0.15, 0.12, 0.95, 1], [0, 1, 0, 1, 1], { bins: 5 });
    expect(bins.map((b) => b.count)).toEqual([3, 0, 0, 0, 2]);
    for (const b of bins.slice(1, 4)) {
      expect(b.mean_predicted).toBe("missing");
      expect(b.observed_frequency).toBe("missing");
    }
    expect(bins[0]).toMatchObject({ lower: 0, upper: 0.2, count: 3, observed_frequency: 1 / 3 });
    expect(bins[0]!.mean_predicted).toBeCloseTo(0.32 / 3, 15);
    expect(bins[4]).toEqual({ lower: 0.8, upper: 1, count: 2, mean_predicted: 0.975, observed_frequency: 1 });

    // D17 wire form.
    expect(toWireMetric(Infinity)).toBe("+inf");
    expect(toWireMetric(1.5)).toBe(1.5);
    expect(Object.is(toWireMetric(-0), 0)).toBe(true);
    expect([undefined, null, "missing"].map(toWireMetric)).toEqual(["missing", "missing", "missing"]);
    expect(toWireMetric("+inf")).toBe("+inf");
    raises(() => toWireMetric(NaN), /no wire form/);
    raises(() => toWireMetric(-Infinity), /no wire form/);
    raises(() => toWireMetric("1.5"), /no wire form/);
  });

  it("meanNll never clips and rejects invalid bits", () => {
    raises(() => meanNll([]), /nonempty/);
    raises(() => meanNll([1, NaN]), /scores\[1\]/);
    raises(() => meanNll([-0.5]), /nonnegative/);
    expect(meanNll([0, 0])).toBe(0);
    raises(() => meanBrier([], []), /at least one/);
    raises(() => meanBrier([0.5], [2 as 1]), /0 or 1/);
    raises(() => meanBrier([1.5], [1]), /probability/);
    raises(() => meanBrier([0.5, 0.5], [1]), /equal length/);
  });

  it("calibration bins follow the reported edges", () => {
    // 0.6 equals the double edge 3/5, so it opens bin [0.6, 0.8); 1 closes the last bin.
    expect(calibrationBins([0.6, 0.2, 0, 1], [1, 0, 0, 1], { bins: 5 }).map((b) => b.count)).toEqual([1, 1, 0, 1, 1]);
    const edges = calibrationBins([], [], { bins: 10 });
    expect(edges.every((b) => b.count === 0 && b.mean_predicted === "missing")).toBe(true);
    for (const p of [0.1, 0.3, 0.7, 0.29999999999999993, 0.30000000000000004, 0.9999999999999999]) {
      const b = calibrationBins([p], [1], { bins: 10 }).find((bin) => bin.count === 1)!;
      expect(b.lower <= p && (p < b.upper || b.upper === 1)).toBe(true);
    }
    raises(() => calibrationBins([0.5], [1], { bins: 0 }), /bins/);
    raises(() => calibrationBins([0.5], [1], { bins: 2.5 }), /bins/);
  });

  it("strata come per horizon, per category, then per cell", () => {
    const items = [
      { horizon: 2, category: "b" },
      { horizon: 1, category: "a" },
      { horizon: 1, category: "b" },
    ];
    expect(strata(items, ["horizon", "category"]).map((s) => [s.key.horizon, s.key.category, s.indices])).toEqual([
      [1, null, [1, 2]],
      [2, null, [0]],
      [null, "a", [1]],
      [null, "b", [0, 2]],
      [1, "a", [1]],
      [1, "b", [2]],
      [2, "b", [0]], // the empty (2, "a") cell is not a stratum
    ]);
    expect(strata(items, ["category"]).map((s) => s.key)).toEqual([
      { horizon: null, category: "a" },
      { horizon: null, category: "b" },
    ]);
    expect(strata(items, [])).toEqual([]);
    raises(() => strata(items, ["entity" as "horizon"]), /groupBy\[0\]/);
    raises(() => strata(items, ["horizon", "horizon"]), /duplicate/);
  });

  it("reliability by horizon and category", () => {
    const items: ReliabilityItem[] = [
      { horizon: 1, category: "incident", probability: 0.9, outcome: 1 },
      { horizon: 1, category: "meeting", probability: 0.1, outcome: 0 },
      { horizon: 2, category: "incident", probability: 0.7, outcome: 0 },
    ];
    const out = reliabilityByStratum(items, { bins: 2 });
    expect(out.map((s) => [s.horizon, s.category, s.count])).toEqual([
      [1, null, 2],
      [2, null, 1],
      [null, "incident", 2],
      [null, "meeting", 1],
      [1, "incident", 1],
      [1, "meeting", 1],
      [2, "incident", 1],
    ]);
    const h2 = out[1]!;
    expect(h2.bins[0]).toEqual({ lower: 0, upper: 0.5, count: 0, mean_predicted: "missing", observed_frequency: "missing" });
    expect(h2.bins[1]).toEqual({ lower: 0.5, upper: 1, count: 1, mean_predicted: 0.7, observed_frequency: 0 });
    expect(reliabilityByStratum(items, { bins: 2, groupBy: ["horizon"] }).length).toBe(2);
  });
});
