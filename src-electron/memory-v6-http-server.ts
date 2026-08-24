import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { createMemoryErrorResponse, type MemoryErrorResponse } from "../src/memory-v6/memory-response-contract.js";
import type { MemoryV6Service } from "./memory-v6-service.js";
import type { MemoryV6Principal } from "./memory-v6-permission.js";
import {
  LOCAL_USER_MEMORY_PERMISSIONS,
  createLocalUserMemoryPrincipal,
} from "./memory-v6-permission.js";
import type {
  AgentRuntimeBindingRegistry,
  ResolvedAgentRuntimeBinding,
} from "./agent-runtime-binding.js";
import {
  WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE_HEADER,
  type AgentRuntimeBindingPolicy,
} from "../src/agent-runtime/agent-runtime-binding-contract.js";
import {
  createCharacterContextError,
  isCharacterContextError,
} from "../src/character-context/character-context-contract.js";
import type {
  CharacterContextApplicationService,
  CharacterContextTransport,
} from "./character-context-application-service.js";
import {
  createWithMateMemoryRuntimeChallenge,
  WITHMATE_AGENT_RUNTIME_EXTENSION_EXCHANGE_PATH,
  WITHMATE_AGENT_RUNTIME_EXTENSION_MAX_BODY_BYTES,
  WITHMATE_MEMORY_RUNTIME_CHALLENGE_HEADER,
  WITHMATE_MEMORY_RUNTIME_EXCHANGE_PATH,
  WITHMATE_MEMORY_RUNTIME_EXCHANGE_SCHEMA_VERSION,
  WITHMATE_MEMORY_RUNTIME_INSTANCE_HEADER,
  WITHMATE_MEMORY_RUNTIME_NONCE_HEADER,
} from "../src/memory-v6/memory-runtime-exchange.js";

export type MemoryV6HttpServerOptions = {
  service: MemoryV6Service;
  characterContextService?: CharacterContextApplicationService;
  apiSecret: string;
  operatorApiSecret: string;
  mcpApiSecret: string;
  runtimeInstanceId: string;
  host?: string;
  port?: number;
  maxBodyBytes?: number;
  requestTimeoutMs?: number;
  fileOperationRequestTimeoutMs?: number;
  maxConcurrentRequests?: number;
  agentRuntimeBindingRegistry?: Pick<AgentRuntimeBindingRegistry, "resolve">;
  resolveActorSession?: (
    sessionId: string,
  ) => Promise<AgentRuntimeActorSession | null> | AgentRuntimeActorSession | null;
  routeAgentRuntimeExtension?: (
    request: AgentRuntimeExtensionRequest,
  ) => Promise<AgentRuntimeExtensionResponse | null> | AgentRuntimeExtensionResponse | null;
};

export type AgentRuntimeActorSession = {
  id: string;
  providerId: string;
  characterId: string;
  workspacePath?: string;
};

export type AgentRuntimeExtensionRequest = {
  method: "GET" | "POST";
  path: string;
  body: unknown;
  transport: CharacterContextTransport;
  bindingReference?: string;
  fallbackFrom?: "mcp";
};

export type AgentRuntimeExtensionResponse = {
  status: number;
  value: unknown;
};

export type MemoryV6HttpServer = {
  start(): Promise<void>;
  stop(): Promise<void>;
  address(): AddressInfo | null;
};

export type MemoryV6Route =
  | "characters"
  | "file_usage"
  | "list_targets"
  | "list_entries"
  | "audit"
  | "search"
  | "get_entry"
  | "get_file"
  | "export_files"
  | "list_tags"
  | "append"
  | "forget"
  | "move_entry"
  | "character_context_get"
  | "character_affect_appraise"
  | "character_affect_inspect"
  | "character_affect_correct"
  | "character_affect_reset"
  | "character_memory_search"
  | "character_memory_append_episode"
  | "character_memory_correct"
  | "character_memory_forget"
  | "character_context_metrics";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 0;
const DEFAULT_MAX_BODY_BYTES = 256 * 1024;
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
export const DEFAULT_FILE_OPERATION_REQUEST_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_CONCURRENT_REQUESTS = 8;
export const WITHMATE_MEMORY_API_SECRET_HEADER = "x-withmate-memory-api-secret";
export const WITHMATE_MEMORY_OPERATOR_API_SECRET_HEADER = "x-withmate-memory-operator-api-secret";
export const WITHMATE_MEMORY_MCP_API_SECRET_HEADER = "x-withmate-memory-mcp-api-secret";
const STATUS_CHALLENGE_NONCE_QUERY = "nonce";

