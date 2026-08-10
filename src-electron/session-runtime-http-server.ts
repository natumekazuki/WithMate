import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import {
  SESSION_RUNTIME_MAX_BODY_BYTES,
  SessionRuntimeValidationError,
  createSessionRuntimeError,
  parseSessionRuntimeRequestEnvelope,
  type SessionRuntimeAdapterKind,
  type SessionRuntimeError,
  type SessionRuntimeOperation,
  type SessionRuntimeResultEnvelope,
} from "../src/session-external-runtime-contract.js";
import {
  SESSION_RUNTIME_ADAPTER_HEADER,
  SESSION_RUNTIME_ADAPTER_SECRET_HEADER,
  SESSION_RUNTIME_API_SECRET_HEADER,
  SESSION_RUNTIME_CHALLENGE_HEADER,
  SESSION_RUNTIME_INSTANCE_HEADER,
  SESSION_RUNTIME_NONCE_HEADER,
  SESSION_RUNTIME_OPERATION_PATH,
  createSessionRuntimeChallenge,
} from "../src/session-runtime-exchange.js";

export type SessionRuntimeHttpHandler = (
  operation: SessionRuntimeOperation,
  input: unknown,
  adapter: SessionRuntimeAdapterKind,
) => Promise<SessionRuntimeResultEnvelope | SessionRuntimeError>;

export type SessionRuntimeHttpServerOptions = {
  apiSecret: string;
  cliSecret: string;
  mcpSecret: string;
  runtimeInstanceId: string;
  handle: SessionRuntimeHttpHandler;
  host?: string;
  port?: number;
};

export type SessionRuntimeHttpServer = {
  start(): Promise<void>;
  stop(): Promise<void>;
  address(): AddressInfo | null;
};

const DEFAULT_HOST = "127.0.0.1";
const STATUS_PATH = "/v1/status";

export function createSessionRuntimeHttpServer(options: SessionRuntimeHttpServerOptions): SessionRuntimeHttpServer {
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? 0;
  const apiSecret = requireSecret(options.apiSecret, "apiSecret");
  const cliSecret = requireSecret(options.cliSecret, "cliSecret");
  const mcpSecret = requireSecret(options.mcpSecret, "mcpSecret");
  const runtimeInstanceId = requireSecret(options.runtimeInstanceId, "runtimeInstanceId");

  const server = createServer(async (request, response) => {
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

      const adapter = authenticateRequest(request, { apiSecret, cliSecret, mcpSecret, runtimeInstanceId });
      if (!adapter) {
        writeJson(response, 401, transportError("UNAUTHORIZED", "Session runtime request is not authorized."));
        return;
      }
      const declaredLength = parseContentLength(request.headers["content-length"]);
      if (declaredLength !== null && declaredLength > SESSION_RUNTIME_MAX_BODY_BYTES) {
        writeJson(response, 413, transportError("CONTENT_TOO_LARGE", "Session runtime request body exceeds 8 MiB."));
        return;
      }
      const envelope = parseSessionRuntimeRequestEnvelope(await readJsonBody(request));
      const result = await options.handle(envelope.operation, envelope.input, adapter);
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
    }
  });

  return {
    async start(): Promise<void> {
      if (server.listening) {
        return;
      }
      if (!isLoopbackListenHost(host)) {
        throw new Error("Session runtime host must be loopback.");
      }
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
      if (!server.listening) {
        return;
      }
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
    address(): AddressInfo | null {
      const address = server.address();
      return address && typeof address !== "string" ? address : null;
    },
  };
}

function authenticateRequest(
  request: IncomingMessage,
  expected: { apiSecret: string; cliSecret: string; mcpSecret: string; runtimeInstanceId: string },
): SessionRuntimeAdapterKind | null {
  const adapter = request.headers[SESSION_RUNTIME_ADAPTER_HEADER];
  const nonce = request.headers[SESSION_RUNTIME_NONCE_HEADER];
  const challenge = request.headers[SESSION_RUNTIME_CHALLENGE_HEADER];
  const runtimeInstanceId = request.headers[SESSION_RUNTIME_INSTANCE_HEADER];
  const apiSecret = request.headers[SESSION_RUNTIME_API_SECRET_HEADER];
  const adapterSecret = request.headers[SESSION_RUNTIME_ADAPTER_SECRET_HEADER];
  if (
    (adapter !== "cli" && adapter !== "mcp")
    || typeof nonce !== "string"
    || typeof challenge !== "string"
    || typeof runtimeInstanceId !== "string"
    || typeof apiSecret !== "string"
    || typeof adapterSecret !== "string"
    || runtimeInstanceId !== expected.runtimeInstanceId
    || !safeEqual(apiSecret, expected.apiSecret)
    || !safeEqual(challenge, createSessionRuntimeChallenge(expected.apiSecret, expected.runtimeInstanceId, nonce))
  ) {
    return null;
  }
  const expectedAdapterSecret = adapter === "cli" ? expected.cliSecret : expected.mcpSecret;
  return safeEqual(adapterSecret, expectedAdapterSecret) ? adapter : null;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > SESSION_RUNTIME_MAX_BODY_BYTES) {
      throw transportError("CONTENT_TOO_LARGE", "Session runtime request body exceeds 8 MiB.");
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw transportError("INVALID_INPUT", "Session runtime request body must be valid JSON.");
  }
}

function transportError(code: string, message: string): SessionRuntimeError {
  return createSessionRuntimeError({ code, message });
}

function statusForResponse(value: SessionRuntimeResultEnvelope | SessionRuntimeError): number {
  if (!("error" in value)) {
    return 200;
  }
  switch (value.error.code) {
    case "UNAUTHORIZED": return 401;
    case "FORBIDDEN": return 403;
    case "ROUTE_NOT_FOUND":
    case "EXECUTION_NOT_FOUND": return 404;
    case "SESSION_BUSY":
    case "QUEUE_FULL":
    case "IDEMPOTENCY_CONFLICT":
    case "EXECUTION_NOT_CANCELLABLE": return 409;
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
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
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
