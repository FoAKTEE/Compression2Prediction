<script setup lang="ts">
import { computed, useId } from "vue";
import { useI18n } from "vue-i18n";
import type { HorizonDistribution } from "../../api/types";
import { clampProbability, formatPercent } from "../../composables/probability";

/** Series tones map to fixed color tokens, so a series keeps its color in every chart. */
export type SeriesTone = "baseline" | "intervention" | "run-a" | "run-b";

export interface ChartSeries {
  id: string;
  label: string;
  tone: SeriesTone;
  byHorizon: HorizonDistribution[];
}

const props = withDefaults(
  defineProps<{
    series: ChartSeries[];
    title: string;
    /** Horizon steps to draw; every step present in any series by default. */
    steps?: number[] | null;
    /** The target's ordered domain; the order of first appearance by default. */
    domain?: string[] | null;
    stepMinutes?: number | null;
  }>(),
  { steps: null, domain: null, stepMinutes: null },
);

const { t } = useI18n();
const uid = useId();
const titleId = `${uid}-title`;
const descId = `${uid}-desc`;

/** Labelled ticks of the fixed 0-1 probability axis; hairline gridlines also mark 25% and 75%. */
const TICKS = [0, 0.5, 1];

/** Second-slot tones carry a hatch, so the two series differ by pattern as well as hue. */
const HATCHED: ReadonlySet<SeriesTone> = new Set(["intervention", "run-b"]);

const domainValues = computed(() => {
  if (props.domain && props.domain.length) return props.domain;
  const seen: string[] = [];
  for (const s of props.series) {
    for (const h of s.byHorizon) for (const e of h.distribution) if (!seen.includes(e.value)) seen.push(e.value);
  }
  return seen;
});

const stepList = computed(() => {
  if (props.steps && props.steps.length) return props.steps;
  const all = new Set<number>();
  for (const s of props.series) for (const h of s.byHorizon) all.add(h.horizon_step);
  return [...all].sort((a, b) => a - b);
});

function probability(series: ChartSeries, step: number, value: string): number | null {
  const entry = series.byHorizon.find((h) => h.horizon_step === step)?.distribution.find((e) => e.value === value);
  return entry === undefined ? null : entry.probability;
}

function stepTitle(step: number): string {
  return props.stepMinutes
    ? t("forecast.chart.stepMinutes", { step, minutes: step * props.stepMinutes })
    : t("forecast.chart.step", { step });
}

function percentText(p: number | null): string {
  return p === null ? t("metric.missing") : formatPercent(p);
}

const panels = computed(() =>
  stepList.value.map((step) => ({
    step,
    title: stepTitle(step),
    groups: domainValues.value.map((value) => ({
      value,
      bars: props.series.map((s) => {
        const p = probability(s, step, value);
        return {
          series: s,
          probability: p,
          width: p === null ? "0%" : `${clampProbability(p) * 100}%`,
          label: percentText(p),
          hatched: HATCHED.has(s.tone),
        };
      }),
    })),
  })),
);

/** A text equivalent of every value, read as the chart's description. */
const summary = computed(() => {
  const steps = panels.value.map((panel) => {
    const series = props.series.map((s, i) =>
      t("forecast.chart.summarySeries", {
        series: s.label,
        values: panel.groups.map((g) => `${g.value} ${g.bars[i]?.label ?? ""}`).join(", "),
      }),
    );
    return t("forecast.chart.summaryStep", { step: panel.title, values: series.join("; ") });
  });
  return [t("forecast.chart.summary"), ...steps].join(" ");
});
</script>

<template>
  <figure class="dist-chart" :aria-labelledby="titleId" :aria-describedby="descId" data-testid="distribution-chart">
    <figcaption :id="titleId" class="dist-chart__title">{{ title }}</figcaption>
    <p :id="descId" class="sr-only" data-testid="chart-description">{{ summary }}</p>

    <ul v-if="series.length > 1" class="dist-chart__legend" :aria-label="t('forecast.chart.legend')" data-testid="chart-legend">
      <li v-for="s in series" :key="s.id" class="dist-chart__legend-item" :data-series="s.id">
        <span
          class="dist-chart__swatch"
          :class="[`tone-${s.tone}`, { 'is-hatched': HATCHED.has(s.tone) }]"
          aria-hidden="true"
        ></span>
        <span>{{ s.label }}</span>
      </li>
    </ul>

    <div class="dist-chart__panels" aria-hidden="true">
      <section
        v-for="panel in panels"
        :key="panel.step"
        class="dist-chart__panel"
        data-testid="chart-step"
        :data-step="panel.step"
      >
        <h4 class="dist-chart__step mono">{{ panel.title }}</h4>
        <div class="dist-chart__grid">
          <template v-for="group in panel.groups" :key="group.value">
            <span class="dist-chart__outcome mono" :style="{ gridRow: `span ${group.bars.length}` }">{{ group.value }}</span>
            <template v-for="bar in group.bars" :key="bar.series.id">
              <span class="dist-chart__track">
                <span
                  class="dist-chart__bar"
                  :class="[`tone-${bar.series.tone}`, { 'is-hatched': bar.hatched }]"
                  :style="{ width: bar.width }"
                  :title="`${bar.series.label} · ${group.value}: ${bar.label}`"
                  data-testid="chart-bar"
                  :data-series="bar.series.id"
                  :data-value="group.value"
                ></span>
              </span>
              <span
                class="dist-chart__pct mono"
                data-testid="chart-label"
                :data-series="bar.series.id"
                :data-value="group.value"
              >{{ bar.label }}</span>
            </template>
            <span class="dist-chart__gap" aria-hidden="true"></span>
          </template>
          <span class="dist-chart__axis-spacer"></span>
          <span class="dist-chart__axis">
            <span v-for="tick in TICKS" :key="tick" class="dist-chart__tick mono" :style="{ left: `${tick * 100}%` }">
              {{ formatPercent(tick) }}
            </span>
          </span>
        </div>
      </section>
    </div>
    <p class="dist-chart__axis-label">{{ t("forecast.chart.axis") }}</p>

    <details class="dist-chart__table">
      <summary class="mono">{{ t("forecast.chart.table") }}</summary>
      <div class="table-scroll">
        <table class="data-table" data-testid="chart-table">
          <thead>
            <tr>
              <th scope="col">{{ t("forecast.chart.tableStep") }}</th>
              <th scope="col">{{ t("forecast.chart.tableOutcome") }}</th>
              <th v-for="s in series" :key="s.id" scope="col">{{ s.label }}</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="panel in panels" :key="panel.step">
              <tr v-for="group in panel.groups" :key="group.value">
                <td class="mono">{{ panel.step }}</td>
                <td class="mono">{{ group.value }}</td>
                <td v-for="bar in group.bars" :key="bar.series.id" class="mono">{{ bar.label }}</td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
    </details>
  </figure>
