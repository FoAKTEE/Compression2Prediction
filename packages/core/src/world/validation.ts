/**
 * World validators: kinds, eligibility, typed links, identity, conflicts.
 *
 * Links are typed foreign keys with checked path equations (memo §1.1): a role,
 * its holder, and its scope share one scenario; so do participations, claims,
 * and the evidence they cite. A participation role is a registered role scoped
 * to events that the participant's kind may hold.
 */
import { ValueError } from "../errors.js";
import { compareCodePoints } from "../store/records.js";
import type { Meta } from "../store/records.js";
import { repr, reprTuple } from "../store/repr.js";
import { ACTOR_KINDS, isKind, KINDS, OntologyRegistry } from "./kinds.js";
import { AliasLink, Claim, Entity, EventParticipation, Evidence, RoleAssignment } from "./records.js";

// Who may set agent_eligible (guide §10.4): an explicit scenario or operator
// selection, never a source document or an extraction.
export const ELIGIBILITY_BASES: readonly string[] = Object.freeze([
  "explicit_operator_selection",
  "explicit_synthetic_scenario_selection",
]);

export function eligible(entity: Entity): boolean {
  return (ACTOR_KINDS as readonly string[]).includes(entity.primary_kind) && entity.agent_eligible === true;
}

const sortedKinds = (kinds: readonly string[]): string => repr([...kinds].sort(compareCodePoints));

export function validateEntity(entity: Entity, registry: OntologyRegistry): void {
  if (!(entity instanceof Entity)) throw new ValueError(`expected Entity, got ${repr(entity)}`);
  if (!(registry instanceof OntologyRegistry)) throw new ValueError(`expected OntologyRegistry, got ${repr(registry)}`);
  const eid = entity.entity_id;
  const kind = entity.primary_kind;
  if (!isKind(kind)) throw new ValueError(`${eid}: primary_kind ${repr(kind)} is not one of ${reprTuple(KINDS)}`);
  if (entity.ontology_version !== registry.version) {
    throw new ValueError(
      `${eid}: ontology_version ${repr(entity.ontology_version)} does not match registry ${repr(registry.version)}`,
    );
  }
  for (const subtype of entity.subtypes) {
    let resolved: string;
    try {
      resolved = registry.kindOf(subtype);
    } catch (exc) {
      if (exc instanceof ValueError) throw new ValueError(`${eid}: ${exc.message}`);
      throw exc;
    }
    if (resolved !== kind) {
      throw new ValueError(
        `${eid}: subtype ${repr(subtype)} resolves to ${repr(resolved)}, not primary_kind ${repr(kind)}`,
      );
    }
  }
  if (entity.agent_eligible === true) {
    if (!(ACTOR_KINDS as readonly string[]).includes(kind)) {
      throw new ValueError(`${eid}: ${kind} entities are never agent-eligible`);
    }
    if (entity.agent_eligibility_basis === null || !ELIGIBILITY_BASES.includes(entity.agent_eligibility_basis)) {
      throw new ValueError(
        `${eid}: agent_eligibility_basis ${repr(entity.agent_eligibility_basis)} ` +
          `is not one of ${repr(ELIGIBILITY_BASES)}`,
      );
    }
    if (entity.meta.origin === "extracted") {
      throw new ValueError(`${eid}: an extracted record cannot authorize an agent`);
    }
  } else if (entity.agent_eligibility_basis !== null) {
    throw new ValueError(`${eid}: agent_eligibility_basis is set but agent_eligible is False`);
  }
}

function index<T>(
  records: Iterable<T>,
  cls: abstract new (...args: never[]) => T,
  key: (record: T) => string,
  label: string,
): Map<string, T> {
  const result = new Map<string, T>();
  for (const record of records) {
    if (!(record instanceof cls)) throw new ValueError(`expected ${cls.name}, got ${repr(record)}`);
    const ident = key(record);
    if (result.has(ident)) throw new ValueError(`duplicate ${label} id ${repr(ident)}`);
    result.set(ident, record);
  }
  return result;
}

