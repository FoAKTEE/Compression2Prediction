/** Simulation adapter, observer mode: recorded logs -> simulated transitions, with replay. */
export { StateAuthority } from "./authority.js";
export type { StateAuthorityJson, StateOwner } from "./authority.js";
export { MIROFISH_NO_ACTION, readMiroFishActions } from "./mirofish.js";
export type { MergedLines, MiroFishOptions, MiroFishReport, MiroFishResult, UnboundLine } from "./mirofish.js";
export {
  ACTIVATIONS,
  checkObserverLog,
  decodeObserverLine,
  decodeObserverLog,
  encodeObserverLog,
  OBSERVER_LOG_SCHEMA_VERSION,
  observerLogFromLines,
  observerLogHash,
  observerLogLines,
} from "./observerLog.js";
export type {
  ActionOutcome,
  Activation,
  FailureOutcome,
  NoActionOutcome,
  ObserverLine,
  ObserverLog,
  ObserverRound,
  Outcome,
  RoundEndLine,
  RoundStartLine,
  RunEndLine,
  RunStartLine,
} from "./observerLog.js";
export { checkReplay, replay } from "./replay.js";
export type { ReplayStep } from "./replay.js";
export { ACTIVITY_STATE_VERSION, activityStateMap, checkSnapshot, checkStateMap } from "./stateMap.js";
export type { StateMap, StepContext, StepOutcome } from "./stateMap.js";
export {
  appendTransitions,
  fromRunRow,
  observerManifest,
  readTransitions,
  RUN_ROW_FIELDS,
  stepStatuses,
  toRunRow,
  toTransitionRecords,
} from "./transitions.js";
export type { ObserverManifestFields, Statuses, TransitionOptions } from "./transitions.js";
