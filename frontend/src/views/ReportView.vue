<script setup lang="ts">
import { useI18n } from "vue-i18n";
import PlaceholderPage from "../components/PlaceholderPage.vue";

defineProps<{ reportId: string }>();
const { t } = useI18n();
</script>

<template>
  <PlaceholderPage
    data-testid="report-view"
    :id-label="t('report.idLabel')"
    :record-id="reportId"
    :title="t('report.title')"
    :description="t('report.description')"
    :placeholder="t('report.placeholder')"
  />
</template>
