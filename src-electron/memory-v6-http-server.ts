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
  type ProviderAgentRuntimeAuthoritySnapshot,
} from "../src/agent-runtime/agent-runtime-binding-contract.js";
import type {
  MemoryTargetSelector,
  ProjectTargetRef,
} from "../src/memory-v6/memory-contract.js";
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
  createWithMateMemoryRuntimeOwnerChallenge,
  WITHMATE_AGENT_RUNTIME_EXTENSION_EXCHANGE_PATH,
  WITHMATE_AGENT_RUNTIME_EXTENSION_MAX_BODY_BYTES,
  WITHMATE_MEMORY_RUNTIME_CHALLENGE_HEADER,
  WITHMATE_MEMORY_RUNTIME_APPLICATION_INSTANCE_HEADER,
  WITHMATE_MEMORY_RUNTIME_GENERATION_HEADER,
  WITHMATE_MEMORY_RUNTIME_EXCHANGE_PATH,
  WITHMATE_MEMORY_RUNTIME_EXCHANGE_SCHEMA_VERSION,
  WITHMATE_MEMORY_RUNTIME_INSTANCE_HEADER,
  WITHMATE_MEMORY_RUNTIME_NONCE_HEADER,
} from "../src/memory-v6/memory-runtime-exchange.js";
import type { MemoryV6ProjectContext } from "./memory-v6-context-resolver.js";
import type { ProviderAgentRuntimeTurnCoordinator } from "./provider-agent-runtime-turn-coordinator.js";

export type MemoryV6HttpServerOptions = {
  service: MemoryV6Service;
  characterContextService?: CharacterContextApplicationService;
  apiSecret: string;
  operatorApiSecret: string;
  mcpApiSecret: string;
  /** @deprecated use runtimeGenerationId; retained as a wire-compatibility alias. */
  runtimeInstanceId?: string;
  applicationInstanceId?: string;
  runtimeGenerationId?: string;
  buildChannel?: "installed" | "development" | "visual-check" | "unknown";
  host?: string;
  port?: number;
  maxBodyBytes?: number;
  requestTimeoutMs?: number;
  fileOperationRequestTimeoutMs?: number;
  maxConcurrentRequests?: number;
  agentRuntimeBindingRegistry?: Pick<AgentRuntimeBindingRegistry, "resolve">;
  providerAgentRuntimeTurns?: Pick<ProviderAgentRuntimeTurnCoordinator, "admit">;
  resolveProjectById?: (id: string) => MemoryV6ProjectContext | null;
  resolveProjectByPath?: (projectPath: string) => MemoryV6ProjectContext | null;
  resolveKnownProjectByPath?: (projectPath: string) => MemoryV6ProjectContext | null;
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
  turnCapability?: string;
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

function buildStatusResponse(input: {
  apiSecret: string;
  applicationInstanceId: string;
  runtimeGenerationId: string;
  buildChannel: "installed" | "development" | "visual-check" | "unknown";
  requestUrl: string | undefined;
}): unknown {
  const url = new URL(input.requestUrl ?? "/", "http://127.0.0.1");
  const nonce = url.searchParams.get(STATUS_CHALLENGE_NONCE_QUERY)?.trim() ?? "";
  return {
    ok: true,
    applicationInstanceId: input.applicationInstanceId,
    runtimeGenerationId: input.runtimeGenerationId,
    // Explicit legacy alias. It has the generation semantics, never the app identity.
    runtimeInstanceId: input.runtimeGenerationId,
    buildChannel: input.buildChannel,
    ...(nonce
      ? {
          challenge: {
            nonce,
            // Legacy challenge remains for 6.3.x clients.
            hmacSha256: createStatusChallenge(input.apiSecret, nonce),
            // New clients verify this before sending exchange credentials/body.
            ownerHmacSha256: createWithMateMemoryRuntimeOwnerChallenge(
              input.apiSecret,
              input.applicationInstanceId,
              input.runtimeGenerationId,
              nonce,
            ),
          },
        }
      : {}),
  };
}

type RuntimeExchangePayload = {
  schemaVersion: typeof WITHMATE_MEMORY_RUNTIME_EXCHANGE_SCHEMA_VERSION;
  apiSecret: string;
  adapter: CharacterContextTransport | "agent_cli_fallback";
  adapterSecret: string;
  bindingReference?: string;
  turnCapability?: string;
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
    || (payload.adapter !== "cli" && payload.adapter !== "mcp" && payload.adapter !== "agent_cli_fallback")
    || typeof payload.adapterSecret !== "string"
    || (payload.bindingReference !== undefined && typeof payload.bindingReference !== "string")
    || (payload.turnCapability !== undefined && typeof payload.turnCapability !== "string")
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

const AGENT_IDENTITY_FIELDS = new Set(["userId", "characterId", "sessionId", "owner", "scope"]);
const TURN_PROTECTED_ROUTES = new Set<MemoryV6Route>([
  "get_file", "export_files", "append", "forget", "move_entry",
  "character_affect_appraise", "character_memory_append_episode",
  "character_memory_correct", "character_memory_forget",
]);

function resolveProviderAgentRuntimeAuthority(
  binding: ResolvedAgentRuntimeBinding,
  actorSession: AgentRuntimeActorSession,
): ProviderAgentRuntimeAuthoritySnapshot | null {
  if (!binding.authoritySnapshot || typeof binding.authoritySnapshot !== "object") {
    return null;
  }
  const snapshot = binding.authoritySnapshot as Partial<ProviderAgentRuntimeAuthoritySnapshot>;
  if (
    snapshot.userId !== "local-user"
    || typeof snapshot.characterId !== "string"
    || snapshot.characterId.trim() !== actorSession.characterId
    || !Array.isArray(snapshot.allowedProjectIds)
    || snapshot.allowedProjectIds.some((id) => typeof id !== "string" || !id.trim())
  ) {
    return null;
  }
  return {
    userId: "local-user",
    characterId: snapshot.characterId.trim(),
    allowedProjectIds: [...new Set(snapshot.allowedProjectIds.map((id) => id.trim()))].sort(),
  };
}

function findCallerIdentityField(value: unknown, allowScope = false): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findCallerIdentityField(item, allowScope);
      if (found) return found;
    }
    return null;
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (AGENT_IDENTITY_FIELDS.has(key) && !(allowScope && key === "scope")) return key;
    const found = findCallerIdentityField(item, allowScope);
    if (found) return found;
  }
  return null;
}

