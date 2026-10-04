<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { STEP_COUNT, STEP_KEYS, padStep, type StepNumber } from "../../process/steps";

const props = withDefaults(
  defineProps<{
    step: StepNumber;
    completed: boolean;
    /** A wired step completes from its own results, so it has no placeholder and no dev control. */
    wired?: boolean;
  }>(),
  { wired: false },
);
const emit = defineEmits<{ complete: [] }>();
const { t } = useI18n();

// Dev-only "mark complete" control for exercising step gating on steps that are not wired yet;
// false (and removed) in production builds.
const showDevControls = computed(() => import.meta.env.DEV && !props.wired);

const key = computed(() => STEP_KEYS[props.step]);
const titleId = computed(() => `step-${props.step}-title`);
</script>

<template>
  <article class="step-panel" :aria-labelledby="titleId" :data-step="step" data-testid="step-panel">
    <header class="step-panel__header">
      <p class="step-panel__kicker mono">
        {{ t("process.stepOf", { n: padStep(step), total: padStep(STEP_COUNT) }) }}
      </p>
      <div class="step-panel__heading">
        <h2 :id="titleId" class="step-panel__title">{{ t(`process.steps.${key}.name`) }}</h2>
        <span class="badge" :class="{ 'badge--solid': completed }" data-testid="step-status">
          {{ completed ? t("process.status.complete") : t("process.status.current") }}
        </span>
      </div>
      <p class="step-panel__description">{{ t(`process.steps.${key}.description`) }}</p>
    </header>

    <slot />

    <p v-if="!wired" class="step-panel__placeholder">{{ t("process.placeholder") }}</p>

    <div v-if="showDevControls" class="step-panel__dev" data-testid="dev-control">
      <span class="eyebrow">{{ t("process.dev.label") }}</span>
      <button type="button" class="btn" data-testid="mark-complete" :disabled="completed" @click="emit('complete')">
        {{ completed ? t("process.dev.marked") : t("process.dev.markComplete") }}
      </button>
    </div>
  </article>
</template>

<style scoped>
.step-panel {
  display: grid;
  gap: var(--c2p-space-5);
  min-width: 0;
}

.step-panel__header {
  display: grid;
  gap: var(--c2p-space-3);
}

.step-panel__kicker {
  color: var(--c2p-text-muted);
  font-size: var(--c2p-text-xs);
}

.step-panel__heading {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--c2p-space-3);
}

.step-panel__title {
  font-size: var(--c2p-text-xl);
  font-weight: 600;
  letter-spacing: -0.015em;
  line-height: 1.2;
}

.step-panel__description {
  max-width: 44rem;
  color: var(--c2p-text-muted);
}

.step-panel__placeholder {
  padding: var(--c2p-space-4);
  border: var(--c2p-rule-width) dashed var(--c2p-rule);
  border-radius: var(--c2p-radius);
  color: var(--c2p-text-faint);
  font-size: var(--c2p-text-sm);
}

.step-panel__dev {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--c2p-space-3);
  padding-top: var(--c2p-space-4);
  border-top: var(--c2p-rule-width) dashed var(--c2p-rule);
}
</style>
