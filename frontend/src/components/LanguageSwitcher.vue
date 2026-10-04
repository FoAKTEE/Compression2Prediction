<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { SUPPORTED_LOCALES, htmlLang, persistLocale, type Locale } from "../i18n";

const { t, locale } = useI18n();

function choose(next: Locale): void {
  if (locale.value !== next) locale.value = next;
  persistLocale(next);
}
</script>

<template>
  <div class="lang-switcher" role="group" :aria-label="t('language.label')">
    <button
      v-for="code in SUPPORTED_LOCALES"
      :key="code"
      type="button"
      class="lang-switcher__option"
      :class="{ 'is-active': locale === code }"
      :aria-pressed="locale === code"
      :lang="htmlLang(code)"
      :title="t(`language.${code}.name`)"
      :data-locale="code"
      @click="choose(code)"
    >
      {{ t(`language.${code}.short`) }}
    </button>
  </div>
</template>

<style scoped>
.lang-switcher {
  display: inline-flex;
  flex-shrink: 0;
  border: var(--c2p-rule-width) solid var(--c2p-rule-strong);
  border-radius: var(--c2p-radius);
}

.lang-switcher__option {
  min-width: 2.75rem;
  min-height: 2rem;
  padding: 0 var(--c2p-space-3);
  border: 0;
  background: transparent;
  font-family: var(--c2p-font-mono);
  font-size: var(--c2p-text-xs);
  letter-spacing: var(--c2p-tracking-mono);
  cursor: pointer;
}

.lang-switcher__option + .lang-switcher__option {
  border-left: var(--c2p-rule-width) solid var(--c2p-rule-strong);
}

.lang-switcher__option.is-active {
  background: var(--c2p-ink);
  color: var(--c2p-ink-contrast);
}
</style>
