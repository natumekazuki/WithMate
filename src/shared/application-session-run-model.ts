import type {
  ApplicationAccessDecision,
  ApplicationOperationOptions,
  ApplicationOperationResponse,
  ApplicationSessionOperationContext,
} from "./application-service-model.js";
import type {
  ApplicationRunCancellationAcknowledgementSummary,
  ApplicationRunCancellationRequestSummary,
  ApplicationRunFailureSummary,
  ApplicationRunPhase,
} from "./application-run-model.js";
import { REPOSITORY_READ_LIMITS } from "./repository-read-model.js";

export const APPLICATION_SESSION_RUN_LIMITS = {
  maxIdentifierLength: 1_024,
  maxCursorLength: 2_048,
  maxSummaryLength: 4_096,
  runsDefaultItems: REPOSITORY_READ_LIMITS.runs.default,
  runsMaxItems: REPOSITORY_READ_LIMITS.runs.max,
} as const;

type ApplicationSessionRunItemBase = Readonly<{
  runId: string;
  ordinal: number;
  initiatingMessageId: string;
  finalAssistantMessageId?: string;
  retryOfRunId?: string;
  createdAt: number;
  startedAt?: number;
  updatedAt: number;
}>;

type ApplicationSessionRunNonTerminalItem = ApplicationSessionRunItemBase &
  Readonly<{
    phase: Exclude<ApplicationRunPhase, "canceling" | "completed" | "failed" | "canceled" | "interrupted">;
    terminalAt?: never;
    failure?: never;
    cancellation?: never;
    finalAssistantMessageId?: never;
  }>;

type ApplicationSessionRunCancelingItem = ApplicationSessionRunItemBase &
  Readonly<{
    phase: "canceling";
    terminalAt?: never;
    failure?: never;
    cancellation: ApplicationRunCancellationRequestSummary;
    finalAssistantMessageId?: never;
  }>;

type ApplicationSessionRunCompletedItem = ApplicationSessionRunItemBase &
  Readonly<{
    phase: "completed";
    terminalAt: number;
    failure?: never;
    cancellation?: ApplicationRunCancellationRequestSummary;
  }>;

type ApplicationSessionRunFailedItem = ApplicationSessionRunItemBase &
  Readonly<{
    phase: "failed" | "interrupted";
    terminalAt: number;
    failure: ApplicationRunFailureSummary;
    cancellation?: ApplicationRunCancellationRequestSummary;
    finalAssistantMessageId?: never;
  }>;

type ApplicationSessionRunCanceledItem = ApplicationSessionRunItemBase &
  Readonly<{
    phase: "canceled";
    terminalAt: number;
    failure?: never;
    cancellation?: ApplicationRunCancellationAcknowledgementSummary;
    finalAssistantMessageId?: never;
  }>;

export type ApplicationSessionRunItem =
  | ApplicationSessionRunNonTerminalItem
  | ApplicationSessionRunCancelingItem
  | ApplicationSessionRunCompletedItem
  | ApplicationSessionRunFailedItem
  | ApplicationSessionRunCanceledItem;

export type ApplicationSessionRunPage = Readonly<{
  sessionId: string;
  items: readonly ApplicationSessionRunItem[];
  nextCursor?: string;
}>;

export type ApplicationSessionRunsRequest<TAuthorizationContext> = Readonly<{
  context: ApplicationSessionOperationContext<TAuthorizationContext>;
  sessionId: string;
  cursor?: string;
  limit?: number;
}>;

export type ApplicationSessionRunAccessValidationInput<TAuthorizationContext> = Readonly<{
  operation: "runs";
  access: "read";
  context: ApplicationSessionOperationContext<TAuthorizationContext>;
  target: Readonly<{ kind: "session_runs"; sessionId: string }>;
}>;

export interface ApplicationSessionRunAccessValidator<TAuthorizationContext> {
  authorize(
    input: ApplicationSessionRunAccessValidationInput<TAuthorizationContext>,
  ): Promise<ApplicationAccessDecision>;
}

export interface ApplicationSessionRunOperations<TAuthorizationContext> {
  runs(
    request: ApplicationSessionRunsRequest<TAuthorizationContext>,
    options?: ApplicationOperationOptions,
  ): Promise<ApplicationOperationResponse<ApplicationSessionRunPage, "read">>;
}
