import { reactive, readonly } from "vue";
import type { CompileModelResponse, Project } from "../api/types";
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
}

function initialState(): ProjectStoreState {
  return { projectId: null, project: null, currentStep: 1, completedSteps: [], exampleName: null, lastCompile: null };
}

const state = reactive<ProjectStoreState>(initialState());

function resetSteps(): void {
  state.currentStep = 1;
  state.completedSteps = [];
  state.exampleName = null;
  state.lastCompile = null;
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
