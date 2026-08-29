import { APPROVAL_MODE_VALUES, type ApprovalMode } from "./approval-mode.js";
import { CODEX_SANDBOX_MODE_VALUES, type CodexSandboxMode } from "./codex-sandbox-mode.js";
import { isModelReasoningEffort, type ModelReasoningEffort } from "./model-catalog.js";
import type { SessionExecution } from "./session-execution.js";
import {
  type SessionInteraction,
  type SessionInteractionResponse,
} from "./session-interaction.js";
import type { ComposerAttachmentKind } from "./runtime-state.js";
import {
  COORDINATION_EVENT_DEFAULT_LIST_LIMIT,
  COORDINATION_EVENT_KINDS,
  COORDINATION_EVENT_MAX_LIST_LIMIT,
  COORDINATION_EVENT_STATES,
  assertKeys as assertCoordinationKeys,
  requireObject as requireCoordinationObject,
  validateCoordinationEventOptions,
  validateCoordinationEventNote,
  validateCoordinationEventPayload,
  type CoordinationEvent,
  type CoordinationEventCancelInput,
  type CoordinationEventConsumeInput,
  type CoordinationEventCorrectInput,
  type CoordinationEventCorrectionResult,
  type CoordinationEventCreateInput,
  type CoordinationEventGetInput,
  type CoordinationEventListInput,
  type CoordinationEventListResult,
  type CoordinationEventResolveInput,
} from "./coordination-event.js";
import {
  SESSION_ROLE_CONTRACT_REVISION,
  SESSION_ROLE_MAX_DELEGATION_DEPTH,
  type ChildSessionRole,
  type SessionRole,
  type SessionRoleBinding,
} from "./session-role-binding.js";
import { SESSION_TURN_COMMUNICATION_CONTRACT_REVISION } from "./session-turn-communication-authority.js";
import {
  WORK_ITEM_CONTRACT_REVISION,
  WORK_ITEM_AGGREGATION_CONTRACT_REVISION,
  WORK_ITEM_AGGREGATION_DECISIONS,
  WORK_ITEM_AGGREGATION_DEFAULT_LIST_LIMIT,
  WORK_ITEM_AGGREGATION_MAX_LIST_LIMIT,
  WORK_ITEM_DEFAULT_LIST_LIMIT,
  WORK_ITEM_MAX_LIST_LIMIT,
  WORK_ITEM_MAX_RESULT_BYTES,
  WORK_ITEM_MAX_RESULT_ITEMS,
  WORK_ITEM_MAX_TEXT_LENGTH,
  WORK_ITEM_STATES,
  type WorkItem,
  type WorkItemAggregationDecision,
  type WorkItemAggregationDecisionType,
  type WorkItemAggregationListItem,
  type WorkItemAggregationSummary,
  type WorkItemResult,
  type WorkItemResultState,
  type WorkItemSourceIdentity,
  type WorkItemState,
} from "./work-item.js";
import {
  SESSION_TRANSCRIPT_FOLDER_DEFAULT_MAX_BYTES,
  SESSION_TRANSCRIPT_FOLDER_HARD_MAX_BYTES,
  SESSION_TRANSCRIPT_INLINE_DEFAULT_MAX_BYTES,
  SESSION_TRANSCRIPT_INLINE_HARD_MAX_BYTES,
  type SessionTranscriptExportInput,
  type SessionTranscriptExportResult,
} from "./session-transcript.js";

export const SESSION_RUNTIME_REQUEST_SCHEMA_VERSION = "withmate-session-request-v2" as const;
export const SESSION_RUNTIME_RESULT_SCHEMA_VERSION = "withmate-session-result-v2" as const;
export const SESSION_RUNTIME_ERROR_SCHEMA_VERSION = "withmate-session-error-v2" as const;
export const SESSION_RUNTIME_MAX_BODY_BYTES = 8 * 1024 * 1024;
export const SESSION_RUNTIME_MAX_INLINE_TEXT_BYTES = 8 * 1024 * 1024;
export const SESSION_RUNTIME_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export const SESSION_RUNTIME_DEFAULT_FILE_TEXT_BYTES = 1024 * 1024;
export const SESSION_RUNTIME_MAX_FILE_TEXT_BYTES = 8 * 1024 * 1024;
export const SESSION_RUNTIME_DEFAULT_LIST_LIMIT = 50;
export const SESSION_RUNTIME_MAX_LIST_LIMIT = 500;
export const SESSION_RUNTIME_DEFAULT_WAIT_TIMEOUT_MS = 30_000;
export const SESSION_RUNTIME_MAX_WAIT_TIMEOUT_MS = 300_000;
export const SESSION_RUNTIME_MAX_TURN_ATTACHMENTS = 32;

export const SESSION_RUNTIME_OPERATIONS = [
  "runtime.catalog",
  "session.self",
  "session.create",
  "session.list",
  "session.get",
  "session.rename",
  "session.files.list",
  "session.files.read_text",
  "session.files.write_text",
  "work.create",
  "work.list",
  "work.get",
  "work.transition",
  "work.result",
  "work.cancel",
  "work.aggregation.get",
  "work.aggregation.list",
  "work.aggregation.decide",
  "work.aggregation.retry",
  "turn.options",
  "turn.run",
  "turn.enqueue",
  "turn.list",
  "turn.get",
  "turn.cancel",
  "interaction.list",
  "interaction.respond",
  "coordination.event.create",
  "coordination.event.list",
  "coordination.event.get",
  "coordination.event.resolve",
  "coordination.event.consume",
  "coordination.event.cancel",
  "coordination.event.correct",
  "transcript.export",
] as const;

export type SessionRuntimeOperation = (typeof SESSION_RUNTIME_OPERATIONS)[number];
export type SessionRuntimeAdapterKind = "cli" | "mcp";
export type SessionRuntimeEffect = "not_applied" | "applied" | "indeterminate";
export const SESSION_RUNTIME_PROVIDER_IDS = ["codex", "copilot"] as const;
export type SessionRuntimeProviderId = (typeof SESSION_RUNTIME_PROVIDER_IDS)[number];

export type SessionRuntimeCatalogResult = {
  revision: number;
  sessionRoleContractRevision: typeof SESSION_ROLE_CONTRACT_REVISION;
  supportedSessionRoles: SessionRole[];
  allowedChildSessionRoles: Record<SessionRole, ChildSessionRole[]>;
  maxDelegationDepth: typeof SESSION_ROLE_MAX_DELEGATION_DEPTH;
  sessionTurnCommunicationContractRevision: typeof SESSION_TURN_COMMUNICATION_CONTRACT_REVISION;
  coordinationEvents: {
    kinds: typeof COORDINATION_EVENT_KINDS;
    states: typeof COORDINATION_EVENT_STATES;
    scopes: readonly ["self", "subtree"];
    defaultListLimit: typeof COORDINATION_EVENT_DEFAULT_LIST_LIMIT;
    maxListLimit: typeof COORDINATION_EVENT_MAX_LIST_LIMIT;
  };
  workItems: {
    contractRevision: typeof WORK_ITEM_CONTRACT_REVISION;
    states: typeof WORK_ITEM_STATES;
    mutations: readonly ["create", "transition", "result", "cancel"];
    defaultListLimit: typeof WORK_ITEM_DEFAULT_LIST_LIMIT;
    maxListLimit: typeof WORK_ITEM_MAX_LIST_LIMIT;
    aggregation: {
      contractRevision: typeof WORK_ITEM_AGGREGATION_CONTRACT_REVISION;
      decisions: typeof WORK_ITEM_AGGREGATION_DECISIONS;
      operations: readonly ["get", "list", "decide", "retry"];
      defaultListLimit: typeof WORK_ITEM_AGGREGATION_DEFAULT_LIST_LIMIT;
      maxListLimit: typeof WORK_ITEM_AGGREGATION_MAX_LIST_LIMIT;
    };
    maxListResponseBytes: typeof SESSION_RUNTIME_MAX_RESPONSE_BYTES;
    maxResultBytes: typeof WORK_ITEM_MAX_RESULT_BYTES;
  };
  providers: Array<{
    id: string;
    label: string;
    defaultModelId: string;
    defaultReasoningEffort: ModelReasoningEffort;
    models: Array<{
      id: string;
      label: string;
      reasoningEfforts: ModelReasoningEffort[];
    }>;
  }>;
};

export type SessionRuntimePublicRoleBinding = SessionRoleBinding;

export type SessionRuntimeSelfResult = SessionRuntimePublicRoleBinding & {
  sessionId: string;
};

export type SessionRuntimeCreateWorkspace =
  | { kind: "directory"; path: string }
  | { kind: "session_folder" };

export type SessionRuntimeCreateInput = {
  sessionRole: ChildSessionRole;
  title: string;
  provider: SessionRuntimeProviderId;
  catalogRevision: number;
  workspace: SessionRuntimeCreateWorkspace;
  idempotencyKey: string;
};

