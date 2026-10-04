<script setup lang="ts">
import StateNotice from "./StateNotice.vue";

defineProps<{ idLabel: string; recordId: string; title: string; description: string; placeholder: string }>();
</script>

<template>
  <div class="page placeholder-page">
    <header class="placeholder-page__header">
      <p class="eyebrow">
        {{ idLabel }} <span class="placeholder-page__id">{{ recordId }}</span>
      </p>
      <h1 class="placeholder-page__title">{{ title }}</h1>
      <p class="placeholder-page__description">{{ description }}</p>
    </header>
    <StateNotice variant="empty" :title="placeholder" />
  </div>
</template>

<style scoped>
.placeholder-page {
  display: grid;
  gap: var(--c2p-space-6);
}

.placeholder-page__header {
  display: grid;
  gap: var(--c2p-space-3);
  padding-top: var(--c2p-space-4);
  border-top: var(--c2p-rule-width) solid var(--c2p-rule-strong);
}

.placeholder-page__id {
  margin-left: var(--c2p-space-2);
  color: var(--c2p-text);
  text-transform: none;
  overflow-wrap: anywhere;
}

.placeholder-page__title {
  font-size: var(--c2p-text-xl);
  font-weight: 700;
  letter-spacing: -0.02em;
}

.placeholder-page__description {
  max-width: 44rem;
  color: var(--c2p-text-muted);
}
</style>
