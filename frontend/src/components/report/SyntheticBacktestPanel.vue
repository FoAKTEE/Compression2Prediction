<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef } from "vue";
import { useI18n } from "vue-i18n";
import { normalizeError } from "../../api/client";
import { listSyntheticBacktests, runSyntheticBacktest } from "../../api/forecast";
import type { BacktestModelSummary, SyntheticBacktestRequest, SyntheticBacktestResponse } from "../../api/types";
import { errorNotice, type ErrorNoticeContent } from "../../composables/errorNotice";
import { formatMetric } from "../../composables/metric";
import { shortHash } from "../forecast/format";
import StateNotice from "../StateNotice.vue";

/**
 * Synthetic backtest of the guide §13 incident chain (D24). The server
 * generates episodes from the hand-specified kernels (origin `simulated`) and
 * scores the oracle and the baselines in bits per prediction by horizon. The
 * disclaimer stays next to the numbers: this checks the software pipeline on
 * simulated data and says nothing about real-world accuracy (guide §7.2).
 * The newest stored backtest of the project is shown when the step opens.
 */
const props = defineProps<{ projectId: string; demo: boolean }>();
const { t } = useI18n();

const episodes = ref(200);
const seed = ref(1);
const origins = ref(4);
const horizonsText = ref("1, 2, 3");

const result = shallowRef<SyntheticBacktestResponse | null>(null);
const running = ref(false);
const problem = ref<{ code: string; detail: string } | null>(null);
const notice = ref<ErrorNoticeContent | null>(null);
const formError = ref<string | null>(null);

let unmounted = false;
onBeforeUnmount(() => {
  unmounted = true;
});

async function loadLatest(): Promise<void> {
  if (props.demo) return;
  try {
    const stored = await listSyntheticBacktests(props.projectId);
    if (!unmounted && result.value === null && stored.length > 0) result.value = stored[0]!;
  } catch {
    // The history is optional; a new run still works.
  }
}

void loadLatest();

/** `"1, 2, 3"` -> [1, 2, 3]; null when an entry is not a positive integer. */
function parseHorizons(text: string): number[] | null {
  const parts = text.split(",").map((p) => p.trim()).filter((p) => p !== "");
  if (parts.length === 0 || !parts.every((p) => /^[0-9]+$/.test(p))) return null;
  const values = parts.map(Number);
  return values.every((v) => Number.isSafeInteger(v) && v >= 1) ? values : null;
}

async function onRun(): Promise<void> {
  if (props.demo || running.value) return;
  problem.value = null;
  notice.value = null;
  formError.value = null;
  const horizons = parseHorizons(horizonsText.value);
  if (horizons === null) {
    formError.value = t("step4.backtest.horizonsInvalid");
    return;
  }
  const request: SyntheticBacktestRequest = { episodes: episodes.value, seed: seed.value, origins: origins.value, horizons };
  running.value = true;
  try {
    const response = await runSyntheticBacktest(props.projectId, request);
    if (!unmounted) result.value = response;
  } catch (caught) {
    if (unmounted) return;
    const e = normalizeError(caught);
    if (e.status === 422) problem.value = { code: e.code, detail: e.message };
    else notice.value = errorNotice(e, t);
  } finally {
    if (!unmounted) running.value = false;
  }
}

/** The oracle first, then the baselines as served. */
const models = computed<BacktestModelSummary[]>(() => {
  const list = result.value?.models ?? [];
  return [...list.filter((m) => m.role === "oracle"), ...list.filter((m) => m.role !== "oracle")];
});

const horizons = computed(() => result.value?.horizons ?? []);

function bits(value: unknown): string {
  return formatMetric(value, t).text;
}

function cellKind(value: unknown): string {
  return formatMetric(value, t).kind;
}

const gateText = computed(() => {
  const g = result.value?.gate;
  if (!g) return "";
  return t(g.accepted ? "step4.backtest.gateAccepted" : "step4.backtest.gateRejected", {
    candidate: g.candidate,
    comparator: g.comparator,
    delta: bits(g.delta_bits),
    tau: g.tau_bits,
    reason: g.reason,
  });
});
</script>