const fileOperationRoutes = new Set<MemoryV6Route>([
  "append",
  "get_file",
  "export_files",
]);

const routeByPath = new Map<string, MemoryV6Route>([
  ["/v1/characters", "characters"],
  ["/v1/file_usage", "file_usage"],
  ["/v1/file-usage", "file_usage"],
  ["/v1/list_targets", "list_targets"],
  ["/v1/list-targets", "list_targets"],
  ["/v1/list_entries", "list_entries"],
  ["/v1/list-entries", "list_entries"],
  ["/v1/audit", "audit"],
  ["/v1/search", "search"],
  ["/v1/get_entry", "get_entry"],
  ["/v1/get_file", "get_file"],
  ["/v1/get-file", "get_file"],
  ["/v1/export_files", "export_files"],
  ["/v1/export-files", "export_files"],
  ["/v1/list_tags", "list_tags"],
  ["/v1/append", "append"],
  ["/v1/forget", "forget"],
  ["/v1/move_entry", "move_entry"],
  ["/v1/move-entry", "move_entry"],
  ["/v1/character_context/get", "character_context_get"],
  ["/v1/character_affect/appraise", "character_affect_appraise"],
  ["/v1/character_affect/inspect", "character_affect_inspect"],
  ["/v1/character_affect/correct", "character_affect_correct"],
  ["/v1/character_affect/reset", "character_affect_reset"],
  ["/v1/character_memory/search", "character_memory_search"],
  ["/v1/character_memory/append_episode", "character_memory_append_episode"],
  ["/v1/character_memory/correct", "character_memory_correct"],
  ["/v1/character_memory/forget", "character_memory_forget"],
  ["/v1/character_context/metrics", "character_context_metrics"],
]);

export const MEMORY_V6_ROUTE_BINDING_POLICIES: Readonly<Record<MemoryV6Route, AgentRuntimeBindingPolicy>> = {
  characters: "none",
  file_usage: "optional",
  list_targets: "optional",
  list_entries: "optional",
  audit: "none",
  search: "optional",
  get_entry: "optional",
  get_file: "optional",
  export_files: "optional",
  list_tags: "optional",
  append: "optional",
  forget: "optional",
  move_entry: "optional",
  character_context_get: "required",
  character_affect_appraise: "required",
  character_affect_inspect: "none",
  character_affect_correct: "none",
  character_affect_reset: "none",
  character_memory_search: "optional",
  character_memory_append_episode: "optional",
  character_memory_correct: "optional",
  character_memory_forget: "optional",
  character_context_metrics: "none",
};

export function agentRuntimeOperationForMemoryRoute(route: MemoryV6Route): string {
  return `memory.route.${route}`;
}

export function getMemoryV6AgentRuntimeOperations(): string[] {
  return (Object.keys(MEMORY_V6_ROUTE_BINDING_POLICIES) as MemoryV6Route[])
    .filter((route) => MEMORY_V6_ROUTE_BINDING_POLICIES[route] !== "none")
    .map(agentRuntimeOperationForMemoryRoute);
}

