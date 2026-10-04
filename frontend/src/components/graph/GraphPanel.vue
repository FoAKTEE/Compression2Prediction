<script setup lang="ts">
import { select, zoom, zoomIdentity, type ZoomBehavior } from "d3";
import { computed, onBeforeUnmount, ref, shallowRef, useId, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { MechanismGraphResponse, Origin, WorldResponse } from "../../api/types";
import StateNotice from "../StateNotice.vue";
import { layoutGraph, type Layout } from "./layout";
import {
  ORIGINS,
  PRIMARY_KINDS,
  WORLD_LAYERS,
  agentCandidates,
  allLayers,
  counts,
  describeEntity,
  describeMechanism,
  entityNodeId,
  formatVariableKey,
  kindClass,
  mechanismLayoutHints,
  originClass,
  toMechanismGraph,
  toWorldGraph,
  type GraphMode,
  type MechanismGraph,
  type VariableNode,
  type WorldGraph,
  type WorldLayer,
  type WorldLayers,
} from "./model";
import { circlePath, kindShapePath, squarePath, trimSegment } from "./shapes";

const props = withDefaults(
  defineProps<{
    world?: WorldResponse | null;
    mechanism?: MechanismGraphResponse | null;
    initialMode?: GraphMode;
    loading?: boolean;
  }>(),
  { world: null, mechanism: null, initialMode: "world", loading: false },
);

const { t } = useI18n();
const uid = useId();
const arrowId = `${uid}-arrow`;
const arrowStrongId = `${uid}-arrow-strong`;

const MODES: readonly GraphMode[] = ["world", "mechanism"];
const ENTITY_R = 15;
const VARIABLE_R = 12;
const MECHANISM_R = 12;

const mode = ref<GraphMode>(props.initialMode);
const layers = ref<WorldLayers>(allLayers());
const selectedId = ref<string | null>(null);

// ---------------------------------------------------------------- graphs

/** All layers, used for the layout, so toggling a layer never moves a node. */
const fullWorldGraph = computed<WorldGraph | null>(() => (props.world ? toWorldGraph(props.world) : null));
const worldGraph = computed<WorldGraph | null>(() => (props.world ? toWorldGraph(props.world, layers.value) : null));

const mechanismResult = computed<{ graph: MechanismGraph | null; error: string | null }>(() => {
  if (!props.mechanism) return { graph: null, error: null };
  try {
    return { graph: toMechanismGraph(props.mechanism), error: null };
  } catch (error) {
    return { graph: null, error: error instanceof Error ? error.message : String(error) };
  }
});

const candidates = computed(() => (props.world ? agentCandidates(props.world) : []));
const entityCounts = computed(() => (props.world ? counts(props.world) : null));

type LabelPlacement = "below" | "above" | "left" | "right";

const LABEL_ANCHOR: Record<LabelPlacement, "middle" | "end" | "start"> = {
  below: "middle",
  above: "middle",
  left: "end",
  right: "start",
};

function labelPosition(placement: LabelPlacement, r: number): { x: number; y: number } {
  switch (placement) {
    case "above":
      return { x: 0, y: -(r + 11) };
    case "left":
      return { x: -(r + 10), y: 4 };
    case "right":
      return { x: r + 10, y: 4 };
    default:
      return { x: 0, y: r + 18 };
  }
}

interface ViewNode {
  id: string;
  type: "entity" | "variable" | "mechanism";
  label: string;
  labelPlacement: LabelPlacement;
  ariaLabel: string;
  path: string;
  r: number;
  classes: string[];
  origin: Origin | null;
}

interface ViewEdge {
  id: string;
  source: string;
  target: string;
  label: string;
  classes: string[];
  strong: boolean;
  portIndex: number | null;
}

const worldView = computed(() => {
  const graph = worldGraph.value;
  const full = fullWorldGraph.value;
  if (!graph || !full || graph.nodes.length === 0) return null;
  const candidateIds = new Set(candidates.value.map((e) => entityNodeId(e.entity_id)));
  const nodes: ViewNode[] = graph.nodes.map((n) => ({
    id: n.id,
    type: "entity",
    label: n.label,
    labelPlacement: "below",
    ariaLabel: t("graph.nodeLabel.entity", { kind: n.primary_kind, name: n.label }),
    path: kindShapePath(n.primary_kind, ENTITY_R),
    r: ENTITY_R,
    classes: [kindClass(n.primary_kind), originClass(n.origin), ...(candidateIds.has(n.id) ? ["is-candidate"] : [])],
    origin: n.origin,
  }));
  const edges: ViewEdge[] = graph.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    label: e.label,
    classes: [`edge--${e.layer}`, ...(e.dashed ? ["edge--dashed"] : [])],
    strong: false,
    portIndex: null,
  }));
  const layout = layoutGraph(full.nodes, full.edges);
  return { nodes, edges, layout };
});