<template>
  <section class="step-section backtest" data-testid="backtest-panel" :aria-label="t('step4.backtest.heading')">
    <div class="step-section__bar">
      <h3 class="eyebrow">{{ t("step4.backtest.heading") }}</h3>
      <span class="badge" data-testid="backtest-origin-badge">{{ t("step4.backtest.simulatedBadge") }}</span>
    </div>
    <p class="backtest__disclaimer" data-testid="backtest-disclaimer">{{ t("step4.backtest.disclaimer") }}</p>

    <p v-if="demo" class="step-hint" data-testid="backtest-demo">{{ t("step4.backtest.demo") }}</p>
    <form v-else class="backtest__form" data-testid="backtest-form" @submit.prevent="onRun">
      <div class="field">
        <label class="field__label" for="backtest-episodes">{{ t("step4.backtest.episodes") }}</label>
        <input id="backtest-episodes" v-model.number="episodes" class="field__input mono" type="number" min="2" step="1" data-testid="backtest-episodes" />
      </div>
      <div class="field">
        <label class="field__label" for="backtest-seed">{{ t("step4.backtest.seed") }}</label>
        <input id="backtest-seed" v-model.number="seed" class="field__input mono" type="number" min="0" step="1" data-testid="backtest-seed" />
      </div>
      <div class="field">
        <label class="field__label" for="backtest-origins">{{ t("step4.backtest.origins") }}</label>
        <input id="backtest-origins" v-model.number="origins" class="field__input mono" type="number" min="1" step="1" data-testid="backtest-origins" />
      </div>
      <div class="field">
        <label class="field__label" for="backtest-horizons">{{ t("step4.backtest.horizons") }}</label>
        <input id="backtest-horizons" v-model="horizonsText" class="field__input mono" type="text" data-testid="backtest-horizons" />
      </div>
      <div class="backtest__actions">
        <button type="submit" class="btn btn--primary" data-testid="backtest-run" :disabled="running">
          {{ running ? t("step4.backtest.running") : t("step4.backtest.run") }}
        </button>
      </div>
    </form>
    <p v-if="formError" class="field__error" data-testid="backtest-form-error">{{ formError }}</p>
    <div v-if="problem" class="inline-error" role="alert" data-testid="backtest-error">
      <p class="inline-error__title">{{ t("step4.backtest.rejected") }}</p>
      <p class="inline-error__detail">{{ problem.code }}: {{ problem.detail }}</p>
    </div>
    <StateNotice v-if="notice" compact data-testid="backtest-notice" :variant="notice.variant" :title="notice.title" :body="notice.body" />

    <template v-if="result">
      <dl class="facts" data-testid="backtest-facts">
        <div>
          <dt>{{ t("step4.backtest.dataOrigin") }}</dt>
          <dd class="mono" data-testid="backtest-data-origin">{{ result.data_origin }}</dd>
        </div>
        <div>
          <dt>{{ t("step4.backtest.request") }}</dt>
          <dd class="mono">
            {{ t("step4.backtest.requestValue", { episodes: result.request.episodes, seed: result.request.seed, origins: result.request.origins }) }}
          </dd>
        </div>
        <div>
          <dt>{{ t("step4.backtest.cases") }}</dt>
          <dd class="mono" data-testid="backtest-cases">{{ result.case_count }}</dd>
        </div>
        <div>
          <dt>{{ t("step4.backtest.generator") }}</dt>
          <dd class="mono">{{ result.generator.name }} · {{ result.generator.parameter_origin }}</dd>
        </div>
        <div>
          <dt>{{ t("step4.backtest.population") }}</dt>
          <dd class="mono" data-testid="backtest-population" :title="result.population_hash">{{ shortHash(result.population_hash) }}</dd>
        </div>
      </dl>

      <p class="step-hint">{{ t("step4.backtest.caption") }}</p>
      <div class="table-scroll">
        <table class="data-table" data-testid="backtest-table">
          <thead>
            <tr>
              <th scope="col">{{ t("step4.backtest.model") }}</th>
              <th v-for="h in horizons" :key="h" scope="col">{{ t("step4.backtest.horizonColumn", { h }) }}</th>
              <th scope="col">{{ t("step4.backtest.overall") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="m in models" :key="m.name" data-testid="backtest-row" :data-model="m.name">
              <td class="mono" data-testid="backtest-model">
                {{ m.name }}<span v-if="m.role === 'oracle'" class="backtest__role">{{ t("step4.backtest.oracleNote") }}</span>
              </td>
              <td
                v-for="(cell, i) in m.by_horizon"
                :key="i"
                class="mono"
                data-testid="backtest-cell"
                :data-horizon="cell.horizon"
                :data-kind="cellKind(cell.mean_nll_bits)"
              >
                {{ bits(cell.mean_nll_bits) }}
              </td>
              <td class="mono" data-testid="backtest-overall" :data-kind="cellKind(m.overall.mean_nll_bits)">{{ bits(m.overall.mean_nll_bits) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="backtest__gate" data-testid="backtest-gate" :data-accepted="String(result.gate.accepted)">{{ gateText }}</p>
      <p class="backtest__server-note mono" data-testid="backtest-server-disclaimer">{{ result.disclaimer }}</p>
    </template>
  </section>
</template>

<style scoped>
.backtest__disclaimer {
  max-width: 52rem;
  padding-left: var(--c2p-space-2);
  border-left: 2px solid var(--c2p-warning);
  color: var(--c2p-text-muted);
  font-size: var(--c2p-text-sm);
}

.backtest__form {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
  gap: var(--c2p-space-3);
  align-items: end;
  max-width: 52rem;
}

.backtest__actions {
  display: flex;
  align-items: end;
}

.backtest__role {
  margin-left: var(--c2p-space-2);
  color: var(--c2p-text-muted);
  font-size: var(--c2p-text-xs);
  font-weight: 400;
}

.backtest__gate {
  font-size: var(--c2p-text-sm);
}

.backtest__server-note {
  color: var(--c2p-text-muted);
  font-size: var(--c2p-text-xs);
}
</style>
