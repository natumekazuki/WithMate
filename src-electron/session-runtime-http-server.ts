import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";

import {
  SESSION_RUNTIME_MAX_BODY_BYTES,
  SESSION_RUNTIME_MAX_RESPONSE_BYTES,
  SessionRuntimeValidationError,
  createSessionRuntimeError,
  parseSessionRuntimeRequestEnvelope,
  type SessionRuntimeAdapterKind,
  type SessionRuntimeError,
  type SessionRuntimeOperation,
  type SessionRuntimeResultEnvelope,
} from "../src/session-external-runtime-contract.js";
import {
  SESSION_RUNTIME_CHALLENGE_HEADER,
  SESSION_RUNTIME_EXCHANGE_SCHEMA_VERSION,
  SESSION_RUNTIME_INSTANCE_HEADER,
  SESSION_RUNTIME_NONCE_HEADER,
  SESSION_RUNTIME_OPERATION_PATH,
  createSessionRuntimeChallenge,
  type SessionRuntimeExchangePayload,
} from "../src/session-runtime-exchange.js";
import type {
  AgentRuntimeBindingRegistry,
  ResolvedAgentRuntimeBinding,
} from "./agent-runtime-binding.js";

export const SESSION_RUNTIME_AGENT_OPERATION = "session.runtime.invoke";

export type SessionRuntimeInvocationContext = {
  agentRuntimeBinding: ResolvedAgentRuntimeBinding | null;
};

export type SessionRuntimeHttpHandler = (
  operation: SessionRuntimeOperation,
  input: unknown,
  adapter: SessionRuntimeAdapterKind,
  context: SessionRuntimeInvocationContext,
) => Promise<SessionRuntimeResultEnvelope | SessionRuntimeError>;

export type SessionRuntimeHttpServerOptions = {
  apiSecret: string;
  cliSecret: string;
  mcpSecret: string;
  runtimeInstanceId: string;
  agentRuntimeBindingRegistry?: Pick<AgentRuntimeBindingRegistry, "resolve">;
  handle: SessionRuntimeHttpHandler;
  host?: string;
  port?: number;
  preAuthTimeoutMs?: number;
  shutdownGraceMs?: number;
  maxPreAuthConnections?: number;
  maxPreAuthAggregateBytes?: number;
};

export type SessionRuntimeHttpServer = {
  start(): Promise<void>;
  stop(): Promise<void>;
  address(): AddressInfo | null;
};

const DEFAULT_HOST = "127.0.0.1";
const STATUS_PATH = "/v1/status";
const DEFAULT_PRE_AUTH_TIMEOUT_MS = 30_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 1_000;
const DEFAULT_MAX_PRE_AUTH_CONNECTIONS = 32;
const DEFAULT_MAX_PRE_AUTH_AGGREGATE_BYTES = 32 * 1024 * 1024;

