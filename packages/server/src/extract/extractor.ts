/**
 * World-mode extractor (node N8): uploaded documents -> chunks -> one model
 * call per chunk -> strictly validated items -> a world bundle in the import
 * format of `world/codec.ts`, plus an extraction report.
 *
 * Invariants enforced here (and re-checked by `decodeWorld` / `validateLinks`
 * before the bundle is returned):
 * - every record has origin `extracted`; `agent_eligible` is always false and
 *   the basis null. An extraction can never authorize an agent, whatever the
 *   document or the model reply says (guide §10.4);
 * - every record cites Evidence: source hash, absolute source span, the
 *   upload's availability time, and an extraction version that hashes the
 *   prompt template;
 * - identity is never merged on a name: same kind + normalized name in
 *   different chunks gives separate entities joined by a `candidate` alias
 *   link for review. Only exact duplicates within one chunk collapse;
 * - IDs derive from source hash + chunk + local ref, so reruns are stable.
 *
 * Actor-kind entities are listed as `agent_candidate_suggestions` in the
 * report: suggestions for explicit operator selection, not eligible agents.
 */
import {
  ACTOR_KINDS,
  AliasLink,
  canonicalJson,
  eligible,
  KINDS,
  OntologyRegistry,
  resolveIdentities,
  RoleDef,
  SubtypeDef,
  ValueError,
} from "@c2p/core";
import type { EntityJson, Kind } from "@c2p/core";
import type { ClaimJson, EventParticipationJson, EvidenceJson, RoleAssignmentRecordJson } from "../wire.js";
import { decodeWorld, DEFAULT_RECORD_VERSION, DEFAULT_SCENARIO } from "../world/codec.js";
import type { OntologyJson, WorldPayload } from "../world/codec.js";
import type { ExtractionContext, ExtractionInput, Extractor } from "../world/extractor.js";
import { checkChunking, chunkSource } from "./chunking.js";
import type { Chunk, ChunkingOptions } from "./chunking.js";
import { sha256Bytes, sha256Text, stableId, toWellFormedText } from "./hashing.js";
import { LlmError } from "./llmClient.js";
import type { ChatMessage } from "./llmClient.js";
import { buildMessages, PROMPT_TEMPLATE_HASH } from "./prompt.js";
import { newIssueLog, ReplyValidator } from "./validate.js";
import type { AuthorityIssue, Issue, IssueLog, LocalSpan, ParsedReply } from "./validate.js";

export const EXTRACTOR_NAME = "llm-world-extractor";
export const EXTRACTION_VERSION_BASE = "extract.world.v1";
/** Constant plus a hash of the prompt template; any prompt edit changes it. */
export const EXTRACTION_VERSION = `${EXTRACTION_VERSION_BASE}+prompt.${PROMPT_TEMPLATE_HASH.slice(7, 19)}`;
export const EXTRACTION_REPORT_SCHEMA = "extraction_report.v1";
export const EXTRACTED_EPISTEMIC_STATUS = "source_asserted";
export const SPAN_UNIT = "utf16_code_unit_of_utf8_decoded_text";

const role = (name: string, allowed: readonly Kind[], scope: readonly Kind[]): OntologyJson["roles"][number] =>
  Object.freeze({ name, allowed_kinds: Object.freeze([...allowed]), scope_kinds: Object.freeze([...scope]) }) as OntologyJson["roles"][number];

/** Approved vocabulary offered to the model; replies may extend it (reported). */
export const DEFAULT_BASE_ONTOLOGY: OntologyJson = Object.freeze({
  version: "ontology.v1",
  subtypes: Object.freeze([]),
  roles: Object.freeze([
    role("Participant", ACTOR_KINDS, ["Event"]),
    role("Organizer", ACTOR_KINDS, ["Event"]),
    role("Host", ["Organization", "Group"], ["Event"]),
    role("Venue", ["Location"], ["Event"]),
    role("Employee", ["Person"], ["Organization"]),
    role("Member", ["Person", "Organization"], ["Organization", "Group"]),
    role("Author", ACTOR_KINDS, ["Artifact"]),
  ]),
}) as unknown as OntologyJson;

