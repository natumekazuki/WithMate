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
    if (!hasOnlyKeys(value, ["id", "result", "jsonrpc"])) {
      throw invalidEnvelope();
    }
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
  if (
    !isRequestId(value.id) ||
    !hasOnlyKeys(value, ["id", "method", "params", "trace", "jsonrpc"]) ||
    (hasOwn(value, "trace") && !isTraceContext(value.trace))
  ) {
    throw invalidEnvelope();
  }
  return withJsonRpc(
    {
      kind: "serverRequest",
      id: value.id,
      method: value.method as string,
      ...(hasOwn(value, "params") ? { params: value.params } : {}),
      ...(hasOwn(value, "trace") ? { trace: value.trace as CodexW3cTraceContext | null } : {}),
    },
    value,
  );
}

function decodeNotification(value: Record<string, unknown>): CodexWireNotification {
  if (!hasOnlyKeys(value, ["method", "params", "jsonrpc"])) {
    throw invalidEnvelope();
  }
  return withJsonRpc(
    {
      kind: "notification",
      method: value.method as string,
      ...(hasOwn(value, "params") ? { params: value.params } : {}),
    },
    value,
  );
}

function decodeErrorResponse(value: Record<string, unknown>): CodexWireErrorResponse {
  if (!hasOnlyKeys(value, ["id", "error", "jsonrpc"]) || !isPlainObject(value.error)) {
    throw invalidEnvelope();
  }
  const error = value.error;
  if (
    !hasOnlyKeys(error, ["code", "message", "data"]) ||
    !Number.isSafeInteger(error.code) ||
    typeof error.message !== "string"
  ) {
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

function isTraceContext(value: unknown): value is CodexW3cTraceContext | null {
  if (value === null) return true;
  if (!isPlainObject(value) || !hasOnlyKeys(value, ["traceparent", "tracestate"])) return false;
  return isOptionalNullableString(value, "traceparent") && isOptionalNullableString(value, "tracestate");
}

function isOptionalNullableString(value: Record<string, unknown>, key: string): boolean {
  return !hasOwn(value, key) || value[key] === null || typeof value[key] === "string";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
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
