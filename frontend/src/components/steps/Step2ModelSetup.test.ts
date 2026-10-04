import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api/client";
import { getExample, listExamples } from "../../api/examples";
import {
  compileModel,
  getEligibility,
  getMechanismGraph,
  importModel,
  listMechanisms,
  listVariables,
} from "../../api/model";
import type {
  CompileModelResponse,
  EligibilityRecord,
  ExampleBundle,
  MechanismGraphResponse,
  ModelImport,
  Project,
} from "../../api/types";
import { projectStore } from "../../store/project";
import { createTestPlugins, serverUnavailable } from "../../test-support";
import { exampleEligibility, exampleMechanismGraph, exampleVariables } from "../graph/examples";
import Step2ModelSetup from "./Step2ModelSetup.vue";

vi.mock("../../api/model", () => ({
  getMechanismGraph: vi.fn(),
  listVariables: vi.fn(),
  listMechanisms: vi.fn(),
  getEligibility: vi.fn(),
  compileModel: vi.fn(),
  importModel: vi.fn(),
}));
vi.mock("../../api/examples", () => ({ listExamples: vi.fn(), getExample: vi.fn() }));

const PROJECT: Project = {
  project_id: "p-1",
  name: "Depot incident",
  prediction_question: "Resolved within two hours?",
  status: "world_ready",
  created_at: "2026-10-01T12:00:00Z",
  updated_at: "2026-10-01T12:00:00Z",
  files: [],
  world_version: "w1",
  model_version: null,
  plan_version: null,
  last_compile_ok: null,
  latest_run_id: null,
  latest_report_id: null,
};

const MODEL: ModelImport = {
  schema_version: "model_import.v1",
  registry: { version: "example.registry.v1", variables: exampleVariables().variables },
  templates: [],
  kernels: [
    {
      kernel_ref: "kernel_incident_progress.v1",
      payload: {
        schema_version: "kernel.v1",
        matrix_convention: "rows=input",
        source: { name: "Unit", values: ["*"] },
        target: { name: "IncidentStatus", values: ["unacknowledged", "acknowledged", "resolved"] },
        rows: [[0.6, 0.3, 0.1]],
        parameter_origin: "hand_specified_illustration",
        fitting_method: "hand_specified",
        training_cutoff: null,
        extra: {},
      },
    },
  ],
  horizon_steps: 2,
  scenario_id: "scn_baseline",
  sources: [["scn_baseline", "crew_capacity", "ent_repair_crew", 0]],
  initial: [],
};

const BUNDLE: ExampleBundle = {
  name: "depot_incident",
  title: "Depot incident",
  description: "Six entities and one incident mechanism.",
  world: { ontology: { version: "o1", subtypes: [], roles: [] }, entities: [], role_assignments: [], participations: [], claims: [], evidence: [] },
  model: MODEL,
};

/** Before a compile the server lists the specs but no variable instances or bindings. */
function uncompiledGraph(): MechanismGraphResponse {
  return { ...exampleMechanismGraph(), model_version: null, variables: [], bindings: [] };
}

const COMPILE_OK: CompileModelResponse = { ok: true, model_version: "model-7f3a", diagnostics: [] };
const COMPILE_FAILED: CompileModelResponse = {
  ok: false,
  model_version: null,
  diagnostics: [
    {
      severity: "error",
      code: "port_domain_mismatch",
      message: "port crew expects crew_capacity on Group, got Location",
      mechanism_id: "mechanism_incident_progress",
      variable_id: "crew_capacity",
      port: "crew",
    },
    {
      severity: "error",
      code: "missing_kernel",
      message: "kernel kernel_incident_progress.v1 is not defined",
      mechanism_id: null,
      variable_id: null,
      port: null,
    },
  ],
};

async function mountStep(path = "/process/p-1") {
  const { plugins } = await createTestPlugins({ path });
  const wrapper = mount(Step2ModelSetup, {
    props: { projectId: "p-1", completed: false },
    global: { plugins: [...plugins] },
  });
  await flushPromises();
  return wrapper;
}

type Wrapper = Awaited<ReturnType<typeof mountStep>>;

