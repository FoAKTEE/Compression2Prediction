/**
 * Pure transforms from the API wire shapes to the graphs GraphPanel draws.
 *
 * The World view and the Mechanism view are built from different responses and
 * never share nodes: world entities live only in the World view, variable and
 * mechanism instances only in the Mechanism view. Nothing here touches the DOM.
 */
import type {
  Claim,
  EventParticipation,
  MechanismBinding,
  MechanismGraphResponse,
  MechanismSpec,
  Origin,
  PrimaryKind,
  VariableInstance,
  VariableKey,
  WorldEntity,
  WorldResponse,
} from "../../api/types";

// ---------------------------------------------------------------- shared

/** The two views GraphPanel offers. They are built from different responses and share no nodes. */
export type GraphMode = "world" | "mechanism";

export const ORIGINS: readonly Origin[] = ["observed", "extracted", "assumed", "simulated"];

export const PRIMARY_KINDS: readonly PrimaryKind[] = [
  "Person",
  "Organization",
  "Group",
  "Event",
  "Location",
  "Artifact",
  "Resource",
  "Topic",
];

/** The only kinds that may act as agents (guide §4.1). */
export const AGENT_KINDS: readonly PrimaryKind[] = ["Person", "Organization", "Group"];

/** One CSS class per origin, so observed, extracted, assumed, and simulated never look alike. */
export function originClass(origin: string): string {
  return (ORIGINS as readonly string[]).includes(origin) ? `origin--${origin}` : "origin--unknown";
}

/** Styling follows the canonical `primary_kind`, never the order in which kinds arrive. */
export function kindClass(kind: string): string {
  return (PRIMARY_KINDS as readonly string[]).includes(kind) ? `kind--${kind.toLowerCase()}` : "kind--unknown";
}

/** Half-open interval `[from, to)`; an unbounded end shows as infinity. */
export function formatInterval(from: number | null, to: number | null): string {
  const start = from === null ? "(−∞" : `[${from}`;
  const end = to === null ? "+∞)" : `${to})`;
  return `${start}, ${end}`;
}

// ---------------------------------------------------------------- world

export type WorldLayer = "roles" | "participation" | "claims";
export const WORLD_LAYERS: readonly WorldLayer[] = ["roles", "participation", "claims"];
export type WorldLayers = Record<WorldLayer, boolean>;

export function allLayers(): WorldLayers {
  return { roles: true, participation: true, claims: true };
}

export type WorldInput = Pick<WorldResponse, "entities" | "role_assignments" | "participations" | "claims">;

export interface EntityNode {
  id: string;
  type: "entity";
  label: string;
  entity: WorldEntity;
  primary_kind: PrimaryKind;
  origin: Origin;
}

export interface WorldEdge {
  id: string;
  source: string;
  target: string;
  layer: WorldLayer;
  /** Role name, participation role, or claim predicate. */
  label: string;
  /** Knowledge-graph claims are drawn dashed; role and participation edges are solid. */
  dashed: boolean;
  origin: Origin;
}

export interface WorldGraph {
  nodes: EntityNode[];
  edges: WorldEdge[];
}

export const entityNodeId = (entityId: string): string => `entity:${entityId}`;

/** A role resolved for display: the holder, the scope, the interval, and where it came from. */
export interface ResolvedRole {
  entity_id: string;
  role: string;
  scope_entity_id: string;
  valid_from: number | null;
  valid_to: number | null;
  evidence_ids: string[];
  origin: Origin;
}

function roleKey(role: ResolvedRole): string {
  return JSON.stringify([role.entity_id, role.role, role.scope_entity_id, role.valid_from, role.valid_to]);
}

/**
 * Standalone role records first, then roles embedded in entity records (which
 * inherit the entity's origin). The same assignment listed twice appears once.
 */
export function resolvedRoles(world: Pick<WorldResponse, "entities" | "role_assignments">): ResolvedRole[] {
  const seen = new Set<string>();
  const out: ResolvedRole[] = [];
  const add = (role: ResolvedRole) => {
    const key = roleKey(role);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(role);
  };
  for (const r of world.role_assignments ?? []) add({ ...r, evidence_ids: [...r.evidence_ids] });
  for (const entity of world.entities) {
    for (const r of entity.roles ?? []) {
      add({ ...r, entity_id: entity.entity_id, origin: entity.origin, evidence_ids: [...r.evidence_ids] });
    }
  }
  return out;
}

