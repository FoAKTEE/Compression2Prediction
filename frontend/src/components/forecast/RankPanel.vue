<script setup lang="ts">
import { computed, ref, shallowRef, watch } from "vue";
import { useI18n } from "vue-i18n";
import { normalizeError } from "../../api/client";
import { getRankDiagnostics } from "../../api/forecast";
import type { RankDiagnostics } from "../../api/types";
import { errorNotice } from "../../composables/errorNotice";
import { formatMetric } from "../../composables/metric";
import StateNotice from "../StateNotice.vue";

/**
 * Rank and influence diagnostics of a run. The server answers 501 until
 * ranking diagnostics are enabled, which reads as a plain notice. Ranking
 * never changes a kernel; the server says whether the hashes stayed the same.
 */
const props = defineProps<{ projectId: string | null; runId: string | null; demo: boolean }>();
const { t } = useI18n();

type State = "idle" | "loading" | "disabled" | "ready" | "error";
const state = ref<State>("idle");
const diagnostics = shallowRef<RankDiagnostics | null>(null);
const failure = ref<unknown>(null);

async function load(projectId: string, runId: string): Promise<void> {
  state.value = "loading";
  failure.value = null;
  try {
    const result = await getRankDiagnostics(projectId, runId);
    if (props.runId !== runId) return;
    diagnostics.value = result;
    state.value = "ready";
  } catch (error) {
    if (props.runId !== runId) return;
    const e = normalizeError(error);
    if (e.status === 501 || e.code === "not_implemented") state.value = "disabled";
    else {
      failure.value = e;
      state.value = "error";
    }
  }
}

watch(
  () => [props.projectId, props.runId] as const,
  ([projectId, runId]) => {
    diagnostics.value = null;
    if (props.demo || projectId === null || runId === null) {
      state.value = "idle";
      return;
    }
    void load(projectId, runId);
  },
  { immediate: true },
);

const notice = computed(() => (failure.value === null ? null : errorNotice(failure.value, t)));
</script>

<template>
  <div class="rank" data-testid="rank-panel" :data-state="state">
    <StateNotice
      v-if="demo"
      compact
      variant="empty"
      data-testid="rank-demo"
      :title="t('step5.rank.demo.title')"
      :body="t('step5.rank.demo.body')"
    />
    <p v-else-if="state === 'idle'" class="step-hint">{{ t("step5.rank.idle") }}</p>
    <p v-else-if="state === 'loading'" class="step-hint">{{ t("common.loading") }}</p>
    <StateNotice
      v-else-if="state === 'disabled'"
      compact
      variant="unavailable"
      data-testid="rank-disabled"
      :title="t('step5.rank.disabled.title')"
      :body="t('step5.rank.disabled.body')"
    />
    <StateNotice
      v-else-if="state === 'error' && notice"
      compact
      data-testid="rank-error"
      :variant="notice.variant"
      :title="notice.title"
      :body="notice.body"
    />
    <template v-else-if="state === 'ready' && diagnostics">
      <dl class="facts">
        <div>
          <dt>{{ t("step5.rank.method") }}</dt>
          <dd class="mono">{{ diagnostics.method }}</dd>
        </div>
        <div>
          <dt>{{ t("step5.rank.hashes") }}</dt>
          <dd data-testid="rank-hashes">
            {{ diagnostics.kernel_hashes_unchanged ? t("step5.rank.unchanged") : t("step5.rank.changed") }}
          </dd>
        </div>
      </dl>
      <div class="table-scroll">
        <table class="data-table" data-testid="rank-table">
          <thead>
            <tr>
              <th scope="col">{{ t("step5.rank.node") }}</th>
              <th scope="col">{{ t("step5.rank.kind") }}</th>
              <th scope="col">{{ t("step5.rank.score") }}</th>
              <th scope="col">{{ t("step5.rank.bound") }}</th>
              <th scope="col">{{ t("step5.rank.prunable") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="entry in diagnostics.entries" :key="entry.node_id" data-testid="rank-row">
              <td class="mono">{{ entry.node_id }}</td>
              <td class="mono">{{ entry.node_kind }}</td>
              <td class="mono">{{ formatMetric(entry.score, t).text }}</td>
              <td class="mono">{{ entry.influence_bound === null ? t("step5.rank.sampled") : formatMetric(entry.influence_bound, t).text }}</td>
              <td>{{ entry.certified_prunable ? t("graph.detail.yes") : t("graph.detail.no") }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>

<style scoped>
.rank {
  display: grid;
  gap: var(--c2p-space-3);
  min-width: 0;
}
</style>
