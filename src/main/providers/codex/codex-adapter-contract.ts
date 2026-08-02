import type { TextContentBlock } from "../../../shared/message-content.js";
import { APPLICATION_RUN_PAYLOAD_LIMITS } from "../../../shared/application-run-payload-limits.js";
import { APPLICATION_RUN_INTERACTION_TRANSPORT_LIMITS } from "../../../shared/application-run-interaction-limits.js";
import type {
  CodexConnectionFailureCode,
  CodexRequestNotSentCode,
  CodexResponseUnknownCode,
} from "./transport-error.js";
import type { CodexServerRequestIdentity, CodexServerRequestResolution } from "./protocol-session.js";
import type { CODEX_PROVIDER_DEFINITION_VERSION, CODEX_PROVIDER_ID } from "./codex-provider-contract.js";

// Generated schema is version-specific evidence; runtime compatibility is decided by decoding actual stable-protocol payloads.
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
  maxPendingInteractions: 32,
  maxInteractionProjectionBytes: APPLICATION_RUN_INTERACTION_TRANSPORT_LIMITS.maxCollectionWireBytes,
  maxInteractionTombstones: 128,
  maxInteractionIdCharacters: 128,
  maxInteractionSummaryCodePoints: 512,
  maxInteractionBodyCodePoints: 2_048,
  maxInteractionFileChanges: 256,
  maxInteractionFileObservations: 128,
  maxInteractionObservedFileChanges: 4_096,
  maxInteractionObservedFileChangeBytes: 1 * 1_024 * 1_024,
  maxInteractionQuestions: 32,
  maxInteractionOptionsPerQuestion: 16,
  maxInteractionFormFields: 32,
  maxInteractionFormValueCodePoints: 4_096,
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
  readonly identity: CodexServerRequestIdentity;
  readonly method: string;
  readonly params: unknown;
  respond(result: unknown): Promise<void>;
  releasePayload?(): void;
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
  observeServerRequestResolution(requestId: unknown): CodexServerRequestResolution;
  nextEvent(): Promise<CodexAdapterTransportEvent>;
  close(): Promise<void>;
}

export type CodexAdapterApprovalPolicy = "never" | "untrusted" | "on-request";
export type CodexAdapterSandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type CodexAdapterModelSelection = "explicit" | "inherited";

export type CodexAdapterCapabilityPreflightInput = Readonly<{
  model: string;
  modelSelection: CodexAdapterModelSelection;
  reasoningEffort: string;
  requiredModality: "text" | "image" | "audio";
}>;

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
  modelSelection: CodexAdapterModelSelection;
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

export type CodexAdapterInteractionKind =
  | "codex.command_approval"
  | "codex.file_change_approval"
  | "codex.permission_approval"
  | "codex.user_input"
  | "codex.mcp_tool_approval"
  | "codex.mcp_server_form";

export const CODEX_ADAPTER_COMMAND_DECISIONS = Object.freeze(["accept", "decline", "cancel"] as const);
export type CodexAdapterCommandDecision = (typeof CODEX_ADAPTER_COMMAND_DECISIONS)[number];

export const CODEX_ADAPTER_PERMISSION_CATEGORIES = Object.freeze(["workspace_write", "network"] as const);
export type CodexAdapterPermissionCategory = (typeof CODEX_ADAPTER_PERMISSION_CATEGORIES)[number];

export function isCodexAdapterCommandDecision(value: unknown): value is CodexAdapterCommandDecision {
  return (CODEX_ADAPTER_COMMAND_DECISIONS as readonly unknown[]).includes(value);
}

export type CodexAdapterInteractionUnavailableDisplay = Readonly<{
  summary: string;
  unavailableReason:
    | "unsafe_projection"
    | "unsupported_shape"
    | "secret_input"
    | "resource_limit"
    | "owner_unresolved"
    | "response_admitted";
}>;

type CodexAdapterInteractionSnapshotCommon<TKind extends CodexAdapterInteractionKind, TDisplay> = Readonly<{
  interactionId: string;
  providerId: typeof CODEX_PROVIDER_ID;
  definitionVersion: typeof CODEX_PROVIDER_DEFINITION_VERSION;
  kind: TKind;
  answerable: true;
  display: TDisplay;
}>;

