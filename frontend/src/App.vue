<script setup lang="ts">
import { useI18n } from "vue-i18n";
import LanguageSwitcher from "./components/LanguageSwitcher.vue";

const { t } = useI18n();
</script>

<template>
  <a class="skip-link" href="#main">{{ t("app.skipToContent") }}</a>
  <header class="topbar">
    <div class="topbar__inner">
      <RouterLink to="/" class="topbar__brand mono" :aria-label="t('app.homeLink')" data-testid="brand">
        <span class="topbar__mark" aria-hidden="true"></span>
        <span class="topbar__name">{{ t("app.name") }}</span>
      </RouterLink>
      <LanguageSwitcher />
    </div>
  </header>
  <main id="main" class="app-main" tabindex="-1">
    <RouterView />
  </main>
</template>

<style scoped>
.skip-link {
  position: absolute;
  top: var(--c2p-space-2);
  left: var(--c2p-space-2);
  z-index: 10;
  padding: var(--c2p-space-2) var(--c2p-space-3);
  background: var(--c2p-ink);
  color: var(--c2p-ink-contrast);
  font-size: var(--c2p-text-sm);
  transform: translateY(-200%);
}

.skip-link:focus {
  transform: none;
}

.topbar {
  position: sticky;
  top: 0;
  z-index: 5;
  border-bottom: var(--c2p-rule-width) solid var(--c2p-rule);
  background: var(--c2p-bg);
}

.topbar__inner {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--c2p-space-2) var(--c2p-space-4);
  max-width: var(--c2p-max-width);
  min-height: var(--c2p-topbar-height);
  margin: 0 auto;
  padding: var(--c2p-space-2) var(--c2p-gutter);
}

.topbar__brand {
  display: inline-flex;
  align-items: center;
  gap: var(--c2p-space-3);
  min-width: 0;
  font-size: var(--c2p-text-sm);
  font-weight: 700;
  text-decoration: none;
}

.topbar__mark {
  flex-shrink: 0;
  width: 0.75rem;
  height: 0.75rem;
  background: var(--c2p-ink);
}

.topbar__name {
  overflow-wrap: anywhere;
}

.app-main {
  outline: none;
}
</style>