/** The client surface the extractor needs (`ChatClient` satisfies it). */
export interface JsonChatClient {
  chatJson(messages: readonly ChatMessage[], options?: { readonly temperature?: number }): Promise<Record<string, unknown>>;
  readonly model?: string;
  readonly jsonMode?: string;
}

export interface WorldExtractorOptions {
  readonly client: JsonChatClient;
  readonly name?: string;
  readonly chunking?: Partial<ChunkingOptions>;
  /** Default 0. */
  readonly temperature?: number;
  /** Record envelope scenario; default `baseline`. */
  readonly scenarioId?: string;
  readonly baseOntology?: OntologyJson;
  /** The upload time of the input's files (the project's creation time). */
  readonly availabilityTime?: (input: ExtractionInput) => string | null | undefined | Promise<string | null | undefined>;
  /** Fallback when no upload time is known. */
  readonly clock?: () => Date;
  /** Receives the report of every successful `extract` call. */
  readonly onReport?: (report: ExtractionReport, input: ExtractionInput) => void | Promise<void>;
}

export interface FileReport {
  file_id: string;
  filename: string;
  source_hash: string;
  text_length: number;
  total_chunks: number;
  processed_chunks: number;
  sampled: boolean;
  selected_chunk_indices: number[] | null;
  duplicate_of_file_id: string | null;
  invalid_utf8_replaced: boolean;
}

export interface ChunkReport {
  chunk_id: string;
  source_file_id: string;
  source_hash: string;
  index: number;
  span: [number, number];
  chunk_hash: string;
  status: "ok" | "failed" | "blank";
  error: string | null;
  entities_accepted: number;
}

export interface AliasSuggestion {
  entity_id_a: string;
  entity_id_b: string;
  status: "candidate";
  evidence_ids: string[];
  primary_kind: Kind;
  normalized_name: string;
  same_chunk: boolean;
}

export interface AgentCandidateSuggestion {
  entity_id: string;
  display_name: string;
  primary_kind: Kind;
  agent_eligible: false;
  note: string;
}

export interface CollapsedDuplicate {
  chunk_id: string;
  ref: string;
  into_entity_id: string;
}

export interface ExtractionReport {
  schema_version: string;
  extractor: string;
  model: string | null;
  json_mode: string | null;
  extraction_version: string;
  prompt_template_hash: string;
  project_id: string;
  scenario_id: string;
  availability_time: string;
  availability_time_source: "upload" | "extraction_clock";
  span_unit: string;
  chunking: { max_chars: number; overlap_chars: number; max_chunks: number };
  sampling: { sampled_files: number; chunks_total: number; chunks_selected: number };
  files: FileReport[];
  chunks: ChunkReport[];
  ontology: { version: string; base_version: string; extension_subtypes: string[]; extension_roles: string[] };
  world_entity_count: number;
  agent_candidate_count: number;
  agent_candidate_suggestions: AgentCandidateSuggestion[];
  alias_links: AliasSuggestion[];
  collapsed_duplicates: CollapsedDuplicate[];
  counts: { entities: number; role_assignments: number; participations: number; claims: number; evidence: number };
  ignored_authority_fields: AuthorityIssue[];
  rejected_items: Issue[];
  warnings: Issue[];
}

export interface ExtractionResult {
  readonly world: WorldPayload;
  readonly report: ExtractionReport;
}

interface EntityDraft {
  readonly id: string;
  readonly chunk_id: string;
  readonly order: number;
  readonly ref: string;
  readonly kind: Kind;
  readonly display_name: string;
  readonly norm: string;
  readonly contentKey: string;
  subtypes: string[];
  readonly attributes: readonly (readonly [string, string])[];
  readonly evidence_ids: string[];
}