export function createSessionRuntimeHttpServer(options: SessionRuntimeHttpServerOptions): SessionRuntimeHttpServer {
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? 0;
  const apiSecret = requireSecret(options.apiSecret, "apiSecret");
  const cliSecret = requireSecret(options.cliSecret, "cliSecret");
  const mcpSecret = requireSecret(options.mcpSecret, "mcpSecret");
  const runtimeInstanceId = requireSecret(options.runtimeInstanceId, "runtimeInstanceId");
  const preAuthTimeoutMs = requirePositiveInteger(options.preAuthTimeoutMs ?? DEFAULT_PRE_AUTH_TIMEOUT_MS, "preAuthTimeoutMs");
  const shutdownGraceMs = requirePositiveInteger(options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS, "shutdownGraceMs");
  const maxPreAuthConnections = requirePositiveInteger(
    options.maxPreAuthConnections ?? DEFAULT_MAX_PRE_AUTH_CONNECTIONS,
    "maxPreAuthConnections",
  );
  const maxPreAuthAggregateBytes = requirePositiveInteger(
    options.maxPreAuthAggregateBytes ?? DEFAULT_MAX_PRE_AUTH_AGGREGATE_BYTES,
    "maxPreAuthAggregateBytes",
  );
  const liveSockets = new Set<Socket>();
  const preAuthRequests = new Map<IncomingMessage, { bytes: number; timeout: NodeJS.Timeout }>();
  const handlerDrainWaiters = new Set<() => void>();
  let preAuthAggregateBytes = 0;
  let activeHandlers = 0;
  let stopping = false;
  let stopPromise: Promise<void> | null = null;

  const releasePreAuth = (request: IncomingMessage): void => {
    const state = preAuthRequests.get(request);
    if (!state) return;
    clearTimeout(state.timeout);
    preAuthAggregateBytes -= state.bytes;
    preAuthRequests.delete(request);
  };

  const beginPreAuth = (request: IncomingMessage): boolean => {
    if (stopping || preAuthRequests.size >= maxPreAuthConnections) {
      return false;
    }
    const timeout = setTimeout(() => {
      releasePreAuth(request);
      request.destroy(new Error("Session runtime pre-auth request timed out."));
    }, preAuthTimeoutMs);
    timeout.unref();
    preAuthRequests.set(request, { bytes: 0, timeout });
    return true;
  };

  const retainPreAuthBytes = (request: IncomingMessage, bytes: number): void => {
    const state = preAuthRequests.get(request);
    if (!state) {
      throw transportError("RUNTIME_UNAVAILABLE", "Session runtime request is no longer admitted.", true);
    }
    state.bytes += bytes;
    preAuthAggregateBytes += bytes;
    if (preAuthAggregateBytes > maxPreAuthAggregateBytes) {
      throw transportError("RUNTIME_UNAVAILABLE", "Session runtime request capacity is unavailable.", true);
    }
  };

  const waitForHandlersToDrain = async (): Promise<void> => {
    if (activeHandlers === 0) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        handlerDrainWaiters.delete(finish);
        resolve();
      };
      const timeout = setTimeout(finish, shutdownGraceMs);
      handlerDrainWaiters.add(finish);
    });
  };

  const server = createServer(async (request, response) => {
    let registeredPreAuth = false;
    try {
      if (!isLoopbackRemoteAddress(request.socket.remoteAddress) || hasBrowserHeaders(request)) {
        writeJson(response, 403, transportError("FORBIDDEN", "Session runtime only accepts local non-browser requests."));
        return;
      }
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === STATUS_PATH) {
        if (request.method !== "GET") {
          writeJson(response, 405, transportError("METHOD_NOT_ALLOWED", "Session runtime status requires GET."));
          return;
        }
        const nonce = url.searchParams.get("nonce")?.trim() ?? "";
        writeJson(response, 200, {
          ok: true,
          runtimeInstanceId,
          ...(nonce ? { challenge: { nonce, hmacSha256: createSessionRuntimeChallenge(apiSecret, runtimeInstanceId, nonce) } } : {}),
        });
        return;
      }
      if (url.pathname !== SESSION_RUNTIME_OPERATION_PATH) {
        writeJson(response, 404, transportError("ROUTE_NOT_FOUND", "Session runtime route was not found."));
        return;
      }
      if (request.method !== "POST" || !acceptsJson(request)) {
        writeJson(response, 415, transportError("UNSUPPORTED_MEDIA_TYPE", "Session runtime operation requires JSON POST."));
        return;
      }

      const nonce = request.headers[SESSION_RUNTIME_NONCE_HEADER];
      const expectedRuntimeInstanceId = request.headers[SESSION_RUNTIME_INSTANCE_HEADER];
      if (
        typeof nonce !== "string"
        || typeof expectedRuntimeInstanceId !== "string"
        || expectedRuntimeInstanceId !== runtimeInstanceId
      ) {
        writeJson(response, 401, transportError("UNAUTHORIZED", "Session runtime request is not authorized."));
        return;
      }
      registeredPreAuth = beginPreAuth(request);
      if (!registeredPreAuth) {
        writeJsonAndClose(request, response, 503, transportError(
          "RUNTIME_UNAVAILABLE",
          "Session runtime request capacity is unavailable.",
          true,
        ));
        return;
      }
      response.writeEarlyHints({
        link: `<${SESSION_RUNTIME_OPERATION_PATH}>; rel=preconnect`,
        [SESSION_RUNTIME_INSTANCE_HEADER]: runtimeInstanceId,
        [SESSION_RUNTIME_CHALLENGE_HEADER]: createSessionRuntimeChallenge(apiSecret, runtimeInstanceId, nonce),
      });
      const declaredLength = parseContentLength(request.headers["content-length"]);
      if (declaredLength !== null && declaredLength > SESSION_RUNTIME_MAX_BODY_BYTES) {
        writeJsonAndClose(
          request,
          response,
          413,
          transportError("CONTENT_TOO_LARGE", "Session runtime request body exceeds 8 MiB."),
        );
        return;
      }
      const payload = parseExchangePayload(await readJsonBody(request, (bytes) => retainPreAuthBytes(request, bytes)));
      const adapter = authenticateExchange(payload, { apiSecret, cliSecret, mcpSecret });
      if (!adapter) {
        writeJson(response, 401, transportError("UNAUTHORIZED", "Session runtime request is not authorized."));
        return;
      }
      releasePreAuth(request);
      registeredPreAuth = false;
      const envelope = parseSessionRuntimeRequestEnvelope(payload.envelope);
      const bindingResolution = resolveInvocationContext(
        envelope.operation,
        payload.agentRuntimeBindingReference,
        options.agentRuntimeBindingRegistry,
      );
      if (!bindingResolution.ok) {
        writeJson(response, 403, bindingResolution.error);
        return;
      }
      activeHandlers += 1;
      let result: SessionRuntimeResultEnvelope | SessionRuntimeError;
      try {
        result = await options.handle(envelope.operation, envelope.input, adapter, bindingResolution.context);
      } finally {
        activeHandlers -= 1;
        if (activeHandlers === 0) {
          for (const resolve of handlerDrainWaiters) resolve();
          handlerDrainWaiters.clear();
        }
      }
      writeJson(response, statusForResponse(result), result);
    } catch (error) {
      if (error instanceof SessionRuntimeValidationError) {
        writeJson(response, error.code === "LIMIT_EXCEEDED" ? 413 : 400, createSessionRuntimeError({
          code: error.code,
          message: error.message,
          details: error.details,
        }));
        return;
      }
      if (isSessionRuntimeError(error)) {
        writeJson(response, statusForResponse(error), error);
        return;
      }
      writeJson(response, 500, createSessionRuntimeError({
        code: "RUNTIME_UNAVAILABLE",
        message: "Session runtime request failed.",
        retryable: true,
        effect: "indeterminate",
      }));
    } finally {
      if (registeredPreAuth) {
        releasePreAuth(request);
      }
    }
  });
  server.headersTimeout = 5_000;
  server.requestTimeout = preAuthTimeoutMs;
  server.maxConnections = maxPreAuthConnections;
  server.on("connection", (socket) => {
    liveSockets.add(socket);
    socket.once("close", () => liveSockets.delete(socket));
  });

  return {
    async start(): Promise<void> {
      if (server.listening) {
        return;
      }
      if (!isLoopbackListenHost(host)) {
        throw new Error("Session runtime host must be loopback.");
      }
      stopping = false;
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        server.once("error", onError);
        server.listen(port, host, () => {
          server.off("error", onError);
          resolve();
        });
      });
    },
    async stop(): Promise<void> {
      if (stopPromise) {
        return stopPromise;
      }
      if (!server.listening) {
        return;
      }
      stopPromise = (async () => {
        stopping = true;
        for (const request of preAuthRequests.keys()) {
          releasePreAuth(request);
          request.destroy();
        }
        server.closeIdleConnections();
        await new Promise<void>((resolve, reject) => {
          const forceClose = setTimeout(() => {
            server.closeAllConnections();
            for (const socket of liveSockets) socket.destroy();
          }, shutdownGraceMs);
          forceClose.unref();
          server.close((error) => {
            clearTimeout(forceClose);
            if (error) reject(error);
            else resolve();
          });
        });
        await waitForHandlersToDrain();
      })();
      try {
        await stopPromise;
      } finally {
        stopPromise = null;
      }
    },
    address(): AddressInfo | null {
      const address = server.address();
      return address && typeof address !== "string" ? address : null;
    },
  };
}

