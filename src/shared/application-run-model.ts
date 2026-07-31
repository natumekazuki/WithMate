import type {
  ApplicationAccessDecision,
  ApplicationDomainErrorCode,
  ApplicationOperationOptions,
  ApplicationOperationResponse,
  ApplicationSessionOperationContext,
} from "./application-service-model.js";
import type { TextContentBlock } from "./message-content.js";
import { REPOSITORY_READ_LIMITS } from "./repository-read-model.js";

export const APPLICATION_RUN_LIMITS = {
  maxIdentifierLength: 1_024,
  maxExecutionSettingLength: 1_024,
  maxCursorLength: 2_048,
  maxSummaryLength: 4_096,
  maxPendingInputsPerAttempt: 64,
  maxTrackedInputs: 128,
  eventsDefaultItems: REPOSITORY_READ_LIMITS.events.default,
  eventsMaxItems: REPOSITORY_READ_LIMITS.events.max,
  followDefaultWaitMs: 10_000,
  followMaxWaitMs: 30_000,
  followDefaultPollMs: 250,
  followMinPollMs: 25,
  followMaxPollMs: 5_000,
} as const;

export const APPLICATION_RUN_SEND_INPUT_DOMAIN_ERROR_CODES = [
  "request_invalid",
  "not_found",
  "reference_invalid",
  "lifecycle_conflict",
  "session_busy",
  "capacity_exceeded",
  "insufficient_disk_space",
  "idempotency_conflict",
  "idempotency_in_progress",
  "idempotency_expired",
  "identity_exhausted",
] as const satisfies readonly ApplicationDomainErrorCode[];

export type ApplicationRunSendInputDomainErrorCode = (typeof APPLICATION_RUN_SEND_INPUT_DOMAIN_ERROR_CODES)[number];

export function isApplicationRunSendInputDomainErrorCode(
  value: unknown,
): value is ApplicationRunSendInputDomainErrorCode {
  return (
    typeof value === "string" && (APPLICATION_RUN_SEND_INPUT_DOMAIN_ERROR_CODES as readonly string[]).includes(value)
  );
}

export const APPLICATION_RUN_CANCEL_DOMAIN_ERROR_CODES = [
  "request_invalid",
  "not_found",
  "reference_invalid",
  "lifecycle_conflict",
  "idempotency_conflict",
  "idempotency_in_progress",
  "idempotency_expired",
] as const satisfies readonly ApplicationDomainErrorCode[];

export type ApplicationRunCancelDomainErrorCode = (typeof APPLICATION_RUN_CANCEL_DOMAIN_ERROR_CODES)[number];

export function isApplicationRunCancelDomainErrorCode(value: unknown): value is ApplicationRunCancelDomainErrorCode {
  return typeof value === "string" && (APPLICATION_RUN_CANCEL_DOMAIN_ERROR_CODES as readonly string[]).includes(value);
}

export type ApplicationRunOperation = "start" | "retry" | "send-input" | "cancel" | "status" | "events" | "follow";

export type ApplicationRunSandboxSetting =
  | Readonly<{ mode: "read-only"; networkAccess: boolean }>
  | Readonly<{ mode: "workspace-write"; networkAccess: boolean }>
  | Readonly<{ mode: "danger-full-access" }>;

export type ApplicationRunExecutionSettings = Readonly<{
  model: string;
  reasoningEffort: string;
  sandbox: ApplicationRunSandboxSetting;
}>;

export type ApplicationRunExecutionOverrides = Readonly<{
  model?: string;
  reasoningEffort?: string;
  sandbox?: ApplicationRunSandboxSetting;
}>;

export type ApplicationRunPhase =
  "queued" | "starting" | "active" | "canceling" | "finalizing" | "completed" | "failed" | "canceled" | "interrupted";

export type ApplicationRunLiveActivity = "running" | "waiting_approval" | "waiting_input" | "waiting_child";

export type ApplicationRunFailureSummary = Readonly<{
  origin: "provider" | "transport" | "process" | "application" | "persistence" | "unknown";
  summary?: string;
}>;

export type ApplicationRunCancellationRequestSummary = Readonly<{
  requestedAt: number;
  acknowledgedAt?: never;
}>;

export type ApplicationRunCancellationAcknowledgementSummary = Readonly<{
  requestedAt: number;
  acknowledgedAt: number;
}>;

export type ApplicationRunCancellationSummary =
  ApplicationRunCancellationRequestSummary | ApplicationRunCancellationAcknowledgementSummary;

type ApplicationRunStatusBase = Readonly<{
  sessionId: string;
  runId: string;
  retryOfRunId?: string;
  createdAt: number;
  startedAt?: number;
  updatedAt: number;
}>;