const mechanismView = computed(() => {
  const graph = mechanismResult.value.graph;
  if (!graph || graph.nodes.length === 0) return null;
  // Long variable labels go outside the flow: sources to the left, sinks to the right.
  const read = new Set(graph.edges.filter((e) => e.direction === "input").map((e) => e.variable_node_id));
  const written = new Set(graph.edges.filter((e) => e.direction === "output").map((e) => e.variable_node_id));
  const placement = (id: string): LabelPlacement =>
    read.has(id) && !written.has(id) ? "left" : written.has(id) && !read.has(id) ? "right" : "below";
  const nodes: ViewNode[] = graph.nodes.map((n) =>
    n.type === "variable"
      ? {
          id: n.id,
          type: "variable",
          label: n.label,
          labelPlacement: placement(n.id),
          ariaLabel: t("graph.nodeLabel.variable", { name: n.label }),
          path: circlePath(VARIABLE_R),
          r: VARIABLE_R,
          classes: ["node--variable", originClass(n.origin)],
          origin: n.origin,
        }
      : {
          id: n.id,
          type: "mechanism",
          label: n.label,
          labelPlacement: "above",
          ariaLabel: t("graph.nodeLabel.mechanism", { name: n.label }),
          path: squarePath(MECHANISM_R),
          r: MECHANISM_R,
          classes: ["node--mechanism"],
          origin: null,
        },
  );
  const edges: ViewEdge[] = graph.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    label: e.direction === "input" ? `${e.port_index} · ${e.port}` : e.port,
    classes: [`edge--${e.direction}`],
    strong: e.direction === "output",
    portIndex: e.direction === "input" ? e.port_index : null,
  }));
  const layout = layoutGraph(mechanismLayoutHints(graph), graph.edges, {
    columnWidth: 320,
    rowHeight: 104,
    linkDistance: 170,
    charge: -500,
    collideRadius: 46,
    padding: { x: 300, y: 60 },
    minSize: { width: 900, height: 420 },
  });
  return { nodes, edges, layout };
});

const view = computed(() => (mode.value === "world" ? worldView.value : mechanismView.value));

interface PlacedEdge extends ViewEdge {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  lx: number;
  ly: number;
}

function placed(layout: Layout, nodes: ViewNode[], edges: ViewEdge[]) {
  const radius = new Map(nodes.map((n) => [n.id, n.r]));
  const placedNodes = nodes.map((n) => {
    const label = labelPosition(n.labelPlacement, n.r);
    return {
      ...n,
      ...(layout.positions[n.id] ?? { x: 0, y: 0 }),
      labelX: label.x,
      labelY: label.y,
      labelAnchor: LABEL_ANCHOR[n.labelPlacement],
    };
  });
  const placedEdges: PlacedEdge[] = edges.flatMap((e) => {
    const a = layout.positions[e.source];
    const b = layout.positions[e.target];
    if (!a || !b || e.source === e.target) return [];
    const seg = trimSegment(a, b, (radius.get(e.source) ?? 0) + 3, (radius.get(e.target) ?? 0) + 8);
    return [{ ...e, ...seg, lx: (a.x + b.x) / 2, ly: (a.y + b.y) / 2 - 5 }];
  });
  return { nodes: placedNodes, edges: placedEdges };
}

const scene = computed(() => {
  const v = view.value;
  if (!v) return null;
  const { x, y, width, height } = v.layout.viewBox;
  return { ...placed(v.layout, v.nodes, v.edges), viewBox: `${x} ${y} ${width} ${height}` };
});

const canvasLabel = computed(() =>
  t("graph.canvas", {
    view: mode.value === "world" ? t("graph.modes.world") : t("graph.modes.mechanism"),
    nodes: scene.value?.nodes.length ?? 0,
    edges: scene.value?.edges.length ?? 0,
  }),
);

const emptyState = computed(() => {
  if (props.loading) return { variant: "loading" as const, title: t("graph.loading"), body: undefined };
  if (mode.value === "mechanism" && mechanismResult.value.error) {
    return { variant: "error" as const, title: t("graph.invalid.title"), body: mechanismResult.value.error };
  }
  if (scene.value) return null;
  const key = mode.value === "world" ? "world" : "mechanism";
  return { variant: "empty" as const, title: t(`graph.empty.${key}.title`), body: t(`graph.empty.${key}.body`) };
});

// ---------------------------------------------------------------- selection and details

function setMode(next: GraphMode): void {
  if (mode.value === next) return;
  mode.value = next;
  selectedId.value = null;
}

function selectNode(id: string): void {
  selectedId.value = id;
}

function selectCandidate(entityId: string): void {
  setMode("world");
  selectedId.value = entityNodeId(entityId);
}

function setLayer(layer: WorldLayer, on: boolean): void {
  layers.value = { ...layers.value, [layer]: on };
}

const entityDetail = computed(() => {
  const id = selectedId.value;
  if (mode.value !== "world" || !id || !props.world || !id.startsWith("entity:")) return null;
  return describeEntity(props.world, id.slice("entity:".length));
});

const mechanismDetail = computed(() => {
  const graph = mechanismResult.value.graph;
  const id = selectedId.value;
  if (mode.value !== "mechanism" || !graph || !id) return null;
  return describeMechanism(graph, id);
});

