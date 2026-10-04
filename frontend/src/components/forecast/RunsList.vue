<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { ForecastRunSummary } from "../../api/types";
import EffectBadge from "./EffectBadge.vue";
import { formatTimestamp } from "./format";

/** A project's forecast runs, newest first; one can be selected. */
const props = withDefaults(
  defineProps<{
    runs: ForecastRunSummary[];
    selectedId: string | null;
    /** Extra query for report links (the offline example keeps `example=1`). */
    linkQuery?: Record<string, string>;
  }>(),
  { linkQuery: () => ({}) },
);
const emit = defineEmits<{ select: [runId: string] }>();
const { t, locale } = useI18n();

/** Newest first, whatever order the list arrived in. */
const ordered = computed(() =>
  [...props.runs].sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0)),
);
</script>

<template>
  <ol class="runs" data-testid="runs-list">
    <li
      v-for="run in ordered"
      :key="run.run_id"
      class="runs__item"
      :class="{ 'is-selected': run.run_id === selectedId }"
      data-testid="run-row"
      :data-run-id="run.run_id"
    >
      <button
        type="button"
        class="runs__select"
        :aria-pressed="run.run_id === selectedId"
        data-testid="select-run"
        @click="emit('select', run.run_id)"
      >
        <span class="runs__main">
          <span class="mono runs__scenario">{{ run.scenario_id }}</span>
          <span class="runs__target mono">
            {{ t("forecast.runs.target", { variable: run.target_variable, entity: run.target_entity_id, steps: run.horizon_steps }) }}
          </span>
        </span>
        <span class="runs__meta">
          <EffectBadge :status="run.effect_status ?? (run.query_kind === 'interventional' ? 'model_based_intervention' : 'not_applicable')" />
          <span v-if="run.status !== 'completed'" class="badge">{{ t(`forecast.runStatus.${run.status}`) }}</span>
          <span class="mono runs__date">{{ formatTimestamp(run.created_at, locale) }}</span>
          <span class="mono runs__id" :title="run.run_id">{{ run.run_id }}</span>
        </span>
      </button>
      <RouterLink
        v-if="run.report_id"
        class="runs__report mono"
        data-testid="run-report-link"
        :to="{ name: 'report', params: { reportId: run.report_id }, query: linkQuery }"
      >
        {{ t("forecast.runs.report") }}
      </RouterLink>
    </li>
  </ol>
</template>

<style scoped>
.runs {
  display: grid;
  border-top: var(--c2p-rule-width) solid var(--c2p-rule);
}

.runs__item {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: var(--c2p-space-2);
  border-bottom: var(--c2p-rule-width) solid var(--c2p-rule);
  border-left: 3px solid transparent;
}

.runs__item.is-selected {
  border-left-color: var(--c2p-ink);
  background: var(--c2p-surface);
}

.runs__select {
  display: grid;
  gap: var(--c2p-space-1);
  min-width: 0;
  padding: var(--c2p-space-2) var(--c2p-space-3);
  border: 0;
  background: transparent;
  text-align: left;
  cursor: pointer;
}

.runs__main,
.runs__meta {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--c2p-space-1) var(--c2p-space-3);
  min-width: 0;
}

.runs__scenario {
  font-size: var(--c2p-text-sm);
  font-weight: 600;
  overflow-wrap: anywhere;
}

.runs__target,
.runs__date,
.runs__id {
  color: var(--c2p-text-muted);
  font-size: var(--c2p-text-xs);
  overflow-wrap: anywhere;
}

.runs__report {
  padding: 0 var(--c2p-space-3);
  font-size: var(--c2p-text-xs);
  white-space: nowrap;
}
</style>
