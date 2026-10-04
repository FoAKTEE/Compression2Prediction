/** Canonical typed world: kinds, subtypes, roles, entities, events, evidence, bindings. */

export { ACTOR_KINDS, isKind, KINDS, OntologyRegistry, RoleDef, SubtypeDef } from "./kinds.js";
export type { Kind, OntologyRegistryFields, RoleDefFields, SubtypeDefFields } from "./kinds.js";
export {
  AgentBinding,
  AliasLink,
  ALIAS_STATUSES,
  ASSERTION_STATUSES,
  checkInterval,
  Claim,
  CLAIM_KINDS,
  Entity,
  EventParticipation,
  Evidence,
  inInterval,
  REVIEW_STATUSES,
  RoleAssignment,
  WORLD_SCHEMA_VERSION,
} from "./records.js";
export type {
  AgentBindingFields,
  AgentBindingJson,
  AliasLinkFields,
  AliasStatus,
  AssertionStatus,
  CandidateJson,
  ClaimFields,
  ClaimKind,
  EntityFields,
  EntityJson,
  EventParticipationFields,
  EvidenceFields,
  ReviewStatus,
  RoleAssignmentFields,
  RoleJson,
  VariableKey,
} from "./records.js";
export {
  conflictGroups,
  ELIGIBILITY_BASES,
  eligible,
  resolveIdentities,
  validateEntity,
  validateLinks,
} from "./validation.js";