function agentInputError(route: MemoryV6Route, field: string, message: string): unknown {
  return route.startsWith("character_")
    ? createCharacterContextError("invalid_input", message, {
        field, retryable: false, conversationMayContinue: true, effect: "none",
      })
    : createMemoryErrorResponse({
        code: "MEMORY_INVALID_FIELD", message, field,
        retryable: false, conversationMayContinue: true, effect: "none",
      });
}

function requiresCurrentTurnCapability(route: MemoryV6Route, body: unknown): boolean {
  if (route === "forget" && body && typeof body === "object" && !Array.isArray(body)) {
    return (body as { dryRun?: unknown }).dryRun !== true;
  }
  return TURN_PROTECTED_ROUTES.has(route);
}

function turnAdmissionFailure(route: MemoryV6Route): unknown {
  return route.startsWith("character_")
    ? createCharacterContextError("authority_denied", "This operation requires the current provider turn capability.", {
        retryable: false, conversationMayContinue: true, effect: "none",
      })
    : createMemoryErrorResponse({
        code: "MEMORY_FORBIDDEN",
        message: "This operation requires the current provider turn capability.",
        retryable: false, conversationMayContinue: true, effect: "none",
      });
}

function resolveAllowedProject(
  options: MemoryV6HttpServerOptions,
  ref: unknown,
  authority: ProviderAgentRuntimeAuthoritySnapshot,
): MemoryV6ProjectContext | null {
  if (!ref || typeof ref !== "object" || Array.isArray(ref)) return null;
  const value = ref as Partial<ProjectTargetRef>;
  const project = value.type === "id" && typeof value.id === "string"
    ? options.resolveProjectById?.(value.id.trim()) ?? (
        authority.allowedProjectIds.includes(value.id.trim())
          ? { id: value.id.trim(), displayName: value.id.trim() }
          : null
      )
    : value.type === "path" && typeof value.path === "string"
      ? options.resolveProjectByPath?.(value.path) ?? options.resolveKnownProjectByPath?.(value.path) ?? null
      : null;
  return project && authority.allowedProjectIds.includes(project.id) ? project : null;
}

