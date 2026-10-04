import { computed, ref, shallowRef, watch, type Ref, type ShallowRef } from "vue";
import { useRoute } from "vue-router";
import { projectStore } from "../store/project";

/** `?example=1` loads the bundled examples, so the graph views work without a server. */
export const EXAMPLE_QUERY = "example";

export function exampleRequested(query: Record<string, unknown> | undefined): boolean {
  const value = query?.[EXAMPLE_QUERY];
  return value === "1" || (Array.isArray(value) && value.includes("1"));
}

export interface GraphSource<T> {
  data: ShallowRef<T | null>;
  loading: Ref<boolean>;
  error: Ref<unknown>;
  isExample: Ref<boolean>;
  /** Whether the project record has loaded (so its server-side data can be fetched). */
  hasProject: Readonly<Ref<boolean>>;
  loadExample: () => void;
}

/**
 * Data for a step's graph: fetched from the server once the project exists, or
 * replaced by a bundled example on request. A late server response never
 * overwrites an example the user loaded in the meantime.
 */
export function useGraphSource<T>(options: {
  projectId: () => string;
  fetch: (projectId: string) => Promise<T>;
  example: () => T;
}): GraphSource<T> {
  const route = useRoute();
  const data = shallowRef<T | null>(null);
  const loading = ref(false);
  const error = ref<unknown>(null);
  const isExample = ref(false);

  const projectId = computed(() => {
    const project = projectStore.state.project;
    return project !== null && project.project_id === options.projectId() ? project.project_id : null;
  });
  const hasProject = computed(() => projectId.value !== null);

  async function load(id: string): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      const result = await options.fetch(id);
      if (!isExample.value && projectId.value === id) data.value = result;
    } catch (caught) {
      if (!isExample.value && projectId.value === id) error.value = caught;
    } finally {
      if (projectId.value === id || isExample.value) loading.value = false;
    }
  }

  function loadExample(): void {
    isExample.value = true;
    loading.value = false;
    error.value = null;
    data.value = options.example();
  }

  if (exampleRequested(route?.query)) loadExample();

  watch(
    projectId,
    (id) => {
      if (id !== null && !isExample.value) void load(id);
    },
    { immediate: true },
  );

  return { data, loading, error, isExample, hasProject, loadExample };
}
