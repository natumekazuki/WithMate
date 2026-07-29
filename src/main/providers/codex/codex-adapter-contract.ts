import type { TextContentBlock } from "../../../shared/message-content.js";
import { APPLICATION_RUN_PAYLOAD_LIMITS } from "../../../shared/application-run-payload-limits.js";
import type {
  CodexConnectionFailureCode,
  CodexRequestNotSentCode,
  CodexResponseUnknownCode,
} from "./transport-error.js";

export const CODEX_ADAPTER_SCHEMA_BASELINE = Object.freeze({
  cliVersion: "0.145.0",
  protocol: "stable",
} as const);

export const CODEX_ADAPTER_LIMITS = Object.freeze({
  maxIdentifierCharacters: 1_024,
  maxIdentifierBytes: 4 * 1_024,
  maxMethodCharacters: 256,
  maxShortStringBytes: 64 * 1_024,
  maxItemTextBytes: 1 * 1_024 * 1_024,
  maxTurnTextBytes: 4 * 1_024 * 1_024,
  maxConnectionTextBytes: 32 * 1_024 * 1_024,
  maxValidationAggregateBytes: APPLICATION_RUN_PAYLOAD_LIMITS.providerRequestMaxJsonBytes,
  maxArrayItems: 4_096,
  maxObjectDepth: 32,
  maxObjectProperties: 256,
  maxThreadTurns: 512,
  maxTurnItems: 2_048,
  maxModelPageItems: 256,
  maxModelPages: 64,
  maxModels: 4_096,
  maxModelCatalogBytes: 2 * 1_024 * 1_024,
  maxTrackedThreads: 128,
  maxTrackedTurns: 512,
  maxTrackedItems: 2_048,
  maxTerminalTurnTombstones: 2_048,
  maxQueuedEvents: 1_024,
  maxDiagnostics: 256,
  maxDiagnosticBytes: 256 * 1_024,
} as const);

export type CodexAdapterLimits = Readonly<typeof CODEX_ADAPTER_LIMITS>;

export type CodexAdapterRequestOptions = Readonly<{
  timeoutMs?: number;
  signal?: AbortSignal;
}>;

export type CodexAdapterOptions = Readonly<{
  cliVersion: string;
}>;

export interface CodexAdapterServerRequestPort {
  readonly method: string;
  readonly params: unknown;
}

export type CodexAdapterTransportEvent =
  | Readonly<{ kind: "notification"; method: string; params?: unknown }>
  | Readonly<{ kind: "serverRequest"; request: CodexAdapterServerRequestPort }>
  | Readonly<{
      kind: "protocolAnomaly";
      code: "duplicate_or_late_response_id" | "unknown_response_id";
      responseIdType: "number" | "string";
    }>;

export interface CodexAdapterTransportPort {
  request<TResult>(method: string, params?: unknown, options?: CodexAdapterRequestOptions): Promise<TResult>;
  nextEvent(): Promise<CodexAdapterTransportEvent>;
  close(): Promise<void>;
}

export type CodexAdapterApprovalPolicy = "never" | "untrusted" | "on-request";
export type CodexAdapterSandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type CodexAdapterModelSelection = "explicit" | "inherited";

export type CodexAdapterSandboxPolicy =
  | Readonly<{ mode: "read-only"; networkAccess: boolean }>
  | Readonly<{
      mode: "workspace-write";
      writableRoots: readonly string[];
      networkAccess: boolean;
    }>
  | Readonly<{ mode: "danger-full-access" }>;

export type CodexListModelsInput = Readonly<{
  pageSize?: number;
}>;

export type CodexStartThreadInput = Readonly<{
  model: string;
  reasoningEffort?: string;
  workspacePath: string;
  approvalPolicy: CodexAdapterApprovalPolicy;
  sandboxMode: CodexAdapterSandboxMode;
  persistence: "persistent" | "ephemeral";
}>;