const variableDetail = computed<VariableNode | null>(() => {
  const graph = mechanismResult.value.graph;
  const id = selectedId.value;
  if (mode.value !== "mechanism" || !graph || !id) return null;
  return graph.nodes.find((n): n is VariableNode => n.type === "variable" && n.id === id) ?? null;
});

const hasDetail = computed(() => Boolean(entityDetail.value || mechanismDetail.value || variableDetail.value));

// ---------------------------------------------------------------- zoom and pan (real browsers only)

const svgRef = ref<SVGSVGElement | null>(null);
const zoomTransform = ref<string | undefined>(undefined);
const zoomEnabled = ref(false);
const zoomBehavior = shallowRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);

/** d3-zoom needs real layout (a sized, rendered SVG); test DOMs report zero size and get a static graph. */
function supportsZoom(el: SVGSVGElement): boolean {
  return typeof el.getScreenCTM === "function" && el.getBoundingClientRect().width > 0;
}

function detachZoom(el: SVGSVGElement | null): void {
  if (el && zoomBehavior.value) select(el).on(".zoom", null);
  zoomBehavior.value = null;
  zoomEnabled.value = false;
  zoomTransform.value = undefined;
}

watch(
  svgRef,
  (el, previous) => {
    detachZoom(previous ?? null);
    if (!el || !supportsZoom(el)) return;
    const behavior = zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.4, 4])
      // Plain wheel scrolls the page; Ctrl/Cmd + wheel (and pinch) zooms; drags pan.
      .filter((event: MouseEvent | WheelEvent) =>
        event.type === "wheel" ? event.ctrlKey || event.metaKey : !event.ctrlKey && !event.button,
      )
      .on("zoom", (event: { transform: { toString(): string } }) => {
        zoomTransform.value = event.transform.toString();
      });
    select(el).call(behavior).on("dblclick.zoom", null);
    zoomBehavior.value = behavior;
    zoomEnabled.value = true;
  },
  { flush: "post" },
);

function zoomBy(factor: number): void {
  if (svgRef.value && zoomBehavior.value) select(svgRef.value).call(zoomBehavior.value.scaleBy, factor);
}

function resetZoom(): void {
  if (svgRef.value && zoomBehavior.value) select(svgRef.value).call(zoomBehavior.value.transform, zoomIdentity);
}

watch(mode, () => resetZoom());
onBeforeUnmount(() => detachZoom(svgRef.value));

// ---------------------------------------------------------------- legend

const legendKinds = computed(() =>
  PRIMARY_KINDS.map((kind) => ({ kind, path: kindShapePath(kind, 7), cls: kindClass(kind) })),
);
const legendOrigins = ORIGINS.map((origin) => ({ origin, cls: originClass(origin) }));
const legendNodeShapes = { variable: circlePath(6), mechanism: squarePath(6.5) };
</script>

