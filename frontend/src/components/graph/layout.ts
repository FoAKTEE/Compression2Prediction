/**
 * Force layout computed once, synchronously, for a fixed number of ticks.
 *
 * There is no animation loop and no `Math.random`: d3-force places new nodes on
 * its deterministic phyllotaxis spiral and jiggles with its own seeded LCG, so
 * the same graph always gets the same coordinates.
 */
import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY } from "d3";
import type { SimulationLinkDatum, SimulationNodeDatum } from "d3";

export interface LayoutNode {
  id: string;
  /** Optional column (for example a time index); nodes are pulled toward its x position. */
  column?: number;
  /** Optional row within the column; nodes are pulled toward its y position. */
  row?: number;
}

export interface LayoutEdge {
  source: string;
  target: string;
}

export interface Point {
  x: number;
  y: number;
}

export interface ViewBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Layout {
  positions: Record<string, Point>;
  viewBox: ViewBox;
}

export interface LayoutOptions {
  ticks?: number;
  /** Horizontal distance between columns. */
  columnWidth?: number;
  /** Vertical distance between rows. */
  rowHeight?: number;
  linkDistance?: number;
  charge?: number;
  collideRadius?: number;
  /** Space kept around the outermost nodes for labels. */
  padding?: { x: number; y: number };
  minSize?: { width: number; height: number };
}

export const LAYOUT_TICKS = 300;

const DEFAULTS: Required<LayoutOptions> = {
  ticks: LAYOUT_TICKS,
  columnWidth: 300,
  rowHeight: 110,
  linkDistance: 190,
  charge: -1500,
  collideRadius: 68,
  padding: { x: 110, y: 56 },
  minSize: { width: 640, height: 400 },
};

interface SimNode extends SimulationNodeDatum {
  id: string;
  column?: number;
  row?: number;
}

const round = (value: number): number => Math.round(value * 100) / 100;

export function layoutGraph(nodes: readonly LayoutNode[], edges: readonly LayoutEdge[], options: LayoutOptions = {}): Layout {
  const o = { ...DEFAULTS, ...options };
  const simNodes: SimNode[] = nodes.map((n) => {
    const node: SimNode = { id: n.id };
    if (n.column !== undefined) node.column = n.column;
    if (n.row !== undefined) node.row = n.row;
    return node;
  });
  const known = new Set(simNodes.map((n) => n.id));
  const links: SimulationLinkDatum<SimNode>[] = edges
    .filter((e) => known.has(e.source) && known.has(e.target) && e.source !== e.target)
    .map((e) => ({ source: e.source, target: e.target }));
  const columned = simNodes.some((n) => n.column !== undefined);
  const rowed = simNodes.some((n) => n.row !== undefined);

  const simulation = forceSimulation<SimNode>(simNodes)
    .force(
      "link",
      forceLink<SimNode, SimulationLinkDatum<SimNode>>(links)
        .id((n) => n.id)
        .distance(o.linkDistance),
    )
    .force("charge", forceManyBody<SimNode>().strength(o.charge))
    .force("collide", forceCollide<SimNode>(o.collideRadius))
    .force("x", forceX<SimNode>((n) => (n.column ?? 0) * o.columnWidth).strength(columned ? 0.9 : 0.06))
    .force("y", forceY<SimNode>((n) => (n.row ?? 0) * o.rowHeight).strength(rowed ? 0.6 : columned ? 0.12 : 0.08))
    .stop();
  simulation.tick(o.ticks);

  const positions: Record<string, Point> = {};
  for (const n of simNodes) positions[n.id] = { x: round(n.x ?? 0), y: round(n.y ?? 0) };
  return { positions, viewBox: fitViewBox(Object.values(positions), o.padding, o.minSize) };
}

/** The smallest box around every point plus padding, centred and no smaller than `minSize`. */
export function fitViewBox(points: readonly Point[], padding: { x: number; y: number }, minSize: { width: number; height: number }): ViewBox {
  if (points.length === 0) return { x: -minSize.width / 2, y: -minSize.height / 2, ...minSize };
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs) - padding.x;
  const maxX = Math.max(...xs) + padding.x;
  const minY = Math.min(...ys) - padding.y;
  const maxY = Math.max(...ys) + padding.y;
  const width = Math.max(maxX - minX, minSize.width);
  const height = Math.max(maxY - minY, minSize.height);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return { x: round(cx - width / 2), y: round(cy - height / 2), width: round(width), height: round(height) };
}
