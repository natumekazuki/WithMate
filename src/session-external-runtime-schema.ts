import { z } from "zod";

import { APPROVAL_MODE_VALUES } from "./approval-mode.js";
import { CODEX_SANDBOX_MODE_VALUES } from "./codex-sandbox-mode.js";
import {
  RESOURCE_BUDGET_CONTRACT_REVISION,
  RESOURCE_BUDGET_DEFAULT_DURATION_MS,
  RESOURCE_BUDGET_DEFAULT_HARD_LIMITS,
  RESOURCE_BUDGET_DEFAULT_LIST_LIMIT,
  RESOURCE_BUDGET_DIMENSIONS,
  RESOURCE_BUDGET_MAX_LIST_LIMIT,
  RESOURCE_BUDGET_RETRY_PER_EXECUTION_LIMIT,
} from "./resource-budget.js";
import {
  COORDINATION_EVENT_DEFAULT_LIST_LIMIT,
  COORDINATION_EVENT_KINDS,
  COORDINATION_EVENT_MAX_LIST_LIMIT,
  COORDINATION_EVENT_STATES,
} from "./coordination-event.js";
import {
  SESSION_TRANSCRIPT_INLINE_HARD_MAX_BYTES,
  SESSION_TRANSCRIPT_FOLDER_HARD_MAX_BYTES,
} from "./session-transcript.js";
import {
  WORK_ITEM_DEFAULT_LIST_LIMIT,
  WORK_ITEM_MAX_EVENT_PAYLOAD_BYTES,
  WORK_ITEM_MAX_MIGRATION_BASELINE_PAYLOAD_BYTES,
  WORK_ITEM_MAX_LIST_LIMIT,
  WORK_ITEM_MAX_RESULT_BYTES,
  WORK_ITEM_MAX_RESULT_ITEMS,
  WORK_ITEM_MAX_TEXT_LENGTH,
  WORK_ITEM_STATES,
  WORK_ITEM_AGGREGATION_DECISIONS,
  WORK_ITEM_AGGREGATION_DEFAULT_LIST_LIMIT,
  WORK_ITEM_AGGREGATION_MAX_LIST_LIMIT,
} from "./work-item.js";
import {
  SESSION_AUTHORITY_DECISION_CLASSES,
  SESSION_AUTHORITY_EFFECT_CLASSES,
  SESSION_AUTHORITY_RESOURCE_KINDS,
} from "./session-authority.js";
import {
  SESSION_RUNTIME_DEFAULT_LIST_LIMIT,
  SESSION_RUNTIME_DEFAULT_FILE_TEXT_BYTES,
  SESSION_RUNTIME_MAX_FILE_TEXT_BYTES,
  SESSION_RUNTIME_MAX_LIST_LIMIT,
  SESSION_RUNTIME_MAX_RESPONSE_BYTES,
  SESSION_RUNTIME_MAX_TURN_ATTACHMENTS,
  SESSION_RUNTIME_MAX_WAIT_TIMEOUT_MS,
  SESSION_RUNTIME_ERROR_SCHEMA_VERSION,
  SESSION_RUNTIME_RESULT_SCHEMA_VERSION,
  SESSION_RUNTIME_OPERATIONS,
  type SessionRuntimeError,
  type SessionRuntimeOperation,
  type SessionRuntimeResultEnvelope,
} from "./session-external-runtime-contract.js";
const reasoningEffortSchema = z.enum(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
const nonEmptyStringSchema = z.string().trim().min(1);
const budgetTimestampSchema = z.iso.datetime({ offset: true });
const runtimeCatalogInputSchema = z.object({}).strict();
const budgetGetInputSchema = z.object({ sessionId: nonEmptyStringSchema }).strict();
const budgetListInputSchema = z.object({
  sessionId: nonEmptyStringSchema,
  limit: z.number().int().positive().max(RESOURCE_BUDGET_MAX_LIST_LIMIT),
  cursor: nonEmptyStringSchema.optional(),
}).strict();
const budgetAmountsShape = Object.fromEntries(
  RESOURCE_BUDGET_DIMENSIONS.map((dimension) => [dimension, z.number().int().nonnegative().optional()]),
) as Record<(typeof RESOURCE_BUDGET_DIMENSIONS)[number], z.ZodOptional<z.ZodNumber>>;
const budgetPartialAmountsSchema = z.object(budgetAmountsShape).strict()
  .refine((amounts) => Object.values(amounts).some((amount) => amount !== undefined), {
    message: "hardLimits must not be empty.",
  })
  .meta({ minProperties: 1 });
const budgetRequiredAmountsShape = Object.fromEntries(
  RESOURCE_BUDGET_DIMENSIONS.map((dimension) => [dimension, z.number().int().nonnegative()]),
) as Record<(typeof RESOURCE_BUDGET_DIMENSIONS)[number], z.ZodNumber>;
const budgetChildAllocationHardLimitsSchema = z.object({
  ...budgetRequiredAmountsShape,
  storageBytes: z.literal(0),
}).strict();
const budgetSoftLimitsShape = Object.fromEntries(
  RESOURCE_BUDGET_DIMENSIONS.map((dimension) => [dimension, z.number().int().nonnegative().nullable().optional()]),
) as Record<(typeof RESOURCE_BUDGET_DIMENSIONS)[number], z.ZodOptional<z.ZodNullable<z.ZodNumber>>>;
const budgetSoftLimitsSchema = z.object(budgetSoftLimitsShape).strict()
  .refine((limits) => Object.values(limits).some((limit) => limit !== undefined), {
    message: "softLimits must not be empty.",
  })
  .meta({ minProperties: 1 });
const budgetChildSoftLimitsSchema = z.object({
  ...budgetSoftLimitsShape,
  storageBytes: z.null().optional(),
}).strict()
  .refine((limits) => Object.values(limits).some((limit) => limit !== undefined), {
    message: "childAllocation.softLimits must not be empty.",
  })
  .meta({ minProperties: 1 });
const BUDGET_ACCOUNT_POLICY_FIELDS = [
  "hardLimits", "softLimits", "deadlineAt", "expiresAt", "revoked", "retryPerExecutionLimit",
] as const;
const budgetPolicyRequiredAnyOf = BUDGET_ACCOUNT_POLICY_FIELDS.map((field) => ({ required: [field] }));
const budgetConfigureInputSchema = z.object({
  sessionId: nonEmptyStringSchema,
  accountId: nonEmptyStringSchema,
  expectedRevision: z.number().int().positive(),
  hardLimits: budgetPartialAmountsSchema.optional(),
  softLimits: budgetSoftLimitsSchema.optional(),
  deadlineAt: budgetTimestampSchema.optional(),
  expiresAt: budgetTimestampSchema.nullable().optional(),
  revoked: z.boolean().optional(),
  retryPerExecutionLimit: z.number().int().nonnegative().optional(),
  childAllocation: z.object({
    accountId: nonEmptyStringSchema,
    childSessionId: nonEmptyStringSchema,
    hardLimits: budgetChildAllocationHardLimitsSchema,
    softLimits: budgetChildSoftLimitsSchema.optional(),
    expiresAt: budgetTimestampSchema.nullable().optional(),
  }).strict().optional(),
  idempotencyKey: nonEmptyStringSchema,
}).strict().refine((input) => {
  const hasPolicyChange = BUDGET_ACCOUNT_POLICY_FIELDS.some((field) => input[field] !== undefined);
  return input.childAllocation === undefined ? hasPolicyChange : !hasPolicyChange;
}, {
  message: "budget.configure must contain either account policy changes or childAllocation, but not both.",
}).meta({
  anyOf: [
    {
      required: ["childAllocation"],
      not: { anyOf: budgetPolicyRequiredAnyOf },
    },
    {
      not: { required: ["childAllocation"] },
      anyOf: budgetPolicyRequiredAnyOf,
    },
  ],
});
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
  expectedContainerRevision: z.number().int().min(1),
  sessionId: nonEmptyStringSchema,
  catalogRevision: z.number().int().min(1),
  idempotencyKey: nonEmptyStringSchema,
  turn: turnSchema,
  terminalFailureNotification: z.object({
    targetSessionId: nonEmptyStringSchema,
  }).strict().optional(),
  workItemId: nonEmptyStringSchema.optional(),
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
  expectedRevision: z.number().int().min(1),
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
  expectedRevision: z.number().int().min(1),
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
const lifecycleWorkspaceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("directory"), path: nonEmptyStringSchema }).strict(),
  z.object({ kind: z.literal("session_folder") }).strict(),
]);
const lifecycleProviderSchema = z.discriminatedUnion("id", [
  z.object({ id: z.literal("codex"), catalogRevision: z.number().int().min(1), model: nonEmptyStringSchema, reasoningEffort: reasoningEffortSchema, threadContinuity: z.enum(["continue", "reset"]), approvalMode: z.enum(APPROVAL_MODE_VALUES), codexSandboxMode: z.enum(CODEX_SANDBOX_MODE_VALUES), allowedAdditionalDirectories: z.array(nonEmptyStringSchema) }).strict(),
  z.object({ id: z.literal("copilot"), catalogRevision: z.number().int().min(1), model: nonEmptyStringSchema, reasoningEffort: reasoningEffortSchema, threadContinuity: z.enum(["continue", "reset"]), approvalMode: z.enum(APPROVAL_MODE_VALUES), customAgentName: z.string().trim() }).strict(),
]);
const lifecycleInitialGrantSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("inherit") }).strict(),
  z.object({ kind: z.literal("explicit"), actions: z.array(nonEmptyStringSchema), visibility: z.array(nonEmptyStringSchema), expiresAt: z.string().nullable() }).strict(),
]);
const lifecycleBudgetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("inherit") }).strict(),
  z.object({ kind: z.literal("explicit"), hardLimits: z.record(z.string(), z.number().int().nonnegative()), deadlineAt: nonEmptyStringSchema }).strict(),
]);
const sessionPlacementSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("root"), rootKind: z.enum(["standalone", "overall-coordinator"]) }).strict(),
  z.object({ kind: z.literal("child"), parentSessionId: nonEmptyStringSchema, sessionRole: z.enum(["task-coordinator", "executor"]) }).strict(),
]);
const sessionCreateInputSchema = z.object({
  expectedContainerRevision: z.number().int().min(1), placement: sessionPlacementSchema, title: nonEmptyStringSchema,
  character: z.object({ characterId: nonEmptyStringSchema, expectedDefinitionSha256: nonEmptyStringSchema }).strict(),
  provider: lifecycleProviderSchema.refine((value) => value.threadContinuity === "reset", "New Sessions require reset thread continuity."),
  workspace: lifecycleWorkspaceSchema, initialGrant: lifecycleInitialGrantSchema, budget: lifecycleBudgetSchema, idempotencyKey: nonEmptyStringSchema,
}).strict();
const sessionListInputSchema = z.object({
  limit: z.number().int().min(1).max(SESSION_RUNTIME_MAX_LIST_LIMIT).default(SESSION_RUNTIME_DEFAULT_LIST_LIMIT),
  cursor: nonEmptyStringSchema.optional(),
}).strict();
const sessionGetInputSchema = z.object({ sessionId: nonEmptyStringSchema }).strict();
const sessionRenameInputSchema = z.object({
  expectedRevision: z.number().int().min(1),
  sessionId: nonEmptyStringSchema,
  title: nonEmptyStringSchema,
  idempotencyKey: nonEmptyStringSchema,
}).strict();
const sessionConfigureInputSchema = z.discriminatedUnion("kind", [
  z.object({ sessionId: nonEmptyStringSchema, expectedRevision: z.number().int().min(1), idempotencyKey: nonEmptyStringSchema, kind: z.literal("title"), title: nonEmptyStringSchema }).strict(),
  z.object({ sessionId: nonEmptyStringSchema, expectedRevision: z.number().int().min(1), idempotencyKey: nonEmptyStringSchema, kind: z.literal("runtime"), provider: lifecycleProviderSchema }).strict(),
  z.object({ sessionId: nonEmptyStringSchema, expectedRevision: z.number().int().min(1), idempotencyKey: nonEmptyStringSchema, kind: z.literal("character"), character: z.object({ characterId: nonEmptyStringSchema, expectedDefinitionSha256: nonEmptyStringSchema }).strict(), threadContinuity: z.enum(["continue", "reset"]) }).strict(),
  z.object({ sessionId: nonEmptyStringSchema, expectedRevision: z.number().int().min(1), idempotencyKey: nonEmptyStringSchema, kind: z.literal("workspace"), workspace: lifecycleWorkspaceSchema, threadContinuity: z.enum(["continue", "reset"]) }).strict(),
  z.object({ sessionId: nonEmptyStringSchema, expectedRevision: z.number().int().min(1), idempotencyKey: nonEmptyStringSchema, kind: z.literal("role"), sessionRole: z.enum(["standalone", "overall-coordinator", "task-coordinator", "executor"]) }).strict(),
]);
const sessionMoveInputSchema = z.discriminatedUnion("kind", [
  z.object({ sessionId: nonEmptyStringSchema, expectedRevision: z.number().int().min(1), idempotencyKey: nonEmptyStringSchema, kind: z.literal("same_root"), destinationParentSessionId: z.string().nullable(), destinationExpectedRevision: z.number().int().min(1) }).strict(),
  z.object({ sessionId: nonEmptyStringSchema, expectedRevision: z.number().int().min(1), idempotencyKey: nonEmptyStringSchema, kind: z.literal("cross_root"), destinationRootSessionId: nonEmptyStringSchema, destinationParentSessionId: z.string().nullable(), destinationExpectedRevision: z.number().int().min(1), transferManifestRevision: z.number().int().min(1), transferPolicy: z.literal("full") }).strict(),
]);
const sessionMoveManifestInputSchema = z.object({ sessionId: nonEmptyStringSchema, destinationRootSessionId: nonEmptyStringSchema }).strict();
const sessionCloneInputSchema = z.object({ sourceSessionId: nonEmptyStringSchema, expectedSourceRevision: z.number().int().min(1), expectedContainerRevision: z.number().int().min(0), placement: sessionPlacementSchema, title: nonEmptyStringSchema, initialGrant: lifecycleInitialGrantSchema, budget: lifecycleBudgetSchema, idempotencyKey: nonEmptyStringSchema }).strict();
const sessionRestoreInputSchema = z.discriminatedUnion("kind", [
  z.object({ sessionId: nonEmptyStringSchema, expectedRevision: z.number().int().min(1), kind: z.literal("root"), purpose: nonEmptyStringSchema, provider: lifecycleProviderSchema, budget: lifecycleBudgetSchema, idempotencyKey: nonEmptyStringSchema }).strict(),
  z.object({ sessionId: nonEmptyStringSchema, expectedRevision: z.number().int().min(1), kind: z.literal("child"), purpose: nonEmptyStringSchema, provider: lifecycleProviderSchema, idempotencyKey: nonEmptyStringSchema }).strict(),
]);
const sessionArchiveInputSchema = z.object({ sessionId: nonEmptyStringSchema, expectedRevision: z.number().int().min(1), reason: nonEmptyStringSchema, descendantPolicy: z.enum(["retain", "archive_descendants"]), idempotencyKey: nonEmptyStringSchema }).strict();
const sessionDeleteManifestInputSchema = sessionGetInputSchema;
const sessionDeleteInputSchema = z.object({ sessionId: nonEmptyStringSchema, expectedRevision: z.number().int().min(1), manifestRevision: z.number().int().min(1), idempotencyKey: nonEmptyStringSchema }).strict();
const sessionManifestResultSchema = z.object({
  sessionId: nonEmptyStringSchema, manifestRevision: z.number().int().min(1), destinationRootSessionId: z.string().nullable(),
  descendants: z.array(z.object({ sessionId: nonEmptyStringSchema, revision: z.number().int().min(1) }).strict()),
  workItems: z.array(z.object({ workItemId: nonEmptyStringSchema, state: nonEmptyStringSchema, revision: z.number().int().min(1) }).strict()),
  artifacts: z.array(z.object({ id: nonEmptyStringSchema, ownerSessionId: nonEmptyStringSchema }).strict()),
  budgetReservations: z.array(z.object({ id: nonEmptyStringSchema, state: nonEmptyStringSchema }).strict()),
  executions: z.object({ running: z.number().int().nonnegative(), queued: z.number().int().nonnegative() }).strict(),
  grants: z.array(z.object({ id: nonEmptyStringSchema, revision: z.number().int().min(1), state: nonEmptyStringSchema }).strict()),
  openInteractions: z.number().int().nonnegative(), openCoordinationEvents: z.number().int().nonnegative(), blockers: z.array(z.string()),
}).strict();
const sessionDeleteManifestResultSchema = sessionManifestResultSchema.extend({ deletable: z.boolean() }).strict();
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
const workItemSourceIdentitySchema = z.object({
  workspace: z.string().max(WORK_ITEM_MAX_TEXT_LENGTH).nullable(),
  repository: z.string().max(WORK_ITEM_MAX_TEXT_LENGTH).nullable(),
  branch: z.string().max(WORK_ITEM_MAX_TEXT_LENGTH).nullable(),
  base: z.string().max(WORK_ITEM_MAX_TEXT_LENGTH).nullable(),
  head: z.string().max(WORK_ITEM_MAX_TEXT_LENGTH).nullable(),
}).strict();
const workItemCreateInputSchema = z.object({
  expectedContainerRevision: z.number().int().min(1),
  targetSessionId: nonEmptyStringSchema,
  parentWorkItemId: nonEmptyStringSchema.optional(),
  goal: nonEmptyStringSchema.max(WORK_ITEM_MAX_TEXT_LENGTH),
  scope: nonEmptyStringSchema.max(WORK_ITEM_MAX_TEXT_LENGTH),
  completionCriteria: nonEmptyStringSchema.max(WORK_ITEM_MAX_TEXT_LENGTH),
  authority: nonEmptyStringSchema.max(WORK_ITEM_MAX_TEXT_LENGTH),
  sourceIdentity: workItemSourceIdentitySchema,
  idempotencyKey: nonEmptyStringSchema,
}).strict();
const workItemInputSchema = z.object({ workItemId: nonEmptyStringSchema }).strict();
const workItemReviseInputSchema = z.object({
  workItemId: nonEmptyStringSchema, goal: nonEmptyStringSchema.max(WORK_ITEM_MAX_TEXT_LENGTH), scope: z.string().max(WORK_ITEM_MAX_TEXT_LENGTH),
  completionCriteria: z.string().max(WORK_ITEM_MAX_TEXT_LENGTH), authority: z.string().max(WORK_ITEM_MAX_TEXT_LENGTH), sourceIdentity: workItemSourceIdentitySchema.optional(),
  expectedRevision: z.number().int().min(1), idempotencyKey: nonEmptyStringSchema,
}).strict();
const actualStartSourceIdentitySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("git_unavailable"), workspace: z.string(), repository: z.null(), branch: z.null(), base: z.null(), head: z.null() }).strict(),
  z.object({ kind: z.literal("detached_head"), workspace: z.string(), repository: z.string(), branch: z.null(), base: z.string().nullable(), head: z.string() }).strict(),
  z.object({ kind: z.literal("unborn_branch"), workspace: z.string(), repository: z.string(), branch: z.string(), base: z.null(), head: z.null() }).strict(),
  z.object({ kind: z.literal("resolved"), workspace: z.string(), repository: z.string(), branch: z.string(), base: z.string().nullable(), head: z.string() }).strict(),
]);
const workItemReassignInputSchema = z.object({ workItemId: nonEmptyStringSchema, targetSessionId: nonEmptyStringSchema, expectedRevision: z.number().int().min(1), expectedContainerRevision: z.number().int().min(1).optional(), transferPolicy: z.enum(["handoff", "successor"]), idempotencyKey: nonEmptyStringSchema }).strict();
const workItemMoveInputSchema = z.object({ workItemId: nonEmptyStringSchema, destinationParentWorkItemId: nonEmptyStringSchema.nullable(), expectedRevision: z.number().int().min(1), expectedAggregateRevision: z.number().int().min(0).optional(), expectedDestinationAggregateRevision: z.number().int().min(0).optional(), idempotencyKey: nonEmptyStringSchema }).strict();
const workItemCloneInputSchema = z.object({ workItemId: nonEmptyStringSchema, expectedRevision: z.number().int().min(1), expectedContainerRevision: z.number().int().min(1), targetSessionId: nonEmptyStringSchema, parentWorkItemId: nonEmptyStringSchema.nullable().optional(), goal: nonEmptyStringSchema.max(WORK_ITEM_MAX_TEXT_LENGTH), scope: z.string().max(WORK_ITEM_MAX_TEXT_LENGTH), completionCriteria: z.string().max(WORK_ITEM_MAX_TEXT_LENGTH), authority: z.string().max(WORK_ITEM_MAX_TEXT_LENGTH), sourceIdentity: workItemSourceIdentitySchema, idempotencyKey: nonEmptyStringSchema }).strict();
const workItemReopenInputSchema = z.object({ workItemId: nonEmptyStringSchema, expectedRevision: z.number().int().min(1), strategy: z.literal("successor"), expectedContainerRevision: z.number().int().min(1).optional(), destinationParentWorkItemId: nonEmptyStringSchema.nullable().optional(), goal: nonEmptyStringSchema.max(WORK_ITEM_MAX_TEXT_LENGTH), scope: z.string().max(WORK_ITEM_MAX_TEXT_LENGTH), completionCriteria: z.string().max(WORK_ITEM_MAX_TEXT_LENGTH), authority: z.string().max(WORK_ITEM_MAX_TEXT_LENGTH), sourceIdentity: workItemSourceIdentitySchema, idempotencyKey: nonEmptyStringSchema }).strict();
const workItemArchiveInputSchema = z.object({ workItemId: nonEmptyStringSchema, expectedRevision: z.number().int().min(1), reason: nonEmptyStringSchema.max(WORK_ITEM_MAX_TEXT_LENGTH), idempotencyKey: nonEmptyStringSchema }).strict();
const workItemRestoreInputSchema = z.object({ workItemId: nonEmptyStringSchema, expectedRevision: z.number().int().min(1), idempotencyKey: nonEmptyStringSchema }).strict();
const workItemDeleteInputSchema = z.object({ workItemId: nonEmptyStringSchema, expectedRevision: z.number().int().min(1), idempotencyKey: nonEmptyStringSchema }).strict();
const workItemHistoryAppendInputSchema = z.object({
  workItemId: nonEmptyStringSchema, type: z.enum(["progress", "handoff"]), summary: nonEmptyStringSchema.max(WORK_ITEM_MAX_TEXT_LENGTH),
  blockers: z.array(nonEmptyStringSchema.max(WORK_ITEM_MAX_TEXT_LENGTH)).max(WORK_ITEM_MAX_RESULT_ITEMS), nextAction: nonEmptyStringSchema.max(WORK_ITEM_MAX_TEXT_LENGTH), expectedRevision: z.number().int().min(1), idempotencyKey: nonEmptyStringSchema,
}).strict();
const workItemHistoryListInputSchema = z.object({ workItemId: nonEmptyStringSchema, limit: z.number().int().min(1).max(WORK_ITEM_MAX_LIST_LIMIT).default(WORK_ITEM_DEFAULT_LIST_LIMIT), cursor: nonEmptyStringSchema.optional() }).strict();
const workItemProgressPayloadSchema = z.object({ progressSummary: z.string(), blockers: z.array(z.string()), nextAction: z.string() }).strict();
const workItemContractProjectionSchema = z.object({ goal: z.string(), scope: z.string(), completionCriteria: z.string(), authority: z.string() }).strict();
const workItemEventResultSchema = z.object({ outcome: z.enum(["completed", "partially_completed", "failed"]), summary: z.string(), changes: z.array(z.string()), verificationResults: z.array(z.object({ name: z.string(), status: z.enum(["passed", "failed", "not_run"]), details: z.string() }).strict()), findings: z.array(z.string()), unverifiedItems: z.array(z.string()), remainingWork: z.array(z.string()), reportingSessionId: z.string(), reportedAt: z.string() }).strict();
const workItemEventBase = { sequence: z.number().int().positive(), workItemId: z.string(), revision: z.number().int().positive(), actorSessionId: z.string().nullable(), createdAt: z.string() };
const workItemEventSchema = z.discriminatedUnion("type", [
  z.object({ ...workItemEventBase, type: z.literal("created"), payload: z.object({ kind: z.enum(["root", "delegated"]), rootSessionId: z.string(), creatorSessionId: z.string(), targetSessionId: z.string(), parentWorkItemId: z.string().nullable(), sourceIdentity: workItemSourceIdentitySchema, contract: workItemContractProjectionSchema, progress: workItemProgressPayloadSchema, state: z.enum(WORK_ITEM_STATES), result: workItemEventResultSchema.nullable(), predecessorWorkItemId: z.string().nullable().optional(), sourceWorkItemId: z.string().nullable().optional() }).strict() }).strict(),
  z.object({ ...workItemEventBase, type: z.literal("migration_baseline"), payload: z.object({ kind: z.enum(["root", "delegated"]), rootSessionId: z.string(), creatorSessionId: z.string(), targetSessionId: z.string(), parentWorkItemId: z.string().nullable(), sourceIdentity: workItemSourceIdentitySchema, contract: workItemContractProjectionSchema, progress: workItemProgressPayloadSchema, state: z.enum(WORK_ITEM_STATES), result: workItemEventResultSchema.nullable(), predecessorWorkItemId: z.string().nullable().optional(), sourceWorkItemId: z.string().nullable().optional() }).strict() }).strict(),
  z.object({ ...workItemEventBase, type: z.literal("contract_revised"), payload: z.object({ before: workItemContractProjectionSchema, after: workItemContractProjectionSchema, beforeSourceIdentity: workItemSourceIdentitySchema.optional(), afterSourceIdentity: workItemSourceIdentitySchema.optional() }).strict() }).strict(),
  z.object({ ...workItemEventBase, type: z.literal("progress"), payload: workItemProgressPayloadSchema }).strict(),
  z.object({ ...workItemEventBase, type: z.literal("handoff"), payload: workItemProgressPayloadSchema }).strict(),
  z.object({ ...workItemEventBase, type: z.literal("state_transitioned"), payload: z.object({ from: z.enum(WORK_ITEM_STATES), to: z.enum(WORK_ITEM_STATES) }).strict() }).strict(),
  z.object({ ...workItemEventBase, type: z.literal("result_reported"), payload: z.object({ from: z.enum(WORK_ITEM_STATES), to: z.enum(WORK_ITEM_STATES), result: workItemEventResultSchema }).strict() }).strict(),
  z.object({ ...workItemEventBase, type: z.literal("assignment_changed"), payload: z.object({ beforeTargetSessionId: z.string(), afterTargetSessionId: z.string() }).strict() }).strict(),
  z.object({ ...workItemEventBase, type: z.literal("parent_changed"), payload: z.object({ beforeParentWorkItemId: z.string().nullable(), afterParentWorkItemId: z.string().nullable(), beforeCreatorSessionId: z.string().optional(), afterCreatorSessionId: z.string().optional(), supersededDecision: z.boolean() }).strict() }).strict(),
  z.object({ ...workItemEventBase, type: z.literal("archived"), payload: z.object({ archivedAt: z.string(), reason: z.string().optional() }).strict() }).strict(),
  z.object({ ...workItemEventBase, type: z.literal("restored"), payload: z.object({ restoredAt: z.string() }).strict() }).strict(),
  z.object({ ...workItemEventBase, type: z.literal("deleted"), payload: z.object({ deletedAt: z.string() }).strict() }).strict(),
]);
const workItemListInputSchema = z.object({
  creatorSessionId: nonEmptyStringSchema.optional(),
  targetSessionId: nonEmptyStringSchema.optional(),
  state: z.enum(WORK_ITEM_STATES).optional(),
  includeArchived: z.boolean().default(false),
  limit: z.number().int().min(1).max(WORK_ITEM_MAX_LIST_LIMIT).default(WORK_ITEM_DEFAULT_LIST_LIMIT),
  cursor: nonEmptyStringSchema.optional(),
}).strict();
const workItemTransitionInputSchema = z.object({
  workItemId: nonEmptyStringSchema,
  state: z.enum(["in_progress", "waiting"]),
  expectedRevision: z.number().int().min(1),
  idempotencyKey: nonEmptyStringSchema,
}).strict();
const workItemStringListSchema = z.array(nonEmptyStringSchema.max(WORK_ITEM_MAX_TEXT_LENGTH)).max(WORK_ITEM_MAX_RESULT_ITEMS);
const workItemResultBodySchema = z.object({
  summary: nonEmptyStringSchema.max(WORK_ITEM_MAX_TEXT_LENGTH),
  changes: workItemStringListSchema,
  verificationResults: z.array(z.object({
    name: nonEmptyStringSchema.max(WORK_ITEM_MAX_TEXT_LENGTH),
    status: z.enum(["passed", "failed", "not_run"]),
    details: nonEmptyStringSchema.max(WORK_ITEM_MAX_TEXT_LENGTH),
  }).strict()).max(WORK_ITEM_MAX_RESULT_ITEMS),
  findings: workItemStringListSchema,
  unverifiedItems: workItemStringListSchema,
  remainingWork: workItemStringListSchema,
}).strict();
const workItemResultInputSchema = z.object({
  workItemId: nonEmptyStringSchema,
  state: z.enum(["completed", "partially_completed", "failed"]),
  expectedRevision: z.number().int().min(1),
  expectedAggregateRevision: z.number().int().min(0).optional(),
  result: workItemResultBodySchema,
  idempotencyKey: nonEmptyStringSchema,
}).strict();
const workItemAggregationGetInputSchema = z.object({ parentWorkItemId: nonEmptyStringSchema }).strict();
const workItemAggregationListInputSchema = z.object({
  parentWorkItemId: nonEmptyStringSchema,
  decision: z.enum(WORK_ITEM_AGGREGATION_DECISIONS).optional(),
  limit: z.number().int().min(1).max(WORK_ITEM_AGGREGATION_MAX_LIST_LIMIT).default(WORK_ITEM_AGGREGATION_DEFAULT_LIST_LIMIT),
  cursor: nonEmptyStringSchema.optional(),
}).strict();
const workItemAggregationDecisionInputSchema = z.object({
  parentWorkItemId: nonEmptyStringSchema, childWorkItemId: nonEmptyStringSchema,
  decision: z.enum(["accepted", "excluded"]), reason: nonEmptyStringSchema.max(WORK_ITEM_MAX_TEXT_LENGTH).optional(),
  expectedAggregateRevision: z.number().int().min(1), idempotencyKey: nonEmptyStringSchema,
}).strict().superRefine((value, context) => {
  if (value.decision === "excluded" && value.reason === undefined) context.addIssue({ code: "custom", path: ["reason"], message: "excluded requires a reason." });
});
const workItemAggregationRetryInputSchema = z.object({
  parentWorkItemId: nonEmptyStringSchema, childWorkItemId: nonEmptyStringSchema,
  targetSessionId: nonEmptyStringSchema, goal: nonEmptyStringSchema.max(WORK_ITEM_MAX_TEXT_LENGTH),
  scope: nonEmptyStringSchema.max(WORK_ITEM_MAX_TEXT_LENGTH),
  completionCriteria: nonEmptyStringSchema.max(WORK_ITEM_MAX_TEXT_LENGTH),
  authority: nonEmptyStringSchema.max(WORK_ITEM_MAX_TEXT_LENGTH), sourceIdentity: workItemSourceIdentitySchema,
  reason: nonEmptyStringSchema.max(WORK_ITEM_MAX_TEXT_LENGTH).optional(), expectedAggregateRevision: z.number().int().min(1), idempotencyKey: nonEmptyStringSchema,
}).strict();
const workItemCancelInputSchema = z.object({
  workItemId: nonEmptyStringSchema,
  expectedRevision: z.number().int().min(1),
  idempotencyKey: nonEmptyStringSchema,
}).strict();
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
  expectedContainerRevision: z.number().int().positive(),
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
  expectedRevision: z.number().int().min(0),
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
  expectedRevision: z.number().int().min(0),
  eventId: nonEmptyStringSchema,
  note: z.string().trim().min(1).max(1_000).optional(),
  idempotencyKey: nonEmptyStringSchema,
}).strict();
const coordinationCorrectInputSchema = z.object({
  expectedRevision: z.number().int().min(0),
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
  revision: z.number().int().min(1),
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
    revision: z.number().int().positive(),
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
    workItemId: z.string().nullable(),
    workItemRevision: z.number().int().positive().nullable(),
    plannedSourceIdentity: workItemSourceIdentitySchema.nullable(),
    actualStartSourceIdentity: actualStartSourceIdentitySchema.nullable(),
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
  revision: z.number().int().positive(),
  decisionClass: z.enum(["user_only", "agent_delegable", "deny_or_cancel"]),
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
  revision: z.number().int().nonnegative(),
  actorSessionId: z.string(),
  sessionRole: sessionRoleSchema,
  kind: z.enum(COORDINATION_EVENT_KINDS),
  decisionClass: z.enum(SESSION_AUTHORITY_DECISION_CLASSES),
  state: z.enum(COORDINATION_EVENT_STATES),
  summary: z.string(),
  createdAt: z.string(),
}).strict();
const coordinationActionSchema = z.object({
  sequence: z.number().int().positive(),
  type: z.enum(["responded", "resolved", "cancelled", "superseded", "consumed"]),
  actorType: z.enum(["session", "trusted_gui"]),
  principalKind: z.enum(["agent", "user", "system"]),
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
const workItemResultSchema = workItemResultBodySchema.extend({
  outcome: z.enum(["completed", "partially_completed", "failed"]),
  reportingSessionId: z.string(),
  reportedAt: z.string(),
}).strict();
const workItemIdentityShape = {
  id: z.string(),
  sequence: z.number().int().positive(),
  contractRevision: z.literal(2),
  kind: z.enum(["root", "delegated"]),
  rootSessionId: z.string(),
  creatorSessionId: z.string(),
  targetSessionId: z.string(),
  parentWorkItemId: z.string().nullable(),
  predecessorWorkItemId: z.string().nullable().optional(),
  goal: z.string(),
  scope: z.string(),
  completionCriteria: z.string(),
  authority: z.string(),
  sourceIdentity: workItemSourceIdentitySchema,
  revision: z.number().int().positive(),
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable().optional(),
  deletedAt: z.string().nullable().optional(),
  progressSummary: z.string().optional(),
  blockers: z.array(z.string()).optional(),
  nextAction: z.string().optional(),
};
function validateWorkItemKind<T extends z.ZodObject>(schema: T) {
  return schema.superRefine((value, context) => {
    const v = value as {
      kind: string;
      progressSummary?: string;
      blockers?: string[];
      nextAction?: string;
      predecessorWorkItemId?: string | null;
    };
    const b = value as { rootSessionId: string; creatorSessionId: string; targetSessionId: string; parentWorkItemId: string | null; goal: string; scope: string; completionCriteria: string; authority: string };
    if (v.kind === "root" && (b.rootSessionId !== b.creatorSessionId || b.creatorSessionId !== b.targetSessionId || b.parentWorkItemId !== null)) context.addIssue({ code: "custom", path: ["kind"], message: "Root Work Item binding is invalid." });
    if (v.kind === "delegated" && (b.creatorSessionId === b.targetSessionId || b.goal.length === 0 || b.scope.length === 0 || b.completionCriteria.length === 0 || b.authority.length === 0)) context.addIssue({ code: "custom", path: ["kind"], message: "Delegated Work Item binding is invalid." });
    const hasProgress = v.progressSummary !== undefined || v.blockers !== undefined || v.nextAction !== undefined;
    if (v.kind === "root" && (!hasProgress || v.progressSummary === undefined || v.blockers === undefined || v.nextAction === undefined)) context.addIssue({ code: "custom", path: ["kind"], message: "Root Work Items require progress fields." });
    if (v.kind === "delegated" && hasProgress) context.addIssue({ code: "custom", path: ["kind"], message: "Delegated Work Items cannot include root progress fields." });
    if (v.kind === "delegated" && v.predecessorWorkItemId !== undefined) context.addIssue({ code: "custom", path: ["predecessorWorkItemId"], message: "Delegated Work Items cannot include root successor fields." });
  });
}
const activeWorkItemSchema = validateWorkItemKind(z.object({
  ...workItemIdentityShape,
  state: z.enum(["pending", "in_progress", "waiting"]),
  result: z.null(),
}).strict());
const canceledWorkItemSchema = validateWorkItemKind(z.object({
  ...workItemIdentityShape,
  state: z.literal("canceled"),
  result: z.null(),
}).strict());
const completedWorkItemSchema = validateWorkItemKind(z.object({ ...workItemIdentityShape, state: z.literal("completed"), result: workItemResultSchema.extend({ outcome: z.literal("completed") }).strict() }).strict());
const partiallyCompletedWorkItemSchema = validateWorkItemKind(z.object({ ...workItemIdentityShape, state: z.literal("partially_completed"), result: workItemResultSchema.extend({ outcome: z.literal("partially_completed") }).strict() }).strict());
const failedWorkItemSchema = validateWorkItemKind(z.object({ ...workItemIdentityShape, state: z.literal("failed"), result: workItemResultSchema.extend({ outcome: z.literal("failed") }).strict() }).strict());
const resultWorkItemSchema = z.union([
  completedWorkItemSchema,
  partiallyCompletedWorkItemSchema,
  failedWorkItemSchema,
]);
const workItemSchema = z.union([
  activeWorkItemSchema,
  canceledWorkItemSchema,
  completedWorkItemSchema,
  partiallyCompletedWorkItemSchema,
  failedWorkItemSchema,
]);
const workItemAggregationDecisionSchema = z.object({
  parentWorkItemId: z.string(), childWorkItemId: z.string(), revision: z.number().int().positive(),
  childRevision: z.number().int().positive(), actorSessionId: z.string(), decision: z.enum(WORK_ITEM_AGGREGATION_DECISIONS),
  reason: z.string().nullable(), replacementWorkItemId: z.string().nullable(), decidedAt: z.string(),
}).strict();
const workItemAggregationItemSchema = z.object({
  child: z.object({
    id: z.string(), sequence: z.number().int().positive(), creatorSessionId: z.string(), targetSessionId: z.string(),
    parentWorkItemId: z.string().nullable(), state: z.enum(WORK_ITEM_STATES), revision: z.number().int().positive(),
    createdAt: z.string(), updatedAt: z.string(),
  }).strict(),
  hasResult: z.boolean(), resultSummary: z.string().nullable(), decision: workItemAggregationDecisionSchema.nullable(),
}).strict();
const budgetDimensionStateSchema = z.object({
  hardLimit: z.number().int().nonnegative(),
  softLimit: z.number().int().nonnegative().nullable(),
  committed: z.number().int().nonnegative(),
  reserved: z.number().int().nonnegative(),
  allocatedToChildren: z.number().int().nonnegative(),
  available: z.number().int().nonnegative(),
  softLimitExceeded: z.boolean(),
  measurement: z.enum(["known", "unknown"]),
  unknownSince: z.string().nullable(),
}).strict();
const budgetSchema = z.object({
  contractRevision: z.literal(RESOURCE_BUDGET_CONTRACT_REVISION),
  accountId: z.string(),
  accountKind: z.enum(["root", "session"]),
  rootSessionId: z.string(),
  ownerSessionId: z.string(),
  appliesToSessionId: z.string(),
  allocationSource: z.enum(["owned", "root_shared"]),
  rootManagedDimensions: z.array(z.enum(RESOURCE_BUDGET_DIMENSIONS)).max(RESOURCE_BUDGET_DIMENSIONS.length),
  parentAccountId: z.string().nullable(),
  authorityGrantId: z.string().nullable(),
  authorityGrantRevision: z.number().int().positive().nullable(),
  expiresAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  deadlineAt: z.string(),
  retryPerExecutionLimit: z.number().int().nonnegative(),
  revision: z.number().int().positive(),
  dimensions: z.object(Object.fromEntries(
    RESOURCE_BUDGET_DIMENSIONS.map((dimension) => [dimension, budgetDimensionStateSchema]),
  ) as Record<(typeof RESOURCE_BUDGET_DIMENSIONS)[number], typeof budgetDimensionStateSchema>).strict(),
  alerts: z.array(z.object({
    dimension: z.enum(RESOURCE_BUDGET_DIMENSIONS),
    softLimit: z.number().int().nonnegative(),
    usage: z.number().int().nonnegative(),
  }).strict()),
  meteredUsage: z.array(z.object({
    usageId: z.string(),
    executionId: z.string().nullable(),
    providerGenerationId: z.string().nullable(),
    reservationId: z.string().nullable(),
    unit: z.enum(["tokens", "monetary_cost", "provider_usage"]),
    amount: z.number().nonnegative().nullable(),
    currency: z.string().nullable(),
    confidence: z.enum(["unknown", "estimated", "reported", "settled"]),
    observedAt: z.string(),
  }).strict()).max(100),
  meteredUsageTruncated: z.boolean(),
  meteredUsageSummary: z.object({
    knownTokens: z.number().nonnegative(),
    knownProviderUsage: z.number().nonnegative(),
    monetaryCostByCurrency: z.record(z.string(), z.number().nonnegative()),
    unknownRecords: z.object({
      tokens: z.number().int().nonnegative(),
      monetary_cost: z.number().int().nonnegative(),
      provider_usage: z.number().int().nonnegative(),
    }).strict(),
  }).strict(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).strict();
const resultSchemas: Record<SessionRuntimeOperation, z.ZodType> = {
  "runtime.catalog": z.object({
    revision: z.number().int(),
    authority: z.object({
      mappingRevision: z.number().int().positive(),
      operations: z.array(z.object({
        action: z.enum(SESSION_RUNTIME_OPERATIONS),
        resourceKind: z.enum(SESSION_AUTHORITY_RESOURCE_KINDS),
        scopeSource: z.enum([
          "actor", "session", "target_session", "work_item", "parent_work_item",
          "execution", "interaction", "coordination_event", "coordination_list",
        ]),
        effectClass: z.enum(SESSION_AUTHORITY_EFFECT_CLASSES),
        decisionClass: z.enum(SESSION_AUTHORITY_DECISION_CLASSES),
      }).strict()),
      budget: z.object({
        contractRevision: z.literal(RESOURCE_BUDGET_CONTRACT_REVISION),
        operations: z.tuple([z.literal("get"), z.literal("list"), z.literal("configure")]),
        dimensions: z.tuple(RESOURCE_BUDGET_DIMENSIONS.map((dimension) => z.literal(dimension)) as [z.ZodLiteral<(typeof RESOURCE_BUDGET_DIMENSIONS)[number]>, ...z.ZodLiteral<(typeof RESOURCE_BUDGET_DIMENSIONS)[number]>[]]),
        defaultHardLimits: z.object(Object.fromEntries(
          RESOURCE_BUDGET_DIMENSIONS.map((dimension) => [dimension, z.literal(RESOURCE_BUDGET_DEFAULT_HARD_LIMITS[dimension])]),
        ) as Record<(typeof RESOURCE_BUDGET_DIMENSIONS)[number], z.ZodLiteral<number>>).strict(),
        retryPerExecutionLimit: z.literal(RESOURCE_BUDGET_RETRY_PER_EXECUTION_LIMIT),
        defaultDurationMs: z.literal(RESOURCE_BUDGET_DEFAULT_DURATION_MS),
        defaultListLimit: z.literal(RESOURCE_BUDGET_DEFAULT_LIST_LIMIT),
        maxListLimit: z.literal(RESOURCE_BUDGET_MAX_LIST_LIMIT),
        meteredUsage: z.tuple([z.literal("tokens"), z.literal("monetary_cost"), z.literal("provider_usage")]),
        constraints: z.array(z.string()),
      }).strict(),
      validationGaps: z.array(z.string()),
    }).strict(),
    sessionRoleContractRevision: z.literal(1),
    sessionTurnCommunicationContractRevision: z.literal(1),
    supportedSessionRoles: z.array(sessionRoleSchema),
    baselineChildSessionRoleTemplates: z.object({
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
    workItems: z.object({
      contractRevision: z.literal(2),
      states: z.tuple(WORK_ITEM_STATES.map((state) => z.literal(state)) as [z.ZodLiteral<(typeof WORK_ITEM_STATES)[number]>, ...z.ZodLiteral<(typeof WORK_ITEM_STATES)[number]>[]]),
      mutations: z.tuple([
        z.literal("create"),
        z.literal("revise"),
        z.literal("reassign"), z.literal("move"), z.literal("clone"), z.literal("reopen"), z.literal("archive"), z.literal("restore"), z.literal("delete"),
        z.literal("transition"),
        z.literal("result"),
        z.literal("cancel"),
        z.literal("history.append"),
      ]),
      history: z.object({
        events: z.tuple([
          z.literal("created"),
          z.literal("migration_baseline"),
          z.literal("contract_revised"),
          z.literal("progress"),
          z.literal("handoff"),
          z.literal("state_transitioned"),
          z.literal("result_reported"),
          z.literal("assignment_changed"), z.literal("parent_changed"), z.literal("archived"), z.literal("restored"), z.literal("deleted"),
        ]),
        operations: z.tuple([z.literal("append"), z.literal("list")]),
        defaultListLimit: z.literal(WORK_ITEM_DEFAULT_LIST_LIMIT),
        maxListLimit: z.literal(WORK_ITEM_MAX_LIST_LIMIT),
      }).strict(),
      defaultListLimit: z.literal(WORK_ITEM_DEFAULT_LIST_LIMIT),
      maxListLimit: z.literal(WORK_ITEM_MAX_LIST_LIMIT),
      maxListResponseBytes: z.literal(SESSION_RUNTIME_MAX_RESPONSE_BYTES),
      maxEventPayloadBytes: z.literal(WORK_ITEM_MAX_EVENT_PAYLOAD_BYTES),
      maxMigrationBaselinePayloadBytes: z.literal(WORK_ITEM_MAX_MIGRATION_BASELINE_PAYLOAD_BYTES),
      maxResultBytes: z.literal(WORK_ITEM_MAX_RESULT_BYTES),
      aggregation: z.object({
        contractRevision: z.literal(1),
        decisions: z.tuple([z.literal("accepted"), z.literal("excluded"), z.literal("retry_requested")]),
        operations: z.tuple([z.literal("get"), z.literal("list"), z.literal("decide"), z.literal("retry")]),
        defaultListLimit: z.literal(WORK_ITEM_AGGREGATION_DEFAULT_LIST_LIMIT),
        maxListLimit: z.literal(WORK_ITEM_AGGREGATION_MAX_LIST_LIMIT),
      }).strict(),
    }).strict(),
    providers: z.array(z.object({
      id: z.string(),
      label: z.string(),
      defaultModelId: z.string(),
      defaultReasoningEffort: reasoningEffortSchema,
      models: z.array(modelSchema),
    }).strict()),
    sessionLifecycle: z.object({
      operations: z.tuple([z.literal("create"), z.literal("configure"), z.literal("rename"), z.literal("move.manifest"), z.literal("move"), z.literal("clone"), z.literal("restore"), z.literal("archive"), z.literal("delete.manifest"), z.literal("delete")]),
      placement: z.tuple([z.literal("root"), z.literal("child")]),
      moveKinds: z.tuple([z.literal("same_root"), z.literal("cross_root")]),
      restoreKinds: z.tuple([z.literal("root"), z.literal("child")]),
      capabilities: z.array(z.string()),
      constraints: z.array(z.string()),
    }).strict().optional(),
  }).strict(),
  "budget.get": budgetSchema,
  "budget.list": z.object({
    items: z.array(budgetSchema).max(RESOURCE_BUDGET_MAX_LIST_LIMIT),
    nextCursor: z.string().optional(),
  }).strict(),
  "budget.configure": budgetSchema,
  "session.self": z.object({ revision: z.number().int().positive(), sessionId: z.string(), ...sessionRoleBindingShape }).strict(),
  "session.create": sessionDetailSchema,
  "session.list": z.object({ items: z.array(sessionSummarySchema), nextCursor: z.string().optional() }).strict(),
  "session.get": sessionGetSchema,
  "session.configure": sessionDetailSchema,
  "session.rename": sessionDetailSchema,
  "session.move.manifest": sessionManifestResultSchema,
  "session.move": sessionDetailSchema,
  "session.clone": sessionDetailSchema,
  "session.restore": sessionDetailSchema,
  "session.archive": sessionDetailSchema,
  "session.delete.manifest": sessionDeleteManifestResultSchema,
  "session.delete": sessionDetailSchema,
  "session.files.list": z.object({ items: z.array(fileReferenceSchema), nextCursor: z.string().optional() }).strict(),
  "session.files.read_text": z.object({ file: fileReferenceSchema, content: z.string() }).strict(),
  "session.files.write_text": z.object({ file: fileReferenceSchema }).strict(),
  "work.create": workItemSchema,
  "work.list": z.object({ items: z.array(workItemSchema), nextCursor: z.string().optional() }).strict(),
  "work.get": workItemSchema,
  "work.revise": workItemSchema,
  "work.reassign": workItemSchema,
  "work.move": workItemSchema,
  "work.clone": workItemSchema,
  "work.reopen": workItemSchema,
  "work.archive": workItemSchema,
  "work.restore": workItemSchema,
  "work.delete": workItemSchema,
  "work.history.append": workItemSchema,
  "work.history.list": z.object({ items: z.array(workItemEventSchema), nextCursor: z.string().optional() }).strict(),
  "work.transition": workItemSchema,
  "work.result": resultWorkItemSchema,
  "work.cancel": canceledWorkItemSchema,
  "work.aggregation.get": z.object({
    contractRevision: z.literal(1), parentWorkItemId: z.string(), aggregateRevision: z.number().int().nonnegative(),
    directChildCount: z.number().int().nonnegative(), activeCount: z.number().int().nonnegative(),
    undecidedTerminalCount: z.number().int().nonnegative(), acceptedCount: z.number().int().nonnegative(),
    excludedCount: z.number().int().nonnegative(), retryRequestedCount: z.number().int().nonnegative(),
  }).strict(),
  "work.aggregation.list": z.object({ items: z.array(workItemAggregationItemSchema), nextCursor: z.string().optional() }).strict(),
  "work.aggregation.decide": workItemAggregationDecisionSchema,
  "work.aggregation.retry": z.object({ decision: workItemAggregationDecisionSchema, replacement: workItemSchema }).strict(),
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

export function createSessionRuntimeResultEnvelopeSchema(operation: SessionRuntimeOperation) {
  return z.object({
    schemaVersion: z.literal(SESSION_RUNTIME_RESULT_SCHEMA_VERSION),
    operation: z.literal(operation),
    result: resultSchemas[operation],
  }).strict();
}

export function createSessionRuntimeOutputSchema(operation: SessionRuntimeOperation) {
  // MCP outputSchema describes successful structured output. Tool errors are
  // returned with isError=true and are intentionally excluded from SDK output
  // validation, while safeRuntimeError validates their public envelope.
  return createSessionRuntimeResultEnvelopeSchema(operation);
}


const inputSchemas: Record<SessionRuntimeOperation, z.ZodType> = {
  "runtime.catalog": runtimeCatalogInputSchema,
  "budget.get": budgetGetInputSchema,
  "budget.list": budgetListInputSchema,
  "budget.configure": budgetConfigureInputSchema,
  "session.self": runtimeCatalogInputSchema,
  "session.create": sessionCreateInputSchema,
  "session.list": sessionListInputSchema,
  "session.get": sessionGetInputSchema,
  "session.configure": sessionConfigureInputSchema,
  "session.rename": sessionRenameInputSchema,
  "session.move.manifest": sessionMoveManifestInputSchema,
  "session.move": sessionMoveInputSchema,
  "session.clone": sessionCloneInputSchema,
  "session.restore": sessionRestoreInputSchema,
  "session.archive": sessionArchiveInputSchema,
  "session.delete.manifest": sessionDeleteManifestInputSchema,
  "session.delete": sessionDeleteInputSchema,
  "session.files.list": sessionFileListInputSchema,
  "session.files.read_text": sessionFileReadTextInputSchema,
  "session.files.write_text": sessionFileWriteTextInputSchema,
  "work.create": workItemCreateInputSchema,
  "work.list": workItemListInputSchema,
  "work.get": workItemInputSchema,
  "work.revise": workItemReviseInputSchema,
  "work.reassign": workItemReassignInputSchema,
  "work.move": workItemMoveInputSchema,
  "work.clone": workItemCloneInputSchema,
  "work.reopen": workItemReopenInputSchema,
  "work.archive": workItemArchiveInputSchema,
  "work.restore": workItemRestoreInputSchema,
  "work.delete": workItemDeleteInputSchema,
  "work.history.append": workItemHistoryAppendInputSchema,
  "work.history.list": workItemHistoryListInputSchema,
  "work.transition": workItemTransitionInputSchema,
  "work.result": workItemResultInputSchema,
  "work.cancel": workItemCancelInputSchema,
  "work.aggregation.get": workItemAggregationGetInputSchema,
  "work.aggregation.list": workItemAggregationListInputSchema,
  "work.aggregation.decide": workItemAggregationDecisionInputSchema,
  "work.aggregation.retry": workItemAggregationRetryInputSchema,
  "turn.options": sessionGetInputSchema,
  "turn.run": runInputSchema,
  "turn.enqueue": enqueueInputSchema,
  "turn.list": listInputSchema,
  "turn.get": executionInputSchema,
  "turn.cancel": cancelInputSchema,
  "interaction.list": interactionListInputSchema,
  "interaction.respond": interactionRespondInputSchema,
  "coordination.event.create": coordinationCreateInputSchema,
  "coordination.event.list": coordinationListInputSchema,
  "coordination.event.get": coordinationGetInputSchema,
  "coordination.event.resolve": coordinationResolveInputSchema,
  "coordination.event.consume": coordinationConsumeInputSchema,
  "coordination.event.cancel": coordinationCancelInputSchema,
  "coordination.event.correct": coordinationCorrectInputSchema,
  "transcript.export": transcriptExportInputSchema,
};

export function createSessionRuntimeInputSchema(operation: SessionRuntimeOperation): z.ZodType {
  return inputSchemas[operation];
}

export function createSessionRuntimeAdvertisedInputSchema(operation: SessionRuntimeOperation): z.ZodType {
  const advertised = z.toJSONSchema(inputSchemas[operation]) as Record<string, unknown>;
  delete advertised.$schema;
  advertised.additionalProperties = false;
  return z.looseObject({}).meta(advertised);
}

export function parseSessionRuntimeErrorEnvelope(value: unknown): SessionRuntimeError {
  return errorSchema.parse(value) as SessionRuntimeError;
}

export function parseSessionRuntimeResultEnvelope<O extends SessionRuntimeOperation>(
  operation: O,
  value: unknown,
): SessionRuntimeResultEnvelope<O> {
  return createSessionRuntimeResultEnvelopeSchema(operation).parse(value) as SessionRuntimeResultEnvelope<O>;
}

export function parseSessionRuntimeResponseEnvelope<O extends SessionRuntimeOperation>(
  operation: O,
  value: unknown,
): SessionRuntimeResultEnvelope<O> | SessionRuntimeError {
  const error = errorSchema.safeParse(value);
  if (error.success) return error.data as SessionRuntimeError;
  return parseSessionRuntimeResultEnvelope(operation, value);
}
