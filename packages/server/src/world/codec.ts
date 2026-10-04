/**
 * World bundle codec: the canonical-world JSON accepted by
 * `PUT /api/world/projects/:id/world`, stored as an immutable `world` artifact,
 * and re-decoded for every read.
 *
 * Bundle fields: `ontology` ({version, subtypes, roles}), `entities` (guide
 * §4.2 `world.v1` records, roles embedded), `role_assignments`,
 * `participations`, `claims`, `evidence` (each a record plus its `origin`),
 * and optional `scenario_id` / `version` for the records' envelope. Every
 * record is decoded with core constructors and the whole set is checked with
 * `validateLinks`; unknown fields are rejected at every level.
 */
import {
  asStr,
  Claim,
  Entity,
  eligible,
  EventParticipation,
  Evidence,
  isPlainObject,
  OntologyRegistry,
  requireFields,
  RoleAssignment,
  RoleDef,
  seal,
  SubtypeDef,
  validateLinks,
  ValueError,
} from "@c2p/core";
import type { EntityJson, EnvelopeFields, Kind, Meta, Origin, RecordClass } from "@c2p/core";
import { validateName } from "../store/index.js";
import type {
  ClaimJson,
  EligibilityResponse,
  EventParticipationJson,
  EvidenceJson,
  RoleAssignmentRecordJson,
  WorldCounts,
  WorldResponse,
} from "../wire.js";

export const BUNDLE_FIELDS = Object.freeze(["ontology", "entities", "role_assignments", "participations", "claims", "evidence"]);
export const BUNDLE_OPTIONAL = Object.freeze(["scenario_id", "version"]);
export const DEFAULT_SCENARIO = "baseline";
export const DEFAULT_RECORD_VERSION = "world.v1";

const ROLE_FIELDS = ["entity_id", "role", "scope_entity_id", "valid_from", "valid_to", "evidence_ids", "origin"];
const PART_FIELDS = ["event_id", "participant_entity_id", "participation_role", "valid_from", "valid_to", "evidence_ids", "origin"];
const CLAIM_FIELDS = [
  "claim_id",
  "claim_kind",
  "subject_entity_id",
  "predicate",
  "object_entity_id",
  "value",
  "variable_key",
  "evidence_ids",
  "assertion_status",
  "valid_from",
  "valid_to",
  "conflict_group_id",
  "origin",
];
const EVIDENCE_FIELDS = [
  "evidence_id",
  "source_hash",
  "source_span",
  "availability_time",
  "extraction_version",
  "review_status",
  "origin",
];

/** Weakest first: a bundle is only as observed as its least-evidenced record. */
const ORIGIN_RANK: readonly Origin[] = ["assumed", "extracted", "observed"];

export interface WorldBundle {
  readonly scenario_id: string;
  readonly version: string;
  readonly registry: OntologyRegistry;
  readonly entities: readonly Entity[];
  readonly roles: readonly RoleAssignment[];
  readonly participations: readonly EventParticipation[];
  readonly claims: readonly Claim[];
  readonly evidence: readonly Evidence[];
}

/** Stored artifact payload (also a valid import body). */
export interface WorldPayload {
  scenario_id: string;
  version: string;
  ontology: OntologyJson;
  entities: EntityJson[];
  role_assignments: RoleAssignmentRecordJson[];
  participations: EventParticipationJson[];
  claims: ClaimJson[];
  evidence: EvidenceJson[];
}

export interface OntologyJson {
  version: string;
  subtypes: { name: string; parent: string }[];
  roles: { name: string; allowed_kinds: Kind[]; scope_kinds: Kind[] }[];
}

function list(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new ValueError(`${field}: expected an array`);
  return value as unknown[];
}

function decodeOntology(d: unknown): OntologyRegistry {
  const o = requireFields(d, ["version", "subtypes", "roles"], [], { name: "ontology" });
  const subtypes = list(o.subtypes, "ontology.subtypes").map((s, i) => {
    const f = requireFields(s, ["name", "parent"], [], { name: `ontology.subtypes[${i}]` });
    return new SubtypeDef({ name: f.name as string, parent: f.parent as string });
  });
  const roles = list(o.roles, "ontology.roles").map((r, i) => {
    const f = requireFields(r, ["name", "allowed_kinds", "scope_kinds"], [], { name: `ontology.roles[${i}]` });
    return new RoleDef({
      name: f.name as string,
      allowed_kinds: f.allowed_kinds as Kind[],
      scope_kinds: f.scope_kinds as Kind[],
    });
  });
  return new OntologyRegistry({ version: o.version as string, subtypes, roles });
}

