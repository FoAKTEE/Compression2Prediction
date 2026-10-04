<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";

/**
 * What a result is: a model-based intervention (surgery on the stated model),
 * or a forecast without intervention, observational or (when `conditioned`)
 * conditional on evidence. Identification is a separate claim the server
 * never makes, so the badge never calls a result an effect of a cause.
 */
const props = withDefaults(defineProps<{ status: string | null | undefined; conditioned?: boolean }>(), { conditioned: false });
const { t, te } = useI18n();

const text = computed(() => {
  const status = props.status ?? "not_applicable";
  if (status === "not_applicable" && props.conditioned) return t("forecast.effect.conditional");
  const key = `forecast.effect.${status}`;
  return te(key) ? t(key) : status;
});
</script>

<template>
  <span
    class="badge effect-badge"
    :class="{ 'effect-badge--intervention': status === 'model_based_intervention' }"
    :data-status="status ?? 'not_applicable'"
    data-testid="effect-badge"
  >
    {{ text }}
  </span>
</template>

<style scoped>
.effect-badge {
  max-width: 100%;
  font-weight: 600;
  text-align: left;
  overflow-wrap: anywhere;
}

.effect-badge--intervention {
  border-style: dashed;
}
</style>
