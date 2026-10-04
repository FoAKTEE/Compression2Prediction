<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { getMechanismGraph } from "../../api/model";
import { errorNotice } from "../../composables/errorNotice";
import { useGraphSource } from "../../composables/graphSource";
import GraphPanel from "../graph/GraphPanel.vue";
import { exampleMechanismGraph } from "../graph/examples";
import StateNotice from "../StateNotice.vue";
import StepPanel from "./StepPanel.vue";

const props = defineProps<{ projectId: string; completed: boolean }>();
const emit = defineEmits<{ complete: [] }>();
const { t } = useI18n();

const { data, loading, error, isExample, hasProject, loadExample } = useGraphSource({
  projectId: () => props.projectId,
  fetch: getMechanismGraph,
  example: exampleMechanismGraph,
});

const notice = computed(() => {
  if (error.value !== null) return errorNotice(error.value, t);
  if (!hasProject.value && !data.value && !loading.value) {
    return {
      variant: "empty" as const,
      title: t("process.mechanismGraph.noModel.title"),
      body: t("process.mechanismGraph.noModel.body"),
    };
  }
  return null;
});
</script>

<template>
  <StepPanel :step="2" :completed="completed" @complete="emit('complete')">
    <section class="graph-region" data-testid="mechanism-region" :aria-label="t('process.mechanismGraph.label')">
      <header class="graph-region__bar">
        <h3 class="eyebrow">{{ t("process.mechanismGraph.label") }}</h3>
        <span v-if="isExample" class="badge" data-testid="example-badge" :title="t('graph.example.note')">
          {{ t("graph.example.badge") }}
        </span>
        <button type="button" class="btn graph-region__action" data-testid="load-example" @click="loadExample">
          {{ t("graph.example.load") }}
        </button>
      </header>
      <StateNotice
        v-if="notice"
        compact
        data-testid="mechanism-notice"
        :variant="notice.variant"
        :title="notice.title"
        :body="notice.body"
      />
      <GraphPanel v-if="data || loading" :mechanism="data" initial-mode="mechanism" :loading="loading" />
    </section>
  </StepPanel>
</template>

<style scoped>
.graph-region {
  display: grid;
  gap: var(--c2p-space-4);
  min-width: 0;
}

.graph-region__bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--c2p-space-3);
  padding-top: var(--c2p-space-3);
  border-top: var(--c2p-rule-width) solid var(--c2p-rule);
}

.graph-region__action {
  margin-left: auto;
}
</style>
