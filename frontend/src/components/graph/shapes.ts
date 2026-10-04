/**
 * Node glyphs. Each primary kind has its own shape as well as its own color, so
 * kinds stay distinguishable without color (print, color-vision deficiency).
 */
import type { PrimaryKind } from "../../api/types";
import type { Point } from "./layout";

const f = (n: number): string => String(Math.round(n * 100) / 100);

function polygon(sides: number, radius: number, rotation = -Math.PI / 2): string {
  const points: string[] = [];
  for (let i = 0; i < sides; i += 1) {
    const angle = rotation + (2 * Math.PI * i) / sides;
    points.push(`${f(radius * Math.cos(angle))} ${f(radius * Math.sin(angle))}`);
  }
  return `M ${points.join(" L ")} Z`;
}

function star(points: number, outer: number, inner: number): string {
  const out: string[] = [];
  for (let i = 0; i < points * 2; i += 1) {
    const radius = i % 2 === 0 ? outer : inner;
    const angle = -Math.PI / 2 + (Math.PI * i) / points;
    out.push(`${f(radius * Math.cos(angle))} ${f(radius * Math.sin(angle))}`);
  }
  return `M ${out.join(" L ")} Z`;
}

export function circlePath(r: number): string {
  return `M ${f(-r)} 0 A ${f(r)} ${f(r)} 0 1 0 ${f(r)} 0 A ${f(r)} ${f(r)} 0 1 0 ${f(-r)} 0 Z`;
}

export function squarePath(r: number): string {
  const s = r * 0.86;
  return `M ${f(-s)} ${f(-s)} H ${f(s)} V ${f(s)} H ${f(-s)} Z`;
}

function documentPath(r: number): string {
  const w = r * 0.78;
  const h = r;
  const fold = r * 0.38;
  return `M ${f(-w)} ${f(-h)} H ${f(w - fold)} L ${f(w)} ${f(-h + fold)} V ${f(h)} H ${f(-w)} Z`;
}

/** SVG path data for a kind's glyph, centred on the origin, about `r` in radius. */
export function kindShapePath(kind: string, r: number): string {
  switch (kind as PrimaryKind) {
    case "Person":
      return circlePath(r);
    case "Organization":
      return squarePath(r);
    case "Group":
      return polygon(6, r * 1.05);
    case "Event":
      return polygon(4, r * 1.2);
    case "Location":
      return polygon(3, r * 1.25);
    case "Artifact":
      return documentPath(r);
    case "Resource":
      return polygon(5, r * 1.08);
    case "Topic":
      return star(5, r * 1.2, r * 0.55);
    default:
      return polygon(8, r);
  }
}

/** The segment from `a` to `b` shortened by `trimA` and `trimB`, so arrowheads stop at the glyph edge. */
export function trimSegment(a: Point, b: Point, trimA: number, trimB: number): { x1: number; y1: number; x2: number; y2: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  if (length <= trimA + trimB) return { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
  const ux = dx / length;
  const uy = dy / length;
  return { x1: a.x + ux * trimA, y1: a.y + uy * trimA, x2: b.x - ux * trimB, y2: b.y - uy * trimB };
}
