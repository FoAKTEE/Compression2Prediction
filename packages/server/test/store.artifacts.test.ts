import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { contentHash, forecast, Kernel, kernelEquals, Meta, Space, ValueError } from "@c2p/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ArtifactStore,
  kernelFromPayload,
  kernelToPayload,
  resolveInside,
  validateName,
} from "../src/store/index.js";
import type { ArtifactMeta, KernelMetadata } from "../src/store/index.js";

const STATUS = ["unacknowledged", "acknowledged", "resolved"];
const BASELINE_ROWS = [
  [0.6, 0.3, 0.1],
  [0, 0.7, 0.3],
  [0, 0, 1],
];
const HAND: KernelMetadata = {
  parameter_origin: "hand_specified_illustration",
  fitting_method: "none",
  training_cutoff: null,
  extra: { context: "fixed supplies", step: "1h" },
};

function baseline(): Kernel {
  const s = new Space("IncidentStatus", STATUS);
  return new Kernel(s, s, BASELINE_ROWS);
}

function meta(scenario_id: string, origin: ArtifactMeta["origin"] = "assumed"): ArtifactMeta {
  return { origin, scenario_id, run_id: null, version: "kernel_incident_progress.v1" };
}

function objectFiles(root: string): string[] {
  const dir = path.join(root, "objects");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".json")).sort();
}

function indexRows(root: string): number {
  const db = new DatabaseSync(path.join(root, "index.sqlite3"));
  try {
    return Number(db.prepare("SELECT COUNT(*) AS n FROM objects").get()!.n);
  } finally {
    db.close();
  }
}

let root: string;
let store: ArtifactStore;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "c2p-store-"));
  store = new ArtifactStore(root);
});