<template>
  <div class="graph-panel" data-testid="graph-panel" :data-mode="mode">
    <div class="graph-panel__toolbar">
      <div class="graph-panel__modes" role="group" :aria-label="t('graph.modes.label')">
        <button
          v-for="m in MODES"
          :key="m"
          type="button"
          class="graph-panel__mode"
          :class="{ 'is-active': mode === m }"
          :aria-pressed="mode === m"
          :data-testid="`mode-${m}`"
          @click="setMode(m)"
        >
          {{ t(`graph.modes.${m}`) }}
        </button>
      </div>

      <fieldset v-if="mode === 'world' && world" class="graph-panel__layers" data-testid="layer-toggles">
        <legend class="sr-only">{{ t("graph.layers.label") }}</legend>
        <label v-for="layer in WORLD_LAYERS" :key="layer" class="graph-panel__layer" :class="`layer--${layer}`">
          <input
            type="checkbox"
            :checked="layers[layer]"
            :data-testid="`layer-${layer}`"
            @change="setLayer(layer, ($event.target as HTMLInputElement).checked)"
          />
          <span class="graph-panel__layer-swatch" aria-hidden="true"></span>
          <span>{{ t(`graph.layers.${layer}`) }}</span>
        </label>
      </fieldset>

      <div v-if="zoomEnabled && scene" class="graph-panel__zoom" data-testid="zoom-controls">
        <button type="button" class="graph-panel__icon-btn" :aria-label="t('graph.zoom.in')" @click="zoomBy(1.3)">+</button>
        <button type="button" class="graph-panel__icon-btn" :aria-label="t('graph.zoom.out')" @click="zoomBy(1 / 1.3)">
          −
        </button>
        <button type="button" class="graph-panel__icon-btn graph-panel__icon-btn--text" @click="resetZoom">
          {{ t("graph.zoom.reset") }}
        </button>
      </div>
    </div>

    <div class="graph-panel__body">
      <div class="graph-panel__main">
        <StateNotice
          v-if="emptyState"
          :variant="emptyState.variant"
          :title="emptyState.title"
          :body="emptyState.body"
          data-testid="graph-state"
        />
        <div v-else-if="scene" class="graph-panel__figure">
          <div class="graph-panel__canvas" data-testid="graph-canvas">
            <svg
              ref="svgRef"
              class="graph-panel__svg"
              :viewBox="scene.viewBox"
              role="group"
              :aria-label="canvasLabel"
              :data-mode="mode"
            >
              <defs>
                <marker :id="arrowId" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" markerUnits="userSpaceOnUse" orient="auto">
                  <path class="marker" d="M 0 1 L 9 5 L 0 9 Z" />
                </marker>
                <marker :id="arrowStrongId" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto">
                  <path class="marker marker--strong" d="M 0 1 L 9 5 L 0 9 Z" />
                </marker>
              </defs>
              <g :transform="zoomTransform">
                <g class="edges">
                  <g
                    v-for="edge in scene.edges"
                    :key="edge.id"
                    class="edge"
                    :class="edge.classes"
                    data-testid="graph-edge"
                    :data-port-index="edge.portIndex ?? undefined"
                  >
                    <line
                      :x1="edge.x1"
                      :y1="edge.y1"
                      :x2="edge.x2"
                      :y2="edge.y2"
                      :marker-end="`url(#${edge.strong ? arrowStrongId : arrowId})`"
                    />
                    <text class="edge__label" :x="edge.lx" :y="edge.ly" text-anchor="middle">{{ edge.label }}</text>
                  </g>
                </g>
                <g class="nodes">
                  <g
                    v-for="node in scene.nodes"
                    :key="node.id"
                    class="node"
                    :class="[...node.classes, { 'is-selected': selectedId === node.id }]"
                    :transform="`translate(${node.x} ${node.y})`"
                    tabindex="0"
                    role="button"
                    :aria-label="node.ariaLabel"
                    :aria-pressed="selectedId === node.id"
                    data-testid="graph-node"
                    :data-node-id="node.id"
                    :data-node-type="node.type"
                    @click="selectNode(node.id)"
                    @keydown.enter.prevent="selectNode(node.id)"
                    @keydown.space.prevent="selectNode(node.id)"
                    @keydown.esc="selectedId = null"
                  >
                    <circle class="node__focus" :r="node.r + 10" />
                    <circle v-if="node.origin" class="node__halo" :r="node.r + 5" />
                    <path class="node__glyph" :d="node.path" />
                    <text class="node__label" :x="node.labelX" :y="node.labelY" :text-anchor="node.labelAnchor">{{
                      node.label
                    }}</text>
                  </g>
                </g>
              </g>
            </svg>
          </div>
          <p v-if="zoomEnabled" class="graph-panel__hint">{{ t("graph.zoom.hint") }}</p>
        </div>

        <section class="graph-panel__legend" :aria-label="t('graph.legend.label')" data-testid="graph-legend">
          <div class="legend__group">
            <h3 class="eyebrow">{{ mode === "world" ? t("graph.legend.kinds") : t("graph.legend.nodes") }}</h3>
            <ul v-if="mode === 'world'" class="legend__list">
              <li v-for="item in legendKinds" :key="item.kind" class="legend__item" :data-kind="item.kind">
                <svg class="legend__swatch" viewBox="-10 -10 20 20" aria-hidden="true">
                  <path class="node__glyph" :class="item.cls" :d="item.path" />
                </svg>
                {{ t(`graph.kinds.${item.kind}`) }}
              </li>
            </ul>
            <ul v-else class="legend__list">
              <li class="legend__item">
                <svg class="legend__swatch node--variable" viewBox="-10 -10 20 20" aria-hidden="true">
                  <path class="node__glyph" :d="legendNodeShapes.variable" />
                </svg>
                {{ t("graph.legend.variable") }}
              </li>
              <li class="legend__item">
                <svg class="legend__swatch node--mechanism" viewBox="-10 -10 20 20" aria-hidden="true">
                  <path class="node__glyph" :d="legendNodeShapes.mechanism" />
                </svg>
                {{ t("graph.legend.mechanism") }}
              </li>
            </ul>
          </div>
          <div class="legend__group">
            <h3 class="eyebrow">{{ t("graph.legend.origins") }}</h3>
            <ul class="legend__list">
              <li v-for="item in legendOrigins" :key="item.origin" class="legend__item" :data-origin="item.origin">
                <svg class="legend__swatch" :class="item.cls" viewBox="-10 -10 20 20" aria-hidden="true">
                  <circle class="node__halo" r="7.5" />
                </svg>
                {{ t(`graph.origins.${item.origin}`) }}
              </li>
            </ul>
          </div>
          <div class="legend__group">
            <h3 class="eyebrow">{{ t("graph.legend.edges") }}</h3>
            <ul v-if="mode === 'world'" class="legend__list">
              <li class="legend__item edge--roles">
                <svg class="legend__line" viewBox="0 0 28 8" aria-hidden="true"><line x1="1" y1="4" x2="27" y2="4" /></svg>
                {{ t("graph.legend.roleEdge") }}
              </li>
              <li class="legend__item edge--participation">
                <svg class="legend__line" viewBox="0 0 28 8" aria-hidden="true"><line x1="1" y1="4" x2="27" y2="4" /></svg>
                {{ t("graph.legend.participationEdge") }}
              </li>
              <li class="legend__item edge--claims edge--dashed">
                <svg class="legend__line" viewBox="0 0 28 8" aria-hidden="true"><line x1="1" y1="4" x2="27" y2="4" /></svg>
                {{ t("graph.legend.claimEdge") }}
              </li>
            </ul>
            <ul v-else class="legend__list">
              <li class="legend__item edge--input">
                <svg class="legend__line" viewBox="0 0 28 8" aria-hidden="true"><line x1="1" y1="4" x2="27" y2="4" /></svg>
                {{ t("graph.legend.inputEdge") }}
              </li>
              <li class="legend__item edge--output">
                <svg class="legend__line" viewBox="0 0 28 8" aria-hidden="true"><line x1="1" y1="4" x2="27" y2="4" /></svg>
                {{ t("graph.legend.outputEdge") }}
              </li>
            </ul>
          </div>
        </section>
      </div>

      <aside class="graph-panel__side">
        <section class="graph-panel__card" data-testid="graph-detail" :aria-label="t('graph.detail.heading')">
          <header class="card__header">
            <h3 class="eyebrow">{{ t("graph.detail.heading") }}</h3>
            <button
              v-if="hasDetail"
              type="button"
              class="graph-panel__icon-btn graph-panel__icon-btn--text"
              data-testid="clear-selection"
              @click="selectedId = null"
            >
              {{ t("graph.detail.clear") }}
            </button>
          </header>

          <div v-if="entityDetail" class="detail" data-detail="entity">
            <p class="detail__type">{{ t("graph.detail.types.entity") }}</p>
            <p class="detail__title">{{ entityDetail.entity.display_name }}</p>
            <dl class="detail__list">
              <dt>{{ t("graph.detail.id") }}</dt>
              <dd class="mono">{{ entityDetail.entity.entity_id }}</dd>
              <dt>{{ t("graph.detail.kind") }}</dt>
              <dd class="mono" data-testid="detail-kind">{{ entityDetail.entity.primary_kind }}</dd>
              <dt>{{ t("graph.detail.subtypes") }}</dt>
              <dd class="mono">{{ entityDetail.entity.subtypes.join(", ") || t("graph.detail.none") }}</dd>
              <dt>{{ t("graph.detail.origin") }}</dt>
              <dd>
                <span class="origin-tag" :class="originClass(entityDetail.entity.origin)" data-testid="detail-origin">
                  {{ entityDetail.entity.origin }}
                </span>
              </dd>
              <dt>{{ t("graph.detail.evidence") }}</dt>
              <dd data-testid="detail-evidence">
                {{ t("graph.detail.evidenceCount", { count: entityDetail.evidence_count }, entityDetail.evidence_count) }}
              </dd>
              <dt>{{ t("graph.detail.agentCandidate") }}</dt>
              <dd>{{ entityDetail.agent_candidate ? t("graph.detail.yes") : t("graph.detail.no") }}</dd>
            </dl>
            <p class="detail__sub">{{ t("graph.detail.roles") }}</p>
            <ul v-if="entityDetail.roles.length" class="detail__roles" data-testid="detail-roles">
              <li v-for="role in entityDetail.roles" :key="`${role.role}|${role.scope_entity_id}|${role.interval}`">
                <span>{{ t("graph.detail.roleIn", { role: role.role, scope: role.scope_label }) }}</span>
                <span class="mono detail__interval">{{ role.interval }}</span>
                <span class="origin-tag" :class="originClass(role.origin)">{{ role.origin }}</span>
              </li>
            </ul>
            <p v-else class="detail__muted">{{ t("graph.detail.none") }}</p>
          </div>

          <div v-else-if="mechanismDetail" class="detail" data-detail="mechanism">
            <p class="detail__type">{{ t("graph.detail.types.mechanism") }}</p>
            <p class="detail__title mono">{{ mechanismDetail.spec.mechanism_id }}</p>
            <dl class="detail__list">
              <dt>{{ t("graph.detail.family") }}</dt>
              <dd class="mono" data-testid="detail-family">{{ mechanismDetail.spec.family }}</dd>
            </dl>
            <p class="detail__sub">{{ t("graph.detail.inputs") }}</p>
            <ol class="detail__ports" data-testid="detail-inputs">
              <li v-for="input in mechanismDetail.inputs" :key="input.port" :data-port="input.port">
                <span class="mono detail__port">{{ input.port_index }} · {{ input.port }}</span>
                <span class="mono detail__var">{{ input.variable_label }}</span>
              </li>
            </ol>
            <p class="detail__sub">{{ t("graph.detail.output") }}</p>
            <p class="detail__ports-single" data-testid="detail-output">
              <span class="mono detail__port">{{ mechanismDetail.output.port }}</span>
              <span class="mono detail__var">{{ mechanismDetail.output.variable_label }}</span>
            </p>
            <dl class="detail__list">
              <dt>{{ t("graph.detail.kernelRef") }}</dt>
              <dd class="mono">{{ mechanismDetail.spec.kernel_ref }}</dd>
              <dt>{{ t("graph.detail.causalBasis") }}</dt>
              <dd class="mono">{{ mechanismDetail.spec.causal_basis }}</dd>
              <dt>{{ t("graph.detail.parameterOrigin") }}</dt>
              <dd class="mono">{{ mechanismDetail.spec.parameter_origin }}</dd>
              <dt>{{ t("graph.detail.validationStatus") }}</dt>
              <dd class="mono">{{ mechanismDetail.spec.validation_status }}</dd>
            </dl>
          </div>

          <div v-else-if="variableDetail" class="detail" data-detail="variable">
            <p class="detail__type">{{ t("graph.detail.types.variable") }}</p>
            <p class="detail__title mono">{{ variableDetail.label }}</p>
            <dl class="detail__list">
              <dt>{{ t("graph.detail.key") }}</dt>
              <dd class="mono" data-testid="detail-key">{{ formatVariableKey(variableDetail.key) }}</dd>
              <dt>{{ t("graph.detail.domain") }}</dt>
              <dd class="mono" data-testid="detail-domain">
                {{ variableDetail.variable.domain.name }}: {{ "{" + variableDetail.variable.domain.values.join(", ") + "}" }}
              </dd>
              <dt>{{ t("graph.detail.origin") }}</dt>
              <dd>
                <span class="origin-tag" :class="originClass(variableDetail.origin)">{{ variableDetail.origin }}</span>
              </dd>
            </dl>
          </div>

          <p v-else class="detail__muted">{{ t("graph.detail.hint") }}</p>
        </section>

        <section
          v-if="world && entityCounts"
          class="graph-panel__card"
          data-testid="agent-candidates"
          :aria-label="t('graph.agents.heading')"
        >
          <h3 class="eyebrow">{{ t("graph.agents.heading") }}</h3>
          <div class="agents__counts">
            <p class="agents__count" data-testid="world-entity-count">
              <span class="agents__number">{{ entityCounts.world_entity_count }}</span>
              <span class="agents__label">{{ t("graph.agents.worldEntities") }}</span>
            </p>
            <p class="agents__count" data-testid="agent-candidate-count">
              <span class="agents__number">{{ entityCounts.agent_candidate_count }}</span>
              <span class="agents__label">{{ t("graph.agents.candidates") }}</span>
            </p>
          </div>
          <ul v-if="candidates.length" class="agents__list" data-testid="agent-list">
            <li v-for="entity in candidates" :key="entity.entity_id" :data-entity-id="entity.entity_id">
              <button type="button" class="agents__item" @click="selectCandidate(entity.entity_id)">
                <span>{{ entity.display_name }}</span>
                <span class="mono agents__kind">{{ entity.primary_kind }}</span>
              </button>
            </li>
          </ul>
          <p v-else class="detail__muted">{{ t("graph.agents.none") }}</p>
          <p class="agents__rule">{{ t("graph.agents.rule") }}</p>
        </section>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.graph-panel {
  display: grid;
  gap: var(--c2p-space-4);
  min-width: 0;
}

