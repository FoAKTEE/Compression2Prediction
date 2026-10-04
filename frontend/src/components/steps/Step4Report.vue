<script setup lang="ts">
import StepPanel from "./StepPanel.vue";

defineProps<{ projectId: string; completed: boolean }>();
const emit = defineEmits<{ complete: [] }>();
</script>

<template>
  <StepPanel :step="4" :completed="completed" @complete="emit('complete')" />
</template>
