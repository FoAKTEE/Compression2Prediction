<script setup lang="ts">
import { useI18n } from "vue-i18n";
import PlaceholderPage from "../components/PlaceholderPage.vue";

defineProps<{ reportId: string }>();
const { t } = useI18n();
</script>

<template>
  <PlaceholderPage
    data-testid="interaction-view"
    :id-label="t('interaction.idLabel')"
    :record-id="reportId"
    :title="t('interaction.title')"
    :description="t('interaction.description')"
    :placeholder="t('interaction.placeholder')"
  />
</template>
