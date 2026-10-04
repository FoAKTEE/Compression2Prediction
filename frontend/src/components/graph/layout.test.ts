import { afterEach, describe, expect, it, vi } from "vitest";
import { exampleMechanismGraph, exampleWorld } from "./examples";
import { fitViewBox, layoutGraph } from "./layout";
import { mechanismLayoutHints, toMechanismGraph, toWorldGraph } from "./model";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("layoutGraph", () => {
  it("is deterministic: two runs give identical coordinates", () => {
    const graph = toWorldGraph(exampleWorld());
    const first = layoutGraph(graph.nodes, graph.edges);
    const second = layoutGraph(toWorldGraph(exampleWorld()).nodes, toWorldGraph(exampleWorld()).edges);
    expect(second).toEqual(first);
    expect(Object.keys(first.positions)).toHaveLength(6);
    for (const point of Object.values(first.positions)) {
      expect(Number.isFinite(point.x) && Number.isFinite(point.y)).toBe(true);
    }
  });

  it("never calls Math.random", () => {
    const random = vi.spyOn(Math, "random");
    const graph = toMechanismGraph(exampleMechanismGraph());
    layoutGraph(graph.nodes, graph.edges);
    expect(random).not.toHaveBeenCalled();
  });

  it("separates nodes, keeps time columns left to right, and stacks ports in order", () => {
    const graph = toMechanismGraph(exampleMechanismGraph());
    const { positions } = layoutGraph(mechanismLayoutHints(graph), graph.edges);
    const x = (id: string) => positions[id]!.x;
    const y = (id: string) => positions[id]!.y;
    const inputs = graph.edges.filter((e) => e.direction === "input").map((e) => e.source);
    const output = graph.edges.find((e) => e.direction === "output")!;
    for (const input of inputs) expect(x(input)).toBeLessThan(x(output.source));
    // status, crew, supplies from top to bottom.
    expect(y(inputs[0]!)).toBeLessThan(y(inputs[1]!));
    expect(y(inputs[1]!)).toBeLessThan(y(inputs[2]!));
    expect(x(output.source)).toBeLessThan(x(output.target));
    const points = Object.values(positions);
    for (let i = 0; i < points.length; i += 1) {
      for (let j = i + 1; j < points.length; j += 1) {
        expect(Math.hypot(points[i]!.x - points[j]!.x, points[i]!.y - points[j]!.y)).toBeGreaterThan(20);
      }
    }
  });

  it("fits a padded view box around the points, with a minimum size", () => {
    expect(fitViewBox([], { x: 10, y: 10 }, { width: 100, height: 50 })).toEqual({ x: -50, y: -25, width: 100, height: 50 });
    const box = fitViewBox(
      [
        { x: 0, y: 0 },
        { x: 400, y: 200 },
      ],
      { x: 20, y: 10 },
      { width: 100, height: 50 },
    );
    expect(box).toEqual({ x: -20, y: -10, width: 440, height: 220 });
  });
});
