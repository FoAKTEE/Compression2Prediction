<script setup lang="ts">
import { computed, ref, shallowRef, useId, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { ForecastRequest, ForecastResult } from "../../api/types";
import { errorNotice } from "../../composables/errorNotice";
import { useForecastContext } from "../../composables/forecastContext";
import { useForecastSubmit } from "../../composables/forecastSubmit";
import StateNotice from "../StateNotice.vue";
import ForecastForm from "./ForecastForm.vue";
import ForecastResultView from "./ForecastResultView.vue";
import MechanismInspector from "./MechanismInspector.vue";
import RankPanel from "./RankPanel.vue";
import RunComparison from "./RunComparison.vue";

/**
 * Step 5 and the interaction page: a what-if re-run prefilled from the
 * selected run, a comparison of two runs, the mechanism inspector, and rank
 * and influence diagnostics, all for one project.
 */
const props = withDefaults(
  defineProps<{
    projectId: string | null;
    demo: boolean;
    initialRunId?: string | null;
    linkQuery?: Record<string, string>;
  }>(),
  { initialRunId: null, linkQuery: () => ({}) },
);
const emit = defineEmits<{ interacted: []; "refresh-project": []; "select-run": [runId: string, reportId: string | null] }>();
const { t } = useI18n();
const uid = useId();

const ctx = useForecastContext({ projectId: () => props.projectId, demo: props.demo });
const submitter = useForecastSubmit(ctx, { projectId: () => props.projectId, t });

const ordered = computed(() => [...ctx.runs.value].sort((a, b) => (a.created_at < b.created_at ? 1 : -1)));
const selectedId = ref<string>("");
const selected = shallowRef<ForecastResult | null>(null);
const selectedError = ref<unknown>(null);
/** The what-if form's starting request; replaced only when another run is selected. */
const whatIfInitial = shallowRef<ForecastRequest | null>(null);
const whatIfResult = shallowRef<ForecastResult | null>(null);

watch(
  ordered,
  (runs) => {
    if (runs.some((r) => r.run_id === selectedId.value)) return;
    const preferred = runs.find((r) => r.run_id === props.initialRunId) ?? runs[0];
    selectedId.value = preferred?.run_id ?? "";
  },
  { immediate: true },
);

/** The selected run's request, editable: same target and horizon, its hard interventions. */
function requestFrom(run: ForecastResult): ForecastRequest {
  const scope = run.prediction_scope;
  return {
    query_kind: run.query_kind,
    target_entity_id: run.target_entity_id,
    target_variable: run.target_variable,
    horizon_steps: run.horizon_steps,
    ...(scope?.step_minutes ? { step_minutes: scope.step_minutes } : {}),
    ...(scope?.initial_belief?.requested_ref ? { initial_belief_ref: scope.initial_belief.requested_ref } : {}),
    interventions: run.interventions.map((iv) => ({ ...iv })),
  };
}

watch(
  selectedId,
  async (id) => {
    selected.value = null;
    selectedError.value = null;
    if (!id) return;
    try {
      const run = await ctx.fetchRun(id);
      if (selectedId.value !== id) return;
      selected.value = run;
      whatIfInitial.value = requestFrom(run);
      emit("select-run", run.run_id, run.report_id);
    } catch (error) {
      if (selectedId.value === id) selectedError.value = error;
    }
  },
  { immediate: true },
);

async function onWhatIf(request: ForecastRequest): Promise<void> {
  const result = await submitter.submit(request);
  if (result === null) return;
  whatIfResult.value = result;
  emit("interacted");
  if (!props.demo) emit("refresh-project");
}

const selectedNotice = computed(() => (selectedError.value === null ? null : errorNotice(selectedError.value, t)));
const runsNotice = computed(() => (ctx.runsError.value === null ? null : errorNotice(ctx.runsError.value, t)));
</script>

<template>
  <div class="panels" data-testid="interaction-panels">
    <section class="step-section" data-testid="interaction-run" :aria-label="t('step5.run.heading')">
      <div class="step-section__bar">
        <h3 class="eyebrow">{{ t("step5.run.heading") }}</h3>
        <span v-if="demo" class="badge" data-testid="example-badge" :title="t('graph.example.note')">{{ t("graph.example.badge") }}</span>
      </div>
      <StateNotice v-if="runsNotice" compact data-testid="interaction-runs-notice" :variant="runsNotice.variant" :title="runsNotice.title" :body="runsNotice.body" />
      <div v-else-if="ordered.length" class="field panels__run">
        <label class="field__label" :for="`${uid}-run`">{{ t("step5.run.label") }}</label>
        <select :id="`${uid}-run`" v-model="selectedId" class="field__input" data-testid="interaction-run-select">
          <option v-for="run in ordered" :key="run.run_id" :value="run.run_id">{{ run.scenario_id }} · {{ run.run_id }}</option>
        </select>
      </div>
      <p v-else-if="!ctx.runsLoading.value" class="step-hint" data-testid="interaction-no-runs">{{ t("step5.run.empty") }}</p>
      <StateNotice v-if="selectedNotice" compact data-testid="interaction-run-notice" :variant="selectedNotice.variant" :title="selectedNotice.title" :body="selectedNotice.body" />
    </section>

    <div class="panels__grid">
      <section class="step-section" data-testid="whatif-panel" :aria-label="t('step5.whatif.heading')">
        <div class="step-section__bar">
          <h3 class="eyebrow">{{ t("step5.whatif.heading") }}</h3>
        </div>
        <p class="step-hint">{{ t("step5.whatif.intro") }}</p>
        <ForecastForm
          v-if="selected || demo"
          compact
          :entities="ctx.entities.value"
          :variables="ctx.variables.value"
          :horizon-max="ctx.model.value?.horizon_steps ?? null"
          :initial="whatIfInitial"
          :busy="submitter.submitting.value"
          :disabled="!demo && ctx.variables.value.length === 0"
          :submit-label="t('step5.whatif.submit')"
          @submit="onWhatIf"
        />
        <div v-if="submitter.problem.value" class="inline-error" role="alert" data-testid="whatif-error">
          <p class="inline-error__title">{{ submitter.problem.value.title }}</p>
          <p class="inline-error__detail">{{ submitter.problem.value.code }}: {{ submitter.problem.value.detail }}</p>
        </div>
        <StateNotice
          v-if="submitter.notice.value"
          compact
          data-testid="whatif-notice"
          :variant="submitter.notice.value.variant"
          :title="submitter.notice.value.title"
          :body="submitter.notice.value.body"
        />
        <StateNotice
          v-if="submitter.demoMiss.value"
          compact
          variant="unavailable"
          data-testid="whatif-demo-miss"
          :title="t('step3.demoMiss.title')"
          :body="t('step3.demoMiss.body')"
        />
        <ForecastResultView v-if="whatIfResult" compact :result="whatIfResult" :link-query="linkQuery" />
      </section>

      <section class="step-section" data-testid="compare-panel" :aria-label="t('step5.compare.heading')">
        <div class="step-section__bar">
          <h3 class="eyebrow">{{ t("step5.compare.heading") }}</h3>
        </div>
        <RunComparison :runs="ctx.runs.value" :fetch-run="ctx.fetchRun" @compared="emit('interacted')" />
      </section>
    </div>

    <section class="step-section" data-testid="inspector-panel" :aria-label="t('step5.inspector.heading')">
      <div class="step-section__bar">
        <h3 class="eyebrow">{{ t("step5.inspector.heading") }}</h3>
      </div>
      <MechanismInspector :project-id="projectId" :demo="demo" :kernels="selected?.provenance?.kernels ?? []" />
    </section>

    <section class="step-section" data-testid="rank-section" :aria-label="t('step5.rank.heading')">
      <div class="step-section__bar">
        <h3 class="eyebrow">{{ t("step5.rank.heading") }}</h3>
      </div>
      <RankPanel :project-id="projectId" :run-id="selectedId || null" :demo="demo" />
    </section>
  </div>
</template>

<style scoped>
.panels {
  display: grid;
  gap: var(--c2p-space-5);
  min-width: 0;
}

.panels__run {
  max-width: 36rem;
}

.panels__run .field__input {
  padding: var(--c2p-space-2) var(--c2p-space-3);
}

.panels__grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--c2p-space-5);
  align-items: start;
}

@media (min-width: 64rem) {
  .panels__grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