export type SessionRuntimeSessionInput = { sessionId: string };
export type SessionRuntimeSessionListInput = { limit: number; cursor?: string };
export type SessionRuntimeRenameInput = SessionRuntimeSessionInput & {
  title: string;
  idempotencyKey: string;
};

export type SessionRuntimePublicCharacter = { id: string; name: string };
export type SessionRuntimePublicWorkspace = {
  kind: "directory" | "session_folder";
  label: string;
  path: string;
};
export type SessionRuntimePublicSessionFolder = { path: string; isWorkspace: boolean };
export type SessionRuntimeSessionSummary = SessionRuntimePublicRoleBinding & {
  sessionId: string;
  title: string;
  sessionKind: "default";
  provider: { id: string; catalogRevision: number };
  character: SessionRuntimePublicCharacter;
  workspace: SessionRuntimePublicWorkspace;
  updatedAt: string;
};
export type SessionRuntimeSessionDetail = SessionRuntimeSessionSummary & {
  sessionFolder: SessionRuntimePublicSessionFolder;
};
export type SessionRuntimeSessionGetResult = Omit<SessionRuntimeSessionDetail, "workspace"> & {
  workspace: SessionRuntimePublicWorkspace & { branch: string | null };
};
export type SessionRuntimeSessionListResult = {
  items: SessionRuntimeSessionSummary[];
  nextCursor?: string;
};

export type SessionRuntimeFileReference = {
  sessionId: string;
  relativePath: string;
  byteLength: number;
  modifiedAt: string;
};
export type SessionRuntimeFileListInput = SessionRuntimeSessionInput & {
  limit: number;
  cursor?: string;
};
export type SessionRuntimeFileListResult = {
  items: SessionRuntimeFileReference[];
  nextCursor?: string;
};
export type SessionRuntimeFileReadTextInput = SessionRuntimeSessionInput & {
  relativePath: string;
  maxBytes: number;
};
export type SessionRuntimeFileReadTextResult = {
  file: SessionRuntimeFileReference;
  content: string;
};
export type SessionRuntimeFileWriteTextInput = SessionRuntimeSessionInput & {
  relativePath: string;
  content: string;
  maxBytes: number;
  replace: boolean;
  idempotencyKey: string;
};
export type SessionRuntimeFileWriteTextResult = {
  file: SessionRuntimeFileReference;
};

export type SessionRuntimeWorkItemCreateInput = {
  targetSessionId: string;
  parentWorkItemId?: string;
  goal: string;
  scope: string;
  completionCriteria: string;
  authority: string;
  sourceIdentity: WorkItemSourceIdentity;
  idempotencyKey: string;
};
export type SessionRuntimeWorkItemInput = { workItemId: string };
export type SessionRuntimeWorkItemListInput = {
  creatorSessionId?: string;
  targetSessionId?: string;
  state?: WorkItemState;
  limit: number;
  cursor?: string;
};
export type SessionRuntimeWorkItemListResult = { items: WorkItem[]; nextCursor?: string };
export type SessionRuntimeWorkItemTransitionInput = {
  workItemId: string;
  state: "in_progress" | "waiting";
  expectedRevision: number;
  idempotencyKey: string;
};
export type SessionRuntimeWorkItemResultInput = {
  workItemId: string;
  state: WorkItemResultState;
  expectedRevision: number;
  result: Omit<WorkItemResult, "outcome" | "reportingSessionId" | "reportedAt">;
  idempotencyKey: string;
  expectedAggregateRevision?: number;
};
export type SessionRuntimeWorkItemCancelInput = {
  workItemId: string;
  expectedRevision: number;
  idempotencyKey: string;
};
export type SessionRuntimeWorkItemAggregationGetInput = { parentWorkItemId: string };
export type SessionRuntimeWorkItemAggregationListInput = {
  parentWorkItemId: string;
  decision?: WorkItemAggregationDecisionType;
  limit: number;
  cursor?: string;
};
export type SessionRuntimeWorkItemAggregationListResult = {
  items: WorkItemAggregationListItem[];
  nextCursor?: string;
};
export type SessionRuntimeWorkItemAggregationDecisionInput = {
  parentWorkItemId: string;
  childWorkItemId: string;
  decision: "accepted" | "excluded";
  reason?: string;
  expectedAggregateRevision: number;
  idempotencyKey: string;
};
export type SessionRuntimeWorkItemAggregationRetryInput = {
  parentWorkItemId: string;
  childWorkItemId: string;
  targetSessionId: string;
  goal: string;
  scope: string;
  completionCriteria: string;
  authority: string;
  sourceIdentity: WorkItemSourceIdentity;
  reason?: string;
  expectedAggregateRevision: number;
  idempotencyKey: string;
};
export type SessionRuntimeWorkItemAggregationRetryResult = {
  decision: WorkItemAggregationDecision;
  replacement: WorkItem;
};

type SessionRuntimeTurnRequestBase = {
  userMessage: string;
  model: string;
  reasoningEffort: ModelReasoningEffort;
  approvalMode: ApprovalMode;
  attachments: SessionRuntimeTurnAttachment[];
};

export type SessionRuntimeTurnAttachment = {
  kind: ComposerAttachmentKind;
  relativePath: string;
};

export type SessionRuntimeTurnRequest = SessionRuntimeTurnRequestBase & (
  | {
    provider: "codex";
    codexSandboxMode: CodexSandboxMode;
  }
  | {
    provider: "copilot";
    customAgentName: string;
  }
);

export type SessionRuntimeTerminalFailureNotificationInput = {
  targetSessionId: string;
};

export type SessionRuntimeTerminalFailureNotificationProjection = {
  targetSessionId: string;
  state: "armed" | "pending" | "enqueued" | "failed" | "not_triggered";
  notificationExecutionId: string | null;
  errorCode: string | null;
  updatedAt: string;
};

type SessionRuntimeTurnOptionsBase = {
  sessionId: string;
  catalogRevision: number;
  models: Array<{
    id: string;
    label: string;
    reasoningEfforts: ModelReasoningEffort[];
  }>;
  approvalModes: Array<{ id: ApprovalMode; label: string }>;
};

export type SessionRuntimeTurnOptionsResult = SessionRuntimeTurnOptionsBase & (
  | {
    provider: { id: "codex" };
    codexSandboxModes: Array<{ id: CodexSandboxMode; label: string }>;
  }
  | {
    provider: { id: "copilot" };
    customAgents: Array<{ name: string; displayName: string; description: string }>;
  }
);

type SessionRuntimeEffectiveTurnBase = {
  model: string;
  reasoningEffort: ModelReasoningEffort;
  approvalMode: ApprovalMode;
};

export type SessionRuntimeEffectiveTurn = SessionRuntimeEffectiveTurnBase & (
  | { provider: "codex"; sandboxMode: CodexSandboxMode; customAgentName: null }
  | { provider: "copilot"; sandboxMode: null; customAgentName: string }
);

type SessionRuntimePublicInteractionBase = {
  sequence: number;
  interactionId: string;
  sessionId: string;
  executionId: string;
  kind: SessionInteraction["kind"];
  request: SessionInteraction["publicPayload"];
  createdAt: string;
  updatedAt: string;
};

export type SessionRuntimePendingInteraction = SessionRuntimePublicInteractionBase & {
  state: "pending";
  resolution: null;
};

export type SessionRuntimeAnsweredInteraction = SessionRuntimePublicInteractionBase & {
  state: "answered";
  resolution: {
    action: NonNullable<SessionInteraction["response"]>["action"];
    submittedFields: string[];
    resolvedAt: string;
  };
};

export type SessionRuntimeExpiredInteraction = SessionRuntimePublicInteractionBase & {
  state: "expired";
  resolution: {
    reason: NonNullable<SessionInteraction["expiryReason"]>;
    resolvedAt: string;
  };
};

export type SessionRuntimePublicInteraction =
  | SessionRuntimePendingInteraction
  | SessionRuntimeAnsweredInteraction
  | SessionRuntimeExpiredInteraction;

export type SessionRuntimePublicExecution = Omit<SessionExecution, "result"> & {
  workItemId: string | null;
  result: { assistantText: string } | null;
  effectiveTurn: SessionRuntimeEffectiveTurn | null;
  attachments: SessionRuntimeTurnAttachment[];
  pendingInteraction: SessionRuntimePublicInteraction | null;
  partialOutput: {
    assistantText: string;
    truncated: boolean;
    updatedAt: string;
  } | null;
  terminalFailureNotification: SessionRuntimeTerminalFailureNotificationProjection | null;
};

export type SessionRuntimeTurnListResult = {
  items: SessionRuntimePublicExecution[];
  nextCursor?: string;
};

export type SessionRuntimeInteractionListInput = {
  sessionId: string;
  executionId?: string;
  kind?: "approval" | "elicitation";
  state?: "pending" | "answered" | "expired";
  limit: number;
  cursor?: string;
};

