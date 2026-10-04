<script setup lang="ts">
import { computed } from "vue";
import { useRoute } from "vue-router";
import { exampleRequested } from "../../composables/graphSource";
import { projectStore } from "../../store/project";
import InteractionPanels from "../forecast/InteractionPanels.vue";
import StepPanel from "./StepPanel.vue";

const props = defineProps<{ projectId: string; completed: boolean }>();
const emit = defineEmits<{ complete: []; incomplete: []; "refresh-project": [] }>();
const route = useRoute();

/** `?example=1`: the bundled runs, mechanism graph, and report stand in for the server. */
const demo = exampleRequested(route?.query);
const linkQuery: Record<string, string> = demo ? { example: "1" } : {};

/** The run chosen in step 3, else the project's latest run. */
const initialRunId = computed(() => {
  const project = projectStore.state.project;
  const latest = project !== null && project.project_id === props.projectId ? project.latest_run_id : null;
  return projectStore.state.selectedRunId ?? latest ?? null;
});

function onSelectRun(runId: string, reportId: string | null): void {
  projectStore.selectRun(runId, reportId);
}

/** The last step completes once something was asked of the model: a what-if run or a comparison. */
function onInteracted(): void {
  if (!props.completed) emit("complete");
}
</script>

<template>
  <StepPanel :step="5" :completed="completed" wired>
    <InteractionPanels
      :project-id="projectId"
      :demo="demo"
      :initial-run-id="initialRunId"
      :link-query="linkQuery"
      @interacted="onInteracted"
      @refresh-project="emit('refresh-project')"
      @select-run="onSelectRun"
    />
  </StepPanel>
</template>
