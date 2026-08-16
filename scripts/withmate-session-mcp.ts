import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { APPROVAL_MODE_VALUES } from "../src/approval-mode.js";
import { CODEX_SANDBOX_MODE_VALUES } from "../src/codex-sandbox-mode.js";
import {
  SESSION_TRANSCRIPT_INLINE_HARD_MAX_BYTES,
  SESSION_TRANSCRIPT_FOLDER_HARD_MAX_BYTES,
} from "../src/session-transcript.js";
import {
  SESSION_RUNTIME_DEFAULT_LIST_LIMIT,
  SESSION_RUNTIME_DEFAULT_FILE_TEXT_BYTES,
  SESSION_RUNTIME_MAX_FILE_TEXT_BYTES,
  SESSION_RUNTIME_MAX_LIST_LIMIT,
  SESSION_RUNTIME_MAX_TURN_ATTACHMENTS,
  SESSION_RUNTIME_MAX_WAIT_TIMEOUT_MS,
  SESSION_RUNTIME_ERROR_SCHEMA_VERSION,
  SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
  SESSION_RUNTIME_RESULT_SCHEMA_VERSION,
  SessionRuntimeValidationError,
  createSessionRuntimeError,
  type SessionRuntimeEffect,
  type SessionRuntimeOperation,
  type SessionRuntimeRequestEnvelope,
} from "../src/session-external-runtime-contract.js";
import {
  SessionRuntimeClientError,
  callSessionRuntime,
  discoverSessionRuntime,
  type SessionRuntimeClientResponse,
  type SessionRuntimeConnection,
} from "./withmate-session-runtime-client.js";

type McpRuntimeDeps = {
  env?: NodeJS.ProcessEnv;
  discover?: typeof discoverSessionRuntime;
  call?: typeof callSessionRuntime;
  requestTimeoutMs?: number;
};