/* Toolbar: mode toggle, layer toggles, zoom controls */
.graph-panel__toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--c2p-space-3) var(--c2p-space-4);
  min-width: 0;
}

.graph-panel__modes {
  display: inline-flex;
  border: var(--c2p-rule-width) solid var(--c2p-rule-strong);
  border-radius: var(--c2p-radius);
}

.graph-panel__mode {
  min-height: 2.25rem;
  padding: 0 var(--c2p-space-4);
  border: 0;
  background: transparent;
  font-family: var(--c2p-font-mono);
  font-size: var(--c2p-text-sm);
  letter-spacing: var(--c2p-tracking-mono);
  cursor: pointer;
}

.graph-panel__mode + .graph-panel__mode {
  border-left: var(--c2p-rule-width) solid var(--c2p-rule-strong);
}

.graph-panel__mode.is-active {
  background: var(--c2p-ink);
  color: var(--c2p-ink-contrast);
}

.graph-panel__layers {
  display: flex;
  flex-wrap: wrap;
  gap: var(--c2p-space-2) var(--c2p-space-4);
  margin: 0;
  padding: 0;
  border: 0;
  min-width: 0;
}

.graph-panel__layer {
  display: inline-flex;
  align-items: center;
  gap: var(--c2p-space-2);
  font-size: var(--c2p-text-sm);
  color: var(--c2p-text-muted);
  cursor: pointer;
}