function resolveActorRelativeTarget(
  options: MemoryV6HttpServerOptions,
  value: unknown,
  authority: ProviderAgentRuntimeAuthoritySnapshot,
): MemoryTargetSelector | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const target = value as Record<string, unknown>;
  if (target.kind === "user-global" && Object.keys(target).length === 1) {
    return { owner: "user", scope: "global" };
  }
  if (target.kind === "character" && Object.keys(target).length === 1) {
    return { owner: "character", scope: "character", character: { type: "id", id: authority.characterId } };
  }
  if ((target.kind === "project" || target.kind === "character+project") && Object.keys(target).length === 2) {
    const project = resolveAllowedProject(options, target.project, authority);
    if (!project) return null;
    const requestedRef = target.project as ProjectTargetRef;
    const projectRef: ProjectTargetRef = requestedRef.type === "path" && !options.resolveProjectById?.(project.id)
      ? requestedRef
      : { type: "id", id: project.id };
    return target.kind === "project"
      ? { owner: "project", scope: "project", project: projectRef }
      : {
          owner: "character", scope: "project",
          character: { type: "id", id: authority.characterId },
          project: projectRef,
        };
  }
  return null;
}

type AgentBodyResult = { ok: true; value: unknown } | { ok: false; error: unknown };

function resolveAgentBoundRequestBody(
  options: MemoryV6HttpServerOptions,
  route: MemoryV6Route,
  body: unknown,
  actorSession: AgentRuntimeActorSession,
  authority: ProviderAgentRuntimeAuthoritySnapshot,
): AgentBodyResult {
  if (route.startsWith("character_")) {
    if (route === "character_memory_search") {
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return { ok: false, error: agentInputError(route, "body", "Character Memory request body must be an object.") };
      }
      const request = body as Record<string, unknown>;
      const scope = request.scope;
      if (!scope || typeof scope !== "object" || Array.isArray(scope)) {
        return { ok: false, error: agentInputError(route, "scope", "Character Memory scope is invalid or not authorized.") };
      }
      const actorScope = scope as Record<string, unknown>;
      if (actorScope.scope === "character" && Object.keys(actorScope).length === 1) {
        return { ok: true, value: applyActorSessionToBody(route, body, actorSession, authority) };
      }
      if (actorScope.scope === "project" && Object.keys(actorScope).length === 2) {
        const project = resolveAllowedProject(options, actorScope.project, authority);
        if (project) {
          const requestedRef = actorScope.project as ProjectTargetRef;
          const projectRef: ProjectTargetRef = requestedRef.type === "path" && !options.resolveProjectById?.(project.id)
            ? requestedRef
            : { type: "id", id: project.id };
          return {
            ok: true,
            value: applyActorSessionToBody(route, {
              ...request,
              scope: { scope: "project", project: projectRef },
            }, actorSession, authority),
          };
        }
      }
      return { ok: false, error: agentInputError(route, "scope", "Character Memory scope is invalid or not authorized.") };
    }
    return { ok: true, value: applyActorSessionToBody(route, body, actorSession, authority) };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: agentInputError(route, "body", "Memory request body must be an object.") };
  }
  const request = { ...(body as Record<string, unknown>) };
  if (route === "file_usage") {
    return { ok: true, value: request };
  }
  if (route === "list_targets") {
    const filter = request.filter;
    delete request.filter;
    if (filter !== undefined) {
      if (!filter || typeof filter !== "object" || Array.isArray(filter)) {
        return { ok: false, error: agentInputError(route, "filter", "Memory target filter is invalid or not authorized.") };
      }
      const actorFilter = filter as Record<string, unknown>;
      if (actorFilter.kind === "project" && actorFilter.project === undefined && Object.keys(actorFilter).length === 1) {
        Object.assign(request, { owner: "project", scope: "project" });
      } else if (actorFilter.kind === "character+project" && actorFilter.project === undefined && Object.keys(actorFilter).length === 1) {
        Object.assign(request, {
          owner: "character",
          scope: "project",
          character: { type: "id", id: authority.characterId },
        });
      } else {
        const resolved = resolveActorRelativeTarget(options, filter, authority);
        if (!resolved) return { ok: false, error: agentInputError(route, "filter", "Memory target filter is invalid or not authorized.") };
        Object.assign(request, resolved);
      }
    }
    return { ok: true, value: request };
  }
  if (Array.isArray(request.targets)) {
    const targets = request.targets.map((target) => resolveActorRelativeTarget(options, target, authority));
    if (targets.some((target) => target === null)) {
      return { ok: false, error: agentInputError(route, "targets", "A Memory target is invalid or not authorized.") };
    }
    request.targets = targets;
    return { ok: true, value: request };
  }
  if (route === "move_entry") {
    const from = resolveActorRelativeTarget(options, request.from, authority);
    const to = resolveActorRelativeTarget(options, request.to, authority);
    if (!from || !to) {
      return { ok: false, error: agentInputError(route, !from ? "from" : "to", "A Memory target is invalid or not authorized.") };
    }
    request.from = from;
    request.to = to;
    return { ok: true, value: request };
  }
  const target = resolveActorRelativeTarget(options, request.target, authority);
  if (!target) return { ok: false, error: agentInputError(route, "target", "Memory target is invalid or not authorized.") };
  request.target = target;
  return { ok: true, value: request };
}