const reasoningEffortSchema = z.enum(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
const nonEmptyStringSchema = z.string().trim().min(1);
const runtimeCatalogInputSchema = z.object({}).strict();
const commonTurnShape = {
  userMessage: nonEmptyStringSchema,
  model: nonEmptyStringSchema,
  reasoningEffort: reasoningEffortSchema,
  approvalMode: z.enum(APPROVAL_MODE_VALUES),
  attachments: z.array(z.object({
    kind: z.enum(["file", "folder", "image"]),
    relativePath: nonEmptyStringSchema,
  }).strict()).max(SESSION_RUNTIME_MAX_TURN_ATTACHMENTS),
};
const turnSchema = z.discriminatedUnion("provider", [
  z.object({
    ...commonTurnShape,
    provider: z.literal("codex"),
    codexSandboxMode: z.enum(CODEX_SANDBOX_MODE_VALUES),
  }).strict(),
  z.object({
    ...commonTurnShape,
    provider: z.literal("copilot"),
    customAgentName: z.string(),
  }).strict(),
]);
const mutationBaseShape = {
  sessionId: nonEmptyStringSchema,
  catalogRevision: z.number().int().min(1),
  idempotencyKey: nonEmptyStringSchema,
  turn: turnSchema,
};
const runInputSchema = z.object({
  ...mutationBaseShape,
  responseMode: z.enum(["wait", "deferred"]),
  waitTimeoutMs: z.number().int().min(1).max(SESSION_RUNTIME_MAX_WAIT_TIMEOUT_MS).optional(),
}).strict().superRefine((value, context) => {
  if (value.responseMode === "deferred" && value.waitTimeoutMs !== undefined) {
    context.addIssue({ code: "custom", path: ["waitTimeoutMs"], message: "waitTimeoutMs is only valid for wait mode." });
  }
});
const enqueueInputSchema = z.object(mutationBaseShape).strict();
const executionInputSchema = z.object({
  sessionId: nonEmptyStringSchema,
  executionId: nonEmptyStringSchema,
}).strict();
const cancelInputSchema = z.object({
  sessionId: nonEmptyStringSchema,
  executionId: nonEmptyStringSchema,
  idempotencyKey: nonEmptyStringSchema,
}).strict();
const listInputSchema = z.object({
  sessionId: nonEmptyStringSchema,
  limit: z.number().int().min(1).max(SESSION_RUNTIME_MAX_LIST_LIMIT).default(SESSION_RUNTIME_DEFAULT_LIST_LIMIT),
  cursor: nonEmptyStringSchema.optional(),
}).strict();
const interactionListInputSchema = z.object({
  sessionId: nonEmptyStringSchema,
  executionId: nonEmptyStringSchema.optional(),
  kind: z.enum(["approval", "elicitation"]).optional(),
  state: z.enum(["pending", "answered", "expired"]).optional(),
  limit: z.number().int().min(1).max(SESSION_RUNTIME_MAX_LIST_LIMIT).default(SESSION_RUNTIME_DEFAULT_LIST_LIMIT),
  cursor: nonEmptyStringSchema.optional(),
}).strict();
const elicitationValueSchema = z.union([
  z.string(), z.number(), z.boolean(), z.array(z.string()),
]);
const interactionRespondInputSchema = z.object({
  sessionId: nonEmptyStringSchema,
  executionId: nonEmptyStringSchema,
  interactionId: nonEmptyStringSchema,
  response: z.union([
    z.object({ kind: z.literal("approval"), decision: z.enum(["approve", "deny"]) }).strict(),
    z.object({
      kind: z.literal("elicitation"),
      action: z.literal("accept"),
      content: z.record(z.string().min(1), elicitationValueSchema),
    }).strict(),
    z.object({ kind: z.literal("elicitation"), action: z.enum(["decline", "cancel"]) }).strict(),
  ]),
  idempotencyKey: nonEmptyStringSchema,
  responseMode: z.enum(["wait", "deferred"]),
  waitTimeoutMs: z.number().int().min(1).max(SESSION_RUNTIME_MAX_WAIT_TIMEOUT_MS).optional(),
}).strict().superRefine((value, context) => {
  if (value.responseMode === "deferred" && value.waitTimeoutMs !== undefined) {
    context.addIssue({ code: "custom", path: ["waitTimeoutMs"], message: "waitTimeoutMs is only valid for wait mode." });
  }
});
const sessionCreateInputSchema = z.object({
  title: nonEmptyStringSchema,
  provider: z.enum(["codex", "copilot"]),
  catalogRevision: z.number().int().min(1),
  workspace: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("directory"), path: nonEmptyStringSchema }).strict(),
    z.object({ kind: z.literal("session_folder") }).strict(),
  ]),
  idempotencyKey: nonEmptyStringSchema,
}).strict();
const sessionListInputSchema = z.object({
  limit: z.number().int().min(1).max(SESSION_RUNTIME_MAX_LIST_LIMIT).default(SESSION_RUNTIME_DEFAULT_LIST_LIMIT),
  cursor: nonEmptyStringSchema.optional(),
}).strict();
const sessionGetInputSchema = z.object({ sessionId: nonEmptyStringSchema }).strict();
const sessionRenameInputSchema = z.object({
  sessionId: nonEmptyStringSchema,
  title: nonEmptyStringSchema,
  idempotencyKey: nonEmptyStringSchema,
}).strict();
const sessionFileListInputSchema = z.object({
  sessionId: nonEmptyStringSchema,
  limit: z.number().int().min(1).max(SESSION_RUNTIME_MAX_LIST_LIMIT).default(SESSION_RUNTIME_DEFAULT_LIST_LIMIT),
  cursor: nonEmptyStringSchema.optional(),
}).strict();
const sessionFileReadTextInputSchema = z.object({
  sessionId: nonEmptyStringSchema,
  relativePath: nonEmptyStringSchema,
  maxBytes: z.number().int().min(1).max(SESSION_RUNTIME_MAX_FILE_TEXT_BYTES)
    .default(SESSION_RUNTIME_DEFAULT_FILE_TEXT_BYTES),
}).strict();
const sessionFileWriteTextInputSchema = z.object({
  sessionId: nonEmptyStringSchema,
  relativePath: nonEmptyStringSchema,
  content: z.string(),
  maxBytes: z.number().int().min(1).max(SESSION_RUNTIME_MAX_FILE_TEXT_BYTES)
    .default(SESSION_RUNTIME_DEFAULT_FILE_TEXT_BYTES),
  replace: z.boolean().default(false),
  idempotencyKey: nonEmptyStringSchema,
}).strict().superRefine((value, context) => {
  const actualBytes = Buffer.byteLength(value.content, "utf8");
  if (actualBytes > value.maxBytes) {
    context.addIssue({
      code: "custom",
      path: ["content"],
      message: `content exceeds maxBytes (${actualBytes} > ${value.maxBytes}).`,
    });
  }
});
const transcriptExportInputSchema = z.object({
  sessionId: nonEmptyStringSchema,
  format: z.enum(["json", "markdown"]),
  maxBytes: z.number().int().min(1).max(SESSION_TRANSCRIPT_FOLDER_HARD_MAX_BYTES).optional(),
  destination: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("inline") }).strict(),
    z.object({ kind: z.literal("session_folder"), relativePath: nonEmptyStringSchema, replace: z.boolean().default(false), idempotencyKey: nonEmptyStringSchema }).strict(),
  ]),
}).strict().superRefine((value, context) => {
  const hardMax = value.destination.kind === "inline" ? SESSION_TRANSCRIPT_INLINE_HARD_MAX_BYTES : SESSION_TRANSCRIPT_FOLDER_HARD_MAX_BYTES;
  if (value.maxBytes !== undefined && value.maxBytes > hardMax) context.addIssue({ code: "custom", path: ["maxBytes"], message: `maxBytes exceeds destination limit (${value.maxBytes} > ${hardMax}).` });
});
const publicDetailsSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));
const errorSchema = z.object({
  schemaVersion: z.literal(SESSION_RUNTIME_ERROR_SCHEMA_VERSION),
  error: z.object({
    code: z.string(),
    message: z.string(),
    retryable: z.boolean(),
    effect: z.enum(["not_applied", "applied", "indeterminate"]),
    details: publicDetailsSchema,
  }).strict(),
}).strict();

