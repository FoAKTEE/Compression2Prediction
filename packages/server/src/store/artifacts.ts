/**
 * Content-addressed artifact store (guide §9.1).
 *
 * Objects live at ``<root>/objects/<hex[:2]>/<hex>.json`` as canonical JSON
 * ``{kind, meta, payload}``; ``meta.content_hash`` is ``contentHash`` over
 * ``{kind, meta minus content_hash, payload}``. The hash covers the scenario
 * namespace and origin, so the same payload in two scenarios is two objects.
 * The sqlite index (``<root>/index.sqlite3``) maps hashes to kind, scenario,
 * origin, run, and version, and holds immutable named versions.
 *
 * Origin separation (invariant 8): ``listRefs`` without ``origin`` returns
 * every origin in the scenario. Observed and simulated records are separated
 * only by passing an explicit ``origin`` filter; callers that must not pool
 * them (fitting, backtests) are required to pass it.
 */
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { asHash, canonicalJson, contentHash, isPlainObject, Meta, ORIGINS, requireFields, ValueError } from "@c2p/core";
import type { Origin } from "@c2p/core";
import { writeFileAtomic } from "./fsAtomic.js";
import { resolveInside, validateName } from "./names.js";

const DRAFT_HASH = "sha256:" + "0".repeat(64);

export interface ArtifactRef {
  readonly kind: string;
  readonly content_hash: string;
  readonly scenario_id: string;
}

/** Envelope fields; a ``Meta`` instance also fits, and its ``content_hash`` is ignored. */
export interface ArtifactMeta {
  readonly origin: Origin;
  readonly scenario_id: string;
  readonly run_id?: string | null;
  readonly version: string;
  readonly content_hash?: string;
}

export interface StoredArtifact {
  readonly ref: ArtifactRef;
  readonly meta: Meta;
  readonly payload: Record<string, unknown>;
}

interface Envelope {
  origin: Origin;
  scenario_id: string;
  run_id: string | null;
  version: string;
}

function normalizeMeta(meta: ArtifactMeta): Envelope {
  if (typeof meta !== "object" || meta === null) throw new ValueError("meta: expected an object");
  const m = new Meta({
    origin: meta.origin,
    scenario_id: meta.scenario_id,
    run_id: meta.run_id ?? null,
    version: meta.version,
    content_hash: DRAFT_HASH,
  });
  validateName(m.scenario_id, "scenario_id");
  if (m.run_id !== null) validateName(m.run_id, "run_id");
  return { origin: m.origin, scenario_id: m.scenario_id, run_id: m.run_id, version: m.version };
}

function checkRef(ref: ArtifactRef): ArtifactRef {
  if (typeof ref !== "object" || ref === null) throw new ValueError("ref: expected an artifact ref");
  return Object.freeze({
    kind: validateName(ref.kind, "kind"),
    content_hash: asHash(ref.content_hash, "content_hash"),
    scenario_id: validateName(ref.scenario_id, "scenario_id"),
  });
}

function hashOf(kind: string, meta: Envelope, payload: unknown): string {
  return contentHash({ kind, meta, payload });
}

