import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { ChatClient, DEFAULT_BASE_URL, LlmError, parseJsonReply, parseRetryAfter } from "../src/extract/llmClient.js";
import type { ChatClientOptions, FetchLike } from "../src/extract/llmClient.js";
import { completion, fakeFetch, httpError, instantSleep, TEST_KEY } from "./fixtures/extract/fakeLlm.js";

const MESSAGES = [
  { role: "system" as const, content: "Return JSON." },
  { role: "user" as const, content: "Say hi as JSON." },
];

function client(fetch: FetchLike, extra: Partial<ChatClientOptions> = {}): ChatClient {
  return new ChatClient({ apiKey: TEST_KEY, model: "test-model", baseUrl: "https://llm.test/v1", fetch, ...extra });
}

async function caught(p: Promise<unknown>): Promise<LlmError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(LlmError);
    return err as LlmError;
  }
  throw new Error("expected a rejection");
}

describe("ChatClient request shape", () => {
  it("posts an OpenAI-compatible chat completion with response_format json_object", async () => {
    const fetch = fakeFetch(() => completion({ greeting: "hi" }));
    const result = await client(fetch).chatJson(MESSAGES, { temperature: 0.2 });
    expect(result).toEqual({ greeting: "hi" });
    expect(fetch.calls).toHaveLength(1);
    const [call] = fetch.calls;
    expect(call!.url).toBe("https://llm.test/v1/chat/completions");
    expect(call!.init.method).toBe("POST");
    expect(call!.headers.get("authorization")).toBe(`Bearer ${TEST_KEY}`);
    expect(call!.body).toEqual({
      model: "test-model",
      messages: MESSAGES,
      temperature: 0.2,
      response_format: { type: "json_object" },
    });
  });

  it("fromEnv reads LLM_API_KEY, LLM_BASE_URL (default), and LLM_MODEL_NAME", async () => {
    const fetch = fakeFetch(() => completion({}));
    const dflt = ChatClient.fromEnv({ LLM_API_KEY: TEST_KEY, LLM_MODEL_NAME: "m1" }, { fetch });
    expect(dflt.baseUrl).toBe(DEFAULT_BASE_URL);
    expect(dflt.model).toBe("m1");
    const custom = ChatClient.fromEnv({ LLM_API_KEY: TEST_KEY, LLM_MODEL_NAME: "m2", LLM_BASE_URL: "http://localhost:8000/v1/" }, { fetch });
    await custom.chatJson(MESSAGES);
    expect(fetch.calls[0]!.url).toBe("http://localhost:8000/v1/chat/completions");
    expect(() => ChatClient.fromEnv({ LLM_MODEL_NAME: "m" })).toThrow(/LLM_API_KEY is not set/);
    expect(() => ChatClient.fromEnv({ LLM_API_KEY: TEST_KEY })).toThrow(/LLM_MODEL_NAME is not set/);
    expect(() => ChatClient.fromEnv({ LLM_API_KEY: TEST_KEY, LLM_MODEL_NAME: "m", LLM_BASE_URL: "ftp://x" })).toThrow(/http or https/);
  });
});