const mcpRoutes = new Set<MemoryV6Route>([
  "file_usage",
  "list_targets",
  "list_entries",
  "search",
  "get_entry",
  "get_file",
  "export_files",
  "list_tags",
  "append",
  "forget",
  "move_entry",
  "character_context_get",
  "character_affect_appraise",
  "character_memory_search",
  "character_memory_append_episode",
  "character_memory_correct",
  "character_memory_forget",
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

function buildFileUsageRequestOptions(requestUrl: string | undefined): { includeLargestEntries?: boolean; largestLimit?: number } {
  const url = new URL(requestUrl ?? "/", "http://127.0.0.1");
  const largest = url.searchParams.get("largest")?.trim().toLowerCase();
  const includeLargestEntries = largest === "1" || largest === "true" || largest === "yes";
  const limitText = url.searchParams.get("limit")?.trim();
  const largestLimit = limitText ? Number(limitText) : undefined;
  return {
    ...(includeLargestEntries ? { includeLargestEntries: true } : {}),
    ...(largestLimit === undefined ? {} : { largestLimit }),
  };
}

async function routeServiceRequest(service: MemoryV6Service, principal: MemoryV6Principal | null, route: MemoryV6Route, body: unknown): Promise<unknown> {
  if (route === "characters") {
    return service.listCharacters(principal);
  }
  if (route === "file_usage") {
    return service.fileUsage(principal, typeof body === "object" && body !== null ? body as { includeLargestEntries?: boolean; largestLimit?: number } : {});
  }
  if (route === "list_targets") {
    return service.listTargets(principal, body);
  }
  if (route === "list_entries") {
    return service.listEntries(principal, body);
  }
  if (route === "audit") {
    return service.audit(principal, body);
  }
  if (route === "search") {
    return service.search(principal, body);
  }
  if (route === "get_entry") {
    return service.getEntry(principal, body);
  }
  if (route === "get_file") {
    return service.getFile(principal, body);
  }
  if (route === "export_files") {
    return service.exportFiles(principal, body);
  }
  if (route === "list_tags") {
    return service.listTags(principal, body);
  }
  if (route === "append") {
    return service.append(principal, body);
  }
  if (route === "forget") {
    return service.forget(principal, body);
  }
  return service.moveEntry(principal, body);
}

function resolveCharacterContextTransport(
  request: IncomingMessage,
  operatorApiSecret: string,
  mcpApiSecret: string,
): CharacterContextTransport | null {
  const operatorHeader = request.headers[WITHMATE_MEMORY_OPERATOR_API_SECRET_HEADER];
  if (typeof operatorHeader === "string" && timingSafeStringEqual(operatorHeader, operatorApiSecret)) {
    return "cli";
  }
  const mcpHeader = request.headers[WITHMATE_MEMORY_MCP_API_SECRET_HEADER];
  if (typeof mcpHeader === "string" && timingSafeStringEqual(mcpHeader, mcpApiSecret)) {
    return "mcp";
  }
  return null;
}

function canTransportInvokeRoute(transport: CharacterContextTransport, route: MemoryV6Route): boolean {
  return transport === "cli" || mcpRoutes.has(route);
}

function createTransportAuthorityError(route: MemoryV6Route): unknown {
  return route.startsWith("character_")
    ? createCharacterContextError(
        "authority_denied",
        "Character context request is not authorized for this adapter transport.",
        { retryable: false, conversationMayContinue: true, effect: "none" },
      )
    : memoryTransportError("MEMORY_FORBIDDEN", "Memory API route is not authorized for this adapter transport.");
}

async function routeCharacterContextRequest(
  service: CharacterContextApplicationService | undefined,
  principal: MemoryV6Principal,
  route: MemoryV6Route,
  body: unknown,
  transport: CharacterContextTransport,
): Promise<unknown> {
  if (!service) {
    return memoryTransportError("MEMORY_ROUTE_NOT_FOUND", "Character context service is unavailable.");
  }
  if (route === "character_context_get") {
    return service.getContext(body, transport);
  }
  if (
    transport === "mcp"
    && principal.type !== "session_binding"
    && (route === "character_memory_correct" || route === "character_memory_forget")
  ) {
    return createCharacterContextError(
      "authority_denied",
      "This operation requires a WithMate Session runtime binding.",
      { retryable: false, conversationMayContinue: true, effect: "none" },
    );
  }
  const authorizedBody = resolveTransportAuthority(body, route, transport);
  if (route === "character_affect_appraise") {
    return service.appraise(authorizedBody, transport);
  }
  if (route === "character_affect_inspect") {
    return service.inspectAffect(authorizedBody, transport);
  }
  if (route === "character_affect_correct") {
    return service.correctAffect(authorizedBody, transport);
  }
  if (route === "character_affect_reset") {
    return service.resetAffect(authorizedBody, transport);
  }
  if (route === "character_memory_search") {
    return service.searchMemory(body, transport, principal);
  }
  if (route === "character_memory_append_episode") {
    return service.appendEpisode(authorizedBody, transport, principal);
  }
  if (route === "character_memory_correct") {
    return service.correctMemory(authorizedBody, transport, principal);
  }
  if (route === "character_memory_forget") {
    return service.forgetMemory(authorizedBody, transport, principal);
  }
  return {
    schemaVersion: "withmate-character-context-v1",
    metrics: service.getMetrics(),
  };
}

function resolveTransportAuthority(
  body: unknown,
  route: MemoryV6Route,
  transport: CharacterContextTransport,
): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return body;
  }
  const authority = transport === "cli"
    ? { kind: "operator", reason: "Authenticated local CLI operation." }
    : { kind: "conversation" };
  return { ...(body as Record<string, unknown>), authority };
}

