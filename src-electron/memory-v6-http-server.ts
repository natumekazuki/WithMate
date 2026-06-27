import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { createMemoryErrorResponse, type MemoryErrorResponse } from "../src/memory-v6/memory-response-contract.js";
import type { MemoryV6Service } from "./memory-v6-service.js";
import type { MemoryV6Principal } from "./memory-v6-permission.js";
import { createLocalUserMemoryPrincipal } from "./memory-v6-permission.js";
import { WITHMATE_MEMORY_BINDING_REFERENCE_HEADER } from "./provider-memory-binding.js";

export type MemoryV6HttpServerOptions = {
  service: MemoryV6Service;
  resolvePrincipal(input: {
    request: IncomingMessage;
    bindingReference: string | null;
  }): MemoryV6Principal | null | Promise<MemoryV6Principal | null>;
  apiSecret: string;
  runtimeInstanceId: string;
  host?: string;
  port?: number;
  maxBodyBytes?: number;
  requestTimeoutMs?: number;
  maxConcurrentRequests?: number;
};

export type MemoryV6HttpServer = {
  start(): Promise<void>;
  stop(): Promise<void>;
  address(): AddressInfo | null;
};

type MemoryV6Route = "context" | "search" | "get_entry" | "list_tags" | "append" | "forget";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 0;
const DEFAULT_MAX_BODY_BYTES = 256 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_CONCURRENT_REQUESTS = 8;
export const WITHMATE_MEMORY_API_SECRET_HEADER = "x-withmate-memory-api-secret";
const STATUS_CHALLENGE_NONCE_QUERY = "nonce";

const routeByPath = new Map<string, MemoryV6Route>([
  ["/v1/context", "context"],
  ["/v1/search", "search"],
  ["/v1/get_entry", "get_entry"],
  ["/v1/list_tags", "list_tags"],
  ["/v1/append", "append"],
  ["/v1/forget", "forget"],
]);

function memoryTransportError(code: string, message: string): MemoryErrorResponse {
  return createMemoryErrorResponse({ code, message });
}

function writeJson(response: ServerResponse, statusCode: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

function rejectBrowserRequest(request: IncomingMessage): MemoryErrorResponse | null {
  if (request.headers.origin !== undefined) {
    return memoryTransportError("MEMORY_BROWSER_REQUEST_FORBIDDEN", "Memory API does not accept browser-origin requests.");
  }

  for (const header of ["sec-fetch-site", "sec-fetch-dest", "sec-fetch-user"]) {
    if (request.headers[header] !== undefined) {
      return memoryTransportError("MEMORY_BROWSER_REQUEST_FORBIDDEN", "Memory API does not accept browser fetch metadata.");
    }
  }

  return null;
}

function acceptsJsonRequest(request: IncomingMessage): boolean {
  const contentType = request.headers["content-type"];
  if (typeof contentType !== "string") {
    return false;
  }
  return contentType.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

function timingSafeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  if (leftBuffer.byteLength !== rightBuffer.byteLength) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function authenticateInternalApiRequest(request: IncomingMessage, apiSecret: string): MemoryErrorResponse | null {
  const header = request.headers[WITHMATE_MEMORY_API_SECRET_HEADER];
  if (typeof header !== "string" || !timingSafeStringEqual(header, apiSecret)) {
    return memoryTransportError("MEMORY_UNAUTHORIZED", "Memory API request is not authorized.");
  }
  return null;
}

function readBindingReference(request: IncomingMessage): string | null {
  const header = request.headers[WITHMATE_MEMORY_BINDING_REFERENCE_HEADER];
  return typeof header === "string" && header.trim() ? header.trim() : null;
}

function isMemoryErrorResponse(value: unknown): value is MemoryErrorResponse {
  return typeof value === "object" && value !== null && "error" in value;
}

export function isLoopbackRemoteAddress(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) {
    return false;
  }
  if (remoteAddress === "127.0.0.1" || remoteAddress === "::1") {
    return true;
  }
  if (remoteAddress.startsWith("127.")) {
    return true;
  }
  return remoteAddress === "::ffff:127.0.0.1" || remoteAddress.startsWith("::ffff:127.");
}

export function isLoopbackListenHost(host: string): boolean {
  return host === "localhost" || isLoopbackRemoteAddress(host);
}

async function readJsonBody(request: IncomingMessage, maxBodyBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > maxBodyBytes) {
      throw memoryTransportError("MEMORY_REQUEST_TOO_LARGE", "Memory request body is too large.");
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    return {};
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw memoryTransportError("MEMORY_INVALID_JSON", "Memory request body must be valid JSON.");
  }
}

function routeServiceRequest(service: MemoryV6Service, principal: MemoryV6Principal | null, route: MemoryV6Route, body: unknown): unknown {
  if (route === "context") {
    return service.resolveContext(principal, body);
  }
  if (route === "search") {
    return service.search(principal, body);
  }
  if (route === "get_entry") {
    return service.getEntry(principal, body);
  }
  if (route === "list_tags") {
    return service.listTags(principal, body);
  }
  if (route === "append") {
    return service.append(principal, body);
  }
  return service.forget(principal, body);
}

