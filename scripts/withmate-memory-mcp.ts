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
  discoverWithMateMemoryApi,
  mapRuntimeHttpFailureToCharacterContext,
  WithMateMemoryRuntimeExchangeError,
  type WithMateMemoryRuntimeConnection,
  type WithMateMemoryRuntimeOperation,
  type WithMateMemoryRuntimeResponse,
} from "./withmate-memory-runtime-client.js";

type McpRuntimeDeps = {
  env?: NodeJS.ProcessEnv;
  runtimeCall?: (
    connection: WithMateMemoryRuntimeConnection,
    operation: WithMateMemoryRuntimeOperation,
    options: { signal: AbortSignal },
  ) => Promise<WithMateMemoryRuntimeResponse>;
  readFile?: typeof import("node:fs/promises").readFile;
  requestTimeoutMs?: number;
};

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
  characterId: z.string().min(1),
  userId: z.literal("local-user"),
  sessionId: z.string().min(1),
  layer: z.enum(["relationship", "session"]),
  targetType: z.enum(["user", "relationship", "task", "bug", "artifact", "self"]),
  targetId: z.string().min(1),
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
    characterId: z.string(),
    sessionId: z.string(),
    baseline: z.object({ definitionSha256: z.string(), snapshotAt: z.string() }).strict(),
    affect: z.object({
      mode: z.enum(["shadow", "active"]),
      effective: z.array(z.object({
        contributingLayers: z.array(z.enum(["baseline", "relationship", "session"])).min(1),
        targetType: z.enum(["user", "relationship", "task", "bug", "artifact", "self"]),
        targetId: z.string(),
        label: z.string(),
        valence: z.number(),
        arousal: z.number().optional(),
        dimensions: z.record(z.string(), z.number()).optional(),
        intensity: z.number(),
      }).strict()),
      version: z.string(),
      updatedAt: z.string().nullable(),
    }).strict(),
    memory: z.object({
      items: z.array(memorySearchHitSchema),
      relatedTags: z.array(memoryTagSchema).optional(),
      updatedAt: z.string().nullable(),
    }).strict(),
    scope: z.object({
      userId: z.literal("local-user"),
      characterId: z.string(),
      sessionId: z.string(),
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
  ["schemaVersion", "characterId", "sessionId", "baseline", "affect", "memory", "scope"],
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
  "Call character_memory.correct or character_memory.forget only after an explicit user instruction. Do not infer correction or deletion authority.",
  "Do not expose internal audit data or tool state in the user-facing response. Use returned scope, source version, and update result without guessing missing values.",
].join("\n");

export const CHARACTER_MCP_TOOL_DEFINITIONS = [
  {
    name: "character_context.get",
    description: "Get a versioned, minimal Character context snapshot when injected context is unavailable or insufficient.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "character_affect.appraise",
    description: "Validate and record bounded candidates for the Character's own affect; this does not diagnose the user.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "character_memory.search",
    description: "Search one explicit Character Memory scope for a focused current-task or conversation query.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "character_memory.append_episode",
    description: "Append one shared Character episode; motif recurrence is allowed and only same-event retries deduplicate.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "character_memory.correct",
    description: "Correct one Character Memory entry after an explicit user instruction, preserving supersession history.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "character_memory.forget",
    description: "Forget one Character Memory entry after an explicit user instruction and read back the result.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
] as const;

async function callRuntime(
  path: string,
  body: unknown,
  operationKind: "read" | "write",
  deps: McpRuntimeDeps,
): Promise<unknown> {
  const connection = await discoverWithMateMemoryApi({ adapter: "mcp", env: deps.env, readFile: deps.readFile });
  if (!connection) {
    return createCharacterContextError("storage_unavailable", "WithMate runtime is not available.", {
      retryable: true,
      conversationMayContinue: true,
      effect: "none",
    });
  }
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), deps.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
  let dispatched = false;
  try {
    const runtimeResponse = await (deps.runtimeCall ?? callWithMateMemoryRuntime)(connection, {
      method: "POST",
      path,
      body,
    }, { signal: abortController.signal });
    dispatched = true;
    return mapRuntimeHttpFailureToCharacterContext(runtimeResponse);
  } catch (error) {
    const operationDispatched = error instanceof WithMateMemoryRuntimeExchangeError
      ? error.dispatched
      : dispatched;
    return createCharacterContextError("storage_unavailable", "WithMate runtime request failed.", {
      retryable: true,
      conversationMayContinue: true,
      effect: operationKind === "write" && operationDispatched ? "unknown" : "none",
    });
  } finally {
    clearTimeout(timeout);
  }
}

function toolResult(value: unknown) {
  const structured = value && typeof value === "object" ? value as Record<string, unknown> : { value };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: structured,
    ...(isCharacterContextError(value) ? { isError: true } : {}),
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
      characterId: z.string().min(1),
      sessionId: z.string().min(1),
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
      characterId: z.string().min(1),
      sessionId: z.string().min(1),
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
      characterId: z.string().min(1),
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
      characterId: z.string().min(1),
      sessionId: z.string().min(1),
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
      characterId: z.string().min(1),
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
      characterId: z.string().min(1),
      entryId: z.string().min(1),
      reason: z.enum(["user_request", "incorrect", "outdated", "privacy", "other"]),
      idempotencyKey: z.string().min(1),
    }).strict(),
    outputSchema: mutationToolOutputSchema,
  }, async (input) => toolResult(await callRuntime("/v1/character_memory/forget", {
    schemaVersion: CHARACTER_CONTEXT_SCHEMA_VERSION,
    ...input,
  }, "write", deps)));

  return server;
}

export async function startWithMateMemoryMcpServer(deps: McpRuntimeDeps = {}): Promise<McpServer> {
  const server = createWithMateMemoryMcpServer(deps);
  await server.connect(new StdioServerTransport());
  return server;
}
