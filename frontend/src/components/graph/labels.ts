/**
 * Edge-label placement for GraphPanel: a pure, deterministic function of the
 * layout, so the same graph always gets the same labels.
 *
 * Each label is a horizontal box drawn over a background, so it reads cleanly
 * even where it sits on a line. Candidates are tried in a fixed order: on the
 * edge at its midpoint, then beside the edge along its normal, then further
 * along the edge. The first candidate that overlaps no node glyph, no node
 * label, and no label already placed wins, preferring one that crosses no
 * other edge. A label on an edge that is too short to carry it, or that finds
 * no free spot, is hidden and only shown while its edge or one of its end
 * nodes is hovered, focused, or selected.
 */
import type { Point } from "./layout";

export interface Box {
  /** Left edge. */
  x: number;
  /** Top edge. */
  y: number;
  width: number;
  height: number;
}

export interface LabelEdge {
  id: string;
  label: string;
  /** Centre of the source node. */
  source: Point;
  /** Centre of the target node. */
  target: Point;
  /** Glyph radius at each end; the label never sits on the glyphs. */
  sourceRadius: number;
  targetRadius: number;
}

export type HiddenReason = "empty" | "short" | "crowded";

export interface PlacedLabel {
  id: string;
  /** Centre of the label box. */
  x: number;
  y: number;
  box: Box;
  /** Hidden labels are drawn only on hover, focus, or selection of the edge or its end nodes. */
  hidden: boolean;
  reason: HiddenReason | null;
}

export interface LabelOptions {
  /** Font size of edge labels, in user units. */
  fontSize?: number;
  /** Padding around the text inside its background box. */
  padding?: { x: number; y: number };
  /** An edge whose visible part (between the glyphs) is shorter than this carries no visible label. */
  minEdgeLength?: number;
  /** Gap between the line and a label placed beside it. */
  sideGap?: number;
  /** Overlap area (square user units) still treated as no overlap, for rounding. */
  tolerance?: number;
}

export const EDGE_LABEL_DEFAULTS: Required<LabelOptions> = {
  fontSize: 11,
  padding: { x: 3, y: 1.5 },
  minEdgeLength: 56,
  sideGap: 2,
  tolerance: 0.5,
};

/** Positions along the edge (fraction from source to target), tried in this order. */
const ALONG: readonly number[] = [0.5, 0.42, 0.58, 0.34, 0.66, 0.26, 0.74];

const round = (value: number): number => Math.round(value * 100) / 100;

/** Wide (CJK and full-width) characters take a full em in a monospace font; the rest take 0.6 em. */
function isWide(codePoint: number): boolean {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe4f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6)
  );
}

/** Estimated advance width of `text` in a monospace font of `fontSize`. */
export function textWidth(text: string, fontSize: number): number {
  let ems = 0;
  for (const char of text) ems += isWide(char.codePointAt(0) ?? 0) ? 1 : 0.6;
  return ems * fontSize;
}

/** The background box of a label: text width and line height plus padding. */
export function labelSize(text: string, options: LabelOptions = {}): { width: number; height: number } {
  const o = { ...EDGE_LABEL_DEFAULTS, ...options };
  return {
    width: round(textWidth(text, o.fontSize) + 2 * o.padding.x),
    height: round(o.fontSize * 1.2 + 2 * o.padding.y),
  };
}

export function boxAround(center: Point, size: { width: number; height: number }): Box {
  return { x: center.x - size.width / 2, y: center.y - size.height / 2, width: size.width, height: size.height };
}

/** Area of the intersection of two boxes (0 when they are apart or only touch). */
export function overlapArea(a: Box, b: Box): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

function inside(p: Point, box: Box): boolean {
  return p.x > box.x && p.x < box.x + box.width && p.y > box.y && p.y < box.y + box.height;
}

function cross(o: Point, a: Point, b: Point): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

