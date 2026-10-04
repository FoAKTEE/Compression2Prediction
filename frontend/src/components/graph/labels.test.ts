import { describe, expect, it } from "vitest";
import { exampleWorld } from "./examples";
import {
  EDGE_LABEL_DEFAULTS,
  labelSize,
  nodeObstacles,
  overlapArea,
  placeEdgeLabels,
  segmentHitsBox,
  textWidth,
  type Box,
  type LabelEdge,
  type PlacedLabel,
} from "./labels";
import { layoutGraph } from "./layout";
import { toWorldGraph } from "./model";

const TOLERANCE = EDGE_LABEL_DEFAULTS.tolerance;

function edge(id: string, label: string, source: [number, number], target: [number, number], r = 15): LabelEdge {
  return {
    id,
    label,
    source: { x: source[0], y: source[1] },
    target: { x: target[0], y: target[1] },
    sourceRadius: r,
    targetRadius: r,
  };
}

function expectNoOverlap(labels: PlacedLabel[], obstacles: Box[]): void {
  const visible = labels.filter((l) => !l.hidden);
  for (let i = 0; i < visible.length; i += 1) {
    for (let j = i + 1; j < visible.length; j += 1) {
      expect(overlapArea(visible[i]!.box, visible[j]!.box), `${visible[i]!.id} / ${visible[j]!.id}`).toBeLessThanOrEqual(
        TOLERANCE,
      );
    }
    for (const obstacle of obstacles) expect(overlapArea(visible[i]!.box, obstacle)).toBeLessThanOrEqual(TOLERANCE);
  }
}

describe("label geometry", () => {
  it("estimates monospace widths, wide characters at a full em", () => {
    expect(textWidth("abcd", 10)).toBeCloseTo(24);
    expect(textWidth("雇员", 10)).toBeCloseTo(20);
    const size = labelSize("Employee");
    expect(size.width).toBeCloseTo(8 * 0.6 * 11 + 6);
    expect(size.height).toBeGreaterThan(11);
  });

  it("measures box overlap and segment hits", () => {
    const a: Box = { x: 0, y: 0, width: 10, height: 10 };
    expect(overlapArea(a, { x: 5, y: 5, width: 10, height: 10 })).toBe(25);
    expect(overlapArea(a, { x: 10, y: 0, width: 10, height: 10 })).toBe(0);
    expect(segmentHitsBox({ x: -5, y: 5 }, { x: 15, y: 5 }, a)).toBe(true);
    expect(segmentHitsBox({ x: -5, y: 20 }, { x: 15, y: 20 }, a)).toBe(false);
  });
});

describe("placeEdgeLabels", () => {
  it("centres a lone label on its edge", () => {
    const [label] = placeEdgeLabels([edge("e", "Employee", [0, 0], [200, 0])], []);
    expect(label).toMatchObject({ x: 100, y: 0, hidden: false, reason: null });
  });

  it("hides the label of an edge shorter than the threshold, and of an unlabelled edge", () => {
    const labels = placeEdgeLabels([edge("short", "ShiftLead", [0, 0], [70, 0]), edge("blank", " ", [0, 100], [300, 100])], []);
    expect(labels.map((l) => [l.hidden, l.reason])).toEqual([
      [true, "short"],
      [true, "empty"],
    ]);
  });

  it("moves a second label off the first when two edges share a line", () => {
    const labels = placeEdgeLabels([edge("a", "Employee", [0, 0], [240, 0]), edge("b", "Contractor", [0, 0], [240, 0])], []);
    expect(labels.every((l) => !l.hidden)).toBe(true);
    expect(labels[0]!.x === labels[1]!.x && labels[0]!.y === labels[1]!.y).toBe(false);
    expectNoOverlap(labels, []);
  });

  it("prefers a spot that no other edge crosses", () => {
    // Two edges crossing at their midpoints: the second label must leave the crossing.
    const edges = [edge("h", "venue", [-150, 0], [150, 0]), edge("v", "attendee", [0, -150], [0, 150])];
    const labels = placeEdgeLabels(edges, []);
    const crossing: Box = { x: -1, y: -1, width: 2, height: 2 };
    expect(overlapArea(labels[1]!.box, crossing)).toBe(0);
    expect(segmentHitsBox(edges[0]!.source, edges[0]!.target, labels[1]!.box)).toBe(false);
  });

  it("hides a label that has no free spot, and never overlaps an obstacle", () => {
    const wall: Box = { x: -500, y: -500, width: 1000, height: 1000 };
    const [label] = placeEdgeLabels([edge("e", "organizer", [0, 0], [200, 0])], [wall]);
    expect(label).toMatchObject({ hidden: true, reason: "crowded" });
  });

  it("is deterministic", () => {
    const edges = [edge("a", "x_label", [0, 0], [200, 50]), edge("b", "y_label", [200, 50], [20, 160])];
    expect(placeEdgeLabels(edges, [])).toEqual(placeEdgeLabels(edges, []));
  });

  it("places every six-entity world label clear of the others, the glyphs, and the node names", () => {
    const graph = toWorldGraph(exampleWorld());
    const { positions } = layoutGraph(graph.nodes, graph.edges);
    const r = 15;
    const nodes = graph.nodes.map((n) => ({
      ...positions[n.id]!,
      r,
      label: n.label,
      labelX: 0,
      labelY: r + 18,
      labelAnchor: "middle" as const,
    }));
    const obstacles = nodeObstacles(nodes);
    const edges = graph.edges.map((e) => ({
      id: e.id,
      label: e.label,
      source: positions[e.source]!,
      target: positions[e.target]!,
      sourceRadius: r + 3,
      targetRadius: r + 8,
    }));
    const labels = placeEdgeLabels(edges, obstacles);
    expect(labels).toHaveLength(8);
    expect(labels.filter((l) => !l.hidden).length).toBeGreaterThanOrEqual(6);
    for (const hidden of labels.filter((l) => l.hidden)) expect(hidden.reason).not.toBeNull();
    expectNoOverlap(labels, obstacles);
    expect(placeEdgeLabels(edges, obstacles)).toEqual(labels);
  });
});
