<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { ForecastReportBody } from "../../api/types";
import { formatMarker, formatMetric, type MetricText } from "../../composables/metric";
import DistributionChart, { type ChartSeries } from "../forecast/DistributionChart.vue";
import EffectBadge from "../forecast/EffectBadge.vue";
import { describeEvidence, describeIntervention, formatTimestamp, shortHash } from "../forecast/format";
import ProvenancePanel from "../forecast/ProvenancePanel.vue";
import UncertaintyPanel from "../forecast/UncertaintyPanel.vue";

/**
 * A forecast report as the server serialized it (guide §10.9): target,
 * horizon, information cutoff, data origin, model version, validation
 * status, the server's statements verbatim, distributions by horizon, the
 * causal assumptions and the evidence the run is conditioned on (kept apart
 * from source-backed counts), and validation
 * metrics. A metric that is `"missing"` reads "missing" and `"+inf"` reads as
 * an impossible outcome; neither is ever shown as a number. The UI composes
 * no numeric claim of its own.
 */
const props = withDefaults(defineProps<{ report: ForecastReportBody; headingTag?: "h2" | "h3" }>(), { headingTag: "h3" });
const { t, locale } = useI18n();

/** The evidence every scenario is conditioned on (an older server sends none). */
const evidence = computed(() => props.report.assumptions?.evidence ?? []);
const conditioned = computed(() => props.report.conditioning === "evidence" || evidence.value.length > 0);

const series = computed<ChartSeries[]>(() =>
  props.report.forecasts.map((f, i) => ({
    id: `${f.scenario_id}-${i}`,
    label: f.is_baseline
      ? t(conditioned.value ? "forecast.series.conditionalBaseline" : "forecast.series.baseline", { scenario: f.scenario_id })
      : t(conditioned.value ? "forecast.series.conditionalIntervention" : "forecast.series.intervention", { scenario: f.scenario_id }),
    tone: f.is_baseline ? "baseline" : "intervention",
    byHorizon: f.by_horizon,
  })),
);

const domain = computed(() => props.report.forecasts[0]?.by_horizon[0]?.distribution.map((e) => e.value) ?? null);

const statements = computed(() => props.report.statements ?? []);

interface MetricRow {
  key: string;
  label: string;
  reading: MetricText;
}

const metrics = computed<MetricRow[]>(() => {
  const v = props.report.validation;
  const calibration: MetricText =
    v.calibration === "missing" || typeof v.calibration !== "object" || v.calibration === null
      ? { kind: "missing", text: t("metric.missing") }
      : formatMetric(v.calibration.expected_calibration_error, t);
  return [
    { key: "nll", label: t("reportBody.metrics.nll"), reading: formatMetric(v.nll_bits, t) },
    { key: "brier", label: t("reportBody.metrics.brier"), reading: formatMetric(v.brier, t) },
    { key: "calibration", label: t("reportBody.metrics.calibration"), reading: calibration },
    { key: "parameter-uncertainty", label: t("reportBody.metrics.parameterUncertainty"), reading: formatMarker(v.parameter_uncertainty, t) },
    { key: "model-error", label: t("reportBody.metrics.modelError"), reading: formatMarker(v.model_error, t) },
  ];
});

const calibrationBins = computed(() => {
  const c = props.report.validation.calibration;
  return typeof c === "object" && c !== null ? c.bins : [];
});

const hashes = computed(() =>
  (
    [
      ["plan_version", props.report.plan_version],
      ["graph_hash", props.report.graph_hash],
      ["model_hash", props.report.model_hash],
      ["intervened_model_hash", props.report.intervened_model_hash],
    ] as const
  ).filter(([, value]) => value !== undefined),
);

function formatPrior(values: number[]): string {
  return `[${values.join(", ")}]`;
}
</script>

