export type CodexRequestId = string | number;

export type CodexWireSuccessResponse = Readonly<{
  kind: "response";
  id: CodexRequestId;
  result: unknown;
  jsonrpc?: "2.0";
}>;

export type CodexWireError = Readonly<{
  code: number;
  message: string;
  data?: unknown;
}>;

export type CodexWireErrorResponse = Readonly<{
  kind: "errorResponse";
  id: CodexRequestId;
  error: CodexWireError;
  jsonrpc?: "2.0";
}>;

export type CodexW3cTraceContext = Readonly<{
  traceparent?: string | null;
  tracestate?: string | null;
}>;

export type CodexWireServerRequest = Readonly<{
  kind: "serverRequest";
  id: CodexRequestId;
  method: string;
  params?: unknown;
  trace?: CodexW3cTraceContext | null;
  jsonrpc?: "2.0";
}>;

export type CodexWireNotification = Readonly<{
  kind: "notification";
  method: string;
  params?: unknown;
  emittedAtMs?: number;
  jsonrpc?: "2.0";
}>;

export type CodexWireEnvelope =
  CodexWireSuccessResponse | CodexWireErrorResponse | CodexWireServerRequest | CodexWireNotification;

export type CodexWireProtocolErrorCode =
  "empty_line" | "invalid_utf8" | "line_too_large" | "malformed_json" | "invalid_envelope" | "partial_line";

export class CodexWireProtocolError extends Error {
  constructor(readonly code: CodexWireProtocolErrorCode) {
    super(protocolErrorMessage(code));
    this.name = "CodexWireProtocolError";
  }
}

export function decodeCodexWireEnvelope(value: unknown): CodexWireEnvelope {
  if (!isPlainObject(value) || !hasValidJsonRpc(value)) {
    throw invalidEnvelope();
  }

  const hasMethod = hasOwn(value, "method");
  const hasId = hasOwn(value, "id");
  const hasResult = hasOwn(value, "result");
  const hasError = hasOwn(value, "error");

  if (hasMethod) {
    if (hasResult || hasError || typeof value.method !== "string" || value.method.length === 0) {
      throw invalidEnvelope();
    }
    if (hasId) {
      return decodeServerRequest(value);
    }
    return decodeNotification(value);
  }

  if (!hasId || !isRequestId(value.id) || hasResult === hasError) {
    throw invalidEnvelope();
  }
  if (hasResult) {
    return withJsonRpc(
      {
        kind: "response",
        id: value.id,
        result: value.result,
      },
      value,
    );
  }
  return decodeErrorResponse(value);
}

function decodeServerRequest(value: Record<string, unknown>): CodexWireServerRequest {
  const trace = hasOwn(value, "trace") ? decodeTraceContext(value.trace) : undefined;
  if (!isRequestId(value.id) || (hasOwn(value, "trace") && trace === undefined)) {
    throw invalidEnvelope();
  }
  return withJsonRpc(
    {
      kind: "serverRequest",
      id: value.id,
      method: value.method as string,
      ...(hasOwn(value, "params") ? { params: value.params } : {}),
      ...(hasOwn(value, "trace") ? { trace: trace as CodexW3cTraceContext | null } : {}),
    },
    value,
  );
}

function decodeNotification(value: Record<string, unknown>): CodexWireNotification {
  if (hasOwn(value, "emittedAtMs") && !Number.isSafeInteger(value.emittedAtMs)) {
    throw invalidEnvelope();
  }
  return withJsonRpc(
    {
      kind: "notification",
      method: value.method as string,
      ...(hasOwn(value, "params") ? { params: value.params } : {}),
      ...(hasOwn(value, "emittedAtMs") ? { emittedAtMs: value.emittedAtMs as number } : {}),
    },
    value,
  );
}

function decodeErrorResponse(value: Record<string, unknown>): CodexWireErrorResponse {
  if (!isPlainObject(value.error)) {
    throw invalidEnvelope();
  }
  const error = value.error;
  if (!Number.isSafeInteger(error.code) || typeof error.message !== "string") {
    throw invalidEnvelope();
  }
  return withJsonRpc(
    {
      kind: "errorResponse",
      id: value.id as CodexRequestId,
      error: {
        code: error.code as number,
        message: error.message,
        ...(hasOwn(error, "data") ? { data: error.data } : {}),
      },
    },
    value,
  );
}

function withJsonRpc<T extends object>(envelope: T, value: Record<string, unknown>): T & { jsonrpc?: "2.0" } {
  return hasOwn(value, "jsonrpc") ? { ...envelope, jsonrpc: "2.0" } : envelope;
}

function hasValidJsonRpc(value: Record<string, unknown>): boolean {
  return !hasOwn(value, "jsonrpc") || value.jsonrpc === "2.0";
}

function isRequestId(value: unknown): value is CodexRequestId {
  return typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value));
}

function decodeTraceContext(value: unknown): CodexW3cTraceContext | null | undefined {
  if (value === null) return null;
  if (!isPlainObject(value)) return undefined;
  if (!isOptionalNullableString(value, "traceparent") || !isOptionalNullableString(value, "tracestate")) {
    return undefined;
  }
  return {
    ...(hasOwn(value, "traceparent") ? { traceparent: value.traceparent as string | null } : {}),
    ...(hasOwn(value, "tracestate") ? { tracestate: value.tracestate as string | null } : {}),
  };
}

function isOptionalNullableString(value: Record<string, unknown>, key: string): boolean {
  return !hasOwn(value, key) || value[key] === null || typeof value[key] === "string";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function invalidEnvelope(): CodexWireProtocolError {
  return new CodexWireProtocolError("invalid_envelope");
}

function protocolErrorMessage(code: CodexWireProtocolErrorCode): string {
  switch (code) {
    case "empty_line":
      return "Codex App Server emitted an empty protocol line.";
    case "invalid_utf8":
      return "Codex App Server emitted invalid UTF-8.";
    case "line_too_large":
      return "Codex App Server emitted an oversized protocol line.";
    case "malformed_json":
      return "Codex App Server emitted malformed JSON.";
    case "invalid_envelope":
      return "Codex App Server emitted an invalid wire envelope.";
    case "partial_line":
      return "Codex App Server closed stdout with an incomplete protocol line.";
  }
}
