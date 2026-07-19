import type {
  ApplicationAccessDecision,
  ApplicationOperationOptions,
  ApplicationOperationResponse,
  ApplicationSessionOperationContext,
} from "./application-service-model.js";
import { REPOSITORY_READ_LIMITS } from "./repository-read-model.js";

export const APPLICATION_RUN_LIMITS = {
  maxIdentifierLength: 1_024,
  maxCursorLength: 2_048,
  maxSummaryLength: 4_096,
  eventsDefaultItems: REPOSITORY_READ_LIMITS.events.default,
  eventsMaxItems: REPOSITORY_READ_LIMITS.events.max,
  followDefaultWaitMs: 10_000,
  followMaxWaitMs: 30_000,
  followDefaultPollMs: 250,
  followMinPollMs: 25,
  followMaxPollMs: 5_000,
} as const;

export type ApplicationRunOperation = "status" | "events" | "follow";

export type ApplicationRunPhase =
  "queued" | "starting" | "active" | "canceling" | "finalizing" | "completed" | "failed" | "canceled" | "interrupted";

export type ApplicationRunLiveActivity = "running" | "waiting_approval" | "waiting_input" | "waiting_child";

export type ApplicationRunFailureSummary = Readonly<{
  origin: "provider" | "transport" | "process" | "application" | "persistence" | "unknown";
  summary?: string;
}>;

export type ApplicationRunCancellationSummary = Readonly<{
  requestedAt: number;
  acknowledgedAt?: number;
}>;

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
    cancellation?: ApplicationRunCancellationSummary;
    failure?: never;
    terminalAt?: never;
  }>;

type ApplicationRunCompletedStatus = ApplicationRunStatusBase &
  Readonly<{
    phase: "completed";
    liveActivity: null;
    terminalAt: number;
    failure?: never;
    cancellation?: never;
  }>;

type ApplicationRunFailedStatus = ApplicationRunStatusBase &
  Readonly<{
    phase: "failed" | "interrupted";
    liveActivity: null;
    terminalAt: number;
    failure: ApplicationRunFailureSummary;
    cancellation?: ApplicationRunCancellationSummary;
  }>;

type ApplicationRunCanceledStatus = ApplicationRunStatusBase &
  Readonly<{
    phase: "canceled";
    liveActivity: null;
    terminalAt: number;
    cancellation?: ApplicationRunCancellationSummary;
    failure?: never;
  }>;

export type ApplicationRunStatus =
  | ApplicationRunInactiveStatus
  | ApplicationRunActiveStatus
  | ApplicationRunCancelingStatus
  | ApplicationRunCompletedStatus
  | ApplicationRunFailedStatus
  | ApplicationRunCanceledStatus;

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

export type ApplicationRunAccessValidationInput<TAuthorizationContext> = Readonly<{
  operation: ApplicationRunOperation;
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
