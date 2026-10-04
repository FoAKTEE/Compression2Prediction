<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { ForecastResult } from "../../api/types";
import DistributionChart, { type ChartSeries } from "./DistributionChart.vue";
import EffectBadge from "./EffectBadge.vue";
import { describeIntervention, formatTimestamp, shortHash } from "./format";
import ProvenancePanel from "./ProvenancePanel.vue";
import UncertaintyPanel from "./UncertaintyPanel.vue";

/**
 * One forecast run as the server returned it: baseline and intervention
 * distributions side by side, the effect status, provenance, uncertainty
 * metadata, and the exact model and run references.
 */
const props = withDefaults(
  defineProps<{
    result: ForecastResult;
    /** The what-if panel shows the chart, badge, and uncertainty only. */
    compact?: boolean;
    linkQuery?: Record<string, string>;
  }>(),
  { compact: false, linkQuery: () => ({}) },
);
const { t, locale } = useI18n();

/** Baseline first, intervention second, each with its fixed tone. */
const series = computed<ChartSeries[]>(() => {
  const r = props.result;
  const out: ChartSeries[] = [
    {
      id: "baseline",
      label: t("forecast.series.baseline", { scenario: r.baseline.scenario_id }),
      tone: "baseline",
      byHorizon: r.baseline.by_horizon,
    },
  ];
  if (r.intervention) {
    out.push({
      id: "intervention",
      label: t("forecast.series.intervention", { scenario: r.intervention.scenario_id }),
      tone: "intervention",
      byHorizon: r.intervention.by_horizon,
    });
  }
  return out;
});

const chartTitle = computed(() =>
  t("forecast.chart.title", { variable: props.result.target_variable, entity: props.result.target_entity_id }),
);

const hashes = computed(() => {
  const r = props.result;
  return [
    ["plan_version", r.plan_version],
    ["graph_hash", r.graph_hash],
    ["model_hash", r.model_hash],
    ["intervened_model_hash", r.intervened_model_hash],
    ["manifest_hash", r.manifest_hash],
  ] as const;
});
</script>

<template>
  <article class="result" data-testid="forecast-result" :data-run-id="result.run_id">
    <header class="result__header">
      <div class="result__title">
        <span class="mono result__scenario">{{ result.scenario_id }}</span>
        <EffectBadge :status="result.effect_status" />
        <span class="badge">{{ t(`forecast.queryKind.${result.query_kind}`) }}</span>
        <span v-if="result.status !== 'completed'" class="badge">{{ t(`forecast.runStatus.${result.status}`) }}</span>
      </div>
      <p class="result__meta mono">
        <span :title="result.run_id">{{ result.run_id }}</span>
        <span>{{ formatTimestamp(result.created_at, locale) }}</span>
        <RouterLink
          v-if="result.report_id"
          data-testid="result-report-link"
          :to="{ name: 'report', params: { reportId: result.report_id }, query: linkQuery }"
        >
          {{ t("forecast.result.openReport") }}
        </RouterLink>
      </p>
      <p v-if="result.effect_status === 'model_based_intervention'" class="step-hint result__effect-note">
        {{ t("forecast.effect.note") }}
      </p>
    </header>

    <ul v-if="result.interventions.length" class="result__interventions" data-testid="result-interventions">
      <li v-for="(iv, index) in result.interventions" :key="index" class="chip">
        <span class="chip__key">{{ t("forecast.result.held") }}</span>{{ describeIntervention(iv) }}
      </li>
    </ul>

    <DistributionChart
      :series="series"
      :title="chartTitle"
      :domain="result.prediction_scope?.domain?.values ?? null"
      :step-minutes="result.prediction_scope?.step_minutes ?? null"
    />

    <UncertaintyPanel :uncertainty="result.uncertainty" />

    <template v-if="!compact">
      <ProvenancePanel
        :kernels="result.provenance?.kernels ?? []"
        :data-origin="result.provenance?.data_origin"
        :parameter-origin="result.provenance?.parameter_origin"
        :validation-status="result.validation_status"
      />

      <details class="result__refs" data-testid="result-references">
        <summary class="eyebrow">{{ t("forecast.result.references") }}</summary>
        <dl class="facts">
          <div>
            <dt>{{ t("forecast.result.scopeScenario") }}</dt>
            <dd class="mono">{{ result.prediction_scope.scenario_id }}</dd>
          </div>
          <div>
            <dt>{{ t("forecast.result.cutoff") }}</dt>
            <dd class="mono" data-testid="result-cutoff">{{ result.prediction_scope.information_cutoff ?? t("forecast.none") }}</dd>
          </div>
          <div>
            <dt>{{ t("forecast.result.initialBelief") }}</dt>
            <dd class="mono">
              {{ result.prediction_scope.initial_belief.source }}
              <template v-if="result.prediction_scope.initial_belief.requested_ref">
                ({{ result.prediction_scope.initial_belief.requested_ref }})
              </template>
            </dd>
          </div>
          <div>
            <dt>{{ t("forecast.result.conditioning") }}</dt>
            <dd class="mono">{{ result.prediction_scope.conditioning }}</dd>
          </div>
          <div>
            <dt>{{ t("forecast.result.modelVersion") }}</dt>
            <dd class="mono" :title="result.model_version ?? ''">{{ shortHash(result.model_version) }}</dd>
          </div>
          <div>
            <dt>{{ t("forecast.result.worldVersion") }}</dt>
            <dd class="mono" :title="result.provenance.world_version">{{ shortHash(result.provenance.world_version) }}</dd>
          </div>
          <div v-for="[name, value] in hashes" :key="name">
            <dt class="mono">{{ name }}</dt>
            <dd class="mono" :title="value ?? ''">{{ value ? shortHash(value) : t("forecast.none") }}</dd>
          </div>
          <div>
            <dt>{{ t("forecast.result.repoSha") }}</dt>
            <dd class="mono">{{ shortHash(result.provenance.repo_sha) }}</dd>
          </div>
        </dl>
        <p class="step-hint">{{ result.prediction_scope.interpretation }}</p>
      </details>
    </template>
  </article>
</template>

<style scoped>
.result {
  display: grid;
  gap: var(--c2p-space-4);
  min-width: 0;
}

.result__header {
  display: grid;
  gap: var(--c2p-space-2);
}

.result__title {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--c2p-space-2) var(--c2p-space-3);
}

.result__scenario {
  font-size: var(--c2p-text-md);
  font-weight: 700;
  overflow-wrap: anywhere;
}

.result__meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--c2p-space-1) var(--c2p-space-4);
  color: var(--c2p-text-muted);
  font-size: var(--c2p-text-xs);
  overflow-wrap: anywhere;
}

.result__effect-note {
  font-size: var(--c2p-text-xs);
}

.result__interventions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--c2p-space-2);
}

.result__interventions .chip {
  white-space: normal;
  overflow-wrap: anywhere;
}

.result__refs {
  display: grid;
  gap: var(--c2p-space-3);
  padding-top: var(--c2p-space-3);
  border-top: var(--c2p-rule-width) solid var(--c2p-rule);
}

.result__refs summary {
  cursor: pointer;
}

.result__refs .facts {
  margin-top: var(--c2p-space-3);
}
</style>
