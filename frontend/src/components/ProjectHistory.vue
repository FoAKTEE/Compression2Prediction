<script setup lang="ts">
import { computed, onMounted, ref, shallowRef } from "vue";
import { useI18n } from "vue-i18n";
import { listRuns } from "../api/forecast";
import { listReports } from "../api/report";
import type { ForecastRunSummary, ReportSummary } from "../api/types";
import { errorNotice } from "../composables/errorNotice";
import EffectBadge from "./forecast/EffectBadge.vue";
import { formatTimestamp } from "./forecast/format";
import StateNotice from "./StateNotice.vue";

/** A project's forecast runs and reports (newest first), each report linked to its page. */
const props = defineProps<{ projectId: string }>();
const { t, locale } = useI18n();

const runs = shallowRef<ForecastRunSummary[]>([]);
const reports = shallowRef<ReportSummary[]>([]);
const loading = ref(true);
const failure = ref<unknown>(null);

async function load(): Promise<void> {
  loading.value = true;
  failure.value = null;
  try {
    const [r, p] = await Promise.all([listRuns(props.projectId), listReports(props.projectId)]);
    runs.value = r;
    reports.value = p;
  } catch (error) {
    failure.value = error;
  } finally {
    loading.value = false;
  }
}

onMounted(load);

const notice = computed(() => (failure.value === null ? null : errorNotice(failure.value, t)));
</script>

<template>
  <div class="history" data-testid="project-history" :aria-busy="loading ? 'true' : 'false'">
    <StateNotice
      v-if="notice"
      compact
      data-testid="history-error"
      :variant="notice.variant"
      :title="notice.title"
      :body="notice.body"
      :action-label="t('common.retry')"
      @action="load"
    />
    <p v-else-if="loading" class="history__muted">{{ t("common.loading") }}</p>
    <template v-else>
      <div class="history__block">
        <h4 class="eyebrow">{{ t("history.runs", { count: runs.length }, runs.length) }}</h4>
        <ol v-if="runs.length" class="history__list">
          <li v-for="run in runs" :key="run.run_id" class="history__item" data-testid="history-run" :data-run-id="run.run_id">
            <span class="mono history__name">{{ run.scenario_id }}</span>
            <EffectBadge :status="run.effect_status" />
            <span class="mono history__muted">{{ run.target_variable }} · {{ run.target_entity_id }}</span>
            <span class="mono history__muted">{{ formatTimestamp(run.created_at, locale) }}</span>
            <RouterLink
              v-if="run.report_id"
              class="mono history__link"
              data-testid="history-run-report"
              :to="{ name: 'report', params: { reportId: run.report_id } }"
            >
              {{ t("forecast.runs.report") }}
            </RouterLink>
          </li>
        </ol>
        <p v-else class="history__muted" data-testid="history-no-runs">{{ t("history.noRuns") }}</p>
      </div>
      <div class="history__block">
        <h4 class="eyebrow">{{ t("history.reports", { count: reports.length }, reports.length) }}</h4>
        <ol v-if="reports.length" class="history__list">
          <li v-for="report in reports" :key="report.report_id" class="history__item" data-testid="history-report" :data-report-id="report.report_id">
            <RouterLink
              class="mono history__link history__name"
              data-testid="history-report-link"
              :to="{ name: 'report', params: { reportId: report.report_id } }"
            >
              {{ report.report_id }}
            </RouterLink>
            <span class="mono history__muted">{{ report.scenario_id }} · {{ t(`forecast.queryKind.${report.query_kind}`) }}</span>
            <span class="mono history__muted">{{ formatTimestamp(report.created_at, locale) }}</span>
            <RouterLink
              class="mono history__link"
              data-testid="history-interaction-link"
              :to="{ name: 'interaction', params: { reportId: report.report_id } }"
            >
              {{ t("history.interact") }}
            </RouterLink>
          </li>
        </ol>
        <p v-else class="history__muted" data-testid="history-no-reports">{{ t("history.noReports") }}</p>
      </div>
    </template>
  </div>
</template>

<style scoped>
.history {
  display: grid;
  gap: var(--c2p-space-3);
  padding: var(--c2p-space-2) var(--c2p-space-2) var(--c2p-space-4) calc(var(--c2p-space-2) + 2.25rem);
}

@media (max-width: 40rem) {
  .history {
    padding-left: var(--c2p-space-2);
  }
}

.history__block {
  display: grid;
  gap: var(--c2p-space-2);
}

.history__list {
  display: grid;
  gap: var(--c2p-space-1);
}

.history__item {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--c2p-space-1) var(--c2p-space-3);
  font-size: var(--c2p-text-sm);
}

.history__name {
  font-size: var(--c2p-text-xs);
  font-weight: 600;
  overflow-wrap: anywhere;
}

.history__muted {
  color: var(--c2p-text-muted);
  font-size: var(--c2p-text-xs);
  overflow-wrap: anywhere;
}

.history__link {
  font-size: var(--c2p-text-xs);
}
</style>