function roleEdge(role: ResolvedRole): WorldEdge {
  return {
    id: `role:${roleKey(role)}`,
    source: entityNodeId(role.entity_id),
    target: entityNodeId(role.scope_entity_id),
    layer: "roles",
    label: role.role,
    dashed: false,
    origin: role.origin,
  };
}

function participationEdge(p: EventParticipation): WorldEdge {
  const key = JSON.stringify([p.participant_entity_id, p.event_id, p.participation_role, p.valid_from, p.valid_to]);
  return {
    id: `participation:${key}`,
    source: entityNodeId(p.participant_entity_id),
    target: entityNodeId(p.event_id),
    layer: "participation",
    label: p.participation_role,
    dashed: false,
    origin: p.origin,
  };
}

function claimEdge(claim: Claim & { object_entity_id: string }): WorldEdge {
  return {
    id: `claim:${claim.claim_id}`,
    source: entityNodeId(claim.subject_entity_id),
    target: entityNodeId(claim.object_entity_id),
    layer: "claims",
    label: claim.predicate,
    dashed: true,
    origin: claim.origin,
  };
}

/**
 * Entities become nodes; each enabled layer contributes its own edges. Only
 * relation claims between two world entities are drawn. An edge whose ends are
 * not both world entities is dropped, so the World view never invents a node.
 */
export function toWorldGraph(world: WorldInput, layers: WorldLayers = allLayers()): WorldGraph {
  const nodes: EntityNode[] = world.entities.map((entity) => ({
    id: entityNodeId(entity.entity_id),
    type: "entity",
    label: entity.display_name,
    entity,
    primary_kind: entity.primary_kind,
    origin: entity.origin,
  }));
  const ids = new Set(nodes.map((n) => n.id));

  const edges: WorldEdge[] = [];
  if (layers.roles) edges.push(...resolvedRoles(world).map(roleEdge));
  if (layers.participation) edges.push(...(world.participations ?? []).map(participationEdge));
  if (layers.claims) {
    for (const claim of world.claims ?? []) {
      if (claim.claim_kind !== "relation" || claim.object_entity_id === null) continue;
      edges.push(claimEdge({ ...claim, object_entity_id: claim.object_entity_id }));
    }
  }
  return { nodes, edges: edges.filter((e) => ids.has(e.source) && ids.has(e.target)) };
}

/**
 * Deterministic eligibility: `primary_kind` is Person, Organization, or Group
 * AND `agent_eligible` is the boolean `true`. Strings such as `"true"` do not
 * count. Only world entities are considered, so variables and mechanisms can
 * never be candidates.
 */
export function agentCandidates(world: Pick<WorldResponse, "entities">): WorldEntity[] {
  return world.entities.filter(
    (entity) => (AGENT_KINDS as readonly string[]).includes(entity.primary_kind) && entity.agent_eligible === true,
  );
}

export interface EntityAgentCounts {
  world_entity_count: number;
  agent_candidate_count: number;
}

/** Two separate numbers: every world entity, and the eligible actors among them. */
export function counts(world: Pick<WorldResponse, "entities">): EntityAgentCounts {
  return { world_entity_count: world.entities.length, agent_candidate_count: agentCandidates(world).length };
}

export interface EntityDetail {
  entity: WorldEntity;
  roles: (ResolvedRole & { scope_label: string; interval: string })[];
  evidence_count: number;
  agent_candidate: boolean;
}

export function describeEntity(world: WorldInput, entityId: string): EntityDetail | null {
  const entity = world.entities.find((e) => e.entity_id === entityId);
  if (!entity) return null;
  const names = new Map(world.entities.map((e) => [e.entity_id, e.display_name]));
  const roles = resolvedRoles(world)
    .filter((r) => r.entity_id === entityId)
    .map((r) => ({
      ...r,
      scope_label: names.get(r.scope_entity_id) ?? r.scope_entity_id,
      interval: formatInterval(r.valid_from, r.valid_to),
    }));
  return {
    entity,
    roles,
    evidence_count: entity.evidence_ids.length,
    agent_candidate: agentCandidates({ entities: [entity] }).length === 1,
  };
}

// ---------------------------------------------------------------- mechanism

export class MechanismGraphError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MechanismGraphError";
  }
}

export interface VariableNode {
  id: string;
  type: "variable";
  /** `variable_id · entity_id · t` */
  label: string;
  key: VariableKey;
  variable: VariableInstance;
  origin: Origin;
}

export interface MechanismNode {
  id: string;
  type: "mechanism";
  label: string;
  spec: MechanismSpec;
  binding: MechanismBinding;
}

