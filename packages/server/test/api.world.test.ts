import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Extractor } from "../src/world/extractor.js";
import { entity, sixEntityWorld } from "./fixtures/sixEntityWorld.js";
import { cleanup, createProject, expectError, makeApp, multipart, PROJECT_FIELDS, rawMultipart, tempDir } from "./helpers.js";

afterEach(cleanup);

const NOTES = "# Incident notes\n\nCrew A acknowledged the incident at 09:10.\n";
const sha = (s: string) => "sha256:" + createHash("sha256").update(s).digest("hex");

describe("projects", () => {
  it("create / list / get round trip with a multipart upload", async () => {
    const dir = tempDir();
    const app = await makeApp({ dataDir: dir });
    const body = await multipart(PROJECT_FIELDS, [{ name: "notes.md", content: NOTES }]);
    const res = await app.inject({ method: "POST", url: "/api/world/projects", ...body });
    expect(res.statusCode, res.body).toBe(201);
    const created = res.json();
    expect(created.project_id).toMatch(/^proj_[0-9a-f]{24}$/);
    expect(created).toMatchObject({
      ...PROJECT_FIELDS,
      status: "created",
      world_version: null,
      model_version: null,
      plan_version: null,
      last_compile_ok: null,
      latest_run_id: null,
      latest_report_id: null,
    });
    expect(created.files).toHaveLength(1);
    expect(created.files[0]).toEqual({
      file_id: expect.stringMatching(/^file_[0-9a-f]{24}$/),
      filename: "notes.md",
      size_bytes: Buffer.byteLength(NOTES),
      content_hash: sha(NOTES),
    });
    // Stored content-addressed under the data root.
    const hex = sha(NOTES).slice(7);
    expect(fs.readFileSync(path.join(dir, "uploads", hex.slice(0, 2), hex), "utf8")).toBe(NOTES);

    const list = await app.inject({ method: "GET", url: "/api/world/projects" });
    expect(list.statusCode).toBe(200);
    expect(Object.keys(list.json())).toEqual(["projects"]);
    expect(list.json().projects).toEqual([
      {
        project_id: created.project_id,
        name: created.name,
        prediction_question: created.prediction_question,
        status: "created",
        created_at: created.created_at,
        updated_at: created.updated_at,
        world_version: null,
        model_version: null,
        plan_version: null,
        last_compile_ok: null,
        latest_run_id: null,
        latest_report_id: null,
      },
    ]);

    const got = await app.inject({ method: "GET", url: `/api/world/projects/${created.project_id}` });
    expect(got.statusCode).toBe(200);
    expect(got.json()).toEqual(created);
  });

  it("rejects a disallowed extension and creates nothing", async () => {
    const app = await makeApp();
    for (const name of ["payload.exe", "report.pdf", "noext"]) {
      const body = await multipart(PROJECT_FIELDS, [{ name, content: "x" }]);
      expectError(await app.inject({ method: "POST", url: "/api/world/projects", ...body }), 422, "unsupported_file_type");
    }
    expect((await app.inject({ method: "GET", url: "/api/world/projects" })).json().projects).toEqual([]);
  });

  it("rejects missing and blank fields", async () => {
    const app = await makeApp();
    const noQuestion = await multipart({ name: "x" }, [{ name: "a.txt", content: "a" }]);
    expectError(await app.inject({ method: "POST", url: "/api/world/projects", ...noQuestion }), 400, "missing_field");
    const noName = await multipart({ prediction_question: "q?" });
    expectError(await app.inject({ method: "POST", url: "/api/world/projects", ...noName }), 400, "missing_field");
    const blank = await multipart({ name: "   ", prediction_question: "q?" });
    expectError(await app.inject({ method: "POST", url: "/api/world/projects", ...blank }), 422, "invalid_field");
    const extra = await multipart({ ...PROJECT_FIELDS, owner: "me" });
    expectError(await app.inject({ method: "POST", url: "/api/world/projects", ...extra }), 400, "unknown_field");
    const wrongFileField = await multipart(PROJECT_FIELDS, [{ name: "a.txt", content: "a" }], "file");
    expectError(await app.inject({ method: "POST", url: "/api/world/projects", ...wrongFileField }), 400, "unknown_field");
  });

  it("rejects too many files, oversized files, empty files, and non-multipart bodies", async () => {
    const app = await makeApp({ config: { upload: { maxFiles: 2, maxFileBytes: 32 } } });
    const three = await multipart(PROJECT_FIELDS, ["a.txt", "b.txt", "c.txt"].map((name) => ({ name, content: name })));
    expectError(await app.inject({ method: "POST", url: "/api/world/projects", ...three }), 413, "too_many_files");
    const big = await multipart(PROJECT_FIELDS, [{ name: "big.csv", content: "x".repeat(33) }]);
    expectError(await app.inject({ method: "POST", url: "/api/world/projects", ...big }), 413, "file_too_large");
    const empty = await multipart(PROJECT_FIELDS, [{ name: "empty.json", content: "" }]);
    expectError(await app.inject({ method: "POST", url: "/api/world/projects", ...empty }), 422, "empty_file");
    const json = await app.inject({ method: "POST", url: "/api/world/projects", payload: PROJECT_FIELDS });
    expectError(json, 415, "unsupported_media_type");
    const two = await multipart(PROJECT_FIELDS, ["a.txt", "b.TXT"].map((name) => ({ name, content: name })));
    expect((await app.inject({ method: "POST", url: "/api/world/projects", ...two })).statusCode).toBe(201);
  });

  it("rejects path traversal in filenames and malformed project IDs", async () => {
    const app = await makeApp();
    for (const name of ["../evil.md", "..\\evil.md", "a/b.md", ".hidden.md"]) {
      const body = rawMultipart(PROJECT_FIELDS, [{ name, content: "x" }]);
      expectError(await app.inject({ method: "POST", url: "/api/world/projects", ...body }), 422, "invalid_filename");
    }
    const bad = [
      "..%2Fx",
      "%2e%2e%2f%2e%2e%2fetc",
      "proj_..",
      "proj_%2E%2E",
      "proj_ABC",
      "proj_0123",
      "x",
      "proj_0123456789abcdef01234567%2F..",
    ];
    for (const id of bad) {
      for (const suffix of ["", "/world", "/extraction"]) {
        const method = suffix === "/extraction" ? "POST" : "GET";
        expectError(await app.inject({ method, url: `/api/world/projects/${id}${suffix}` }), 400, "invalid_id");
      }
    }
    // A bare dot segment is normalized away by URL parsing and never reaches a project route.
    expectError(await app.inject({ method: "GET", url: "/api/world/projects/%2E%2E/world" }), 404, "not_found");
    // Well-formed but unknown.
    expectError(await app.inject({ method: "GET", url: `/api/world/projects/proj_${"0".repeat(24)}` }), 404, "project_not_found");
  });
});