interface RoleDraft {
  readonly entity_id: string;
  readonly role: string;
  readonly scope_entity_id: string;
  readonly evidence_ids: string[];
}

interface ParticipationDraft {
  readonly event_id: string;
  readonly participant_entity_id: string;
  readonly participation_role: string;
  readonly evidence_ids: string[];
}

interface ClaimDraft {
  readonly claim_id: string;
  readonly subject_entity_id: string;
  readonly predicate: string;
  readonly object_entity_id: string;
  readonly evidence_ids: string[];
}

interface RunState {
  readonly availability_time: string;
  readonly availability_time_source: "upload" | "extraction_clock";
  readonly base: OntologyRegistry;
  readonly log: IssueLog;
  readonly entities: EntityDraft[];
  readonly roles: Map<string, RoleDraft>;
  readonly participations: Map<string, ParticipationDraft>;
  readonly claims: Map<string, ClaimDraft>;
  readonly evidence: Map<string, EvidenceJson>;
  /** Role usages for roles outside the base ontology. */
  readonly roleUse: Map<string, { allowed: Set<Kind>; scope: Set<Kind> }>;
  readonly collapsed: CollapsedDuplicate[];
}

const ISO_PREFIX = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})?)?$/;

/** NFKC, lower case, collapsed whitespace, surrounding punctuation removed. */
export function normalizeName(name: string): string {
  return name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/^[\s"'“”‘’.,;:()[\]{}]+|[\s"'“”‘’.,;:()[\]{}]+$/g, "");
}

function decodeText(bytes: Uint8Array): { text: string; lossy: boolean } {
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), lossy: false };
  } catch {
    return { text: new TextDecoder("utf-8").decode(bytes), lossy: true };
  }
}

const kindList = (set: ReadonlySet<Kind>): Kind[] => KINDS.filter((k) => set.has(k));

function pushUnique(target: string[], values: readonly string[]): void {
  for (const v of values) if (!target.includes(v)) target.push(v);
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message || err.name : String(err));

export class WorldExtractor implements Extractor {
  readonly name: string;
  private readonly client: JsonChatClient;
  private readonly chunking: ChunkingOptions;
  private readonly temperature: number;
  private readonly scenarioId: string;
  private readonly baseOntology: OntologyJson;
  private readonly baseRegistry: OntologyRegistry;

  constructor(private readonly options: WorldExtractorOptions) {
    this.name = options.name ?? EXTRACTOR_NAME;
    this.client = options.client;
    this.chunking = checkChunking(options.chunking);
    this.temperature = options.temperature ?? 0;
    this.scenarioId = options.scenarioId ?? DEFAULT_SCENARIO;
    this.baseOntology = structuredClone(options.baseOntology ?? DEFAULT_BASE_ONTOLOGY);
    this.baseRegistry = new OntologyRegistry({
      version: this.baseOntology.version,
      subtypes: this.baseOntology.subtypes.map((s) => new SubtypeDef(s)),
      roles: this.baseOntology.roles.map((r) => new RoleDef(r)),
    });
  }

  /** Model name reported by the client, if any. */
  get model(): string | null {
    return this.client.model ?? null;
  }

  async extract(input: ExtractionInput, ctx: ExtractionContext): Promise<unknown> {
    const { world, report } = await this.run(input, ctx);
    await this.options.onReport?.(report, input);
    return world;
  }