function authenticateExchange(
  payload: SessionRuntimeExchangePayload,
  expected: { apiSecret: string; cliSecret: string; mcpSecret: string },
): SessionRuntimeAdapterKind | null {
  if (
    (payload.adapter !== "cli" && payload.adapter !== "mcp")
    || !safeEqual(payload.apiSecret, expected.apiSecret)
  ) {
    return null;
  }
  const expectedAdapterSecret = payload.adapter === "cli" ? expected.cliSecret : expected.mcpSecret;
  return safeEqual(payload.adapterSecret, expectedAdapterSecret) ? payload.adapter : null;
}

function parseExchangePayload(value: unknown): SessionRuntimeExchangePayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SessionRuntimeValidationError("Session runtime exchange payload must be an object.");
  }
  const record = value as Record<string, unknown>;
  const allowed = [
    "schemaVersion",
    "apiSecret",
    "adapter",
    "adapterSecret",
    "agentRuntimeBindingReference",
    "envelope",
  ];
  if (Object.keys(record).some((key) => !allowed.includes(key))) {
    throw new SessionRuntimeValidationError("Session runtime exchange payload has an unknown field.");
  }
  if (
    record.schemaVersion !== SESSION_RUNTIME_EXCHANGE_SCHEMA_VERSION
    || typeof record.apiSecret !== "string"
    || (record.adapter !== "cli" && record.adapter !== "mcp")
    || typeof record.adapterSecret !== "string"
    || (record.agentRuntimeBindingReference !== undefined
      && typeof record.agentRuntimeBindingReference !== "string")
    || !record.envelope
    || typeof record.envelope !== "object"
    || Array.isArray(record.envelope)
  ) {
    throw new SessionRuntimeValidationError("Session runtime exchange payload is invalid.");
  }
  return {
    schemaVersion: SESSION_RUNTIME_EXCHANGE_SCHEMA_VERSION,
    apiSecret: record.apiSecret,
    adapter: record.adapter,
    adapterSecret: record.adapterSecret,
    ...(record.agentRuntimeBindingReference !== undefined
      ? { agentRuntimeBindingReference: record.agentRuntimeBindingReference }
      : {}),
    envelope: record.envelope as SessionRuntimeExchangePayload["envelope"],
  };
}

