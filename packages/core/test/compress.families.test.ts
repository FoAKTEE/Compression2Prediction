/** N6.1: family pooling and frozen-family shrinkage (memo §2.3, §4.3 POOL/SHRINK, §4.4). */
import { describe, expect, it } from "vitest";
import { FamilyKey } from "../src/causal/family.js";
import { FittedRows, freezeFamily, FrozenFamily, pool, recordIdsHash, shrink, toFamilyKey, transitionIdEntity, transitionIdParts } from "../src/compress/families.js";
import { buildTransitionDataset } from "../src/learn/datasets.js";
import type { CountDatum } from "../src/learn/datasets.js";
import { exactRow, fitSparseRows, row, SparseRows } from "../src/learn/rows.js";
import { Rational } from "../src/numeric/rational.js";
import { ACTIVITY, data, KEY, R, tid, uniformPrior } from "./fixtures/compress.js";
import { raises } from "./support.js";

const E1: readonly (readonly [number, number])[] = [[0, 0], [0, 1], [1, 1], [0, 0], [2, 2]];
const E2: readonly (readonly [number, number])[] = [[0, 2], [1, 1], [1, 0], [0, 0]];

const str = (rows: readonly Rational[]) => rows.map(String);
const countsJson = (t: SparseRows) => t.toJson().counts;

/** Family training data: context 0 counts (5, 2, 2), context 1 counts (0, 3, 0). */
function training(): CountDatum[] {
  return [
    ...data("train", "e2", [[0, 0], [0, 0], [0, 0], [0, 1], [1, 1]]),
    ...data("train", "e3", [[0, 0], [0, 0], [0, 1], [0, 2], [0, 2], [1, 1], [1, 1]]),
  ];
}

function family(): FrozenFamily {
  const d = training();
  return freezeFamily(pool(d, KEY, uniformPrior()), KEY);
}

/** Local data for e1 in context 0: counts (1, 2, 1), repeated ``times`` times. */
function local(times = 1): CountDatum[] {
  const pattern: [number, number][] = [[0, 0], [0, 1], [0, 1], [0, 2]];
  return data("local", "e1", Array.from({ length: times }, () => pattern).flat());
}

const maxDiff = (a: readonly Rational[], b: readonly Rational[]) =>
  a.reduce((m, x, i) => m.max(x.sub(b[i]!).abs()), Rational.ZERO);