function projectAgentBoundResponse(
  route: MemoryV6Route,
  requestBody: unknown,
  result: unknown,
  authority: ProviderAgentRuntimeAuthoritySnapshot,
): unknown {
  if (isMemoryErrorResponse(result) || isCharacterContextError(result) || route.startsWith("character_")) {
    return result;
  }
  const targetForSelector = (value: unknown): Record<string, unknown> | null => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const selector = value as Record<string, unknown>;
    if (selector.owner === "user" && selector.scope === "global") return { kind: "user-global" };
    if (selector.owner === "project" && selector.scope === "project") {
      const project = selector.project as { type?: unknown; id?: unknown } | undefined;
      return project?.type === "id" && typeof project.id === "string" && authority.allowedProjectIds.includes(project.id)
        ? { kind: "project", project: { type: "id", id: project.id } }
        : null;
    }
    if (selector.owner === "character" && selector.scope === "character") {
      const character = selector.character as { type?: unknown; id?: unknown } | undefined;
      return character?.type === "id" && character.id === authority.characterId ? { kind: "character" } : null;
    }
    if (selector.owner === "character" && selector.scope === "project") {
      const character = selector.character as { type?: unknown; id?: unknown } | undefined;
      const project = selector.project as { type?: unknown; id?: unknown } | undefined;
      return character?.type === "id" && character.id === authority.characterId
        && project?.type === "id" && typeof project.id === "string" && authority.allowedProjectIds.includes(project.id)
        ? { kind: "character+project", project: { type: "id", id: project.id } }
        : null;
    }
    return null;
  };
  const targetForResolvedRefs = (value: Record<string, unknown>): Record<string, unknown> | null => {
    const owner = value.owner as { type?: unknown; id?: unknown } | undefined;
    const scope = value.scope as { type?: unknown; id?: unknown } | undefined;
    if (owner?.type === "user" && owner.id === authority.userId && scope?.type === "global") {
      return { kind: "user-global" };
    }
    if (owner?.type === "project" && scope?.type === "project" && owner.id === scope.id
      && typeof owner.id === "string" && authority.allowedProjectIds.includes(owner.id)) {
      return { kind: "project", project: { type: "id", id: owner.id } };
    }
    if (owner?.type === "character" && owner.id === authority.characterId && scope?.type === "character") {
      return { kind: "character" };
    }
    if (owner?.type === "character" && owner.id === authority.characterId && scope?.type === "project"
      && typeof scope.id === "string" && authority.allowedProjectIds.includes(scope.id)) {
      return { kind: "character+project", project: { type: "id", id: scope.id } };
    }
    return null;
  };
  const projectionFailure = Symbol("projectionFailure");
  const projectValue = (value: unknown, depth = 0): unknown | typeof projectionFailure => {
    if (Array.isArray(value)) {
      const items = value.map((item) => projectValue(item, depth + 1));
      if (route === "list_targets" && depth === 1) {
        return items.filter((item) => item !== projectionFailure);
      }
      return items.some((item) => item === projectionFailure) ? projectionFailure : items;
    }
    if (!value || typeof value !== "object") return value;
    const source = value as Record<string, unknown>;
    const projected: Record<string, unknown> = {};
    const resolvedTarget = targetForResolvedRefs(source);
    const hasResolvedTargetRefs = (
      source.owner !== null
      && typeof source.owner === "object"
      && !Array.isArray(source.owner)
      && "type" in source.owner
    ) || (
      source.scope !== null
      && typeof source.scope === "object"
      && !Array.isArray(source.scope)
      && "type" in source.scope
    );
    if (hasResolvedTargetRefs && !resolvedTarget) return projectionFailure;
    const selectorTarget = source.target === undefined ? null : targetForSelector(source.target);
    if (source.target !== undefined && !selectorTarget) return projectionFailure;
    if (resolvedTarget) {
      projected.target = resolvedTarget;
    }
    for (const [key, item] of Object.entries(source)) {
      if ((resolvedTarget || selectorTarget) && (key === "owner" || key === "scope")) continue;
      if (key === "target" || key === "from" || key === "to") {
        const target = targetForSelector(item);
        if (!target) return projectionFailure;
        projected[key] = target;
        continue;
      }
      if ((resolvedTarget || selectorTarget) && (key === "project" || key === "character")) continue;
      const nested = projectValue(item, depth + 1);
      if (nested === projectionFailure) return projectionFailure;
      projected[key] = nested;
    }
    return projected;
  };
  const projected = projectValue(result);
  return projected !== projectionFailure ? projected : createMemoryErrorResponse({
    code: "MEMORY_FORBIDDEN",
    message: "Memory response target is outside the bound actor authority.",
    retryable: false,
    conversationMayContinue: true,
    effect: requiresCurrentTurnCapability(route, requestBody) ? "unknown" : "none",
  });
}