function encodeOntology(r: OntologyRegistry): OntologyJson {
  return {
    version: r.version,
    subtypes: r.subtypes.map((s) => ({ name: s.name, parent: s.parent })),
    roles: r.roles.map((x) => ({ name: x.name, allowed_kinds: [...x.allowed_kinds], scope_kinds: [...x.scope_kinds] })),
  };
}

interface Env {
  readonly scenario_id: string;
  readonly version: string;
}

/** Decode one standalone record: strict fields, envelope from the bundle, origin from the record. */
function record<R extends object, P extends { readonly meta: Meta }>(
  cls: RecordClass<R, P>,
  d: unknown,
  fields: readonly string[],
  env: Env,
  name: string,
): R {
  const { origin, ...values } = requireFields(d, fields, [], { name });
  return seal(cls, {
    origin: asStr(origin, `${name}.origin`) as Origin,
    scenario_id: env.scenario_id,
    run_id: null,
    version: env.version,
    ...values,
  } as unknown as EnvelopeFields & Omit<P, "meta">);
}

function sameEnvelope(a: Meta, b: Meta): boolean {
  return a.origin === b.origin && a.scenario_id === b.scenario_id && a.run_id === b.run_id && a.version === b.version;
}

/** Decode and validate a bundle (import body or stored payload). Throws `ValueError`. */
export function decodeWorld(body: unknown): WorldBundle {
  const o = requireFields(body, BUNDLE_FIELDS, BUNDLE_OPTIONAL, { name: "world" });
  const env: Env = {
    scenario_id: validateName(o.scenario_id ?? DEFAULT_SCENARIO, "scenario_id"),
    version: asStr(o.version ?? DEFAULT_RECORD_VERSION, "version"),
  };
  const registry = decodeOntology(o.ontology);
  const roles: RoleAssignment[] = [];
  const entities = list(o.entities, "entities").map((e, i) => {
    if (!isPlainObject(e)) throw new ValueError(`entities[${i}]: expected a world.v1 entity object`);
    return Entity.fromJson(e, roles, env);
  });
  list(o.role_assignments, "role_assignments").forEach((r, i) => {
    roles.push(record(RoleAssignment, r, ROLE_FIELDS, env, `role_assignments[${i}]`));
  });
  const participations = list(o.participations, "participations").map((p, i) =>
    record(EventParticipation, p, PART_FIELDS, env, `participations[${i}]`),
  );
  const claims = list(o.claims, "claims").map((c, i) => record(Claim, c, CLAIM_FIELDS, env, `claims[${i}]`));
  const evidence = list(o.evidence, "evidence").map((e, i) => record(Evidence, e, EVIDENCE_FIELDS, env, `evidence[${i}]`));

  const seen = new Set<string>();
  for (const role of roles) {
    if (seen.has(role.meta.content_hash)) {
      throw new ValueError(`duplicate role assignment ${role.role} of ${role.entity_id} in ${role.scope_entity_id}`);
    }
    seen.add(role.meta.content_hash);
  }
  for (const rec of [...entities, ...roles, ...participations, ...claims, ...evidence]) {
    if (rec.meta.origin === "simulated") {
      throw new ValueError("simulated records belong to run namespaces, not the canonical world");
    }
  }
  validateLinks(entities, roles, participations, claims, evidence, registry);
  return { ...env, registry, entities, roles, participations, claims, evidence };
}

function roleJson(r: RoleAssignment): RoleAssignmentRecordJson {
  return {
    role: r.role,
    scope_entity_id: r.scope_entity_id,
    valid_from: r.valid_from,
    valid_to: r.valid_to,
    evidence_ids: [...r.evidence_ids],
    entity_id: r.entity_id,
    origin: r.meta.origin,
  };
}