export type SessionRuntimeInteractionListResult = {
  items: SessionRuntimePublicInteraction[];
  nextCursor?: string;
};

export type SessionRuntimeInteractionRespondInput = {
  sessionId: string;
  executionId: string;
  interactionId: string;
  response: SessionInteractionResponse;
  idempotencyKey: string;
  responseMode: "wait" | "deferred";
  waitTimeoutMs?: number;
};

export type SessionRuntimeInteractionRespondResult = {
  interaction: SessionRuntimeAnsweredInteraction;
  execution: SessionRuntimePublicExecution;
};

export type SessionRuntimeTranscriptExportInput = SessionTranscriptExportInput;
export type SessionRuntimeTranscriptExportResult = SessionTranscriptExportResult;

export type SessionRuntimeResultByOperation = {
  "runtime.catalog": SessionRuntimeCatalogResult;
  "session.self": SessionRuntimeSelfResult;
  "session.create": SessionRuntimeSessionDetail;
  "session.list": SessionRuntimeSessionListResult;
  "session.get": SessionRuntimeSessionGetResult;
  "session.rename": SessionRuntimeSessionDetail;
  "session.files.list": SessionRuntimeFileListResult;
  "session.files.read_text": SessionRuntimeFileReadTextResult;
  "session.files.write_text": SessionRuntimeFileWriteTextResult;
  "work.create": WorkItem;
  "work.list": SessionRuntimeWorkItemListResult;
  "work.get": WorkItem;
  "work.transition": WorkItem;
  "work.result": WorkItem;
  "work.cancel": WorkItem;
  "work.aggregation.get": WorkItemAggregationSummary;
  "work.aggregation.list": SessionRuntimeWorkItemAggregationListResult;
  "work.aggregation.decide": WorkItemAggregationDecision;
  "work.aggregation.retry": SessionRuntimeWorkItemAggregationRetryResult;
  "turn.options": SessionRuntimeTurnOptionsResult;
  "turn.run": SessionRuntimePublicExecution;
  "turn.enqueue": SessionRuntimePublicExecution;
  "turn.list": SessionRuntimeTurnListResult;
  "turn.get": SessionRuntimePublicExecution;
  "turn.cancel": SessionRuntimePublicExecution;
  "interaction.list": SessionRuntimeInteractionListResult;
  "interaction.respond": SessionRuntimeInteractionRespondResult;
  "coordination.event.create": CoordinationEvent;
  "coordination.event.list": CoordinationEventListResult;
  "coordination.event.get": CoordinationEvent;
  "coordination.event.resolve": CoordinationEvent;
  "coordination.event.consume": CoordinationEvent;
  "coordination.event.cancel": CoordinationEvent;
  "coordination.event.correct": CoordinationEventCorrectionResult;
  "transcript.export": SessionRuntimeTranscriptExportResult;
};

export type SessionRuntimeRunInput = {
  sessionId: string;
  catalogRevision: number;
  idempotencyKey: string;
  responseMode: "wait" | "deferred";
  waitTimeoutMs?: number;
  turn: SessionRuntimeTurnRequest;
  terminalFailureNotification?: SessionRuntimeTerminalFailureNotificationInput;
  workItemId?: string;
};

export type SessionRuntimeEnqueueInput = Omit<SessionRuntimeRunInput, "responseMode" | "waitTimeoutMs">;
export type SessionRuntimeExecutionInput = { sessionId: string; executionId: string };
export type SessionRuntimeCancelInput = SessionRuntimeExecutionInput & { idempotencyKey: string };
export type SessionRuntimeListInput = { sessionId: string; limit: number; cursor?: string };

export type SessionRuntimeRequestEnvelope = {
  schemaVersion: typeof SESSION_RUNTIME_REQUEST_SCHEMA_VERSION;
  operation: SessionRuntimeOperation;
  input: unknown;
};

export type SessionRuntimeResultEnvelope<O extends SessionRuntimeOperation = SessionRuntimeOperation> = {
  [K in O]: {
    schemaVersion: typeof SESSION_RUNTIME_RESULT_SCHEMA_VERSION;
    operation: K;
    result: SessionRuntimeResultByOperation[K];
  }
}[O];

export type SessionRuntimeError = {
  schemaVersion: typeof SESSION_RUNTIME_ERROR_SCHEMA_VERSION;
  error: {
    code: string;
    message: string;
    retryable: boolean;
    effect: SessionRuntimeEffect;
    details: Record<string, string | number | boolean>;
  };
};

export class SessionRuntimeValidationError extends Error {
  readonly code: string;
  readonly details: Record<string, string | number | boolean>;

  constructor(message: string, details: Record<string, string | number | boolean> = {}, code = "INVALID_INPUT") {
    super(message);
    this.name = "SessionRuntimeValidationError";
    this.code = code;
    this.details = details;
  }
}

export class SessionRuntimeProjectionLimitError extends SessionRuntimeValidationError {
  constructor(field: string, details: Record<string, string | number | boolean> = {}) {
    super(
      "Session runtime inline response exceeds 8 MiB.",
      { field, maxBytes: SESSION_RUNTIME_MAX_RESPONSE_BYTES, ...details },
      "CONTENT_TOO_LARGE",
    );
    this.name = "SessionRuntimeProjectionLimitError";
  }
}

export function assertSessionRuntimeRequestBodySize(actualBytes: number, field = "requestBody"): void {
  if (actualBytes <= SESSION_RUNTIME_MAX_BODY_BYTES) return;
  throw new SessionRuntimeValidationError(
    "Session runtime request body exceeds 8 MiB.",
    { field, actualBytes, maxBytes: SESSION_RUNTIME_MAX_BODY_BYTES },
    "CONTENT_TOO_LARGE",
  );
}

export function parseSessionRuntimeRequestEnvelope(value: unknown): SessionRuntimeRequestEnvelope {
  const record = requireObject(value, "request");
  assertKeys(record, ["schemaVersion", "operation", "input"], "request");
  if (record.schemaVersion !== SESSION_RUNTIME_REQUEST_SCHEMA_VERSION) {
    throw invalid("schemaVersion", "Unsupported Session runtime request schemaVersion.");
  }
  if (!SESSION_RUNTIME_OPERATIONS.includes(record.operation as SessionRuntimeOperation)) {
    throw invalid("operation", "Unsupported Session runtime operation.");
  }
  return {
    schemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
    operation: record.operation as SessionRuntimeOperation,
    input: parseSessionRuntimeOperationInput(record.operation as SessionRuntimeOperation, record.input),
  };
}

export function parseSessionRuntimeOperationInput(operation: SessionRuntimeOperation, value: unknown): unknown {
  if (!SESSION_RUNTIME_OPERATIONS.includes(operation)) {
    throw invalid("operation", "Unsupported Session runtime operation.");
  }
  if (operation === "runtime.catalog" || operation === "session.self") {
    const record = requireObject(value, "input");
    assertKeys(record, [], "input");
    return {};
  }
  if (operation === "session.create") {
    return parseSessionCreateInput(value);
  }
  if (operation === "session.list") {
    return parseSessionListInput(value);
  }
  if (operation === "session.get") {
    return parseSessionInput(value);
  }
  if (operation === "session.rename") {
    return parseSessionRenameInput(value);
  }
  if (operation === "session.files.list") {
    return parseSessionFileListInput(value);
  }
  if (operation === "session.files.read_text") {
    return parseSessionFileReadTextInput(value);
  }
  if (operation === "session.files.write_text") {
    return parseSessionFileWriteTextInput(value);
  }
  if (operation === "work.create") return parseWorkItemCreateInput(value);
  if (operation === "work.list") return parseWorkItemListInput(value);
  if (operation === "work.get") return parseWorkItemInput(value);
  if (operation === "work.transition") return parseWorkItemTransitionInput(value);
  if (operation === "work.result") return parseWorkItemResultInput(value);
  if (operation === "work.cancel") return parseWorkItemCancelInput(value);
  if (operation === "work.aggregation.get") return parseWorkItemAggregationGetInput(value);
  if (operation === "work.aggregation.list") return parseWorkItemAggregationListInput(value);
  if (operation === "work.aggregation.decide") return parseWorkItemAggregationDecisionInput(value);
  if (operation === "work.aggregation.retry") return parseWorkItemAggregationRetryInput(value);
  if (operation === "turn.options") {
    return parseSessionInput(value);
  }
  if (operation === "turn.run") {
    return parseTurnRunInput(value);
  }
  if (operation === "turn.enqueue") {
    return parseTurnEnqueueInput(value);
  }
  if (operation === "turn.list") {
    return parseTurnListInput(value);
  }
  if (operation === "turn.get") {
    return parseExecutionInput(value);
  }
  if (operation === "turn.cancel") {
    return parseCancelInput(value);
  }
  if (operation === "interaction.list") {
    return parseInteractionListInput(value);
  }
  if (operation === "interaction.respond") {
    return parseInteractionRespondInput(value);
  }
  if (operation === "coordination.event.create") {
    return parseCoordinationEventCreateInput(value);
  }
  if (operation === "coordination.event.list") {
    return parseCoordinationEventListInput(value);
  }
  if (operation === "coordination.event.get") {
    return parseCoordinationEventGetInput(value);
  }
  if (operation === "coordination.event.resolve") {
    return parseCoordinationEventResolveInput(value);
  }
  if (operation === "coordination.event.consume") {
    return parseCoordinationEventConsumeInput(value);
  }
  if (operation === "coordination.event.cancel") {
    return parseCoordinationEventCancelInput(value);
  }
  if (operation === "coordination.event.correct") {
    return parseCoordinationEventCorrectInput(value);
  }
  if (operation === "transcript.export") {
    return parseTranscriptExportInput(value);
  }
  throw invalid("operation", "Unsupported Session runtime operation.");
}