describe("json_object fallback", () => {
  it("retries once without response_format when the provider rejects it, and parses a fenced reply", async () => {
    const fetch = fakeFetch((call) =>
      call.body.response_format
        ? httpError(400, {
            error: {
              message: "Unrecognized request argument supplied: response_format",
              type: "invalid_request_error",
              param: "response_format",
              code: "unsupported_parameter",
            },
          })
        : completion('Here you go:\n```json\n{"greeting": "hi"}\n```'),
    );
    const { sleep, delays } = instantSleep();
    const c = client(fetch, { sleep });
    expect(await c.chatJson(MESSAGES)).toEqual({ greeting: "hi" });
    expect(fetch.calls).toHaveLength(2);
    expect(fetch.calls[0]!.body.response_format).toEqual({ type: "json_object" });
    expect(fetch.calls[1]!.body).not.toHaveProperty("response_format");
    expect(delays).toEqual([]); // a capability fallback, not a backoff retry
    expect(c.jsonMode).toBe("prompt_only");

    // The rejection is remembered: the next call goes straight to prompt-only JSON.
    expect(await c.chatJson(MESSAGES)).toEqual({ greeting: "hi" });
    expect(fetch.calls).toHaveLength(3);
    expect(fetch.calls[2]!.body).not.toHaveProperty("response_format");
  });

  it("does not fall back for a 400 that is not about response_format", async () => {
    const fetch = fakeFetch(() => httpError(400, { error: { message: "messages: too long", param: "messages" } }));
    const err = await caught(client(fetch).chatJson(MESSAGES));
    expect(err.status).toBe(400);
    expect(fetch.calls).toHaveLength(1);
  });

  it("parses JSON from plain, fenced, and wrapped replies, and rejects non-objects", () => {
    expect(parseJsonReply('{"a": 1}')).toEqual({ a: 1 });
    expect(parseJsonReply('```\n{"a": 2}\n```')).toEqual({ a: 2 });
    expect(parseJsonReply('<think>plan</think>\nSure: {"a": 3} hope this helps')).toEqual({ a: 3 });
    expect(() => parseJsonReply("[1, 2]")).toThrow(/not a JSON object/);
    expect(() => parseJsonReply("no json here")).toThrow(/not a JSON object/);
    expect(() => parseJsonReply("   ")).toThrow(/empty/);
  });

  it("rejects a reply truncated at the token limit", async () => {
    const fetch = fakeFetch(() => completion('{"a": ', "length"));
    const err = await caught(client(fetch).chatJson(MESSAGES));
    expect(err.kind).toBe("response");
    expect(err.message).toMatch(/truncated/);
  });
});

describe("retry policy", () => {
  it("retries a 429 after the Retry-After delay", async () => {
    const fetch = fakeFetch((_, n) =>
      n === 1 ? httpError(429, { error: { message: "rate limited" } }, { "retry-after": "7" }) : completion({ ok: true }),
    );
    const { sleep, delays } = instantSleep();
    expect(await client(fetch, { sleep }).chatJson(MESSAGES)).toEqual({ ok: true });
    expect(fetch.calls).toHaveLength(2);
    expect(delays).toEqual([7000]);
  });

  it("honours an HTTP-date Retry-After and caps it at maxDelayMs", async () => {
    const now = Date.parse("2026-10-04T12:00:00Z");
    expect(parseRetryAfter("Sun, 04 Oct 2026 12:00:03 GMT", now)).toBe(3000);
    expect(parseRetryAfter("1.5", now)).toBe(1500);
    expect(parseRetryAfter("soon", now)).toBeNull();
    const fetch = fakeFetch((_, n) => (n === 1 ? httpError(503, "busy", { "retry-after": "3600" }) : completion({ ok: 1 })));
    const { sleep, delays } = instantSleep();
    await client(fetch, { sleep, maxDelayMs: 5000 }).chatJson(MESSAGES);
    expect(delays).toEqual([5000]);
  });

  it("never retries a 400", async () => {
    const fetch = fakeFetch(() => httpError(400, { error: { message: "bad request" } }));
    const { sleep, delays } = instantSleep();
    const err = await caught(client(fetch, { sleep }).chatJson(MESSAGES));
    expect(err).toMatchObject({ kind: "http", status: 400, retryable: false, attempts: 1 });
    expect(fetch.calls).toHaveLength(1);
    expect(delays).toEqual([]);
  });

  it("never retries other 4xx (401, 404, 422)", async () => {
    for (const status of [401, 404, 422]) {
      const fetch = fakeFetch(() => httpError(status, { error: { message: "no" } }));
      const err = await caught(client(fetch, instantSleep()).chatJson(MESSAGES));
      expect(err.status).toBe(status);
      expect(fetch.calls).toHaveLength(1);
    }
  });

  it("exhausts its bounded attempts on 5xx with exponential backoff", async () => {
    const fetch = fakeFetch(() => httpError(503, { error: { message: "overloaded" } }));
    const { sleep, delays } = instantSleep();
    const err = await caught(client(fetch, { sleep, maxAttempts: 3, initialDelayMs: 100 }).chatJson(MESSAGES));
    expect(fetch.calls).toHaveLength(3);
    expect(delays).toEqual([100, 200]);
    expect(err).toMatchObject({ kind: "http", status: 503, retryable: true, attempts: 3 });
    expect(err.message).toMatch(/HTTP 503: overloaded \(after 3 attempts\)/);
  });

  it("retries 408 and transport errors", async () => {
    let n = 0;
    const fetch: FetchLike = async () => {
      n++;
      if (n === 1) throw new TypeError("fetch failed");
      if (n === 2) return httpError(408, "timeout");
      return completion({ ok: true });
    };
    const { sleep, delays } = instantSleep();
    expect(await client(fetch, { sleep, initialDelayMs: 10 }).chatJson(MESSAGES)).toEqual({ ok: true });
    expect(n).toBe(3);
    expect(delays).toEqual([10, 20]);
  });
});

