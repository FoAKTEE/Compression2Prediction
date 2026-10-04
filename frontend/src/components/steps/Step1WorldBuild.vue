<script setup lang="ts">
import { useI18n } from "vue-i18n";
import StepPanel from "./StepPanel.vue";

defineProps<{ projectId: string; completed: boolean }>();
const emit = defineEmits<{ complete: [] }>();
defineSlots<{ graph?: () => unknown }>();
const { t } = useI18n();
</script>

<template>
  <StepPanel :step="1" :completed="completed" @complete="emit('complete')">
    <!-- Reserved for the GraphPanel (World view). -->
    <section class="graph-region" data-testid="graph-region" :aria-label="t('process.graph.label')">
      <slot name="graph">
        <div class="graph-region__placeholder">
          <span class="eyebrow">{{ t("process.graph.label") }}</span>
          <p>{{ t("process.graph.placeholder") }}</p>
        </div>
      </slot>
    </section>
  </StepPanel>
</template>

<style scoped>
.graph-region {
  min-width: 0;
  min-height: clamp(14rem, 40vw, 26rem);
  border: var(--c2p-rule-width) solid var(--c2p-rule);
  border-radius: var(--c2p-radius);
  background-color: var(--c2p-surface);
  background-image: radial-gradient(var(--c2p-rule) 1px, transparent 1px);
  background-size: 1.25rem 1.25rem;
}

.graph-region__placeholder {
  display: grid;
  place-content: center;
  gap: var(--c2p-space-2);
  height: 100%;
  min-height: inherit;
  padding: var(--c2p-space-5);
  color: var(--c2p-text-muted);
  font-size: var(--c2p-text-sm);
  text-align: center;
}
</style>
