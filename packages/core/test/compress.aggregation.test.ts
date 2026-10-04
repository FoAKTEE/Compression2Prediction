/** N6.2: declared aggregators and budgets before expansion (memo §2.1, §2.4, §4.3 AGGREGATE, §4.4). */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Space as SpaceType } from "../src/kernels.js";

// Spy on product construction; productAll folds over the spied product.
vi.mock("../src/kernels.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/kernels.js")>();
  const product = vi.fn(actual.product);
  const productAll = vi.fn((spaces: Iterable<SpaceType>) => {
    const all = Array.from(spaces);
    if (all.length === 0) return actual.UNIT;
    return all.slice(1).reduce((acc, space) => product(acc, space), all[0]!);
  });
  return { ...actual, product, productAll };
});

import { Budget } from "../src/causal/compiler.js";
import {
  aggregate,
  aggregatedContexts,
  aggregatedContextSpace,
  aggregationHash,
  AggregationSpec,
  bisectRight,
  checkBudget,
  contextSpace,
  parameterCount,
  sufficiency,
} from "../src/compress/aggregation.js";
import type { AggregationSpecFields } from "../src/compress/aggregation.js";
import { recordIdsHash } from "../src/compress/families.js";
import * as kernels from "../src/kernels.js";
import { Space } from "../src/kernels.js";
import { ACTIVITY, R } from "./fixtures/compress.js";
import { raises } from "./support.js";

const productSpy = vi.mocked(kernels.product);
const productAllSpy = vi.mocked(kernels.productAll);
beforeEach(() => {
  productSpy.mockClear();
  productAllSpy.mockClear();
});

const DECLARED = recordIdsHash([]);
const PEERS = ["peer_1", "peer_2", "peer_3", "peer_4"];
const BIT = new Space("Bit", ["0", "1"]);

function spec(over: Partial<AggregationSpecFields> = {}): AggregationSpec {
  return new AggregationSpec({
    aggregator_id: "peers_two_plus",
    inputs: PEERS,
    output: new Space("PeerLevel", ["lt2", "ge2"]),
    algorithm: "threshold",
    active_value: "active",
    thresholds: [2],
    training_ids_hash: DECLARED,
    version: "v1",
    ...over,
  });
}

/** phi = any active peer: threshold 1. */
function anyActive(inputs: readonly string[] = PEERS, active = "active"): AggregationSpec {
  return spec({ aggregator_id: "any_active", inputs, output: new Space("AnyActive", ["none", "any"]), thresholds: [1], active_value: active });
}

const peers = (activeCount: number) => PEERS.map((_, i) => (i < activeCount ? "active" : "idle"));

