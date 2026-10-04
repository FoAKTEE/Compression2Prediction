import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { incidentMeta, incidentModel, incidentWorld, writeExample } from "./fixtures/incident.js";
import { cleanup, createProject, expectError, makeApp, tempDir } from "./helpers.js";

afterEach(cleanup);

describe("examples", () => {
  it("lists and serves the bundled incident example", async () => {
    const app = await makeApp();
    const list = await app.inject({ method: "GET", url: "/api/examples" });
    expect(list.statusCode).toBe(200);
    const meta = incidentMeta();
    expect(list.json()).toEqual({ examples: [{ name: "incident", title: meta.title, description: meta.description }] });
    expect(meta.description).toMatch(/illustrative assumptions, not estimates/);

    const got = await app.inject({ method: "GET", url: "/api/examples/incident" });
    expect(got.statusCode).toBe(200);
    expect(Object.keys(got.json())).toEqual(["name", "title", "description", "world", "model"]);
    expect(got.json()).toEqual({ name: "incident", ...meta, world: incidentWorld(), model: incidentModel() });

    expectError(await app.inject({ method: "GET", url: "/api/examples/nope" }), 404, "example_not_found");
    expectError(await app.inject({ method: "GET", url: "/api/examples/..%2Fincident" }), 400, "invalid_id");
  });

  it("the example imports and compiles through the API", async () => {
    const app = await makeApp();
    const id = await createProject(app);
    const example = (await app.inject({ method: "GET", url: "/api/examples/incident" })).json();
    const world = await app.inject({ method: "PUT", url: `/api/world/projects/${id}/world`, payload: example.world });
    expect(world.statusCode, world.body).toBe(200);
    expect(world.json().counts).toEqual({
      world_entity_count: 6,
      agent_candidate_count: 1,
      event_count: 1,
      role_count: 5,
      claim_count: 1,
    });
    const model = await app.inject({ method: "PUT", url: `/api/model/projects/${id}/model`, payload: example.model });
    expect(model.statusCode, model.body).toBe(200);
    expect(model.json().counts).toEqual({ variables: 3, templates: 1, kernels: 1, sources: 5 });
    const compiled = await app.inject({ method: "POST", url: `/api/model/projects/${id}/compile`, payload: {} });
    expect(compiled.json()).toEqual({ ok: true, model_version: model.json().model_version, diagnostics: [] });
  });

  it("an empty or missing examples directory serves no examples", async () => {
    const empty = tempDir();
    for (const examplesDir of [empty, path.join(empty, "absent")]) {
      const app = await makeApp({ config: { examplesDir } });
      expect((await app.inject({ method: "GET", url: "/api/examples" })).json()).toEqual({ examples: [] });
      await app.close();
    }
  });

  it("serves examples from an injected directory", async () => {
    const dir = tempDir();
    writeExample(dir, "copy", ({ example }) => {
      example.title = "Copied incident";
    });
    const app = await makeApp({ config: { examplesDir: dir } });
    expect((await app.inject({ method: "GET", url: "/api/examples" })).json().examples).toEqual([
      { name: "copy", title: "Copied incident", description: incidentMeta().description },
    ]);
  });

  it("an invalid example fails startup with an error naming it, before any state is opened", () => {
    const cases: [string, (dir: string) => void, RegExp][] = [
      [
        "prior",
        (dir) =>
          writeExample(dir, "bad_prior", ({ model }) => {
            model.initial[0]!.distribution = [0.5, 0.4, 0];
          }),
        /invalid example "bad_prior" .*sum to one/,
      ],
      [
        "world",
        (dir) =>
          writeExample(dir, "bad_world", ({ world }) => {
            world.owner = "me";
          }),
        /invalid example "bad_world" .*unknown field\(s\) 'owner'/,
      ],
      [
        "compile",
        (dir) =>
          writeExample(dir, "swapped", ({ model }) => {
            const inputs = model.templates[0]!.mechanism.inputs;
            [inputs[0], inputs[1]] = [inputs[1]!, inputs[0]!];
          }),
        /invalid example "swapped" .*model does not compile: .*declared port order/,
      ],
      [
        "meta",
        (dir) =>
          writeExample(dir, "no_title", ({ example }) => {
            delete example.title;
          }),
        /invalid example "no_title" .*missing field\(s\) title/,
      ],
      [
        "missing file",
        (dir) => fs.rmSync(path.join(writeExample(dir, "partial"), "model.json")),
        /invalid example "partial" .*model\.json: ENOENT/,
      ],
      ["stray file", (dir) => fs.writeFileSync(path.join(dir, "notes.txt"), "x"), /invalid example "notes.txt" .*not a directory/],
    ];
    for (const [label, make, message] of cases) {
      const examplesDir = tempDir();
      writeExample(examplesDir, "good");
      make(examplesDir);
      const dataDir = tempDir();
      expect(() => buildApp({ dataDir, config: { examplesDir } }), label).toThrow(message);
      expect(fs.existsSync(path.join(dataDir, "state.sqlite3")), label).toBe(false);
    }
  });
});