  /** Extract a validated world bundle and its report. */
  async run(input: ExtractionInput, ctx: ExtractionContext = { progress: () => undefined }): Promise<ExtractionResult> {
    const upload = await this.options.availabilityTime?.(input);
    const availability_time = upload ?? (this.options.clock?.() ?? new Date()).toISOString();
    if (typeof availability_time !== "string" || !ISO_PREFIX.test(availability_time) || !Number.isFinite(Date.parse(availability_time))) {
      throw new ValueError(`availability time ${JSON.stringify(availability_time)} is not an ISO 8601 timestamp`);
    }
    const state: RunState = {
      availability_time,
      availability_time_source: upload == null ? "extraction_clock" : "upload",
      base: this.baseRegistry,
      log: newIssueLog(),
      entities: [],
      roles: new Map(),
      participations: new Map(),
      claims: new Map(),
      evidence: new Map(),
      roleUse: new Map(),
      collapsed: [],
    };

    // Sources: verify each file's hash, decode, chunk; identical bytes are processed once.
    const files: FileReport[] = [];
    const work: { chunk: Chunk; label: string; report: ChunkReport }[] = [];
    const chunkReports: ChunkReport[] = [];
    const seen = new Map<string, string>();
    for (const { file, bytes } of input.files) {
      const source_hash = sha256Bytes(bytes);
      if (file.content_hash !== source_hash) {
        throw new ValueError(`file ${file.file_id}: bytes do not match content hash ${file.content_hash}`);
      }
      const dup = seen.get(source_hash) ?? null;
      const { text, lossy } = dup === null ? decodeText(bytes) : { text: "", lossy: false };
      const plan = dup === null ? chunkSource({ source_file_id: file.file_id, source_hash, text }, this.chunking) : null;
      seen.set(source_hash, dup ?? file.file_id);
      files.push({
        file_id: file.file_id,
        filename: file.filename,
        source_hash,
        text_length: plan?.text_length ?? 0,
        total_chunks: plan?.total_chunks ?? 0,
        processed_chunks: plan?.chunks.length ?? 0,
        sampled: plan?.sampled ?? false,
        selected_chunk_indices: plan?.sampled ? [...plan.selected_indices] : null,
        duplicate_of_file_id: dup,
        invalid_utf8_replaced: lossy,
      });
      if (lossy) {
        state.log.warnings.push({ chunk_id: "", path: `files.${file.file_id}`, message: "invalid UTF-8 replaced with U+FFFD" });
      }
      for (const chunk of plan?.chunks ?? []) {
        const report: ChunkReport = {
          chunk_id: chunk.chunk_id,
          source_file_id: chunk.source_file_id,
          source_hash: chunk.source_hash,
          index: chunk.index,
          span: [chunk.span[0], chunk.span[1]],
          chunk_hash: chunk.chunk_hash,
          status: chunk.text.trim() === "" ? "blank" : "ok",
          error: null,
          entities_accepted: 0,
        };
        chunkReports.push(report);
        if (report.status === "ok") work.push({ chunk, label: file.filename, report });
      }
    }
    if (work.length === 0) throw new ValueError("no extractable text: the project's files are empty or blank");

    // One model call per chunk, in order.
    let succeeded = 0;
    let firstFailure: string | null = null;
    const perFile = new Map<string, number>();
    for (const w of work) perFile.set(w.chunk.source_file_id, (perFile.get(w.chunk.source_file_id) ?? 0) + 1);
    const position = new Map<string, number>();
    for (const [i, w] of work.entries()) {
      const k = (position.get(w.chunk.source_file_id) ?? 0) + 1;
      position.set(w.chunk.source_file_id, k);
      const of = perFile.get(w.chunk.source_file_id)!;
      ctx.progress(i / work.length, `extracting chunk ${k}/${of} of ${w.label}`);
      const messages = buildMessages({
        ontology: this.baseOntology,
        sourceLabel: w.label,
        chunk: w.chunk,
        chunkNumber: k,
        chunkCount: of,
      });
      let reply: Record<string, unknown>;
      try {
        reply = await this.client.chatJson(messages, { temperature: this.temperature });
      } catch (err) {
        if (err instanceof LlmError && err.kind === "response") {
          w.report.status = "failed";
          w.report.error = toWellFormedText(err.message);
          firstFailure ??= err.message;
          continue;
        }
        throw new Error(`extraction stopped at chunk ${k}/${of} of ${w.label}: ${errorText(err)}`);
      }
      const parsed = new ReplyValidator(w.chunk.chunk_id, w.chunk.text, state.log).parse(reply);
      w.report.entities_accepted = this.addChunk(state, w.chunk, parsed);
      succeeded++;
    }
    if (succeeded === 0) throw new ValueError(`no chunk produced a usable extraction (first error: ${firstFailure})`);
    ctx.progress(1, "validating the extracted world");

    return this.assemble(state, input, files, chunkReports);
  }