const modelSchema = z.object({
  id: z.string(),
  label: z.string(),
  reasoningEfforts: z.array(reasoningEffortSchema),
}).strict();
const characterSchema = z.object({ id: z.string(), name: z.string() }).strict();
const workspaceSchema = z.object({
  kind: z.enum(["directory", "session_folder"]),
  label: z.string(),
  path: z.string(),
}).strict();
const sessionSummarySchema = z.object({
  sessionId: z.string(),
  title: z.string(),
  sessionKind: z.literal("default"),
  provider: z.object({ id: z.string(), catalogRevision: z.number().int() }).strict(),
  character: characterSchema,
  workspace: workspaceSchema,
  updatedAt: z.string(),
}).strict();
const sessionDetailSchema = sessionSummarySchema.extend({
  sessionFolder: z.object({ path: z.string(), isWorkspace: z.boolean() }).strict(),
}).strict();
const sessionGetSchema = sessionDetailSchema.omit({ workspace: true }).extend({
  workspace: workspaceSchema.extend({ branch: z.string().nullable() }).strict(),
}).strict();
const fileReferenceSchema = z.object({
  sessionId: z.string(),
  relativePath: z.string(),
  byteLength: z.number().int().nonnegative(),
  modifiedAt: z.string(),
}).strict();
const effectiveTurnSchema = z.discriminatedUnion("provider", [
  z.object({
    provider: z.literal("codex"),
    model: z.string(),
    reasoningEffort: reasoningEffortSchema,
    approvalMode: z.enum(APPROVAL_MODE_VALUES),
    sandboxMode: z.enum(CODEX_SANDBOX_MODE_VALUES),
    customAgentName: z.null(),
  }).strict(),
  z.object({
    provider: z.literal("copilot"),
    model: z.string(),
    reasoningEffort: reasoningEffortSchema,
    approvalMode: z.enum(APPROVAL_MODE_VALUES),
    sandboxMode: z.null(),
    customAgentName: z.string(),
  }).strict(),
]);
function createExecutionSchema(operation: z.ZodType<"turn.run" | "turn.enqueue">) {
  return z.object({
    id: z.string(),
    sessionId: z.string(),
    operation,
    state: z.enum(["queued", "running", "completed", "failed", "canceled", "interrupted"]),
    result: z.object({ assistantText: z.string() }).strict().nullable(),
    errorCode: z.string(),
    reason: z.string(),
    createdAt: z.string(),
    admittedAt: z.string().nullable(),
    completedAt: z.string().nullable(),
    updatedAt: z.string(),
    effectiveTurn: effectiveTurnSchema.nullable(),
    attachments: z.array(z.object({
      kind: z.enum(["file", "folder", "image"]), relativePath: z.string(),
    }).strict()),
    pendingInteraction: z.lazy(() => interactionSchema).nullable(),
    partialOutput: z.object({
      assistantText: z.string(), truncated: z.boolean(), updatedAt: z.string(),
    }).strict().nullable(),
  }).strict();
}
const elicitationFieldBase = {
  name: z.string(), title: z.string(), description: z.string().optional(), required: z.boolean(),
};
const elicitationFieldSchema = z.discriminatedUnion("type", [
  z.object({
    ...elicitationFieldBase, type: z.literal("select"),
    options: z.array(z.object({ value: z.string(), label: z.string() }).strict()),
    defaultValue: z.string().optional(),
  }).strict(),
  z.object({
    ...elicitationFieldBase, type: z.literal("multi-select"),
    options: z.array(z.object({ value: z.string(), label: z.string() }).strict()),
    defaultValue: z.array(z.string()).optional(), minItems: z.number().int().nonnegative().optional(),
    maxItems: z.number().int().nonnegative().optional(),
  }).strict(),
  z.object({ ...elicitationFieldBase, type: z.literal("boolean"), defaultValue: z.boolean().optional() }).strict(),
  z.object({
    ...elicitationFieldBase, type: z.literal("text"), defaultValue: z.string().optional(),
    minLength: z.number().int().nonnegative().optional(), maxLength: z.number().int().nonnegative().optional(),
    format: z.enum(["email", "uri", "date", "date-time"]).optional(),
  }).strict(),
  z.object({
    ...elicitationFieldBase, type: z.literal("number"), numberKind: z.enum(["number", "integer"]),
    defaultValue: z.number().optional(), minimum: z.number().optional(), maximum: z.number().optional(),
  }).strict(),
]);
const approvalRequestSchema = z.object({
  title: z.string(), summary: z.string(), details: z.string().optional(), warning: z.string().optional(),
}).strict();
const elicitationRequestSchema = z.object({
  mode: z.enum(["form", "url"]), message: z.string(), fields: z.array(elicitationFieldSchema), url: z.string().optional(),
}).strict();
const interactionIdentityShape = {
  sequence: z.number().int().positive(), interactionId: z.string(), sessionId: z.string(), executionId: z.string(),
  createdAt: z.string(), updatedAt: z.string(),
};
const approvalInteractionShape = { kind: z.literal("approval"), request: approvalRequestSchema };
const elicitationInteractionShape = { kind: z.literal("elicitation"), request: elicitationRequestSchema };
const pendingInteractionSchema = z.union([
  z.object({ ...interactionIdentityShape, ...approvalInteractionShape, state: z.literal("pending"), resolution: z.null() }).strict(),
  z.object({ ...interactionIdentityShape, ...elicitationInteractionShape, state: z.literal("pending"), resolution: z.null() }).strict(),
]);
const answeredInteractionSchema = z.union([
  z.object({
    ...interactionIdentityShape,
    ...approvalInteractionShape,
    state: z.literal("answered"),
    resolution: z.object({
      action: z.enum(["approve", "deny"]), submittedFields: z.tuple([]), resolvedAt: z.string(),
    }).strict(),
  }).strict(),
  z.object({
    ...interactionIdentityShape,
    ...elicitationInteractionShape,
    state: z.literal("answered"),
    resolution: z.object({
      action: z.enum(["accept", "decline", "cancel"]), submittedFields: z.array(z.string()), resolvedAt: z.string(),
    }).strict(),
  }).strict(),
]);
const expiredResolutionSchema = z.object({
  reason: z.enum(["runtime_restarted", "runtime_shutdown", "execution_canceled", "execution_terminal"]),
  resolvedAt: z.string(),
}).strict();
const expiredInteractionSchema = z.union([
  z.object({
    ...interactionIdentityShape, ...approvalInteractionShape, state: z.literal("expired"), resolution: expiredResolutionSchema,
  }).strict(),
  z.object({
    ...interactionIdentityShape, ...elicitationInteractionShape, state: z.literal("expired"), resolution: expiredResolutionSchema,
  }).strict(),
]);
const interactionSchema = z.union([
  pendingInteractionSchema,
  answeredInteractionSchema,
  expiredInteractionSchema,
]);
const runExecutionSchema = createExecutionSchema(z.literal("turn.run"));
const enqueueExecutionSchema = createExecutionSchema(z.literal("turn.enqueue"));
const executionSchema = createExecutionSchema(z.enum(["turn.run", "turn.enqueue"]));
const turnOptionsSchema = z.union([
  z.object({
    sessionId: z.string(),
    provider: z.object({ id: z.literal("codex") }).strict(),
    catalogRevision: z.number().int(),
    models: z.array(modelSchema),
    approvalModes: z.array(z.object({ id: z.enum(APPROVAL_MODE_VALUES), label: z.string() }).strict()),
    codexSandboxModes: z.array(z.object({ id: z.enum(CODEX_SANDBOX_MODE_VALUES), label: z.string() }).strict()),
  }).strict(),
  z.object({
    sessionId: z.string(),
    provider: z.object({ id: z.literal("copilot") }).strict(),
    catalogRevision: z.number().int(),
    models: z.array(modelSchema),
    approvalModes: z.array(z.object({ id: z.enum(APPROVAL_MODE_VALUES), label: z.string() }).strict()),
    customAgents: z.array(z.object({
      name: z.string(),
      displayName: z.string(),
      description: z.string(),
    }).strict()),
  }).strict(),
]);
const resultSchemas: Record<SessionRuntimeOperation, z.ZodType> = {
  "runtime.catalog": z.object({
    revision: z.number().int(),
    providers: z.array(z.object({
      id: z.string(),
      label: z.string(),
      defaultModelId: z.string(),
      defaultReasoningEffort: reasoningEffortSchema,
      models: z.array(modelSchema),
    }).strict()),
  }).strict(),
  "session.self": z.object({ sessionId: z.string() }).strict(),
  "session.create": sessionDetailSchema,
  "session.list": z.object({ items: z.array(sessionSummarySchema), nextCursor: z.string().optional() }).strict(),
  "session.get": sessionGetSchema,
  "session.rename": sessionDetailSchema,
  "session.files.list": z.object({ items: z.array(fileReferenceSchema), nextCursor: z.string().optional() }).strict(),
  "session.files.read_text": z.object({ file: fileReferenceSchema, content: z.string() }).strict(),
  "session.files.write_text": z.object({ file: fileReferenceSchema }).strict(),
  "turn.options": turnOptionsSchema,
  "turn.run": runExecutionSchema,
  "turn.enqueue": enqueueExecutionSchema,
  "turn.list": z.object({ items: z.array(executionSchema), nextCursor: z.string().optional() }).strict(),
  "turn.get": executionSchema,
  "turn.cancel": executionSchema,
  "interaction.list": z.object({ items: z.array(interactionSchema), nextCursor: z.string().optional() }).strict(),
  "interaction.respond": z.object({ interaction: answeredInteractionSchema, execution: executionSchema }).strict(),
  "transcript.export": z.discriminatedUnion("destination", [
    z.object({ destination: z.literal("inline"), format: z.enum(["json", "markdown"]), byteLength: z.number().int(), content: z.string() }).strict(),
    z.object({
      destination: z.literal("session_folder"),
      format: z.enum(["json", "markdown"]),
      file: z.object({ sessionId: z.string(), relativePath: z.string(), byteLength: z.number().int(), modifiedAt: z.string(), sha256: z.string() }).strict(),
    }).strict(),
  ]),
};

