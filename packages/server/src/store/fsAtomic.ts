/** Atomic file publication: temp file in the target directory, fsync, then rename or link. */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function writeTemp(target: string, data: string | Buffer): string {
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  const fd = fs.openSync(tmp, "wx");
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return tmp;
}

/** Replace ``target`` atomically with ``data``. */
export function writeFileAtomic(target: string, data: string | Buffer): void {
  const tmp = writeTemp(target, data);
  try {
    fs.renameSync(tmp, target);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/** Create ``target`` atomically; throws ``EEXIST`` if it already exists (never clobbers). */
export function createFileAtomic(target: string, data: string | Buffer): void {
  const tmp = writeTemp(target, data);
  try {
    fs.linkSync(tmp, target);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** Atomically replace ``target`` with its current bytes plus ``suffix``. */
export function appendFileAtomic(target: string, suffix: string): void {
  const prefix = fs.existsSync(target) ? fs.readFileSync(target) : Buffer.alloc(0);
  writeFileAtomic(target, Buffer.concat([prefix, Buffer.from(suffix, "utf8")]));
}
