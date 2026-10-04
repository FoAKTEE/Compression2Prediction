import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import type { MechanismGraphResponse, WorldResponse } from "../../api/types";
import { createTestPlugins } from "../../test-support";
import { exampleMechanismGraph, exampleWorld } from "./examples";
import GraphPanel from "./GraphPanel.vue";

async function mountPanel(
  props: { world?: WorldResponse | null; mechanism?: MechanismGraphResponse | null; initialMode?: "world" | "mechanism"; loading?: boolean },
  locale: "en" | "zh" = "en",
) {
  const { plugins } = await createTestPlugins({ locale });
  return mount(GraphPanel, { props, global: { plugins: [...plugins] } });
}

type Wrapper = Awaited<ReturnType<typeof mountPanel>>;

const nodes = (w: Wrapper) => w.findAll("[data-testid='graph-node']");
const node = (w: Wrapper, id: string) => w.get(`[data-testid='graph-node'][data-node-id='${id}']`);
const nodeTypes = (w: Wrapper) => nodes(w).map((n) => n.attributes("data-node-type"));
const edgeClasses = (w: Wrapper) => w.findAll("[data-testid='graph-edge']").map((e) => e.classes());

describe("GraphPanel", () => {
  it("mounts in world mode with one node per entity and the three edge layers", async () => {
    const w = await mountPanel({ world: exampleWorld(), mechanism: exampleMechanismGraph() });
    expect(w.attributes("data-mode")).toBe("world");
    expect(nodes(w)).toHaveLength(6);
    expect(new Set(nodeTypes(w))).toEqual(new Set(["entity"]));
    expect(w.findAll("[data-testid='graph-edge']")).toHaveLength(8);
    expect(edgeClasses(w).filter((c) => c.includes("edge--dashed")).every((c) => c.includes("edge--claims"))).toBe(true);
    expect(node(w, "entity:ent_operator_a").classes()).toEqual(
      expect.arrayContaining(["kind--person", "origin--assumed", "is-candidate"]),
    );
    expect(node(w, "entity:ent_east_depot").classes()).toEqual(expect.arrayContaining(["kind--location", "origin--observed"]));
  });

  it("toggles edge layers without moving or removing nodes", async () => {
    const w = await mountPanel({ world: exampleWorld() });
    const before = nodes(w).map((n) => n.attributes("transform"));
    await w.get("[data-testid='layer-claims']").setValue(false);
    expect(edgeClasses(w).some((c) => c.includes("edge--claims"))).toBe(false);
    expect(w.findAll("[data-testid='graph-edge']")).toHaveLength(7);
    await w.get("[data-testid='layer-participation']").setValue(false);
    await w.get("[data-testid='layer-roles']").setValue(false);
    expect(w.findAll("[data-testid='graph-edge']")).toHaveLength(0);
    expect(nodes(w).map((n) => n.attributes("transform"))).toEqual(before);
    await w.get("[data-testid='layer-claims']").setValue(true);
    expect(edgeClasses(w)).toEqual([expect.arrayContaining(["edge--claims", "edge--dashed"])]);
  });

  it("switches between the World and Mechanism views", async () => {
    const w = await mountPanel({ world: exampleWorld(), mechanism: exampleMechanismGraph() });
    await w.get("[data-testid='mode-mechanism']").trigger("click");
    expect(w.attributes("data-mode")).toBe("mechanism");
    expect(w.get("[data-testid='mode-mechanism']").attributes("aria-pressed")).toBe("true");
    expect(nodeTypes(w).sort()).toEqual(["mechanism", "variable", "variable", "variable", "variable"]);
    expect(w.find("[data-testid='layer-toggles']").exists()).toBe(false);
    expect(w.text()).toContain("incident_status · ent_incident_001 · 0");

    await w.get("[data-testid='mode-world']").trigger("click");
    expect(nodes(w)).toHaveLength(6);
    expect(new Set(nodeTypes(w))).toEqual(new Set(["entity"]));
  });

  it("renders input ports in declared order with exactly one output edge", async () => {
    const w = await mountPanel({ mechanism: exampleMechanismGraph(), initialMode: "mechanism" });
    const inputs = w.findAll("[data-testid='graph-edge'].edge--input");
    expect(inputs.map((e) => e.attributes("data-port-index"))).toEqual(["0", "1", "2"]);
    expect(inputs.map((e) => e.get("text").text())).toEqual(["0 · status", "1 · crew", "2 · supplies"]);
    expect(w.findAll("[data-testid='graph-edge'].edge--output")).toHaveLength(1);
  });

  it("shows entity details for the selected node: kind, subtypes, roles, origin, evidence", async () => {
    const w = await mountPanel({ world: exampleWorld() });
    expect(w.get("[data-testid='graph-detail']").text()).toContain("Select a node");
    await node(w, "entity:ent_operator_a").trigger("click");
    const detail = w.get("[data-testid='graph-detail']");
    expect(detail.get("[data-testid='detail-kind']").text()).toBe("Person");
    expect(detail.text()).toContain("Operator");
    expect(detail.get("[data-testid='detail-origin']").classes()).toContain("origin--assumed");
    expect(detail.get("[data-testid='detail-evidence']").text()).toBe("No evidence records");
    const roles = detail.findAll("[data-testid='detail-roles'] li").map((li) => li.text());
    expect(roles[0]).toContain("Employee in Northline Transit");
    expect(roles[0]).toContain("[0, +∞)");
    expect(roles[1]).toContain("[4, 12)");
    expect(node(w, "entity:ent_operator_a").attributes("aria-pressed")).toBe("true");

    await node(w, "entity:ent_review_meeting").trigger("click");
    expect(w.get("[data-testid='detail-kind']").text()).toBe("Event");
    expect(w.get("[data-testid='detail-evidence']").text()).toBe("2 evidence records");
  });

  it("selects a focused node with Enter and shows mechanism details in port order", async () => {
    const w = await mountPanel({ mechanism: exampleMechanismGraph(), initialMode: "mechanism" });
    const mechanism = node(w, "mechanism:bind_incident_progress_t0");
    expect(mechanism.attributes("tabindex")).toBe("0");
    await mechanism.trigger("keydown", { key: "Enter" });
    const detail = w.get("[data-testid='graph-detail']");
    expect(detail.get("[data-testid='detail-family']").text()).toBe("incident_progress");
    expect(detail.findAll("[data-testid='detail-inputs'] li").map((li) => li.attributes("data-port"))).toEqual([
      "status",
      "crew",
      "supplies",
    ]);
    expect(detail.get("[data-testid='detail-output']").text()).toContain("next_status");
    expect(detail.text()).toContain("kernel_incident_progress.v1");
    expect(detail.text()).toContain("explicit_model_assumption");
    expect(detail.text()).toContain("hand_specified_illustration");
    expect(detail.text()).toContain("not_empirically_validated");

    await node(w, 'variable:["scn_baseline","crew_capacity","ent_repair_crew",0]').trigger("keydown", { key: "Enter" });
    expect(w.get("[data-testid='detail-key']").text()).toBe("(scn_baseline, crew_capacity, ent_repair_crew, 0)");
    expect(w.get("[data-testid='detail-domain']").text()).toBe("crew_capacity: {baseline, extra_crew}");

    await w.get("[data-testid='clear-selection']").trigger("click");
    expect(w.get("[data-testid='graph-detail']").text()).toContain("Select a node");
  });

  it("lists agent candidates with world and candidate counts shown separately, in both views", async () => {
    const w = await mountPanel({ world: exampleWorld(), mechanism: exampleMechanismGraph() });
    expect(w.get("[data-testid='world-entity-count']").text()).toContain("6");
    expect(w.get("[data-testid='agent-candidate-count']").text()).toContain("2");
    const listed = () => w.findAll("[data-testid='agent-list'] li").map((li) => li.attributes("data-entity-id"));
    expect(listed()).toEqual(["ent_operator_a", "ent_engineer_b"]);

    await w.get("[data-testid='mode-mechanism']").trigger("click");
    expect(listed()).toEqual(["ent_operator_a", "ent_engineer_b"]);
    const agentText = w.get("[data-testid='agent-candidates']").text();
    for (const label of ["incident_status", "crew_capacity", "supply_status", "incident_progress"]) {
      expect(agentText).not.toContain(label);
    }
  });

  it("draws observed, extracted, assumed, and simulated records with distinct classes", async () => {
    const w = await mountPanel({ world: exampleWorld(), mechanism: exampleMechanismGraph() });
    const originsOf = (wrapper: Wrapper) =>
      nodes(wrapper).flatMap((n) => n.classes().filter((c) => c.startsWith("origin--")));
    const seen = new Set(originsOf(w));
    await w.get("[data-testid='mode-mechanism']").trigger("click");
    for (const origin of originsOf(w)) seen.add(origin);
    expect(seen).toEqual(new Set(["origin--observed", "origin--extracted", "origin--assumed", "origin--simulated"]));
    const legend = w.get("[data-testid='graph-legend']").findAll("[data-origin]");
    expect(legend.map((li) => li.get("svg").classes()[1])).toEqual([
      "origin--observed",
      "origin--extracted",
      "origin--assumed",
      "origin--simulated",
    ]);
  });

  it("handles empty, loading, and invalid inputs", async () => {
    const empty = await mountPanel({ world: null });
    expect(empty.get("[data-testid='graph-state']").attributes("data-variant")).toBe("empty");
    expect(empty.find("[data-testid='graph-canvas']").exists()).toBe(false);
    expect(empty.find("[data-testid='agent-candidates']").exists()).toBe(false);

    const loading = await mountPanel({ world: null, loading: true });
    expect(loading.get("[data-testid='graph-state']").attributes("data-variant")).toBe("loading");

    const bad = exampleMechanismGraph();
    bad.mechanisms[0]!.outputs.push({ port: "extra", variable: "crew_capacity", time_offset: 1 });
    const invalid = await mountPanel({ mechanism: bad, initialMode: "mechanism" });
    const state = invalid.get("[data-testid='graph-state']");
    expect(state.attributes("data-variant")).toBe("error");
    expect(state.text()).toContain("exactly one is allowed");
  });

  it("keeps a static graph when the DOM has no real layout (no zoom controls)", async () => {
    const w = await mountPanel({ world: exampleWorld() });
    expect(w.find("[data-testid='zoom-controls']").exists()).toBe(false);
    expect(w.get("svg.graph-panel__svg").attributes("viewBox")).toMatch(/^-?[\d.]+ -?[\d.]+ [\d.]+ [\d.]+$/);
  });

  it("renders the same coordinates on every mount", async () => {
    const a = await mountPanel({ world: exampleWorld() });
    const b = await mountPanel({ world: exampleWorld() });
    expect(nodes(b).map((n) => n.attributes("transform"))).toEqual(nodes(a).map((n) => n.attributes("transform")));
  });

  it("translates its labels", async () => {
    const w = await mountPanel({ world: exampleWorld() }, "zh");
    expect(w.get("[data-testid='mode-world']").text()).toBe("世界");
    expect(w.get("[data-testid='agent-candidates']").text()).toContain("智能体候选");
  });
});
