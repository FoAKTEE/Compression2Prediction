/** Repository commit recorded in run manifests: `git rev-parse HEAD`, read once, else "unknown". */
import { execFileSync } from "node:child_process";
import { REPO_ROOT } from "../config.js";

export const UNKNOWN_SHA = "unknown";
let cached: string | undefined;

export function repoSha(): string {
  if (cached === undefined) {
    try {
      const out = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5000,
      }).trim();
      cached = /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(out) ? out : UNKNOWN_SHA;
    } catch {
      cached = UNKNOWN_SHA;
    }
  }
  return cached;
}
