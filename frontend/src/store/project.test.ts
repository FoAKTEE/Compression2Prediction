import { beforeEach, describe, expect, it } from "vitest";
import type { Project } from "../api/types";
import { projectStore } from "./project";

const project = (project_id: string): Project => ({
  project_id,
  name: project_id,
  prediction_question: "?",
  status: "created",
  created_at: "2026-10-04T00:00:00Z",
  updated_at: "2026-10-04T00:00:00Z",
  files: [],
  world_version: null,
});

beforeEach(() => projectStore.reset());

describe("projectStore", () => {
  it("gates advancing on completion of the current step", () => {
    expect(projectStore.state.currentStep).toBe(1);
    expect(projectStore.canAdvance()).toBe(false);
    expect(projectStore.nextStep()).toBe(false);
    projectStore.markStepComplete(1);
    expect(projectStore.nextStep()).toBe(true);
    expect(projectStore.state.currentStep).toBe(2);
    expect(projectStore.state.completedSteps).toEqual([1]);
  });

  it("allows visiting completed steps and the first incomplete one only", () => {
    projectStore.markStepComplete(1);
    projectStore.markStepComplete(2);
    expect(projectStore.furthestReachableStep()).toBe(3);
    expect(projectStore.goToStep(3)).toBe(true);
    expect(projectStore.goToStep(1)).toBe(true);
    expect(projectStore.goToStep(4)).toBe(false);
    expect(projectStore.goToStep(0)).toBe(false);
    expect(projectStore.goToStep(6)).toBe(false);
    expect(projectStore.state.currentStep).toBe(1);
  });

  it("never advances past the last step", () => {
    for (const step of [1, 2, 3, 4, 5] as const) projectStore.markStepComplete(step);
    expect(projectStore.goToStep(5)).toBe(true);
    expect(projectStore.canAdvance()).toBe(false);
    expect(projectStore.nextStep()).toBe(false);
  });

  it("resets step progress when the project changes, but not for the same project", () => {
    projectStore.setProject(project("p-1"));
    projectStore.markStepComplete(1);
    projectStore.nextStep();
    projectStore.setProjectId("p-1");
    expect(projectStore.state.currentStep).toBe(2);
    expect(projectStore.state.project?.project_id).toBe("p-1");

    projectStore.setProjectId("p-2");
    expect(projectStore.state.currentStep).toBe(1);
    expect(projectStore.state.completedSteps).toEqual([]);
    expect(projectStore.state.project).toBeNull();
  });
});
