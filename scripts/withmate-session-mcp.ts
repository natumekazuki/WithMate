import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { APPROVAL_MODE_VALUES } from "../src/approval-mode.js";
import { CODEX_SANDBOX_MODE_VALUES } from "../src/codex-sandbox-mode.js";
import {
  COORDINATION_EVENT_DEFAULT_LIST_LIMIT,
  COORDINATION_EVENT_KINDS,
  COORDINATION_EVENT_MAX_LIST_LIMIT,
  COORDINATION_EVENT_STATES,
} from "../src/coordination-event.js";
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
  terminalFailureNotification: z.object({
    targetSessionId: nonEmptyStringSchema,
  }).strict().optional(),
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
  sessionRole: z.enum(["task-coordinator", "executor"]),
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
const coordinationPayloadSchema = z.object({
  summary: z.string().trim().min(1).max(240),
  facts: z.array(z.string().trim().min(1).max(500)).max(8).optional(),
  assumptions: z.array(z.string().trim().min(1).max(500)).max(8).optional(),
  impact: z.string().trim().min(1).max(1_000).optional(),
  recommendation: z.string().trim().min(1).max(1_000).optional(),
}).strict();
const coordinationOptionSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/).max(80),
  label: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(500).optional(),
}).strict();
const coordinationCreateInputSchema = z.object({
  kind: z.enum(COORDINATION_EVENT_KINDS).exclude(["correction"]),
  payload: coordinationPayloadSchema,
  executionId: nonEmptyStringSchema.optional(),
  targetSessionId: nonEmptyStringSchema.optional(),
  options: z.array(coordinationOptionSchema).min(2).max(8).optional(),
  idempotencyKey: nonEmptyStringSchema,
}).strict().superRefine((value, context) => {
  if ((value.kind === "escalation") !== (value.targetSessionId !== undefined)) {
    context.addIssue({ code: "custom", path: ["targetSessionId"], message: "targetSessionId is required only for escalation events." });
  }
  if ((value.kind === "user_decision_required") !== (value.options !== undefined)) {
    context.addIssue({ code: "custom", path: ["options"], message: "options are required only for user_decision_required events." });
  }
  if (value.options && new Set(value.options.map((option) => option.id)).size !== value.options.length) {
    context.addIssue({ code: "custom", path: ["options"], message: "option IDs must be unique." });
  }
});
const coordinationListInputSchema = z.object({
  scope: z.enum(["self", "subtree"]),
  kind: z.enum(COORDINATION_EVENT_KINDS).optional(),
  state: z.enum(COORDINATION_EVENT_STATES).optional(),
  limit: z.number().int().min(1).max(COORDINATION_EVENT_MAX_LIST_LIMIT).default(COORDINATION_EVENT_DEFAULT_LIST_LIMIT),
  cursor: nonEmptyStringSchema.optional(),
}).strict();
const coordinationGetInputSchema = z.object({
  eventId: nonEmptyStringSchema.optional(),
  idempotencyKey: nonEmptyStringSchema.optional(),
}).strict().superRefine((value, context) => {
  if ((value.eventId !== undefined) === (value.idempotencyKey !== undefined)) {
    context.addIssue({ code: "custom", path: [], message: "Exactly one of eventId or idempotencyKey is required." });
  }
});
const coordinationResolveInputSchema = z.object({
  eventId: nonEmptyStringSchema,
  note: z.string().trim().min(1).max(1_000).optional(),
  idempotencyKey: nonEmptyStringSchema,
}).strict();
const coordinationConsumeInputSchema = z.object({
  eventId: nonEmptyStringSchema,
  expectedResolutionSequence: z.number().int().positive(),
  idempotencyKey: nonEmptyStringSchema,
}).strict();
const coordinationCancelInputSchema = z.object({
  eventId: nonEmptyStringSchema,
  note: z.string().trim().min(1).max(1_000).optional(),
  idempotencyKey: nonEmptyStringSchema,
}).strict();
const coordinationCorrectInputSchema = z.object({
  eventId: nonEmptyStringSchema,
  payload: coordinationPayloadSchema,
  executionId: nonEmptyStringSchema.optional(),
  idempotencyKey: nonEmptyStringSchema,
}).strict();
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
const sessionRoleSchema = z.enum(["standalone", "overall-coordinator", "task-coordinator", "executor"]);
const sessionRoleBindingShape = {
  sessionRole: sessionRoleSchema,
  roleContractRevision: z.literal(1),
  rootSessionId: z.string(),
  parentSessionId: z.string().nullable(),
  delegationDepth: z.number().int().min(0).max(2),
};
const sessionSummarySchema = z.object({
  ...sessionRoleBindingShape,
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
    terminalFailureNotification: z.object({
      targetSessionId: z.string(),
      state: z.enum(["armed", "pending", "enqueued", "failed", "not_triggered"]),
      notificationExecutionId: z.string().nullable(),
      errorCode: z.string().nullable(),
      updatedAt: z.string(),
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
const coordinationSummarySchema = z.object({
  sequence: z.number().int().positive(),
  eventId: z.string(),
  actorSessionId: z.string(),
  sessionRole: sessionRoleSchema,
  kind: z.enum(COORDINATION_EVENT_KINDS),
  state: z.enum(COORDINATION_EVENT_STATES),
  summary: z.string(),
  createdAt: z.string(),
}).strict();
const coordinationActionSchema = z.object({
  sequence: z.number().int().positive(),
  type: z.enum(["resolved", "cancelled", "superseded", "consumed"]),
  actorType: z.enum(["session", "trusted_gui"]),
  actorSessionId: z.string().nullable(),
  optionId: z.string().nullable(),
  note: z.string().nullable(),
  relatedEventId: z.string().nullable(),
  createdAt: z.string(),
}).strict();
const coordinationEventSchema = coordinationSummarySchema.extend({
  roleContractRevision: z.literal(1),
  rootSessionId: z.string(),
  parentSessionId: z.string().nullable(),
  delegationDepth: z.number().int().min(0).max(2),
  payload: coordinationPayloadSchema,
  executionId: z.string().nullable(),
  targetSessionId: z.string().nullable(),
  correctedEventId: z.string().nullable(),
  options: z.array(coordinationOptionSchema),
  actions: z.array(coordinationActionSchema),
}).strict();
const resultSchemas: Record<SessionRuntimeOperation, z.ZodType> = {
  "runtime.catalog": z.object({
    revision: z.number().int(),
    sessionRoleContractRevision: z.literal(1),
    supportedSessionRoles: z.array(sessionRoleSchema),
    allowedChildSessionRoles: z.object({
      standalone: z.array(z.enum(["task-coordinator", "executor"])),
      "overall-coordinator": z.array(z.enum(["task-coordinator", "executor"])),
      "task-coordinator": z.array(z.enum(["task-coordinator", "executor"])),
      executor: z.array(z.enum(["task-coordinator", "executor"])),
    }).strict(),
    maxDelegationDepth: z.literal(2),
    coordinationEvents: z.object({
      kinds: z.tuple(COORDINATION_EVENT_KINDS.map((kind) => z.literal(kind)) as [z.ZodLiteral<(typeof COORDINATION_EVENT_KINDS)[number]>, ...z.ZodLiteral<(typeof COORDINATION_EVENT_KINDS)[number]>[]]),
      states: z.tuple(COORDINATION_EVENT_STATES.map((state) => z.literal(state)) as [z.ZodLiteral<(typeof COORDINATION_EVENT_STATES)[number]>, ...z.ZodLiteral<(typeof COORDINATION_EVENT_STATES)[number]>[]]),
      scopes: z.tuple([z.literal("self"), z.literal("subtree")]),
      defaultListLimit: z.literal(COORDINATION_EVENT_DEFAULT_LIST_LIMIT),
      maxListLimit: z.literal(COORDINATION_EVENT_MAX_LIST_LIMIT),
    }).strict(),
    providers: z.array(z.object({
      id: z.string(),
      label: z.string(),
      defaultModelId: z.string(),
      defaultReasoningEffort: reasoningEffortSchema,
      models: z.array(modelSchema),
    }).strict()),
  }).strict(),
  "session.self": z.object({ sessionId: z.string(), ...sessionRoleBindingShape }).strict(),
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
  "coordination.event.create": coordinationEventSchema,
  "coordination.event.list": z.object({ items: z.array(coordinationSummarySchema), nextCursor: z.string().optional() }).strict(),
  "coordination.event.get": coordinationEventSchema,
  "coordination.event.resolve": coordinationEventSchema,
  "coordination.event.consume": coordinationEventSchema,
  "coordination.event.cancel": coordinationEventSchema,
  "coordination.event.correct": z.object({ correction: coordinationEventSchema, superseded: coordinationEventSchema }).strict(),
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
  "Coordination events are public records separate from the normal response; do not change the normal response format when recording one.",
  "Record a coordination event for a scope or policy decision, an ancestor or user decision request, a blocker opening or clearing, a major work milestone, or a correction.",
  "Use user_decision_required for user confirmation, selection, or free text; use blocker only for an external condition that prevents your work, and resolve your blocker after work can resume.",
  "Never record secrets, raw logs, stack traces, large diffs, provider responses, private reasoning, or personal environment paths.",
  "A progress or decision recording failure must not stop the normal response. If user_decision_required cannot be recorded, state the failure and a safe next action in the normal response.",
].join(" ");

export const SESSION_MCP_TOOL_DEFINITIONS = [
  { name: "runtime.catalog", title: "Get runtime catalog", description: "Read the current public Provider and model catalog.", readOnly: true, destructive: false },
  { name: "session.self", title: "Resolve actor Session", description: "Resolve the current provider actor Session from its runtime binding.", readOnly: true, destructive: false },
  { name: "session.create", title: "Create child Session", description: "Create an authorized child Session for the bound actor with an explicit workspace.", readOnly: false, destructive: false },
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
  { name: "coordination.event.create", title: "Create coordination event", description: "Record a public coordination event for the bound Session and return its stable eventId.", readOnly: false, destructive: false },
  { name: "coordination.event.list", title: "List coordination events", description: "List visible coordination event summaries, including each stable eventId.", readOnly: true, destructive: false },
  { name: "coordination.event.get", title: "Get coordination event", description: "Read one visible coordination event by eventId, or recover it and its stable eventId by the create idempotencyKey.", readOnly: true, destructive: false },
  { name: "coordination.event.resolve", title: "Resolve coordination event", description: "Resolve an authorized escalation or blocker using the exact eventId returned by create, list, or get.", readOnly: false, destructive: false },
  { name: "coordination.event.consume", title: "Consume coordination answer", description: "Mark the exact resolved revision identified by expectedResolutionSequence as applied by its owner Session.", readOnly: false, destructive: false },
  { name: "coordination.event.cancel", title: "Cancel coordination event", description: "Cancel an open coordination event created by the bound Session.", readOnly: false, destructive: true },
  { name: "coordination.event.correct", title: "Correct coordination event", description: "Append a correction and supersede an event created by the bound Session.", readOnly: false, destructive: true },
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
    || operation === "coordination.event.create" || operation === "coordination.event.resolve"
    || operation === "coordination.event.consume"
    || operation === "coordination.event.cancel" || operation === "coordination.event.correct"
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
  server.registerTool("coordination.event.create", {
    ...definitions.get("coordination.event.create")!, annotations: annotations(definitions.get("coordination.event.create")!),
    inputSchema: coordinationCreateInputSchema, outputSchema: createOutputSchema("coordination.event.create"),
  }, async (input) => executeOperation("coordination.event.create", input, deps));
  server.registerTool("coordination.event.list", {
    ...definitions.get("coordination.event.list")!, annotations: annotations(definitions.get("coordination.event.list")!),
    inputSchema: coordinationListInputSchema, outputSchema: createOutputSchema("coordination.event.list"),
  }, async (input) => executeOperation("coordination.event.list", input, deps));
  server.registerTool("coordination.event.get", {
    ...definitions.get("coordination.event.get")!, annotations: annotations(definitions.get("coordination.event.get")!),
    inputSchema: coordinationGetInputSchema, outputSchema: createOutputSchema("coordination.event.get"),
  }, async (input) => executeOperation("coordination.event.get", input, deps));
  server.registerTool("coordination.event.resolve", {
    ...definitions.get("coordination.event.resolve")!, annotations: annotations(definitions.get("coordination.event.resolve")!),
    inputSchema: coordinationResolveInputSchema, outputSchema: createOutputSchema("coordination.event.resolve"),
  }, async (input) => executeOperation("coordination.event.resolve", input, deps));
  server.registerTool("coordination.event.consume", {
    ...definitions.get("coordination.event.consume")!, annotations: annotations(definitions.get("coordination.event.consume")!),
    inputSchema: coordinationConsumeInputSchema, outputSchema: createOutputSchema("coordination.event.consume"),
  }, async (input) => executeOperation("coordination.event.consume", input, deps));
  server.registerTool("coordination.event.cancel", {
    ...definitions.get("coordination.event.cancel")!, annotations: annotations(definitions.get("coordination.event.cancel")!),
    inputSchema: coordinationCancelInputSchema, outputSchema: createOutputSchema("coordination.event.cancel"),
  }, async (input) => executeOperation("coordination.event.cancel", input, deps));
  server.registerTool("coordination.event.correct", {
    ...definitions.get("coordination.event.correct")!, annotations: annotations(definitions.get("coordination.event.correct")!),
    inputSchema: coordinationCorrectInputSchema, outputSchema: createOutputSchema("coordination.event.correct"),
  }, async (input) => executeOperation("coordination.event.correct", input, deps));
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
