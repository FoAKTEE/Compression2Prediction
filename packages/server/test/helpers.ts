/** Shared test helpers: temp data dirs, app lifecycle, multipart bodies, error-shape checks. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { expect } from "vitest";
import { buildApp } from "../src/app.js";
import type { BuildAppOptions } from "../src/app.js";

const dirs: string[] = [];
const apps: FastifyInstance[] = [];

export function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c2p-api-"));
  dirs.push(dir);
  return dir;
}

/** Build and ready an app on `dataDir` (a fresh temp dir by default); closed by `cleanup`. */
export async function makeApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = buildApp({ dataDir: options.dataDir ?? tempDir(), ...options });
  apps.push(app);
  await app.ready();
  return app;
}

export async function cleanup(): Promise<void> {
  for (const app of apps.splice(0)) await app.close().catch(() => undefined); // some tests close early
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}

export interface UploadFile {
  readonly name: string;
  readonly content: string | Uint8Array;
}

/** Encode a multipart form with the platform `FormData`. */
export async function multipart(
  fields: Readonly<Record<string, string>>,
  files: readonly UploadFile[] = [],
  fileField = "files",
): Promise<{ payload: Buffer; headers: Record<string, string> }> {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  for (const f of files) form.append(fileField, new Blob([f.content]), f.name);
  const req = new Request("http://localhost/", { method: "POST", body: form });
  return {
    payload: Buffer.from(await req.arrayBuffer()),
    headers: { "content-type": req.headers.get("content-type")! },
  };
}

/** Hand-built multipart body (lets a test send a raw filename such as `../evil.md`). */
export function rawMultipart(
  fields: Readonly<Record<string, string>>,
  files: readonly UploadFile[],
): { payload: Buffer; headers: Record<string, string> } {
  const boundary = "----c2pboundary7MA4YWxkTrZu0gW";
  const chunks: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  for (const f of files) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${f.name}"\r\nContent-Type: text/plain\r\n\r\n`,
      ),
      Buffer.from(f.content),
      Buffer.from("\r\n"),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

export const PROJECT_FIELDS = Object.freeze({
  name: "Depot incident",
  prediction_question: "Will the incident be resolved within two hours?",
});

export async function createProject(app: FastifyInstance, files: readonly UploadFile[] = []): Promise<string> {
  const body = await multipart(PROJECT_FIELDS, files);
  const res = await app.inject({ method: "POST", url: "/api/world/projects", ...body });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().project_id as string;
}

/** Assert the one error shape: exactly `{error: {code, message}}`, JSON, no stack. */
export function expectError(res: LightMyRequestResponse, status: number, code?: string): { code: string; message: string } {
  expect(res.statusCode, res.body).toBe(status);
  expect(res.headers["content-type"]).toMatch(/^application\/json/);
  const body = res.json() as Record<string, unknown>;
  expect(Object.keys(body)).toEqual(["error"]);
  const err = body.error as Record<string, unknown>;
  expect(Object.keys(err).sort()).toEqual(["code", "message"]);
  expect(typeof err.code).toBe("string");
  expect(typeof err.message).toBe("string");
  expect(err.code).not.toBe("");
  expect(err.message).not.toBe("");
  expect(res.body).not.toMatch(/\bstack\b|\n\s+at /);
  if (code !== undefined) expect(err.code).toBe(code);
  return err as { code: string; message: string };
}
