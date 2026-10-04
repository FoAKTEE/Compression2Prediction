/** Package version of @c2p/core. */
export const VERSION = "0.1.0";

export { ValueError } from "./errors.js";
export { pythonJsonPair, pythonJsonString } from "./json.js";
export { fsum } from "./numeric/fsum.js";
export { Rational } from "./numeric/rational.js";
export {
  constant,
  copy,
  discard,
  fitCounts,
  forecast,
  identity,
  Kernel,
  kernelEquals,
  posterior,
  probabilityVector,
  product,
  productAll,
  Space,
  spaceEquals,
  TOL,
  UNIT,
} from "./kernels.js";
export type { Vector } from "./kernels.js";
export {
  asBool,
  asFiniteFloat,
  asHash,
  asInt,
  asLiteral,
  asOptional,
  asStr,
  asStrTuple,
  canonicalJson,
  compareCodePoints,
  contentHash,
  HASH_FIELD,
  isPlainObject,
  Meta,
  META_FIELDS,
  ORIGINS,
  recordPayload,
  replaceRecord,
  requireFields,
  seal,
  verifyHash,
} from "./store/records.js";
export type { EnvelopeFields, MetaFields, Origin, RecordClass } from "./store/records.js";
export * from "./world/index.js";
export * from "./causal/index.js";
export * from "./learn/index.js";
export * from "./evaluate/index.js";
export * from "./compress/index.js";
export { lgamma } from "./numeric/lgamma.js";
export * from "./inference/index.js";
