/** Server-generated identifiers and their route-parameter checks. */
import { randomBytes } from "node:crypto";
import { ValueError } from "@c2p/core";
import { badRequest } from "./api/errors.js";
import { validateName } from "./store/index.js";

const ID_HEX_BYTES = 12;

export type IdPrefix = "proj" | "task" | "file";

const SHAPES: Readonly<Record<IdPrefix, RegExp>> = {
  proj: /^proj_[0-9a-f]{24}$/,
  task: /^task_[0-9a-f]{24}$/,
  file: /^file_[0-9a-f]{24}$/,
};

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${randomBytes(ID_HEX_BYTES).toString("hex")}`;
}

/** `validateName` (one safe path component), rethrown as 400 `invalid_id`. */
export function nameParam(raw: unknown, field: string): string {
  try {
    return validateName(raw, field);
  } catch (err) {
    if (err instanceof ValueError) throw badRequest("invalid_id", err.message);
    throw err;
  }
}

/** A server-generated ID: a valid name with the exact `<prefix>_<24 hex>` shape. */
export function idParam(raw: unknown, prefix: IdPrefix, field: string): string {
  const id = nameParam(raw, field);
  if (!SHAPES[prefix].test(id)) {
    throw badRequest("invalid_id", `${field}: invalid identifier ${JSON.stringify(id)}`);
  }
  return id;
}

export const projectIdParam = (raw: unknown): string => idParam(raw, "proj", "project_id");
export const taskIdParam = (raw: unknown): string => idParam(raw, "task", "task_id");