describe("timeout", () => {
  it("aborts a hung request after timeoutMs and retries within its bound", async () => {
    let aborted = 0;
    const fetch = fakeFetch(
      (call) =>
        new Promise<Response>((_, reject) => {
          call.init.signal!.addEventListener("abort", () => {
            aborted++;
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );
    const { sleep } = instantSleep();
    const err = await caught(client(fetch, { sleep, timeoutMs: 20, maxAttempts: 2 }).chatJson(MESSAGES));
    expect(err.kind).toBe("timeout");
    expect(err.message).toMatch(/timed out after 20 ms \(after 2 attempts\)/);
    expect(fetch.calls).toHaveLength(2);
    expect(aborted).toBe(2);
  });

  it("times out even when the fetch implementation ignores the abort signal", async () => {
    const fetch: FetchLike = () => new Promise<Response>(() => undefined);
    const err = await caught(client(fetch, { timeoutMs: 15, maxAttempts: 1 }).chatJson(MESSAGES));
    expect(err.kind).toBe("timeout");
  });
});

describe("API key hygiene", () => {
  it("never puts the key in thrown error messages", async () => {
    const echo = fakeFetch(() =>
      httpError(401, { error: { message: `Incorrect API key provided: ${TEST_KEY}`, param: TEST_KEY } }),
    );
    const httpErr = await caught(client(echo).chatJson(MESSAGES));
    expect(httpErr.status).toBe(401);
    expect(httpErr.message).toContain("[redacted]");

    const transport: FetchLike = async (_, init) => {
      throw new Error(`connect ECONNREFUSED while sending ${String(new Headers(init.headers).get("authorization"))}`);
    };
    const transportErr = await caught(client(transport, { maxAttempts: 2, sleep: instantSleep().sleep }).chatJson(MESSAGES));
    expect(transportErr.kind).toBe("transport");

    const raw = fakeFetch(() => httpError(500, `upstream said: ${TEST_KEY}`));
    const rawErr = await caught(client(raw, { maxAttempts: 1 }).chatJson(MESSAGES));

    for (const err of [httpErr, transportErr, rawErr]) {
      for (const text of [err.message, String(err.stack), JSON.stringify(err), inspect(err), String(err.providerMessage), String(err.param)]) {
        expect(text).not.toContain(TEST_KEY);
      }
    }
  });

  it("does not expose the key through inspection or serialization", () => {
    const c = client(fakeFetch(() => completion({})));
    expect(inspect(c, { showHidden: true, depth: 5 })).not.toContain(TEST_KEY);
    expect(JSON.stringify(c)).not.toContain(TEST_KEY);
    expect(Object.values(c).join(" ")).not.toContain(TEST_KEY);
  });
});
