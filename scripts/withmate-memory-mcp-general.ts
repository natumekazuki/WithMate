import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  MEMORY_APPEND_FILE_ROLES,
  MEMORY_ENTRY_KINDS,
  MEMORY_FORGET_REASONS,
  MEMORY_RESULT_LIMIT_MAX,
  MEMORY_V6_SCHEMA_VERSION,
} from "../src/memory-v6/memory-contract.js";
import { MEMORY_ABSOLUTE_PATH_PATTERN } from "../src/memory-v6/memory-validation.js";

type GeneralMemoryRuntimeCall = (operation: {
  method: "GET" | "POST";
  path: string;
  body: unknown;
  operationKind: "read" | "write";
}) => Promise<unknown>;

type GeneralMemoryToolResult = (value: unknown) => {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
  isError?: boolean;
};

const projectRefSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("id"), id: z.string().min(1).max(200) }).strict(),
  z.object({ type: z.literal("path"), path: z.string().min(1).max(1_000).regex(MEMORY_ABSOLUTE_PATH_PATTERN) }).strict(),
]);

const characterRefSchema = z.object({
  type: z.literal("id"),
  id: z.string().min(1).max(200),
}).strict();

const memoryTargetSchema = z.union([
  z.object({
    owner: z.literal("project"),
    scope: z.literal("project"),
    project: projectRefSchema,
  }).strict(),
  z.object({
    owner: z.literal("character"),
    scope: z.literal("character"),
    character: characterRefSchema,
  }).strict(),
  z.object({
    owner: z.literal("character"),
    scope: z.literal("project"),
    character: characterRefSchema,
    project: projectRefSchema,
  }).strict(),
  z.object({
    owner: z.literal("user"),
    scope: z.literal("global"),
  }).strict(),
]);

const memoryTagInputSchema = z.object({
  type: z.string().min(1).max(48),
  value: z.string().min(1).max(96),
}).strict();

const memoryTagOutputSchema = z.object({
  type: z.string(),
  value: z.string(),
}).strict();

const memoryOwnerOutputSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("character"), id: z.string() }).strict(),
  z.object({ type: z.literal("project"), id: z.string() }).strict(),
  z.object({ type: z.literal("user"), id: z.literal("local-user") }).strict(),
]);

const memoryScopeOutputSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("session"), id: z.string() }).strict(),
  z.object({ type: z.literal("project"), id: z.string() }).strict(),
  z.object({ type: z.literal("character"), id: z.string() }).strict(),
  z.object({ type: z.literal("global"), id: z.literal("global") }).strict(),
]);

const memoryFileOutputSchema = z.object({
  objectId: z.string(),
  role: z.enum(MEMORY_APPEND_FILE_ROLES),
  mediaKind: z.enum(["image", "text", "source", "archive", "document", "other"]),
  contentType: z.string(),
  displayName: z.string(),
  summary: z.string(),
  originalBytes: z.number().int().nonnegative(),
}).strict();

