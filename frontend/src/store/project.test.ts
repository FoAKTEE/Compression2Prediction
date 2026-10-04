import { beforeEach, describe, expect, it } from "vitest";
import type { Project } from "../api/types";
import { projectStore, serverProgress } from "./project";

const project = (project_id: string): Project => ({
  project_id,
  name: project_id,
  prediction_question: "?",
  status: "created",
  created_at: "2026-10-04T00:00:00Z",
  updated_at: "2026-10-04T00:00:00Z",
  files: [],
  world_version: null,
  model_version: null,
  plan_version: null,
  last_compile_ok: null,
  latest_run_id: null,
  latest_report_id: null,
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

  it("selects a run for steps 3-5 and forgets it with the project", () => {
    projectStore.setProject(project("p-1"));
    projectStore.selectRun("run_1", "rep_1");
    projectStore.markReportViewed();
    expect([projectStore.state.selectedRunId, projectStore.state.selectedReportId, projectStore.state.reportViewed]).toEqual([
      "run_1",
      "rep_1",
      true,
    ]);
    projectStore.setProjectId("p-2");
    expect([projectStore.state.selectedRunId, projectStore.state.selectedReportId, projectStore.state.reportViewed]).toEqual([
      null,
      null,
      false,
    ]);
  });
});

describe("server-derived step completion", () => {
  const full = (): Project => ({
    ...project("p-1"),
    world_version: "w-1",
    model_version: "m-1",
    plan_version: "plan-1",
    last_compile_ok: true,
    latest_run_id: "run_1",
    latest_report_id: "rep_1",
  });

  it("reads world, compile, run, and report from the record, each needing the one before", () => {
    expect(serverProgress(full(), false)).toEqual({ 1: true, 2: true, 3: true, 4: true });
    expect(serverProgress({ ...full(), last_compile_ok: false }, false)).toEqual({ 1: true, 2: false, 3: false, 4: false });
    expect(serverProgress({ ...full(), last_compile_ok: null }, false)).toEqual({ 1: true, 2: false, 3: false, 4: false });
    expect(serverProgress({ ...full(), latest_report_id: null }, false)[4]).toBe(false);
    expect(serverProgress({ ...full(), latest_report_id: null }, true)[4]).toBe(true);
    expect(serverProgress({ ...full(), latest_run_id: null, latest_report_id: null }, true)).toEqual({ 1: true, 2: true, 3: false, 4: false });
    expect(serverProgress({ ...full(), world_version: null }, true)).toEqual({ 1: false, 2: false, 3: false, 4: false });
  });

  it("treats fields an older server omits as unknown", () => {
    const old = { project_id: "p-1", world_version: "w-1" } as unknown as Project;
    expect(serverProgress(old, false)).toEqual({ 1: true, 2: null, 3: null, 4: null });
    expect(serverProgress(old, true)[4]).toBe(true);
  });

  it("a re-import that clears model_version withdraws steps 2-4 and the last compile, keeping step 1", () => {
    projectStore.setProject(full());
    projectStore.syncFromProject(full());
    projectStore.setLastCompile({ ok: true, model_version: "m-1", diagnostics: [] });
    expect(projectStore.state.completedSteps).toEqual([1, 2, 3, 4]);
    projectStore.syncFromProject({ ...full(), world_version: "w-2", model_version: null, plan_version: null, last_compile_ok: null });
    expect(projectStore.state.completedSteps).toEqual([1]);
    expect(projectStore.state.lastCompile).toBeNull();
  });

  it("ignores the record of another project", () => {
    projectStore.setProject(full());
    projectStore.syncFromProject({ ...full(), project_id: "p-other" });
    expect(projectStore.state.completedSteps).toEqual([]);
  });
});