function sameScenario(where: string, scenarioId: string, linked: Record<string, { readonly meta: Meta }>): void {
  for (const [name, record] of Object.entries(linked)) {
    if (record.meta.scenario_id !== scenarioId) {
      throw new ValueError(
        `${where}: ${name} is in scenario ${repr(record.meta.scenario_id)}, ` +
          `not ${repr(scenarioId)} (cross-scenario link)`,
      );
    }
  }
}

function lookup<T>(table: Map<string, T>, ident: string, label: string, where: string): T {
  if (!table.has(ident)) throw new ValueError(`${where}: dangling ${label} reference ${repr(ident)}`);
  return table.get(ident)!;
}

function checkEvidence(
  where: string,
  meta: Meta,
  evidenceIds: readonly string[],
  evidence: Map<string, Evidence>,
): void {
  for (const ident of evidenceIds) {
    const record = lookup(evidence, ident, "evidence", where);
    sameScenario(where, meta.scenario_id, { evidence: record });
  }
}

/** Validate every entity and every reference between world records. */
export function validateLinks(
  entities: Iterable<Entity>,
  roles: Iterable<RoleAssignment>,
  participations: Iterable<EventParticipation>,
  claims: Iterable<Claim>,
  evidence: Iterable<Evidence>,
  registry: OntologyRegistry,
): void {
  const ents = index(entities, Entity, (e) => e.entity_id, "entity");
  const evs = index(evidence, Evidence, (e) => e.evidence_id, "evidence");
  const claimIndex = index(claims, Claim, (c) => c.claim_id, "claim");

  for (const entity of ents.values()) {
    validateEntity(entity, registry);
    checkEvidence(`entity ${repr(entity.entity_id)}`, entity.meta, entity.evidence_ids, evs);
  }

  for (const role of roles) {
    if (!(role instanceof RoleAssignment)) throw new ValueError(`expected RoleAssignment, got ${repr(role)}`);
    const where = `role ${repr(role.role)} of ${repr(role.entity_id)}`;
    const holder = lookup(ents, role.entity_id, "entity", where);
    const scope = lookup(ents, role.scope_entity_id, "scope entity", where);
    sameScenario(where, role.meta.scenario_id, { entity: holder, scope });
    const definition = registry.role(role.role);
    if (!(definition.allowed_kinds as readonly string[]).includes(holder.primary_kind)) {
      throw new ValueError(
        `${where}: a ${holder.primary_kind} cannot hold role ${repr(role.role)} ` +
          `(allowed ${sortedKinds(definition.allowed_kinds)})`,
      );
    }
    if (!(definition.scope_kinds as readonly string[]).includes(scope.primary_kind)) {
      throw new ValueError(
        `${where}: role ${repr(role.role)} cannot be scoped to a ${scope.primary_kind} ` +
          `(allowed ${sortedKinds(definition.scope_kinds)})`,
      );
    }
    checkEvidence(where, role.meta, role.evidence_ids, evs);
  }

  for (const part of participations) {
    if (!(part instanceof EventParticipation)) throw new ValueError(`expected EventParticipation, got ${repr(part)}`);
    const where = `participation of ${repr(part.participant_entity_id)} in ${repr(part.event_id)}`;
    const event = lookup(ents, part.event_id, "event", where);
    const participant = lookup(ents, part.participant_entity_id, "participant", where);
    sameScenario(where, part.meta.scenario_id, { event, participant });
    if (event.primary_kind !== "Event") {
      throw new ValueError(`${where}: ${repr(part.event_id)} is a ${event.primary_kind}, not an Event`);
    }
    if (participant.primary_kind === "Event") throw new ValueError(`${where}: an Event cannot be a participant`);
    const definition = registry.role(part.participation_role);
    if (!(definition.allowed_kinds as readonly string[]).includes(participant.primary_kind)) {
      throw new ValueError(
        `${where}: a ${participant.primary_kind} cannot take part as ${repr(part.participation_role)} ` +
          `(allowed ${sortedKinds(definition.allowed_kinds)})`,
      );
    }
    if (!(definition.scope_kinds as readonly string[]).includes("Event")) {
      throw new ValueError(
        `${where}: role ${repr(part.participation_role)} is not scoped to events ` +
          `(scope ${sortedKinds(definition.scope_kinds)})`,
      );
    }
    checkEvidence(where, part.meta, part.evidence_ids, evs);
  }

  const groups = new Map<string, string>();
  for (const claim of claimIndex.values()) {
    const where = `claim ${repr(claim.claim_id)}`;
    const subject = lookup(ents, claim.subject_entity_id, "subject", where);
    sameScenario(where, claim.meta.scenario_id, { subject });
    if (claim.object_entity_id !== null) {
      const obj = lookup(ents, claim.object_entity_id, "object", where);
      sameScenario(where, claim.meta.scenario_id, { object: obj });
    }
    if (claim.variable_key !== null) {
      const [scenarioId, , entityId] = claim.variable_key;
      if (scenarioId !== claim.meta.scenario_id) {
        throw new ValueError(
          `${where}: variable_key scenario ${repr(scenarioId)} is not ${repr(claim.meta.scenario_id)} ` +
            "(cross-scenario link)",
        );
      }
      if (entityId !== claim.subject_entity_id) {
        throw new ValueError(
          `${where}: variable_key entity ${repr(entityId)} is not the subject ${repr(claim.subject_entity_id)}`,
        );
      }
    }
    checkEvidence(where, claim.meta, claim.evidence_ids, evs);
    if (claim.conflict_group_id !== null) {
      if (!groups.has(claim.conflict_group_id)) groups.set(claim.conflict_group_id, claim.meta.scenario_id);
      const first = groups.get(claim.conflict_group_id)!;
      if (first !== claim.meta.scenario_id) {
        throw new ValueError(
          `${where}: conflict group ${repr(claim.conflict_group_id)} spans scenarios ${repr(first)} ` +
            `and ${repr(claim.meta.scenario_id)}`,
        );
      }
    }
  }
}