type ApplicationRunInactiveStatus = ApplicationRunStatusBase &
  Readonly<{
    phase: "queued" | "starting" | "finalizing";
    liveActivity: null;
    failure?: never;
    cancellation?: never;
    terminalAt?: never;
  }>;

type ApplicationRunActiveStatus = ApplicationRunStatusBase &
  Readonly<{
    phase: "active";
    liveActivity: ApplicationRunLiveActivity | null;
    failure?: never;
    cancellation?: never;
    terminalAt?: never;
  }>;

type ApplicationRunCancelingStatus = ApplicationRunStatusBase &
  Readonly<{
    phase: "canceling";
    liveActivity: null;
    cancellation: ApplicationRunCancellationRequestSummary;
    failure?: never;
    terminalAt?: never;
  }>;

type ApplicationRunCompletedStatus = ApplicationRunStatusBase &
  Readonly<{
    phase: "completed";
    liveActivity: null;
    terminalAt: number;
    failure?: never;
    cancellation?: ApplicationRunCancellationRequestSummary;
  }>;

type ApplicationRunFailedStatus = ApplicationRunStatusBase &
  Readonly<{
    phase: "failed" | "interrupted";
    liveActivity: null;
    terminalAt: number;
    failure: ApplicationRunFailureSummary;
    cancellation?: ApplicationRunCancellationRequestSummary;
  }>;

type ApplicationRunCanceledStatus = ApplicationRunStatusBase &
  Readonly<{
    phase: "canceled";
    liveActivity: null;
    terminalAt: number;
    cancellation?: ApplicationRunCancellationAcknowledgementSummary;
    failure?: never;
  }>;

export type ApplicationRunStatus =
  | ApplicationRunInactiveStatus
  | ApplicationRunActiveStatus
  | ApplicationRunCancelingStatus
  | ApplicationRunCompletedStatus
  | ApplicationRunFailedStatus
  | ApplicationRunCanceledStatus;

export type ApplicationRunCancelResult = Extract<
  ApplicationRunStatus,
  Readonly<{ phase: "canceling" | "completed" | "failed" | "canceled" | "interrupted" }>
>;

export type ApplicationRunEventKind = "run_terminal" | "child_result_collected" | "unknown";

export type ApplicationRunEvent = Readonly<{
  ordinal: number;
  kind: ApplicationRunEventKind;
  summary?: string;
  createdAt: number;
}>;

export type ApplicationRunEventPage = Readonly<{
  sessionId: string;
  runId: string;
  items: readonly ApplicationRunEvent[];
  nextCursor: string;
}>;

export type ApplicationRunStatusRequest<TAuthorizationContext> = Readonly<{
  context: ApplicationSessionOperationContext<TAuthorizationContext>;
  sessionId: string;
  runId: string;
}>;

export type ApplicationRunStartRequest<TAuthorizationContext> = Readonly<{
  context: ApplicationSessionOperationContext<TAuthorizationContext>;
  sessionId: string;
  idempotencyKey: string;
  contentBlocks: readonly TextContentBlock[];
  execution: ApplicationRunExecutionSettings;
}>;

export type ApplicationRunRetryRequest<TAuthorizationContext> = Readonly<{
  context: ApplicationSessionOperationContext<TAuthorizationContext>;
  sessionId: string;
  retryOfRunId: string;
  idempotencyKey: string;
  executionOverrides?: ApplicationRunExecutionOverrides;
}>;

export type ApplicationRunSendInputRequest<TAuthorizationContext> = Readonly<{
  context: ApplicationSessionOperationContext<TAuthorizationContext>;
  sessionId: string;
  runId: string;
  idempotencyKey: string;
  contentBlocks: readonly TextContentBlock[];
}>;

export type ApplicationRunCancelRequest<TAuthorizationContext> = Readonly<{
  context: ApplicationSessionOperationContext<TAuthorizationContext>;
  sessionId: string;
  runId: string;
  idempotencyKey: string;
}>;

export type ApplicationRunSendInputResult =
  | Readonly<{
      sessionId: string;
      runId: string;
      messageId: string;
      deliveryState: "pending";
      resolutionCode?: never;
    }>
  | Readonly<{
      sessionId: string;
      runId: string;
      messageId: string;
      deliveryState: "accepted";
      resolutionCode?: never;
    }>
  | Readonly<{
      sessionId: string;
      runId: string;
      messageId: string;
      deliveryState: "rejected";
      resolutionCode: "provider_rejected" | "delivery_not_sent";
    }>
  | Readonly<{
      sessionId: string;
      runId: string;
      messageId: string;
      deliveryState: "ambiguous";
      resolutionCode: "transport_unknown" | "process_unknown";
    }>
  | Readonly<{
      sessionId: string;
      runId: string;
      messageId: string;
      deliveryState: "aborted";
      resolutionCode: "run_terminal_not_sent";
    }>;