  /** Map one validated reply into the run state; returns the number of new entities. */
  private addChunk(state: RunState, chunk: Chunk, parsed: ParsedReply): number {
    const reject = (path: string, message: string): void => {
      state.log.rejected.push({ chunk_id: chunk.chunk_id, path, message: toWellFormedText(message) });
    };
    const evidenceIds = (spans: readonly LocalSpan[]): string[] =>
      spans.map((span) => {
        const start = chunk.span[0] + span.start;
        const end = chunk.span[0] + span.end;
        const evidence_id = stableId("ev", [chunk.source_hash, start, end, EXTRACTION_VERSION]);
        if (!state.evidence.has(evidence_id)) {
          state.evidence.set(evidence_id, {
            evidence_id,
            source_hash: chunk.source_hash,
            source_span: [start, end],
            availability_time: state.availability_time,
            extraction_version: EXTRACTION_VERSION,
            review_status: "unreviewed",
            origin: "extracted",
          });
        }
        return evidence_id;
      });

    // Entities: a ref names one entity per chunk; exact duplicates collapse.
    const refs = new Map<string, EntityDraft>();
    const byContent = new Map<string, EntityDraft>();
    let added = 0;
    for (const e of parsed.entities) {
      const norm = normalizeName(e.display_name);
      const contentKey = JSON.stringify([
        e.primary_kind,
        norm,
        [...e.subtypes].sort(),
        [...e.attributes].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
      ]);
      const prior = refs.get(e.ref);
      if (prior !== undefined) {
        if (prior.contentKey === contentKey) {
          pushUnique(prior.evidence_ids, evidenceIds(e.evidence));
        } else {
          reject(e.path, `ref ${JSON.stringify(e.ref)} already names a different entity in this chunk`);
        }
        continue;
      }
      const same = byContent.get(contentKey);
      if (same !== undefined) {
        pushUnique(same.evidence_ids, evidenceIds(e.evidence));
        refs.set(e.ref, same);
        state.collapsed.push({ chunk_id: chunk.chunk_id, ref: e.ref, into_entity_id: same.id });
        continue;
      }
      const draft: EntityDraft = {
        id: stableId("ent", [chunk.source_hash, chunk.chunk_id, e.ref]),
        chunk_id: chunk.chunk_id,
        order: state.entities.length,
        ref: e.ref,
        kind: e.primary_kind,
        display_name: e.display_name,
        norm,
        contentKey,
        subtypes: [...e.subtypes],
        attributes: e.attributes,
        evidence_ids: evidenceIds(e.evidence),
      };
      refs.set(e.ref, draft);
      byContent.set(contentKey, draft);
      state.entities.push(draft);
      added++;
    }

    const lookup = (ref: string, field: string, path: string): EntityDraft | null => {
      const found = refs.get(ref);
      if (found === undefined) reject(path, `${field} ${JSON.stringify(ref)} names no accepted entity in this chunk`);
      return found ?? null;
    };
    const baseRole = (name: string): RoleDef | null => state.base.roles.find((r) => r.name === name) ?? null;
    const useRole = (name: string, holder: Kind, scope: Kind): void => {
      if (baseRole(name) !== null) return;
      const use = state.roleUse.get(name) ?? { allowed: new Set<Kind>(), scope: new Set<Kind>() };
      use.allowed.add(holder);
      use.scope.add(scope);
      state.roleUse.set(name, use);
    };

    for (const r of parsed.roles) {
      const holder = lookup(r.entity_ref, "entity_ref", r.path);
      const scope = lookup(r.scope_ref, "scope_ref", r.path);
      if (holder === null || scope === null) continue;
      if (holder === scope) {
        reject(r.path, "an entity cannot hold a role scoped to itself");
        continue;
      }
      const def = baseRole(r.role);
      if (def !== null && !(def.allowed_kinds.includes(holder.kind) && def.scope_kinds.includes(scope.kind))) {
        reject(r.path, `approved role ${r.role} does not allow a ${holder.kind} within a ${scope.kind}`);
        continue;
      }
      useRole(r.role, holder.kind, scope.kind);
      const key = JSON.stringify([holder.id, r.role, scope.id]);
      const ev = evidenceIds(r.evidence);
      const existing = state.roles.get(key);
      if (existing) pushUnique(existing.evidence_ids, ev);
      else state.roles.set(key, { entity_id: holder.id, role: r.role, scope_entity_id: scope.id, evidence_ids: ev });
    }

    for (const p of parsed.participations) {
      const event = lookup(p.event_ref, "event_ref", p.path);
      const who = lookup(p.participant_ref, "participant_ref", p.path);
      if (event === null || who === null) continue;
      if (event.kind !== "Event") {
        reject(p.path, `event_ref names a ${event.kind}, not an Event`);
        continue;
      }
      if (who.kind === "Event") {
        reject(p.path, "an Event cannot be a participant");
        continue;
      }
      const def = baseRole(p.participation_role);
      if (def !== null && !(def.scope_kinds.includes("Event") && def.allowed_kinds.includes(who.kind))) {
        reject(p.path, `approved role ${p.participation_role} does not allow a ${who.kind} in an Event`);
        continue;
      }
      useRole(p.participation_role, who.kind, "Event");
      const key = JSON.stringify([event.id, who.id, p.participation_role]);
      const ev = evidenceIds(p.evidence);
      const existing = state.participations.get(key);
      if (existing) pushUnique(existing.evidence_ids, ev);
      else {
        state.participations.set(key, {
          event_id: event.id,
          participant_entity_id: who.id,
          participation_role: p.participation_role,
          evidence_ids: ev,
        });
      }
    }

    for (const c of parsed.relations) {
      const subject = lookup(c.subject_ref, "subject_ref", c.path);
      const object = lookup(c.object_ref, "object_ref", c.path);
      if (subject === null || object === null) continue;
      if (subject === object) {
        reject(c.path, "a relation claim needs two different entities");
        continue;
      }
      const claim_id = stableId("clm", [chunk.source_hash, chunk.chunk_id, subject.id, c.predicate, object.id]);
      const ev = evidenceIds(c.evidence);
      const existing = state.claims.get(claim_id);
      if (existing) pushUnique(existing.evidence_ids, ev);
      else {
        state.claims.set(claim_id, {
          claim_id,
          subject_entity_id: subject.id,
          predicate: c.predicate,
          object_entity_id: object.id,
          evidence_ids: ev,
        });
      }
    }
    return added;
  }