function createSuccessSchema(operation: SessionRuntimeOperation) {
  return z.object({
    schemaVersion: z.literal(SESSION_RUNTIME_RESULT_SCHEMA_VERSION),
    operation: z.literal(operation),
    result: resultSchemas[operation],
  }).strict();
}

function createOutputSchema(operation: SessionRuntimeOperation) {
  // MCP outputSchema describes successful structured output. Tool errors are
  // returned with isError=true and are intentionally excluded from SDK output
  // validation, while safeRuntimeError validates their public envelope.
  return createSuccessSchema(operation);
}

export const SESSION_MCP_SERVER_INSTRUCTIONS = [
  "Use session.self only to resolve the bound actor Session; keep every target of other Session operations explicit.",
  "Generate, retain, and reuse the same caller-owned idempotency key when retrying effect-bearing operations.",
  "A failed terminal execution is a successful tool result; inspect execution.state and errorCode.",
].join(" ");

export const SESSION_MCP_TOOL_DEFINITIONS = [
  { name: "runtime.catalog", title: "Get runtime catalog", description: "Read the current public Provider and model catalog.", readOnly: true, destructive: false },
  { name: "session.self", title: "Resolve actor Session", description: "Resolve the current provider actor Session from its runtime binding.", readOnly: true, destructive: false },
  { name: "session.create", title: "Create Session", description: "Create a normal Session with an explicit workspace.", readOnly: false, destructive: false },
  { name: "session.list", title: "List Sessions", description: "List normal Sessions with keyset pagination.", readOnly: true, destructive: false },
  { name: "session.get", title: "Get Session", description: "Read one normal Session.", readOnly: true, destructive: false },
  { name: "session.rename", title: "Rename Session", description: "Rename one normal Session.", readOnly: false, destructive: false },
  { name: "session.files.list", title: "List Session files", description: "List UTF-8-capable files in one SessionFolder.", readOnly: true, destructive: false },
  { name: "session.files.read_text", title: "Read Session text file", description: "Read one bounded UTF-8 text file from a SessionFolder.", readOnly: true, destructive: false },
  { name: "session.files.write_text", title: "Write Session text file", description: "Atomically write one bounded UTF-8 text file to a SessionFolder.", readOnly: false, destructive: true },
  { name: "turn.options", title: "Get Session turn options", description: "Read valid turn options for one normal Session.", readOnly: true, destructive: false },
  { name: "turn.run", title: "Run Session turn", description: "Start one turn immediately in the specified Session.", readOnly: false, destructive: true },
  { name: "turn.enqueue", title: "Enqueue Session turn", description: "Append one turn to the specified Session FIFO queue.", readOnly: false, destructive: true },
  { name: "turn.list", title: "List Session executions", description: "List execution records for the specified Session.", readOnly: true, destructive: false },
  { name: "turn.get", title: "Get Session execution", description: "Read one execution from the specified Session.", readOnly: true, destructive: false },
  { name: "turn.cancel", title: "Cancel Session execution", description: "Cancel one queued or running execution in the specified Session.", readOnly: false, destructive: true },
  { name: "interaction.list", title: "List Session interactions", description: "List public interactions for the specified Session.", readOnly: true, destructive: false },
  { name: "interaction.respond", title: "Respond to Session interaction", description: "Resolve one pending interaction in the specified execution.", readOnly: false, destructive: true },
  { name: "transcript.export", title: "Export Session transcript", description: "Export a Session transcript inline or into its SessionFolder.", readOnly: false, destructive: true },
] as const;

