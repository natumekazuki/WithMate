import { type ApprovalMode } from "./approval-mode.js";
import { type CodexSandboxMode } from "./codex-sandbox-mode.js";
import { type ModelReasoningEffort } from "./model-catalog.js";

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

export type AuditLogPhase =
  | "running"
  | "completed"
  | "failed"
  | "canceled"
  | "started"
  | "background-running"
  | "background-completed"
  | "background-failed"
  | "background-canceled";

export type AuditLogOperation = {
  type: string;
  summary: string;
  details?: string;
};

export type AuditLogUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
};

export type AuditLogicalPrompt = {
  systemText: string;
  inputText: string;
  composedText: string;
};

export type AuditTransportField = {
  label: string;
  value: string;
};

export type AuditTransportPayload = {
  summary: string;
  fields: AuditTransportField[];
};

export type AuditLogEntry = {
  id: number;
  sessionId: string;
  createdAt: string;
  phase: AuditLogPhase;
  provider: string;
  model: string;
  reasoningEffort: ModelReasoningEffort;
  approvalMode: ApprovalMode;
  threadId: string;
  logicalPrompt: AuditLogicalPrompt;
  transportPayload: AuditTransportPayload | null;
  assistantText: string;
  operations: AuditLogOperation[];
  rawItemsJson: string;
  usage: AuditLogUsage | null;
  errorMessage: string;
};

export type AuditLogSummary = Omit<
  AuditLogEntry,
  "logicalPrompt" | "transportPayload" | "assistantText" | "rawItemsJson"
> & {
  assistantTextPreview: string;
  detailAvailable: boolean;
};

export type AuditLogSummaryPageRequest = {
  cursor?: number | null;
  limit?: number | null;
};

export type AuditLogSummaryPageResult = {
  entries: AuditLogSummary[];
  nextCursor: number | null;
  hasMore: boolean;
  total: number;
};

export type AuditLogDetail = Pick<
  AuditLogEntry,
  "id" | "sessionId" | "logicalPrompt" | "transportPayload" | "assistantText" | "operations" | "rawItemsJson" | "usage" | "errorMessage"
>;

export type LiveRunStepStatus = "in_progress" | "completed" | "failed" | "canceled" | "pending" | (string & {});

export type LiveRunStep = {
  id: string;
  type: string;
  summary: string;
  details?: string;
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
};

export type LiveElicitationMultiSelectField = LiveElicitationFieldBase & {
  type: "multi-select";
  options: LiveElicitationChoiceOption[];
  defaultValue?: string[];
  minItems?: number;
  maxItems?: number;
};

export type LiveElicitationBooleanField = LiveElicitationFieldBase & {
  type: "boolean";
  defaultValue?: boolean;
};

export type LiveElicitationTextField = LiveElicitationFieldBase & {
  type: "text";
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
  provider: string;
  mode: "form" | "url";
  message: string;
  source?: string;
  fields: LiveElicitationField[];
  url?: string;
};

export type LiveSessionRunState = {
  sessionId: string;
  threadId: string;
  assistantText: string;
  steps: LiveRunStep[];
  backgroundTasks: LiveBackgroundTask[];
  usage: AuditLogUsage | null;
  errorMessage: string;
  approvalRequest: LiveApprovalRequest | null;
  elicitationRequest: LiveElicitationRequest | null;
};

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
  updatedAt: string;
  snapshots: ProviderQuotaSnapshot[];
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

export type ComposerAttachmentSource = "text";

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
  model?: string;
  reasoningEffort?: ModelReasoningEffort;
  approvalMode?: ApprovalMode;
  codexSandboxMode?: CodexSandboxMode;
};

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