.graph-panel__layer input {
  margin: 0;
  accent-color: var(--c2p-ink);
}

.graph-panel__layer-swatch {
  width: 1.25rem;
  border-top: 2px solid var(--c2p-text-muted);
}

.layer--participation .graph-panel__layer-swatch {
  border-top-color: var(--c2p-kind-event);
}

.layer--claims .graph-panel__layer-swatch {
  border-top-style: dashed;
}

.graph-panel__zoom {
  display: inline-flex;
  gap: var(--c2p-space-1);
  margin-left: auto;
}

.graph-panel__icon-btn {
  min-width: 2rem;
  min-height: 2rem;
  padding: 0 var(--c2p-space-2);
  border: var(--c2p-rule-width) solid var(--c2p-rule);
  border-radius: var(--c2p-radius);
  background: transparent;
  font-family: var(--c2p-font-mono);
  font-size: var(--c2p-text-sm);
  cursor: pointer;
}

.graph-panel__icon-btn:hover {
  border-color: var(--c2p-rule-strong);
}

.graph-panel__icon-btn--text {
  font-size: var(--c2p-text-xs);
  letter-spacing: var(--c2p-tracking-mono);
}

/* Body: canvas and legend on the left, details and agents on the right */
.graph-panel__body {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 19rem);
  gap: var(--c2p-space-4);
  align-items: start;
  min-width: 0;
}