function annotations(definition: (typeof SESSION_MCP_TOOL_DEFINITIONS)[number]) {
  return {
    readOnlyHint: definition.readOnly,
    destructiveHint: definition.destructive,
    idempotentHint: true,
    openWorldHint: definition.name === "turn.run" || definition.name === "turn.enqueue"
      || definition.name === "interaction.respond" || definition.name === "transcript.export",
  };
}

function isMutation(operation: SessionRuntimeOperation, input?: unknown): boolean {
  return operation === "session.create" || operation === "session.rename"
    || operation === "session.files.write_text"
    || operation === "turn.run" || operation === "turn.enqueue" || operation === "turn.cancel"
    || operation === "interaction.respond"
    || (operation === "transcript.export"
      && (input === undefined || (input as { destination?: { kind?: string } }).destination?.kind !== "inline"));
}

function safeRuntimeError(value: unknown): ReturnType<typeof createSessionRuntimeError> | null {
  const parsed = errorSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function safeRuntimeResult(operation: SessionRuntimeOperation, response: SessionRuntimeClientResponse): Record<string, unknown> | null {
  const parsed = createSuccessSchema(operation).safeParse(response.value);
  return parsed.success ? parsed.data : null;
}

function toolResult(value: Record<string, unknown>, isError: boolean) {
  if (isError) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify(value) }],
      isError: true as const,
    };
  }
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