</template>

<style scoped>
.dist-chart {
  display: grid;
  gap: var(--c2p-space-3);
  min-width: 0;
  margin: 0;
}

.dist-chart__title {
  font-size: var(--c2p-text-sm);
  font-weight: 600;
  overflow-wrap: anywhere;
}

.dist-chart__legend {
  display: flex;
  flex-wrap: wrap;
  gap: var(--c2p-space-1) var(--c2p-space-4);
  font-size: var(--c2p-text-xs);
  color: var(--c2p-text-muted);
}

.dist-chart__legend-item {
  display: inline-flex;
  align-items: center;
  gap: var(--c2p-space-2);
  overflow-wrap: anywhere;
}

.dist-chart__swatch {
  flex-shrink: 0;
  width: 1.25rem;
  height: 0.75rem;
  border-radius: 0 4px 4px 0;
}

.dist-chart__panels {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 19rem), 1fr));
  gap: var(--c2p-space-4) var(--c2p-space-6);
}

.dist-chart__panel {
  display: grid;
  gap: var(--c2p-space-2);
  align-content: start;
  min-width: 0;
}

.dist-chart__step {
  color: var(--c2p-text-muted);
  font-size: var(--c2p-text-xs);
  font-weight: 600;
}

/* Outcome label | bar track | value label; one row per series, a spacer row between outcomes. */
.dist-chart__grid {
  display: grid;
  grid-template-columns: minmax(4.5rem, 7.5rem) minmax(0, 1fr) 3.25rem;
  column-gap: var(--c2p-space-2);
  row-gap: 2px;
  align-items: center;
}

.dist-chart__outcome {
  grid-column: 1;
  align-self: center;
  color: var(--c2p-text);
  font-size: var(--c2p-text-xs);
  overflow-wrap: anywhere;
  line-height: 1.25;
}

.dist-chart__track {
  grid-column: 2;
  position: relative;
  display: block;
  height: 14px;
  border-left: 1px solid var(--c2p-rule-strong);
  background-image: linear-gradient(to right, var(--c2p-rule) 1px, transparent 1px);
  background-size: 25% 100%;
  box-shadow: inset -1px 0 0 var(--c2p-rule);
}

.dist-chart__bar {
  position: absolute;
  inset: 0 auto 0 0;
  display: block;
  max-width: 100%;
  border-radius: 0 4px 4px 0;
  background-color: var(--bar);
}

.dist-chart__pct {
  grid-column: 3;
  color: var(--c2p-text);
  font-size: var(--c2p-text-xs);
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.dist-chart__gap {
  grid-column: 1 / -1;
  height: var(--c2p-space-2);
}

.dist-chart__axis-spacer {
  grid-column: 1;
}

.dist-chart__axis {
  grid-column: 2;
  position: relative;
  height: 1.1rem;
}

.dist-chart__tick {
  position: absolute;
  top: 0;
  color: var(--c2p-text-faint);
  font-size: 0.6875rem;
  transform: translateX(-50%);
  white-space: nowrap;
}

.dist-chart__tick:first-child {
  transform: none;
}

.dist-chart__tick:last-child {
  transform: translateX(-100%);
}

.dist-chart__axis-label {
  color: var(--c2p-text-faint);
  font-size: var(--c2p-text-xs);
}

.tone-baseline {
  --bar: var(--c2p-series-baseline);
}

.tone-intervention {
  --bar: var(--c2p-series-intervention);
}

.tone-run-a {
  --bar: var(--c2p-series-run-a);
}

.tone-run-b {
  --bar: var(--c2p-series-run-b);
}

.dist-chart__swatch {
  background-color: var(--bar);
}

/* The 45° hatch: the second series' secondary encoding, in legend and bars alike. */
.is-hatched {
  background-image: repeating-linear-gradient(
    45deg,
    var(--c2p-series-hatch) 0 2px,
    transparent 2px 6px
  );
}

@media (forced-colors: active) {
  .dist-chart__bar,
  .dist-chart__swatch {
    background-color: CanvasText;
    forced-color-adjust: none;
  }

  .is-hatched {
    background-image: repeating-linear-gradient(45deg, Canvas 0 2px, transparent 2px 6px);
  }
}

.dist-chart__table summary {
  color: var(--c2p-text-muted);
  font-size: var(--c2p-text-xs);
  cursor: pointer;
}

.dist-chart__table .table-scroll {
  margin-top: var(--c2p-space-2);
}
</style>