<template>
  <article class="report-body" data-testid="report-body" :data-report-id="report.report_id">
    <header class="report-body__header">
      <p class="eyebrow">
        {{ t("reportBody.eyebrow") }} <span class="mono report-body__id">{{ report.report_id }}</span>
      </p>
      <component :is="headingTag" class="report-body__title">
        {{ t("reportBody.title", { variable: report.target_variable, entity: report.target_entity_id }) }}
      </component>
      <div class="report-body__badges">
        <EffectBadge :status="report.effect_status ?? null" :conditioned="conditioned" />
        <span v-if="report.query_kind && report.query_kind !== 'conditional'" class="badge">{{ t(`forecast.queryKind.${report.query_kind}`) }}</span>
        <span v-if="conditioned" class="badge" data-testid="report-conditional-badge">{{ t("forecast.queryKind.conditional") }}</span>
      </div>
    </header>

    <dl class="facts report-body__facts" data-testid="report-facts">
      <div>
        <dt>{{ t("reportBody.facts.target") }}</dt>
        <dd class="mono" data-testid="report-target">{{ report.target_variable }} · {{ report.target_entity_id }}</dd>
      </div>
      <div>
        <dt>{{ t("reportBody.facts.horizon") }}</dt>
        <dd class="mono" data-testid="report-horizon">
          {{
            report.step_minutes
              ? t("reportBody.facts.horizonMinutes", { steps: report.horizon_steps, minutes: report.step_minutes })
              : t("reportBody.facts.horizonSteps", { steps: report.horizon_steps })
          }}
        </dd>
      </div>
      <div>
        <dt>{{ t("reportBody.facts.cutoff") }}</dt>
        <dd class="mono" data-testid="report-cutoff">{{ report.cutoff ?? t("forecast.none") }}</dd>
      </div>
      <div>
        <dt>{{ t("reportBody.facts.origin") }}</dt>
        <dd class="mono" data-testid="report-origin">{{ report.origin }}</dd>
      </div>
      <div>
        <dt>{{ t("reportBody.facts.modelVersion") }}</dt>
        <dd class="mono" data-testid="report-model-version" :title="report.model_version">{{ shortHash(report.model_version) }}</dd>
      </div>
      <div>
        <dt>{{ t("reportBody.facts.validationStatus") }}</dt>
        <dd class="mono" data-testid="report-validation-status">{{ report.validation.status }}</dd>
      </div>
      <div>
        <dt>{{ t("reportBody.facts.uncertaintyMethod") }}</dt>
        <dd class="mono">{{ report.uncertainty?.method ?? t("metric.missing") }}</dd>
      </div>
      <div>
        <dt>{{ t("reportBody.facts.run") }}</dt>
        <dd class="mono">{{ report.run_id }}</dd>
      </div>
      <div>
        <dt>{{ t("reportBody.facts.created") }}</dt>
        <dd class="mono">{{ formatTimestamp(report.created_at, locale) }}</dd>
      </div>
    </dl>

    <section class="step-section" data-testid="report-statements" :aria-label="t('reportBody.statements.heading')">
      <div class="step-section__bar">
        <h4 class="eyebrow">{{ t("reportBody.statements.heading") }}</h4>
      </div>
      <p class="step-hint report-body__small">{{ t("reportBody.statements.verbatim") }}</p>
      <ol v-if="statements.length" class="statements">
        <li
          v-for="(s, index) in statements"
          :key="index"
          class="statements__item"
          :class="`statements__item--${s.kind}`"
          data-testid="report-statement"
          :data-kind="s.kind"
        >
          <span class="statements__kind mono" aria-hidden="true">{{ t(`reportBody.statements.kind.${s.kind}`) }}</span>
          <q class="statements__text" data-testid="statement-text">{{ s.text }}</q>
        </li>
      </ol>
      <p v-else class="step-hint" data-testid="no-statements">{{ t("reportBody.statements.none") }}</p>
      <p v-if="report.statement_policy" class="step-hint report-body__small" data-testid="statement-policy">
        {{ report.statement_policy }}
      </p>
    </section>

    <section class="step-section" data-testid="report-distributions" :aria-label="t('reportBody.distributions')">
      <div class="step-section__bar">
        <h4 class="eyebrow">{{ t("reportBody.distributions") }}</h4>
      </div>
      <DistributionChart
        :series="series"
        :domain="domain"
        :step-minutes="report.step_minutes ?? null"
        :title="t('forecast.chart.title', { variable: report.target_variable, entity: report.target_entity_id })"
      />
    </section>

    <section class="step-section" data-testid="report-validation" :aria-label="t('reportBody.metrics.heading')">
      <div class="step-section__bar">
        <h4 class="eyebrow">{{ t("reportBody.metrics.heading") }}</h4>
      </div>
      <dl class="metrics">
        <div v-for="m in metrics" :key="m.key" class="metrics__item" :data-testid="`metric-${m.key}`" :data-kind="m.reading.kind">
          <dt>{{ m.label }}</dt>
          <dd :class="{ 'is-missing': m.reading.kind === 'missing', 'is-infinite': m.reading.kind === 'infinite' }">
            <span class="metrics__value" data-testid="metric-value">{{ m.reading.text }}</span>
            <span v-if="m.reading.kind === 'infinite'" class="metrics__note" data-testid="metric-impossible">
              {{ t("reportBody.metrics.impossible") }}
            </span>
          </dd>
        </div>
      </dl>
      <div v-if="calibrationBins.length" class="table-scroll">
        <table class="data-table" data-testid="calibration-bins">
          <thead>
            <tr>
              <th scope="col">{{ t("reportBody.metrics.predicted") }}</th>
              <th scope="col">{{ t("reportBody.metrics.observed") }}</th>
              <th scope="col">{{ t("reportBody.metrics.count") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(bin, index) in calibrationBins" :key="index">
              <td class="mono">{{ formatMetric(bin.predicted, t).text }}</td>
              <td class="mono">{{ formatMetric(bin.observed, t).text }}</td>
              <td class="mono">{{ bin.count }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="step-hint report-body__small">{{ t("reportBody.metrics.note") }}</p>
    </section>

    <UncertaintyPanel v-if="report.uncertainty" :uncertainty="report.uncertainty" />

    <section class="step-section" data-testid="report-assumptions" :aria-label="t('reportBody.assumptions.heading')">
      <div class="step-section__bar">
        <h4 class="eyebrow">{{ t("reportBody.assumptions.heading") }}</h4>
      </div>
      <template v-if="report.assumptions">
        <dl class="facts">
          <div>
            <dt>{{ t("reportBody.assumptions.causalBasis") }}</dt>
            <dd class="mono" data-testid="assumption-causal-basis">{{ report.assumptions.causal_basis.join(", ") || t("forecast.none") }}</dd>
          </div>
        </dl>
        <ProvenancePanel :kernels="report.assumptions.kernels" :heading="t('reportBody.assumptions.kernels')" />
        <div class="report-body__sub">
          <h5 class="eyebrow">{{ t("reportBody.assumptions.priors") }}</h5>
          <div v-if="report.assumptions.priors.length" class="table-scroll">
            <table class="data-table" data-testid="assumption-priors">
              <thead>
                <tr>
                  <th scope="col">{{ t("reportBody.assumptions.key") }}</th>
                  <th scope="col">{{ t("reportBody.assumptions.distribution") }}</th>
                  <th scope="col">{{ t("reportBody.assumptions.origin") }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(prior, index) in report.assumptions.priors" :key="index">
                  <td class="mono">{{ prior.key.join(" · ") }}</td>
                  <td class="mono">{{ formatPrior(prior.distribution) }}</td>
                  <td class="mono">{{ prior.origin }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p v-else class="step-hint">{{ t("forecast.none") }}</p>
        </div>
        <div class="report-body__sub">
          <h5 class="eyebrow">{{ t("reportBody.assumptions.interventions") }}</h5>
          <ul v-if="report.assumptions.interventions.length" class="report-body__list" data-testid="assumption-interventions">
            <li v-for="(iv, index) in report.assumptions.interventions" :key="index" class="mono">{{ describeIntervention(iv) }}</li>
          </ul>
          <p v-else class="step-hint" data-testid="assumption-no-interventions">{{ t("reportBody.assumptions.noInterventions") }}</p>
        </div>
        <div class="report-body__sub">
          <h5 class="eyebrow">{{ t("reportBody.assumptions.evidence") }}</h5>
          <template v-if="evidence.length">
            <ul class="report-body__list" data-testid="assumption-evidence">
              <li v-for="(e, index) in evidence" :key="index" class="mono" data-testid="assumption-evidence-item">{{ describeEvidence(e) }}</li>
            </ul>
            <p class="step-hint report-body__small">{{ t("forecast.form.evidence.rule") }}</p>
          </template>
          <p v-else class="step-hint" data-testid="assumption-no-evidence">{{ t("reportBody.assumptions.noEvidence") }}</p>
        </div>
        <div v-if="report.assumptions.notes.length" class="report-body__sub">
          <h5 class="eyebrow">{{ t("reportBody.assumptions.notes") }}</h5>
          <ul class="report-body__list report-body__notes" data-testid="assumption-notes">
            <li v-for="(note, index) in report.assumptions.notes" :key="index">{{ note }}</li>
          </ul>
        </div>
      </template>
      <p v-else class="step-hint" data-testid="no-assumptions">{{ t("reportBody.assumptions.none") }}</p>
    </section>

    <section v-if="report.source_backed" class="step-section" data-testid="report-source-backed" :aria-label="t('reportBody.sourceBacked.heading')">
      <div class="step-section__bar">
        <h4 class="eyebrow">{{ t("reportBody.sourceBacked.heading") }}</h4>
      </div>
      <dl class="facts">
        <div>
          <dt>{{ t("reportBody.sourceBacked.evidence") }}</dt>
          <dd class="mono">{{ report.source_backed.evidence_count }}</dd>
        </div>
        <div>
          <dt>{{ t("reportBody.sourceBacked.claims") }}</dt>
          <dd class="mono">{{ report.source_backed.claim_count }}</dd>
        </div>
      </dl>
      <p class="step-hint report-body__small">{{ t("reportBody.sourceBacked.note") }}</p>
    </section>

    <details v-if="hashes.length" class="report-body__hashes" data-testid="report-hashes">
      <summary class="eyebrow">{{ t("forecast.result.references") }}</summary>
      <dl class="facts">
        <div v-for="[name, value] in hashes" :key="name">
          <dt class="mono">{{ name }}</dt>
          <dd class="mono" :title="value ?? ''">{{ value ? shortHash(value) : t("forecast.none") }}</dd>
        </div>
      </dl>
    </details>
  </article>
</template>

<style scoped>
.report-body {
  display: grid;
  gap: var(--c2p-space-5);
  min-width: 0;
}

.report-body__header {
  display: grid;
  gap: var(--c2p-space-2);
}

.report-body__id {
  margin-left: var(--c2p-space-1);
  color: var(--c2p-text);
  text-transform: none;
  overflow-wrap: anywhere;
}

.report-body__title {
  font-size: var(--c2p-text-lg);
  font-weight: 600;
  overflow-wrap: anywhere;
}

.report-body__badges {
  display: flex;
  flex-wrap: wrap;
  gap: var(--c2p-space-2);
}

.report-body__small {
  font-size: var(--c2p-text-xs);
}

.statements {
  display: grid;
  gap: var(--c2p-space-2);
}

.statements__item {
  display: grid;
  grid-template-columns: 6.5rem minmax(0, 1fr);
  gap: var(--c2p-space-1) var(--c2p-space-3);
  padding: var(--c2p-space-2) 0;
  border-bottom: var(--c2p-rule-width) solid var(--c2p-rule);
  font-size: var(--c2p-text-sm);
}

@media (max-width: 40rem) {
  .statements__item {
    grid-template-columns: minmax(0, 1fr);
  }
}

.statements__kind {
  color: var(--c2p-text-muted);
  font-size: var(--c2p-text-xs);
  text-transform: uppercase;
}

.statements__text {
  quotes: none;
  overflow-wrap: anywhere;
}

.statements__item--comparison .statements__text {
  font-style: italic;
}

.metrics {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 10rem), 1fr));
  margin: 0;
  border-top: var(--c2p-rule-width) solid var(--c2p-rule);
  border-left: var(--c2p-rule-width) solid var(--c2p-rule);
}

.metrics__item {
  display: grid;
  gap: var(--c2p-space-1);
  align-content: start;
  min-width: 0;
  padding: var(--c2p-space-3) var(--c2p-space-4);
  border-right: var(--c2p-rule-width) solid var(--c2p-rule);
  border-bottom: var(--c2p-rule-width) solid var(--c2p-rule);
}

.metrics__item dt {
  font-family: var(--c2p-font-mono);
  font-size: var(--c2p-text-xs);
  letter-spacing: var(--c2p-tracking-mono);
  text-transform: uppercase;
  color: var(--c2p-text-muted);
}

.metrics__item dd {
  display: grid;
  gap: var(--c2p-space-1);
  margin: 0;
}

.metrics__value {
  font-size: var(--c2p-text-md);
  font-weight: 600;
  overflow-wrap: anywhere;
}

.metrics__note {
  color: var(--c2p-text-muted);
  font-size: var(--c2p-text-xs);
}

.is-infinite .metrics__value {
  color: var(--c2p-danger);
}

.report-body__sub {
  display: grid;
  gap: var(--c2p-space-2);
}

.report-body__list {
  display: grid;
  gap: var(--c2p-space-1);
  font-size: var(--c2p-text-sm);
  overflow-wrap: anywhere;
}

.report-body__list .mono {
  font-size: var(--c2p-text-xs);
}

.report-body__notes li {
  padding-left: var(--c2p-space-3);
  border-left: 2px solid var(--c2p-rule);
  color: var(--c2p-text-muted);
}

.report-body__hashes summary {
  cursor: pointer;
}

.report-body__hashes .facts {
  margin-top: var(--c2p-space-3);
}
</style>