function parseCoordinationEventCreateInput(value: unknown): CoordinationEventCreateInput {
  const record = requireCoordinationObject(value, "input");
  assertCoordinationKeys(record, ["kind", "payload", "executionId", "targetSessionId", "options", "idempotencyKey"], "input");
  const kind = requireEnum(record.kind, COORDINATION_EVENT_KINDS.filter((candidate) => candidate !== "correction"), "kind") as CoordinationEventCreateInput["kind"];
  const targetSessionId = record.targetSessionId === undefined ? undefined : requireNonEmptyString(record.targetSessionId, "targetSessionId");
  const options = record.options === undefined ? undefined : validateCoordinationEventOptions(record.options);
  if ((kind === "escalation") !== (targetSessionId !== undefined)) {
    throw invalid("targetSessionId", "targetSessionId is required only for escalation events.");
  }
  if ((kind === "user_decision_required") !== (options !== undefined)) {
    throw invalid("options", "options are required only for user_decision_required events.");
  }
  return {
    kind,
    payload: validateCoordinationEventPayload(record.payload),
    ...(record.executionId === undefined ? {} : { executionId: requireNonEmptyString(record.executionId, "executionId") }),
    ...(targetSessionId === undefined ? {} : { targetSessionId }),
    ...(options === undefined ? {} : { options }),
    idempotencyKey: requireNonEmptyString(record.idempotencyKey, "idempotencyKey"),
  };
}

function parseCoordinationEventListInput(value: unknown): CoordinationEventListInput {
  const record = requireCoordinationObject(value, "input");
  assertCoordinationKeys(record, ["scope", "kind", "state", "limit", "cursor"], "input");
  return {
    scope: requireEnum(record.scope, ["self", "subtree"] as const, "scope"),
    ...(record.kind === undefined ? {} : { kind: requireEnum(record.kind, COORDINATION_EVENT_KINDS, "kind") }),
    ...(record.state === undefined ? {} : { state: requireEnum(record.state, COORDINATION_EVENT_STATES, "state") }),
    limit: record.limit === undefined
      ? COORDINATION_EVENT_DEFAULT_LIST_LIMIT
      : requireInteger(record.limit, "limit", 1, COORDINATION_EVENT_MAX_LIST_LIMIT, "LIMIT_EXCEEDED"),
    ...(record.cursor === undefined ? {} : { cursor: requireNonEmptyString(record.cursor, "cursor") }),
  };
}

function parseCoordinationEventGetInput(value: unknown): CoordinationEventGetInput {
  const record = requireCoordinationObject(value, "input");
  assertCoordinationKeys(record, ["eventId", "idempotencyKey"], "input");
  const hasEventId = record.eventId !== undefined;
  const hasKey = record.idempotencyKey !== undefined;
  if (hasEventId === hasKey) throw invalid("input", "Exactly one of eventId or idempotencyKey is required.");
  return hasEventId
    ? { eventId: requireNonEmptyString(record.eventId, "eventId") }
    : { idempotencyKey: requireNonEmptyString(record.idempotencyKey, "idempotencyKey") };
}

function parseCoordinationEventResolveInput(value: unknown): CoordinationEventResolveInput {
  const record = requireCoordinationObject(value, "input");
  assertCoordinationKeys(record, ["eventId", "note", "idempotencyKey"], "input");
  return {
    eventId: requireNonEmptyString(record.eventId, "eventId"),
    ...(record.note === undefined ? {} : { note: validateCoordinationEventNote(record.note) }),
    idempotencyKey: requireNonEmptyString(record.idempotencyKey, "idempotencyKey"),
  };
}