describe("POOL", () => {
  it("test_pooling", () => {
    const prior = uniformPrior();
    const a = data("run1", "e1", E1);
    const b = data("run1", "e2", E2);
    const pooled = pool([...a, ...b], KEY, prior);
    // Pooled counts equal the concatenated eligible counts, and the per-entity sums.
    expect(countsJson(pooled)).toEqual([[0, [3, 1, 1]], [1, [1, 2, 0]], [2, [0, 0, 1]]]);
    expect(countsJson(pooled)).toEqual(countsJson(fitSparseRows([...a, ...b], prior)));
    const ea = fitSparseRows(a, prior);
    const eb = fitSparseRows(b, prior);
    for (let c = 0; c < 3; c++) {
      expect(pooled.countsFor(c)).toEqual(ea.countsFor(c).map((n, y) => n + eb.countsFor(c)[y]!));
    }
    // Order-free; source/target ordering and the prior are unchanged.
    expect(pool([...b].reverse().concat([...a].reverse()), KEY, prior).toJson()).toEqual(pooled.toJson());
    expect(pooled.source).toBe(prior.source);
    expect(pooled.target).toBe(prior.target);
    const { counts: _p, ...priorRest } = prior.toJson();
    const { counts: _q, ...pooledRest } = pooled.toJson();
    expect(pooledRest).toEqual(priorRest);
    expect(prior.counts).toEqual([]);
    // A FamilyKey instance and a key-like object pool identically.
    expect(pool([...a, ...b], new FamilyKey({ ...KEY, kind: "Person" }), prior).toJson()).toEqual(pooled.toJson());

    // Mismatches raise.
    raises(() => pool([...a, ...data("run1", "e2", E2, 0, { origin: "observed" })], KEY, prior), /mixes origins/);
    const other = (field: string, value: string) => data("run1", "e2", E2, 0, { key: { ...KEY, [field]: value } });
    raises(() => pool([...a, ...other("data_origin_partition", "observed")], KEY, prior), /origin partition/);
    raises(() => pool([...a, ...other("regime", "surge")], KEY, prior), /regime 'surge' is not 'normal'/);
    raises(() => pool([...a, ...other("interface_hash", "sha256:" + "c".repeat(64))], KEY, prior), /interface/);
    raises(() => pool([...a, ...other("template", "tpl_other")], KEY, prior), /family template/);
    raises(() => pool([...a, ...other("role", "manager")], KEY, prior), /family role/);
    raises(() => pool(a, { ...KEY, regime: "surge" }, prior), /regime/);
    // Duplicates, a prior with counts, malformed IDs and keys, unsupported outcomes.
    raises(() => pool([...a, a[0]!], KEY, prior), /duplicate record_id/);
    raises(() => pool(a, KEY, pooled), /already carries counts/);
    raises(() => pool([{ ...a[0]!, record_id: "r1" }], KEY, prior), /not a complete transition record ID/);
    raises(() => pool([{ ...a[0]!, record_id: tid("run1", "e1", 0).replace('"transition"', '"note"') }], KEY, prior), /transition record ID/);
    raises(() => pool([{ ...a[0]!, entity_id: "e9" }], KEY, prior), /differs from the record ID/);
    raises(() => pool(a, { ...KEY, kind: "Meeting" }, prior), /kind/);
    raises(() => pool(a, { ...KEY, interface_hash: "abc" }, prior), /interface_hash/);
    const restricted = new SparseRows({ ...fieldsOf(prior), support: [0, 1], default_prior: [R(1, 2), R(1, 2), R(0)] });
    raises(() => pool(a, KEY, restricted), /outside the support/);
  });

  it("pools only eligible transitions from a transition dataset", () => {
    const rec = (entity: string, round: number, before: string, after: string | null, status: Record<string, unknown> = {}) => ({
      schema_version: "transition_record.v1",
      record_kind: "transition",
      sequence_number: 0,
      source_action_ids: [],
      canonical_event_ids: [],
      valid_time: null,
      availability_time: null,
      processing_time: "2026-10-04T08:00:00Z",
      transition: {
        schema_version: "transition.v1",
        run_id: "run1",
        scenario_id: "baseline",
        platform: "reddit",
        round,
        simulated_time_minutes: round * 60,
        step_minutes: 60,
        entity_id: entity,
        agent_id: null,
        origin: "simulated",
        activity_status: "action",
        execution_status: "completed",
        state_before: { activity: before },
        state_after: after === null ? null : { activity: after },
        observation_status: "complete",
        mechanism_version: "model.v1",
        ...status,
      },
    });
    const records = [
      rec("e1", 0, "idle", "active"),
      rec("e1", 1, "active", "active"),
      rec("e1", 2, "active", "offline", { execution_status: "failed" }),
      rec("e1", 3, "active", null, { observation_status: "missing" }),
      rec("e2", 0, "idle", "idle"),
      rec("e2", 1, "idle", "idle", { activity_status: "inactive", execution_status: "not_attempted" }),
    ];
    const ds = buildTransitionDataset(records, { origin: "simulated", scenario_id: "baseline", variable: "activity", space: ACTIVITY, key: KEY });
    expect(ds.data.map((d) => transitionIdEntity(d.record_id))).toEqual(["e1", "e1", "e2"]);
    const pooled = pool(ds.data, KEY, uniformPrior());
    expect(countsJson(pooled)).toEqual([[0, [1, 1, 0]], [1, [0, 1, 0]]]);
  });
});

function fieldsOf(t: SparseRows) {
  return {
    source: t.source,
    target: t.target,
    support: t.support,
    default_prior: t.default_prior,
    strength: t.strength,
    prior_overrides: t.prior_overrides,
    counts: t.counts,
  };
}