function resolveInvocationContext(
  _operation: SessionRuntimeOperation,
  bindingReference: string | undefined,
  registry: Pick<AgentRuntimeBindingRegistry, "resolve"> | undefined,
): { ok: true; context: SessionRuntimeInvocationContext } | { ok: false; error: SessionRuntimeError } {
  if (bindingReference !== undefined && bindingReference.trim().length === 0) {
    return { ok: false, error: bindingFailure("SESSION_BINDING_INVALID") };
  }
  const resolution = registry?.resolve(bindingReference, SESSION_RUNTIME_AGENT_OPERATION);
  if (!resolution?.ok) {
    return {
      ok: false,
      error: bindingFailure(resolution?.code ?? "SESSION_BINDING_REQUIRED"),
    };
  }
  return { ok: true, context: { agentRuntimeBinding: resolution.binding } };
}

function bindingFailure(code: string): SessionRuntimeError {
  return createSessionRuntimeError({
    code,
    message: "Session runtime actor binding is unavailable for this operation.",
  });
}

async function readJsonBody(request: IncomingMessage, retainBytes: (bytes: number) => void): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > SESSION_RUNTIME_MAX_BODY_BYTES) {
      throw transportError("CONTENT_TOO_LARGE", "Session runtime request body exceeds 8 MiB.");
    }
    retainBytes(buffer.byteLength);
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw transportError("INVALID_INPUT", "Session runtime request body must be valid JSON.");
  }
}

function transportError(code: string, message: string, retryable = false): SessionRuntimeError {
  return createSessionRuntimeError({ code, message, retryable });
}

function statusForResponse(value: SessionRuntimeResultEnvelope | SessionRuntimeError): number {
  if (!("error" in value)) {
    return 200;
  }
  switch (value.error.code) {
    case "UNAUTHORIZED": return 401;
    case "FORBIDDEN": return 403;
    case "SESSION_TURN_FORBIDDEN": return 403;
    case "WORK_ITEM_FORBIDDEN": return 403;
    case "WORK_ITEM_AGGREGATION_FORBIDDEN": return 403;
    case "WORK_ITEM_EXECUTION_FORBIDDEN": return 403;
    case "ROUTE_NOT_FOUND":
    case "EXECUTION_NOT_FOUND": return 404;
    case "WORK_ITEM_NOT_FOUND": return 404;
    case "SESSION_BUSY":
    case "QUEUE_FULL":
    case "IDEMPOTENCY_CONFLICT":
    case "IDEMPOTENCY_RESPONSE_UNAVAILABLE":
    case "EXECUTION_NOT_CANCELLABLE": return 409;
    case "WORK_ITEM_REVISION_CONFLICT": return 409;
    case "WORK_ITEM_STATE_CONFLICT": return 409;
    case "WORK_ITEM_PARENT_INVALID": return 409;
    case "WORK_ITEM_AGGREGATION_REVISION_REQUIRED": return 409;
    case "WORK_ITEM_AGGREGATION_PARENT_INVALID": return 409;
    case "WORK_ITEM_AGGREGATION_REVISION_CONFLICT": return 409;
    case "WORK_ITEM_AGGREGATION_CHILD_INVALID": return 409;
    case "WORK_ITEM_AGGREGATION_CHILD_ACTIVE": return 409;
    case "WORK_ITEM_AGGREGATION_DECISION_IMMUTABLE": return 409;
    case "WORK_ITEM_AGGREGATION_DECISION_INVALID": return 409;
    case "WORK_ITEM_AGGREGATION_REASON_REQUIRED": return 409;
    case "WORK_ITEM_AGGREGATION_INCOMPLETE": return 409;
    case "WORK_ITEM_AGGREGATION_PARENT_TERMINAL": return 409;
    case "CONTENT_TOO_LARGE":
    case "LIMIT_EXCEEDED": return 413;
    case "RUNTIME_UNAVAILABLE": return 503;
    default: return 400;
  }
}