function parseCoordinationEventConsumeInput(value: unknown): CoordinationEventConsumeInput {
  const record = requireCoordinationObject(value, "input");
  assertCoordinationKeys(record, ["eventId", "expectedResolutionSequence", "idempotencyKey"], "input");
  return {
    eventId: requireNonEmptyString(record.eventId, "eventId"),
    expectedResolutionSequence: requireInteger(
      record.expectedResolutionSequence,
      "expectedResolutionSequence",
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    idempotencyKey: requireNonEmptyString(record.idempotencyKey, "idempotencyKey"),
  };
}

function parseCoordinationEventCancelInput(value: unknown): CoordinationEventCancelInput {
  const record = requireCoordinationObject(value, "input");
  assertCoordinationKeys(record, ["eventId", "note", "idempotencyKey"], "input");
  return {
    eventId: requireNonEmptyString(record.eventId, "eventId"),
    ...(record.note === undefined ? {} : { note: validateCoordinationEventNote(record.note) }),
    idempotencyKey: requireNonEmptyString(record.idempotencyKey, "idempotencyKey"),
  };
}

function parseCoordinationEventCorrectInput(value: unknown): CoordinationEventCorrectInput {
  const record = requireCoordinationObject(value, "input");
  assertCoordinationKeys(record, ["eventId", "payload", "executionId", "idempotencyKey"], "input");
  return {
    eventId: requireNonEmptyString(record.eventId, "eventId"),
    payload: validateCoordinationEventPayload(record.payload),
    ...(record.executionId === undefined ? {} : { executionId: requireNonEmptyString(record.executionId, "executionId") }),
    idempotencyKey: requireNonEmptyString(record.idempotencyKey, "idempotencyKey"),
  };
}

function requireBoundedString(value: unknown, field: string, maxLength: number): string {
  const text = requireNonEmptyString(value, field);
  if (text.length > maxLength) throw invalid(field, `${field} exceeds ${maxLength} characters.`);
  return text;
}

function parseSessionCreateInput(value: unknown): SessionRuntimeCreateInput {
  const record = requireObject(value, "input");
  assertKeys(record, ["sessionRole", "title", "provider", "catalogRevision", "workspace", "idempotencyKey"], "input");
  return {
    sessionRole: requireEnum(record.sessionRole, ["task-coordinator", "executor"] as const, "sessionRole"),
    title: requireNonEmptyString(record.title, "title"),
    provider: requireEnum(record.provider, SESSION_RUNTIME_PROVIDER_IDS, "provider"),
    catalogRevision: requireInteger(record.catalogRevision, "catalogRevision", 1, Number.MAX_SAFE_INTEGER),
    workspace: parseSessionCreateWorkspace(record.workspace),
    idempotencyKey: requireNonEmptyString(record.idempotencyKey, "idempotencyKey"),
  };
}

function parseSessionCreateWorkspace(value: unknown): SessionRuntimeCreateWorkspace {
  const record = requireObject(value, "workspace");
  const kind = requireEnum(record.kind, ["directory", "session_folder"] as const, "workspace.kind");
  if (kind === "session_folder") {
    assertKeys(record, ["kind"], "workspace");
    return { kind };
  }
  assertKeys(record, ["kind", "path"], "workspace");
  return { kind, path: requireNonEmptyString(record.path, "workspace.path") };
}

function parseSessionListInput(value: unknown): SessionRuntimeSessionListInput {
  const record = requireObject(value, "input");
  assertKeys(record, ["limit", "cursor"], "input");
  return {
    limit: record.limit === undefined
      ? SESSION_RUNTIME_DEFAULT_LIST_LIMIT
      : requireInteger(record.limit, "limit", 1, SESSION_RUNTIME_MAX_LIST_LIMIT, "LIMIT_EXCEEDED"),
    ...(record.cursor === undefined ? {} : { cursor: requireNonEmptyString(record.cursor, "cursor") }),
  };
}

function parseSessionInput(value: unknown): SessionRuntimeSessionInput {
  const record = requireObject(value, "input");
  assertKeys(record, ["sessionId"], "input");
  return { sessionId: requireNonEmptyString(record.sessionId, "sessionId") };
}

function parseSessionRenameInput(value: unknown): SessionRuntimeRenameInput {
  const record = requireObject(value, "input");
  assertKeys(record, ["sessionId", "title", "idempotencyKey"], "input");
  return {
    sessionId: requireNonEmptyString(record.sessionId, "sessionId"),
    title: requireNonEmptyString(record.title, "title"),
    idempotencyKey: requireNonEmptyString(record.idempotencyKey, "idempotencyKey"),
  };
}

function parseSessionFileListInput(value: unknown): SessionRuntimeFileListInput {
  const record = requireObject(value, "input");
  assertKeys(record, ["sessionId", "limit", "cursor"], "input");
  return {
    sessionId: requireNonEmptyString(record.sessionId, "sessionId"),
    limit: record.limit === undefined
      ? SESSION_RUNTIME_DEFAULT_LIST_LIMIT
      : requireInteger(record.limit, "limit", 1, SESSION_RUNTIME_MAX_LIST_LIMIT, "LIMIT_EXCEEDED"),
    ...(record.cursor === undefined ? {} : { cursor: requireNonEmptyString(record.cursor, "cursor") }),
  };
}

function parseSessionFileReadTextInput(value: unknown): SessionRuntimeFileReadTextInput {
  const record = requireObject(value, "input");
  assertKeys(record, ["sessionId", "relativePath", "maxBytes"], "input");
  return {
    sessionId: requireNonEmptyString(record.sessionId, "sessionId"),
    relativePath: requireNonEmptyString(record.relativePath, "relativePath"),
    maxBytes: record.maxBytes === undefined
      ? SESSION_RUNTIME_DEFAULT_FILE_TEXT_BYTES
      : requireInteger(record.maxBytes, "maxBytes", 1, SESSION_RUNTIME_MAX_FILE_TEXT_BYTES, "LIMIT_EXCEEDED"),
  };
}

function parseSessionFileWriteTextInput(value: unknown): SessionRuntimeFileWriteTextInput {
  const record = requireObject(value, "input");
  assertKeys(
    record,
    ["sessionId", "relativePath", "content", "maxBytes", "replace", "idempotencyKey"],
    "input",
  );
  const maxBytes = record.maxBytes === undefined
    ? SESSION_RUNTIME_DEFAULT_FILE_TEXT_BYTES
    : requireInteger(record.maxBytes, "maxBytes", 1, SESSION_RUNTIME_MAX_FILE_TEXT_BYTES, "LIMIT_EXCEEDED");
  const content = requireString(record.content, "content");
  const actualBytes = Buffer.byteLength(content, "utf8");
  if (actualBytes > maxBytes) {
    throw new SessionRuntimeValidationError(
      "Session file content exceeds the requested byte limit.",
      { field: "content", actualBytes, maxBytes },
      "CONTENT_TOO_LARGE",
    );
  }
  return {
    sessionId: requireNonEmptyString(record.sessionId, "sessionId"),
    relativePath: requireNonEmptyString(record.relativePath, "relativePath"),
    content,
    maxBytes,
    replace: record.replace === undefined ? false : requireBoolean(record.replace, "replace"),
    idempotencyKey: requireNonEmptyString(record.idempotencyKey, "idempotencyKey"),
  };
}

function parseWorkItemCreateInput(value: unknown): SessionRuntimeWorkItemCreateInput {
  const record = requireObject(value, "input");
  assertKeys(record, [
    "targetSessionId", "parentWorkItemId", "goal", "scope", "completionCriteria",
    "authority", "sourceIdentity", "idempotencyKey",
  ], "input");
  const source = requireObject(record.sourceIdentity, "sourceIdentity");
  assertKeys(source, ["workspace", "repository", "branch", "base", "head"], "sourceIdentity");
  return {
    targetSessionId: requireNonEmptyString(record.targetSessionId, "targetSessionId"),
    ...(record.parentWorkItemId === undefined
      ? {}
      : { parentWorkItemId: requireNonEmptyString(record.parentWorkItemId, "parentWorkItemId") }),
    goal: requireBoundedString(record.goal, "goal", WORK_ITEM_MAX_TEXT_LENGTH),
    scope: requireBoundedString(record.scope, "scope", WORK_ITEM_MAX_TEXT_LENGTH),
    completionCriteria: requireBoundedString(record.completionCriteria, "completionCriteria", WORK_ITEM_MAX_TEXT_LENGTH),
    authority: requireBoundedString(record.authority, "authority", WORK_ITEM_MAX_TEXT_LENGTH),
    sourceIdentity: {
      workspace: requireNullableBoundedString(source.workspace, "sourceIdentity.workspace"),
      repository: requireNullableBoundedString(source.repository, "sourceIdentity.repository"),
      branch: requireNullableBoundedString(source.branch, "sourceIdentity.branch"),
      base: requireNullableBoundedString(source.base, "sourceIdentity.base"),
      head: requireNullableBoundedString(source.head, "sourceIdentity.head"),
    },
    idempotencyKey: requireNonEmptyString(record.idempotencyKey, "idempotencyKey"),
  };
}

function parseWorkItemInput(value: unknown): SessionRuntimeWorkItemInput {
  const record = requireObject(value, "input");
  assertKeys(record, ["workItemId"], "input");
  return { workItemId: requireNonEmptyString(record.workItemId, "workItemId") };
}

function parseWorkItemListInput(value: unknown): SessionRuntimeWorkItemListInput {
  const record = requireObject(value, "input");
  assertKeys(record, ["creatorSessionId", "targetSessionId", "state", "limit", "cursor"], "input");
  return {
    ...(record.creatorSessionId === undefined ? {} : { creatorSessionId: requireNonEmptyString(record.creatorSessionId, "creatorSessionId") }),
    ...(record.targetSessionId === undefined ? {} : { targetSessionId: requireNonEmptyString(record.targetSessionId, "targetSessionId") }),
    ...(record.state === undefined ? {} : { state: requireEnum(record.state, WORK_ITEM_STATES, "state") }),
    limit: record.limit === undefined
      ? WORK_ITEM_DEFAULT_LIST_LIMIT
      : requireInteger(record.limit, "limit", 1, WORK_ITEM_MAX_LIST_LIMIT, "LIMIT_EXCEEDED"),
    ...(record.cursor === undefined ? {} : { cursor: requireNonEmptyString(record.cursor, "cursor") }),
  };
}

function parseWorkItemTransitionInput(value: unknown): SessionRuntimeWorkItemTransitionInput {
  const record = requireObject(value, "input");
  assertKeys(record, ["workItemId", "state", "expectedRevision", "idempotencyKey"], "input");
  return {
    workItemId: requireNonEmptyString(record.workItemId, "workItemId"),
    state: requireEnum(record.state, ["in_progress", "waiting"] as const, "state"),
    expectedRevision: requireInteger(record.expectedRevision, "expectedRevision", 1, Number.MAX_SAFE_INTEGER),
    idempotencyKey: requireNonEmptyString(record.idempotencyKey, "idempotencyKey"),
  };
}

function parseWorkItemResultInput(value: unknown): SessionRuntimeWorkItemResultInput {
  const record = requireObject(value, "input");
  assertKeys(record, ["workItemId", "state", "expectedRevision", "expectedAggregateRevision", "result", "idempotencyKey"], "input");
  const state = requireEnum(record.state, ["completed", "partially_completed", "failed"] as const, "state");
  const result = requireObject(record.result, "result");
  assertKeys(result, [
    "summary", "changes", "verificationResults", "findings", "unverifiedItems", "remainingWork",
  ], "result");
  const parsedResult = {
    summary: requireBoundedString(result.summary, "result.summary", WORK_ITEM_MAX_TEXT_LENGTH),
    changes: parseWorkItemStringList(result.changes, "result.changes"),
    verificationResults: parseWorkItemVerificationResults(result.verificationResults),
    findings: parseWorkItemStringList(result.findings, "result.findings"),
    unverifiedItems: parseWorkItemStringList(result.unverifiedItems, "result.unverifiedItems"),
    remainingWork: parseWorkItemStringList(result.remainingWork, "result.remainingWork"),
  };
  const canonicalResult = {
    outcome: state,
    ...parsedResult,
    reportingSessionId: "",
    reportedAt: "",
  };
  const actualBytes = Buffer.byteLength(JSON.stringify(canonicalResult), "utf8");
  if (actualBytes > WORK_ITEM_MAX_RESULT_BYTES) {
    throw new SessionRuntimeValidationError(
      "Work Item result exceeds the byte limit.",
      { field: "result", actualBytes, maxBytes: WORK_ITEM_MAX_RESULT_BYTES },
      "CONTENT_TOO_LARGE",
    );
  }
  return {
    workItemId: requireNonEmptyString(record.workItemId, "workItemId"),
    state,
    expectedRevision: requireInteger(record.expectedRevision, "expectedRevision", 1, Number.MAX_SAFE_INTEGER),
    result: parsedResult,
    idempotencyKey: requireNonEmptyString(record.idempotencyKey, "idempotencyKey"),
    ...(record.expectedAggregateRevision === undefined ? {} : {
      expectedAggregateRevision: requireInteger(record.expectedAggregateRevision, "expectedAggregateRevision", 0, Number.MAX_SAFE_INTEGER),
    }),
  };
}

function parseWorkItemAggregationGetInput(value: unknown): SessionRuntimeWorkItemAggregationGetInput {
  const record = requireObject(value, "input");
  assertKeys(record, ["parentWorkItemId"], "input");
  return { parentWorkItemId: requireNonEmptyString(record.parentWorkItemId, "parentWorkItemId") };
}

function parseWorkItemAggregationListInput(value: unknown): SessionRuntimeWorkItemAggregationListInput {
  const record = requireObject(value, "input");
  assertKeys(record, ["parentWorkItemId", "decision", "limit", "cursor"], "input");
  return {
    parentWorkItemId: requireNonEmptyString(record.parentWorkItemId, "parentWorkItemId"),
    ...(record.decision === undefined ? {} : { decision: requireEnum(record.decision, WORK_ITEM_AGGREGATION_DECISIONS, "decision") }),
    limit: record.limit === undefined ? WORK_ITEM_AGGREGATION_DEFAULT_LIST_LIMIT
      : requireInteger(record.limit, "limit", 1, WORK_ITEM_AGGREGATION_MAX_LIST_LIMIT, "LIMIT_EXCEEDED"),
    ...(record.cursor === undefined ? {} : { cursor: requireNonEmptyString(record.cursor, "cursor") }),
  };
}

function parseWorkItemAggregationDecisionInput(value: unknown): SessionRuntimeWorkItemAggregationDecisionInput {
  const record = requireObject(value, "input");
  assertKeys(record, ["parentWorkItemId", "childWorkItemId", "decision", "reason", "expectedAggregateRevision", "idempotencyKey"], "input");
  const decision = requireEnum(record.decision, ["accepted", "excluded"] as const, "decision");
  const reason = record.reason === undefined ? undefined : requireBoundedString(record.reason, "reason", WORK_ITEM_MAX_TEXT_LENGTH);
  if (decision === "excluded" && reason === undefined) throw invalid("reason", "excluded requires a reason.");
  return {
    parentWorkItemId: requireNonEmptyString(record.parentWorkItemId, "parentWorkItemId"),
    childWorkItemId: requireNonEmptyString(record.childWorkItemId, "childWorkItemId"), decision,
    ...(reason === undefined ? {} : { reason }),
    expectedAggregateRevision: requireInteger(record.expectedAggregateRevision, "expectedAggregateRevision", 1, Number.MAX_SAFE_INTEGER),
    idempotencyKey: requireNonEmptyString(record.idempotencyKey, "idempotencyKey"),
  };
}

function parseWorkItemAggregationRetryInput(value: unknown): SessionRuntimeWorkItemAggregationRetryInput {
  const record = requireObject(value, "input");
  assertKeys(record, ["parentWorkItemId", "childWorkItemId", "targetSessionId", "goal", "scope", "completionCriteria", "authority", "sourceIdentity", "reason", "expectedAggregateRevision", "idempotencyKey"], "input");
  const sourceIdentity = requireObject(record.sourceIdentity, "sourceIdentity");
  assertKeys(sourceIdentity, ["workspace", "repository", "branch", "base", "head"], "sourceIdentity");
  return {
    parentWorkItemId: requireNonEmptyString(record.parentWorkItemId, "parentWorkItemId"),
    childWorkItemId: requireNonEmptyString(record.childWorkItemId, "childWorkItemId"),
    targetSessionId: requireNonEmptyString(record.targetSessionId, "targetSessionId"),
    goal: requireBoundedString(record.goal, "goal", WORK_ITEM_MAX_TEXT_LENGTH),
    scope: requireBoundedString(record.scope, "scope", WORK_ITEM_MAX_TEXT_LENGTH),
    completionCriteria: requireBoundedString(record.completionCriteria, "completionCriteria", WORK_ITEM_MAX_TEXT_LENGTH),
    authority: requireBoundedString(record.authority, "authority", WORK_ITEM_MAX_TEXT_LENGTH),
    sourceIdentity: {
      workspace: requireNullableBoundedString(sourceIdentity.workspace, "sourceIdentity.workspace"),
      repository: requireNullableBoundedString(sourceIdentity.repository, "sourceIdentity.repository"),
      branch: requireNullableBoundedString(sourceIdentity.branch, "sourceIdentity.branch"),
      base: requireNullableBoundedString(sourceIdentity.base, "sourceIdentity.base"),
      head: requireNullableBoundedString(sourceIdentity.head, "sourceIdentity.head"),
    },
    ...(record.reason === undefined ? {} : { reason: requireBoundedString(record.reason, "reason", WORK_ITEM_MAX_TEXT_LENGTH) }),
    expectedAggregateRevision: requireInteger(record.expectedAggregateRevision, "expectedAggregateRevision", 1, Number.MAX_SAFE_INTEGER),
    idempotencyKey: requireNonEmptyString(record.idempotencyKey, "idempotencyKey"),
  };
}

function parseWorkItemCancelInput(value: unknown): SessionRuntimeWorkItemCancelInput {
  const record = requireObject(value, "input");
  assertKeys(record, ["workItemId", "expectedRevision", "idempotencyKey"], "input");
  return {
    workItemId: requireNonEmptyString(record.workItemId, "workItemId"),
    expectedRevision: requireInteger(record.expectedRevision, "expectedRevision", 1, Number.MAX_SAFE_INTEGER),
    idempotencyKey: requireNonEmptyString(record.idempotencyKey, "idempotencyKey"),
  };
}

function parseWorkItemStringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > WORK_ITEM_MAX_RESULT_ITEMS) {
    throw invalid(field, `${field} must contain at most ${WORK_ITEM_MAX_RESULT_ITEMS} items.`, "LIMIT_EXCEEDED");
  }
  return value.map((item, index) => requireBoundedString(item, `${field}[${index}]`, WORK_ITEM_MAX_TEXT_LENGTH));
}