describe("world import", () => {
  it("six-entity world: 6 world entities, 2 agent candidates, counted separately", async () => {
    const app = await makeApp();
    const id = await createProject(app);
    expectError(await app.inject({ method: "GET", url: `/api/world/projects/${id}/world` }), 404, "world_not_ready");

    const put = await app.inject({ method: "PUT", url: `/api/world/projects/${id}/world`, payload: sixEntityWorld() });
    expect(put.statusCode, put.body).toBe(200);
    const version = put.json().world_version as string;
    expect(version).toMatch(/^sha256:[0-9a-f]{64}$/);

    const res = await app.inject({ method: "GET", url: `/api/world/projects/${id}/world` });
    expect(res.statusCode).toBe(200);
    const world = res.json();
    expect(Object.keys(world).sort()).toEqual(
      ["claims", "counts", "entities", "participations", "project_id", "role_assignments", "world_version"].sort(),
    );
    expect(world.project_id).toBe(id);
    expect(world.world_version).toBe(version);
    expect(world.counts).toEqual({
      world_entity_count: 6,
      agent_candidate_count: 2,
      event_count: 1,
      role_count: 3,
      claim_count: 2,
    });
    expect(world.entities.map((e: { primary_kind: string }) => e.primary_kind)).toEqual([
      "Person",
      "Person",
      "Organization",
      "Event",
      "Location",
      "Artifact",
    ]);
    const bob = world.entities.find((e: { entity_id: string }) => e.entity_id === "ent_bob");
    expect(bob.roles.map((r: { role: string }) => r.role)).toEqual(["Employee", "Author"]);
    expect(world.role_assignments).toContainEqual(
      expect.objectContaining({ entity_id: "ent_alice", role: "Researcher", origin: "observed" }),
    );
    expect(world.participations).toHaveLength(4);
    expect(world.claims.map((c: { predicate: string }) => c.predicate)).toEqual(["WORKS_FOR", "MENTIONS"]);

    const project = (await app.inject({ method: "GET", url: `/api/world/projects/${id}` })).json();
    expect(project).toMatchObject({ status: "world_ready", world_version: version });

    const elig = (await app.inject({ method: "GET", url: `/api/model/projects/${id}/eligibility` })).json();
    expect(elig.world_entity_count).toBe(6);
    expect(elig.agent_candidate_count).toBe(2);
    expect(
      elig.entities.filter((e: { agent_eligible: boolean }) => e.agent_eligible).map((e: { entity_id: string }) => e.entity_id),
    ).toEqual(["ent_alice", "ent_lab"]);
  });

  it("is idempotent and stores the world as an immutable artifact in the project namespace", async () => {
    const app = await makeApp();
    const id = await createProject(app);
    const url = `/api/world/projects/${id}/world`;
    const v1 = (await app.inject({ method: "PUT", url, payload: sixEntityWorld() })).json().world_version;
    const v2 = (await app.inject({ method: "PUT", url, payload: sixEntityWorld() })).json().world_version;
    expect(v2).toBe(v1);
    // Embedding a same-envelope role or listing it standalone is the same canonical world.
    const moved = sixEntityWorld();
    const bob = moved.entities[1]!;
    const author = (bob.roles as Record<string, unknown>[]).pop()!;
    moved.role_assignments.push({ ...author, entity_id: "ent_bob", origin: "extracted" });
    expect((await app.inject({ method: "PUT", url, payload: moved })).json().world_version).toBe(v1);
    expect(app.c2p.artifacts.listRefs("world", { scenario_id: id })).toHaveLength(1);
  });

  it("rejects invalid worlds with 422 and the validation message", async () => {
    const app = await makeApp();
    const id = await createProject(app);
    const url = `/api/world/projects/${id}/world`;
    const cases: [string, (w: ReturnType<typeof sixEntityWorld>) => void, RegExp][] = [
      ["dangling event", (w) => void (w.participations[0]!.event_id = "ent_missing"), /dangling event reference/],
      ["unknown entity field", (w) => void (w.entities[0]!.nickname = "Al"), /unknown field/],
      ["string boolean", (w) => void (w.entities[0]!.agent_eligible = "true"), /agent_eligible/],
      ["eligible event", (w) => {
        Object.assign(w.entities[3]!, { origin: "assumed", agent_eligible: true, agent_eligibility_basis: "explicit_operator_selection" });
      }, /never agent-eligible/],
      ["unknown top-level field", (w) => void (w.agents = []), /unknown field/],
      ["missing evidence list", (w) => void delete w.evidence, /missing field/],
      ["inverted role interval", (w) => void Object.assign(w.role_assignments[0]!, { valid_from: 5, valid_to: 2 }), /interval/],
      ["simulated record", (w) => void (w.participations[1]!.origin = "simulated"), /simulated/],
      ["role not in ontology", (w) => void (w.role_assignments[0]!.role = "Mayor"), /unknown role/],
    ];
    for (const [label, mutate, message] of cases) {
      const w = sixEntityWorld();
      mutate(w);
      const err = expectError(await app.inject({ method: "PUT", url, payload: w }), 422, "invalid_world");
      expect(err.message, label).toMatch(message);
    }
    expectError(await app.inject({ method: "PUT", url, payload: [1, 2] }), 422, "invalid_world");
    expectError(await app.inject({ method: "GET", url }), 404, "world_not_ready");
  });

  it("an extracted record can never be agent-eligible", async () => {
    const app = await makeApp();
    const id = await createProject(app);
    const w = sixEntityWorld();
    w.entities.push(
      entity("ent_carol", "Carol", "Person", [], {
        origin: "extracted",
        agent_eligible: true,
        agent_eligibility_basis: "explicit_operator_selection",
      }),
    );
    const err = expectError(
      await app.inject({ method: "PUT", url: `/api/world/projects/${id}/world`, payload: w }),
      422,
      "invalid_world",
    );
    expect(err.message).toMatch(/extracted record cannot authorize an agent/);
  });

  it("expected_world_version guards against lost updates (409)", async () => {
    const app = await makeApp();
    const id = await createProject(app);
    const url = `/api/world/projects/${id}/world`;
    const first = await app.inject({ method: "PUT", url, payload: { ...sixEntityWorld(), expected_world_version: null } });
    expect(first.statusCode).toBe(200);
    const v1 = first.json().world_version;
    const stale = await app.inject({ method: "PUT", url, payload: { ...sixEntityWorld(), expected_world_version: null } });
    expectError(stale, 409, "version_conflict");
    const w = sixEntityWorld();
    w.entities[4]!.display_name = "Building 8";
    const ok = await app.inject({ method: "PUT", url, payload: { ...w, expected_world_version: v1 } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().world_version).not.toBe(v1);
  });

  it("one project's world is not visible through another project", async () => {
    const app = await makeApp();
    const a = await createProject(app);
    const b = await createProject(app);
    await app.inject({ method: "PUT", url: `/api/world/projects/${a}/world`, payload: sixEntityWorld() });
    expectError(await app.inject({ method: "GET", url: `/api/world/projects/${b}/world` }), 404, "world_not_ready");
  });
});

describe("extraction", () => {
  it("answers 501 until an extractor is registered", async () => {
    const app = await makeApp();
    const id = await createProject(app);
    expectError(await app.inject({ method: "POST", url: `/api/world/projects/${id}/extraction` }), 501, "not_implemented");
    expect((await app.inject({ method: "GET", url: `/api/world/projects/${id}` })).json().status).toBe("created");
  });

  it("runs a registered extractor as a polled task through the import validator", async () => {
    const seen: string[] = [];
    const extractor: Extractor = {
      name: "fake",
      async extract(input, ctx) {
        seen.push(...input.files.map((f) => f.bytes.toString("utf8")));
        ctx.progress(0.5, "halfway");
        return sixEntityWorld();
      },
    };
    const app = await makeApp({ extractor });
    const id = await createProject(app, [{ name: "notes.md", content: NOTES }]);
    const res = await app.inject({ method: "POST", url: `/api/world/projects/${id}/extraction` });
    expect(res.statusCode, res.body).toBe(202);
    const task = res.json().task;
    expect(task).toMatchObject({ project_id: id, kind: "world_extraction", status: "pending" });
    await app.c2p.runner.idle();
    const done = (await app.inject({ method: "GET", url: `/api/tasks/${task.task_id}` })).json();
    expect(done).toMatchObject({ status: "completed", progress: 1, error: null });
    expect(seen).toEqual([NOTES]);
    const world = (await app.inject({ method: "GET", url: `/api/world/projects/${id}/world` })).json();
    expect(world.world_version).toBe(done.result_ref);
    expect(world.counts.world_entity_count).toBe(6);
    expect(world.counts.agent_candidate_count).toBe(2);
  });

  it("fails the task when the extractor emits an agent-eligible extracted record", async () => {
    const extractor: Extractor = {
      name: "overreaching",
      async extract() {
        const w = sixEntityWorld();
        Object.assign(w.entities[1]!, { agent_eligible: true, agent_eligibility_basis: "explicit_operator_selection" });
        return w;
      },
    };
    const app = await makeApp({ extractor });
    const id = await createProject(app);
    const task = (await app.inject({ method: "POST", url: `/api/world/projects/${id}/extraction` })).json().task;
    await app.c2p.runner.idle();
    const failed = (await app.inject({ method: "GET", url: `/api/tasks/${task.task_id}` })).json();
    expect(failed.status).toBe("failed");
    expect(failed.error).toMatch(/extracted record cannot authorize an agent/);
    expect((await app.inject({ method: "GET", url: `/api/world/projects/${id}` })).json().status).toBe("failed");
  });
});