@media (max-width: 56rem) {
  .graph-panel__body {
    grid-template-columns: minmax(0, 1fr);
  }
}

.graph-panel__main,
.graph-panel__side {
  display: grid;
  gap: var(--c2p-space-4);
  min-width: 0;
}

/* The canvas scrolls inside itself on narrow screens; the page never does. */
.graph-panel__canvas {
  min-width: 0;
  overflow: auto;
  border: var(--c2p-rule-width) solid var(--c2p-rule);
  border-radius: var(--c2p-radius);
  background-color: var(--c2p-surface);
  background-image: radial-gradient(var(--c2p-rule) 1px, transparent 1px);
  background-size: 1.25rem 1.25rem;
}

.graph-panel__svg {
  display: block;
  width: 100%;
  min-width: 40rem;
  max-width: none;
  height: clamp(20rem, 44vw, 28rem);
  touch-action: none;
}

/* Variable labels are long; keep them legible and let the canvas scroll instead of shrinking them. */
.graph-panel__svg[data-mode="mechanism"] {
  min-width: 44rem;
}

.graph-panel__figure {
  display: grid;
  gap: var(--c2p-space-2);
  min-width: 0;
}

.graph-panel__hint {
  color: var(--c2p-text-faint);
  font-size: var(--c2p-text-xs);
  text-align: right;
}

/* Edges (and their legend samples) */
.edge line,
.legend__line line {
  stroke: var(--c2p-text-muted);
  stroke-width: 1.25;
  fill: none;
}

.legend__line line {
  stroke-width: 2;
}

.edge--participation line {
  stroke: var(--c2p-kind-event);
  stroke-width: 2;
}

.edge--dashed line {
  stroke-dasharray: 6 4;
}

.edge--output line {
  stroke: var(--c2p-ink);
  stroke-width: 2;
}

.marker {
  fill: var(--c2p-text-muted);
}

.marker--strong {
  fill: var(--c2p-ink);
}

.edge__label,
.node__label {
  font-family: var(--c2p-font-mono);
  paint-order: stroke;
  stroke: var(--c2p-surface);
  stroke-width: 3px;
  stroke-linejoin: round;
}

.edge__label {
  fill: var(--c2p-text-muted);
  font-size: 11px;
}

.node__label {
  fill: var(--c2p-text);
  font-size: 12px;
}

.is-candidate .node__label {
  font-weight: 700;
}

/* Nodes: shape and fill by kind, halo by origin */
.node {
  cursor: pointer;
  outline: none;
}

.node__glyph {
  fill: var(--kind-color, var(--c2p-text-faint));
  stroke: var(--c2p-text);
  stroke-width: 1;
}

.kind--person {
  --kind-color: var(--c2p-kind-person);
}
.kind--organization {
  --kind-color: var(--c2p-kind-organization);
}
.kind--group {
  --kind-color: var(--c2p-kind-group);
}
.kind--event {
  --kind-color: var(--c2p-kind-event);
}
.kind--location {
  --kind-color: var(--c2p-kind-location);
}
.kind--artifact {
  --kind-color: var(--c2p-kind-artifact);
}
.kind--resource {
  --kind-color: var(--c2p-kind-resource);
}
.kind--topic {
  --kind-color: var(--c2p-kind-topic);
}

.node--variable .node__glyph {
  fill: var(--c2p-bg);
  stroke: var(--c2p-ink);
  stroke-width: 1.5;
}

.node--mechanism .node__glyph {
  fill: var(--c2p-ink);
  stroke: var(--c2p-ink);
}

.node__halo {
  fill: none;
  stroke: var(--c2p-text-muted);
  stroke-width: 1.5;
  stroke-linecap: round;
}

.origin--observed .node__halo {
  stroke-dasharray: none;
}
.origin--extracted .node__halo {
  stroke-dasharray: 5 3;
  stroke-linecap: butt;
}
.origin--assumed .node__halo {
  stroke-dasharray: 0.1 3.4;
  stroke-width: 2;
}
.origin--simulated .node__halo {
  stroke-dasharray: 8 3 1 3;
  stroke-linecap: butt;
}

.node__focus {
  fill: none;
  stroke: transparent;
  stroke-width: 2.5;
}