function parseWorkItemVerificationResults(value: unknown): WorkItemResult["verificationResults"] {
  if (!Array.isArray(value) || value.length > WORK_ITEM_MAX_RESULT_ITEMS) {
    throw invalid("result.verificationResults", `result.verificationResults must contain at most ${WORK_ITEM_MAX_RESULT_ITEMS} items.`, "LIMIT_EXCEEDED");
  }
  return value.map((item, index) => {
    const record = requireObject(item, `result.verificationResults[${index}]`);
    assertKeys(record, ["name", "status", "details"], `result.verificationResults[${index}]`);
    return {
      name: requireBoundedString(record.name, `result.verificationResults[${index}].name`, WORK_ITEM_MAX_TEXT_LENGTH),
      status: requireEnum(record.status, ["passed", "failed", "not_run"] as const, `result.verificationResults[${index}].status`),
      details: requireBoundedString(record.details, `result.verificationResults[${index}].details`, WORK_ITEM_MAX_TEXT_LENGTH),
    };
  });
}

function requireNullableBoundedString(value: unknown, field: string): string | null {
  if (value === null) return null;
  return requireBoundedString(value, field, WORK_ITEM_MAX_TEXT_LENGTH);
}

export function createSessionRuntimeResult<O extends SessionRuntimeOperation>(
  operation: O,
  result: SessionRuntimeResultByOperation[O],
): SessionRuntimeResultEnvelope<O> {
  return { schemaVersion: SESSION_RUNTIME_RESULT_SCHEMA_VERSION, operation, result };
}

export function createSessionRuntimeError(input: {
  code: string;
  message: string;
  retryable?: boolean;
  effect?: SessionRuntimeEffect;
  details?: Record<string, string | number | boolean>;
}): SessionRuntimeError {
  return {
    schemaVersion: SESSION_RUNTIME_ERROR_SCHEMA_VERSION,
    error: {
      code: input.code,
      message: input.message,
      retryable: input.retryable ?? false,
      effect: input.effect ?? "not_applied",
      details: input.details ?? {},
    },
  };
}

