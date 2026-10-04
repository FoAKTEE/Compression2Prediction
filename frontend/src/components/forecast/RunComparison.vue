<script setup lang="ts">
import { computed, ref, shallowRef, useId, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { ForecastResult, ForecastRunSummary, ScenarioResult } from "../../api/types";
import { errorNotice } from "../../composables/errorNotice";
import { formatPercent, formatPointDifference } from "../../composables/probability";
import StateNotice from "../StateNotice.vue";
import DistributionChart, { type ChartSeries } from "./DistributionChart.vue";

/**
 * Two runs side by side at one horizon step: each run's own scenario (its
 * intervention when it has one, else its baseline), and the difference B − A
 * in percentage points. Both are outputs of the stated model, so the
 * difference is labelled as one between two model runs.
 */
const props = defineProps<{
  runs: ForecastRunSummary[];
  fetchRun: (runId: string) => Promise<ForecastResult>;
}>();
const emit = defineEmits<{ compared: [] }>();
const { t } = useI18n();
const uid = useId();

const ordered = computed(() => [...props.runs].sort((a, b) => (a.created_at < b.created_at ? 1 : -1)));

const aId = ref<string>("");
const bId = ref<string>("");
const step = ref<number>(1);
const resultA = shallowRef<ForecastResult | null>(null);
const resultB = shallowRef<ForecastResult | null>(null);
const failure = ref<unknown>(null);

/** Defaults: A is the second newest run, B the newest. */
watch(
  ordered,
  (runs) => {
    const ids = runs.map((r) => r.run_id);
    if (!ids.includes(bId.value)) bId.value = runs[0]?.run_id ?? "";
    if (!ids.includes(aId.value)) aId.value = runs[1]?.run_id ?? runs[0]?.run_id ?? "";
  },
  { immediate: true },
);

async function load(id: string, slot: "a" | "b"): Promise<void> {
  const target = slot === "a" ? resultA : resultB;
  if (!id) {
    target.value = null;
    return;
  }
  try {
    const result = await props.fetchRun(id);
    if ((slot === "a" ? aId.value : bId.value) === id) target.value = result;
  } catch (error) {
    failure.value = error;
  }
}

watch(aId, (id) => void load(id, "a"), { immediate: true });
watch(bId, (id) => void load(id, "b"), { immediate: true });

function own(result: ForecastResult): ScenarioResult {
  return result.intervention ?? result.baseline;
}

const sameTarget = computed(() => {
  const a = resultA.value;
  const b = resultB.value;
  return a !== null && b !== null && a.target_variable === b.target_variable && a.target_entity_id === b.target_entity_id;
});

const maxStep = computed(() => Math.min(resultA.value?.horizon_steps ?? 0, resultB.value?.horizon_steps ?? 0));
const stepOptions = computed(() => Array.from({ length: maxStep.value }, (_, i) => i + 1));

/** The final common step until the user picks another one. */
const stepPicked = ref(false);
watch(
  maxStep,
  (max) => {
    if (max > 0 && (!stepPicked.value || step.value < 1 || step.value > max)) step.value = max;
  },
  { immediate: true },
);

const ready = computed(() => sameTarget.value && aId.value !== bId.value && maxStep.value > 0);

watch(
  ready,
  (ok) => {
    if (ok) emit("compared");
  },
  { immediate: true },
);

const domain = computed(() => resultA.value?.prediction_scope?.domain?.values ?? null);

const series = computed<ChartSeries[]>(() => {
  if (!ready.value) return [];
  const a = resultA.value!;
  const b = resultB.value!;
  return [
    { id: "run-a", label: t("step5.compare.seriesA", { scenario: a.scenario_id }), tone: "run-a", byHorizon: own(a).by_horizon },
    { id: "run-b", label: t("step5.compare.seriesB", { scenario: b.scenario_id }), tone: "run-b", byHorizon: own(b).by_horizon },
  ];
});

function at(result: ForecastResult, value: string): number | null {
  return own(result).by_horizon.find((h) => h.horizon_step === step.value)?.distribution.find((e) => e.value === value)?.probability ?? null;
}

const rows = computed(() => {
  if (!ready.value) return [];
  const a = resultA.value!;
  const b = resultB.value!;
  const values = domain.value ?? own(a).by_horizon[0]?.distribution.map((e) => e.value) ?? [];
  return values.map((value) => {
    const pa = at(a, value);
    const pb = at(b, value);
    return {
      value,
      a: pa === null ? t("metric.missing") : formatPercent(pa),
      b: pb === null ? t("metric.missing") : formatPercent(pb),
      diff: pa === null || pb === null ? t("metric.missing") : formatPointDifference(pa, pb),
    };
  });
});

function runLabel(run: ForecastRunSummary): string {
  return `${run.scenario_id} · ${run.run_id}`;
}

const notice = computed(() => (failure.value === null ? null : errorNotice(failure.value, t)));
</script>

<template>
  <div class="compare" data-testid="run-comparison">
    <div class="compare__controls">
      <div class="field">
        <label class="field__label" :for="`${uid}-a`">{{ t("step5.compare.runA") }}</label>
        <select :id="`${uid}-a`" v-model="aId" class="field__input" data-testid="compare-a">
          <option v-for="run in ordered" :key="run.run_id" :value="run.run_id">{{ runLabel(run) }}</option>
        </select>
      </div>
      <div class="field">
        <label class="field__label" :for="`${uid}-b`">{{ t("step5.compare.runB") }}</label>
        <select :id="`${uid}-b`" v-model="bId" class="field__input" data-testid="compare-b">
          <option v-for="run in ordered" :key="run.run_id" :value="run.run_id">{{ runLabel(run) }}</option>
        </select>
      </div>
      <div class="field compare__step">
        <label class="field__label" :for="`${uid}-step`">{{ t("step5.compare.step") }}</label>
        <select
          :id="`${uid}-step`"
          v-model.number="step"
          class="field__input mono"
          data-testid="compare-step"
          :disabled="!stepOptions.length"
          @change="stepPicked = true"
        >
          <option v-for="h in stepOptions" :key="h" :value="h">{{ h }}</option>
        </select>
      </div>
    </div>

    <StateNotice v-if="notice" compact data-testid="compare-notice" :variant="notice.variant" :title="notice.title" :body="notice.body" />
    <p v-else-if="runs.length < 2" class="step-hint" data-testid="compare-need-two">{{ t("step5.compare.needTwo") }}</p>
    <p v-else-if="aId === bId" class="step-hint" data-testid="compare-same">{{ t("step5.compare.same") }}</p>
    <p v-else-if="resultA && resultB && !sameTarget" class="step-hint" data-testid="compare-mismatch">{{ t("step5.compare.mismatch") }}</p>

    <template v-if="ready">
      <DistributionChart
        :series="series"
        :steps="[step]"
        :domain="domain"
        :title="t('step5.compare.chartTitle', { variable: resultA!.target_variable, entity: resultA!.target_entity_id, step })"
      />
      <div class="table-scroll">
        <table class="data-table compare__table" data-testid="compare-table">
          <caption class="compare__caption" data-testid="compare-caption">
            {{ t("step5.compare.caption", { step }) }}
          </caption>
          <thead>
            <tr>
              <th scope="col">{{ t("forecast.chart.tableOutcome") }}</th>
              <th scope="col">{{ t("step5.compare.runA") }}</th>
              <th scope="col">{{ t("step5.compare.runB") }}</th>
              <th scope="col">{{ t("step5.compare.difference") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in rows" :key="row.value" data-testid="compare-row" :data-value="row.value">
              <td class="mono">{{ row.value }}</td>
              <td class="mono">{{ row.a }}</td>
              <td class="mono">{{ row.b }}</td>
              <td class="mono compare__diff" data-testid="compare-diff">{{ row.diff }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>

<style scoped>
.compare {
  display: grid;
  gap: var(--c2p-space-3);
  min-width: 0;
}

.compare__controls {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 12rem), 1fr));
  gap: var(--c2p-space-2) var(--c2p-space-3);
}

.compare__controls .field__input {
  padding: var(--c2p-space-2) var(--c2p-space-3);
}

.compare__caption {
  padding-bottom: var(--c2p-space-2);
  color: var(--c2p-text-muted);
  font-size: var(--c2p-text-xs);
  text-align: left;
  caption-side: top;
}

.compare__diff {
  font-weight: 600;
}
</style>