afterEach(() => {
  store.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("artifact store", () => {
  it("test_hash_and_namespace", () => {
    const payload = kernelToPayload(baseline(), HAND);
    const a1 = store.put("kernel", payload, meta("scenario_a"));
    const a2 = store.put("kernel", kernelToPayload(baseline(), HAND), meta("scenario_a"));
    expect(a2).toEqual(a1);
    expect(a1.content_hash).toMatch(/^sha256:[0-9a-f]{64}$/);

    // Same relabeled kernel with a permuted domain order: a different artifact.
    const perm = [2, 0, 1];
    const s = new Space("IncidentStatus", perm.map((i) => STATUS[i]!));
    const permuted = new Kernel(s, s, perm.map((i) => perm.map((j) => BASELINE_ROWS[i]![j]!)));
    const p = store.put("kernel", kernelToPayload(permuted, HAND), meta("scenario_a"));
    expect(p.content_hash).not.toBe(a1.content_hash);

    const fitted = store.put("kernel", kernelToPayload(baseline(), { ...HAND, parameter_origin: "hand_specified" }), meta("scenario_a"));
    expect(fitted.content_hash).not.toBe(a1.content_hash);

    // Scenario isolation: same payload in B is a different object; A cannot be read as B.
    const b = store.put("kernel", payload, meta("scenario_b"));
    expect(b.content_hash).not.toBe(a1.content_hash);
    expect(() => store.get(a1, { scenario_id: "scenario_b" })).toThrow(ValueError);
    expect(() => store.get({ ...a1, scenario_id: "scenario_b" }, { scenario_id: "scenario_b" })).toThrow(ValueError);
    expect(store.listRefs("kernel", { scenario_id: "scenario_b" })).toEqual([b]);
    expect(store.listRefs("kernel", { scenario_id: "scenario_a" }).map((r) => r.content_hash)).not.toContain(b.content_hash);
    expect(store.get(a1, { scenario_id: "scenario_a" }).payload).toEqual(payload);

    // Idempotent duplicate: same ref, one object file, one index row, no rewrite.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c2p-store-dup-"));
    const dup = new ArtifactStore(dir);
    try {
      const r1 = dup.put("kernel", payload, meta("scenario_a"));
      const file = path.join(dir, "objects", r1.content_hash.slice(7, 9), `${r1.content_hash.slice(7)}.json`);
      const before = fs.statSync(file);
      const r2 = dup.put("kernel", payload, meta("scenario_a"));
      const after = fs.statSync(file);
      expect(r2).toEqual(r1);
      expect(objectFiles(dir)).toHaveLength(1);
      expect(fs.readdirSync(path.dirname(file))).toEqual([path.basename(file)]);
      expect(indexRows(dir)).toBe(1);
      expect([after.ino, after.mtimeMs]).toEqual([before.ino, before.mtimeMs]);
    } finally {
      dup.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }

    // Traversal.
    for (const bad of ["../x", "a/b", "..", ".", "", ".hidden", "a\\b", "x".repeat(129)]) {
      expect(() => validateName(bad)).toThrow(ValueError);
    }
    expect(validateName("run_2026-10-04.v1")).toBe("run_2026-10-04.v1");
    expect(() => resolveInside(root, "..", "x")).toThrow(ValueError);
    expect(() => resolveInside(root, "objects/../../x")).toThrow(ValueError);
    expect(() => resolveInside(root, "/etc/passwd")).toThrow(ValueError);
    expect(resolveInside(root, "objects", "ab")).toBe(path.join(root, "objects", "ab"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "c2p-outside-"));
    try {
      fs.symlinkSync(outside, path.join(root, "link"));
      expect(() => resolveInside(root, "link", "secret.json")).toThrow(ValueError);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
    expect(() => store.put("../kernel", payload, meta("scenario_a"))).toThrow(ValueError);
    expect(() => store.put("kernel", payload, meta("../scenario_a"))).toThrow(ValueError);
  });

  it("test_kernel_payload_roundtrip", () => {
    const k = baseline();
    const payload = kernelToPayload(k, HAND);
    expect(payload.matrix_convention).toBe("rows=input");
    expect(payload.source).toEqual({ name: "IncidentStatus", values: STATUS });
    expect(payload.target).toEqual({ name: "IncidentStatus", values: STATUS });
    expect(payload.rows).toEqual(BASELINE_ROWS);

    const ref = store.put("kernel", payload, meta("baseline"));
    const read = store.get(ref, { scenario_id: "baseline" });
    expect(read.meta).toBeInstanceOf(Meta);
    expect(read.meta.content_hash).toBe(ref.content_hash);
    expect(read.meta.origin).toBe("assumed");
    const decoded = kernelFromPayload(read.payload);
    expect(kernelEquals(decoded.kernel, k)).toBe(true);
    expect(decoded.kernel.source.values).toEqual(STATUS);
    expect(decoded.parameter_origin).toBe("hand_specified_illustration");
    expect(decoded.training_cutoff).toBeNull();
    expect(decoded.extra).toEqual(HAND.extra);
    expect(kernelToPayload(decoded.kernel, decoded)).toEqual(payload);

    const b2 = forecast([1, 0, 0], decoded.kernel, 2);
    [0.36, 0.39, 0.25].forEach((v, i) => expect(Math.abs(b2[i]! - v)).toBeLessThanOrEqual(1e-12));

    const { matrix_convention: _drop, ...noConvention } = payload;
    expect(() => kernelFromPayload(noConvention)).toThrow(ValueError);
    expect(() => kernelFromPayload({ ...payload, matrix_convention: "rows=output" })).toThrow(ValueError);
    expect(() => kernelFromPayload({ ...payload, parameter_origin: "llm_guess" })).toThrow(ValueError);
    expect(() => kernelToPayload(k, { ...HAND, parameter_origin: "llm_guess" as never })).toThrow(ValueError);
    expect(() => kernelFromPayload({ ...payload, unknown: 1 })).toThrow(ValueError);
    expect(() => kernelFromPayload({ ...payload, rows: [[0.6, 0.3, 0.2], ...BASELINE_ROWS.slice(1)] })).toThrow(ValueError);
    expect(() => kernelFromPayload({ ...payload, source: { name: "S", values: ["a", "a", "b"] } })).toThrow(ValueError);
  });

  it("test_tamper_detection", () => {
    const ref = store.put("kernel", kernelToPayload(baseline(), HAND), meta("baseline"));
    const file = path.join(root, "objects", ref.content_hash.slice(7, 9), `${ref.content_hash.slice(7)}.json`);
    const original = fs.readFileSync(file, "utf8");

    type Stored = { kind: string; meta: Record<string, unknown>; payload: { rows: number[][] } };

    // Payload edited, hash left alone.
    const edited = JSON.parse(original) as Stored;
    edited.payload.rows[0] = [0.5, 0.4, 0.1];
    fs.writeFileSync(file, JSON.stringify(edited));
    expect(() => store.get(ref, { scenario_id: "baseline" })).toThrow(/tampered/);
    // A put of the true content refuses to overwrite the tampered object.
    expect(() => store.put("kernel", kernelToPayload(baseline(), HAND), meta("baseline"))).toThrow(ValueError);

    // Origin relabeled with a self-consistent recomputed hash: still caught against the ref.
    const relabeled = JSON.parse(original) as Stored;
    relabeled.meta.origin = "observed";
    const { content_hash: _old, ...env } = relabeled.meta;
    relabeled.meta.content_hash = contentHash({ kind: relabeled.kind, meta: env, payload: relabeled.payload });
    fs.writeFileSync(file, JSON.stringify(relabeled));
    expect(() => store.get(ref, { scenario_id: "baseline" })).toThrow(/tampered/);

    // Truncated file.
    fs.writeFileSync(file, original.slice(0, 20));
    expect(() => store.get(ref, { scenario_id: "baseline" })).toThrow(ValueError);

    // Restored bytes read cleanly again.
    fs.writeFileSync(file, original);
    expect(store.get(ref, { scenario_id: "baseline" }).ref).toEqual(ref);
  });

  it("test_named_versions_are_immutable", () => {
    const v1 = store.put("kernel", kernelToPayload(baseline(), HAND), meta("baseline"));
    const v2 = store.put("kernel", kernelToPayload(baseline(), { ...HAND, fitting_method: "manual" }), meta("baseline"));
    expect(store.resolve("baseline", "incident_progress")).toBeNull();
    store.bind("baseline", "incident_progress", v1);
    store.bind("baseline", "incident_progress", v1); // same hash: no-op
    expect(() => store.bind("baseline", "incident_progress", v2)).toThrow(/immutable/);
    expect(store.resolve("baseline", "incident_progress")).toEqual(v1);
    store.bind("baseline", "incident_progress.v2", v2);
    expect(store.resolve("baseline", "incident_progress.v2")).toEqual(v2);

    // Names are per scenario; refs cannot cross scenarios.
    expect(store.resolve("other", "incident_progress")).toBeNull();
    expect(() => store.bind("other", "incident_progress", v1)).toThrow(ValueError);
    expect(() => store.bind("baseline", "missing", { ...v1, content_hash: "sha256:" + "1".repeat(64) })).toThrow(ValueError);
    expect(() => store.bind("baseline", "../escape", v1)).toThrow(ValueError);

    // Survives reopening.
    store.close();
    store = new ArtifactStore(root);
    expect(store.resolve("baseline", "incident_progress")).toEqual(v1);
    expect(() => store.bind("baseline", "incident_progress", v2)).toThrow(/immutable/);
  });

  it("test_origin_filter", () => {
    const record = (n: number) => ({ schema_version: "transition.v1", round: n, entity_id: "ent_operator_a" });
    const obs = store.put("transition", record(1), meta("real_world", "observed"));
    const sim1 = store.put("transition", record(1), { ...meta("real_world", "simulated"), run_id: "run_example" });
    const sim2 = store.put("transition", record(2), { ...meta("real_world", "simulated"), run_id: "run_example" });
    expect(sim1.content_hash).not.toBe(obs.content_hash);

    // Without a filter, origins are mixed; separation needs the explicit filter.
    expect(store.listRefs("transition", { scenario_id: "real_world" })).toEqual([obs, sim1, sim2]);
    expect(store.listRefs("transition", { scenario_id: "real_world", origin: "observed" })).toEqual([obs]);
    expect(store.listRefs("transition", { scenario_id: "real_world", origin: "simulated" })).toEqual([sim1, sim2]);
    expect(store.listRefs("transition", { scenario_id: "real_world", origin: "extracted" })).toEqual([]);
    expect(store.listRefs("kernel", { scenario_id: "real_world" })).toEqual([]);
    expect(store.get(sim1, { scenario_id: "real_world" }).meta.origin).toBe("simulated");
    expect(() => store.listRefs("transition", { scenario_id: "real_world", origin: "generated" as never })).toThrow(ValueError);
    expect(() => store.put("transition", record(3), meta("real_world", "imagined" as never))).toThrow(ValueError);
  });
});
