/**
 * OpenAI-compatible `/chat/completions` client over an injected `fetch`.
 *
 * - `chatJson` asks for `response_format: {type: "json_object"}`. When the
 *   provider rejects that parameter (a 400/422 whose error names
 *   `response_format`), it retries once without it and parses JSON from the
 *   reply text, tolerating a Markdown fence. The fallback is remembered, so
 *   later calls skip the rejected parameter.
 * - Retries are bounded, with exponential backoff, and only for transport
 *   errors, timeouts, 408, 429, and 5xx. `Retry-After` (seconds or HTTP date)
 *   replaces the backoff delay, capped at `maxDelayMs`. Every other 4xx fails
 *   at once.
 * - Each attempt has its own timeout (AbortController).
 * - The API key lives in a private field, is sent only in the Authorization
 *   header, and is redacted from every error message.
 */

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  readonly role: ChatRole;
  readonly content: string;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
export type Sleep = (ms: number) => Promise<void>;

export const DEFAULT_BASE_URL = "https://api.openai.com/v1";

export const CLIENT_DEFAULTS = Object.freeze({
  timeoutMs: 120_000,
  maxAttempts: 4,
  initialDelayMs: 1_000,
  maxDelayMs: 30_000,
});

export interface ChatClientOptions {
  readonly apiKey: string;
  readonly model: string;
  /** Default `https://api.openai.com/v1`; `/chat/completions` is appended. */
  readonly baseUrl?: string;
  /** Default: the global `fetch`. */
  readonly fetch?: FetchLike;
  /** Backoff sleep; tests inject an instant one. */
  readonly sleep?: Sleep;
  /** Clock (ms since epoch) for HTTP-date `Retry-After` values. */
  readonly now?: () => number;
  /** Per-attempt timeout, including reading the body. */
  readonly timeoutMs?: number;
  /** Total attempts per request (1 = no retries). */
  readonly maxAttempts?: number;
  readonly initialDelayMs?: number;
  readonly maxDelayMs?: number;
  /** Sent as `max_tokens` when set. */
  readonly maxTokens?: number | null;
}

/** Dependencies for `fromEnv`: everything except what the environment supplies. */
export type ChatClientDeps = Omit<ChatClientOptions, "apiKey" | "model" | "baseUrl">;

export type LlmErrorKind = "transport" | "timeout" | "http" | "response" | "config";

export interface LlmErrorDetails {
  readonly status?: number | null;
  readonly retryable?: boolean;
  readonly attempts?: number;
  /** Provider error `param`, when given (redacted). */
  readonly param?: string | null;
  /** Provider error message (redacted, truncated). */
  readonly providerMessage?: string | null;
}

/** Every client failure. Messages never contain the API key. */
export class LlmError extends Error {
  override readonly name = "LlmError";
  readonly status: number | null;
  readonly retryable: boolean;
  readonly attempts: number;
  readonly param: string | null;
  readonly providerMessage: string | null;

  constructor(
    message: string,
    readonly kind: LlmErrorKind,
    details: LlmErrorDetails = {},
  ) {
    super(message);
    this.status = details.status ?? null;
    this.retryable = details.retryable ?? false;
    this.attempts = details.attempts ?? 1;
    this.param = details.param ?? null;
    this.providerMessage = details.providerMessage ?? null;
  }
}

export type JsonMode = "unknown" | "json_object" | "prompt_only";

export interface CompleteOptions {
  readonly temperature?: number;
  /** Request `response_format: {type: "json_object"}`. */
  readonly jsonObject?: boolean;
}

export interface ChatResult {
  readonly text: string;
  readonly finish_reason: string | null;
}

type Attempt =
  | { readonly ok: true; readonly json: unknown }
  | { readonly ok: false; readonly error: LlmError; readonly retryAfterMs: number | null };

const MAX_PROVIDER_MESSAGE = 300;
const ROLES: readonly ChatRole[] = ["system", "user", "assistant"];

const defaultSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function positiveInt(value: unknown, name: string, min = 1): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) {
    throw new LlmError(`${name}: expected an integer >= ${min}`, "config");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

/** `Retry-After` in ms: delta-seconds or an HTTP date; null when absent or unparseable. */
export function parseRetryAfter(value: string | null, nowMs: number): number | null {
  if (value === null) return null;
  const v = value.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : null;
}

/** Text of `choices[0].message.content`, as a string or a list of text parts. */
function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content as unknown[]) {
    if (typeof item === "string") {
      parts.push(item);
    } else if (isRecord(item)) {
      const text = isRecord(item.text) ? item.text.value : item.text;
      if (typeof text === "string") parts.push(text);
      else if (typeof item.content === "string") parts.push(item.content);
    }
  }
  return parts.join("");
}

/** Remove reasoning wrappers and a byte-order mark around a reply. */
function cleanReply(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/^﻿/, "")
    .trim();
}

function tryObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Parse one JSON object from a reply: the whole text, else the first fenced
 * block, else the span from the first `{` to the last `}`. Never repairs JSON.
 */
export function parseJsonReply(text: string): Record<string, unknown> {
  const cleaned = cleanReply(text);
  if (cleaned === "") throw new LlmError("model reply was empty", "response");
  const direct = tryObject(cleaned);
  if (direct !== null) return direct;
  const fence = /```[ \t]*(?:json)?[ \t]*\r?\n?([\s\S]*?)```/i.exec(cleaned);
  if (fence) {
    const fenced = tryObject(fence[1]!.trim());
    if (fenced !== null) return fenced;
  }
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first !== -1 && last > first) {
    const sliced = tryObject(cleaned.slice(first, last + 1));
    if (sliced !== null) return sliced;
  }
  throw new LlmError("model reply is not a JSON object", "response");
}

function isResponseFormatRejection(err: unknown): boolean {
  if (!(err instanceof LlmError) || err.kind !== "http") return false;
  if (err.status !== 400 && err.status !== 422) return false;
  const param = (err.param ?? "").toLowerCase();
  const message = (err.providerMessage ?? "").toLowerCase();
  return param.startsWith("response_format") || message.includes("response_format");
}

export class ChatClient {
  readonly model: string;
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly maxAttempts: number;
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  readonly maxTokens: number | null;
  readonly #apiKey: string;
  readonly #fetch: FetchLike;
  readonly #sleep: Sleep;
  readonly #now: () => number;
  #jsonMode: JsonMode = "unknown";

  constructor(options: ChatClientOptions) {
    if (typeof options.apiKey !== "string" || options.apiKey.trim() === "") {
      throw new LlmError("an API key is required", "config");
    }
    if (typeof options.model !== "string" || options.model.trim() === "") {
      throw new LlmError("a model name is required", "config");
    }
    this.#apiKey = options.apiKey.trim();
    this.model = options.model.trim();
    this.baseUrl = ChatClient.checkBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
    this.timeoutMs = positiveInt(options.timeoutMs ?? CLIENT_DEFAULTS.timeoutMs, "timeoutMs");
    this.maxAttempts = positiveInt(options.maxAttempts ?? CLIENT_DEFAULTS.maxAttempts, "maxAttempts");
    this.initialDelayMs = positiveInt(options.initialDelayMs ?? CLIENT_DEFAULTS.initialDelayMs, "initialDelayMs", 0);
    this.maxDelayMs = positiveInt(options.maxDelayMs ?? CLIENT_DEFAULTS.maxDelayMs, "maxDelayMs", 0);
    this.maxTokens = options.maxTokens == null ? null : positiveInt(options.maxTokens, "maxTokens");
    const globalFetch: FetchLike = (url, init) => fetch(url, init);
    this.#fetch = options.fetch ?? globalFetch;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#now = options.now ?? Date.now;
  }

