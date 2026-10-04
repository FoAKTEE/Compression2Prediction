import { reactive, readonly } from "vue";
import type { CompileModelResponse, Project, ProjectSummary } from "../api/types";
import { STEP_COUNT, STEP_NUMBERS, isStepNumber, type StepNumber } from "../process/steps";

export interface ProjectStoreState {
  projectId: string | null;
  project: Project | null;
  currentStep: StepNumber;
  /** Sorted, without duplicates. */
  completedSteps: StepNumber[];
  /** The server example loaded into this project's world (step 1), so step 2 can load the matching model. */
  exampleName: string | null;
  /** The most recent compile result for this project's current model (step 2). */
  lastCompile: CompileModelResponse | null;
  /** The run selected in steps 3-5, and its report when known. */
  selectedRunId: string | null;
  selectedReportId: string | null;
  /** A report of this project was rendered in this session (step 4). */
  reportViewed: boolean;
}

function initialState(): ProjectStoreState {
  return {
    projectId: null,
    project: null,
    currentStep: 1,
    completedSteps: [],
    exampleName: null,
    lastCompile: null,
    selectedRunId: null,
    selectedReportId: null,
    reportViewed: false,
  };
}

/** Steps whose completion the server's project record decides. */
export type ServerGatedStep = 1 | 2 | 3 | 4;

/** The fields of a project record that step completion reads. */
export type ProjectProgress = Pick<
  ProjectSummary,
  "project_id" | "world_version" | "model_version" | "plan_version" | "last_compile_ok" | "latest_run_id" | "latest_report_id"
>;

/**
 * Step completion derived from the server's project record:
 * step 1 from `world_version`; step 2 from `last_compile_ok === true` and a
 * `model_version`; step 3 from `latest_run_id`; step 4 from `latest_report_id`
 * or a report viewed in this session. Each step also needs the one before it,
 * so a world re-import that clears `model_version` withdraws steps 2-4.
 * `null` means the record does not say (a server that predates these fields),
 * and the session's own completion stands.
 */
export function serverProgress(project: Readonly<ProjectProgress>, reportViewed: boolean): Record<ServerGatedStep, boolean | null> {
  const world = project.world_version !== null;
  const modelKnown = project.model_version !== undefined && project.last_compile_ok !== undefined;
  const compiled = !world
    ? false
    : modelKnown
      ? (project.model_version ?? null) !== null && project.last_compile_ok === true
      : null;
  const ran = compiled === false ? false : project.latest_run_id === undefined ? null : project.latest_run_id !== null;
  let reported: boolean | null;
  if (ran === false) reported = false;
  else if (project.latest_report_id === undefined) reported = reportViewed ? true : null;
  else reported = project.latest_report_id !== null || reportViewed;
  return { 1: world, 2: compiled, 3: ran, 4: reported };
}

const state = reactive<ProjectStoreState>(initialState());

function resetSteps(): void {
  state.currentStep = 1;
  state.completedSteps = [];
  state.exampleName = null;
  state.lastCompile = null;
  state.selectedRunId = null;
  state.selectedReportId = null;
  state.reportViewed = false;
}

function isCompleted(step: StepNumber): boolean {
  return state.completedSteps.includes(step);
}

/** The first step not yet complete (or the last step): every step up to it may be visited. */
function furthestReachableStep(): StepNumber {
  return STEP_NUMBERS.find((step) => !isCompleted(step)) ?? STEP_COUNT;
}

function canVisit(step: StepNumber): boolean {
  return step <= furthestReachableStep();
}

function canAdvance(): boolean {
  return state.currentStep < STEP_COUNT && isCompleted(state.currentStep);
}

/**
 * A small reactive store (no Pinia) for the project being worked on and its
 * step progress. Views read `state` (read-only) and change it through methods.
 */
export const projectStore = {
  state: readonly(state),

  /** Switching to another project resets step progress. */
  setProjectId(projectId: string): void {
    if (state.projectId === projectId) return;
    state.projectId = projectId;
    state.project = null;
    resetSteps();
  },

  setProject(project: Project): void {
    projectStore.setProjectId(project.project_id);
    state.project = project;
  },

  isCompleted,
  canVisit,
  canAdvance,
  furthestReachableStep,

  markStepComplete(step: StepNumber): void {
    if (isCompleted(step)) return;
    state.completedSteps = [...state.completedSteps, step].sort((a, b) => a - b);
  },

  /**
   * Withdraws a step's completion (for example when a recompile fails). Later
   * steps keep their own completion but stay locked until this step completes
   * again; the current step never moves.
   */
  markStepIncomplete(step: StepNumber): void {
    if (!isCompleted(step)) return;
    state.completedSteps = state.completedSteps.filter((s) => s !== step);
  },

  setExampleName(name: string | null): void {
    state.exampleName = name;
  },

  setLastCompile(result: CompileModelResponse | null): void {
    state.lastCompile = result;
  },

  /** Selects a run for steps 3-5; `reportId` is its report when known. */
  selectRun(runId: string | null, reportId: string | null = null): void {
    state.selectedRunId = runId;
    state.selectedReportId = runId === null ? null : reportId;
  },

  /** Records that a report of this project was rendered in this session (it completes step 4). */
  markReportViewed(): void {
    state.reportViewed = true;
  },

  /**
   * Applies {@link serverProgress} for the current project: the server's word
   * marks a step complete or incomplete; a field it does not send leaves the
   * step as it is. A model cleared by a world re-import also drops the last
   * compile result, so step 2 cannot complete from a stale compile.
   */
  syncFromProject(project: Readonly<ProjectProgress>): void {
    if (state.projectId !== project.project_id) return;
    if (project.model_version === null || project.world_version === null) state.lastCompile = null;
    const progress = serverProgress(project, state.reportViewed);
    for (const step of [1, 2, 3, 4] as const) {
      const done = progress[step];
      if (done === true) projectStore.markStepComplete(step);
      else if (done === false) projectStore.markStepIncomplete(step);
    }
  },

  /** Moves to `step` if it is reachable; returns whether it moved. */
  goToStep(step: number): boolean {
    if (!isStepNumber(step) || !canVisit(step)) return false;
    state.currentStep = step;
    return true;
  },

  nextStep(): boolean {
    if (!canAdvance()) return false;
    return projectStore.goToStep(state.currentStep + 1);
  },

  previousStep(): boolean {
    return projectStore.goToStep(state.currentStep - 1);
  },

  reset(): void {
    Object.assign(state, initialState());
  },
};

export type ProjectStore = typeof projectStore;
