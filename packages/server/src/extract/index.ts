/**
 * Extraction pipeline (node N8): an OpenAI-compatible JSON client, chunking,
 * the world-mode prompt, strict reply validation, and the `Extractor` that
 * `buildApp({extractor})` registers.
 */
import type { ArtifactStore } from "../store/index.js";
import type { ChunkingOptions } from "./chunking.js";
import { EXTRACTION_REPORT_SCHEMA, WorldExtractor } from "./extractor.js";
import type { ExtractionReport, WorldExtractorOptions } from "./extractor.js";
import { ChatClient } from "./llmClient.js";
import type { ChatClientDeps } from "./llmClient.js";

export * from "./chunking.js";
export * from "./extractor.js";
export * from "./llmClient.js";
export * from "./prompt.js";
export { newIssueLog, ReplyValidator, resolveSpan } from "./validate.js";
export type { AuthorityIssue, Issue, IssueLog, LocalSpan, ParsedReply } from "./validate.js";

/** Artifact kind of stored extraction reports (namespaced by project ID). */
export const EXTRACTION_REPORT_KIND = "extraction_report";

export interface ExtractorEnvDeps extends ChatClientDeps {
  readonly chunking?: Partial<ChunkingOptions>;
  readonly availabilityTime?: WorldExtractorOptions["availabilityTime"];
  readonly onReport?: WorldExtractorOptions["onReport"];
}

/**
 * A `WorldExtractor` configured from `LLM_API_KEY`, `LLM_BASE_URL`, and
 * `LLM_MODEL_NAME`, or `undefined` when `LLM_API_KEY` is unset (the
 * extraction route then answers 501). Throws when the key is set but the
 * rest of the configuration is invalid.
 */
export function extractorFromEnv(env: NodeJS.ProcessEnv = process.env, deps: ExtractorEnvDeps = {}): WorldExtractor | undefined {
  if (!env.LLM_API_KEY?.trim()) return undefined;
  const { chunking, availabilityTime, onReport, ...clientDeps } = deps;
  const client = ChatClient.fromEnv(env, clientDeps);
  return new WorldExtractor({
    client,
    ...(chunking ? { chunking } : {}),
    ...(availabilityTime ? { availabilityTime } : {}),
    ...(onReport ? { onReport } : {}),
  });
}

/** Store a report as an immutable `extraction_report` artifact of the project; returns its hash. */
export function storeExtractionReport(artifacts: ArtifactStore, projectId: string, report: ExtractionReport): string {
  return artifacts.put(EXTRACTION_REPORT_KIND, report, {
    origin: "extracted",
    scenario_id: projectId,
    run_id: null,
    version: EXTRACTION_REPORT_SCHEMA,
  }).content_hash;
}
