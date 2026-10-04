<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { useRoute } from "vue-router";

const { t } = useI18n();
const route = useRoute();
</script>

<template>
  <div class="page not-found" data-testid="not-found">
    <span class="badge badge--solid">{{ t("notFound.code") }}</span>
    <h1 class="not-found__title">{{ t("notFound.title") }}</h1>
    <p class="not-found__body">{{ t("notFound.body", { path: route.fullPath }) }}</p>
    <RouterLink class="btn" to="/">{{ t("notFound.home") }}</RouterLink>
  </div>
</template>

<style scoped>
.not-found {
  display: grid;
  justify-items: start;
  gap: var(--c2p-space-4);
  padding-top: var(--c2p-space-8);
}

.not-found__title {
  font-size: var(--c2p-text-hero);
  font-weight: 700;
  letter-spacing: -0.03em;
  line-height: 1.05;
}

.not-found__body {
  color: var(--c2p-text-muted);
  overflow-wrap: anywhere;
}
</style>