.node:hover .node__focus {
  stroke: var(--c2p-rule);
}

.node.is-selected .node__focus,
.node:focus-visible .node__focus {
  stroke: var(--c2p-focus);
}

/* Legend */
.graph-panel__legend {
  display: flex;
  flex-wrap: wrap;
  gap: var(--c2p-space-4) var(--c2p-space-6);
  min-width: 0;
}

.legend__group {
  display: grid;
  gap: var(--c2p-space-2);
  align-content: start;
  min-width: 0;
}

.legend__list {
  display: flex;
  flex-wrap: wrap;
  gap: var(--c2p-space-1) var(--c2p-space-3);
  max-width: 26rem;
}

.legend__item {
  display: inline-flex;
  align-items: center;
  gap: var(--c2p-space-2);
  color: var(--c2p-text-muted);
  font-size: var(--c2p-text-xs);
}

.legend__swatch {
  width: 1.1rem;
  height: 1.1rem;
  flex: none;
  overflow: visible;
}

.legend__line {
  width: 1.75rem;
  height: 0.5rem;
  flex: none;
}

/* Side cards */
.graph-panel__card {
  display: grid;
  gap: var(--c2p-space-3);
  align-content: start;
  min-width: 0;
  padding: var(--c2p-space-4);
  border: var(--c2p-rule-width) solid var(--c2p-rule);
  border-radius: var(--c2p-radius);
  background: var(--c2p-bg);
}

.card__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--c2p-space-2);
  min-height: 2rem;
}

.detail {
  display: grid;
  gap: var(--c2p-space-2);
  min-width: 0;
  font-size: var(--c2p-text-sm);
}

.detail__type {
  color: var(--c2p-text-muted);
  font-size: var(--c2p-text-xs);
}

.detail__title {
  font-weight: 600;
  overflow-wrap: anywhere;
}

.detail__list {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: var(--c2p-space-1) var(--c2p-space-3);
  margin: 0;
}

.detail__list dt {
  color: var(--c2p-text-muted);
  font-size: var(--c2p-text-xs);
  line-height: 1.9;
}

.detail__list dd {
  margin: 0;
  min-width: 0;
  overflow-wrap: anywhere;
}

.detail__list .mono,
.detail__ports .mono,
.detail__ports-single .mono {
  font-size: var(--c2p-text-xs);
}

.detail__sub {
  margin-top: var(--c2p-space-2);
  color: var(--c2p-text-muted);
  font-size: var(--c2p-text-xs);
}

.detail__roles,
.detail__ports {
  display: grid;
  gap: var(--c2p-space-2);
}

.detail__roles li {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--c2p-space-1) var(--c2p-space-2);
}

.detail__ports li,
.detail__ports-single {
  display: grid;
  gap: 0.1rem;
  padding-left: var(--c2p-space-2);
  border-left: 2px solid var(--c2p-rule);
}

.detail__port {
  font-weight: 600;
}

.detail__var,
.detail__interval {
  color: var(--c2p-text-muted);
  overflow-wrap: anywhere;
}

.detail__muted {
  color: var(--c2p-text-muted);
  font-size: var(--c2p-text-sm);
}

.origin-tag {
  display: inline-block;
  padding: 0 var(--c2p-space-2);
  border: 1.5px solid var(--c2p-text-muted);
  border-radius: var(--c2p-radius);
  font-family: var(--c2p-font-mono);
  font-size: var(--c2p-text-xs);
  line-height: 1.5;
}

.origin-tag.origin--extracted {
  border-style: dashed;
}
.origin-tag.origin--assumed {
  border-style: dotted;
}
.origin-tag.origin--simulated {
  border-style: double;
  border-width: 3px;
}

/* Agent candidates: two separate counts, never one number */
.agents__counts {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--c2p-space-2);
}

.agents__count {
  display: grid;
  gap: 0.1rem;
  padding: var(--c2p-space-2) var(--c2p-space-3);
  border: var(--c2p-rule-width) solid var(--c2p-rule);
  border-radius: var(--c2p-radius);
}

.agents__number {
  font-size: var(--c2p-text-lg);
  font-weight: 600;
  line-height: 1.2;
}

.agents__label {
  color: var(--c2p-text-muted);
  font-size: var(--c2p-text-xs);
}

.agents__list {
  display: grid;
  gap: var(--c2p-space-1);
}

.agents__item {
  display: flex;
  justify-content: space-between;
  gap: var(--c2p-space-2);
  width: 100%;
  padding: var(--c2p-space-1) var(--c2p-space-2);
  border: 0;
  border-radius: var(--c2p-radius);
  background: transparent;
  font-size: var(--c2p-text-sm);
  text-align: left;
  cursor: pointer;
}

.agents__item:hover {
  background: var(--c2p-surface);
}

.agents__kind {
  color: var(--c2p-text-muted);
  font-size: var(--c2p-text-xs);
}

.agents__rule {
  color: var(--c2p-text-faint);
  font-size: var(--c2p-text-xs);
}
</style>
