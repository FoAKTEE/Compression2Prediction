<script setup lang="ts">
import { computed, ref, shallowRef, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute } from "vue-router";
import { getReport } from "../api/report";
import type { ForecastReportBody } from "../api/types";
import { exampleReport } from "../components/forecast/examples";
import InteractionPanels from "../components/forecast/InteractionPanels.vue";
import StateNotice from "../components/StateNotice.vue";
import { errorNotice } from "../composables/errorNotice";
import { exampleRequested } from "../composables/graphSource";

/** `/interaction/:reportId`: the step 5 panels for the project and run behind one report. */
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
  <div class="page interaction-view" data-testid="interaction-view">
    <header class="interaction-view__header">
      <p class="eyebrow">
        {{ t("interaction.idLabel") }} <span class="interaction-view__id mono">{{ reportId }}</span>
      </p>
      <h1 class="interaction-view__title">{{ t("interaction.title") }}</h1>
      <p class="interaction-view__description">{{ t("interaction.description") }}</p>
      <div v-if="report" class="step-actions">
        <RouterLink class="btn" data-testid="interaction-report-link" :to="{ name: 'report', params: { reportId }, query: linkQuery }">
          {{ t("interaction.openReport") }}
        </RouterLink>
        <RouterLink
          class="btn btn--quiet"
          data-testid="interaction-process-link"
          :to="{ name: 'process', params: { projectId: report.project_id }, query: demo ? { example: '1', step: '5' } : {} }"
        >
          {{ t("report.backToProject") }}
        </RouterLink>
      </div>
    </header>
    <StateNotice v-if="notice" data-testid="interaction-view-notice" :variant="notice.variant" :title="notice.title" :body="notice.body" />
    <StateNotice v-else-if="missingExample" variant="empty" data-testid="interaction-view-missing" :title="t('report.notExample')" />
    <StateNotice v-else-if="loading" compact variant="loading" :title="t('common.loading')" />
    <InteractionPanels
      v-if="report"
      :key="report.report_id"
      :project-id="report.project_id"
      :demo="demo"
      :initial-run-id="report.run_id"
      :link-query="linkQuery"
    />
  </div>
</template>

<style scoped>
.interaction-view {
  display: grid;
  gap: var(--c2p-space-6);
}

.interaction-view__header {
  display: grid;
  gap: var(--c2p-space-3);
  padding-top: var(--c2p-space-4);
  border-top: var(--c2p-rule-width) solid var(--c2p-rule-strong);
}

.interaction-view__id {
  margin-left: var(--c2p-space-2);
  color: var(--c2p-text);
  text-transform: none;
  overflow-wrap: anywhere;
}

.interaction-view__title {
  font-size: var(--c2p-text-xl);
  font-weight: 700;
  letter-spacing: -0.02em;
}

.interaction-view__description {
  max-width: 44rem;
  color: var(--c2p-text-muted);
}
</style>