const memoryEntrySummaryShape = {
  id: z.string(),
  owner: memoryOwnerOutputSchema,
  scope: memoryScopeOutputSchema,
  kind: z.enum(MEMORY_ENTRY_KINDS),
  title: z.string(),
  preview: z.string(),
  state: z.enum(["active", "superseded", "forgotten"]),
  tags: z.array(memoryTagOutputSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
  files: z.array(memoryFileOutputSchema).optional(),
};

const memoryEntrySummarySchema = z.object(memoryEntrySummaryShape).strict();
const memorySearchHitSchema = memoryEntrySummarySchema.omit({ state: true }).extend({
  match: z.object({
    fields: z.array(z.enum(["title", "preview", "body", "tags"])),
    snippet: z.string().optional(),
  }).strict().optional(),
}).strict();

const memorySourceSchema = z.object({
  type: z.enum(["agent", "manual", "migration"]),
  sessionId: z.string().nullable(),
  messageId: z.string().nullable(),
  providerId: z.string().nullable(),
}).strict();

const memoryEntryDetailBase = z.object({
  ...memoryEntrySummaryShape,
  body: z.string(),
  source: memorySourceSchema,
  supersedes: z.array(z.string()),
  supersededBy: z.string().nullable(),
  forgottenAt: z.string().nullable(),
}).strict();

const memoryEntryDetailSchema = z.union([
  memoryEntryDetailBase.extend({
    state: z.literal("active"),
    supersededBy: z.null(),
    forgottenAt: z.null(),
  }).strict(),
  memoryEntryDetailBase.extend({
    state: z.literal("superseded"),
    supersededBy: z.string(),
    forgottenAt: z.null(),
  }).strict(),
  memoryEntryDetailBase.extend({
    state: z.literal("forgotten"),
    supersededBy: z.string().nullable(),
    forgottenAt: z.string(),
  }).strict(),
]);

const memoryErrorSchema = z.object({
  schemaVersion: z.literal(MEMORY_V6_SCHEMA_VERSION),
  error: z.object({
    code: z.string(),
    message: z.string(),
    field: z.string().optional(),
    quotaBytes: z.number().optional(),
    usedBytes: z.number().optional(),
    incomingBytes: z.number().optional(),
    availableBytes: z.number().optional(),
    allowedProjectTargets: z.array(z.string()).optional(),
    suggestion: z.string().optional(),
    retryable: z.boolean().optional(),
    conversationMayContinue: z.boolean().optional(),
    effect: z.enum(["none", "committed", "partial", "unknown"]),
    details: z.record(z.string(), z.unknown()).optional(),
  }).strict(),
}).strict();

function createMemoryToolOutputSchema<T extends z.ZodRawShape>(
  successSchema: z.ZodObject<T>,
  requiredSuccessKeys: string[],
) {
  return successSchema.partial().extend({
    schemaVersion: z.literal(MEMORY_V6_SCHEMA_VERSION),
    error: memoryErrorSchema.shape.error.optional(),
  }).strict().superRefine((value, context) => {
    if (successSchema.safeParse(value).success || memoryErrorSchema.safeParse(value).success) {
      return;
    }
    context.addIssue({
      code: "custom",
      message: "Result must match either the Memory success contract or the Memory error contract.",
    });
  }).meta({
    oneOf: [
      { required: requiredSuccessKeys, not: { required: ["error"] } },
      { required: ["error"] },
    ],
  });
}

const searchSuccessSchema = z.object({
  schemaVersion: z.literal(MEMORY_V6_SCHEMA_VERSION),
  items: z.array(memorySearchHitSchema),
  relatedTags: z.array(memoryTagOutputSchema).optional(),
  nextCursor: z.string().optional(),
}).strict();

const getEntrySuccessSchema = z.object({
  schemaVersion: z.literal(MEMORY_V6_SCHEMA_VERSION),
  entry: memoryEntryDetailSchema,
}).strict();

const targetInventorySchema = z.object({
  target: memoryTargetSchema,
  owner: z.enum(["project", "character", "user"]),
  scope: z.enum(["project", "character", "global"]),
  project: z.object({
    id: z.string(),
    displayName: z.string(),
    path: z.string().optional(),
  }).strict().optional(),
  character: z.object({
    id: z.string(),
    displayName: z.string(),
  }).strict().optional(),
  entryCount: z.number().int().nonnegative(),
  tagCount: z.number().int().nonnegative(),
  lastUpdatedAt: z.string().nullable(),
}).strict();

const listTargetsSuccessSchema = z.object({
  schemaVersion: z.literal(MEMORY_V6_SCHEMA_VERSION),
  items: z.array(targetInventorySchema),
  nextCursor: z.string().optional(),
}).strict();

const listEntrySchema = z.object({
  ...memoryEntrySummaryShape,
  body: z.string().optional(),
  supersedes: z.array(z.string()),
  supersededBy: z.string().nullable(),
}).strict();

const listEntriesSuccessSchema = z.object({
  schemaVersion: z.literal(MEMORY_V6_SCHEMA_VERSION),
  items: z.array(listEntrySchema),
  nextCursor: z.string().optional(),
}).strict();

const listTagsSuccessSchema = z.object({
  schemaVersion: z.literal(MEMORY_V6_SCHEMA_VERSION),
  tags: z.array(z.object({
    type: z.string(),
    value: z.string(),
    entryCount: z.number().int().nonnegative().optional(),
    latestUpdatedAt: z.string().optional(),
    samples: z.array(z.object({ id: z.string(), title: z.string() }).strict()).optional(),
  }).strict()),
  nextCursor: z.string().optional(),
}).strict();

const appendSuccessSchema = z.object({
  schemaVersion: z.literal(MEMORY_V6_SCHEMA_VERSION),
  entry: memoryEntrySummarySchema,
  created: z.boolean(),
  replayed: z.literal(true).optional(),
}).strict();

const forgetSuccessSchema = z.object({
  schemaVersion: z.literal(MEMORY_V6_SCHEMA_VERSION),
  results: z.array(z.object({
    entryId: z.string(),
    status: z.enum(["forgotten", "already_forgotten", "not_found"]),
    replayed: z.literal(true).optional(),
    entry: memoryEntrySummarySchema.optional(),
    warning: z.literal("target_mismatch_or_not_found").optional(),
  }).strict()),
  dryRun: z.literal(true).optional(),
  writeOccurred: z.literal(false).optional(),
}).strict();

const moveSuccessSchema = z.object({
  schemaVersion: z.literal(MEMORY_V6_SCHEMA_VERSION),
  entry: memoryEntrySummarySchema,
  moved: z.boolean(),
  replayed: z.literal(true).optional(),
  from: memoryTargetSchema,
  to: memoryTargetSchema,
}).strict();

const getFileSuccessSchema = z.object({
  schemaVersion: z.literal(MEMORY_V6_SCHEMA_VERSION),
  objectId: z.string(),
  entryId: z.string(),
  outputPath: z.string(),
  bytesWritten: z.number().int().nonnegative(),
  contentType: z.string(),
  displayName: z.string(),
}).strict();

const exportedFileSchema = z.object({
  objectId: z.string(),
  outputPath: z.string(),
  bytesWritten: z.number().int().nonnegative(),
  contentType: z.string(),
  displayName: z.string(),
}).strict();

const exportFilesSuccessSchema = z.object({
  schemaVersion: z.literal(MEMORY_V6_SCHEMA_VERSION),
  entryId: z.string(),
  outputDirectoryPath: z.string(),
  exportedCount: z.number().int().nonnegative(),
  files: z.array(exportedFileSchema),
}).strict();

const fileUsageSuccessSchema = z.object({
  schemaVersion: z.literal(MEMORY_V6_SCHEMA_VERSION),
  quotaBytes: z.number().int().nonnegative(),
  usedBytes: z.number().int().nonnegative(),
  physicalBytes: z.number().int().nonnegative(),
  pendingDeleteBytes: z.number().int().nonnegative(),
  availableBytes: z.number().int().nonnegative(),
  objectCount: z.number().int().nonnegative(),
  pendingDeleteCount: z.number().int().nonnegative(),
  quotaExceeded: z.boolean(),
  largestEntries: z.array(z.object({
    entryId: z.string(),
    title: z.string(),
    preview: z.string(),
    totalFileBytes: z.number().int().nonnegative(),
    fileCount: z.number().int().nonnegative(),
    updatedAt: z.string(),
  }).strict()).optional(),
}).strict();

const appendFileInputSchema = z.object({
  path: z.string().min(1).max(1_000).regex(/^(?:\/|[A-Za-z]:[\\/]|\\\\)/, "path must be absolute"),
  summary: z.string().min(1).max(500),
  role: z.enum(MEMORY_APPEND_FILE_ROLES).optional(),
  displayName: z.string().min(1).max(255).optional(),
  contentType: z.string().min(1).max(120).optional(),
}).strict();

export const GENERAL_MEMORY_MCP_TOOL_DEFINITIONS = [
  { name: "memory.search", description: "Search active general Memory in one or more explicit targets.", annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: "memory.get_entry", description: "Read one active Memory entry from an explicit target, including its full body.", annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: "memory.list_targets", description: "List bounded general Memory target inventory without exposing entry bodies.", annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: "memory.list_entries", description: "List entries in one explicit target; bodies are omitted unless explicitly requested.", annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: "memory.list_tags", description: "List tags for one explicit Memory target, optionally with bounded counts and samples.", annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: "memory.append", description: "Append one idempotent general Memory entry to an explicit target, optionally importing protected files atomically.", annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: "memory.forget", description: "Preview or perform an idempotent forget for an explicit target and concrete reason.", annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } },
  { name: "memory.move_entry", description: "Move one active entry idempotently between explicit targets while preserving its identity and attachments.", annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } },
  { name: "memory.get_file", description: "Export one protected object to a new absolute output path after target validation; existing files are not overwritten. This operation is non-idempotent: after a dispatched response loss, treat the effect as unknown and do not retry automatically. Inspect the intended output path read-only or use operator manual recovery; run a new operation only after confirming no file was created or by choosing a new output path.", annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } },
  { name: "memory.export_files", description: "Export all protected objects for one entry to new files in an absolute output directory after target validation. This operation is non-idempotent: after a dispatched response loss, treat the effect as unknown and do not retry automatically. Inspect the intended output directory read-only or use operator manual recovery; run a new operation only after confirming no files were created or by choosing a new output directory.", annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } },
  { name: "memory.file_usage", description: "Read bounded protected-object quota and usage metadata without exposing content or storage paths.", annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
] as const;