describe("frozen families", () => {
  it("hash the table, key, and full lineage and reject tampering", () => {
    const f = family();
    const ids = training().map((d) => d.record_id);
    const sorted = [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(f.training_ids).toEqual(sorted);
    expect(f.lineage).toEqual({
      record_ids: sorted,
      local_ids: sorted,
      origin: "simulated",
      max_rounds: [["train", "reddit", 6]],
      availability_cutoff: null,
      ancestors: [],
    });
    expect(f.content_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(f.table).toBeInstanceOf(FittedRows);
    expect(f.table.content_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    // Order-free: the same records in another order freeze identically.
    expect(freezeFamily(pool([...training()].reverse(), KEY, uniformPrior())).content_hash).toBe(f.content_hash);
    expect(freezeFamily(f.table).content_hash).toBe(f.content_hash);
    expect(recordIdsHash(ids)).toBe(recordIdsHash([...ids].reverse()));
    const fields = { table: f.table, key: f.key, training_ids: f.training_ids, lineage: f.lineage, content_hash: f.content_hash };
    expect(new FrozenFamily(fields).content_hash).toBe(f.content_hash);
    raises(() => new FrozenFamily({ ...fields, content_hash: "sha256:" + "0".repeat(64) }), /does not match/);
    raises(() => new FrozenFamily({ ...fields, training_ids: [...f.training_ids].reverse() }), /code-point order/);
    raises(() => new FrozenFamily({ ...fields, training_ids: f.training_ids.slice(1) }), /training_ids lists 11 records but the table's lineage has 12/);
    raises(() => new FrozenFamily({ ...fields, lineage: { ...f.lineage, max_rounds: [] } }), /lineage: does not match/);
    raises(() => new FrozenFamily({ ...fields, key: toFamilyKey({ ...KEY, regime: "surge" }) }), /regime/);
    // Only pool/shrink results freeze: a bare table plus IDs carries no lineage.
    const bare = fitSparseRows(training(), uniformPrior());
    raises(() => freezeFamily(bare as never), /expected FittedRows from pool or shrink/);
    raises(() => new FrozenFamily({ ...fields, table: bare as never }), /expected FittedRows/);
    raises(() => new (FittedRows as unknown as new (...a: unknown[]) => FittedRows)(Symbol("x"), fieldsOf(bare), f.key, f.lineage), /only from pool or shrink/);
    // The key is the table's; another key raises instead of re-labelling.
    raises(() => freezeFamily(f.table, { ...KEY, regime: "surge" }), /regime 'surge' is not 'normal'/);
    expect(transitionIdParts(ids[0]!)).toEqual({ run_id: "train", platform: "reddit", round: 0, entity_id: "e2", sequence_number: 0 });
  });

  it("C8: a shrink, refreeze, reuse chain keeps the transitive lineage and rejects the original data", () => {
    const f = family();
    const kappa = R(4);
    const transported = shrink(f, "e1", [], kappa);
    expect(transported).toBeInstanceOf(FittedRows);
    expect(transported.lineage.record_ids).toEqual(f.training_ids);
    expect(transported.lineage.local_ids).toEqual([]);
    expect(transported.lineage.ancestors).toEqual([f.content_hash]);
    const refrozen = freezeFamily(transported, KEY);
    // Before: the refrozen family listed no training IDs and reuse succeeded.
    expect(refrozen.training_ids).toEqual(f.training_ids);
    for (const d of training()) {
      raises(() => shrink(refrozen, d.entity_id, [d], kappa), /training IDs; local data must be disjoint/);
    }
    // Lineage accumulates over levels and is hashed.
    const level2 = shrink(refrozen, "e1", local(), kappa);
    const ids = local().map((d) => d.record_id);
    expect(level2.lineage.record_ids).toEqual([...f.training_ids, ...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    expect(level2.lineage.ancestors).toEqual([f.content_hash, refrozen.content_hash]);
    const level2Frozen = freezeFamily(level2);
    raises(() => shrink(level2Frozen, "e1", [local()[0]!], kappa), /training IDs/);
    raises(() => shrink(level2Frozen, "e2", [training()[0]!], kappa), /training IDs/);
    // Same table, different lineage: different hashes.
    expect(shrink(f, "e1", [], kappa).content_hash).toBe(transported.content_hash);
    expect(shrink(refrozen, "e1", [], kappa).content_hash).not.toBe(transported.content_hash);
  });

  it("C8: local data must be later than the prior's training in the same run", () => {
    // A prior trained at round 100 of one run; local data at round 1 of that run.
    const future = data("sameRun", "e", [[0, 0]], 100);
    const futureFamily = freezeFamily(pool(future, KEY, uniformPrior()));
    expect(futureFamily.lineage.max_rounds).toEqual([["sameRun", "reddit", 100]]);
    const kappa = R(4);
    raises(() => shrink(futureFamily, "e", data("sameRun", "e", [[0, 2]], 1), kappa), /round 1 is not later than the prior's training \(round 100/);
    raises(() => shrink(futureFamily, "f", data("sameRun", "f", [[0, 2]], 100), kappa), /round 100 is not later/);
    expect(str(exactRow(shrink(futureFamily, "e", data("sameRun", "e", [[0, 2]], 101), kappa), 0))).toEqual(["2/5", "1/5", "2/5"]);
    // Rounds of another run or platform are a separate clock.
    expect(shrink(futureFamily, "e", data("otherRun", "e", [[0, 2]], 1), kappa).lineage.max_rounds).toEqual([
      ["otherRun", "reddit", 1],
      ["sameRun", "reddit", 100],
    ]);
  });

  it("C8: local data must carry the prior's actual origin, whatever its declared partition", () => {
    const observedKey = { ...KEY, data_origin_partition: "observed" };
    const trained = data("run", "e", [[0, 0]], 0, { origin: "observed", key: observedKey });
    const f = freezeFamily(pool(trained, observedKey, uniformPrior()), observedKey);
    expect(f.lineage.origin).toBe("observed");
    const simLocal = data("runSim", "e", [[0, 2]], 1, { origin: "simulated", key: observedKey });
    raises(() => shrink(f, "e", simLocal, R(4)), /actual origin 'simulated' differs from the prior's training origin 'observed'/);
    const obsLocal = data("runObs", "e", [[0, 2]], 1, { origin: "observed", key: observedKey });
    expect(shrink(f, "e", obsLocal, R(4)).lineage.origin).toBe("observed");
  });

  it("local data must be available after the prior's availability cutoff", () => {
    const observedKey = { ...KEY, data_origin_partition: "observed" };
    const at = (time: string | null) => ({ origin: "observed" as const, key: observedKey, availability_time: time });
    const trained = [
      ...data("obs", "e2", [[0, 0]], 0, at("2026-03-01T00:00:00Z")),
      ...data("obs", "e3", [[0, 1]], 0, at("2026-03-02T09:00:00+09:00")),
    ];
    const f = freezeFamily(pool(trained, observedKey, uniformPrior()));
    // 2026-03-02T09:00+09:00 is 2026-03-02T00:00Z, the later of the two.
    expect(f.lineage.availability_cutoff).toBe("2026-03-02T09:00:00+09:00");
    const kappa = R(4);
    const local = (time: string | null) => data("obs2", "e1", [[0, 2]], 0, at(time));
    raises(() => shrink(f, "e1", local("2026-03-01T12:00:00Z"), kappa), /not after the prior's availability cutoff/);
    raises(() => shrink(f, "e1", local("2026-03-02T00:00:00Z"), kappa), /not after the prior's availability cutoff/);
    raises(() => shrink(f, "e1", local(null), kappa), /no availability_time/);
    raises(() => shrink(f, "e1", data("obs2", "e1", [[0, 2]], 0, { origin: "observed", key: observedKey }), kappa), /no availability_time/);
    const later = shrink(f, "e1", local("2026-03-02T00:00:01Z"), kappa);
    expect(later.lineage.availability_cutoff).toBe("2026-03-02T00:00:01Z");
    // Naive timestamps cannot set or meet a cutoff.
    raises(() => pool(data("obs", "e2", [[0, 0]], 0, at("2026-03-01T00:00:00")), observedKey, uniformPrior()), /explicit offset/);
  });
});

describe("SHRINK", () => {
  it("test_shrinkage", () => {
    const f = family();
    // Frozen family means mu_c = (N_fcy + alpha q_y) / (N_fc + alpha), alpha q = 1.
    expect(str(exactRow(f.table, 0))).toEqual(["1/2", "1/4", "1/4"]);
    expect(str(exactRow(f.table, 1))).toEqual(["1/6", "2/3", "1/6"]);
    const kappa = R(4);
    const s = shrink(f, "e1", local(), kappa);
    // Displayed fraction: (N_icy + kappa mu_cy) / (N_ic + kappa) = (1 + 2, 2 + 1, 1 + 1) / 8.
    const mu = exactRow(f.table, 0);
    const n = [1, 2, 1];
    const displayed = mu.map((m, y) => R(n[y]!).add(kappa.mul(m)).div(R(4).add(kappa)));
    expect(str(exactRow(s, 0))).toEqual(["3/8", "3/8", "1/4"]);
    expect(exactRow(s, 0)).toEqual(displayed);
    expect(row(s, 0)).toEqual({ probabilities: [3 / 8, 3 / 8, 1 / 4], count: 4, prior_only: false });
    // Missing local rows return the frozen prior, flagged prior_only.
    expect(row(s, 1)).toEqual({ probabilities: exactRow(f.table, 1).map((p) => p.toNumber()), count: 0, prior_only: true });
    expect(exactRow(s, 1)).toEqual(exactRow(f.table, 1));
    expect(str(exactRow(s, 2))).toEqual(["1/3", "1/3", "1/3"]);
    expect(row(s, 2).prior_only).toBe(true);

    // kappa -> infinity approaches the family mean: |theta - mu| = 1 / (4 + kappa) here.
    let previous = Rational.ONE;
    for (let j = 0; j <= 13; j++) {
      const kj = R(10n ** BigInt(j));
      const d = maxDiff(exactRow(shrink(f, "e1", local(), kj), 0), mu);
      expect(d).toEqual(R(1).div(R(4).add(kj)));
      expect(d.cmp(previous)).toBe(-1);
      previous = d;
    }
    expect(previous.toNumber()).toBeLessThan(1e-12);
    // Local N -> infinity approaches local frequencies (1/4, 1/2, 1/4): |theta - f| = 1 / (4m + 4).
    const freq = [R(1, 4), R(1, 2), R(1, 4)];
    previous = Rational.ONE;
    for (const m of [1, 10, 100, 1000]) {
      const d = maxDiff(exactRow(shrink(f, "e1", local(m), kappa), 0), freq);
      expect(d).toEqual(R(1, 4 * m + 4));
      expect(d.cmp(previous)).toBe(-1);
      previous = d;
    }

    // Overlapping training IDs raise.
    raises(() => shrink(f, "e1", [...local(), { ...training()[0]!, entity_id: "e2" }], kappa), /entity 'e2' is not 'e1'/);
    const overlap = { ...local()[0]!, record_id: f.training_ids[0]!, entity_id: transitionIdEntity(f.training_ids[0]!) };
    raises(() => shrink(f, overlap.entity_id, [overlap], kappa), /training IDs; local data must be disjoint/);
    raises(() => shrink(f, "e1", data("local", "e1", [[0, 0]], 0, { key: { ...KEY, regime: "surge" } }), kappa), /regime/);
    raises(() => shrink(f, "e1", local(), R(0)), /kappa/);
    raises(() => shrink(f, "e1", [...local(), local()[0]!], kappa), /duplicate record_id/);

    // Never refit the prior: the frozen family is untouched and its rows are the prior.
    expect(family().content_hash).toBe(f.content_hash);
    expect(s.strength).toEqual(kappa);
    expect(s.prior_overrides.map(([c, q]) => [c, str(q)])).toEqual([
      [0, ["1/2", "1/4", "1/4"]],
      [1, ["1/6", "2/3", "1/6"]],
    ]);
    expect(s.default_prior).toEqual(f.table.default_prior);
    expect(countsJson(s)).toEqual([[0, [1, 2, 1]]]);
  });
});