export type CodexAdapterInteractionSnapshot =
  | CodexAdapterInteractionSnapshotCommon<
      "codex.command_approval",
      Readonly<{
        summary: string;
        command: string;
        availableDecisions: readonly CodexAdapterCommandDecision[];
      }>
    >
  | CodexAdapterInteractionSnapshotCommon<
      "codex.file_change_approval",
      Readonly<{
        summary: string;
        changes: readonly Readonly<{
          displayPath: string;
          changeKind: "add" | "update" | "delete" | "move";
        }>[];
      }>
    >
  | CodexAdapterInteractionSnapshotCommon<
      "codex.permission_approval",
      Readonly<{ summary: string; permissions: readonly CodexAdapterPermissionCategory[] }>
    >
  | CodexAdapterInteractionSnapshotCommon<
      "codex.user_input",
      Readonly<{
        questions: readonly Readonly<{
          questionId: string;
          header: string;
          prompt: string;
          allowOther: boolean;
          options: readonly Readonly<{ label: string; description?: string }>[];
        }>[];
      }>
    >
  | CodexAdapterInteractionSnapshotCommon<
      "codex.mcp_tool_approval",
      Readonly<{ server: string; tool: string; summary: string }>
    >
  | CodexAdapterInteractionSnapshotCommon<
      "codex.mcp_server_form",
      Readonly<{
        server: string;
        message: string;
        fields: readonly Readonly<{
          fieldId: string;
          label: string;
          inputType: "string";
          required: boolean;
          maxLength: number;
        }>[];
      }>
    >
  | Readonly<{
      interactionId: string;
      providerId: typeof CODEX_PROVIDER_ID;
      definitionVersion: typeof CODEX_PROVIDER_DEFINITION_VERSION;
      kind: CodexAdapterInteractionKind;
      answerable: false;
      display: CodexAdapterInteractionUnavailableDisplay;
    }>;

type CodexAdapterDecisionResponse<TKind extends CodexAdapterInteractionKind> = Readonly<{
  interactionId: string;
  kind: TKind;
  payload: Readonly<{ decision: CodexAdapterCommandDecision }>;
}>;

export type CodexAdapterInteractionResponse =
  | CodexAdapterDecisionResponse<"codex.command_approval">
  | CodexAdapterDecisionResponse<"codex.file_change_approval">
  | CodexAdapterDecisionResponse<"codex.mcp_tool_approval">
  | Readonly<{
      interactionId: string;
      kind: "codex.permission_approval";
      payload: Readonly<{
        permissions: readonly CodexAdapterPermissionCategory[];
        scope: "turn";
      }>;
    }>
  | Readonly<{
      interactionId: string;
      kind: "codex.user_input";
      payload: Readonly<{ answers: Readonly<Record<string, readonly [string]>> }>;
    }>
  | Readonly<{
      interactionId: string;
      kind: "codex.mcp_server_form";
      payload:
        | Readonly<{ action: "accept"; values: Readonly<Record<string, string>> }>
        | Readonly<{ action: "decline" | "cancel" }>;
    }>;

declare const CODEX_ADAPTER_INTERACTION_HANDLE: unique symbol;
export type CodexAdapterInteractionHandle = Readonly<{
  readonly [CODEX_ADAPTER_INTERACTION_HANDLE]: true;
}>;

export type CodexAdapterInteractionOwner = Readonly<{
  connectionGeneration: string;
  threadId: string;
  turnId: string;
  itemId?: string;
}>;

export type CodexAdapterInteractionResponseResult =
  | Readonly<{
      kind: "write_attempted";
      effect: "unknown";
      providerResolution: "pending" | "resolved";
    }>
  | Readonly<{
      kind: "not_sent";
      effect: "none";
      code: "invalid_input" | "unknown_handle" | "already_used" | "resolved" | "closed" | "write_rejected";
    }>
  | Readonly<{
      kind: "ambiguous";
      effect: "unknown";
      code: CodexResponseUnknownCode | "write_failed";
      providerResolution: "pending" | "resolved";
    }>;

export type CodexAdapterInteractionResponseReservation = Readonly<{
  token: object;
}>;

export type CodexAdapterInteractionResponseReserveResult =
  | Readonly<{
      kind: "reserved";
      reservation: CodexAdapterInteractionResponseReservation;
    }>
  | Readonly<{
      kind: "not_reserved";
      code: "capability_unavailable" | "write_rejected";
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

export type CodexAdapterCapabilityPreflightResult =
  | Readonly<{ kind: "supported"; effect: "none" }>
  | Readonly<{ kind: "unsupported"; effect: "none" }>
  | Readonly<{
      kind: "unavailable";
      effect: "none";
      failure: Exclude<CodexAdapterReadResult<CodexAdapterModelCatalog>, Readonly<{ kind: "accepted" }>>;
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
      kind: "interaction_pending";
      handle: CodexAdapterInteractionHandle;
      owner: CodexAdapterInteractionOwner;
      snapshot: CodexAdapterInteractionSnapshot;
    }>
  | Readonly<{
      kind: "interaction_resolved";
      handle: CodexAdapterInteractionHandle;
      owner: CodexAdapterInteractionOwner;
    }>
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