export type CodexResumeThreadInput = Readonly<{
  threadId: string;
  model?: string;
  modelSelection?: CodexAdapterModelSelection;
  reasoningEffort?: string;
  workspacePath?: string;
  approvalPolicy?: CodexAdapterApprovalPolicy;
  sandboxMode?: CodexAdapterSandboxMode;
}>;

export type CodexReadThreadInput = Readonly<{
  threadId: string;
  includeTurns: boolean;
}>;

export type CodexStartTurnInput = Readonly<{
  threadId: string;
  contentBlocks: readonly TextContentBlock[];
  workspacePath?: string;
  approvalPolicy?: CodexAdapterApprovalPolicy;
  sandboxPolicy?: CodexAdapterSandboxPolicy;
  model?: string;
  modelSelection?: CodexAdapterModelSelection;
  reasoningEffort?: string;
  reasoningSummary?: "auto" | "concise" | "detailed" | "none";
}>;

export type CodexSteerTurnInput = Readonly<{
  threadId: string;
  expectedTurnId: string;
  contentBlocks: readonly TextContentBlock[];
}>;

export type CodexInterruptTurnInput = Readonly<{
  threadId: string;
  turnId: string;
}>;

export type CodexAdapterModel = Readonly<{
  id: string;
  requestModel: string;
  displayName: string;
  hidden: boolean;
  selectable: boolean;
  supportedReasoningEfforts: readonly string[];
  defaultReasoningEffort: string;
  inputModalities: readonly ("text" | "image" | "audio")[];
  supportsPersonality: boolean;
  isDefault: boolean;
}>;

export type CodexAdapterModelCatalog = Readonly<{
  cliVersion: string;
  schemaBaseline: typeof CODEX_ADAPTER_SCHEMA_BASELINE.cliVersion;
  models: readonly CodexAdapterModel[];
}>;

export type CodexAdapterThreadStatus = "not_loaded" | "idle" | "active" | "system_error";
export type CodexAdapterTurnStatus = "in_progress" | "completed" | "failed" | "interrupted";

export type CodexAdapterThreadSnapshot = Readonly<{
  threadId: string;
  status: CodexAdapterThreadStatus;
  model: string;
  modelProvider: string;
  cliVersion: string;
  reasoningEffort: string | null;
}>;

export type CodexAdapterTurnSnapshot = Readonly<{
  threadId: string;
  turnId: string;
  status: CodexAdapterTurnStatus;
}>;

export type CodexAdapterSteerAcknowledgement = Readonly<{
  threadId: string;
  turnId: string;
}>;

export type CodexAdapterInterruptAcknowledgement = Readonly<{
  threadId: string;
  turnId: string;
  terminal: false;
}>;

export type CodexAdapterReadThreadSnapshot = Readonly<{
  threadId: string;
  status: CodexAdapterThreadStatus;
  cliVersion: string;
  turns: readonly Readonly<{
    turnId: string;
    status: CodexAdapterTurnStatus;
    itemCount: number;
  }>[];
}>;

export type CodexAdapterNotSentCode = CodexRequestNotSentCode | "invalid_input" | "capability_unavailable";

export type CodexAdapterConnectionFailureCode =
  CodexConnectionFailureCode | "unsupported_server_request" | "adapter_resource_limit";

export type CodexAdapterMutationNotSentCode =
  CodexAdapterNotSentCode | CodexResponseUnknownCode | CodexAdapterConnectionFailureCode | "invalid_response";

export type CodexAdapterAmbiguousCode = CodexResponseUnknownCode | "invalid_response";

export type CodexAdapterMutationResult<T> =
  | Readonly<{ kind: "accepted"; effect: "present"; value: T }>
  | Readonly<{ kind: "not_sent"; effect: "none"; code: CodexAdapterMutationNotSentCode }>
  | Readonly<{ kind: "rejected"; effect: "none"; code: number }>
  | Readonly<{ kind: "ambiguous"; effect: "unknown"; code: CodexAdapterAmbiguousCode }>
  | Readonly<{
      kind: "connection_failure";
      effect: "unknown";
      code: CodexConnectionFailureCode;
    }>;