async function routeResolvedRequest(input: {
  options: MemoryV6HttpServerOptions;
  route: MemoryV6Route;
  body: unknown;
  transport: CharacterContextTransport | null;
  fallbackFrom?: "mcp";
  bindingReference?: string;
  turnCapability?: string;
}): Promise<unknown> {
  if (!input.transport || !canTransportInvokeRoute(input.transport, input.route)) {
    return createTransportAuthorityError(input.route);
  }
  if (input.fallbackFrom === "mcp" && input.transport === "cli") {
    return createTransportAuthorityError(input.route);
  }
  if (input.fallbackFrom === "mcp") {
    input.options.characterContextService?.recordFallback("mcp", "cli");
  }
  const bindingResolution = await resolveRouteAgentRuntimeBinding({
    options: input.options,
    route: input.route,
    body: input.body,
    bindingReference: input.bindingReference,
    transport: input.transport,
    fallbackFrom: input.fallbackFrom,
    turnCapability: input.turnCapability,
  });
  if (!bindingResolution.ok) {
    return bindingResolution.error;
  }
  const mcpGeneralPolicyError = validateMcpGeneralMutationPolicy(input.route, bindingResolution.body, input.transport);
  if (mcpGeneralPolicyError) {
    return mcpGeneralPolicyError;
  }
  const result = await (input.route.startsWith("character_")
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
      ));
  return bindingResolution.authority
    ? projectAgentBoundResponse(input.route, bindingResolution.body, result, bindingResolution.authority)
    : result;
}

type RouteBindingResolution =
  | {
      ok: true;
      body: unknown;
      principal: MemoryV6Principal | null;
      authority: ProviderAgentRuntimeAuthoritySnapshot | null;
    }
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

function applyActorSessionToBody(
  route: MemoryV6Route,
  body: unknown,
  actorSession: AgentRuntimeActorSession,
  authority: ProviderAgentRuntimeAuthoritySnapshot,
): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return body;
  }
  const request = body as Record<string, unknown>;
  if (route === "character_affect_appraise") {
    return {
      ...request,
      characterId: actorSession.characterId,
      sessionId: actorSession.id,
      candidates: Array.isArray(request.candidates)
        ? request.candidates.map((candidate) => (
            candidate && typeof candidate === "object" && !Array.isArray(candidate)
              ? {
                  ...(candidate as Record<string, unknown>),
                  userId: authority.userId,
                  characterId: actorSession.characterId,
                  sessionId: actorSession.id,
                }
              : candidate
          ))
        : request.candidates,
    };
  }
  if (route === "character_context_get" || route === "character_memory_append_episode") {
    return {
      ...request,
      characterId: actorSession.characterId,
      sessionId: actorSession.id,
    };
  }
  if (
    route === "character_memory_search"
    || route === "character_memory_correct"
    || route === "character_memory_forget"
  ) {
    return { ...request, characterId: actorSession.characterId };
  }
  return body;
}