export type ApplicationRunAdmissionResult = Readonly<{
  sessionId: string;
  runId: string;
  retryOfRunId?: string;
  phase: ApplicationRunPhase;
}>;

export type ApplicationRunEventsRequest<TAuthorizationContext> = ApplicationRunStatusRequest<TAuthorizationContext> &
  Readonly<{
    cursor?: string;
    limit?: number;
  }>;

export type ApplicationRunFollowRequest<TAuthorizationContext> = ApplicationRunEventsRequest<TAuthorizationContext> &
  Readonly<{
    waitMs?: number;
    pollMs?: number;
  }>;

type ApplicationTerminalRunStatus = Extract<
  ApplicationRunStatus,
  Readonly<{ phase: "completed" | "failed" | "canceled" | "interrupted" }>
>;
type ApplicationNonTerminalRunStatus = Exclude<ApplicationRunStatus, ApplicationTerminalRunStatus>;

export type ApplicationRunFollowResult =
  | Readonly<{ reason: "events"; status: ApplicationRunStatus; events: ApplicationRunEventPage }>
  | Readonly<{ reason: "terminal"; status: ApplicationTerminalRunStatus; events: ApplicationRunEventPage }>
  | Readonly<{ reason: "deadline"; status: ApplicationNonTerminalRunStatus; events: ApplicationRunEventPage }>;

export type ApplicationRunAccessValidationInput<TAuthorizationContext> =
  | Readonly<{
      operation: "start";
      access: "write";
      context: ApplicationSessionOperationContext<TAuthorizationContext>;
      target: Readonly<{
        kind: "session_run_start";
        sessionId: string;
      }>;
    }>
  | Readonly<{
      operation: "retry";
      access: "write";
      context: ApplicationSessionOperationContext<TAuthorizationContext>;
      target: Readonly<{
        kind: "session_run_retry";
        sessionId: string;
        retryOfRunId: string;
      }>;
    }>
  | Readonly<{
      operation: "send-input";
      access: "write";
      context: ApplicationSessionOperationContext<TAuthorizationContext>;
      target: Readonly<{
        kind: "run_input";
        sessionId: string;
        runId: string;
      }>;
    }>
  | Readonly<{
      operation: "cancel";
      access: "write";
      context: ApplicationSessionOperationContext<TAuthorizationContext>;
      target: Readonly<{
        kind: "run_cancel";
        sessionId: string;
        runId: string;
      }>;
    }>
  | Readonly<{
      operation: "status" | "events" | "follow";
      access: "read";
      context: ApplicationSessionOperationContext<TAuthorizationContext>;
      target: Readonly<{
        kind: "run";
        sessionId: string;
        runId: string;
      }>;
    }>;

export interface ApplicationRunAccessValidator<TAuthorizationContext> {
  authorize(input: ApplicationRunAccessValidationInput<TAuthorizationContext>): Promise<ApplicationAccessDecision>;
}

export interface ApplicationRunOperations<TAuthorizationContext> {
  start(
    request: ApplicationRunStartRequest<TAuthorizationContext>,
    options?: ApplicationOperationOptions,
  ): Promise<ApplicationOperationResponse<ApplicationRunAdmissionResult, "write">>;
  retry(
    request: ApplicationRunRetryRequest<TAuthorizationContext>,
    options?: ApplicationOperationOptions,
  ): Promise<ApplicationOperationResponse<ApplicationRunAdmissionResult, "write">>;
  sendInput(
    request: ApplicationRunSendInputRequest<TAuthorizationContext>,
    options?: ApplicationOperationOptions,
  ): Promise<ApplicationOperationResponse<ApplicationRunSendInputResult, "write">>;
  cancel(
    request: ApplicationRunCancelRequest<TAuthorizationContext>,
    options?: ApplicationOperationOptions,
  ): Promise<ApplicationOperationResponse<ApplicationRunCancelResult, "write">>;
  status(
    request: ApplicationRunStatusRequest<TAuthorizationContext>,
    options?: ApplicationOperationOptions,
  ): Promise<ApplicationOperationResponse<ApplicationRunStatus, "read">>;
  events(
    request: ApplicationRunEventsRequest<TAuthorizationContext>,
    options?: ApplicationOperationOptions,
  ): Promise<ApplicationOperationResponse<ApplicationRunEventPage, "read">>;
  follow(
    request: ApplicationRunFollowRequest<TAuthorizationContext>,
    options?: ApplicationOperationOptions,
  ): Promise<ApplicationOperationResponse<ApplicationRunFollowResult, "read">>;
}
