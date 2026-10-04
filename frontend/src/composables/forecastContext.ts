import { computed, ref, shallowRef, watch, type Ref, type ShallowRef } from "vue";
import { normalizeError } from "../api/client";
import { getRun, listRuns } from "../api/forecast";
import { getModel, listVariables } from "../api/model";
import type { ForecastResult, ForecastRunSummary, VariableDef } from "../api/types";
import { getWorld } from "../api/world";
import {
  exampleForecastEntities,
  exampleForecastVariables,
  exampleModelInfo,
  exampleRunResult,
  exampleRunSummaries,
  type EntityOption,
  type ModelInfo,
} from "../components/forecast/examples";

export interface ForecastContext {
  entities: ShallowRef<EntityOption[]>;
  variables: ShallowRef<VariableDef[]>;
  model: ShallowRef<ModelInfo | null>;
  runs: ShallowRef<ForecastRunSummary[]>;
  setupLoading: Ref<boolean>;
  runsLoading: Ref<boolean>;
  /** The first failure loading the world or the variables (a missing world or model is not a failure). */
  setupError: Ref<unknown>;
  runsError: Ref<unknown>;
  isDemo: boolean;
  hasRuns: Readonly<Ref<boolean>>;
  reloadRuns: () => Promise<void>;
  /** A run's full result, from the cache, the bundled example, or the server. */
  fetchRun: (runId: string) => Promise<ForecastResult>;
  /** Records a new run (newest first) and caches its result. */
  addRun: (result: ForecastResult) => void;
}

/** Codes that mean "nothing there yet" rather than a failure. */
const ABSENT = new Set(["world_not_ready", "model_not_found", "not_found"]);

function summaryOf(r: ForecastResult): ForecastRunSummary {
  return {
    run_id: r.run_id,
    project_id: r.project_id,
    scenario_id: r.scenario_id,
    status: r.status,
    target_entity_id: r.target_entity_id,
    target_variable: r.target_variable,
    horizon_steps: r.horizon_steps,
    created_at: r.created_at,
    query_kind: r.query_kind,
    effect_status: r.effect_status,
    report_id: r.report_id,
  };
}

/**
 * What steps 3-5 need from a project: world entities (forecast targets),
 * the variable registry (domains by kind), the model's horizon, and the run
 * list. In the offline example (`demo`) everything comes from the bundled
 * incident forecast and nothing is fetched.
 */
export function useForecastContext(options: { projectId: () => string | null; demo: boolean }): ForecastContext {
  const entities = shallowRef<EntityOption[]>(options.demo ? exampleForecastEntities() : []);
  const variables = shallowRef<VariableDef[]>(options.demo ? exampleForecastVariables() : []);
  const model = shallowRef<ModelInfo | null>(options.demo ? exampleModelInfo() : null);
  const runs = shallowRef<ForecastRunSummary[]>(options.demo ? exampleRunSummaries() : []);
  const setupLoading = ref(false);
  const runsLoading = ref(false);
  const setupError = ref<unknown>(null);
  const runsError = ref<unknown>(null);
  const cache = new Map<string, ForecastResult>();

  const current = () => options.projectId();

  async function loadSetup(id: string): Promise<void> {
    setupLoading.value = true;
    setupError.value = null;
    const [world, vars, stored] = await Promise.allSettled([getWorld(id), listVariables(id), getModel(id)]);
    if (current() !== id) return;
    const failures: unknown[] = [];
    if (world.status === "fulfilled") {
      entities.value = world.value.entities.map((e) => ({
        entity_id: e.entity_id,
        display_name: e.display_name,
        primary_kind: e.primary_kind,
      }));
    } else {
      entities.value = [];
      if (!ABSENT.has(normalizeError(world.reason).code)) failures.push(world.reason);
    }
    if (vars.status === "fulfilled") variables.value = vars.value.variables;
    else {
      variables.value = [];
      failures.push(vars.reason);
    }
    // The horizon bound is optional: an older server without `GET .../model` leaves it to the server.
    model.value =
      stored.status === "fulfilled"
        ? { model_version: stored.value.model_version, horizon_steps: stored.value.horizon_steps, scenario_id: stored.value.scenario_id }
        : null;
    setupError.value = failures[0] ?? null;
    setupLoading.value = false;
  }

  async function loadRuns(id: string): Promise<void> {
    runsLoading.value = true;
    runsError.value = null;
    try {
      const listed = await listRuns(id);
      if (current() === id) runs.value = listed;
    } catch (error) {
      if (current() === id) runsError.value = error;
    } finally {
      if (current() === id) runsLoading.value = false;
    }
  }

  async function reloadRuns(): Promise<void> {
    const id = current();
    if (id !== null && !options.demo) await loadRuns(id);
  }

  async function fetchRun(runId: string): Promise<ForecastResult> {
    const cached = cache.get(runId);
    if (cached) return cached;
    if (options.demo) {
      const bundled = exampleRunResult(runId);
      if (bundled) return bundled;
    }
    const id = current();
    if (id === null) throw new Error(`no project for run ${runId}`);
    const result = await getRun(id, runId);
    cache.set(runId, result);
    return result;
  }

  function addRun(result: ForecastResult): void {
    cache.set(result.run_id, result);
    runs.value = [summaryOf(result), ...runs.value.filter((r) => r.run_id !== result.run_id)];
  }

  if (!options.demo) {
    watch(
      current,
      (id) => {
        cache.clear();
        if (id === null) return;
        void loadSetup(id);
        void loadRuns(id);
      },
      { immediate: true },
    );
  }

  return {
    entities,
    variables,
    model,
    runs,
    setupLoading,
    runsLoading,
    setupError,
    runsError,
    isDemo: options.demo,
    hasRuns: computed(() => runs.value.length > 0),
    reloadRuns,
    fetchRun,
    addRun,
  };
}
