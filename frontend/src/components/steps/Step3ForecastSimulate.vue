<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute } from "vue-router";
import type { ForecastRequest, ForecastResult } from "../../api/types";
import { errorNotice } from "../../composables/errorNotice";
import { useForecastContext } from "../../composables/forecastContext";
import { useForecastSubmit } from "../../composables/forecastSubmit";
import { exampleRequested } from "../../composables/graphSource";
import { projectStore } from "../../store/project";
import { exampleInterventionRequest } from "../forecast/examples";
import ForecastForm from "../forecast/ForecastForm.vue";
import ForecastResultView from "../forecast/ForecastResultView.vue";
import { shortHash } from "../forecast/format";
import RunsList from "../forecast/RunsList.vue";
import StateNotice from "../StateNotice.vue";
import StepPanel from "./StepPanel.vue";

const props = defineProps<{ projectId: string; completed: boolean }>();
const emit = defineEmits<{ complete: []; incomplete: []; "refresh-project": [] }>();
const { t } = useI18n();
const route = useRoute();

/** `?example=1`: the bundled guide §13 forecast stands in for the server. */
const demo = exampleRequested(route?.query);
const linkQuery: Record<string, string> = demo ? { example: "1" } : {};

const ctx = useForecastContext({ projectId: () => props.projectId, demo });
const submitter = useForecastSubmit(ctx, { projectId: () => props.projectId, t });

const project = computed(() => {
  const current = projectStore.state.project;
  return current !== null && current.project_id === props.projectId ? current : null;
});

/** The offline example starts from the guide §11.1 request; a project starts from an empty form. */
const initial = shallowRef<ForecastRequest | null>(demo ? exampleInterventionRequest() : null);

const selectedId = ref<string | null>(null);
const selected = shallowRef<ForecastResult | null>(null);
const runLoading = ref(false);
const runError = ref<unknown>(null);

let unmounted = false;
onBeforeUnmount(() => {
  unmounted = true;
});

async function select(runId: string): Promise<void> {
  selectedId.value = runId;
  const summary = ctx.runs.value.find((r) => r.run_id === runId);
  projectStore.selectRun(runId, summary?.report_id ?? null);
  runLoading.value = true;
  runError.value = null;
  try {
    const result = await ctx.fetchRun(runId);
    if (unmounted || selectedId.value !== runId) return;
    selected.value = result;
    projectStore.selectRun(runId, result.report_id);
  } catch (error) {
    if (!unmounted && selectedId.value === runId) runError.value = error;
  } finally {
    if (!unmounted && selectedId.value === runId) runLoading.value = false;
  }
}

/** Shows the run chosen earlier in the session, else the project's latest, else the newest listed. */
watch(
  () => ctx.runs.value,
  (runs) => {
    if (runs.length === 0) return;
    if (selectedId.value !== null && runs.some((r) => r.run_id === selectedId.value)) return;
    const known = (id: string | null | undefined) => (id && runs.some((r) => r.run_id === id) ? id : null);
    const preferred = known(projectStore.state.selectedRunId) ?? known(project.value?.latest_run_id);
    const newest = [...runs].sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0]!;
    void select(preferred ?? newest.run_id);
  },
  { immediate: true },
);

async function onSubmit(request: ForecastRequest): Promise<void> {
  const result = await submitter.submit(request);
  if (result === null || unmounted) return;
  selectedId.value = result.run_id;
  selected.value = result;
  runError.value = null;
  projectStore.selectRun(result.run_id, result.report_id);
  // The new run is now listed, which completes the step (see `hasRun`).
  if (!demo) emit("refresh-project");
}

/** The step is complete once the project has a run (the server's latest run, or any listed run). */
const hasRun = computed(() => ctx.hasRuns.value || (project.value?.latest_run_id ?? null) !== null);
watch(
  hasRun,
  (done) => {
    if (done && !props.completed) emit("complete");
  },
  { immediate: true },
);

const formDisabled = computed(() => !demo && (ctx.setupLoading.value || ctx.variables.value.length === 0));

const setupNotice = computed(() => (ctx.setupError.value === null ? null : errorNotice(ctx.setupError.value, t)));
const runsNotice = computed(() => (ctx.runsError.value === null ? null : errorNotice(ctx.runsError.value, t)));
const runNotice = computed(() => (runError.value === null ? null : errorNotice(runError.value, t)));

/** A failed recompile keeps the previous plan; forecasts still run on it. */
const stalePlan = computed(() => project.value?.last_compile_ok === false && (project.value?.plan_version ?? null) !== null);
</script>

