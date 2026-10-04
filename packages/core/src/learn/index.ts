/** Learning: transition datasets and sparse Dirichlet rows. */

export {
  ACTIVITY_STATUSES,
  buildTransitionDataset,
  checkCountData,
  checkFamilyKey,
  decodeTransition,
  decodeTransitionRecord,
  EXECUTION_STATUSES,
  familyKeyId,
  idempotencyKey,
  OBSERVATION_STATUSES,
  RECORD_KINDS,
  TRANSITION_FIELDS,
  TRANSITION_RECORD_FIELDS,
  TRANSITION_RECORD_SCHEMA_VERSION,
  TRANSITION_SCHEMA_VERSION,
  transitionRecordId,
} from "./datasets.js";
export type {
  ActivityStatus,
  CountDatum,
  ExclusionReason,
  Exclusion,
  ExecutionStatus,
  FamilyKeyLike,
  IdempotencyKey,
  ObservationStatus,
  RecordKind,
  RoundGap,
  StateSnapshot,
  Transition,
  TransitionDataset,
  TransitionDatasetOptions,
  TransitionRecord,
  TransitionSummary,
} from "./datasets.js";
export { exactRow, fitSparseRows, row, SparseRows } from "./rows.js";
export type { CountRow, PriorOverride, RowEstimate, SparseRowsFields, SparseRowsJson } from "./rows.js";