async function executeOperation(
  operation: SessionRuntimeOperation,
  input: unknown,
  deps: McpRuntimeDeps,
) {
  let connection: SessionRuntimeConnection | null;
  try {
    connection = await (deps.discover ?? discoverSessionRuntime)({ adapter: "mcp", env: deps.env });
  } catch {
    connection = null;
  }
  if (!connection) {
    return toolResult(createSessionRuntimeError({
      code: "RUNTIME_UNAVAILABLE",
      message: "WithMate Session runtime is not running.",
      retryable: true,
    }), true);
  }

  const envelope: SessionRuntimeRequestEnvelope = {
    schemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
    operation,
    input,
  };
  try {
    const response = await (deps.call ?? callSessionRuntime)(
      connection,
      envelope,
      AbortSignal.timeout(deps.requestTimeoutMs ?? 305_000),
    );
    const applicationError = safeRuntimeError(response.value);
    if (applicationError) return toolResult(applicationError, true);
    const result = safeRuntimeResult(operation, response);
    if (result) return toolResult(result, false);
    return toolResult(createTransportError(operation, input, true, "Session runtime returned an invalid public response."), true);
  } catch (error) {
    if (error instanceof SessionRuntimeValidationError) {
      return toolResult(createSessionRuntimeError({
        code: error.code,
        message: error.message,
        effect: "not_applied",
        details: error.details,
      }), true);
    }
    const dispatched = error instanceof SessionRuntimeClientError && error.dispatched;
    return toolResult(createTransportError(operation, input, dispatched, dispatched
      ? "Session runtime response was not received after dispatch."
      : "Session runtime is unavailable."), true);
  }
}