function statusForMemoryResponse(value: unknown): number {
  if (isCharacterContextError(value)) {
    switch (value.error.code) {
      case "authority_denied":
        return 403;
      case "unknown_character":
      case "unknown_scope":
        return 404;
      case "version_conflict":
        return 409;
      case "storage_unavailable":
      case "migration_required":
      case "partial_failure":
      case "internal_error":
        return 503;
      default:
        return 422;
    }
  }
  if (!isMemoryErrorResponse(value)) {
    return 200;
  }

  switch (value.error.code) {
    case "MEMORY_PRINCIPAL_REQUIRED":
    case "MEMORY_UNAUTHORIZED":
      return 401;
    case "MEMORY_FORBIDDEN":
      return 403;
    case "MEMORY_ENTRY_NOT_FOUND":
    case "MEMORY_FILE_NOT_FOUND":
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

type RuntimeExchangePayload = {
  schemaVersion: typeof WITHMATE_MEMORY_RUNTIME_EXCHANGE_SCHEMA_VERSION;
  apiSecret: string;
  adapter: CharacterContextTransport;
  adapterSecret: string;
  bindingReference?: string;
  operation: {
    method: "GET" | "POST";
    path: string;
    body: unknown;
    fallbackFrom?: "mcp";
  };
};

function parseRuntimeExchangePayload(value: unknown): RuntimeExchangePayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const payload = value as Partial<RuntimeExchangePayload>;
  const operation = payload.operation;
  if (
    payload.schemaVersion !== WITHMATE_MEMORY_RUNTIME_EXCHANGE_SCHEMA_VERSION
    || typeof payload.apiSecret !== "string"
    || (payload.adapter !== "cli" && payload.adapter !== "mcp")
    || typeof payload.adapterSecret !== "string"
    || (payload.bindingReference !== undefined && typeof payload.bindingReference !== "string")
    || !operation
    || (operation.method !== "GET" && operation.method !== "POST")
    || typeof operation.path !== "string"
  ) {
    return null;
  }
  return payload as RuntimeExchangePayload;
}

function authenticateRuntimeExchange(
  payload: RuntimeExchangePayload,
  apiSecret: string,
  operatorApiSecret: string,
  mcpApiSecret: string,
): boolean {
  if (!timingSafeStringEqual(payload.apiSecret, apiSecret)) {
    return false;
  }
  const expectedAdapterSecret = payload.adapter === "cli" ? operatorApiSecret : mcpApiSecret;
  return timingSafeStringEqual(payload.adapterSecret, expectedAdapterSecret);
}

async function routeResolvedRequest(input: {
  options: MemoryV6HttpServerOptions;
  route: MemoryV6Route;
  body: unknown;
  transport: CharacterContextTransport | null;
  fallbackFrom?: "mcp";
  bindingReference?: string;
}): Promise<unknown> {
  if (!input.transport || !canTransportInvokeRoute(input.transport, input.route)) {
    return createTransportAuthorityError(input.route);
  }
  if (input.fallbackFrom === "mcp" && input.transport === "cli") {
    input.options.characterContextService?.recordFallback("mcp", "cli");
  }
  const bindingResolution = await resolveRouteAgentRuntimeBinding({
    options: input.options,
    route: input.route,
    body: input.body,
    bindingReference: input.bindingReference,
  });
  if (!bindingResolution.ok) {
    return bindingResolution.error;
  }
  const mcpGeneralPolicyError = validateMcpGeneralMutationPolicy(input.route, bindingResolution.body, input.transport);
  if (mcpGeneralPolicyError) {
    return mcpGeneralPolicyError;
  }
  return input.route.startsWith("character_")
    ? routeCharacterContextRequest(
        input.options.characterContextService,
        bindingResolution.principal ?? createLocalUserMemoryPrincipal(),
        input.route,
        bindingResolution.body,
        input.transport,
      )
    : routeServiceRequest(
        input.options.service,
        bindingResolution.principal ?? createLocalUserMemoryPrincipal(),
        input.route,
        bindingResolution.body,
      );
}

type RouteBindingResolution =
  | { ok: true; body: unknown; principal: MemoryV6Principal | null }
  | { ok: false; error: unknown };

function bindingFailure(
  route: MemoryV6Route,
  code: "SESSION_BINDING_REQUIRED" | "SESSION_BINDING_INVALID" | "SESSION_BINDING_FORBIDDEN",
): unknown {
  if (route.startsWith("character_")) {
    return createCharacterContextError(
      "authority_denied",
      code === "SESSION_BINDING_REQUIRED"
        ? "This operation requires a WithMate Session runtime binding."
        : "The WithMate Session runtime binding is not authorized for this operation.",
      {
        retryable: false,
        conversationMayContinue: true,
        effect: "none",
        details: { bindingFailure: code },
      },
    );
  }
  return createMemoryErrorResponse({
    code: code === "SESSION_BINDING_REQUIRED" ? "MEMORY_PRINCIPAL_REQUIRED" : "MEMORY_FORBIDDEN",
    message: "The Memory request does not have an authorized WithMate Session runtime binding.",
    retryable: false,
    conversationMayContinue: true,
    effect: "none",
  });
}

function hasDifferentCharacterTarget(body: unknown, characterId: string): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return false;
  }
  const request = body as Record<string, unknown>;
  if (typeof request.characterId === "string" && request.characterId.trim() !== characterId) {
    return true;
  }
  return Array.isArray(request.candidates) && request.candidates.some((candidate) => (
    Boolean(candidate)
    && typeof candidate === "object"
    && !Array.isArray(candidate)
    && typeof (candidate as { characterId?: unknown }).characterId === "string"
    && (candidate as { characterId: string }).characterId.trim() !== characterId
  ));
}