export interface MechanismEdge {
  id: string;
  source: string;
  target: string;
  direction: "input" | "output";
  port: string;
  /** Position of the port in the mechanism's declared order (0 for the single output). */
  port_index: number;
  mechanism_node_id: string;
  variable_node_id: string;
}

export interface MechanismGraph {
  nodes: (VariableNode | MechanismNode)[];
  edges: MechanismEdge[];
}

export function variableKeyOf(v: Pick<VariableInstance, "scenario_id" | "variable_id" | "entity_id" | "time_index">): VariableKey {
  return [v.scenario_id, v.variable_id, v.entity_id, v.time_index];
}

export const variableNodeId = (key: VariableKey): string => `variable:${JSON.stringify(key)}`;
export const mechanismNodeId = (bindingId: string): string => `mechanism:${bindingId}`;

export function variableLabel(key: VariableKey): string {
  return `${key[1]} · ${key[2]} · ${key[3]}`;
}

export function formatVariableKey(key: VariableKey): string {
  return `(${key[0]}, ${key[1]}, ${key[2]}, ${key[3]})`;
}

/** MVP rule (guide §5.3): many inputs, exactly one endogenous output, unique port names. */
function checkSpec(spec: MechanismSpec): void {
  if (spec.outputs.length !== 1) {
    throw new MechanismGraphError(
      `mechanism ${spec.mechanism_id} declares ${spec.outputs.length} outputs; exactly one is allowed`,
    );
  }
  const ports = [...spec.inputs, ...spec.outputs].map((p) => p.port);
  const duplicate = ports.find((port, i) => ports.indexOf(port) !== i);
  if (duplicate !== undefined) {
    throw new MechanismGraphError(`mechanism ${spec.mechanism_id} repeats the port name ${duplicate}`);
  }
}

/**
 * Builds the bipartite variable/mechanism incidence graph. Each binding becomes
 * one mechanism node; its input edges follow the spec's declared port order
 * (`port_index` 0, 1, 2, ...), whatever order the binding lists them in, and it
 * has exactly one output edge. Throws {@link MechanismGraphError} on a spec
 * with zero or several outputs, or on a binding that does not match its spec.
 */
export function toMechanismGraph(resp: Pick<MechanismGraphResponse, "variables" | "mechanisms" | "bindings">): MechanismGraph {
  const specs = new Map<string, MechanismSpec>();
  for (const spec of resp.mechanisms) {
    checkSpec(spec);
    if (specs.has(spec.mechanism_id)) {
      throw new MechanismGraphError(`mechanism ${spec.mechanism_id} is listed twice`);
    }
    specs.set(spec.mechanism_id, spec);
  }

  const variables = new Map<string, VariableNode>();
  for (const variable of resp.variables) {
    const key = variableKeyOf(variable);
    const id = variableNodeId(key);
    if (variables.has(id)) throw new MechanismGraphError(`variable instance ${formatVariableKey(key)} is listed twice`);
    variables.set(id, { id, type: "variable", label: variableLabel(key), key, variable, origin: variable.origin });
  }

  const mechanismNodes: MechanismNode[] = [];
  const edges: MechanismEdge[] = [];
  const bindingIds = new Set<string>();

  for (const binding of resp.bindings) {
    const spec = specs.get(binding.mechanism_id);
    if (!spec) throw new MechanismGraphError(`binding ${binding.binding_id} refers to unknown mechanism ${binding.mechanism_id}`);
    if (bindingIds.has(binding.binding_id)) throw new MechanismGraphError(`binding ${binding.binding_id} is listed twice`);
    bindingIds.add(binding.binding_id);
    if (binding.outputs.length !== 1) {
      throw new MechanismGraphError(`binding ${binding.binding_id} binds ${binding.outputs.length} outputs; exactly one is allowed`);
    }

    const nodeId = mechanismNodeId(binding.binding_id);
    const resolve = (declared: MechanismSpec["inputs"][number], bound: MechanismBinding["inputs"]): VariableNode => {
      const matches = bound.filter((b) => b.port === declared.port);
      if (matches.length !== 1) {
        throw new MechanismGraphError(`binding ${binding.binding_id} must bind port ${declared.port} exactly once`);
      }
      const key = matches[0]!.key;
      if (key[0] !== binding.scenario_id) {
        throw new MechanismGraphError(`binding ${binding.binding_id}: port ${declared.port} reads another scenario (${key[0]})`);
      }
      if (key[1] !== declared.variable) {
        throw new MechanismGraphError(
          `binding ${binding.binding_id}: port ${declared.port} expects ${declared.variable}, got ${key[1]}`,
        );
      }
      if (key[3] !== binding.time_index + declared.time_offset) {
        throw new MechanismGraphError(
          `binding ${binding.binding_id}: port ${declared.port} must use time ${binding.time_index + declared.time_offset}, got ${key[3]}`,
        );
      }
      const node = variables.get(variableNodeId(key));
      if (!node) throw new MechanismGraphError(`binding ${binding.binding_id}: unknown variable instance ${formatVariableKey(key)}`);
      return node;
    };

    const declaredInputs = new Set(spec.inputs.map((p) => p.port));
    const extra = binding.inputs.find((b) => !declaredInputs.has(b.port));
    if (extra) throw new MechanismGraphError(`binding ${binding.binding_id} binds undeclared input port ${extra.port}`);

    spec.inputs.forEach((declared, index) => {
      const variable = resolve(declared, binding.inputs);
      edges.push({
        id: `input:${binding.binding_id}:${declared.port}`,
        source: variable.id,
        target: nodeId,
        direction: "input",
        port: declared.port,
        port_index: index,
        mechanism_node_id: nodeId,
        variable_node_id: variable.id,
      });
    });

    const outputPort = spec.outputs[0]!;
    const written = resolve(outputPort, binding.outputs);
    edges.push({
      id: `output:${binding.binding_id}:${outputPort.port}`,
      source: nodeId,
      target: written.id,
      direction: "output",
      port: outputPort.port,
      port_index: 0,
      mechanism_node_id: nodeId,
      variable_node_id: written.id,
    });

    mechanismNodes.push({ id: nodeId, type: "mechanism", label: spec.family, spec, binding });
  }

  return { nodes: [...variables.values(), ...mechanismNodes], edges };
}