function isSessionRuntimeError(value: unknown): value is SessionRuntimeError {
  return Boolean(value && typeof value === "object" && "error" in value);
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  const body = encodeJsonWithinLimit(value, SESSION_RUNTIME_MAX_RESPONSE_BYTES);
  if (body === null) {
    const operation = isSessionRuntimeResultEnvelope(value) ? value.operation : null;
    writeJson(response, 413, createSessionRuntimeError({
      code: "CONTENT_TOO_LARGE",
      message: "Session runtime response exceeds 8 MiB.",
      effect: operation === "turn.run" || operation === "turn.enqueue" || operation === "turn.cancel"
        ? "applied"
        : "not_applied",
    }));
    return;
  }
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

function writeJsonAndClose(
  request: IncomingMessage,
  response: ServerResponse,
  status: number,
  value: unknown,
): void {
  response.once("finish", () => request.destroy());
  writeJson(response, status, value);
}

function isSessionRuntimeResultEnvelope(value: unknown): value is SessionRuntimeResultEnvelope {
  return Boolean(value && typeof value === "object" && "operation" in value && "result" in value);
}

function encodeJsonWithinLimit(value: unknown, maxBytes: number): string | null {
  const chunks: string[] = [];
  const seen = new Set<object>();
  let totalBytes = 0;
  const append = (chunk: string): boolean => {
    totalBytes += Buffer.byteLength(chunk, "utf8");
    if (totalBytes > maxBytes) return false;
    chunks.push(chunk);
    return true;
  };
  const encode = (current: unknown, inArray: boolean): boolean => {
    if (current === null || typeof current === "string" || typeof current === "boolean" || typeof current === "number") {
      const encoded = JSON.stringify(current);
      return append(encoded === undefined ? "null" : encoded);
    }
    if (current === undefined || typeof current === "function" || typeof current === "symbol") {
      return inArray ? append("null") : true;
    }
    if (typeof current !== "object" || seen.has(current)) {
      throw new TypeError("Session runtime response is not JSON serializable.");
    }
    seen.add(current);
    if (Array.isArray(current)) {
      if (!append("[")) return false;
      for (let index = 0; index < current.length; index += 1) {
        if (index > 0 && !append(",")) return false;
        if (!encode(current[index], true)) return false;
      }
      seen.delete(current);
      return append("]");
    }
    if (!append("{")) return false;
    let first = true;
    for (const [key, entry] of Object.entries(current)) {
      if (entry === undefined || typeof entry === "function" || typeof entry === "symbol") continue;
      if (!first && !append(",")) return false;
      first = false;
      if (!append(JSON.stringify(key)) || !append(":")) return false;
      if (!encode(entry, false)) return false;
    }
    seen.delete(current);
    return append("}");
  };
  return encode(value, false) ? chunks.join("") : null;
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return leftBuffer.byteLength === rightBuffer.byteLength && timingSafeEqual(leftBuffer, rightBuffer);
}

function acceptsJson(request: IncomingMessage): boolean {
  const contentType = request.headers["content-type"];
  return typeof contentType === "string" && contentType.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

function parseContentLength(value: string | undefined): number | null {
  if (value === undefined) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function hasBrowserHeaders(request: IncomingMessage): boolean {
  return request.headers.origin !== undefined
    || request.headers["sec-fetch-site"] !== undefined
    || request.headers["sec-fetch-dest"] !== undefined
    || request.headers["sec-fetch-user"] !== undefined;
}

export function isLoopbackRemoteAddress(address: string | undefined): boolean {
  return Boolean(address && (address === "::1" || address.startsWith("127.") || address.startsWith("::ffff:127.")));
}

export function isLoopbackListenHost(host: string): boolean {
  return host === "localhost" || isLoopbackRemoteAddress(host);
}

function requireSecret(value: string, name: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`Session runtime ${name} must be non-empty.`);
  }
  return trimmed;
}

function requirePositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Session runtime ${name} must be a positive integer.`);
  }
  return value;
}