export type CodexAdapterReadResult<T> =
  | Readonly<{ kind: "accepted"; effect: "none"; value: T }>
  | Readonly<{ kind: "not_sent"; effect: "none"; code: CodexAdapterNotSentCode }>
  | Readonly<{ kind: "rejected"; effect: "none"; code: number }>
  | Readonly<{ kind: "ambiguous"; effect: "none"; code: CodexResponseUnknownCode }>
  | Readonly<{ kind: "invalid_response"; effect: "none"; code: "invalid_response" }>
  | Readonly<{
      kind: "connection_failure";
      effect: "none";
      code: CodexAdapterConnectionFailureCode;
    }>;

export type CodexAdapterDiagnosticCode =
  | "known_invalid_payload"
  | "unknown_notification"
  | "unknown_item"
  | "duplicate_event"
  | "out_of_order_event"
  | "identity_mismatch"
  | "draft_mismatch"
  | "phase_fallback"
  | "resource_limit"
  | "provider_warning"
  | "provider_error"
  | "unsupported_server_request"
  | "protocol_anomaly";

export type CodexAdapterDiagnostic = Readonly<{
  code: CodexAdapterDiagnosticCode;
  summary: string;
  method?: string;
  itemType?: string;
  cliVersion?: string;
  model?: string;
  correlation?: Readonly<{ threadId?: string; turnId?: string; itemId?: string }>;
  willRetry?: boolean;
  redaction: "not_required" | "applied";
}>;

export type CodexAdapterTokenUsageBreakdown = Readonly<{
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}>;

export type CodexAdapterOutputPayload =
  | Readonly<{ kind: "none"; redaction: "not_required" }>
  | Readonly<{
      kind: "text";
      text: string;
      originalByteLength: number;
      redaction: "undetermined";
    }>
  | Readonly<{
      kind: "omitted";
      reason: "size_limit" | "redaction";
      originalByteLength: number;
      redaction: "undetermined";
    }>
  | Readonly<{
      kind: "token_usage";
      last: CodexAdapterTokenUsageBreakdown;
      total: CodexAdapterTokenUsageBreakdown;
      modelContextWindow: number | null;
      redaction: "not_required";
    }>;

export type CodexAdapterOutput = Readonly<{
  category: "assistant_detail" | "operation" | "telemetry" | "diagnostic" | "provider_metadata";
  kind: string;
  summary: string;
  completionState: "complete" | "partial";
  payload: CodexAdapterOutputPayload;
}>;

export type CodexAdapterEvent =
  | Readonly<{ kind: "thread_started"; thread: CodexAdapterThreadSnapshot }>
  | Readonly<{
      kind: "thread_status_observed";
      threadId: string;
      status: CodexAdapterThreadStatus;
    }>
  | Readonly<{ kind: "turn_started"; turn: CodexAdapterTurnSnapshot }>
  | Readonly<{
      kind: "item_output";
      threadId: string;
      turnId: string;
      itemId: string;
      output: CodexAdapterOutput;
    }>
  | Readonly<{
      kind: "turn_output";
      threadId: string;
      turnId: string;
      output: CodexAdapterOutput;
    }>
  | Readonly<{
      kind: "provider_metadata";
      correlation: Readonly<{ threadId?: string; turnId?: string; itemId?: string }>;
      output: CodexAdapterOutput;
    }>
  | Readonly<{
      kind: "turn_terminal";
      threadId: string;
      turnId: string;
      status: "completed" | "failed" | "interrupted";
      finalAssistantMessage: Readonly<{ contentBlocks: readonly TextContentBlock[] }> | null;
      contentFailure: Readonly<{ code: "size_limit" | "invalid_content" }> | null;
      resourceLimitExceeded?: true;
    }>
  | Readonly<{ kind: "diagnostic"; diagnostic: CodexAdapterDiagnostic }>
  | Readonly<{
      kind: "connection_failure";
      code: CodexAdapterConnectionFailureCode;
    }>;
