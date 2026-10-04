<script setup lang="ts">
import { computed, ref, watch, type Component } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute } from "vue-router";
import { getProject } from "../api/world";
import StateNotice from "../components/StateNotice.vue";
import Step1WorldBuild from "../components/steps/Step1WorldBuild.vue";
import Step2ModelSetup from "../components/steps/Step2ModelSetup.vue";
import Step3ForecastSimulate from "../components/steps/Step3ForecastSimulate.vue";
import Step4Report from "../components/steps/Step4Report.vue";
import Step5Interaction from "../components/steps/Step5Interaction.vue";
import { errorNotice } from "../composables/errorNotice";
import { exampleRequested } from "../composables/graphSource";
import { STEP_COUNT, STEP_KEYS, STEP_NUMBERS, isStepNumber, padStep, type StepNumber } from "../process/steps";
import { projectStore } from "../store/project";

const props = defineProps<{ projectId: string }>();
const { t } = useI18n();
const route = useRoute();

const STEP_COMPONENTS: Readonly<Record<StepNumber, Component>> = {
  1: Step1WorldBuild,
  2: Step2ModelSetup,
  3: Step3ForecastSimulate,
  4: Step4Report,
  5: Step5Interaction,
};

const state = projectStore.state;
const projectLoading = ref(false);
const projectError = ref<unknown>(null);

async function loadProject(projectId: string): Promise<void> {
  projectStore.setProjectId(projectId);
  projectLoading.value = true;
  projectError.value = null;
  try {
    const project = await getProject(projectId);
    if (props.projectId === projectId) {
      projectStore.setProject(project);
      // A world already exists for this project, so step 1 is complete.
      if (project.world_version !== null) projectStore.markStepComplete(1);
    }
  } catch (error) {
    if (props.projectId === projectId) projectError.value = error;
  } finally {
    if (props.projectId === projectId) projectLoading.value = false;
  }
}

watch(
  () => props.projectId,
  (projectId) => void loadProject(projectId),
  { immediate: true },
);

/**
 * Demo links: with `?example=1`, `&step=N` opens step N directly, marking the
 * earlier steps complete, so each step's bundled example can be viewed without
 * a server. Without `example=1` the step gating is unchanged.
 */
function applyExampleStep(): void {
  if (!exampleRequested(route?.query)) return;
  const step = Number(route.query.step);
  if (!isStepNumber(step)) return;
  for (const earlier of STEP_NUMBERS) if (earlier < step) projectStore.markStepComplete(earlier);
  projectStore.goToStep(step);
}

applyExampleStep();

const project = computed(() => (state.project?.project_id === props.projectId ? state.project : null));
const notice = computed(() => (projectError.value === null ? null : errorNotice(projectError.value, t)));

const steps = computed(() =>
  STEP_NUMBERS.map((number) => ({
    number,
    key: STEP_KEYS[number],
    current: state.currentStep === number,
    complete: projectStore.isCompleted(number),
    visitable: projectStore.canVisit(number),
  })),
);

type StepView = (typeof steps.value)[number];

function statusText(step: StepView): string {
  const parts: string[] = [];
  if (step.current) parts.push(t("process.status.current"));
  if (step.complete) parts.push(t("process.status.complete"));
  if (parts.length === 0) parts.push(step.visitable ? t("process.status.available") : t("process.status.locked"));
  return parts.join(", ");
}

const currentComponent = computed(() => STEP_COMPONENTS[state.currentStep]);
const currentComplete = computed(() => projectStore.isCompleted(state.currentStep));
const isLastStep = computed(() => state.currentStep === STEP_COUNT);
const canAdvance = computed(() => projectStore.canAdvance());

const hint = computed(() => {
  if (!currentComplete.value) return isLastStep.value ? "" : t("process.nextLocked");
  return isLastStep.value ? t("process.finished") : "";
});

function markCurrentComplete(): void {
  projectStore.markStepComplete(state.currentStep);
}

function markCurrentIncomplete(): void {
  projectStore.markStepIncomplete(state.currentStep);
}
</script>