const variableIds = (w: Wrapper) => w.findAll("[data-testid='variable-row']").map((r) => r.attributes("data-variable-id"));

enableAutoUnmount(afterEach);

beforeEach(() => {
  projectStore.reset();
  for (const fn of [getMechanismGraph, listVariables, listMechanisms, getEligibility, compileModel, importModel]) {
    vi.mocked(fn).mockReset();
  }
  vi.mocked(listExamples).mockReset();
  vi.mocked(getExample).mockReset();
  // A project whose world exists but has no model yet.
  vi.mocked(getMechanismGraph).mockResolvedValue({ ...uncompiledGraph(), mechanisms: [] });
  vi.mocked(listVariables).mockResolvedValue({ registry_version: null, variables: [] });
  vi.mocked(listMechanisms).mockResolvedValue([]);
  vi.mocked(getEligibility).mockResolvedValue(exampleEligibility());
});

describe("Step2ModelSetup", () => {
  it("shows the empty notice until a model or the example is loaded", async () => {
    const wrapper = await mountStep();
    expect(getMechanismGraph).not.toHaveBeenCalled();
    expect(wrapper.get("[data-testid='mechanism-notice']").attributes("data-variant")).toBe("empty");
    expect(wrapper.find("[data-testid='graph-panel']").exists()).toBe(false);
    expect(wrapper.get("[data-testid='compile']").attributes("disabled")).toBeDefined();
    expect(wrapper.find("[data-testid='mark-complete']").exists()).toBe(false);
  });

  it("previews the guide's incident mechanism in mechanism mode", async () => {
    const wrapper = await mountStep();
    await wrapper.get("[data-testid='load-example']").trigger("click");
    expect(wrapper.get("[data-testid='graph-panel']").attributes("data-mode")).toBe("mechanism");
    const types = wrapper.findAll("[data-testid='graph-node']").map((n) => n.attributes("data-node-type"));
    expect(types).toEqual(["variable", "variable", "variable", "variable", "mechanism"]);
    const ports = wrapper.findAll("[data-testid='graph-edge'].edge--input").map((e) => e.get("text").text());
    expect(ports).toEqual(["0 · status", "1 · crew", "2 · supplies"]);
    expect(wrapper.findAll("[data-testid='graph-edge'].edge--output")).toHaveLength(1);
    // No world was given to the graph, so there is no agent list to leak variables or mechanisms into.
    expect(wrapper.find("[data-testid='agent-candidates']").exists()).toBe(false);
    expect(wrapper.emitted("complete")).toBeUndefined();
  });

  it("with ?example=1 shows the bundled tables and plan offline and counts the step as done", async () => {
    const wrapper = await mountStep("/process/p-1?example=1");
    expect(wrapper.findAll("[data-testid='graph-node']")).toHaveLength(5);
    expect(variableIds(wrapper)).toEqual(["incident_status", "crew_capacity", "supply_status"]);
    expect(wrapper.findAll("[data-testid='mechanism-row']")).toHaveLength(1);
    expect(wrapper.findAll("[data-testid='eligibility-row']")).toHaveLength(6);
    expect(wrapper.get("[data-testid='actions-need-project']").text()).toContain("Offline example");
    expect(wrapper.emitted("complete")).toHaveLength(1);
  });

  it("reports an unreachable server for the mechanism graph", async () => {
    vi.mocked(getMechanismGraph).mockRejectedValue(serverUnavailable());
    projectStore.setProject(PROJECT);
    const wrapper = await mountStep();
    expect(getMechanismGraph).toHaveBeenCalledWith("p-1");
    expect(wrapper.get("[data-testid='mechanism-notice']").attributes("data-variant")).toBe("unavailable");
  });

  it("loads the step-1 example's model, then lists variables and mechanisms with ports in order", async () => {
    vi.mocked(getExample).mockResolvedValue(BUNDLE);
    vi.mocked(importModel).mockResolvedValue({
      model_version: "model-1",
      counts: { variables: 3, templates: 1, kernels: 1, sources: 1 },
    });
    projectStore.setProject(PROJECT);
    projectStore.setExampleName("depot_incident");
    const wrapper = await mountStep();
    expect(wrapper.find("[data-testid='no-variables']").exists()).toBe(true);

    vi.mocked(listVariables).mockResolvedValue(exampleVariables());
    vi.mocked(listMechanisms).mockResolvedValue(exampleMechanismGraph().mechanisms);
    vi.mocked(getMechanismGraph).mockResolvedValue(uncompiledGraph());
    const button = wrapper.get("[data-testid='load-example-model']");
    expect(button.text()).toContain("depot_incident");
    await button.trigger("click");
    await flushPromises();

    expect(getExample).toHaveBeenCalledWith("depot_incident");
    expect(listExamples).not.toHaveBeenCalled();
    expect(importModel).toHaveBeenCalledWith("p-1", MODEL);
    expect(wrapper.get("[data-testid='model-imported']").text()).toContain("3 variables, 1 templates, 1 kernels, 1 sources");
    expect(wrapper.emitted("incomplete")).toHaveLength(1);

    expect(wrapper.get("[data-testid='registry-version']").text()).toContain("example.registry.v1");
    expect(variableIds(wrapper)).toEqual(["incident_status", "crew_capacity", "supply_status"]);
    const status = wrapper.get("[data-testid='variable-row'][data-variable-id='incident_status']");
    expect(status.text()).toContain("Event");
    expect(status.text()).toContain("{unacknowledged, acknowledged, resolved}");
    expect(status.text()).toContain("endogenous");
    expect(status.text()).toContain("reject");
    expect(status.text()).toContain("categorical");

    const row = wrapper.get("[data-testid='mechanism-row'][data-mechanism-id='mechanism_incident_progress']");
    expect(row.get("[data-testid='mechanism-family']").text()).toBe("incident_progress");
    const inputs = row.findAll("[data-testid='mechanism-input']");
    expect(inputs.map((i) => i.attributes("data-port"))).toEqual(["status", "crew", "supplies"]);
    expect(inputs.map((i) => i.attributes("data-port-index"))).toEqual(["0", "1", "2"]);
    expect(inputs[1]!.text()).toContain("1 · crew");
    expect(inputs[1]!.text()).toContain("crew_capacity @ t");
    expect(row.get("[data-testid='mechanism-output']").text()).toContain("next_status");
    expect(row.get("[data-testid='mechanism-output']").text()).toContain("incident_status @ t+1");
    expect(row.text()).toContain("kernel_incident_progress.v1");
    expect(row.text()).toContain("hand_specified_illustration");
    expect(row.text()).toContain("not_empirically_validated");
  });

  it("opens the example picker when no example was remembered from step 1", async () => {
    vi.mocked(listExamples).mockResolvedValue([{ name: BUNDLE.name, title: BUNDLE.title, description: BUNDLE.description }]);
    vi.mocked(getExample).mockResolvedValue(BUNDLE);
    vi.mocked(importModel).mockResolvedValue({ model_version: "m", counts: { variables: 3, templates: 1, kernels: 1, sources: 1 } });
    projectStore.setProject(PROJECT);
    const wrapper = await mountStep();
    await wrapper.get("[data-testid='load-example-model']").trigger("click");
    await flushPromises();
    expect(wrapper.findAll("[data-testid='example-option']")).toHaveLength(1);
    await wrapper.get("[data-testid='example-confirm']").trigger("click");
    await flushPromises();
    expect(importModel).toHaveBeenCalledWith("p-1", MODEL);
    expect(projectStore.state.exampleName).toBe("depot_incident");
    expect(wrapper.find("[data-testid='example-picker']").exists()).toBe(false);
  });

  it("shows a rejected model import inline", async () => {
    vi.mocked(importModel).mockRejectedValue(
      new ApiError({ status: 422, code: "invalid_model", message: "templates[0]: binding for unknown port 'crews'" }),
    );
    projectStore.setProject(PROJECT);
    const wrapper = await mountStep();
    const input = wrapper.get("[data-testid='model-file']");
    Object.defineProperty(input.element, "files", {
      value: [new File([JSON.stringify(MODEL)], "model.json", { type: "application/json" })],
      configurable: true,
    });
    await input.trigger("change");
    await flushPromises();
    expect(importModel).toHaveBeenCalledWith("p-1", MODEL);
    const error = wrapper.get("[data-testid='model-import-error']");
    expect(error.text()).toContain("The server rejected this import");
    expect(error.text()).toContain("templates[0]: binding for unknown port 'crews'");
  });

  it("explains a model import sent before the world exists (404 world_not_ready)", async () => {
    vi.mocked(getExample).mockResolvedValue(BUNDLE);
    vi.mocked(importModel).mockRejectedValue(
      new ApiError({ status: 404, code: "world_not_ready", message: "project p-1 has no world yet" }),
    );
    projectStore.setProject(PROJECT);
    projectStore.setExampleName("depot_incident");
    const wrapper = await mountStep();
    await wrapper.get("[data-testid='load-example-model']").trigger("click");
    await flushPromises();
    expect(wrapper.get("[data-testid='model-import-error']").text()).toContain("Build the world in step 1 first");
  });

  describe("compile", () => {
    it("ok: shows the success line with the model version, completes, and draws the server plan", async () => {
      vi.mocked(listMechanisms).mockResolvedValue(exampleMechanismGraph().mechanisms);
      vi.mocked(getMechanismGraph).mockResolvedValueOnce(uncompiledGraph()).mockResolvedValue(exampleMechanismGraph());
      vi.mocked(compileModel).mockResolvedValue(COMPILE_OK);
      projectStore.setProject(PROJECT);
      const wrapper = await mountStep();
      expect(wrapper.find("[data-testid='compile-idle']").exists()).toBe(true);
      expect(wrapper.find("[data-testid='graph-node']").exists()).toBe(false);

      await wrapper.get("[data-testid='compile']").trigger("click");
      await flushPromises();
      expect(compileModel).toHaveBeenCalledWith("p-1");
      const success = wrapper.get("[data-testid='compile-ok']");
      expect(success.text()).toContain("Compiled.");
      expect(success.text()).toContain("model-7f3a");
      expect(wrapper.find("[data-testid='diagnostic-row']").exists()).toBe(false);
      expect(projectStore.state.lastCompile).toEqual(COMPILE_OK);
      expect(wrapper.emitted("complete")).toHaveLength(1);
      expect(wrapper.emitted("incomplete")).toBeUndefined();

      expect(getMechanismGraph).toHaveBeenCalledTimes(2);
      expect(wrapper.get("[data-testid='graph-panel']").attributes("data-mode")).toBe("mechanism");
      const types = wrapper.findAll("[data-testid='graph-node']").map((n) => n.attributes("data-node-type"));
      expect(types.filter((type) => type === "mechanism")).toHaveLength(1);
      expect(types.filter((type) => type === "variable")).toHaveLength(4);
    });

    it("ok: false lists each diagnostic with its chips and leaves the step incomplete", async () => {
      vi.mocked(compileModel).mockResolvedValue(COMPILE_FAILED);
      projectStore.setProject(PROJECT);
      const wrapper = await mountStep();
      await wrapper.get("[data-testid='compile']").trigger("click");
      await flushPromises();

      expect(wrapper.find("[data-testid='compile-ok']").exists()).toBe(false);
      expect(wrapper.get("[data-testid='compile-failed']").text()).toBe("Compile failed with 2 errors");
      const rows = wrapper.findAll("[data-testid='diagnostic-row']");
      expect(rows).toHaveLength(2);
      expect(rows[0]!.attributes("data-severity")).toBe("error");
      expect(rows[0]!.get("[data-testid='diagnostic-code']").text()).toBe("port_domain_mismatch");
      expect(rows[0]!.text()).toContain("port crew expects crew_capacity on Group, got Location");
      expect(rows[0]!.get("[data-testid='chip-port']").text()).toBe("portcrew");
      expect(rows[0]!.get("[data-testid='chip-mechanism']").text()).toContain("mechanism_incident_progress");
      expect(rows[0]!.get("[data-testid='chip-variable']").text()).toContain("crew_capacity");
      expect(rows[1]!.find("[data-testid='chip-port']").exists()).toBe(false);
      expect(rows[1]!.find("[data-testid='chip-mechanism']").exists()).toBe(false);
      expect(wrapper.emitted("complete")).toBeUndefined();
      expect(wrapper.emitted("incomplete")).toHaveLength(1);
    });

    it("keeps the last compile result when the step is revisited", async () => {
      projectStore.setProject(PROJECT);
      projectStore.setLastCompile(COMPILE_FAILED);
      const wrapper = await mountStep();
      expect(wrapper.findAll("[data-testid='diagnostic-row']")).toHaveLength(2);
      expect(wrapper.emitted("complete")).toBeUndefined();
    });

    it("explains a compile with no model (404 model_not_found)", async () => {
      vi.mocked(compileModel).mockRejectedValue(
        new ApiError({ status: 404, code: "model_not_found", message: "project p-1 has no model" }),
      );
      projectStore.setProject(PROJECT);
      const wrapper = await mountStep();
      await wrapper.get("[data-testid='compile']").trigger("click");
      await flushPromises();
      expect(wrapper.get("[data-testid='compile-error']").text()).toContain("There is no model to compile");
      expect(wrapper.emitted("complete")).toBeUndefined();
    });
  });

  describe("eligibility", () => {
    it("lists only world entities with their status and basis, never variables or mechanisms", async () => {
      const stray = (fields: Partial<EligibilityRecord>): EligibilityRecord =>
        ({
          entity_id: "x",
          display_name: "x",
          primary_kind: "Person",
          agent_eligible: false,
          agent_eligibility_basis: null,
          ...fields,
        }) as EligibilityRecord;
      const base = exampleEligibility();
      vi.mocked(getEligibility).mockResolvedValue({
        ...base,
        entities: [
          ...base.entities,
          stray({ entity_id: "incident_status", display_name: "incident_status", primary_kind: "Variable" as never }),
          stray({ entity_id: "mechanism_incident_progress", display_name: "incident_progress", primary_kind: "Mechanism" as never, agent_eligible: true }),
          // The string "true" never makes an entity eligible.
          stray({ entity_id: "ent_string_true", display_name: "String true", agent_eligible: "true" as never }),
        ],
      });
      vi.mocked(listVariables).mockResolvedValue(exampleVariables());
      vi.mocked(listMechanisms).mockResolvedValue(exampleMechanismGraph().mechanisms);
      projectStore.setProject(PROJECT);
      const wrapper = await mountStep();

      const panel = wrapper.get("[data-testid='eligibility-panel']");
      const ids = panel.findAll("[data-testid='eligibility-row']").map((r) => r.attributes("data-entity-id"));
      expect(ids).toEqual([...base.entities.map((e) => e.entity_id), "ent_string_true"]);
      for (const leaked of ["incident_status", "crew_capacity", "mechanism_incident_progress", "incident_progress"]) {
        expect(panel.text()).not.toContain(leaked);
      }
      const status = (id: string) => panel.get(`[data-entity-id='${id}'] [data-testid='eligibility-status']`).text();
      expect(status("ent_operator_a")).toBe("Yes");
      expect(status("ent_review_meeting")).toBe("No");
      expect(status("ent_string_true")).toBe("No");
      expect(panel.get("[data-entity-id='ent_operator_a']").text()).toContain("explicit_synthetic_scenario_selection");
      expect(panel.get("[data-testid='eligibility-entity-count'] .stat__value").text()).toBe("7");
      expect(panel.get("[data-testid='eligibility-agent-count'] .stat__value").text()).toBe("2");
    });

    it("explains that eligibility needs a world (404 world_not_ready)", async () => {
      vi.mocked(getEligibility).mockRejectedValue(
        new ApiError({ status: 404, code: "world_not_ready", message: "project p-1 has no world yet" }),
      );
      projectStore.setProject(PROJECT);
      const wrapper = await mountStep();
      const notice = wrapper.get("[data-testid='eligibility-notice']");
      expect(notice.attributes("data-variant")).toBe("empty");
      expect(notice.text()).toContain("Build the world in step 1");
    });
  });
});