export interface MechanismPortDetail {
  port: string;
  port_index: number;
  variable_label: string;
  key: VariableKey;
}

export interface MechanismDetail {
  spec: MechanismSpec;
  binding: MechanismBinding;
  inputs: MechanismPortDetail[];
  output: MechanismPortDetail;
}

/** The selected mechanism's ports, inputs in declared order. */
export function describeMechanism(graph: MechanismGraph, nodeId: string): MechanismDetail | null {
  const node = graph.nodes.find((n): n is MechanismNode => n.type === "mechanism" && n.id === nodeId);
  if (!node) return null;
  const variables = new Map(
    graph.nodes.filter((n): n is VariableNode => n.type === "variable").map((n) => [n.id, n]),
  );
  const toDetail = (edge: MechanismEdge): MechanismPortDetail => {
    const variable = variables.get(edge.variable_node_id)!;
    return { port: edge.port, port_index: edge.port_index, variable_label: variable.label, key: variable.key };
  };
  const own = graph.edges.filter((e) => e.mechanism_node_id === nodeId);
  const inputs = own
    .filter((e) => e.direction === "input")
    .sort((a, b) => a.port_index - b.port_index)
    .map(toDetail);
  const output = own.find((e) => e.direction === "output")!;
  return { spec: node.spec, binding: node.binding, inputs, output: toDetail(output) };
}

export interface MechanismLayoutHint {
  id: string;
  /** Time runs left to right: a variable sits in its time column, a mechanism between input and output. */
  column: number;
  /** Rows within a column, centred on 0; a mechanism's inputs stack top to bottom in declared port order. */
  row: number;
}

export function mechanismLayoutHints(graph: MechanismGraph): MechanismLayoutHint[] {
  const column = new Map<string, number>(
    graph.nodes.map((n) => [n.id, n.type === "variable" ? n.key[3] : n.binding.time_index + 0.5]),
  );
  const rows = new Map<string, number>();
  const perColumn = new Map<number, number>();
  const place = (id: string): void => {
    if (rows.has(id)) return;
    const c = column.get(id) ?? 0;
    const used = perColumn.get(c) ?? 0;
    rows.set(id, used);
    perColumn.set(c, used + 1);
  };
  for (const node of graph.nodes) {
    if (node.type !== "mechanism") continue;
    const own = graph.edges.filter((e) => e.mechanism_node_id === node.id);
    own
      .filter((e) => e.direction === "input")
      .sort((a, b) => a.port_index - b.port_index)
      .forEach((e) => place(e.variable_node_id));
    place(node.id);
    own.filter((e) => e.direction === "output").forEach((e) => place(e.variable_node_id));
  }
  for (const node of graph.nodes) place(node.id);
  return graph.nodes.map((n) => {
    const c = column.get(n.id) ?? 0;
    return { id: n.id, column: c, row: (rows.get(n.id) ?? 0) - ((perColumn.get(c) ?? 1) - 1) / 2 };
  });
}