describe("AGGREGATE", () => {
  it("test_aggregation", () => {
    // Ordered threshold boundary: count == threshold enters the upper bin.
    expect(bisectRight([2], 2)).toBe(1);
    expect([0, 1, 2, 3, 4].map((c) => aggregate(spec(), peers(c)))).toEqual(["lt2", "lt2", "ge2", "ge2", "ge2"]);
    const bins = spec({ algorithm: "bins", thresholds: [1, 3], output: new Space("Level", ["low", "mid", "high"]) });
    expect([0, 1, 2, 3, 4].map((c) => aggregate(bins, peers(c)))).toEqual(["low", "mid", "mid", "high", "high"]);
    const counted = spec({ algorithm: "count", thresholds: [], output: new Space("Count", ["0", "1", "2", "3", "4"]) });
    expect([0, 1, 2, 3, 4].map((c) => aggregate(counted, peers(c)))).toEqual(["0", "1", "2", "3", "4"]);
    // Ordered bindings: named values resolve by binding name.
    expect(aggregate(spec(), { peer_4: "active", peer_1: "idle", peer_3: "active", peer_2: "offline" })).toBe("ge2");
    expect(aggregate(spec(), PEERS.map(() => "offline"), PEERS.map(() => ACTIVITY))).toBe("lt2");

    // Missing inputs raise; they are never counted as zero.
    raises(() => aggregate(spec(), ["active", "active", null, "idle"]), /input 'peer_3' is missing/);
    raises(() => aggregate(spec(), ["active", undefined, "idle", "idle"]), /input 'peer_2' is missing/);
    raises(() => aggregate(spec(), { peer_1: "active", peer_2: "idle", peer_3: "idle" }), /input 'peer_4' is missing/);
    raises(() => aggregate(spec(), ["active", "idle", "idle"]), /expected 4 inputs/);
    raises(() => aggregate(spec(), { ...Object.fromEntries(PEERS.map((p) => [p, "idle"])), peer_9: "idle" }), /unknown input binding/);
    raises(() => aggregate(spec(), ["active", "idle", "idle", "asleep"], PEERS.map(() => ACTIVITY)), /'asleep' is not in Activity/);
    raises(() => aggregate(spec(), peers(1), PEERS.map(() => BIT)), /active value 'active' is not in Bit/);

    // Any-active merges XOR contexts 01 and 11 despite their different outcomes.
    const phi = anyActive(["a", "b"], "1");
    expect(aggregate(phi, ["0", "1"])).toBe("any");
    expect(aggregate(phi, ["1", "1"])).toBe("any");
    expect(aggregate(phi, ["0", "0"])).toBe("none");
    const xor = [[R(1), R(0)], [R(0), R(1)], [R(0), R(1)], [R(1), R(0)]]; // raw contexts 00, 01, 10, 11
    const check = sufficiency(phi, [BIT, BIT], xor);
    expect(check.sufficient).toBe(false);
    expect(check.delta).toEqual(R(1));
    expect(check.witness).toEqual([1, 3]);
    // Within-bin residual on empirical frequencies flags it too; OR passes.
    const freq = [[9, 1], [2, 8], [1, 9], [8, 2]].map(([a, b]) => [R(a!, a! + b!), R(b!, a! + b!)]);
    const residual = sufficiency(phi, [BIT, BIT], freq);
    expect(residual.sufficient).toBe(false);
    expect(residual.delta).toEqual(R(7, 10));
    expect(residual.witness).toEqual([2, 3]);
    const or = [[R(1), R(0)], [R(0), R(1)], [R(0), R(1)], [R(0), R(1)]];
    expect(sufficiency(phi, [BIT, BIT], or)).toEqual({ delta: R(0), witness: null, sufficient: true });
  });

  it("validates specs and hashes them", () => {
    raises(() => spec({ thresholds: [3, 2], output: new Space("L", ["a", "b", "c"]) }), /strictly increasing/);
    raises(() => spec({ thresholds: [0] }), /\[1, 4\]/);
    raises(() => spec({ thresholds: [5] }), /\[1, 4\]/);
    raises(() => spec({ thresholds: [1.5] }), /\[1, 4\]/);
    raises(() => spec({ thresholds: [] }), /needs thresholds/);
    raises(() => spec({ thresholds: [1, 2] }), /need 3 output values/);
    raises(() => spec({ algorithm: "count", thresholds: [] }), /needs 5 values/);
    raises(() => spec({ algorithm: "count" }), /takes no thresholds/);
    raises(() => spec({ inputs: ["a", "a"], thresholds: [1] }), /duplicate input binding/);
    raises(() => spec({ inputs: [] }), /nonempty array/);
    raises(() => spec({ training_ids_hash: "" }), /training_ids_hash/);
    raises(() => spec({ algorithm: "noisy_or" as never }), /algorithm/);
    expect(aggregationHash(spec())).toBe(aggregationHash(spec()));
    expect(aggregationHash(spec({ version: "v2" }))).not.toBe(aggregationHash(spec()));
    expect(aggregationHash(spec({ inputs: [...PEERS].reverse() }))).not.toBe(aggregationHash(spec()));
  });

  it("counts contexts and parameters (memo §2.4, §5.1)", () => {
    expect(aggregatedContexts(ACTIVITY, anyActive())).toBe(6);
    expect(aggregatedContexts(null, anyActive())).toBe(2);
    expect(parameterCount(6 * 6, 3)).toBe(72);
    expect(parameterCount(6 * 3 ** 5, 3)).toBe(2916);
    raises(() => parameterCount(0, 3), /contexts/);
    raises(() => parameterCount(2 ** 53, 3), /safe integer|contexts/);
  });
});

describe("budgets", () => {
  it("test_budget_before_product", () => {
    const budget = new Budget({ max_contexts: 100, max_factor_entries: 1000, max_nodes: 10, max_particles: 10 });
    const five = Array.from({ length: 5 }, () => ACTIVITY);
    // 3^5 = 243 raw contexts: the request raises before any product constructor runs.
    raises(() => contextSpace(five, 3, budget), /exceed max_contexts 100/);
    expect(productSpy).not.toHaveBeenCalled();
    expect(productAllSpy).not.toHaveBeenCalled();
    // Factor entries over budget also raise first.
    const tight = new Budget({ max_contexts: 100, max_factor_entries: 10, max_nodes: 10, max_particles: 10 });
    raises(() => aggregatedContextSpace(ACTIVITY, anyActive(), 3, tight), /18 factor entries exceed max_factor_entries 10/);
    raises(() => contextSpace([ACTIVITY, ACTIVITY], 3, tight), /27 factor entries/);
    raises(() => checkBudget(101, 1, budget), /101 contexts exceed max_contexts 100/);
    expect(productSpy).not.toHaveBeenCalled();
    expect(productAllSpy).not.toHaveBeenCalled();
    // Within budget, the aggregated self x phi Space is built: 3 x 2 = 6 contexts.
    const space = aggregatedContextSpace(ACTIVITY, anyActive(), 3, budget);
    expect(productSpy).toHaveBeenCalledTimes(1);
    expect(space.name).toBe("(Activity*AnyActive)");
    expect(space.values).toHaveLength(6);
    const phi = anyActive();
    expect(aggregatedContextSpace(null, phi, 3, budget)).toBe(phi.output);
    expect(productSpy).toHaveBeenCalledTimes(1);
    expect(contextSpace([ACTIVITY, ACTIVITY], 3, budget).values).toHaveLength(9);
    expect(productSpy).toHaveBeenCalledTimes(2);
  });
});
