<script setup lang="ts">
import { useI18n } from "vue-i18n";
import type { KernelProvenance } from "../../api/types";

/** Where each kernel's parameters came from, and whether anything validated them. */
defineProps<{
  kernels: KernelProvenance[];
  dataOrigin?: string | null;
  parameterOrigin?: string | null;
  validationStatus?: string | null;
  heading?: string | null;
}>();
const { t } = useI18n();
</script>

<template>
  <section class="step-section" data-testid="provenance" :aria-label="heading ?? t('forecast.provenance.heading')">
    <div class="step-section__bar">
      <h4 class="eyebrow">{{ heading ?? t("forecast.provenance.heading") }}</h4>
    </div>
    <dl v-if="dataOrigin || parameterOrigin || validationStatus" class="facts">
      <div v-if="dataOrigin">
        <dt>{{ t("forecast.provenance.dataOrigin") }}</dt>
        <dd class="mono" data-testid="provenance-data-origin">{{ dataOrigin }}</dd>
      </div>
      <div v-if="parameterOrigin">
        <dt>{{ t("forecast.provenance.parameterOrigin") }}</dt>
        <dd class="mono" data-testid="provenance-parameter-origin">{{ parameterOrigin }}</dd>
      </div>
      <div v-if="validationStatus">
        <dt>{{ t("forecast.provenance.validationStatus") }}</dt>
        <dd class="mono" data-testid="provenance-validation">{{ validationStatus }}</dd>
      </div>
    </dl>
    <ul v-if="kernels.length" class="kernels" data-testid="kernel-list">
      <li v-for="k in kernels" :key="`${k.mechanism_id}/${k.kernel_ref}`" class="kernels__item" data-testid="kernel-row">
        <p class="kernels__head">
          <span class="mono kernels__mechanism">{{ k.mechanism_id }}</span>
          <span class="mono kernels__ref">{{ k.kernel_ref }}</span>
        </p>
        <dl class="facts">
          <div>
            <dt>{{ t("forecast.provenance.parameterOrigin") }}</dt>
            <dd class="mono">{{ k.parameter_origin }}</dd>
          </div>
          <div>
            <dt>{{ t("forecast.provenance.fittingMethod") }}</dt>
            <dd class="mono">{{ k.fitting_method }}</dd>
          </div>
          <div>
            <dt>{{ t("forecast.provenance.trainingCutoff") }}</dt>
            <dd class="mono">{{ k.training_cutoff ?? t("forecast.none") }}</dd>
          </div>
          <div>
            <dt>{{ t("forecast.provenance.causalBasis") }}</dt>
            <dd class="mono">{{ k.causal_basis }}</dd>
          </div>
          <div>
            <dt>{{ t("forecast.provenance.validationStatus") }}</dt>
            <dd class="mono">{{ k.validation_status }}</dd>
          </div>
        </dl>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.kernels {
  display: grid;
  gap: var(--c2p-space-2);
}

.kernels__item {
  display: grid;
  gap: var(--c2p-space-2);
  padding: var(--c2p-space-3) var(--c2p-space-4);
  border-left: 2px solid var(--c2p-rule-strong);
  background: var(--c2p-surface);
}

.kernels__head {
  display: flex;
  flex-wrap: wrap;
  gap: var(--c2p-space-1) var(--c2p-space-3);
  align-items: baseline;
}

.kernels__mechanism {
  font-size: var(--c2p-text-sm);
  font-weight: 600;
  overflow-wrap: anywhere;
}

.kernels__ref {
  color: var(--c2p-text-muted);
  font-size: var(--c2p-text-xs);
  overflow-wrap: anywhere;
}
</style>
