import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  CHARACTER_CONTEXT_SCHEMA_VERSION,
  createCharacterContextError,
  isCharacterContextError,
} from "../src/character-context/character-context-contract.js";
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  callWithMateMemoryRuntime,
  createCharacterRuntimeDiscoveryError,
  createMemoryRuntimeDiscoveryError,
  createMemoryRuntimeError,
  isMemoryErrorResponse,
  mapRuntimeHttpFailureToCharacterContext,
  mapRuntimeHttpFailureToMemory,
  resolveAgentRuntimeBindingReference,
  resolveAgentRuntimeTurnCapability,
  resolveWithMateMemoryApi,
  WithMateMemoryRuntimeExchangeError,
  type WithMateMemoryRuntimeConnection,
  type WithMateMemoryRuntimeOperation,
  type WithMateMemoryPublicDiscoveryCode,
  type WithMateMemoryRuntimeResponse,
} from "./withmate-memory-runtime-client.js";
import type { RuntimeDiscoveryClock } from "../src/runtime-discovery/runtime-discovery-contract.js";
import {
  GENERAL_MEMORY_MCP_TOOL_DEFINITIONS,
  registerGeneralMemoryMcpTools,
} from "./withmate-memory-mcp-general.js";

type McpRuntimeDeps = {
  env?: NodeJS.ProcessEnv;
  runtimeCall?: (
    connection: WithMateMemoryRuntimeConnection,
    operation: WithMateMemoryRuntimeOperation,
    options: { signal: AbortSignal; bindingReference?: string; turnCapability?: string },
  ) => Promise<WithMateMemoryRuntimeResponse>;
  readFile?: typeof import("node:fs/promises").readFile;
  fetch?: typeof fetch;
  clock?: RuntimeDiscoveryClock;
  registryRootDirectoryPath?: string;
  staleThresholdMs?: number;
  requestTimeoutMs?: number;
  fileOperationRequestTimeoutMs?: number;
};

const DEFAULT_FILE_OPERATION_REQUEST_TIMEOUT_MS = 300_000;
const GENERAL_MEMORY_FILE_OPERATION_PATHS = new Set([
  "/v1/append",
  "/v1/get_file",
  "/v1/export_files",
]);

function runtimeExchangeDiscoveryCode(error: WithMateMemoryRuntimeExchangeError): WithMateMemoryPublicDiscoveryCode | undefined {
  return error.discoveryCode;
}

const affectValueSchema = z.object({
  label: z.string().min(1),
  valence: z.number().min(-1).max(1),
  arousal: z.number().min(-1).max(1).optional(),
  dimensions: z.record(z.string().min(1), z.number().min(-1).max(1)).optional(),
}).strict();

const episodeBaseSchema = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
  preview: z.string().min(1),
  motif: z.string().min(1).optional(),
}).strict();

const episodeSchema = z.union([
  episodeBaseSchema.extend({
    observedFact: z.string().min(1),
    characterObservation: z.string().min(1).optional(),
  }).strict(),
  episodeBaseSchema.extend({
    observedFact: z.string().min(1).optional(),
    characterObservation: z.string().min(1),
  }).strict(),
]);

const affectEpisodeCandidateSchema = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
  preview: z.string().min(1),
  motif: z.string().min(1).optional(),
  salience: z.number().min(0).max(1),
}).strict();

const affectCandidateSchema = z.object({
  schemaVersion: z.literal("withmate-affect-v1"),
  layer: z.enum(["relationship", "session"]),
  targetType: z.enum(["user", "relationship", "task", "bug", "artifact", "self"]),
  targetId: z.string().min(1),
  family: z.enum([
    "joy", "relief", "interest", "anticipation", "affinity", "gratitude",
    "concern", "frustration", "disappointment", "regret", "determination", "other",
  ]),
  value: affectValueSchema,
  intensity: z.number().min(0).max(1),
  reason: z.string().min(1),
  evidence: z.string().min(1),
  occurredAt: z.string().min(1),
  idempotencyKey: z.string().min(1),
  memoryEpisode: affectEpisodeCandidateSchema.optional(),
}).strict();

const projectRefSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("id"), id: z.string().min(1) }).strict(),
  z.object({ type: z.literal("path"), path: z.string().min(1) }).strict(),
]);

const memoryTagSchema = z.object({ type: z.string(), value: z.string() }).strict();
const memoryOwnerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("character"), id: z.string() }).strict(),
  z.object({ type: z.literal("project"), id: z.string() }).strict(),
  z.object({ type: z.literal("user"), id: z.literal("local-user") }).strict(),
]);
const memoryScopeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("session"), id: z.string() }).strict(),
  z.object({ type: z.literal("project"), id: z.string() }).strict(),
  z.object({ type: z.literal("character"), id: z.string() }).strict(),
  z.object({ type: z.literal("global"), id: z.literal("global") }).strict(),
]);
const memoryFileSchema = z.object({
  objectId: z.string(),
  role: z.string(),
  mediaKind: z.enum(["image", "text", "source", "archive", "document", "other"]),
  contentType: z.string(),
  displayName: z.string(),
  summary: z.string(),
  originalBytes: z.number().int().nonnegative(),
}).strict();
const memoryEntryBaseShape = {
  id: z.string(),
  owner: memoryOwnerSchema,
  scope: memoryScopeSchema,
  kind: z.enum(["decision", "constraint", "convention", "context", "deferred", "preference", "relationship", "boundary", "note"]),
  title: z.string(),
  preview: z.string(),
  tags: z.array(memoryTagSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
  files: z.array(memoryFileSchema).optional(),
};
const memorySearchHitSchema = z.object({
  ...memoryEntryBaseShape,
  match: z.object({
    fields: z.array(z.enum(["title", "preview", "body", "tags"])),
    snippet: z.string().optional(),
  }).strict().optional(),
}).strict();

const characterMemoryPreviewSchema = z.object({
  id: z.string(),
  title: z.string(),
  preview: z.string(),
  tags: z.array(memoryTagSchema),
  updatedAt: z.string(),
}).strict();
const memoryEntrySummarySchema = z.object({
  ...memoryEntryBaseShape,
  state: z.enum(["active", "superseded", "forgotten"]),
}).strict();
const characterErrorSchema = z.object({
  schemaVersion: z.literal(CHARACTER_CONTEXT_SCHEMA_VERSION),
  error: z.object({
    code: z.enum([
      "invalid_input", "unknown_character", "unknown_scope", "authority_denied", "version_conflict",
      "idempotent_replay", "storage_unavailable", "migration_required", "partial_failure", "internal_error",
    ]),
    message: z.string(),
    field: z.string().optional(),
    retryable: z.boolean(),
    conversationMayContinue: z.boolean(),
    effect: z.enum(["none", "committed", "partial", "unknown"]).optional(),
    details: z.record(z.string(), z.unknown()).optional(),
  }).strict(),
}).strict();
const contextOutputSchema = z.union([
  z.object({
    schemaVersion: z.literal(CHARACTER_CONTEXT_SCHEMA_VERSION),
    baseline: z.object({ definitionSha256: z.string(), snapshotAt: z.string() }).strict(),
    affect: z.object({
      mode: z.enum(["shadow", "active"]),
      effective: z.array(z.object({
        contributingLayers: z.array(z.enum(["baseline", "relationship", "session"])).min(1),
        targetType: z.enum(["user", "relationship", "task", "bug", "artifact", "self"]),
        targetId: z.string(),
        family: z.enum([
          "joy", "relief", "interest", "anticipation", "affinity", "gratitude",
          "concern", "frustration", "disappointment", "regret", "determination", "other",
        ]).nullable(),
        label: z.string(),
        valence: z.number(),
        arousal: z.number().optional(),
        dimensions: z.record(z.string(), z.number()).optional(),
        intensity: z.number(),
      }).strict()),
      evaluatedAt: z.string(),
      version: z.string(),
      updatedAt: z.string().nullable(),
    }).strict(),
    memory: z.object({
      items: z.array(characterMemoryPreviewSchema),
      relatedTags: z.array(memoryTagSchema).optional(),
      updatedAt: z.string().nullable(),
    }).strict(),
  }).strict(),
  characterErrorSchema,
]);
const appraisalOutputSchema = z.union([
  z.object({
    schemaVersion: z.literal(CHARACTER_CONTEXT_SCHEMA_VERSION),
    characterId: z.string(),
    sessionId: z.string(),
    saved: z.array(z.object({
      candidateIndex: z.number().int().nonnegative(),
      eventId: z.string(),
      memoryEntryId: z.string().nullable(),
      replayed: z.boolean(),
    }).strict()),
    rejected: z.array(z.object({
      candidateIndex: z.number().int().nonnegative(),
      code: z.enum(["invalid_input", "authority_denied"]),
      message: z.string(),
    }).strict()),
    version: z.string(),
    updatedAt: z.string().nullable(),
  }).strict(),
  characterErrorSchema,
]);
const searchOutputSchema = z.union([
  z.object({
    schemaVersion: z.literal(CHARACTER_CONTEXT_SCHEMA_VERSION),
    characterId: z.string(),
    scope: z.union([
      z.object({ scope: z.literal("character") }).strict(),
      z.object({ scope: z.literal("project"), project: projectRefSchema }).strict(),
    ]),
    items: z.array(memorySearchHitSchema),
    relatedTags: z.array(memoryTagSchema).optional(),
    sourceVersion: z.string().nullable(),
  }).strict(),
  characterErrorSchema,
]);
const mutationOutputSchema = z.union([
  z.object({
    schemaVersion: z.literal(CHARACTER_CONTEXT_SCHEMA_VERSION),
    characterId: z.string(),
    operation: z.enum(["append_episode", "correct", "forget"]),
    entry: memoryEntrySummarySchema.nullable(),
    previousEntryId: z.string().optional(),
    created: z.boolean().optional(),
    replayed: z.boolean().optional(),
    readBack: z.enum(["active", "superseded", "forgotten", "not_found"]),
    sourceVersion: z.string().nullable(),
  }).strict(),
  characterErrorSchema,
]);

function createToolOutputSchema<T extends z.ZodRawShape>(
  successSchema: z.ZodObject<T>,
  requiredSuccessKeys: string[],
) {
  return successSchema.partial().extend({
    schemaVersion: z.literal(CHARACTER_CONTEXT_SCHEMA_VERSION),
    error: characterErrorSchema.shape.error.optional(),
  }).strict().superRefine((value, context) => {
    if (successSchema.safeParse(value).success || characterErrorSchema.safeParse(value).success) {
      return;
    }
    context.addIssue({
      code: "custom",
      message: "Result must match either the tool success contract or the Character context error contract.",
    });
  }).meta({
    oneOf: [
      { required: requiredSuccessKeys, not: { required: ["error"] } },
      { required: ["error"] },
    ],
  });
}

const contextToolOutputSchema = createToolOutputSchema(
  contextOutputSchema.options[0],
  ["schemaVersion", "baseline", "affect", "memory"],
);
const appraisalToolOutputSchema = createToolOutputSchema(
  appraisalOutputSchema.options[0],
  ["schemaVersion", "characterId", "sessionId", "saved", "rejected", "version", "updatedAt"],
);
const searchToolOutputSchema = createToolOutputSchema(
  searchOutputSchema.options[0],
  ["schemaVersion", "characterId", "scope", "items", "sourceVersion"],
);
const mutationToolOutputSchema = createToolOutputSchema(
  mutationOutputSchema.options[0],
  ["schemaVersion", "characterId", "operation", "entry", "readBack", "sourceVersion"],
);

export const CHARACTER_MCP_SERVER_INSTRUCTIONS = [
  "Use character_context.get only when injected turn context is missing, stale, too small for the current topic, or when the client cannot inject context.",
  "Use character_memory.search for a focused current-task or conversation query. Do not request or submit a raw conversation transcript.",
  "character_affect.appraise records the Character's own affect, never a diagnosis of the user's emotions. Every candidate needs an explicit target and idempotency key.",
  "Use character_memory.append_episode for a bounded conversational write. Similar motifs may recur; reuse an idempotency key only for the same event retry.",
  "Character Memory correction and forget are autonomous user-delegate operations. Use only the actor Character scope, an explicit target, a concrete reason, an idempotency key, and read-back.",
  "Do not expose internal audit data or tool state in the user-facing response. Use returned source version and update result without guessing missing values.",
  "Use memory.* for semantic Project, user-global, Character, or Character+Project Memory with an explicit target. Search the same target before append to avoid semantic duplicates.",
  "Agent CLI fallback is available only after this MCP initialize and tools/list succeeded and a later transport availability failure occurs. Invoke withmate-memory <command> --fallback-from mcp with the same actor-relative JSON; initialization, tools/list, domain, authority, version, idempotency, migration, and storage failures do not permit fallback.",
].join("\n");

export const CHARACTER_MCP_TOOL_DEFINITIONS = [
  {
    name: "character_context.get",
    description: "Get a versioned, minimal Character context snapshot when injected context is unavailable or insufficient.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "character_affect.appraise",
    description: "Validate and record bounded candidates for the Character's own affect; this does not diagnose the user. An episode linked to this affect event must be sent only as memoryEpisode here and never duplicated through character_memory.append_episode. Reuse an idempotency key only for an unchanged same-event retry; report saved, rejected, replayed, version, and effect exactly as returned.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "character_memory.search",
    description: "Search one explicit Character Memory scope for a focused current-task or conversation query.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "character_memory.append_episode",
    description: "Append one standalone shared Character episode only; episodes linked to an affect event belong exclusively to character_affect.appraise.memoryEpisode. Motif recurrence is allowed and only unchanged same-event retries reuse an idempotency key.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "character_memory.correct",
    description: "Correct one Character Memory entry as an idempotent user-delegate operation, preserving supersession history.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "character_memory.forget",
    description: "Forget one Character Memory entry as an idempotent user-delegate operation and read back the result.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
] as const;

export const WITHMATE_MEMORY_MCP_TOOL_DEFINITIONS = [
  ...CHARACTER_MCP_TOOL_DEFINITIONS,
  ...GENERAL_MEMORY_MCP_TOOL_DEFINITIONS,
] as const;

async function callRuntime(
  path: string,
  body: unknown,
  operationKind: "read" | "write",
  deps: McpRuntimeDeps,
): Promise<unknown> {
  let bindingReference: string | undefined;
  let turnCapability: string | undefined;
  try {
    bindingReference = resolveAgentRuntimeBindingReference(deps.env);
    turnCapability = resolveAgentRuntimeTurnCapability(deps.env);
  } catch (error) {
    if (isMemoryErrorResponse(error)) {
      return createCharacterContextError("authority_denied", error.error.message, {
        retryable: false,
        conversationMayContinue: true,
        effect: "none",
      });
    }
    throw error;
  }
  let resolution;
  try {
    resolution = await resolveWithMateMemoryApi({
      adapter: "mcp",
      env: deps.env,
      readFile: deps.readFile,
      fetch: deps.fetch,
      clock: deps.clock,
      registryRootDirectoryPath: deps.registryRootDirectoryPath,
      staleThresholdMs: deps.staleThresholdMs,
    });
  } catch {
    return createCharacterContextError("storage_unavailable", "WithMate runtime request failed.", {
      retryable: true,
      conversationMayContinue: true,
      effect: "none",
      details: { discoveryCode: "WITHMATE_RUNTIME_UNAVAILABLE" },
    });
  }
  if (resolution.kind === "error") {
    return createCharacterRuntimeDiscoveryError(resolution);
  }
  const connection = resolution.connection;
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), deps.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
  let dispatched = false;
  try {
    const runtimeResponse = await (deps.runtimeCall ?? callWithMateMemoryRuntime)(connection, {
      method: "POST",
      path,
      body,
    }, {
      signal: abortController.signal,
      bindingReference,
      turnCapability,
    });
    dispatched = true;
    return mapRuntimeHttpFailureToCharacterContext(runtimeResponse);
  } catch (error) {
    const operationDispatched = error instanceof WithMateMemoryRuntimeExchangeError
      ? error.dispatched
      : dispatched;
    const discoveryCode = error instanceof WithMateMemoryRuntimeExchangeError && !operationDispatched
      ? runtimeExchangeDiscoveryCode(error)
      : undefined;
    return createCharacterContextError("storage_unavailable", "WithMate runtime request failed.", {
      retryable: true,
      conversationMayContinue: true,
      effect: operationKind === "write" && operationDispatched ? "unknown" : "none",
      ...(discoveryCode ? { details: { discoveryCode } } : {}),
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function callMemoryRuntime(
  operation: {
    method: "GET" | "POST";
    path: string;
    body: unknown;
    operationKind: "read" | "write";
  },
  deps: McpRuntimeDeps,
): Promise<unknown> {
  let bindingReference: string | undefined;
  let turnCapability: string | undefined;
  try {
    bindingReference = resolveAgentRuntimeBindingReference(deps.env);
    turnCapability = resolveAgentRuntimeTurnCapability(deps.env);
  } catch (error) {
    if (isMemoryErrorResponse(error)) {
      return error;
    }
    throw error;
  }
  let resolution;
  try {
    resolution = await resolveWithMateMemoryApi({
      adapter: "mcp",
      env: deps.env,
      readFile: deps.readFile,
      fetch: deps.fetch,
      clock: deps.clock,
      registryRootDirectoryPath: deps.registryRootDirectoryPath,
      staleThresholdMs: deps.staleThresholdMs,
    });
  } catch {
    return createMemoryRuntimeError("WITHMATE_MEMORY_TRANSPORT_ERROR", "WithMate runtime request failed.", {
      retryable: true,
      conversationMayContinue: true,
      effect: "none",
    });
  }
  if (resolution.kind === "error") {
    return createMemoryRuntimeDiscoveryError(resolution);
  }
  const connection = resolution.connection;
  const operationPath = new URL(operation.path, "http://127.0.0.1").pathname;
  const requestTimeoutMs = GENERAL_MEMORY_FILE_OPERATION_PATHS.has(operationPath)
    ? deps.fileOperationRequestTimeoutMs ?? DEFAULT_FILE_OPERATION_REQUEST_TIMEOUT_MS
    : deps.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), requestTimeoutMs);
  let dispatched = false;
  try {
    const runtimeResponse = await (deps.runtimeCall ?? callWithMateMemoryRuntime)(connection, {
      method: operation.method,
      path: operation.path,
      body: operation.body,
    }, {
      signal: abortController.signal,
      bindingReference,
      turnCapability,
    });
    dispatched = true;
    return mapRuntimeHttpFailureToMemory(runtimeResponse, operation.operationKind);
  } catch (error) {
    const operationDispatched = error instanceof WithMateMemoryRuntimeExchangeError
      ? error.dispatched
      : dispatched;
    const discoveryCode = error instanceof WithMateMemoryRuntimeExchangeError && !operationDispatched
      ? runtimeExchangeDiscoveryCode(error)
      : undefined;
    if (discoveryCode) {
      return createMemoryRuntimeError(discoveryCode, "WithMate Memory runtime identity changed before dispatch.", {
        retryable: discoveryCode === "WITHMATE_RUNTIME_UNAVAILABLE" || discoveryCode === "WITHMATE_RUNTIME_STALE",
        conversationMayContinue: true,
        effect: "none",
        details: { discoveryCode },
      });
    }
    return createMemoryRuntimeError("WITHMATE_MEMORY_TRANSPORT_ERROR", "WithMate runtime request failed.", {
      retryable: true,
      conversationMayContinue: true,
      effect: operation.operationKind === "write" && operationDispatched ? "unknown" : "none",
    });
  } finally {
    clearTimeout(timeout);
  }
}

function isMemoryError(value: unknown): boolean {
  return typeof value === "object"
    && value !== null
    && (value as { schemaVersion?: unknown }).schemaVersion === "withmate-memory-v1"
    && typeof (value as { error?: { code?: unknown } }).error?.code === "string";
}

function toolResult(value: unknown) {
  const structured = value && typeof value === "object" ? value as Record<string, unknown> : { value };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: structured,
    ...(isCharacterContextError(value) || isMemoryError(value) ? { isError: true } : {}),
  };
}

export function createWithMateMemoryMcpServer(deps: McpRuntimeDeps = {}): McpServer {
  const server = new McpServer(
    { name: "withmate-character-context", version: "1.0.0" },
    { instructions: CHARACTER_MCP_SERVER_INSTRUCTIONS },
  );
  const definitions = new Map(CHARACTER_MCP_TOOL_DEFINITIONS.map((definition) => [definition.name, definition]));

  server.registerTool("character_context.get", {
    ...definitions.get("character_context.get")!,
    inputSchema: z.object({
      query: z.string().min(1).optional(),
      memoryLimit: z.number().int().min(0).max(10).default(3),
    }).strict(),
    outputSchema: contextToolOutputSchema,
  }, async (input) => toolResult(await callRuntime("/v1/character_context/get", {
    schemaVersion: CHARACTER_CONTEXT_SCHEMA_VERSION,
    ...input,
  }, "read", deps)));

  server.registerTool("character_affect.appraise", {
    ...definitions.get("character_affect.appraise")!,
    inputSchema: z.object({
      expectedVersion: z.string().min(1).optional(),
      candidates: z.array(affectCandidateSchema).min(1).max(10),
    }).strict(),
    outputSchema: appraisalToolOutputSchema,
  }, async (input) => toolResult(await callRuntime("/v1/character_affect/appraise", {
    schemaVersion: CHARACTER_CONTEXT_SCHEMA_VERSION,
    ...input,
  }, "write", deps)));

  server.registerTool("character_memory.search", {
    ...definitions.get("character_memory.search")!,
    inputSchema: z.object({
      query: z.string().min(1),
      limit: z.number().int().min(1).max(20).default(5),
      scope: z.discriminatedUnion("scope", [
        z.object({ scope: z.literal("character") }).strict(),
        z.object({ scope: z.literal("project"), project: projectRefSchema }).strict(),
      ]),
    }).strict(),
    outputSchema: searchToolOutputSchema,
  }, async (input) => toolResult(await callRuntime("/v1/character_memory/search", {
    schemaVersion: CHARACTER_CONTEXT_SCHEMA_VERSION,
    ...input,
  }, "read", deps)));

  server.registerTool("character_memory.append_episode", {
    ...definitions.get("character_memory.append_episode")!,
    inputSchema: z.object({
      idempotencyKey: z.string().min(1),
      episode: episodeSchema,
    }).strict(),
    outputSchema: mutationToolOutputSchema,
  }, async (input) => toolResult(await callRuntime("/v1/character_memory/append_episode", {
    schemaVersion: CHARACTER_CONTEXT_SCHEMA_VERSION,
    ...input,
  }, "write", deps)));

  server.registerTool("character_memory.correct", {
    ...definitions.get("character_memory.correct")!,
    inputSchema: z.object({
      entryId: z.string().min(1),
      reason: z.string().min(1),
      idempotencyKey: z.string().min(1),
      replacement: episodeSchema,
    }).strict(),
    outputSchema: mutationToolOutputSchema,
  }, async (input) => toolResult(await callRuntime("/v1/character_memory/correct", {
    schemaVersion: CHARACTER_CONTEXT_SCHEMA_VERSION,
    ...input,
  }, "write", deps)));

  server.registerTool("character_memory.forget", {
    ...definitions.get("character_memory.forget")!,
    inputSchema: z.object({
      entryId: z.string().min(1),
      reason: z.enum(["user_request", "incorrect", "outdated", "privacy", "other"]),
      idempotencyKey: z.string().min(1),
    }).strict(),
    outputSchema: mutationToolOutputSchema,
  }, async (input) => toolResult(await callRuntime("/v1/character_memory/forget", {
    schemaVersion: CHARACTER_CONTEXT_SCHEMA_VERSION,
    ...input,
  }, "write", deps)));

  registerGeneralMemoryMcpTools(
    server,
    (operation) => callMemoryRuntime(operation, deps),
    toolResult,
  );

  return server;
}

export async function startWithMateMemoryMcpServer(deps: McpRuntimeDeps = {}): Promise<McpServer> {
  const server = createWithMateMemoryMcpServer(deps);
  await server.connect(new StdioServerTransport());
  return server;
}
