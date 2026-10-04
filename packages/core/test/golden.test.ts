import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface ManifestEntry {
  file: string;
  description: string;
  oracle: string;
  oracle_module: string;
}

const goldenDir = fileURLToPath(new URL("./golden/", import.meta.url));
const readJson = (name: string): unknown => JSON.parse(readFileSync(join(goldenDir, name), "utf8"));
const manifest = readJson("manifest.json") as { generator: string; fixtures: ManifestEntry[] };

describe("golden fixtures", () => {
  it("manifest names its generator and lists fixtures", () => {
    expect(manifest.generator).toBe("reference/python/golden/generate.py");
    expect(manifest.fixtures.length).toBeGreaterThan(0);
  });

  it("every JSON file in golden/ is listed", () => {
    const onDisk = readdirSync(goldenDir).filter((name) => name !== "manifest.json");
    expect(onDisk.sort()).toEqual(manifest.fixtures.map((f) => f.file).sort());
  });

  it.each(manifest.fixtures.map((entry) => [entry.file, entry] as const))(
    "%s exists, parses, and records its oracle",
    (file, entry) => {
      expect(file).toMatch(/^[a-z0-9_]+\.json$/);
      expect(entry.description).not.toBe("");
      expect(entry.oracle).toBe("reference/python");
      expect(entry.oracle_module).toMatch(/^(?:c2p(?:\.[a-z_]+)+|math|fractions)$/);
      expect(existsSync(join(goldenDir, file))).toBe(true);
      const fixture = readJson(file) as Record<string, unknown>;
      expect(fixture.oracle).toBe(entry.oracle);
      expect(fixture.oracle_module).toBe(entry.oracle_module);
    },
  );
});
