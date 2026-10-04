import { readdirSync, readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { VERSION } from "../src/index.js";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const srcDir = join(packageDir, "src");

// Static, re-export, side-effect, dynamic, and require forms.
const SPECIFIER =
  /\b(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;

function specifiers(source: string): string[] {
  return [...source.matchAll(SPECIFIER)].map((m) => m[1] ?? m[2] ?? m[3] ?? "");
}

/** Reasons the specifier is forbidden in core source at `file`; empty when allowed. */
function violation(spec: string, file: string): string | undefined {
  if (spec.startsWith("node:")) {
    return isBuiltin(spec) ? undefined : "unknown Node built-in";
  }
  if (spec.startsWith("./") || spec.startsWith("../")) {
    const target = relative(srcDir, resolve(dirname(file), spec));
    return target.startsWith("..") ? "relative import escapes packages/core/src" : undefined;
  }
  return "not relative and not a node: built-in";
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((name) => /\.[cm]?ts$/.test(name))
    .map((name) => join(dir, name));
}

describe("@c2p/core smoke", () => {
  it("exports VERSION", () => {
    expect(VERSION).toBe("0.1.0");
  });

  it("declares no runtime dependencies", () => {
    const pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as Record<
      string,
      unknown
    >;
    for (const field of [
      "dependencies",
      "peerDependencies",
      "optionalDependencies",
      "bundleDependencies",
      "bundledDependencies",
    ]) {
      expect(pkg[field], field).toBeUndefined();
    }
  });

  it("imports only relative modules inside src and node: built-ins", () => {
    const files = sourceFiles(srcDir);
    expect(files.length).toBeGreaterThan(0);
    const bad = files.flatMap((file) =>
      specifiers(readFileSync(file, "utf8")).flatMap((spec) => {
        const reason = violation(spec, file);
        return reason ? [`${relative(packageDir, file)}: "${spec}" (${reason})`] : [];
      }),
    );
    expect(bad).toEqual([]);
  });

  it("guard rejects server, frontend, and third-party imports", () => {
    const file = join(srcDir, "kernels.ts");
    const sample = [
      'import { buildApp } from "@c2p/server";',
      'import type { App } from "../../server/src/app.js";',
      'export * from "../../../frontend/src/main.js";',
      'import "fastify";',
      'const fs = await import("fs");',
      'import {\n  a,\n  b,\n} from "./ok.js";',
      'import { createHash } from "node:crypto";',
    ].join("\n");
    const verdicts = specifiers(sample).map((spec) => [spec, violation(spec, file) === undefined]);
    expect(verdicts).toEqual([
      ["@c2p/server", false],
      ["../../server/src/app.js", false],
      ["../../../frontend/src/main.js", false],
      ["fastify", false],
      ["fs", false],
      ["./ok.js", true],
      ["node:crypto", true],
    ]);
  });
});