  /** Subtypes: approved ones must match their kind; a new name used for two kinds is dropped. */
  private resolveSubtypes(state: RunState): SubtypeDef[] {
    const baseKind = (name: string): Kind | null => {
      try {
        return state.base.kindOf(name);
      } catch {
        return null;
      }
    };
    const kindsOf = new Map<string, Set<Kind>>();
    for (const e of state.entities) {
      for (const s of e.subtypes) kindsOf.set(s, (kindsOf.get(s) ?? new Set<Kind>()).add(e.kind));
    }
    const extensions: SubtypeDef[] = [];
    const drop = new Set<string>();
    for (const [name, kinds] of kindsOf) {
      const approved = baseKind(name);
      if (approved !== null) continue;
      if (kinds.size > 1) {
        drop.add(name);
        state.log.warnings.push({
          chunk_id: "",
          path: `subtypes.${toWellFormedText(name)}`,
          message: `subtype proposed for several kinds (${kindList(kinds).join(", ")}); dropped as ambiguous`,
        });
      } else {
        extensions.push(new SubtypeDef({ name, parent: [...kinds][0]! }));
      }
    }
    for (const e of state.entities) {
      e.subtypes = e.subtypes.filter((s) => {
        const approved = baseKind(s);
        if (approved !== null && approved !== e.kind) {
          state.log.warnings.push({
            chunk_id: e.chunk_id,
            path: `entities.${e.id}.subtypes`,
            message: `approved subtype ${s} refines ${approved}, not ${e.kind}; dropped`,
          });
          return false;
        }
        return !drop.has(s);
      });
    }
    return extensions;
  }

