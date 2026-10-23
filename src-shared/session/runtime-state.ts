import { type SessionExecutionOptions } from "./session-execution-options.js";

export type DiffRow = {
  kind: "context" | "add" | "delete" | "modify";
  leftNumber?: number;
  rightNumber?: number;
  leftText?: string;
  rightText?: string;
};

export type ChangedFile = {
  kind: "add" | "edit" | "delete";
  path: string;
  summary: string;
  diffRows: DiffRow[];
};

export type RunCheck = {
  label: string;
  value: string;
};

export type MessageOperation = {
  id?: string;
  status?: LiveRunStepStatus;
  exitCode?: number;
  error?: { message: string; code?: string };
  truncated?: boolean;
  type: string;
  summary: string;
  details?: string;
  detailAvailable?: boolean;
};

export type ProviderUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens?: number;
  totalTokens?: number;
};

export type ProviderDiagnosticMetadata = {
  provider: string;
  kind: "unsupported_response" | "unsupported_event" | (string & {});
  summary: string;
  source?: string;
  responseType?: string;
  eventType?: string;
  payload?: unknown;
};

export type ProviderLogicalPrompt = {
  systemText: string;
  inputText: string;
  composedText: string;
};

export type LiveRunStepStatus = "in_progress" | "completed" | "failed" | "canceled" | "pending" | (string & {});

export type LiveRunStep = MessageOperation & {
  id: string;
  status: LiveRunStepStatus;
};

export type LiveBackgroundTaskKind = "agent" | "shell";

export type LiveBackgroundTaskStatus = "running" | "completed" | "failed";

export type LiveBackgroundTask = {
  id: string;
  kind: LiveBackgroundTaskKind;
  status: LiveBackgroundTaskStatus;
  title: string;
  details?: string;
  updatedAt: string;
};

export type LiveApprovalDecision = "approve" | "deny";

export type LiveApprovalDecisionMode = "direct-decision" | "retry-with-policy-change";

export type LiveApprovalRequest = {
  requestId: string;
  textPosition?: number;
  provider: string;
  kind: string;
  title: string;
  summary: string;
  details?: string;
  warning?: string;
  decisionMode: LiveApprovalDecisionMode;
};

export type LiveElicitationAction = "accept" | "decline" | "cancel";

export type LiveElicitationValue = string | number | boolean | string[];

export type LiveElicitationResponse = {
  action: LiveElicitationAction;
  content?: Record<string, LiveElicitationValue>;
};

export type LiveElicitationChoiceOption = {
  value: string;
  label: string;
};

type LiveElicitationFieldBase = {
  name: string;
  title: string;
  description?: string;
  required: boolean;
};

export type LiveElicitationSelectField = LiveElicitationFieldBase & {
  type: "select";
  options: LiveElicitationChoiceOption[];
  defaultValue?: string;
  allowFreeText?: boolean;
};

export type LiveElicitationMultiSelectField = LiveElicitationFieldBase & {
  type: "multi-select";
  options: LiveElicitationChoiceOption[];
  defaultValue?: string[];
  minItems?: number;
  maxItems?: number;
  allowFreeText?: boolean;
};

export type LiveElicitationBooleanField = LiveElicitationFieldBase & {
  type: "boolean";
  defaultValue?: boolean;
};

export type LiveElicitationTextField = LiveElicitationFieldBase & {
  type: "text";
  secret?: boolean;
  defaultValue?: string;
  minLength?: number;
  maxLength?: number;
  format?: "email" | "uri" | "date" | "date-time";
};

export type LiveElicitationNumberField = LiveElicitationFieldBase & {
  type: "number";
  numberKind: "number" | "integer";
  defaultValue?: number;
  minimum?: number;
  maximum?: number;
};

export type LiveElicitationField =
  | LiveElicitationSelectField
  | LiveElicitationMultiSelectField
  | LiveElicitationBooleanField
  | LiveElicitationTextField
  | LiveElicitationNumberField;

export type LiveElicitationRequest = {
  requestId: string;
  sourceItemId?: string;
  textPosition?: number;
  provider: string;
  kind?: "question";
  delivery?: "user-message";
  turnId?: string;
  mode: "form" | "url";
  message: string;
  source?: string;
  fields: LiveElicitationField[];
  blocking?: boolean;
  url?: string;
};

export type ElicitationRecord = {
  requestId: string;
  kind?: "question";
  sourceItemId?: string;
  textRange?: { start: number; end: number };
  message: string;
  fields: Array<{ title: string; description?: string; options?: string[] }>;
  status: "pending" | "answered" | "declined" | "canceled" | "expired";
};