function createTransportError(
  operation: SessionRuntimeOperation,
  input: unknown,
  dispatched: boolean,
  message: string,
): ReturnType<typeof createSessionRuntimeError> {
  const effect: SessionRuntimeEffect = dispatched && isMutation(operation, input) ? "indeterminate" : "not_applied";
  return createSessionRuntimeError({ code: "RUNTIME_UNAVAILABLE", message, retryable: true, effect });
}

export function createWithMateSessionMcpServer(deps: McpRuntimeDeps = {}): McpServer {
  const server = new McpServer(
    { name: "withmate-session", version: "1.0.0" },
    { instructions: SESSION_MCP_SERVER_INSTRUCTIONS },
  );
  const definitions = new Map(SESSION_MCP_TOOL_DEFINITIONS.map((definition) => [definition.name, definition]));

  server.registerTool("runtime.catalog", {
    ...definitions.get("runtime.catalog")!,
    annotations: annotations(definitions.get("runtime.catalog")!),
    inputSchema: runtimeCatalogInputSchema,
    outputSchema: createOutputSchema("runtime.catalog"),
  }, async (input) => executeOperation("runtime.catalog", input, deps));
  server.registerTool("session.self", {
    ...definitions.get("session.self")!,
    annotations: annotations(definitions.get("session.self")!),
    inputSchema: runtimeCatalogInputSchema,
    outputSchema: createOutputSchema("session.self"),
  }, async (input) => executeOperation("session.self", input, deps));
  server.registerTool("session.create", {
    ...definitions.get("session.create")!,
    annotations: annotations(definitions.get("session.create")!),
    inputSchema: sessionCreateInputSchema,
    outputSchema: createOutputSchema("session.create"),
  }, async (input) => executeOperation("session.create", input, deps));
  server.registerTool("session.list", {
    ...definitions.get("session.list")!,
    annotations: annotations(definitions.get("session.list")!),
    inputSchema: sessionListInputSchema,
    outputSchema: createOutputSchema("session.list"),
  }, async (input) => executeOperation("session.list", input, deps));
  server.registerTool("session.get", {
    ...definitions.get("session.get")!,
    annotations: annotations(definitions.get("session.get")!),
    inputSchema: sessionGetInputSchema,
    outputSchema: createOutputSchema("session.get"),
  }, async (input) => executeOperation("session.get", input, deps));
  server.registerTool("session.rename", {
    ...definitions.get("session.rename")!,
    annotations: annotations(definitions.get("session.rename")!),
    inputSchema: sessionRenameInputSchema,
    outputSchema: createOutputSchema("session.rename"),
  }, async (input) => executeOperation("session.rename", input, deps));
  server.registerTool("session.files.list", {
    ...definitions.get("session.files.list")!,
    annotations: annotations(definitions.get("session.files.list")!),
    inputSchema: sessionFileListInputSchema,
    outputSchema: createOutputSchema("session.files.list"),
  }, async (input) => executeOperation("session.files.list", input, deps));
  server.registerTool("session.files.read_text", {
    ...definitions.get("session.files.read_text")!,
    annotations: annotations(definitions.get("session.files.read_text")!),
    inputSchema: sessionFileReadTextInputSchema,
    outputSchema: createOutputSchema("session.files.read_text"),
  }, async (input) => executeOperation("session.files.read_text", input, deps));
  server.registerTool("session.files.write_text", {
    ...definitions.get("session.files.write_text")!,
    annotations: annotations(definitions.get("session.files.write_text")!),
    inputSchema: sessionFileWriteTextInputSchema,
    outputSchema: createOutputSchema("session.files.write_text"),
  }, async (input) => executeOperation("session.files.write_text", input, deps));
  server.registerTool("turn.options", {
    ...definitions.get("turn.options")!,
    annotations: annotations(definitions.get("turn.options")!),
    inputSchema: sessionGetInputSchema,
    outputSchema: createOutputSchema("turn.options"),
  }, async (input) => executeOperation("turn.options", input, deps));
  server.registerTool("turn.run", {
    ...definitions.get("turn.run")!,
    annotations: annotations(definitions.get("turn.run")!),
    inputSchema: runInputSchema,
    outputSchema: createOutputSchema("turn.run"),
  }, async (input) => executeOperation("turn.run", input, deps));
  server.registerTool("turn.enqueue", {
    ...definitions.get("turn.enqueue")!,
    annotations: annotations(definitions.get("turn.enqueue")!),
    inputSchema: enqueueInputSchema,
    outputSchema: createOutputSchema("turn.enqueue"),
  }, async (input) => executeOperation("turn.enqueue", input, deps));
  server.registerTool("turn.list", {
    ...definitions.get("turn.list")!,
    annotations: annotations(definitions.get("turn.list")!),
    inputSchema: listInputSchema,
    outputSchema: createOutputSchema("turn.list"),
  }, async (input) => executeOperation("turn.list", input, deps));
  server.registerTool("turn.get", {
    ...definitions.get("turn.get")!,
    annotations: annotations(definitions.get("turn.get")!),
    inputSchema: executionInputSchema,
    outputSchema: createOutputSchema("turn.get"),
  }, async (input) => executeOperation("turn.get", input, deps));
  server.registerTool("turn.cancel", {
    ...definitions.get("turn.cancel")!,
    annotations: annotations(definitions.get("turn.cancel")!),
    inputSchema: cancelInputSchema,
    outputSchema: createOutputSchema("turn.cancel"),
  }, async (input) => executeOperation("turn.cancel", input, deps));
  server.registerTool("interaction.list", {
    ...definitions.get("interaction.list")!,
    annotations: annotations(definitions.get("interaction.list")!),
    inputSchema: interactionListInputSchema,
    outputSchema: createOutputSchema("interaction.list"),
  }, async (input) => executeOperation("interaction.list", input, deps));
  server.registerTool("interaction.respond", {
    ...definitions.get("interaction.respond")!,
    annotations: annotations(definitions.get("interaction.respond")!),
    inputSchema: interactionRespondInputSchema,
    outputSchema: createOutputSchema("interaction.respond"),
  }, async (input) => executeOperation("interaction.respond", input, deps));
  server.registerTool("transcript.export", {
    ...definitions.get("transcript.export")!,
    annotations: annotations(definitions.get("transcript.export")!),
    inputSchema: transcriptExportInputSchema,
    outputSchema: createOutputSchema("transcript.export"),
  }, async (input) => executeOperation("transcript.export", input, deps));

  return server;
}

export async function startWithMateSessionMcpServer(deps: McpRuntimeDeps = {}): Promise<McpServer> {
  const server = createWithMateSessionMcpServer(deps);
  await server.connect(new StdioServerTransport());
  return server;
}
