<script setup lang="ts">
import { computed, ref, shallowRef, watch } from "vue";
import { useI18n } from "vue-i18n";
import { getMechanismGraph } from "../../api/model";
import type { KernelProvenance, MechanismGraphResponse, MechanismPort } from "../../api/types";
import { errorNotice } from "../../composables/errorNotice";
import GraphPanel from "../graph/GraphPanel.vue";
import StateNotice from "../StateNotice.vue";
import { exampleIncidentMechanismGraph } from "./examples";

/**
 * The mechanism graph (variable instances and mechanisms with ordered ports)
 * and, for each mechanism, its kernel, causal basis, parameter origin, and
 * validation status, plus how the selected run's kernel was fitted.
 */
const props = defineProps<{ projectId: string | null; demo: boolean; kernels: KernelProvenance[] }>();
const { t } = useI18n();

const graph = shallowRef<MechanismGraphResponse | null>(props.demo ? exampleIncidentMechanismGraph() : null);
const loading = ref(false);
const failure = ref<unknown>(null);

async function load(id: string): Promise<void> {
  loading.value = true;
  failure.value = null;
  try {
    const result = await getMechanismGraph(id);
    if (props.projectId === id) graph.value = result;
  } catch (error) {
    if (props.projectId === id) failure.value = error;
  } finally {
    if (props.projectId === id) loading.value = false;
  }
}

watch(
  () => props.projectId,
  (id) => {
    if (!props.demo && id !== null) void load(id);
  },
  { immediate: true },
);

function timeLabel(offset: number): string {
  if (offset === 0) return "t";
  return offset > 0 ? `t+${offset}` : `t−${-offset}`;
}

function port(p: MechanismPort): string {
  return `${p.port}: ${p.variable} @ ${timeLabel(p.time_offset)}`;
}

const fitting = computed(() => new Map(props.kernels.map((k) => [k.mechanism_id, k])));
const notice = computed(() => (failure.value === null ? null : errorNotice(failure.value, t)));
</script>

<template>
  <div class="inspector" data-testid="mechanism-inspector">
    <StateNotice v-if="notice" compact data-testid="inspector-notice" :variant="notice.variant" :title="notice.title" :body="notice.body" />
    <GraphPanel v-if="graph || loading" :mechanism="graph" initial-mode="mechanism" :loading="loading" />
    <p v-else-if="!notice" class="step-hint">{{ t("step5.inspector.empty") }}</p>
    <ul v-if="graph && graph.mechanisms.length" class="inspector__list">
      <li v-for="m in graph.mechanisms" :key="m.mechanism_id" class="inspector__item" data-testid="inspector-mechanism" :data-mechanism-id="m.mechanism_id">
        <p class="inspector__head">
          <span class="mono inspector__id">{{ m.mechanism_id }}</span>
          <span class="badge">{{ m.family }}</span>
        </p>
        <dl class="facts">
          <div>
            <dt>{{ t("graph.detail.inputs") }}</dt>
            <dd class="mono">
              <ol class="inspector__ports">
                <li v-for="(p, i) in m.inputs" :key="p.port">{{ i }} · {{ port(p) }}</li>
              </ol>
            </dd>
          </div>
          <div>
            <dt>{{ t("graph.detail.output") }}</dt>
            <dd class="mono">{{ m.outputs[0] ? port(m.outputs[0]) : t("forecast.none") }}</dd>
          </div>
          <div>
            <dt>{{ t("graph.detail.kernelRef") }}</dt>
            <dd class="mono">{{ m.kernel_ref }}</dd>
          </div>
          <div>
            <dt>{{ t("graph.detail.causalBasis") }}</dt>
            <dd class="mono">{{ m.causal_basis }}</dd>
          </div>
          <div>
            <dt>{{ t("graph.detail.parameterOrigin") }}</dt>
            <dd class="mono">{{ m.parameter_origin }}</dd>
          </div>
          <div>
            <dt>{{ t("graph.detail.validationStatus") }}</dt>
            <dd class="mono">{{ m.validation_status }}</dd>
          </div>
          <div v-if="fitting.get(m.mechanism_id)">
            <dt>{{ t("forecast.provenance.fittingMethod") }}</dt>
            <dd class="mono">{{ fitting.get(m.mechanism_id)!.fitting_method }}</dd>
          </div>
          <div v-if="fitting.get(m.mechanism_id)">
            <dt>{{ t("forecast.provenance.trainingCutoff") }}</dt>
            <dd class="mono">{{ fitting.get(m.mechanism_id)!.training_cutoff ?? t("forecast.none") }}</dd>
          </div>
        </dl>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.inspector {
  display: grid;
  gap: var(--c2p-space-4);
  min-width: 0;
}

.inspector__list {
  display: grid;
  gap: var(--c2p-space-3);
}

.inspector__item {
  display: grid;
  gap: var(--c2p-space-2);
  padding: var(--c2p-space-3) var(--c2p-space-4);
  border: var(--c2p-rule-width) solid var(--c2p-rule);
  border-radius: var(--c2p-radius);
}

.inspector__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--c2p-space-2);
}

.inspector__id {
  font-size: var(--c2p-text-sm);
  font-weight: 600;
  overflow-wrap: anywhere;
}

.inspector__ports {
  display: grid;
  gap: 0.1rem;
}
</style>