function participationJson(p: EventParticipation): EventParticipationJson {
  return {
    event_id: p.event_id,
    participant_entity_id: p.participant_entity_id,
    participation_role: p.participation_role,
    valid_from: p.valid_from,
    valid_to: p.valid_to,
    evidence_ids: [...p.evidence_ids],
    origin: p.meta.origin,
  };
}

function claimJson(c: Claim): ClaimJson {
  return {
    claim_id: c.claim_id,
    claim_kind: c.claim_kind,
    subject_entity_id: c.subject_entity_id,
    predicate: c.predicate,
    object_entity_id: c.object_entity_id,
    value: c.value,
    variable_key: c.variable_key === null ? null : [...c.variable_key],
    evidence_ids: [...c.evidence_ids],
    assertion_status: c.assertion_status,
    valid_from: c.valid_from,
    valid_to: c.valid_to,
    conflict_group_id: c.conflict_group_id,
    origin: c.meta.origin,
  };
}

function evidenceJson(e: Evidence): EvidenceJson {
  return {
    evidence_id: e.evidence_id,
    source_hash: e.source_hash,
    source_span: [e.source_span[0], e.source_span[1]],
    availability_time: e.availability_time,
    extraction_version: e.extraction_version,
    review_status: e.review_status,
    origin: e.meta.origin,
  };
}

/** Roles that share the holder's envelope are embedded in its `world.v1` record. */
function embeddable(w: WorldBundle): { embedded: Map<string, RoleAssignment[]>; standalone: RoleAssignment[] } {
  const byId = new Map(w.entities.map((e) => [e.entity_id, e] as const));
  const embedded = new Map<string, RoleAssignment[]>();
  const standalone: RoleAssignment[] = [];
  for (const role of w.roles) {
    const holder = byId.get(role.entity_id);
    if (holder !== undefined && sameEnvelope(holder.meta, role.meta)) {
      embedded.set(role.entity_id, [...(embedded.get(role.entity_id) ?? []), role]);
    } else {
      standalone.push(role);
    }
  }
  return { embedded, standalone };
}

/** Canonical payload: embeddable roles embedded, the rest standalone. */
export function encodeWorld(w: WorldBundle): WorldPayload {
  const { embedded, standalone } = embeddable(w);
  return {
    scenario_id: w.scenario_id,
    version: w.version,
    ontology: encodeOntology(w.registry),
    entities: w.entities.map((e) => e.toJson(embedded.get(e.entity_id) ?? [])),
    role_assignments: standalone.map(roleJson),
    participations: w.participations.map(participationJson),
    claims: w.claims.map(claimJson),
    evidence: w.evidence.map(evidenceJson),
  };
}

/** Envelope origin for the stored bundle: the weakest origin present (records keep their own). */
export function bundleOrigin(w: WorldBundle): Origin {
  const present = new Set<Origin>(
    [...w.entities, ...w.roles, ...w.participations, ...w.claims, ...w.evidence].map((r) => r.meta.origin),
  );
  return ORIGIN_RANK.find((o) => present.has(o)) ?? "assumed";
}

export function worldCounts(w: WorldBundle): WorldCounts {
  return {
    world_entity_count: w.entities.length,
    agent_candidate_count: w.entities.filter(eligible).length,
    event_count: w.entities.filter((e) => e.primary_kind === "Event").length,
    role_count: w.roles.length,
    claim_count: w.claims.length,
  };
}

export function worldResponse(projectId: string, worldVersion: string, w: WorldBundle): WorldResponse {
  const { embedded } = embeddable(w);
  return {
    project_id: projectId,
    world_version: worldVersion,
    entities: w.entities.map((e) => e.toJson(embedded.get(e.entity_id) ?? [])),
    role_assignments: w.roles.map(roleJson),
    participations: w.participations.map(participationJson),
    claims: w.claims.map(claimJson),
    counts: worldCounts(w),
  };
}

export function eligibilityResponse(w: WorldBundle): EligibilityResponse {
  const entities = w.entities.map((e) => ({
    entity_id: e.entity_id,
    display_name: e.display_name,
    primary_kind: e.primary_kind,
    agent_eligible: eligible(e),
    agent_eligibility_basis: e.agent_eligibility_basis,
  }));
  return {
    world_entity_count: entities.length,
    agent_candidate_count: entities.filter((e) => e.agent_eligible).length,
    entities,
  };
}