/**
 * Map each entity ID to its canonical ID: the smallest ID among verified aliases.
 *
 * Candidate links never merge, and a shared display name is not an identity.
 * The map iterates in sorted ID order (Python string order).
 */
export function resolveIdentities(entities: Iterable<Entity>, aliases: Iterable<AliasLink>): Map<string, string> {
  const ents = index(entities, Entity, (e) => e.entity_id, "entity");
  const parent = new Map<string, string>([...ents.keys()].map((ident) => [ident, ident]));

  const find = (start: string): string => {
    let ident = start;
    while (parent.get(ident) !== ident) {
      parent.set(ident, parent.get(parent.get(ident)!)!);
      ident = parent.get(ident)!;
    }
    return ident;
  };

  for (const link of aliases) {
    if (!(link instanceof AliasLink)) throw new ValueError(`expected AliasLink, got ${repr(link)}`);
    const where = `alias ${repr(link.entity_id_a)} ~ ${repr(link.entity_id_b)}`;
    const a = lookup(ents, link.entity_id_a, "entity", where);
    const b = lookup(ents, link.entity_id_b, "entity", where);
    sameScenario(where, a.meta.scenario_id, { entity_b: b });
    if (link.status !== "verified") continue;
    if (a.primary_kind !== b.primary_kind) {
      throw new ValueError(`${where}: verified alias joins a ${a.primary_kind} and a ${b.primary_kind}`);
    }
    const rootA = find(a.entity_id);
    const rootB = find(b.entity_id);
    if (rootA !== rootB) {
      const [low, high] = compareCodePoints(rootA, rootB) < 0 ? [rootA, rootB] : [rootB, rootA];
      parent.set(high, low);
    }
  }
  return new Map([...ents.keys()].sort(compareCodePoints).map((ident) => [ident, find(ident)]));
}

/** Claims sharing a ``conflict_group_id``; all are retained, none overwritten. */
export function conflictGroups(claims: Iterable<Claim>): Map<string, readonly string[]> {
  const groups = new Map<string, string[]>();
  for (const claim of index(claims, Claim, (c) => c.claim_id, "claim").values()) {
    if (claim.conflict_group_id !== null) {
      const members = groups.get(claim.conflict_group_id) ?? [];
      members.push(claim.claim_id);
      groups.set(claim.conflict_group_id, members);
    }
  }
  return new Map(
    [...groups.keys()]
      .sort(compareCodePoints)
      .map((group) => [group, Object.freeze([...groups.get(group)!].sort(compareCodePoints))] as const),
  );
}