export type LiveSessionRunState = {
  sessionId: string;
  threadId: string;
  runState?: string;
  turnId?: string;
  inputAvailable?: boolean;
  cancellationState?: "requested" | "terminating";
  assistantText: string;
  assistantQuestionRanges?: AssistantQuestionRange[];
  reasoningText?: string;
  steps: LiveRunStep[];
  backgroundTasks: LiveBackgroundTask[];
  usage: ProviderUsage | null;
  errorMessage: string;
  approvalRequest: LiveApprovalRequest | null;
  elicitationRequest: LiveElicitationRequest | null;
  elicitationRequests?: LiveElicitationRequest[];
  elicitationRecords?: ElicitationRecord[];
};

export type AssistantQuestionRange = { itemId: string; start: number; end: number };

export type ProviderQuotaSnapshot = {
  quotaKey: string;
  entitlementRequests: number;
  usedRequests: number;
  remainingPercentage: number;
  overage: number;
  overageAllowedWithExhaustedQuota: boolean;
  resetDate?: string;
};

export type ProviderQuotaTelemetry = {
  provider: string;
  /** Time of the last successful observation; null until one succeeds. */
  updatedAt: string | null;
  snapshots: ProviderQuotaSnapshot[];
  rateLimits?: ProviderRateLimitWindow[];
  /** Omitted by request-count providers when the snapshot is ready. */
  status?: "loading" | "ready" | "error" | "unsupported";
};

export type ProviderRateLimitWindow = {
  quotaKey: string;
  label?: string;
  usedPercentage: number;
  windowDurationMinutes?: number;
  resetDate?: string;
};

export type SessionContextTelemetry = {
  provider: string;
  sessionId: string;
  updatedAt: string;
  tokenLimit: number;
  currentTokens: number;
  messagesLength: number;
  systemTokens?: number;
  conversationTokens?: number;
  toolDefinitionsTokens?: number;
};

export type DiscoveredSkillSource = "workspace" | "provider";

export type DiscoveredSkill = {
  id: string;
  name: string;
  description: string;
  source: DiscoveredSkillSource;
  sourcePath: string;
  sourceLabel: string;
};

export type DiscoveredCustomAgentSource = "workspace" | "global";

export type DiscoveredCustomAgent = {
  id: string;
  name: string;
  displayName: string;
  description: string;
  source: DiscoveredCustomAgentSource;
  sourcePath: string;
  sourceLabel: string;
};

export type ComposerAttachmentKind = "file" | "folder" | "image";

export type ComposerAttachmentSource = "text" | "markdown-image";

export type ComposerAttachmentInput = {
  path: string;
  source: ComposerAttachmentSource;
  kind?: ComposerAttachmentKind;
};

export type ComposerAttachment = {
  id: string;
  kind: ComposerAttachmentKind;
  source: ComposerAttachmentSource;
  absolutePath: string;
  displayPath: string;
  workspaceRelativePath: string | null;
  isOutsideWorkspace: boolean;
};

export type ComposerPreview = {
  attachments: ComposerAttachment[];
  errors: string[];
};

export type RunSessionTurnRequest = {
  userMessage: string;
  executionOptions: SessionExecutionOptions;
  clientRequestId?: string;
  submitSource?: "composer" | "retry";
  auxiliaryDraftIncarnation?: string;
  auxiliaryDraftDurableRevision?: number;
  displayAnchorParentMessageCount?: number;
};

export type SteerSessionTurnRequest = {
  expectedTurnId: string;
  userMessage: string;
  clientRequestId?: string;
  auxiliaryDraftIncarnation?: string;
  auxiliaryDraftDurableRevision?: number;
};

export type SteerSessionTurnResult = { turnId: string };

const SESSION_TURN_CLIENT_REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function normalizeSessionTurnClientRequestId(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return SESSION_TURN_CLIENT_REQUEST_ID_PATTERN.test(normalized) ? normalized : null;
}

export function normalizeSessionTurnSubmitSource(value: unknown): RunSessionTurnRequest["submitSource"] | null {
  return value === "composer" || value === "retry" ? value : null;
}

export function normalizeSessionTurnCorrelation(
  request: Partial<Pick<RunSessionTurnRequest, "userMessage" | "clientRequestId" | "submitSource">> | null | undefined,
): { clientRequestId: string | null; submitSource: RunSessionTurnRequest["submitSource"] | null } {
  const normalizedClientRequestId = normalizeSessionTurnClientRequestId(request?.clientRequestId);
  const userMessage = typeof request?.userMessage === "string" ? request.userMessage.trim().toLocaleLowerCase() : "";
  return {
    clientRequestId: normalizedClientRequestId && !userMessage.includes(normalizedClientRequestId.toLocaleLowerCase())
      ? normalizedClientRequestId
      : null,
    submitSource: normalizeSessionTurnSubmitSource(request?.submitSource),
  };
}

export function makeDiffRows(
  rows: Array<[DiffRow["kind"], number | undefined, string | undefined, number | undefined, string | undefined]>,
): DiffRow[] {
  return rows.map(([kind, leftNumber, leftText, rightNumber, rightText]) => ({
    kind,
    leftNumber,
    leftText,
    rightNumber,
    rightText,
  }));
}
