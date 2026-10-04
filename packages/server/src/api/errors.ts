/**
 * One error shape for every response: `{error: {code, message}}`, never a stack.
 *
 * Mapping (guide §11.1): malformed requests and IDs → 400; unknown resources →
 * 404; lifecycle/version conflicts → 409; oversized uploads → 413; a
 * well-formed request whose content is invalid (core `ValueError`, invalid
 * world, out-of-bounds forecast, unsupported counterfactual) → 422; features
 * whose node is not wired yet → 501; anything else → 500 with a generic message.
 */
import { ValueError } from "@c2p/core";
import type { FastifyError, FastifyInstance } from "fastify";

export interface ErrorBody {
  readonly error: { readonly code: string; readonly message: string };
}

/** An error with an explicit HTTP status and wire code. */
export class HttpError extends Error {
  override readonly name = "HttpError";
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const badRequest = (code: string, message: string): HttpError => new HttpError(400, code, message);
export const notFound = (code: string, message: string): HttpError => new HttpError(404, code, message);
export const conflict = (code: string, message: string): HttpError => new HttpError(409, code, message);
export const tooLarge = (code: string, message: string): HttpError => new HttpError(413, code, message);
export const unprocessable = (code: string, message: string): HttpError => new HttpError(422, code, message);
export const notImplemented = (message: string): HttpError => new HttpError(501, "not_implemented", message);

export function errorBody(code: string, message: string): ErrorBody {
  return { error: { code, message } };
}

/** Rethrow a core `ValueError` from `fn` as a 422 with `code`. */
export function as422<T>(code: string, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof ValueError) throw unprocessable(code, err.message);
    throw err;
  }
}

const STATUS_CODES: Readonly<Record<number, string>> = {
  400: "bad_request",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  405: "method_not_allowed",
  406: "not_acceptable",
  409: "conflict",
  413: "payload_too_large",
  415: "unsupported_media_type",
  422: "unprocessable",
  429: "rate_limited",
};

/** Fastify and multipart plugin codes → [status, wire code]. */
const FRAMEWORK_CODES: Readonly<Record<string, readonly [number, string]>> = {
  FST_ERR_CTP_INVALID_MEDIA_TYPE: [415, "unsupported_media_type"],
  FST_ERR_CTP_BODY_TOO_LARGE: [413, "payload_too_large"],
  FST_ERR_CTP_EMPTY_JSON_BODY: [400, "bad_request"],
  FST_ERR_CTP_INVALID_JSON_BODY: [400, "bad_request"],
  FST_INVALID_MULTIPART_CONTENT_TYPE: [415, "unsupported_media_type"],
  FST_FILES_LIMIT: [413, "too_many_files"],
  FST_REQ_FILE_TOO_LARGE: [413, "file_too_large"],
  FST_PARTS_LIMIT: [413, "too_many_parts"],
  FST_FIELDS_LIMIT: [413, "too_many_parts"],
  FST_PROTO_VIOLATION: [400, "bad_request"],
  FST_MP_PREMATURE_CLOSE: [400, "bad_request"],
};

const MULTIPART_MESSAGES: Readonly<Record<string, string>> = {
  FST_FILES_LIMIT: "too many files in one upload",
  FST_REQ_FILE_TOO_LARGE: "an uploaded file exceeds the per-file size limit",
  FST_INVALID_MULTIPART_CONTENT_TYPE: "expected multipart/form-data",
};

export interface Classified {
  readonly status: number;
  readonly code: string;
  readonly message: string;
}

export function classify(err: unknown): Classified {
  if (err instanceof HttpError) return { status: err.statusCode, code: err.code, message: err.message };
  if (err instanceof ValueError) return { status: 422, code: "invalid_input", message: err.message };
  const fe = err as Partial<FastifyError> | null;
  if (fe && typeof fe === "object") {
    const mapped = typeof fe.code === "string" ? FRAMEWORK_CODES[fe.code] : undefined;
    if (mapped) {
      const message = MULTIPART_MESSAGES[fe.code!] ?? String(fe.message ?? mapped[1]);
      return { status: mapped[0], code: mapped[1], message };
    }
    if (fe.validation) return { status: 400, code: "bad_request", message: String(fe.message) };
    const status = fe.statusCode;
    if (typeof status === "number" && status >= 400 && status < 500) {
      return { status, code: STATUS_CODES[status] ?? "bad_request", message: String(fe.message ?? "bad request") };
    }
  }
  return { status: 500, code: "internal_error", message: "internal server error" };
}

export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((err, request, reply) => {
    const c = classify(err);
    if (c.status >= 500) request.log.error({ err }, "unhandled error");
    void reply.status(c.status).type("application/json; charset=utf-8").send(errorBody(c.code, c.message));
  });
  app.setNotFoundHandler((request, reply) => {
    void reply
      .status(404)
      .type("application/json; charset=utf-8")
      .send(errorBody("not_found", `no route for ${request.method} ${request.url.split("?")[0]}`));
  });
}