export function registerGeneralMemoryMcpTools(
  server: McpServer,
  callRuntime: GeneralMemoryRuntimeCall,
  toolResult: GeneralMemoryToolResult,
): void {
  const definitions = new Map(GENERAL_MEMORY_MCP_TOOL_DEFINITIONS.map((definition) => [definition.name, definition]));
  const register = <T extends z.ZodRawShape>(
    name: typeof GENERAL_MEMORY_MCP_TOOL_DEFINITIONS[number]["name"],
    inputSchema: z.ZodObject<T>,
    outputSchema: z.ZodType,
    operation: (input: z.infer<z.ZodObject<T>>) => Parameters<GeneralMemoryRuntimeCall>[0],
  ) => {
    server.registerTool<z.ZodType, z.ZodObject<T>>(name, {
      ...definitions.get(name)!,
      inputSchema,
      outputSchema,
    }, async (input) => (
      toolResult(await callRuntime(operation(input)))
    ));
  };

  register("memory.search", z.object({
    targets: z.array(memoryTargetSchema).min(1).max(5),
    query: z.string().min(1).max(500),
    kinds: z.array(z.enum(MEMORY_ENTRY_KINDS)).max(MEMORY_ENTRY_KINDS.length).optional(),
    tags: z.array(memoryTagInputSchema).max(20).optional(),
    limit: z.number().int().min(1).max(MEMORY_RESULT_LIMIT_MAX).optional(),
    cursor: z.string().min(1).max(500).optional(),
  }).strict(), createMemoryToolOutputSchema(searchSuccessSchema, ["schemaVersion", "items"]), (input) => ({
    method: "POST", path: "/v1/search", body: { schemaVersion: MEMORY_V6_SCHEMA_VERSION, ...input }, operationKind: "read",
  }));

  register("memory.get_entry", z.object({
    entryId: z.string().min(1).max(200),
    target: memoryTargetSchema,
  }).strict(), createMemoryToolOutputSchema(getEntrySuccessSchema, ["schemaVersion", "entry"]), (input) => ({
    method: "POST", path: "/v1/get_entry", body: { schemaVersion: MEMORY_V6_SCHEMA_VERSION, ...input }, operationKind: "read",
  }));

  register("memory.list_targets", z.object({
    owner: z.enum(["project", "character", "user"]).optional(),
    scope: z.enum(["project", "character", "global"]).optional(),
    project: projectRefSchema.optional(),
    character: characterRefSchema.optional(),
    includeEmpty: z.boolean().optional(),
    limit: z.number().int().min(1).max(200).optional(),
    cursor: z.string().min(1).max(500).optional(),
  }).strict(), createMemoryToolOutputSchema(listTargetsSuccessSchema, ["schemaVersion", "items"]), (input) => ({
    method: "POST", path: "/v1/list_targets", body: { schemaVersion: MEMORY_V6_SCHEMA_VERSION, ...input }, operationKind: "read",
  }));

  register("memory.list_entries", z.object({
    target: memoryTargetSchema,
    states: z.array(z.enum(["active", "superseded", "forgotten"])).min(1).max(3).optional(),
    kinds: z.array(z.enum(MEMORY_ENTRY_KINDS)).max(MEMORY_ENTRY_KINDS.length).optional(),
    tags: z.array(memoryTagInputSchema).max(20).optional(),
    includeBody: z.boolean().optional(),
    limit: z.number().int().min(1).max(200).optional(),
    cursor: z.string().min(1).max(500).optional(),
  }).strict(), createMemoryToolOutputSchema(listEntriesSuccessSchema, ["schemaVersion", "items"]), (input) => ({
    method: "POST", path: "/v1/list_entries", body: { schemaVersion: MEMORY_V6_SCHEMA_VERSION, ...input }, operationKind: "read",
  }));

  register("memory.list_tags", z.object({
    targets: z.array(memoryTargetSchema).length(1),
    withCounts: z.boolean().optional(),
    sampleLimit: z.number().int().min(1).max(MEMORY_RESULT_LIMIT_MAX).optional(),
    limit: z.number().int().min(1).max(200).optional(),
    cursor: z.string().min(1).max(500).optional(),
  }).strict().superRefine((input, context) => {
    if (input.sampleLimit !== undefined && input.withCounts !== true) {
      context.addIssue({ code: "custom", path: ["sampleLimit"], message: "sampleLimit requires withCounts=true" });
    }
  }).meta({
    allOf: [{
      if: { required: ["sampleLimit"] },
      then: { properties: { withCounts: { const: true } }, required: ["withCounts"] },
    }],
  }), createMemoryToolOutputSchema(listTagsSuccessSchema, ["schemaVersion", "tags"]), (input) => ({
    method: "POST", path: "/v1/list_tags", body: { schemaVersion: MEMORY_V6_SCHEMA_VERSION, ...input }, operationKind: "read",
  }));

  register("memory.append", z.object({
    target: memoryTargetSchema,
    kind: z.enum(MEMORY_ENTRY_KINDS),
    title: z.string().min(1).max(160),
    body: z.string().min(1).max(8_000),
    preview: z.string().min(1).max(280),
    tags: z.array(memoryTagInputSchema).max(20),
    supersedes: z.array(z.string().min(1).max(200)).max(20).optional(),
    mutationReason: z.string().min(1).max(200).optional(),
    files: z.array(appendFileInputSchema).max(10).optional(),
    sourceMessageId: z.string().min(1).max(200).optional(),
    idempotencyKey: z.string().min(1).max(200),
  }).strict(), createMemoryToolOutputSchema(appendSuccessSchema, ["schemaVersion", "entry", "created"]), (input) => ({
    method: "POST", path: "/v1/append", body: { schemaVersion: MEMORY_V6_SCHEMA_VERSION, ...input }, operationKind: "write",
  }));

  register("memory.forget", z.object({
    target: memoryTargetSchema,
    entryIds: z.array(z.string().min(1).max(200)).min(1).max(50),
    reason: z.enum(MEMORY_FORGET_REASONS),
    sourceMessageId: z.string().min(1).max(200).optional(),
    idempotencyKey: z.string().min(1).max(200),
    dryRun: z.boolean().optional(),
  }).strict(), createMemoryToolOutputSchema(forgetSuccessSchema, ["schemaVersion", "results"]), (input) => ({
    method: "POST", path: "/v1/forget", body: { schemaVersion: MEMORY_V6_SCHEMA_VERSION, ...input }, operationKind: input.dryRun ? "read" : "write",
  }));

  register("memory.move_entry", z.object({
    entryId: z.string().min(1).max(200),
    from: memoryTargetSchema,
    to: memoryTargetSchema,
    reason: z.string().min(1).max(1_000),
    sourceMessageId: z.string().min(1).max(200).optional(),
    idempotencyKey: z.string().min(1).max(200),
  }).strict(), createMemoryToolOutputSchema(moveSuccessSchema, ["schemaVersion", "entry", "moved", "from", "to"]), (input) => ({
    method: "POST", path: "/v1/move_entry", body: { schemaVersion: MEMORY_V6_SCHEMA_VERSION, ...input }, operationKind: "write",
  }));

  register("memory.get_file", z.object({
    target: memoryTargetSchema,
    objectId: z.string().min(1).max(64),
    outputPath: z.string().min(1).max(1_000).regex(/^(?:\/|[A-Za-z]:[\\/]|\\\\)/, "outputPath must be absolute"),
  }).strict(), createMemoryToolOutputSchema(getFileSuccessSchema, ["schemaVersion", "objectId", "entryId", "outputPath", "bytesWritten", "contentType", "displayName"]), (input) => ({
    method: "POST", path: "/v1/get_file", body: { schemaVersion: MEMORY_V6_SCHEMA_VERSION, ...input }, operationKind: "write",
  }));

  register("memory.export_files", z.object({
    target: memoryTargetSchema,
    entryId: z.string().min(1).max(200),
    outputDirectoryPath: z.string().min(1).max(1_000).regex(/^(?:\/|[A-Za-z]:[\\/]|\\\\)/, "outputDirectoryPath must be absolute"),
  }).strict(), createMemoryToolOutputSchema(exportFilesSuccessSchema, ["schemaVersion", "entryId", "outputDirectoryPath", "exportedCount", "files"]), (input) => ({
    method: "POST", path: "/v1/export_files", body: { schemaVersion: MEMORY_V6_SCHEMA_VERSION, ...input }, operationKind: "write",
  }));

  register("memory.file_usage", z.object({
    largest: z.boolean().optional(),
    limit: z.number().int().min(1).max(MEMORY_RESULT_LIMIT_MAX).optional(),
  }).strict(), createMemoryToolOutputSchema(fileUsageSuccessSchema, ["schemaVersion", "quotaBytes", "usedBytes", "physicalBytes", "pendingDeleteBytes", "availableBytes", "objectCount", "pendingDeleteCount", "quotaExceeded"]), (input) => {
    const query = new URLSearchParams();
    if (input.largest === true) {
      query.set("largest", "1");
    }
    if (input.limit !== undefined) {
      query.set("limit", String(input.limit));
    }
    const suffix = query.toString();
    return { method: "GET", path: `/v1/file_usage${suffix ? `?${suffix}` : ""}`, body: {}, operationKind: "read" };
  });
}
