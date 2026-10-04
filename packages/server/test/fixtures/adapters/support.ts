/** Shared fixtures for the adapter tests. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Space } from "@c2p/core";
import type { AgentBindingJson, TransitionDatasetOptions } from "@c2p/core";
import { StateAuthority } from "../../../src/adapters/index.js";
import type { MiroFishOptions, TransitionOptions } from "../../../src/adapters/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));

export function fixture(name: "observer_log.jsonl" | "mirofish_actions.jsonl"): string {
  return fs.readFileSync(path.join(here, name), "utf8");
}

export const AUTHORITY = new StateAuthority({ simulator: ["activity", "idle_minutes"], kernel: ["exposure"] });

export const PROCESSING_TIME = "2026-10-04T08:00:00Z";

export const TRANSITION_OPTIONS: TransitionOptions = {
  mechanism_version: "model.v1",
  origin: "simulated",
  authority: AUTHORITY,
  processing_time: PROCESSING_TIME,
};

function binding(agent_id: number, entity_id: string): AgentBindingJson {
  return {
    simulation_id: "sim_mf",
    platform: "twitter",
    agent_id,
    entity_id,
    representation: "synthetic_persona",
    profile_version: "profile.v1",
  };
}

/** Agents 0..2 are bound; agent 3 in the recording is not. */
export const MIROFISH_OPTIONS: MiroFishOptions = {
  bindings: [binding(0, "ent_operator_a"), binding(1, "ent_operator_b"), binding(2, "ent_depot_org")],
  step_minutes: 30,
  run_id: "run_mf_1",
  scenario_id: "baseline",
  platform: "twitter",
  state_schema_version: "activity_state.v1",
};

export const ACTIVITY = new Space("Activity", ["available", "busy"]);

export function datasetOptions(): TransitionDatasetOptions {
  return {
    origin: "simulated",
    scenario_id: "baseline",
    variable: "activity",
    space: ACTIVITY,
    key: {
      template: "tpl_activity",
      kind: "Person",
      role: "operator",
      interface_hash: "sha256:" + "a".repeat(64),
      regime: "normal",
      data_origin_partition: "simulated",
    },
  };
}

const dirs: string[] = [];

export function tempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c2p-adapters-"));
  dirs.push(dir);
  return dir;
}

export function removeTempRoots(): void {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}