function statusForMemoryResponse(value: unknown): number {
  if (!isMemoryErrorResponse(value)) {
    return 200;
  }

  switch (value.error.code) {
    case "MEMORY_BINDING_REQUIRED":
    case "MEMORY_UNAUTHORIZED":
      return 401;
    case "MEMORY_FORBIDDEN":
      return 403;
    case "MEMORY_ENTRY_NOT_FOUND":
    case "MEMORY_TARGET_NOT_FOUND":
      return 404;
    case "MEMORY_REQUEST_TOO_LARGE":
      return 413;
    case "MEMORY_UNSUPPORTED_MEDIA_TYPE":
      return 415;
    case "MEMORY_TOO_MANY_REQUESTS":
      return 429;
    case "MEMORY_INVALID_JSON":
      return 400;
    default:
      return 422;
  }
}

function requireNonEmptySecret(value: string, name: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`Memory API ${name} must be non-empty.`);
  }
  return trimmed;
}

function createStatusChallenge(apiSecret: string, nonce: string): string {
  return createHmac("sha256", apiSecret).update(nonce, "utf8").digest("base64url");
}

function buildStatusResponse(input: { apiSecret: string; runtimeInstanceId: string; requestUrl: string | undefined }): unknown {
  const url = new URL(input.requestUrl ?? "/", "http://127.0.0.1");
  const nonce = url.searchParams.get(STATUS_CHALLENGE_NONCE_QUERY)?.trim() ?? "";
  return {
    ok: true,
    runtimeInstanceId: input.runtimeInstanceId,
    ...(nonce
      ? { challenge: { nonce, hmacSha256: createStatusChallenge(input.apiSecret, nonce) } }
      : {}),
  };
}

export function createMemoryV6HttpServer(options: MemoryV6HttpServerOptions): MemoryV6HttpServer {
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const apiSecret = requireNonEmptySecret(options.apiSecret, "apiSecret");
  const runtimeInstanceId = requireNonEmptySecret(options.runtimeInstanceId, "runtimeInstanceId");
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const maxConcurrentRequests = options.maxConcurrentRequests ?? DEFAULT_MAX_CONCURRENT_REQUESTS;
  let activeRequests = 0;

  const server = createServer(async (request, response) => {
    let admitted = false;
    try {
      if (!isLoopbackRemoteAddress(request.socket.remoteAddress)) {
        writeJson(response, 403, memoryTransportError("MEMORY_FORBIDDEN", "Memory API only accepts loopback requests."));
        return;
      }
      const browserRequestError = rejectBrowserRequest(request);
      if (browserRequestError) {
        writeJson(response, 403, browserRequestError);
        return;
      }
      const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      if (pathname === "/v1/status") {
        if (request.method !== "GET") {
          writeJson(response, 405, memoryTransportError("MEMORY_METHOD_NOT_ALLOWED", "Memory API route does not support this method."));
          return;
        }
        writeJson(response, 200, buildStatusResponse({ apiSecret, runtimeInstanceId, requestUrl: request.url }));
        return;
      }

      const authenticationError = authenticateInternalApiRequest(request, apiSecret);
      if (authenticationError) {
        writeJson(response, 401, authenticationError);
        return;
      }

      if (activeRequests >= maxConcurrentRequests) {
        writeJson(response, 429, memoryTransportError("MEMORY_TOO_MANY_REQUESTS", "Memory API has too many in-flight requests."));
        return;
      }
      activeRequests += 1;
      admitted = true;

      const route = routeByPath.get(pathname);
      if (!route) {
        writeJson(response, 404, memoryTransportError("MEMORY_ROUTE_NOT_FOUND", "Memory API route was not found."));
        return;
      }
      if (request.method !== "POST") {
        writeJson(response, 405, memoryTransportError("MEMORY_METHOD_NOT_ALLOWED", "Memory API route does not support this method."));
        return;
      }
      if (!acceptsJsonRequest(request)) {
        writeJson(response, 415, memoryTransportError("MEMORY_UNSUPPORTED_MEDIA_TYPE", "Memory API POST requests must use application/json."));
        return;
      }

      const bindingReference = readBindingReference(request);
      const principal = bindingReference
        ? await options.resolvePrincipal({ request, bindingReference })
        : createLocalUserMemoryPrincipal();
      const body = await readJsonBody(request, maxBodyBytes);
      const result = routeServiceRequest(options.service, principal, route, body);
      writeJson(response, statusForMemoryResponse(result), result);
    } catch (error) {
      if (isMemoryErrorResponse(error)) {
        writeJson(response, statusForMemoryResponse(error), error);
        return;
      }
      writeJson(response, 500, memoryTransportError("MEMORY_INTERNAL_ERROR", "Memory API request failed."));
    } finally {
      if (admitted) {
        activeRequests -= 1;
      }
    }
  });

  server.requestTimeout = requestTimeoutMs;
  server.timeout = requestTimeoutMs;

  return {
    async start(): Promise<void> {
      if (server.listening) {
        return;
      }
      if (!isLoopbackListenHost(host)) {
        throw new Error("Memory API host must be loopback.");
      }
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          resolve();
        });
      });
    },
    async stop(): Promise<void> {
      if (!server.listening) {
        return;
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
    address(): AddressInfo | null {
      const address = server.address();
      return typeof address === "string" ? null : address;
    },
  };
}
