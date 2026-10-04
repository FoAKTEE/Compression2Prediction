/** Causal layer: variable registry, mechanism specs, templates, hypergraph, compiler. */

export { MISSING, MISSINGNESS, OWNERSHIP, resolveSpace, VariableDef, VariableRegistry } from "./registry.js";
export type { Missingness, Ownership, VariableDefFields, VariableRegistryFields } from "./registry.js";
export {
  decodeMechanismSpec,
  encodeMechanismSpec,
  MECHANISM_FIELDS,
  MECHANISM_SCHEMA_VERSION,
  MechanismSpec,
  PARAMETER_ORIGINS,
  Port,
  PORT_FIELDS,
} from "./specs.js";
export type {
  MechanismSpecFields,
  MechanismSpecJson,
  MechanismSpecOptions,
  ParameterOrigin,
  PortFields,
  PortJson,
} from "./specs.js";
export {
  BINDING_FIELDS,
  FAMILY_KEY_FIELDS,
  FamilyKey,
  familyKey,
  interfaceHash,
  SELECTORS,
  TemplateSpec,
  unroll,
} from "./templates.js";
export type { Binding, FamilyKeyFields, Selector, TemplateSpecFields, WorldView } from "./templates.js";
export {
  checkVariableKey,
  compareInstances,
  compareKeys,
  graphHash,
  incidenceGraph,
  MechanismInstance,
  parseVariableKey,
  variableKey,
  variableKeyString,
} from "./hypergraph.js";
export type {
  IncidenceGraph,
  InputIncidence,
  MechanismInstanceFields,
  OutputIncidence,
  VariableKey,
} from "./hypergraph.js";
export { Budget, compilePlan, Plan, PlanNode } from "./compiler.js";
export type { BudgetFields, CompileOptions, PlanFields, PlanNodeFields } from "./compiler.js";
