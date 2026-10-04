/**
 * Extraction hook. Node N8 supplies an `Extractor`; `buildApp({extractor})`
 * registers the `world_extraction` job kind. Without one, the extraction route
 * answers 501. Extractor output is a world bundle (see `codec.ts`) and passes
 * the same validation as an import, so an extracted record can never
 * authorize an agent.
 */
import type { ProjectFile } from "../wire.js";

export const EXTRACTION_TASK_KIND = "world_extraction";

export interface ExtractionFile {
  readonly file: ProjectFile;
  readonly bytes: Buffer;
}

export interface ExtractionInput {
  readonly project_id: string;
  readonly prediction_question: string;
  readonly files: readonly ExtractionFile[];
}

export interface ExtractionContext {
  progress(fraction: number | null, message?: string | null): void;
}

export interface Extractor {
  readonly name: string;
  /** Returns world-bundle JSON; it is decoded and validated by the server. */
  extract(input: ExtractionInput, ctx: ExtractionContext): Promise<unknown>;
}
