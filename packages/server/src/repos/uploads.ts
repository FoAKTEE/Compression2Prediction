/** Content-addressed upload blobs: `<root>/<hex[:2]>/<hex>`, keyed by sha256 of the bytes. */
import { createHash } from "node:crypto";
import fs from "node:fs";
import { asHash, ValueError } from "@c2p/core";
import { createFileAtomic } from "../store/fsAtomic.js";
import { resolveInside } from "../store/index.js";

export function sha256Bytes(bytes: Uint8Array): string {
  return "sha256:" + createHash("sha256").update(bytes).digest("hex");
}

export class UploadStore {
  readonly root: string;

  constructor(root: string) {
    fs.mkdirSync(root, { recursive: true });
    this.root = resolveInside(root);
  }

  private pathOf(hash: string): string {
    const hex = asHash(hash, "content_hash").slice("sha256:".length);
    return resolveInside(this.root, hex.slice(0, 2), hex);
  }

  /** Store `bytes` (idempotent) and return their content hash. */
  put(bytes: Uint8Array): string {
    const hash = sha256Bytes(bytes);
    const file = this.pathOf(hash);
    if (!fs.existsSync(file)) {
      fs.mkdirSync(resolveInside(this.root, hash.slice(7, 9)), { recursive: true });
      try {
        createFileAtomic(file, Buffer.from(bytes));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
    }
    return hash;
  }

  /** Read and verify a blob; throws on a missing or tampered file. */
  read(hash: string): Buffer {
    const file = this.pathOf(hash);
    if (!fs.existsSync(file)) throw new ValueError(`upload ${hash} is missing`);
    const bytes = fs.readFileSync(file);
    if (sha256Bytes(bytes) !== hash) throw new ValueError(`upload ${hash} does not match its content`);
    return bytes;
  }
}
