<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { ForecastUncertainty } from "../../api/types";
import { formatMarker } from "../../composables/metric";

/**
 * Uncertainty metadata, shown as the server states it. Parameter uncertainty
 * and model error read "missing" until quantified; an exact calculation from
 * assumed kernels is never drawn as an interval (guide §11.1).
 */
const props = defineProps<{ uncertainty: ForecastUncertainty | null | undefined }>();
const { t } = useI18n();

const parameter = computed(() => formatMarker(props.uncertainty?.parameter, t));
const modelError = computed(() => formatMarker(props.uncertainty?.model_error, t));
</script>

<template>
  <section class="step-section uncertainty" data-testid="uncertainty-panel" :aria-label="t('forecast.uncertainty.heading')">
    <div class="step-section__bar">
      <h4 class="eyebrow">{{ t("forecast.uncertainty.heading") }}</h4>
    </div>
    <dl class="facts">
      <div>
        <dt>{{ t("forecast.uncertainty.parameter") }}</dt>
        <dd :class="{ 'is-missing': parameter.kind === 'missing' }" data-testid="uncertainty-parameter">{{ parameter.text }}</dd>
      </div>
      <div>
        <dt>{{ t("forecast.uncertainty.modelError") }}</dt>
        <dd :class="{ 'is-missing': modelError.kind === 'missing' }" data-testid="uncertainty-model-error">{{ modelError.text }}</dd>
      </div>
      <div>
        <dt>{{ t("forecast.uncertainty.method") }}</dt>
        <dd class="mono" data-testid="uncertainty-method">{{ uncertainty?.method ?? t("metric.missing") }}</dd>
      </div>
    </dl>
    <p v-if="uncertainty?.note" class="step-hint" data-testid="uncertainty-note">{{ uncertainty.note }}</p>
    <p class="step-hint uncertainty__rule">{{ t("forecast.uncertainty.noInterval") }}</p>
  </section>
</template>

<style scoped>
.uncertainty__rule {
  font-size: var(--c2p-text-xs);
}
</style>