export function projectSessionExecution(
  execution: SessionExecution,
  observation: {
    request?: unknown;
    pendingInteraction?: SessionInteraction | null;
    partialOutput?: {
      assistantText: string;
      truncated: boolean;
      updatedAt: string;
    } | null;
    terminalFailureNotification?: SessionRuntimeTerminalFailureNotificationProjection | null;
    workItemId?: string | null;
  } = {},
): SessionRuntimePublicExecution {
  try {
    const turn = projectEffectiveTurn(observation.request);
    return {
      id: execution.id,
      sessionId: execution.sessionId,
      operation: execution.operation,
      state: execution.state,
      result: projectTurnResult(execution.result),
      errorCode: execution.errorCode,
      reason: execution.reason,
      createdAt: execution.createdAt,
      admittedAt: execution.admittedAt,
      completedAt: execution.completedAt,
      updatedAt: execution.updatedAt,
      workItemId: observation.workItemId ?? null,
      effectiveTurn: turn?.effectiveTurn ?? null,
      attachments: turn?.attachments ?? [],
      pendingInteraction: observation.pendingInteraction
        ? projectSessionInteraction(observation.pendingInteraction)
        : null,
      partialOutput: observation.partialOutput ?? null,
      terminalFailureNotification: observation.terminalFailureNotification ?? null,
    };
  } catch (error) {
    if (error instanceof SessionRuntimeProjectionLimitError) {
      throw new SessionRuntimeProjectionLimitError(String(error.details.field), {
        sessionId: execution.sessionId,
        executionId: execution.id,
      });
    }
    throw error;
  }
}

export function projectSessionInteraction(
  interaction: SessionInteraction,
): SessionRuntimePublicInteraction {
  const base = {
    sequence: interaction.sequence,
    interactionId: interaction.id,
    sessionId: interaction.sessionId,
    executionId: interaction.executionId,
    kind: interaction.kind,
    request: structuredClone(interaction.publicPayload),
    createdAt: interaction.createdAt,
    updatedAt: interaction.updatedAt,
  };
  if (interaction.state === "pending") {
    return { ...base, state: "pending", resolution: null };
  }
  if (interaction.state === "answered") {
    return {
      ...base,
      state: "answered",
      resolution: {
        action: interaction.response.action,
        submittedFields: [...interaction.response.submittedFields],
        resolvedAt: interaction.resolvedAt,
      },
    };
  }
  return {
    ...base,
    state: "expired",
    resolution: {
      reason: interaction.expiryReason,
      resolvedAt: interaction.resolvedAt,
    },
  };
}

function projectEffectiveTurn(request: unknown): {
  effectiveTurn: SessionRuntimeEffectiveTurn;
  attachments: SessionRuntimeTurnAttachment[];
} | null {
  if (!request || typeof request !== "object" || Array.isArray(request)) return null;
  const turn = (request as Record<string, unknown>).turn;
  if (!turn || typeof turn !== "object" || Array.isArray(turn)) return null;
  try {
    const requestRecord = request as Record<string, unknown>;
    const turnRecord = turn as Record<string, unknown>;
    const attachments = Array.isArray(turnRecord.attachments)
      ? turnRecord.attachments.map((attachment) => {
        if (!attachment || typeof attachment !== "object" || Array.isArray(attachment)) {
          return attachment;
        }
        const attachmentRecord = attachment as Record<string, unknown>;
        const publicAttachment = { ...attachmentRecord };
        delete publicAttachment.identity;
        return publicAttachment;
      })
      : turnRecord.attachments;
    const initiator = requestRecord.initiator as Record<string, unknown> | undefined;
    const provider = initiator?.kind === "user" || requestRecord.source === "gui"
      ? turnRecord.codexSandboxMode !== undefined ? "codex" : "copilot"
      : turnRecord.provider;
    const parsed = parseTurnRequest({ ...turnRecord, provider, attachments });
    return {
      effectiveTurn: parsed.provider === "codex"
        ? {
          provider: parsed.provider,
          model: parsed.model,
          reasoningEffort: parsed.reasoningEffort,
          approvalMode: parsed.approvalMode,
          sandboxMode: parsed.codexSandboxMode,
          customAgentName: null,
        }
        : {
          provider: parsed.provider,
          model: parsed.model,
          reasoningEffort: parsed.reasoningEffort,
          approvalMode: parsed.approvalMode,
          sandboxMode: null,
          customAgentName: parsed.customAgentName,
        },
      attachments: parsed.attachments.map((attachment) => ({ ...attachment })),
    };
  } catch {
    return null;
  }
}

function projectTurnResult(result: unknown): { assistantText: string } | null {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return null;
  }
  const assistantText = (result as Record<string, unknown>).assistantText;
  if (typeof assistantText !== "string") {
    return null;
  }
  if (Buffer.byteLength(assistantText, "utf8") > SESSION_RUNTIME_MAX_INLINE_TEXT_BYTES) {
    throw new SessionRuntimeProjectionLimitError("result.assistantText");
  }
  return { assistantText };
}

function parseTurnRunInput(value: unknown): SessionRuntimeRunInput {
  const record = requireObject(value, "input");
  assertKeys(record, [
    "sessionId",
    "catalogRevision",
    "idempotencyKey",
    "responseMode",
    "waitTimeoutMs",
    "turn",
    "terminalFailureNotification",
    "workItemId",
  ], "input");
  const responseMode = requireEnum(record.responseMode, ["wait", "deferred"] as const, "responseMode");
  if (responseMode === "deferred" && record.waitTimeoutMs !== undefined) {
    throw invalid("waitTimeoutMs", "waitTimeoutMs is only valid when responseMode is wait.");
  }
  return {
    ...parseTurnMutationBase(record),
    responseMode,
    ...(record.waitTimeoutMs === undefined
      ? {}
      : { waitTimeoutMs: requireInteger(record.waitTimeoutMs, "waitTimeoutMs", 1, SESSION_RUNTIME_MAX_WAIT_TIMEOUT_MS) }),
  };
}

function parseTurnEnqueueInput(value: unknown): SessionRuntimeEnqueueInput {
  const record = requireObject(value, "input");
  assertKeys(record, [
    "sessionId",
    "catalogRevision",
    "idempotencyKey",
    "turn",
    "terminalFailureNotification",
    "workItemId",
  ], "input");
  return parseTurnMutationBase(record);
}

function parseTurnMutationBase(record: Record<string, unknown>): SessionRuntimeEnqueueInput {
  return {
    sessionId: requireNonEmptyString(record.sessionId, "sessionId"),
    catalogRevision: requireInteger(record.catalogRevision, "catalogRevision", 1, Number.MAX_SAFE_INTEGER),
    idempotencyKey: requireNonEmptyString(record.idempotencyKey, "idempotencyKey"),
    turn: parseTurnRequest(record.turn),
    ...(record.terminalFailureNotification === undefined
      ? {}
      : { terminalFailureNotification: parseTerminalFailureNotificationInput(record.terminalFailureNotification) }),
    ...(record.workItemId === undefined
      ? {}
      : { workItemId: requireNonEmptyString(record.workItemId, "workItemId") }),
  };
}

function parseTerminalFailureNotificationInput(
  value: unknown,
): SessionRuntimeTerminalFailureNotificationInput {
  const record = requireObject(value, "terminalFailureNotification");
  assertKeys(record, ["targetSessionId"], "terminalFailureNotification");
  return {
    targetSessionId: requireNonEmptyString(
      record.targetSessionId,
      "terminalFailureNotification.targetSessionId",
    ),
  };
}

function parseTurnRequest(value: unknown): SessionRuntimeTurnRequest {
  const record = requireObject(value, "turn");
  const provider = requireEnum(record.provider, SESSION_RUNTIME_PROVIDER_IDS, "turn.provider");
  const reasoningEffort = record.reasoningEffort;
  if (!isModelReasoningEffort(reasoningEffort)) {
    throw invalid("reasoningEffort", "reasoningEffort is invalid.");
  }
  const common = {
    userMessage: requireNonEmptyString(record.userMessage, "userMessage"),
    model: requireNonEmptyString(record.model, "model"),
    reasoningEffort,
    approvalMode: requireEnum(record.approvalMode, APPROVAL_MODE_VALUES, "approvalMode"),
    attachments: parseTurnAttachments(record.attachments),
  };
  if (provider === "codex") {
    assertKeys(record, ["provider", "userMessage", "model", "reasoningEffort", "approvalMode", "codexSandboxMode", "attachments"], "turn");
    return {
      ...common,
      provider,
      codexSandboxMode: requireEnum(record.codexSandboxMode, CODEX_SANDBOX_MODE_VALUES, "codexSandboxMode"),
    };
  }
  assertKeys(record, ["provider", "userMessage", "model", "reasoningEffort", "approvalMode", "customAgentName", "attachments"], "turn");
  return {
    ...common,
    provider,
    customAgentName: requireString(record.customAgentName, "customAgentName").trim(),
  };
}