<template>
  <StepPanel :step="3" :completed="completed" wired>
    <section class="step-section" data-testid="forecast-setup" :aria-label="t('step3.request.heading')">
      <div class="step-section__bar">
        <h3 class="eyebrow">{{ t("step3.request.heading") }}</h3>
        <span v-if="demo" class="badge" data-testid="example-badge" :title="t('graph.example.note')">
          {{ t("graph.example.badge") }}
        </span>
        <span v-if="ctx.model.value" class="step-section__aside mono" data-testid="model-info" :title="ctx.model.value.model_version">
          {{ t("step3.request.model", { version: shortHash(ctx.model.value.model_version), horizon: ctx.model.value.horizon_steps }) }}
        </span>
      </div>
      <p v-if="demo" class="step-hint" data-testid="demo-hint">{{ t("step3.request.demo") }}</p>
      <StateNotice
        v-if="setupNotice"
        compact
        data-testid="setup-notice"
        :variant="setupNotice.variant"
        :title="setupNotice.title"
        :body="setupNotice.body"
      />
      <p
        v-else-if="!demo && !ctx.setupLoading.value && ctx.variables.value.length === 0"
        class="step-hint"
        data-testid="no-model"
      >
        {{ t("step3.request.noModel") }}
      </p>
      <p v-if="stalePlan" class="step-hint step3__stale" data-testid="stale-plan">{{ t("step3.request.stalePlan") }}</p>

      <ForecastForm
        :entities="ctx.entities.value"
        :variables="ctx.variables.value"
        :horizon-max="ctx.model.value?.horizon_steps ?? null"
        :initial="initial"
        :busy="submitter.submitting.value"
        :disabled="formDisabled"
        @submit="onSubmit"
      />

      <div v-if="submitter.problem.value" class="inline-error" role="alert" data-testid="forecast-error">
        <p class="inline-error__title">{{ submitter.problem.value.title }}</p>
        <p class="inline-error__detail">{{ submitter.problem.value.code }}: {{ submitter.problem.value.detail }}</p>
      </div>
      <StateNotice
        v-if="submitter.notice.value"
        compact
        data-testid="forecast-notice"
        :variant="submitter.notice.value.variant"
        :title="submitter.notice.value.title"
        :body="submitter.notice.value.body"
      />
      <StateNotice
        v-if="submitter.demoMiss.value"
        compact
        variant="unavailable"
        data-testid="demo-miss"
        :title="t('step3.demoMiss.title')"
        :body="t('step3.demoMiss.body')"
      />
    </section>

    <div class="step3__split">
      <section class="step-section" data-testid="forecast-runs" :aria-label="t('step3.runs.heading')">
        <div class="step-section__bar">
          <h3 class="eyebrow">{{ t("step3.runs.heading") }}</h3>
          <span class="step-section__aside">{{ t("step3.runs.count", { count: ctx.runs.value.length }, ctx.runs.value.length) }}</span>
          <button
            v-if="!demo"
            type="button"
            class="btn btn--quiet"
            data-testid="refresh-runs"
            :disabled="ctx.runsLoading.value"
            @click="ctx.reloadRuns()"
          >
            {{ t("common.refresh") }}
          </button>
        </div>
        <StateNotice
          v-if="runsNotice"
          compact
          data-testid="runs-notice"
          :variant="runsNotice.variant"
          :title="runsNotice.title"
          :body="runsNotice.body"
        />
        <p v-else-if="ctx.runsLoading.value && !ctx.runs.value.length" class="step-hint">{{ t("common.loading") }}</p>
        <RunsList
          v-if="ctx.runs.value.length"
          :runs="ctx.runs.value"
          :selected-id="selectedId"
          :link-query="linkQuery"
          @select="select"
        />
        <p v-else-if="!runsNotice && !ctx.runsLoading.value" class="step-hint" data-testid="no-runs">{{ t("step3.runs.empty") }}</p>
      </section>

      <section class="step-section" data-testid="forecast-selected" :aria-label="t('step3.selected.heading')" aria-live="polite">
        <div class="step-section__bar">
          <h3 class="eyebrow">{{ t("step3.selected.heading") }}</h3>
        </div>
        <StateNotice
          v-if="runNotice"
          compact
          data-testid="run-notice"
          :variant="runNotice.variant"
          :title="runNotice.title"
          :body="runNotice.body"
        />
        <p v-else-if="runLoading && !selected" class="step-hint">{{ t("common.loading") }}</p>
        <ForecastResultView v-if="selected" :result="selected" :link-query="linkQuery" />
        <p v-else-if="!runLoading && !runNotice" class="step-hint" data-testid="no-selection">{{ t("step3.selected.empty") }}</p>
      </section>
    </div>
  </StepPanel>
</template>

<style scoped>
.step3__split {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--c2p-space-5);
  align-items: start;
}

@media (min-width: 64rem) {
  .step3__split {
    grid-template-columns: minmax(0, 2fr) minmax(0, 5fr);
  }
}

.step3__stale {
  padding-left: var(--c2p-space-2);
  border-left: 2px solid var(--c2p-warning);
}
</style>
