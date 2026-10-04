/**
 * Fake OpenAI-compatible endpoint for extraction tests: a `fetch` stand-in
 * that records requests and answers with canned responses. No network.
 */
import type { FetchLike } from "../../../src/extract/llmClient.js";

export const TEST_KEY = "sk-test-SECRET-0123456789abcdef";

export interface RecordedCall {
  readonly url: string;
  readonly init: RequestInit;
  readonly headers: Headers;
  readonly body: {
    model: string;
    messages: { role: string; content: string }[];
    temperature?: number;
    response_format?: { type: string };
    [key: string]: unknown;
  };
}

export type FakeFetch = FetchLike & { readonly calls: RecordedCall[] };

/** A `fetch` that records each call and delegates the answer to `handler`. */
export function fakeFetch(handler: (call: RecordedCall, n: number) => Response | Promise<Response>): FakeFetch {
  const calls: RecordedCall[] = [];
  const fn = async (url: string, init: RequestInit): Promise<Response> => {
    const call: RecordedCall = {
      url,
      init,
      headers: new Headers(init.headers),
      body: JSON.parse(String(init.body)) as RecordedCall["body"],
    };
    calls.push(call);
    return handler(call, calls.length);
  };
  return Object.assign(fn, { calls });
}

/** A 200 chat completion whose message content is `content` (objects are JSON-encoded). */
export function completion(content: string | object, finish_reason = "stop"): Response {
  const text = typeof content === "string" ? content : JSON.stringify(content);
  return new Response(
    JSON.stringify({
      id: "cmpl-test",
      object: "chat.completion",
      choices: [{ index: 0, finish_reason, message: { role: "assistant", content: text } }],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

export function httpError(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** Records requested sleeps without waiting. */
export function instantSleep(): { sleep: (ms: number) => Promise<void>; delays: number[] } {
  const delays: number[] = [];
  return {
    delays,
    sleep: async (ms: number) => {
      delays.push(ms);
    },
  };
}

export function systemMessage(call: RecordedCall): string {
  return call.body.messages.find((m) => m.role === "system")?.content ?? "";
}

export function userMessage(call: RecordedCall): string {
  return call.body.messages.find((m) => m.role === "user")?.content ?? "";
}

/** The document chunk between the boundary markers of the user message. */
export function documentChunk(call: RecordedCall): string {
  const user = userMessage(call);
  const m = /<<<DOCUMENT_DATA_BEGIN ([0-9a-f]+)>>>\n([\s\S]*)\n<<<DOCUMENT_DATA_END \1>>>/.exec(user);
  if (!m) throw new Error("no document chunk in the user message");
  return m[2]!;
}

/** A fake endpoint that answers each chunk with `reply(chunkText, call)`. */
export function llmFetch(reply: (chunk: string, call: RecordedCall) => object | string): FakeFetch {
  return fakeFetch((call) => completion(reply(documentChunk(call), call)));
}

/** An evidence span for `quote` in `text` (the `occurrence`-th match), with correct offsets. */
export function span(text: string, quote: string, occurrence = 0): { quote: string; start: number; end: number } {
  let at = -1;
  for (let k = 0; k <= occurrence; k++) {
    at = text.indexOf(quote, at + 1);
    if (at === -1) throw new Error(`fixture quote not found: ${quote}`);
  }
  return { quote, start: at, end: at + quote.length };
}