function segmentsCross(p1: Point, p2: Point, q1: Point, q2: Point): boolean {
  const d1 = cross(q1, q2, p1);
  const d2 = cross(q1, q2, p2);
  const d3 = cross(p1, p2, q1);
  const d4 = cross(p1, p2, q2);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** Whether the segment p1–p2 passes through the interior of `box`. */
export function segmentHitsBox(p1: Point, p2: Point, box: Box): boolean {
  if (inside(p1, box) || inside(p2, box)) return true;
  const corners: Point[] = [
    { x: box.x, y: box.y },
    { x: box.x + box.width, y: box.y },
    { x: box.x + box.width, y: box.y + box.height },
    { x: box.x, y: box.y + box.height },
  ];
  return corners.some((c, i) => segmentsCross(p1, p2, c, corners[(i + 1) % 4]!));
}

interface Segment {
  id: string;
  a: Point;
  b: Point;
}

/** The part of the edge between the two glyphs. */
function visibleSegment(edge: LabelEdge): { a: Point; b: Point; length: number } {
  const dx = edge.target.x - edge.source.x;
  const dy = edge.target.y - edge.source.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return { a: edge.source, b: edge.target, length: 0 };
  const ux = dx / length;
  const uy = dy / length;
  const visible = Math.max(0, length - edge.sourceRadius - edge.targetRadius);
  return {
    a: { x: edge.source.x + ux * edge.sourceRadius, y: edge.source.y + uy * edge.sourceRadius },
    b: { x: edge.target.x - ux * edge.targetRadius, y: edge.target.y - uy * edge.targetRadius },
    length: visible,
  };
}

/** Candidate centres in preference order: on the line, then either side of it, for each position along it. */
function candidates(edge: LabelEdge, size: { width: number; height: number }, sideGap: number): Point[] {
  const dx = edge.target.x - edge.source.x;
  const dy = edge.target.y - edge.source.y;
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length;
  const uy = dy / length;
  // Normal pointing "up" on screen first (or right for vertical edges), so ties resolve the same way every time.
  let nx = -uy;
  let ny = ux;
  if (ny > 0 || (ny === 0 && nx < 0)) {
    nx = -nx;
    ny = -ny;
  }
  // Half the box's extent along the normal, so a side label clears the line.
  const side = Math.abs(nx) * (size.width / 2) + Math.abs(ny) * (size.height / 2) + sideGap;
  const out: Point[] = [];
  for (const t of ALONG) {
    const cx = edge.source.x + dx * t;
    const cy = edge.source.y + dy * t;
    for (const offset of [0, side, -side]) out.push({ x: round(cx + nx * offset), y: round(cy + ny * offset) });
  }
  return out;
}

/**
 * Places one label per edge, in input order. `obstacles` are boxes labels
 * must not cover (node glyphs and node labels). Visible labels never overlap
 * each other or an obstacle by more than `tolerance`.
 */
export function placeEdgeLabels(
  edges: readonly LabelEdge[],
  obstacles: readonly Box[],
  options: LabelOptions = {},
): PlacedLabel[] {
  const o = { ...EDGE_LABEL_DEFAULTS, ...options };
  const segments: Segment[] = edges.map((e) => {
    const { a, b } = visibleSegment(e);
    return { id: e.id, a, b };
  });
  const taken: Box[] = [];
  const out: PlacedLabel[] = [];

  for (const edge of edges) {
    const size = labelSize(edge.label, o);
    const midpoint = { x: (edge.source.x + edge.target.x) / 2, y: (edge.source.y + edge.target.y) / 2 };
    const hidden = (reason: HiddenReason, box: Box): PlacedLabel => ({
      id: edge.id,
      x: round(box.x + box.width / 2),
      y: round(box.y + box.height / 2),
      box: roundBox(box),
      hidden: true,
      reason,
    });

    if (edge.label.trim() === "") {
      out.push(hidden("empty", boxAround(midpoint, size)));
      continue;
    }
    if (visibleSegment(edge).length < o.minEdgeLength) {
      out.push(hidden("short", boxAround(midpoint, size)));
      continue;
    }

    let best: { box: Box; crossings: number } | null = null;
    let fallback: { box: Box; overlap: number } | null = null;
    for (const center of candidates(edge, size, o.sideGap)) {
      const box = boxAround(center, size);
      const overlap = [...obstacles, ...taken].reduce((sum, other) => sum + overlapArea(box, other), 0);
      if (overlap > o.tolerance) {
        if (fallback === null || overlap < fallback.overlap) fallback = { box, overlap };
        continue;
      }
      const crossings = segments.filter((s) => s.id !== edge.id && segmentHitsBox(s.a, s.b, box)).length;
      if (best === null || crossings < best.crossings) best = { box, crossings };
      if (crossings === 0) break;
    }

    if (best === null) {
      out.push(hidden("crowded", fallback?.box ?? boxAround(midpoint, size)));
      continue;
    }
    taken.push(best.box);
    out.push({
      id: edge.id,
      x: round(best.box.x + best.box.width / 2),
      y: round(best.box.y + best.box.height / 2),
      box: roundBox(best.box),
      hidden: false,
      reason: null,
    });
  }
  return out;
}

export interface LabelledNode {
  x: number;
  y: number;
  /** Glyph radius; the box kept clear also covers the origin halo around it. */
  r: number;
  label: string;
  /** Text anchor point relative to the node centre (the baseline for y). */
  labelX: number;
  labelY: number;
  labelAnchor: "start" | "middle" | "end";
}

/** Space the origin halo adds around a glyph. */
export const NODE_HALO = 5;
export const NODE_LABEL_FONT_SIZE = 12;

/** Boxes edge labels must keep clear of: each node's glyph with its halo, and its own label. */
export function nodeObstacles(nodes: readonly LabelledNode[], fontSize = NODE_LABEL_FONT_SIZE): Box[] {
  return nodes.flatMap((n) => {
    const reach = n.r + NODE_HALO;
    const glyph: Box = { x: n.x - reach, y: n.y - reach, width: 2 * reach, height: 2 * reach };
    if (n.label === "") return [glyph];
    // Bold candidate labels run slightly wider than regular text.
    const width = textWidth(n.label, fontSize) * 1.05;
    const left = n.labelAnchor === "middle" ? -width / 2 : n.labelAnchor === "end" ? -width : 0;
    const label: Box = {
      x: n.x + n.labelX + left,
      y: n.y + n.labelY - fontSize * 0.85,
      width,
      height: fontSize * 1.15,
    };
    return [glyph, label];
  });
}

function roundBox(box: Box): Box {
  return { x: round(box.x), y: round(box.y), width: round(box.width), height: round(box.height) };
}
