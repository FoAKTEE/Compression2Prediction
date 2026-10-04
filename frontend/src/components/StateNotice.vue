<script setup lang="ts">
import { computed } from "vue";

export type NoticeVariant = "empty" | "loading" | "unavailable" | "error";

const props = withDefaults(
  defineProps<{
    variant: NoticeVariant;
    title: string;
    body?: string;
    actionLabel?: string;
    compact?: boolean;
  }>(),
  { body: undefined, actionLabel: undefined, compact: false },
);

const emit = defineEmits<{ action: [] }>();

const role = computed(() => (props.variant === "error" ? "alert" : "status"));
const marker = computed(() => ({ empty: "○", loading: "…", unavailable: "×", error: "!" })[props.variant]);
</script>

<template>
  <div
    class="notice"
    :class="[`notice--${variant}`, { 'notice--compact': compact }]"
    :role="role"
    :data-variant="variant"
  >
    <span class="notice__marker mono" aria-hidden="true">{{ marker }}</span>
    <div class="notice__text">
      <p class="notice__title">{{ title }}</p>
      <p v-if="body" class="notice__body">{{ body }}</p>
      <slot />
    </div>
    <button v-if="actionLabel" type="button" class="btn notice__action" @click="emit('action')">
      {{ actionLabel }}
    </button>
  </div>
</template>

<style scoped>
.notice {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: var(--c2p-space-3) var(--c2p-space-4);
  align-items: start;
  padding: var(--c2p-space-5);
  border: var(--c2p-rule-width) dashed var(--c2p-rule);
  border-radius: var(--c2p-radius);
  color: var(--c2p-text-muted);
}

.notice--compact {
  padding: var(--c2p-space-3) var(--c2p-space-4);
}

.notice--unavailable {
  border-style: solid;
  border-color: var(--c2p-warning);
  background: var(--c2p-warning-surface);
  color: var(--c2p-text);
}

.notice--error {
  border-style: solid;
  border-color: var(--c2p-danger);
  background: var(--c2p-danger-surface);
  color: var(--c2p-text);
}

.notice__marker {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.75rem;
  height: 1.75rem;
  border: var(--c2p-rule-width) solid currentColor;
  border-radius: 50%;
  font-size: var(--c2p-text-sm);
  line-height: 1;
}

.notice__text {
  display: grid;
  gap: var(--c2p-space-1);
  min-width: 0;
  overflow-wrap: anywhere;
}

.notice__title {
  font-weight: 600;
  color: var(--c2p-text);
}

.notice__body {
  font-size: var(--c2p-text-sm);
}

.notice__action {
  grid-column: 2;
  justify-self: start;
}
</style>