export class ArtifactStore {
  readonly root: string;
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(root: string) {
    fs.mkdirSync(root, { recursive: true });
    this.root = resolveInside(root);
    this.db = new DatabaseSync(resolveInside(this.root, "index.sqlite3"));
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS objects (
        content_hash TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        scenario_id TEXT NOT NULL,
        origin TEXT NOT NULL,
        run_id TEXT,
        version TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS objects_listing ON objects (kind, scenario_id, origin);
      CREATE TABLE IF NOT EXISTS names (
        scenario_id TEXT NOT NULL,
        name TEXT NOT NULL,
        content_hash TEXT NOT NULL REFERENCES objects (content_hash),
        PRIMARY KEY (scenario_id, name)
      );
    `);
  }

  private open(): DatabaseSync {
    if (this.closed) throw new ValueError("artifact store is closed");
    return this.db;
  }

  private objectPath(contentHashValue: string): string {
    const hex = contentHashValue.slice("sha256:".length);
    return resolveInside(this.root, "objects", hex.slice(0, 2), `${hex}.json`);
  }

  /** Store ``payload``; idempotent: identical content returns the same ref without rewriting. */
  put(kind: string, payload: object, meta: ArtifactMeta): ArtifactRef {
    const db = this.open();
    validateName(kind, "kind");
    if (!isPlainObject(payload)) throw new ValueError("payload: expected a JSON object");
    const env = normalizeMeta(meta);
    const digest = hashOf(kind, env, payload);
    const bytes = canonicalJson({ kind, meta: { ...env, content_hash: digest }, payload }) + "\n";
    const file = this.objectPath(digest);
    if (fs.existsSync(file)) {
      if (!fs.readFileSync(file).equals(Buffer.from(bytes, "utf8"))) {
        throw new ValueError(`stored object ${digest} does not match its content; refusing to overwrite`);
      }
    } else {
      fs.mkdirSync(resolveInside(this.root, "objects", digest.slice(7, 9)), { recursive: true });
      writeFileAtomic(file, bytes);
    }
    db.prepare(
      "INSERT OR IGNORE INTO objects (content_hash, kind, scenario_id, origin, run_id, version) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(digest, kind, env.scenario_id, env.origin, env.run_id, env.version);
    return Object.freeze({ kind, content_hash: digest, scenario_id: env.scenario_id });
  }

  /** Read ``ref`` within ``scenario_id``; throws on a scenario mismatch or a hash mismatch. */
  get(ref: ArtifactRef, options: { scenario_id: string }): StoredArtifact {
    const db = this.open();
    const r = checkRef(ref);
    const scenario = validateName(options?.scenario_id, "scenario_id");
    if (r.scenario_id !== scenario) {
      throw new ValueError(`artifact ${r.content_hash} belongs to scenario ${r.scenario_id}, not ${scenario}`);
    }
    const row = db.prepare("SELECT kind, scenario_id FROM objects WHERE content_hash = ?").get(r.content_hash);
    if (row === undefined || row.kind !== r.kind || row.scenario_id !== scenario) {
      throw new ValueError(`no ${r.kind} artifact ${r.content_hash} in scenario ${scenario}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.objectPath(r.content_hash), "utf8"));
    } catch (err) {
      throw new ValueError(`artifact ${r.content_hash} is unreadable: ${(err as Error).message}`);
    }
    const o = requireFields(parsed, ["kind", "meta", "payload"], [], { name: "stored artifact" });
    const meta = Meta.fromJson(o.meta);
    if (!isPlainObject(o.payload)) throw new ValueError(`artifact ${r.content_hash}: payload is not an object`);
    const env: Envelope = { origin: meta.origin, scenario_id: meta.scenario_id, run_id: meta.run_id, version: meta.version };
    const computed = hashOf(String(o.kind), env, o.payload);
    if (computed !== meta.content_hash || computed !== r.content_hash) {
      throw new ValueError(`tampered artifact: expected ${r.content_hash}, stored ${meta.content_hash}, computed ${computed}`);
    }
    if (o.kind !== r.kind || meta.scenario_id !== scenario) {
      throw new ValueError(`artifact ${r.content_hash}: kind or scenario does not match the ref`);
    }
    return { ref: r, meta, payload: o.payload };
  }

  /**
   * Refs of ``kind`` in ``scenario_id``, in insertion order. All origins are
   * returned unless ``origin`` is given; that filter is the only way to
   * separate observed from simulated records.
   */
  listRefs(kind: string, options: { scenario_id: string; origin?: Origin }): ArtifactRef[] {
    const db = this.open();
    validateName(kind, "kind");
    const scenario = validateName(options?.scenario_id, "scenario_id");
    const origin = options.origin;
    if (origin !== undefined && !(ORIGINS as readonly unknown[]).includes(origin)) {
      throw new ValueError(`origin: expected one of ${ORIGINS.join(", ")}, got ${JSON.stringify(origin)}`);
    }
    const rows =
      origin === undefined
        ? db.prepare("SELECT content_hash FROM objects WHERE kind = ? AND scenario_id = ? ORDER BY rowid").all(kind, scenario)
        : db
            .prepare("SELECT content_hash FROM objects WHERE kind = ? AND scenario_id = ? AND origin = ? ORDER BY rowid")
            .all(kind, scenario, origin);
    return rows.map((row) => Object.freeze({ kind, content_hash: String(row.content_hash), scenario_id: scenario }));
  }

  /** Bind ``name`` to ``ref`` in ``scenario_id``. Rebinding to another hash throws; the same hash is a no-op. */
  bind(scenario_id: string, name: string, ref: ArtifactRef): void {
    const db = this.open();
    const scenario = validateName(scenario_id, "scenario_id");
    validateName(name, "name");
    const r = checkRef(ref);
    if (r.scenario_id !== scenario) {
      throw new ValueError(`cannot bind ${r.content_hash} from scenario ${r.scenario_id} into ${scenario}`);
    }
    const row = db.prepare("SELECT kind, scenario_id FROM objects WHERE content_hash = ?").get(r.content_hash);
    if (row === undefined || row.kind !== r.kind || row.scenario_id !== scenario) {
      throw new ValueError(`no ${r.kind} artifact ${r.content_hash} in scenario ${scenario}`);
    }
    db.prepare("INSERT OR IGNORE INTO names (scenario_id, name, content_hash) VALUES (?, ?, ?)").run(scenario, name, r.content_hash);
    const bound = db.prepare("SELECT content_hash FROM names WHERE scenario_id = ? AND name = ?").get(scenario, name);
    if (bound?.content_hash !== r.content_hash) {
      throw new ValueError(`${scenario}/${name} is bound to ${String(bound?.content_hash)}; named versions are immutable`);
    }
  }

  /** The ref bound to ``name`` in ``scenario_id``, or ``null`` if unbound. */
  resolve(scenario_id: string, name: string): ArtifactRef | null {
    const db = this.open();
    const scenario = validateName(scenario_id, "scenario_id");
    validateName(name, "name");
    const row = db
      .prepare(
        "SELECT n.content_hash AS content_hash, o.kind AS kind FROM names n JOIN objects o ON o.content_hash = n.content_hash WHERE n.scenario_id = ? AND n.name = ?",
      )
      .get(scenario, name);
    if (row === undefined) return null;
    return Object.freeze({ kind: String(row.kind), content_hash: String(row.content_hash), scenario_id: scenario });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