function parseTurnAttachments(value: unknown): SessionRuntimeTurnAttachment[] {
  if (!Array.isArray(value) || value.length > SESSION_RUNTIME_MAX_TURN_ATTACHMENTS) {
    throw invalid("attachments", `attachments must be an array with at most ${SESSION_RUNTIME_MAX_TURN_ATTACHMENTS} items.`);
  }
  const seen = new Set<string>();
  return value.map((item, index) => {
    const record = requireObject(item, `attachments[${index}]`);
    assertKeys(record, ["kind", "relativePath"], `attachments[${index}]`);
    const relativePath = requireNonEmptyString(record.relativePath, `attachments[${index}].relativePath`);
    if (
      relativePath.includes("\0")
      || relativePath.includes("\\")
      || relativePath.includes("\r")
      || relativePath.includes("\n")
      || relativePath.startsWith("/")
      || /^[a-zA-Z]:/.test(relativePath)
      || relativePath.startsWith("//")
    ) {
      throw invalid(`attachments[${index}].relativePath`, "attachment relativePath must be a portable relative path.");
    }
    const segments = relativePath.split("/");
    if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
      throw invalid(`attachments[${index}].relativePath`, "attachment relativePath must identify an item inside the SessionFolder.");
    }
    const duplicateKey = relativePath.toLowerCase();
    if (seen.has(duplicateKey)) {
      throw invalid(`attachments[${index}].relativePath`, "attachment relativePath must not be duplicated.");
    }
    seen.add(duplicateKey);
    return {
      kind: requireEnum(record.kind, ["file", "folder", "image"] as const, `attachments[${index}].kind`),
      relativePath,
    };
  });
}

function parseExecutionInput(value: unknown): SessionRuntimeExecutionInput {
  const record = requireObject(value, "input");
  assertKeys(record, ["sessionId", "executionId"], "input");
  return {
    sessionId: requireNonEmptyString(record.sessionId, "sessionId"),
    executionId: requireNonEmptyString(record.executionId, "executionId"),
  };
}

function parseCancelInput(value: unknown): SessionRuntimeCancelInput {
  const record = requireObject(value, "input");
  assertKeys(record, ["sessionId", "executionId", "idempotencyKey"], "input");
  return {
    sessionId: requireNonEmptyString(record.sessionId, "sessionId"),
    executionId: requireNonEmptyString(record.executionId, "executionId"),
    idempotencyKey: requireNonEmptyString(record.idempotencyKey, "idempotencyKey"),
  };
}

function parseTurnListInput(value: unknown): SessionRuntimeListInput {
  const record = requireObject(value, "input");
  assertKeys(record, ["sessionId", "limit", "cursor"], "input");
  return {
    sessionId: requireNonEmptyString(record.sessionId, "sessionId"),
    limit: record.limit === undefined
      ? SESSION_RUNTIME_DEFAULT_LIST_LIMIT
      : requireInteger(record.limit, "limit", 1, SESSION_RUNTIME_MAX_LIST_LIMIT, "LIMIT_EXCEEDED"),
    ...(record.cursor === undefined ? {} : { cursor: requireNonEmptyString(record.cursor, "cursor") }),
  };
}

function parseInteractionListInput(value: unknown): SessionRuntimeInteractionListInput {
  const record = requireObject(value, "input");
  assertKeys(record, ["sessionId", "executionId", "kind", "state", "limit", "cursor"], "input");
  return {
    sessionId: requireNonEmptyString(record.sessionId, "sessionId"),
    ...(record.executionId === undefined ? {} : { executionId: requireNonEmptyString(record.executionId, "executionId") }),
    ...(record.kind === undefined ? {} : { kind: requireEnum(record.kind, ["approval", "elicitation"] as const, "kind") }),
    ...(record.state === undefined ? {} : { state: requireEnum(record.state, ["pending", "answered", "expired"] as const, "state") }),
    limit: record.limit === undefined
      ? SESSION_RUNTIME_DEFAULT_LIST_LIMIT
      : requireInteger(record.limit, "limit", 1, SESSION_RUNTIME_MAX_LIST_LIMIT, "LIMIT_EXCEEDED"),
    ...(record.cursor === undefined ? {} : { cursor: requireNonEmptyString(record.cursor, "cursor") }),
  };
}

function parseInteractionRespondInput(value: unknown): SessionRuntimeInteractionRespondInput {
  const record = requireObject(value, "input");
  assertKeys(
    record,
    ["sessionId", "executionId", "interactionId", "response", "idempotencyKey", "responseMode", "waitTimeoutMs"],
    "input",
  );
  const responseMode = requireEnum(record.responseMode, ["wait", "deferred"] as const, "responseMode");
  if (responseMode === "deferred" && record.waitTimeoutMs !== undefined) {
    throw invalid("waitTimeoutMs", "waitTimeoutMs is only valid when responseMode is wait.");
  }
  return {
    sessionId: requireNonEmptyString(record.sessionId, "sessionId"),
    executionId: requireNonEmptyString(record.executionId, "executionId"),
    interactionId: requireNonEmptyString(record.interactionId, "interactionId"),
    response: parseInteractionResponse(record.response),
    idempotencyKey: requireNonEmptyString(record.idempotencyKey, "idempotencyKey"),
    responseMode,
    ...(record.waitTimeoutMs === undefined
      ? {}
      : { waitTimeoutMs: requireInteger(record.waitTimeoutMs, "waitTimeoutMs", 1, SESSION_RUNTIME_MAX_WAIT_TIMEOUT_MS) }),
  };
}

function parseInteractionResponse(value: unknown): SessionInteractionResponse {
  const record = requireObject(value, "response");
  const kind = requireEnum(record.kind, ["approval", "elicitation"] as const, "response.kind");
  if (kind === "approval") {
    assertKeys(record, ["kind", "decision"], "response");
    return { kind, decision: requireEnum(record.decision, ["approve", "deny"] as const, "response.decision") };
  }
  const action = requireEnum(record.action, ["accept", "decline", "cancel"] as const, "response.action");
  if (action !== "accept") {
    assertKeys(record, ["kind", "action"], "response");
    return { kind, action };
  }
  assertKeys(record, ["kind", "action", "content"], "response");
  const content = requireObject(record.content, "response.content");
  return {
    kind,
    action,
    content: Object.fromEntries(Object.entries(content).map(([name, item]) => [
      requireNonEmptyString(name, "response.content field"),
      parseElicitationValue(item, `response.content.${name}`),
    ])),
  };
}

function parseTranscriptExportInput(value: unknown): SessionRuntimeTranscriptExportInput {
  const record = requireObject(value, "input");
  assertKeys(record, ["sessionId", "format", "maxBytes", "destination"], "input");
  const destination = requireObject(record.destination, "destination");
  const kind = requireEnum(destination.kind, ["inline", "session_folder"] as const, "destination.kind");
  const maxBytes = requireInteger(
    record.maxBytes ?? (kind === "inline"
      ? SESSION_TRANSCRIPT_INLINE_DEFAULT_MAX_BYTES
      : SESSION_TRANSCRIPT_FOLDER_DEFAULT_MAX_BYTES),
    "maxBytes",
    1,
    kind === "inline" ? SESSION_TRANSCRIPT_INLINE_HARD_MAX_BYTES : SESSION_TRANSCRIPT_FOLDER_HARD_MAX_BYTES,
    "LIMIT_EXCEEDED",
  );
  if (kind === "inline") {
    assertKeys(destination, ["kind"], "destination");
    return {
      sessionId: requireNonEmptyString(record.sessionId, "sessionId"),
      format: requireEnum(record.format, ["json", "markdown"] as const, "format"),
      maxBytes,
      destination: { kind },
    };
  }
  assertKeys(destination, ["kind", "relativePath", "replace", "idempotencyKey"], "destination");
  return {
    sessionId: requireNonEmptyString(record.sessionId, "sessionId"),
    format: requireEnum(record.format, ["json", "markdown"] as const, "format"),
    maxBytes,
    destination: {
      kind,
      relativePath: requireNonEmptyString(destination.relativePath, "destination.relativePath"),
      replace: destination.replace === undefined ? false : requireBoolean(destination.replace, "destination.replace"),
      idempotencyKey: requireNonEmptyString(destination.idempotencyKey, "destination.idempotencyKey"),
    },
  };
}

function parseElicitationValue(value: unknown, field: string): string | number | boolean | string[] {
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return [...value];
  throw invalid(field, `${field} has an invalid elicitation value.`);
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalid(field, `${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function assertKeys(record: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const unknownKey = Object.keys(record).find((key) => !allowed.includes(key));
  if (unknownKey) {
    throw invalid(`${field}.${unknownKey}`, `Unknown field: ${unknownKey}.`);
  }
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw invalid(field, `${field} must be a non-empty string.`);
  }
  return value.trim();
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw invalid(field, `${field} must be a string.`);
  }
  return value;
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw invalid(field, `${field} must be a boolean.`);
  }
  return value;
}

function requireInteger(value: unknown, field: string, min: number, max: number, code = "INVALID_INPUT"): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw invalid(field, `${field} must be an integer from ${min} through ${max}.`, code);
  }
  return value as number;
}

function requireEnum<const T extends readonly string[]>(value: unknown, values: T, field: string): T[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    throw invalid(field, `${field} is invalid.`);
  }
  return value as T[number];
}

function invalid(field: string, message: string, code = "INVALID_INPUT"): SessionRuntimeValidationError {
  return new SessionRuntimeValidationError(message, { field }, code);
}