<template>
  <div class="page process">
    <header class="process__header">
      <RouterLink to="/" class="process__back mono">
        <span aria-hidden="true">←</span> {{ t("process.backToProjects") }}
      </RouterLink>
      <p class="eyebrow">{{ t("process.eyebrow") }}</p>
      <h1 class="process__title" :class="{ mono: !project }">{{ project?.name ?? projectId }}</h1>
      <p v-if="project?.prediction_question" class="process__question">{{ project.prediction_question }}</p>
      <p v-else-if="projectLoading" class="process__loading">{{ t("process.loadingProject") }}</p>
      <StateNotice
        v-if="notice"
        compact
        data-testid="project-notice"
        :variant="notice.variant"
        :title="notice.title"
        :body="t('process.projectOffline')"
      />
    </header>

    <nav class="stepper" :aria-label="t('process.stepper')">
      <ol class="stepper__list">
        <li
          v-for="step in steps"
          :key="step.number"
          class="stepper__item"
          :class="{ 'is-current': step.current, 'is-complete': step.complete, 'is-locked': !step.visitable }"
          :data-step="step.number"
          data-testid="stepper-item"
        >
          <button
            type="button"
            class="stepper__button"
            :disabled="!step.visitable"
            :aria-current="step.current ? 'step' : undefined"
            @click="projectStore.goToStep(step.number)"
          >
            <span class="stepper__badge mono" aria-hidden="true">{{ padStep(step.number) }}</span>
            <span class="stepper__name" data-testid="stepper-name">{{ t(`process.steps.${step.key}.name`) }}</span>
            <span class="sr-only">({{ statusText(step) }})</span>
          </button>
        </li>
      </ol>
    </nav>

    <section class="process__body">
      <component
        :is="currentComponent"
        :key="state.currentStep"
        :project-id="projectId"
        :completed="currentComplete"
        @complete="markCurrentComplete"
        @incomplete="markCurrentIncomplete"
      />
    </section>

    <footer class="process__nav">
      <button
        type="button"
        class="btn"
        data-testid="previous-step"
        :disabled="state.currentStep === 1"
        @click="projectStore.previousStep()"
      >
        <span aria-hidden="true">←</span> {{ t("process.previous") }}
      </button>
      <p class="process__hint" aria-live="polite">{{ hint }}</p>
      <button
        v-if="!isLastStep"
        type="button"
        class="btn btn--primary"
        data-testid="next-step"
        :disabled="!canAdvance"
        @click="projectStore.nextStep()"
      >
        {{ t("process.next") }} <span aria-hidden="true">→</span>
      </button>
    </footer>
  </div>
</template>

<style scoped>
.process {
  display: grid;
  gap: var(--c2p-space-6);
}

.process__header {
  display: grid;
  gap: var(--c2p-space-2);
  min-width: 0;
}

.process__back {
  justify-self: start;
  margin-bottom: var(--c2p-space-3);
  color: var(--c2p-text-muted);
  font-size: var(--c2p-text-xs);
  text-decoration: none;
}

.process__back:hover {
  color: var(--c2p-text);
}

.process__title {
  font-size: var(--c2p-text-xl);
  font-weight: 700;
  letter-spacing: -0.02em;
  line-height: 1.15;
  overflow-wrap: anywhere;
}

.process__question,
.process__loading {
  max-width: 48rem;
  color: var(--c2p-text-muted);
}

.process__header :deep(.notice) {
  margin-top: var(--c2p-space-3);
}

/* Stepper: five equal cells on a rule; on narrow screens only the badges show (names stay for screen readers). */
.stepper {
  display: grid;
  gap: var(--c2p-space-3);
  min-width: 0;
}

.stepper__list {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  border-top: var(--c2p-rule-width) solid var(--c2p-rule);
}

.stepper__item {
  min-width: 0;
  margin-top: calc(-1 * var(--c2p-rule-width));
  border-top: 2px solid transparent;
}

.stepper__item.is-complete {
  border-top-color: var(--c2p-text-faint);
}

.stepper__item.is-current {
  border-top-color: var(--c2p-rule-strong);
}

.stepper__button {
  position: relative;
  display: grid;
  justify-items: start;
  gap: var(--c2p-space-2);
  width: 100%;
  min-width: 0;
  padding: var(--c2p-space-3) var(--c2p-space-2) var(--c2p-space-3) 0;
  border: 0;
  background: transparent;
  text-align: left;
  cursor: pointer;
}

.stepper__button:disabled {
  cursor: not-allowed;
}

.stepper__badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 2.25rem;
  padding: 0.15rem 0.4rem;
  border: var(--c2p-rule-width) solid var(--c2p-rule);
  border-radius: var(--c2p-radius);
  color: var(--c2p-text-faint);
  font-size: var(--c2p-text-xs);
  font-weight: 600;
}

.stepper__name {
  max-width: 100%;
  color: var(--c2p-text-faint);
  font-size: var(--c2p-text-sm);
  line-height: 1.3;
  overflow-wrap: anywhere;
}

.is-complete .stepper__badge {
  border-color: var(--c2p-rule-strong);
  color: var(--c2p-text);
}

.is-complete .stepper__name,
.stepper__item:not(.is-locked) .stepper__name {
  color: var(--c2p-text-muted);
}

.is-current .stepper__badge {
  border-color: var(--c2p-ink);
  background: var(--c2p-ink);
  color: var(--c2p-ink-contrast);
}

.is-current .stepper__name {
  color: var(--c2p-text);
  font-weight: 600;
}

.stepper__item:not(.is-locked) .stepper__button:hover .stepper__name {
  color: var(--c2p-text);
}

@media (max-width: 40rem) {
  .stepper__name {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
  }

  .stepper__button {
    justify-items: center;
    padding-right: 0;
  }
}

.process__body {
  min-width: 0;
  padding-top: var(--c2p-space-2);
}

.process__nav {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--c2p-space-3);
  padding-top: var(--c2p-space-4);
  border-top: var(--c2p-rule-width) solid var(--c2p-rule);
}

.process__hint {
  flex: 1 1 12rem;
  color: var(--c2p-text-muted);
  font-size: var(--c2p-text-sm);
  text-align: center;
}

@media (max-width: 40rem) {
  .process__hint {
    order: -1;
    flex-basis: 100%;
    text-align: left;
  }
}
</style>