function applyActorSessionToBody(
  route: MemoryV6Route,
  body: unknown,
  actorSession: AgentRuntimeActorSession,
): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return body;
  }
  const request = body as Record<string, unknown>;
  if (route === "character_affect_appraise") {
    return {
      ...request,
      sessionId: actorSession.id,
      candidates: Array.isArray(request.candidates)
        ? request.candidates.map((candidate) => (
            candidate && typeof candidate === "object" && !Array.isArray(candidate)
              ? {
                  ...(candidate as Record<string, unknown>),
                  characterId: actorSession.characterId,
                  sessionId: actorSession.id,
                }
              : candidate
          ))
        : request.candidates,
    };
  }
  if (route === "character_context_get" || route === "character_memory_append_episode") {
    return { ...request, sessionId: actorSession.id };
  }
  return body;
}

async function resolveRouteAgentRuntimeBinding(input: {
  options: MemoryV6HttpServerOptions;
  route: MemoryV6Route;
  body: unknown;
  bindingReference?: string;
}): Promise<RouteBindingResolution> {
  const policy = MEMORY_V6_ROUTE_BINDING_POLICIES[input.route];
  if (policy === "none") {
    if (input.bindingReference !== undefined) {
      return { ok: false, error: bindingFailure(input.route, "SESSION_BINDING_FORBIDDEN") };
    }
    return { ok: true, body: input.body, principal: null };
  }
  const bindingWasPresented = input.bindingReference !== undefined;
  const reference = input.bindingReference?.trim();
  if (!bindingWasPresented) {
    return policy === "optional"
      ? { ok: true, body: input.body, principal: null }
      : { ok: false, error: bindingFailure(input.route, "SESSION_BINDING_REQUIRED") };
  }
  if (!reference) {
    return { ok: false, error: bindingFailure(input.route, "SESSION_BINDING_INVALID") };
  }
  const resolved = input.options.agentRuntimeBindingRegistry?.resolve(
    reference,
    agentRuntimeOperationForMemoryRoute(input.route),
  );
  if (!resolved?.ok) {
    return {
      ok: false,
      error: bindingFailure(input.route, resolved?.code ?? "SESSION_BINDING_REQUIRED"),
    };
  }
  const actorSession = await input.options.resolveActorSession?.(resolved.binding.actorSessionId) ?? null;
  if (
    !actorSession
    || actorSession.id !== resolved.binding.actorSessionId
    || actorSession.providerId !== resolved.binding.providerId
  ) {
    return { ok: false, error: bindingFailure(input.route, "SESSION_BINDING_INVALID") };
  }
  if (
    (input.route === "character_context_get" || input.route === "character_affect_appraise")
    && hasDifferentCharacterTarget(input.body, actorSession.characterId)
  ) {
    return { ok: false, error: bindingFailure(input.route, "SESSION_BINDING_FORBIDDEN") };
  }
  const binding = resolved.binding;
  return {
    ok: true,
    body: applyActorSessionToBody(input.route, input.body, actorSession),
    principal: createSessionBindingMemoryPrincipal(binding, actorSession),
  };
}