async function resolveRouteAgentRuntimeBinding(input: {
  options: MemoryV6HttpServerOptions;
  route: MemoryV6Route;
  body: unknown;
  bindingReference?: string;
  transport: CharacterContextTransport;
  fallbackFrom?: "mcp";
  turnCapability?: string;
}): Promise<RouteBindingResolution> {
  const agentBound = input.transport === "mcp" || input.fallbackFrom === "mcp";
  const configuredPolicy = MEMORY_V6_ROUTE_BINDING_POLICIES[input.route];
  const policy: AgentRuntimeBindingPolicy = agentBound && mcpRoutes.has(input.route)
    ? "required"
    : input.transport === "cli" && configuredPolicy === "required"
      ? "optional"
      : configuredPolicy;
  if (policy === "none") {
    if (input.bindingReference !== undefined) {
      return { ok: false, error: bindingFailure(input.route, "SESSION_BINDING_FORBIDDEN") };
    }
    return { ok: true, body: input.body, principal: null, authority: null };
  }
  const bindingWasPresented = input.bindingReference !== undefined;
  const reference = input.bindingReference?.trim();
  if (!bindingWasPresented) {
    return policy === "optional"
      ? { ok: true, body: input.body, principal: null, authority: null }
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
  const binding = resolved.binding;
  if (!agentBound) {
    return {
      ok: true,
      body: input.body,
      principal: createSessionBindingMemoryPrincipal(binding, actorSession),
      authority: null,
    };
  }
  const authority = resolveProviderAgentRuntimeAuthority(binding, actorSession);
  if (!authority) {
    return { ok: false, error: bindingFailure(input.route, "SESSION_BINDING_INVALID") };
  }
  const identityField = findCallerIdentityField(input.body, input.route === "character_memory_search");
  if (identityField) {
    return { ok: false, error: agentInputError(input.route, identityField, "Caller identity is not accepted.") };
  }
  if (requiresCurrentTurnCapability(input.route, input.body)) {
    const admission = input.options.providerAgentRuntimeTurns?.admit({
      actorSessionId: binding.actorSessionId,
      providerId: binding.providerId,
      turnCapability: input.turnCapability,
    });
    if (!admission?.ok) {
      return { ok: false, error: turnAdmissionFailure(input.route) };
    }
  }
  const body = resolveAgentBoundRequestBody(input.options, input.route, input.body, actorSession, authority);
  if (!body.ok) {
    return { ok: false, error: body.error };
  }
  return {
    ok: true,
    body: body.value,
    principal: createSessionBindingMemoryPrincipal(binding, actorSession),
    authority,
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
  const applicationInstanceId = requireNonEmptySecret(options.applicationInstanceId ?? "legacy", "applicationInstanceId");
  const runtimeGenerationId = requireNonEmptySecret(
    options.runtimeGenerationId ?? options.runtimeInstanceId ?? "",
    "runtimeGenerationId",
  );
  const buildChannel = options.buildChannel ?? "unknown";
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
        writeJson(response, 200, buildStatusResponse({
          apiSecret,
          applicationInstanceId,
          runtimeGenerationId,
          buildChannel,
          requestUrl: request.url,
        }));
        return;
      }

      if (pathname === WITHMATE_MEMORY_RUNTIME_EXCHANGE_PATH) {
        if (request.method !== "POST" || !acceptsJsonRequest(request)) {
          writeJson(response, 405, memoryTransportError("MEMORY_METHOD_NOT_ALLOWED", "Memory runtime exchange requires JSON POST."));
          return;
        }
        const nonce = request.headers[WITHMATE_MEMORY_RUNTIME_NONCE_HEADER];
        const expectedRuntimeInstanceId = request.headers[WITHMATE_MEMORY_RUNTIME_INSTANCE_HEADER];
        const expectedRuntimeGenerationId = request.headers[WITHMATE_MEMORY_RUNTIME_GENERATION_HEADER];
        const expectedApplicationInstanceId = request.headers[WITHMATE_MEMORY_RUNTIME_APPLICATION_INSTANCE_HEADER];
        if (
          typeof nonce !== "string"
          || (typeof expectedRuntimeGenerationId !== "string" && typeof expectedRuntimeInstanceId !== "string")
          || (expectedRuntimeGenerationId !== undefined && expectedRuntimeGenerationId !== runtimeGenerationId)
          || (expectedRuntimeInstanceId !== undefined && expectedRuntimeInstanceId !== runtimeGenerationId)
          || (expectedApplicationInstanceId !== undefined && expectedApplicationInstanceId !== applicationInstanceId)
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
          [WITHMATE_MEMORY_RUNTIME_GENERATION_HEADER]: runtimeGenerationId,
          [WITHMATE_MEMORY_RUNTIME_INSTANCE_HEADER]: runtimeGenerationId,
          [WITHMATE_MEMORY_RUNTIME_APPLICATION_INSTANCE_HEADER]: applicationInstanceId,
          [WITHMATE_MEMORY_RUNTIME_CHALLENGE_HEADER]: createWithMateMemoryRuntimeChallenge(
            apiSecret,
            runtimeGenerationId,
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
          writeJson(response, 200, {
            ok: true,
            applicationInstanceId,
            runtimeGenerationId,
            runtimeInstanceId: runtimeGenerationId,
            buildChannel,
          });
          return;
        }
        const route = routeByPath.get(operationUrl.pathname);
        if (!route) {
          writeJson(response, 404, memoryTransportError("MEMORY_ROUTE_NOT_FOUND", "Memory API route was not found."));
          return;
        }
        const transport = payload.adapter === "agent_cli_fallback" ? "mcp" : payload.adapter;
        const validFallbackMode = payload.adapter === "agent_cli_fallback"
          ? payload.operation.fallbackFrom === "mcp" && Boolean(payload.bindingReference?.trim())
          : payload.operation.fallbackFrom === undefined;
        if (!validFallbackMode || !canTransportInvokeRoute(transport, route)) {
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
          transport,
          bindingReference: payload.bindingReference,
          turnCapability: payload.turnCapability,
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
        const expectedRuntimeGenerationId = request.headers[WITHMATE_MEMORY_RUNTIME_GENERATION_HEADER];
        const expectedApplicationInstanceId = request.headers[WITHMATE_MEMORY_RUNTIME_APPLICATION_INSTANCE_HEADER];
        if (
          typeof nonce !== "string"
          || (typeof expectedRuntimeGenerationId !== "string" && typeof expectedRuntimeInstanceId !== "string")
          || (expectedRuntimeGenerationId !== undefined && expectedRuntimeGenerationId !== runtimeGenerationId)
          || (expectedRuntimeInstanceId !== undefined && expectedRuntimeInstanceId !== runtimeGenerationId)
          || (expectedApplicationInstanceId !== undefined && expectedApplicationInstanceId !== applicationInstanceId)
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
          [WITHMATE_MEMORY_RUNTIME_GENERATION_HEADER]: runtimeGenerationId,
          [WITHMATE_MEMORY_RUNTIME_INSTANCE_HEADER]: runtimeGenerationId,
          [WITHMATE_MEMORY_RUNTIME_APPLICATION_INSTANCE_HEADER]: applicationInstanceId,
          [WITHMATE_MEMORY_RUNTIME_CHALLENGE_HEADER]: createWithMateMemoryRuntimeChallenge(
            apiSecret,
            runtimeGenerationId,
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
        if (payload.adapter === "agent_cli_fallback" || payload.operation.fallbackFrom !== undefined) {
          writeJson(response, 403, memoryTransportError("MEMORY_FORBIDDEN", "Agent runtime extension does not accept Memory CLI fallback mode."));
          return;
        }
        const extensionResponse = await options.routeAgentRuntimeExtension?.({
          method: payload.operation.method,
          path: payload.operation.path,
          body: payload.operation.body,
          transport: payload.adapter,
          bindingReference: payload.bindingReference,
          turnCapability: payload.turnCapability,
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