  /** `LLM_API_KEY` (required), `LLM_BASE_URL` (optional), `LLM_MODEL_NAME` (required). */
  static fromEnv(env: NodeJS.ProcessEnv = process.env, deps: ChatClientDeps = {}): ChatClient {
    const apiKey = env.LLM_API_KEY?.trim();
    if (!apiKey) throw new LlmError("LLM_API_KEY is not set", "config");
    const model = env.LLM_MODEL_NAME?.trim();
    if (!model) throw new LlmError("LLM_MODEL_NAME is not set", "config");
    const baseUrl = env.LLM_BASE_URL?.trim() || DEFAULT_BASE_URL;
    return new ChatClient({ ...deps, apiKey, model, baseUrl });
  }

  private static checkBaseUrl(raw: string): string {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new LlmError("LLM base URL is not a valid URL", "config");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new LlmError("LLM base URL must use http or https", "config");
    }
    if (url.username !== "" || url.password !== "") {
      throw new LlmError("LLM base URL must not embed credentials", "config");
    }
    return raw.replace(/\/+$/, "");
  }

  /** Whether `response_format` is in use, was rejected, or is not yet known. */
  get jsonMode(): JsonMode {
    return this.#jsonMode;
  }

  get endpoint(): string {
    return `${this.baseUrl}/chat/completions`;
  }

  /** Safe description (no key) for logs and `JSON.stringify`. */
  toJSON(): Record<string, unknown> {
    return { baseUrl: this.baseUrl, model: this.model, jsonMode: this.#jsonMode };
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return `ChatClient ${JSON.stringify(this.toJSON())}`;
  }

  /** Strip the key from text bound for an error or log, then truncate it. */
  private redact(text: string): string {
    const clean = text.split(this.#apiKey).join("[redacted]");
    return clean.length > MAX_PROVIDER_MESSAGE ? clean.slice(0, MAX_PROVIDER_MESSAGE) + "..." : clean;
  }

  /** One chat completion; returns the reply text and finish reason. */
  async complete(messages: readonly ChatMessage[], options: CompleteOptions = {}): Promise<ChatResult> {
    if (!Array.isArray(messages) || messages.length === 0) throw new LlmError("messages: expected a non-empty list", "config");
    for (const [i, m] of (messages as readonly unknown[]).entries()) {
      if (!isRecord(m) || !(ROLES as readonly unknown[]).includes(m.role) || typeof m.content !== "string") {
        throw new LlmError(`messages[${i}]: expected {role, content}`, "config");
      }
    }
    const body: Record<string, unknown> = {
      model: this.model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    };
    if (options.temperature !== undefined) body.temperature = options.temperature;
    if (this.maxTokens !== null) body.max_tokens = this.maxTokens;
    if (options.jsonObject) body.response_format = { type: "json_object" };

    const json = await this.post(JSON.stringify(body));
    const choices = isRecord(json) && Array.isArray(json.choices) ? (json.choices as unknown[]) : [];
    const choice = choices[0];
    if (!isRecord(choice)) throw new LlmError("provider response has no choices", "response");
    const finish = typeof choice.finish_reason === "string" ? choice.finish_reason : null;
    const text = messageText(isRecord(choice.message) ? choice.message.content : undefined);
    return { text, finish_reason: finish };
  }

  /**
   * A JSON-object reply. Uses `response_format: json_object` unless the
   * provider has rejected it, in which case the request is retried once
   * without it and the object is parsed from the text.
   */
  async chatJson(messages: readonly ChatMessage[], options: { readonly temperature?: number } = {}): Promise<Record<string, unknown>> {
    let result: ChatResult;
    if (this.#jsonMode === "prompt_only") {
      result = await this.complete(messages, { ...options, jsonObject: false });
    } else {
      try {
        result = await this.complete(messages, { ...options, jsonObject: true });
        this.#jsonMode = "json_object";
      } catch (err) {
        if (!isResponseFormatRejection(err)) throw err;
        this.#jsonMode = "prompt_only";
        result = await this.complete(messages, { ...options, jsonObject: false });
      }
    }
    if (result.finish_reason === "length") throw new LlmError("model reply was truncated at the token limit", "response");
    if (result.finish_reason !== null && result.finish_reason !== "stop") {
      throw new LlmError(`model reply stopped unexpectedly (${this.redact(result.finish_reason)})`, "response");
    }
    return parseJsonReply(result.text);
  }

  /** POST with bounded retries; resolves to the parsed JSON body of a 2xx. */
  private async post(body: string): Promise<unknown> {
    for (let attempt = 1; ; attempt++) {
      const outcome = await this.attempt(body);
      if (outcome.ok) return outcome.json;
      const err = outcome.error;
      if (!err.retryable || attempt >= this.maxAttempts) {
        if (attempt === 1) throw err;
        throw new LlmError(`${err.message} (after ${attempt} attempts)`, err.kind, {
          status: err.status,
          retryable: err.retryable,
          attempts: attempt,
          param: err.param,
          providerMessage: err.providerMessage,
        });
      }
      const backoff = Math.min(this.initialDelayMs * 2 ** (attempt - 1), this.maxDelayMs);
      const delay = outcome.retryAfterMs === null ? backoff : Math.min(outcome.retryAfterMs, this.maxDelayMs);
      await this.#sleep(delay);
    }
  }

  private async attempt(body: string): Promise<Attempt> {
    const controller = new AbortController();
    let timedOut = false;
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
    aborted.catch(() => undefined);
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    const failure = (err: unknown): Attempt => {
      if (timedOut) {
        return {
          ok: false,
          error: new LlmError(`request timed out after ${this.timeoutMs} ms`, "timeout", { retryable: true }),
          retryAfterMs: null,
        };
      }
      const detail = err instanceof Error ? err.message || err.name : String(err);
      const cause = err instanceof Error && isRecord(err.cause) && typeof err.cause.code === "string" ? ` (${err.cause.code})` : "";
      return {
        ok: false,
        error: new LlmError(`transport error: ${this.redact(detail)}${this.redact(cause)}`, "transport", { retryable: true }),
        retryAfterMs: null,
      };
    };
    try {
      let res: Response;
      let text: string;
      try {
        res = await Promise.race([
          this.#fetch(this.endpoint, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${this.#apiKey}`,
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            body,
            signal: controller.signal,
          }),
          aborted,
        ]);
        text = await Promise.race([res.text(), aborted]);
      } catch (err) {
        return failure(err);
      }
      if (res.ok) {
        try {
          return { ok: true, json: JSON.parse(text) as unknown };
        } catch {
          return { ok: false, error: new LlmError("provider returned a non-JSON body", "response"), retryAfterMs: null };
        }
      }
      const { message, param } = this.errorDetails(text);
      const retryable = retryableStatus(res.status);
      return {
        ok: false,
        error: new LlmError(`HTTP ${res.status}: ${message}`, "http", {
          status: res.status,
          retryable,
          param,
          providerMessage: message,
        }),
        retryAfterMs: retryable ? parseRetryAfter(res.headers.get("retry-after"), this.#now()) : null,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Provider error message and `param` from an error body (redacted). */
  private errorDetails(text: string): { message: string; param: string | null } {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      // not JSON: fall back to the raw text
    }
    const err = isRecord(parsed) ? (isRecord(parsed.error) ? parsed.error : parsed) : null;
    const rawMessage =
      err !== null && typeof err.message === "string"
        ? err.message
        : isRecord(parsed) && typeof parsed.error === "string"
          ? parsed.error
          : text.trim();
    const param = err !== null && typeof err.param === "string" ? this.redact(err.param) : null;
    return { message: this.redact(rawMessage || "no error message"), param };
  }
}