function createSessionBindingMemoryPrincipal(
  binding: ResolvedAgentRuntimeBinding,
  actorSession: AgentRuntimeActorSession,
): MemoryV6Principal {
  return {
    type: "session_binding",
    bindingIdHash: binding.bindingIdHash,
    sessionId: binding.actorSessionId,
    providerId: binding.providerId,
    characterId: actorSession.characterId,
    permissions: LOCAL_USER_MEMORY_PERMISSIONS,
  };
}

function validateMcpGeneralMutationPolicy(
  route: MemoryV6Route,
  body: unknown,
  transport: CharacterContextTransport,
): MemoryErrorResponse | null {
  if (transport !== "mcp" || !body || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }
  const request = body as Record<string, unknown>;
  const requireText = (field: string): MemoryErrorResponse | null => (
    typeof request[field] === "string" && request[field].trim()
      ? null
      : createMemoryErrorResponse({
        code: "MEMORY_INVALID_FIELD",
        message: `${field} is required for MCP ${route}.`,
        field,
        retryable: false,
        conversationMayContinue: true,
        effect: "none",
      })
  );
  if (route === "append") {
    return requireText("idempotencyKey");
  }
  if (route === "move_entry") {
    return requireText("reason") ?? requireText("idempotencyKey");
  }
  if (route === "forget") {
    return requireText("reason") ?? requireText("idempotencyKey");
  }
  return null;
}

