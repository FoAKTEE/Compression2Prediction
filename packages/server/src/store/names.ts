/** Path identifiers and root-confined path resolution. */
import fs from "node:fs";
import path from "node:path";
import { ValueError } from "@c2p/core";

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** A single path component: ``^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$``, never ``.`` or ``..``. */
export function validateName(s: unknown, field = "name"): string {
  if (typeof s !== "string" || s === "." || s === ".." || !NAME_RE.test(s)) {
    throw new ValueError(`${field}: invalid identifier ${JSON.stringify(s) ?? String(s)}`);
  }
  return s;
}

function isWithin(base: string, target: string): boolean {
  const rel = path.relative(base, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel));
}

/** Realpath of the deepest existing ancestor, with the missing tail appended. */
function realpathDeepest(p: string): string {
  let head = p;
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(head), ...tail.reverse());
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      const parent = path.dirname(head);
      if (parent === head) return p;
      tail.push(path.basename(head));
      head = parent;
    }
  }
}

/** Resolve ``parts`` under ``root``; throws if the result (or its realpath) leaves ``root``. */
export function resolveInside(root: string, ...parts: string[]): string {
  if (typeof root !== "string" || !root) throw new ValueError("root: expected a nonempty path");
  for (const part of parts) {
    if (typeof part !== "string" || !part || part.includes("\0")) {
      throw new ValueError(`path part: invalid ${JSON.stringify(part) ?? String(part)}`);
    }
  }
  const base = path.resolve(root);
  const target = path.resolve(base, ...parts);
  if (!isWithin(base, target) || !isWithin(realpathDeepest(base), realpathDeepest(target))) {
    throw new ValueError(`path escapes its root: ${JSON.stringify(parts)}`);
  }
  return target;
}