  private assemble(state: RunState, input: ExtractionInput, files: FileReport[], chunks: ChunkReport[]): ExtractionResult {
    const extSubtypes = this.resolveSubtypes(state);
    const extRoles = [...state.roleUse].map(
      ([name, use]) => new RoleDef({ name, allowed_kinds: kindList(use.allowed), scope_kinds: kindList(use.scope) }),
    );
    const extJson = {
      subtypes: extSubtypes.map((s) => ({ name: s.name, parent: s.parent })),
      roles: extRoles.map((r) => ({ name: r.name, allowed_kinds: [...r.allowed_kinds], scope_kinds: [...r.scope_kinds] })),
    };
    const hasExtensions = extJson.subtypes.length > 0 || extJson.roles.length > 0;
    const version = hasExtensions
      ? `${this.baseOntology.version}+ext.${sha256Text(canonicalJson(extJson)).slice(7, 19)}`
      : this.baseOntology.version;
    const ontology: OntologyJson = {
      version,
      subtypes: [...this.baseOntology.subtypes.map((s) => ({ ...s })), ...extJson.subtypes],
      roles: [
        ...this.baseOntology.roles.map((r) => ({ ...r, allowed_kinds: [...r.allowed_kinds], scope_kinds: [...r.scope_kinds] })),
        ...extJson.roles,
      ],
    };

    const entities: EntityJson[] = state.entities.map((e) => ({
      schema_version: "world.v1",
      entity_id: e.id,
      display_name: e.display_name,
      primary_kind: e.kind,
      subtypes: [...e.subtypes],
      roles: [],
      classification_candidates: [],
      agent_eligible: false,
      agent_eligibility_basis: null,
      origin: "extracted",
      epistemic_status: EXTRACTED_EPISTEMIC_STATUS,
      external_ids: [],
      evidence_ids: [...e.evidence_ids],
      attributes: Object.fromEntries(e.attributes) as Record<string, string>,
      ontology_version: version,
    }));
    const role_assignments: RoleAssignmentRecordJson[] = [...state.roles.values()].map((r) => ({
      entity_id: r.entity_id,
      role: r.role,
      scope_entity_id: r.scope_entity_id,
      valid_from: null,
      valid_to: null,
      evidence_ids: [...r.evidence_ids],
      origin: "extracted",
    }));
    const participations: EventParticipationJson[] = [...state.participations.values()].map((p) => ({
      event_id: p.event_id,
      participant_entity_id: p.participant_entity_id,
      participation_role: p.participation_role,
      valid_from: null,
      valid_to: null,
      evidence_ids: [...p.evidence_ids],
      origin: "extracted",
    }));
    const claims: ClaimJson[] = [...state.claims.values()].map((c) => ({
      claim_id: c.claim_id,
      claim_kind: "relation",
      subject_entity_id: c.subject_entity_id,
      predicate: c.predicate,
      object_entity_id: c.object_entity_id,
      value: null,
      variable_key: null,
      evidence_ids: [...c.evidence_ids],
      assertion_status: "asserted",
      valid_from: null,
      valid_to: null,
      conflict_group_id: null,
      origin: "extracted",
    }));
    const world: WorldPayload = {
      scenario_id: this.scenarioId,
      version: DEFAULT_RECORD_VERSION,
      ontology,
      entities,
      role_assignments,
      participations,
      claims,
      evidence: [...state.evidence.values()],
    };

    // Same decoder and `validateLinks` as an import; throws on any violation.
    const bundle = decodeWorld(structuredClone(world));
    const agentCount = bundle.entities.filter(eligible).length;
    if (agentCount !== 0) throw new ValueError("extraction produced an agent-eligible entity");

    // Same kind + normalized name: candidate alias links for review, never merges.
    const aliases: AliasSuggestion[] = [];
    const groups = new Map<string, EntityDraft[]>();
    for (const e of state.entities) {
      const key = JSON.stringify([e.kind, e.norm]);
      groups.set(key, [...(groups.get(key) ?? []), e]);
    }
    for (const members of groups.values()) {
      const [first, ...rest] = members;
      for (const other of rest) {
        aliases.push({
          entity_id_a: first!.id,
          entity_id_b: other.id,
          status: "candidate",
          evidence_ids: [...new Set([first!.evidence_ids[0]!, other.evidence_ids[0]!])],
          primary_kind: other.kind,
          normalized_name: other.norm,
          same_chunk: first!.chunk_id === other.chunk_id,
        });
      }
    }
    const links = aliases.map(
      (a) => new AliasLink({ entity_id_a: a.entity_id_a, entity_id_b: a.entity_id_b, status: a.status, evidence_ids: a.evidence_ids }),
    );
    for (const [id, canonical] of resolveIdentities(bundle.entities, links)) {
      if (id !== canonical) throw new ValueError(`extraction merged ${id} into ${canonical}`);
    }

    const suggestions: AgentCandidateSuggestion[] = state.entities
      .filter((e) => (ACTOR_KINDS as readonly string[]).includes(e.kind))
      .map((e) => ({
        entity_id: e.id,
        display_name: e.display_name,
        primary_kind: e.kind,
        agent_eligible: false,
        note: "suggestion only: eligibility requires explicit operator selection",
      }));

    const report: ExtractionReport = {
      schema_version: EXTRACTION_REPORT_SCHEMA,
      extractor: this.name,
      model: this.client.model ?? null,
      json_mode: this.client.jsonMode ?? null,
      extraction_version: EXTRACTION_VERSION,
      prompt_template_hash: PROMPT_TEMPLATE_HASH,
      project_id: input.project_id,
      scenario_id: this.scenarioId,
      availability_time: state.availability_time,
      availability_time_source: state.availability_time_source,
      span_unit: SPAN_UNIT,
      chunking: {
        max_chars: this.chunking.maxChars,
        overlap_chars: this.chunking.overlapChars,
        max_chunks: this.chunking.maxChunks,
      },
      sampling: {
        sampled_files: files.filter((f) => f.sampled).length,
        chunks_total: files.reduce((n, f) => n + f.total_chunks, 0),
        chunks_selected: files.reduce((n, f) => n + f.processed_chunks, 0),
      },
      files,
      chunks,
      ontology: {
        version,
        base_version: this.baseOntology.version,
        extension_subtypes: extJson.subtypes.map((s) => s.name),
        extension_roles: extJson.roles.map((r) => r.name),
      },
      world_entity_count: bundle.entities.length,
      agent_candidate_count: agentCount,
      agent_candidate_suggestions: suggestions,
      alias_links: aliases,
      collapsed_duplicates: state.collapsed,
      counts: {
        entities: entities.length,
        role_assignments: role_assignments.length,
        participations: participations.length,
        claims: claims.length,
        evidence: world.evidence.length,
      },
      ignored_authority_fields: state.log.ignored_authority_fields,
      rejected_items: state.log.rejected,
      warnings: state.log.warnings,
    };
    return { world, report };
  }
}