export function createMemoryV6HttpServer(options: MemoryV6HttpServerOptions): MemoryV6HttpServer {
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const apiSecret = requireNonEmptySecret(options.apiSecret, "apiSecret");
  const operatorApiSecret = requireNonEmptySecret(options.operatorApiSecret, "operatorApiSecret");
  const mcpApiSecret = requireNonEmptySecret(options.mcpApiSecret, "mcpApiSecret");
  const runtimeInstanceId = requireNonEmptySecret(options.runtimeInstanceId, "runtimeInstanceId");
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const fileOperationRequestTimeoutMs = options.fileOperationRequestTimeoutMs ?? DEFAULT_FILE_OPERATION_REQUEST_TIMEOUT_MS;
  const maxConcurrentRequests = options.maxConcurrentRequests ?? DEFAULT_MAX_CONCURRENT_REQUESTS;
  let activeRequests = 0;
  let activeAgentExtensionRequests = 0;

  const server = createServer(async (request, response) => {
    let admitted = false;
    let admittedAgentExtension = false;
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
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      const pathname = requestUrl.pathname;
      if (pathname === "/v1/status") {
        if (request.method !== "GET") {
          writeJson(response, 405, memoryTransportError("MEMORY_METHOD_NOT_ALLOWED", "Memory API route does not support this method."));
          return;
        }
        writeJson(response, 200, buildStatusResponse({ apiSecret, runtimeInstanceId, requestUrl: request.url }));
        return;
      }

      if (pathname === WITHMATE_MEMORY_RUNTIME_EXCHANGE_PATH) {
        if (request.method !== "POST" || !acceptsJsonRequest(request)) {
          writeJson(response, 405, memoryTransportError("MEMORY_METHOD_NOT_ALLOWED", "Memory runtime exchange requires JSON POST."));
          return;
        }
        const nonce = request.headers[WITHMATE_MEMORY_RUNTIME_NONCE_HEADER];
        const expectedRuntimeInstanceId = request.headers[WITHMATE_MEMORY_RUNTIME_INSTANCE_HEADER];
        if (
          typeof nonce !== "string"
          || typeof expectedRuntimeInstanceId !== "string"
          || expectedRuntimeInstanceId !== runtimeInstanceId
        ) {
          writeJson(response, 401, memoryTransportError("MEMORY_UNAUTHORIZED", "Memory runtime identity challenge is invalid."));
          return;
        }
        if (activeRequests >= maxConcurrentRequests) {
          writeJson(response, 429, memoryTransportError("MEMORY_TOO_MANY_REQUESTS", "Memory API has too many in-flight requests."));
          return;
        }
        activeRequests += 1;
        admitted = true;
        request.setTimeout(requestTimeoutMs);
        response.setTimeout(requestTimeoutMs);
        response.writeEarlyHints({
          link: "</v1/exchange>; rel=preconnect",
          [WITHMATE_MEMORY_RUNTIME_INSTANCE_HEADER]: runtimeInstanceId,
          [WITHMATE_MEMORY_RUNTIME_CHALLENGE_HEADER]: createWithMateMemoryRuntimeChallenge(
            apiSecret,
            runtimeInstanceId,
            nonce,
          ),
        });
        const payload = parseRuntimeExchangePayload(await readJsonBody(request, maxBodyBytes));
        if (!payload || !authenticateRuntimeExchange(payload, apiSecret, operatorApiSecret, mcpApiSecret)) {
          writeJson(response, 401, memoryTransportError("MEMORY_UNAUTHORIZED", "Memory runtime exchange is not authorized."));
          return;
        }
        const operationUrl = new URL(payload.operation.path, "http://127.0.0.1");
        if (operationUrl.pathname === "/v1/status" && payload.operation.method === "GET") {
          writeJson(response, 200, { ok: true, runtimeInstanceId });
          return;
        }
        const route = routeByPath.get(operationUrl.pathname);
        if (!route) {
          writeJson(response, 404, memoryTransportError("MEMORY_ROUTE_NOT_FOUND", "Memory API route was not found."));
          return;
        }
        if (!canTransportInvokeRoute(payload.adapter, route)) {
          const error = createTransportAuthorityError(route);
          writeJson(response, statusForMemoryResponse(error), error);
          return;
        }
        const routeTimeoutMs = resolveMemoryV6RouteTimeoutMs(route, {
          requestTimeoutMs,
          fileOperationRequestTimeoutMs,
        });
        request.setTimeout(routeTimeoutMs);
        response.setTimeout(routeTimeoutMs);
        const getOnlyRoute = route === "characters" || route === "file_usage" || route === "character_context_metrics";
        if ((getOnlyRoute && payload.operation.method !== "GET") || (!getOnlyRoute && payload.operation.method !== "POST")) {
          writeJson(response, 405, memoryTransportError("MEMORY_METHOD_NOT_ALLOWED", "Memory API route does not support this method."));
          return;
        }
        const body = route === "characters" || route === "character_context_metrics"
          ? {}
          : route === "file_usage"
            ? buildFileUsageRequestOptions(payload.operation.path)
            : payload.operation.body;
        const result = await routeResolvedRequest({
          options,
          route,
          body,
          transport: payload.adapter,
          bindingReference: payload.bindingReference,
          ...(payload.operation.fallbackFrom ? { fallbackFrom: payload.operation.fallbackFrom } : {}),
        });
        writeJson(response, statusForMemoryResponse(result), result);
        return;
      }

      if (pathname === WITHMATE_AGENT_RUNTIME_EXTENSION_EXCHANGE_PATH) {
        if (request.method !== "POST" || !acceptsJsonRequest(request)) {
          writeJson(response, 405, memoryTransportError("MEMORY_METHOD_NOT_ALLOWED", "Agent runtime extension exchange requires JSON POST."));
          return;
        }
        const nonce = request.headers[WITHMATE_MEMORY_RUNTIME_NONCE_HEADER];
        const expectedRuntimeInstanceId = request.headers[WITHMATE_MEMORY_RUNTIME_INSTANCE_HEADER];
        if (
          typeof nonce !== "string"
          || typeof expectedRuntimeInstanceId !== "string"
          || expectedRuntimeInstanceId !== runtimeInstanceId
        ) {
          writeJson(response, 401, memoryTransportError("MEMORY_UNAUTHORIZED", "Agent runtime identity challenge is invalid."));
          return;
        }
        if (activeAgentExtensionRequests >= 1) {
          writeJson(response, 429, memoryTransportError("MEMORY_TOO_MANY_REQUESTS", "Agent runtime extension exchange has an in-flight request."));
          return;
        }
        activeAgentExtensionRequests += 1;
        admittedAgentExtension = true;
        request.setTimeout(requestTimeoutMs);
        response.setTimeout(requestTimeoutMs);
        response.writeEarlyHints({
          link: `<${WITHMATE_AGENT_RUNTIME_EXTENSION_EXCHANGE_PATH}>; rel=preconnect`,
          [WITHMATE_MEMORY_RUNTIME_INSTANCE_HEADER]: runtimeInstanceId,
          [WITHMATE_MEMORY_RUNTIME_CHALLENGE_HEADER]: createWithMateMemoryRuntimeChallenge(
            apiSecret,
            runtimeInstanceId,
            nonce,
          ),
        });
        const payload = parseRuntimeExchangePayload(
          await readJsonBody(request, WITHMATE_AGENT_RUNTIME_EXTENSION_MAX_BODY_BYTES),
        );
        if (!payload || !authenticateRuntimeExchange(payload, apiSecret, operatorApiSecret, mcpApiSecret)) {
          writeJson(response, 401, memoryTransportError("MEMORY_UNAUTHORIZED", "Agent runtime extension exchange is not authorized."));
          return;
        }
        const extensionResponse = await options.routeAgentRuntimeExtension?.({
          method: payload.operation.method,
          path: payload.operation.path,
          body: payload.operation.body,
          transport: payload.adapter,
          bindingReference: payload.bindingReference,
          ...(payload.operation.fallbackFrom ? { fallbackFrom: payload.operation.fallbackFrom } : {}),
        }) ?? null;
        if (!extensionResponse) {
          writeJson(response, 404, memoryTransportError("MEMORY_ROUTE_NOT_FOUND", "Agent runtime extension route was not found."));
          return;
        }
        writeJson(response, extensionResponse.status, extensionResponse.value);
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
      const routeTimeoutMs = resolveMemoryV6RouteTimeoutMs(route, {
        requestTimeoutMs,
        fileOperationRequestTimeoutMs,
      });
      request.setTimeout(routeTimeoutMs);
      response.setTimeout(routeTimeoutMs);
      const getOnlyRoute = route === "characters" || route === "file_usage" || route === "character_context_metrics";
      if (getOnlyRoute && request.method !== "GET") {
        writeJson(response, 405, memoryTransportError("MEMORY_METHOD_NOT_ALLOWED", "Memory API route does not support this method."));
        return;
      }
      if (!getOnlyRoute && request.method !== "POST") {
        writeJson(response, 405, memoryTransportError("MEMORY_METHOD_NOT_ALLOWED", "Memory API route does not support this method."));
        return;
      }
      if (!getOnlyRoute && !acceptsJsonRequest(request)) {
        writeJson(response, 415, memoryTransportError("MEMORY_UNSUPPORTED_MEDIA_TYPE", "Memory API POST requests must use application/json."));
        return;
      }

      const transport = resolveCharacterContextTransport(request, operatorApiSecret, mcpApiSecret);
      if (!transport || !canTransportInvokeRoute(transport, route)) {
        const error = createTransportAuthorityError(route);
        writeJson(response, statusForMemoryResponse(error), error);
        return;
      }

      const body = route === "characters" || route === "character_context_metrics"
        ? {}
        : route === "file_usage"
          ? buildFileUsageRequestOptions(request.url)
          : await readJsonBody(request, maxBodyBytes);
      const result = await routeResolvedRequest({
        options,
        route,
        body,
        transport,
        bindingReference: typeof request.headers[WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE_HEADER] === "string"
          ? request.headers[WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE_HEADER]
          : undefined,
        ...(request.headers["x-withmate-fallback-from"] === "mcp" ? { fallbackFrom: "mcp" } : {}),
      });
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
      if (admittedAgentExtension) {
        activeAgentExtensionRequests -= 1;
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

export function resolveMemoryV6RouteTimeoutMs(
  route: MemoryV6Route,
  options: { requestTimeoutMs?: number; fileOperationRequestTimeoutMs?: number } = {},
): number {
  if (fileOperationRoutes.has(route)) {
    return options.fileOperationRequestTimeoutMs ?? DEFAULT_FILE_OPERATION_REQUEST_TIMEOUT_MS;
  }
  return options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
}
