<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute } from "vue-router";
import { getRun } from "../../api/forecast";
import { getProjectReport, listReports } from "../../api/report";
import type { ForecastReportBody, ReportSummary } from "../../api/types";
import { errorNotice } from "../../composables/errorNotice";
import { exampleRequested } from "../../composables/graphSource";
import { projectStore } from "../../store/project";
import { EXAMPLE_INTERVENTION_REPORT_ID, exampleReport, exampleReportSummaries } from "../forecast/examples";
import { formatTimestamp } from "../forecast/format";
import ReportBody from "../report/ReportBody.vue";
import StateNotice from "../StateNotice.vue";
import StepPanel from "./StepPanel.vue";

const props = defineProps<{ projectId: string; completed: boolean }>();
const emit = defineEmits<{ complete: []; incomplete: []; "refresh-project": [] }>();
const { t, locale } = useI18n();
const route = useRoute();

/** `?example=1`: the bundled report of the guide §11.1 run stands in for the server. */
const demo = exampleRequested(route?.query);
const linkQuery: Record<string, string> = demo ? { example: "1" } : {};

const project = computed(() => {
  const current = projectStore.state.project;
  return current !== null && current.project_id === props.projectId ? current : null;
});

const reports = shallowRef<ReportSummary[]>(demo ? exampleReportSummaries() : []);
const reportId = ref<string | null>(null);
const report = shallowRef<ForecastReportBody | null>(null);
const loading = ref(false);
const failure = ref<unknown>(null);
/** True until the report to show has been chosen (it may need a run lookup). */
const resolving = ref(true);

let unmounted = false;
onBeforeUnmount(() => {
  unmounted = true;
});

async function load(id: string): Promise<void> {
  reportId.value = id;
  loading.value = true;
  failure.value = null;
  try {
    const body = demo ? exampleReport(id) : await getProjectReport(props.projectId, id);
    if (unmounted || reportId.value !== id) return;
    if (body === null) throw new Error(t("step4.unknownExample", { id }));
    report.value = body;
    projectStore.markReportViewed();
    if (!props.completed) emit("complete");
  } catch (error) {
    if (!unmounted && reportId.value === id) failure.value = error;
  } finally {
    if (!unmounted && reportId.value === id) loading.value = false;
  }
}

/** The selected run's report; else the project's latest report. */
async function resolveReportId(): Promise<string | null> {
  const state = projectStore.state;
  if (state.selectedReportId) return state.selectedReportId;
  if (demo) return EXAMPLE_INTERVENTION_REPORT_ID;
  if (state.selectedRunId) {
    try {
      const run = await getRun(props.projectId, state.selectedRunId);
      if (run.report_id) return run.report_id;
    } catch {
      // Fall back to the latest report.
    }
  }
  return project.value?.latest_report_id ?? null;
}

async function start(): Promise<void> {
  const id = await resolveReportId();
  if (unmounted) return;
  resolving.value = false;
  if (id !== null && reportId.value === null) void load(id);
}

void start();

// The project record may arrive after the step mounts.
watch(
  () => project.value?.latest_report_id,
  (latest) => {
    if (reportId.value === null && latest) void load(latest);
  },
);

async function loadReportList(): Promise<void> {
  if (demo) return;
  try {
    const listed = await listReports(props.projectId);
    if (!unmounted) reports.value = listed;
  } catch {
    // The picker is optional; the selected or latest report still loads.
  }
}

void loadReportList();

function onPick(event: Event): void {
  const id = (event.target as HTMLSelectElement).value;
  if (id && id !== reportId.value) void load(id);
}

const notice = computed(() => (failure.value === null ? null : errorNotice(failure.value, t)));
</script>

<template>
  <StepPanel :step="4" :completed="completed" wired>
    <section class="step-section" data-testid="report-picker" :aria-label="t('step4.heading')">
      <div class="step-section__bar">
        <h3 class="eyebrow">{{ t("step4.heading") }}</h3>
        <span v-if="demo" class="badge" data-testid="example-badge" :title="t('graph.example.note')">
          {{ t("graph.example.badge") }}
        </span>
      </div>
      <div v-if="reports.length > 1" class="field step4__pick">
        <label class="field__label" for="step4-report">{{ t("step4.pick") }}</label>
        <select id="step4-report" class="field__input" data-testid="report-select" :value="reportId ?? ''" @change="onPick">
          <option v-for="r in reports" :key="r.report_id" :value="r.report_id">
            {{ r.scenario_id }} · {{ t(`forecast.queryKind.${r.query_kind}`) }} · {{ formatTimestamp(r.created_at, locale) }}
          </option>
        </select>
      </div>
      <div v-if="reportId" class="step-actions">
        <RouterLink
          class="btn"
          data-testid="open-report-page"
          :to="{ name: 'report', params: { reportId }, query: linkQuery }"
        >
          {{ t("step4.openStandalone") }}
        </RouterLink>
        <RouterLink
          class="btn btn--quiet"
          data-testid="open-interaction-page"
          :to="{ name: 'interaction', params: { reportId }, query: linkQuery }"
        >
          {{ t("step4.openInteraction") }}
        </RouterLink>
      </div>
    </section>

    <StateNotice
      v-if="notice"
      compact
      data-testid="report-notice"
      :variant="notice.variant"
      :title="notice.title"
      :body="notice.body"
    />
    <p v-else-if="loading && !report" class="step-hint">{{ t("common.loading") }}</p>
    <ReportBody v-if="report" :report="report" />
    <StateNotice
      v-else-if="!resolving && !loading && !notice && reportId === null"
      variant="empty"
      data-testid="no-report"
      :title="t('step4.empty.title')"
      :body="t('step4.empty.body')"
    />
  </StepPanel>
</template>

<style scoped>
.step4__pick {
  max-width: 32rem;
}
</style>
