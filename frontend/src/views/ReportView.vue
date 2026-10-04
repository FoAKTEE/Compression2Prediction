<script setup lang="ts">
import { computed, ref, shallowRef, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute } from "vue-router";
import { getReport } from "../api/report";
import type { ForecastReportBody } from "../api/types";
import { exampleReport } from "../components/forecast/examples";
import ReportBody from "../components/report/ReportBody.vue";
import StateNotice from "../components/StateNotice.vue";
import { errorNotice } from "../composables/errorNotice";
import { exampleRequested } from "../composables/graphSource";

/** `/report/:reportId`: one report on its own page. With `?example=1` the bundled reports are served offline. */
const props = defineProps<{ reportId: string }>();
const { t } = useI18n();
const route = useRoute();
const demo = exampleRequested(route?.query);
const linkQuery: Record<string, string> = demo ? { example: "1" } : {};

const report = shallowRef<ForecastReportBody | null>(null);
const loading = ref(false);
const failure = ref<unknown>(null);
const missingExample = ref(false);

async function load(id: string): Promise<void> {
  loading.value = true;
  failure.value = null;
  missingExample.value = false;
  report.value = null;
  try {
    const body = demo ? exampleReport(id) : await getReport(id);
    if (props.reportId !== id) return;
    if (body === null) missingExample.value = true;
    report.value = body;
  } catch (error) {
    if (props.reportId === id) failure.value = error;
  } finally {
    if (props.reportId === id) loading.value = false;
  }
}

watch(() => props.reportId, (id) => void load(id), { immediate: true });

const notice = computed(() => (failure.value === null ? null : errorNotice(failure.value, t)));
</script>

<template>
  <div class="page report-view" data-testid="report-view">
    <header class="report-view__header">
      <RouterLink
        v-if="report"
        class="report-view__back mono"
        data-testid="report-process-link"
        :to="{ name: 'process', params: { projectId: report.project_id }, query: demo ? { example: '1', step: '4' } : {} }"
      >
        <span aria-hidden="true">←</span> {{ t("report.backToProject") }}
      </RouterLink>
      <p class="eyebrow">
        {{ t("report.idLabel") }} <span class="report-view__id mono">{{ reportId }}</span>
      </p>
      <h1 class="report-view__title">{{ t("report.title") }}</h1>
      <p class="report-view__description">{{ t("report.description") }}</p>
      <div v-if="report" class="step-actions">
        <RouterLink
          class="btn btn--quiet"
          data-testid="report-interaction-link"
          :to="{ name: 'interaction', params: { reportId }, query: linkQuery }"
        >
          {{ t("step4.openInteraction") }}
        </RouterLink>
      </div>
    </header>
    <StateNotice v-if="notice" data-testid="report-view-notice" :variant="notice.variant" :title="notice.title" :body="notice.body" />
    <StateNotice v-else-if="missingExample" variant="empty" data-testid="report-view-missing" :title="t('report.notExample')" />
    <StateNotice v-else-if="loading" compact variant="loading" :title="t('common.loading')" />
    <ReportBody v-if="report" :report="report" heading-tag="h2" />
  </div>
</template>

<style scoped>
.report-view {
  display: grid;
  gap: var(--c2p-space-6);
}

.report-view__header {
  display: grid;
  gap: var(--c2p-space-3);
  padding-top: var(--c2p-space-4);
  border-top: var(--c2p-rule-width) solid var(--c2p-rule-strong);
}

.report-view__back {
  justify-self: start;
  color: var(--c2p-text-muted);
  font-size: var(--c2p-text-xs);
  text-decoration: none;
}

.report-view__id {
  margin-left: var(--c2p-space-2);
  color: var(--c2p-text);
  text-transform: none;
  overflow-wrap: anywhere;
}

.report-view__title {
  font-size: var(--c2p-text-xl);
  font-weight: 700;
  letter-spacing: -0.02em;
}

.report-view__description {
  max-width: 44rem;
  color: var(--c2p-text-muted);
}
</style>
