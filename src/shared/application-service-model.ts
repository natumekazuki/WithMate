import type { SessionExecutionState, SessionListItem } from "./repository-read-model.js";

export type ApplicationSessionOperation =
  "create" | "list" | "read" | "read_directories_chunk" | "archive" | "unarchive" | "close";

export type ApplicationSessionOperationContext<TAuthorizationContext> = Readonly<{
  workspaceKey: string;
  authorization: TAuthorizationContext;
}>;

export type ApplicationAccessDecision =
  | Readonly<{ allowed: true }>
  | Readonly<{
      allowed: false;
      error: Readonly<{
        code: "workspace_invalid" | "workspace_unavailable" | "authorization_invalid" | "forbidden";
        message: string;
        retryable: boolean;
      }>;
    }>;

export type ApplicationSessionCreateAccessTarget = Readonly<{
  kind: "session_create";
  providerId: string;
  allowedAdditionalDirectories: readonly string[];
  defaultCharacterId: string;
  maxConcurrentChildRuns: number;
}>;

export type ApplicationSessionCollectionAccessTarget = Readonly<{
  kind: "session_collection";
  lifecycleStatus?: ApplicationSessionLifecycleStatus;
}>;

export type ApplicationSessionAccessTarget = Readonly<{
  kind: "session";
  sessionId: string;
}>;

export type ApplicationSessionDirectoriesAccessTarget = Readonly<{
  kind: "session_directories";
  sessionId: string;
  offset: number;
  maxBytes: number;
}>;

type ApplicationAccessValidationBase<TAuthorizationContext> = Readonly<{
  context: ApplicationSessionOperationContext<TAuthorizationContext>;
}>;

export type ApplicationAccessValidationInput<TAuthorizationContext> =
  | (ApplicationAccessValidationBase<TAuthorizationContext> &
      Readonly<{ operation: "create"; access: "write"; target: ApplicationSessionCreateAccessTarget }>)
  | (ApplicationAccessValidationBase<TAuthorizationContext> &
      Readonly<{ operation: "list"; access: "read"; target: ApplicationSessionCollectionAccessTarget }>)
  | (ApplicationAccessValidationBase<TAuthorizationContext> &
      Readonly<{ operation: "read"; access: "read"; target: ApplicationSessionAccessTarget }>)
  | (ApplicationAccessValidationBase<TAuthorizationContext> &
      Readonly<{
        operation: "read_directories_chunk";
        access: "read";
        target: ApplicationSessionDirectoriesAccessTarget;
      }>)
  | (ApplicationAccessValidationBase<TAuthorizationContext> &
      Readonly<{
        operation: "archive" | "unarchive" | "close";
        access: "write";
        target: ApplicationSessionAccessTarget;
      }>);

export interface ApplicationAccessValidator<TAuthorizationContext> {
  validateWorkspace(input: ApplicationAccessValidationInput<TAuthorizationContext>): Promise<ApplicationAccessDecision>;
  authorize(input: ApplicationAccessValidationInput<TAuthorizationContext>): Promise<ApplicationAccessDecision>;
}

export type ApplicationRequestError = Readonly<{
  kind: "request";
  code: "request_invalid";
  message: string;
  retryable: false;
}>;

export type ApplicationAccessError = Readonly<{
  kind: "access";
  code: "workspace_invalid" | "workspace_unavailable" | "authorization_invalid" | "forbidden";
  message: string;
  retryable: boolean;
}>;

export type ApplicationOperationInterruptedError =
  | Readonly<{
      kind: "operation";
      code: "operation_timeout";
      message: string;
      retryable: true;
    }>
  | Readonly<{
      kind: "operation";
      code: "operation_canceled";
      message: string;
      retryable: false;
    }>;

export type ApplicationDomainErrorCode =
  | "request_invalid"
  | "cursor_invalid"
  | "not_found"
  | "reference_invalid"
  | "lifecycle_conflict"
  | "session_busy"
  | "capacity_exceeded"
  | "idempotency_conflict"
  | "idempotency_in_progress"
  | "idempotency_expired";

export type ApplicationCapacityExceededDetails =
  | Readonly<{ scope: "root"; rootSessionId: string; current: number; limit: number }>
  | Readonly<{ scope: "application"; current: number; limit: number }>
  | Readonly<{ scope: "provider"; providerId: string; current: number; limit: number }>;

export type ApplicationDomainError =
  | Readonly<{
      kind: "domain";
      code: "capacity_exceeded";
      message: string;
      retryable: true;
      details: ApplicationCapacityExceededDetails;
    }>
  | Readonly<{
      kind: "domain";
      code: Exclude<ApplicationDomainErrorCode, "capacity_exceeded">;
      message: string;
      retryable: boolean;
      details?: never;
    }>;

export type ApplicationPersistenceError = Readonly<{
  kind: "persistence";
  code: ApplicationPersistenceErrorCode;
  message: string;
  retryable: boolean;
  effect: ApplicationFailureEffect;
}>;

export type ApplicationFailureEffect = "none" | "unknown";

export type ApplicationPersistenceErrorCode =
  | "persistence_unavailable"
  | "persistence_busy"
  | "persistence_timeout"
  | "persistence_canceled"
  | "persistence_configuration_invalid"
  | "persistence_integrity_failed"
  | "persistence_response_too_large"
  | "persistence_operation_failed";

export type ApplicationInternalError = Readonly<{
  kind: "application";
  code: "internal_error";
  message: string;
  retryable: false;
}>;

export type ApplicationOperationError =
  | ApplicationRequestError
  | ApplicationAccessError
  | ApplicationOperationInterruptedError
  | ApplicationDomainError
  | ApplicationPersistenceError
  | ApplicationInternalError;

type ApplicationNotAttemptedPersistenceStatus = Readonly<{ status: "not_attempted"; effect: "none" }>;
type ApplicationReadPersistenceStatus = Readonly<{ status: "read"; effect: "none" }>;
type ApplicationCommittedPersistenceStatus = Readonly<{
  status: "committed";
  effect: "none";
  replayed: boolean;
}>;
type ApplicationRejectedPersistenceStatus = Readonly<{ status: "rejected"; effect: "none" }>;
type ApplicationFailedPersistenceStatus<TEffect extends ApplicationFailureEffect = ApplicationFailureEffect> =
  TEffect extends "unknown"
    ? Readonly<{ status: "failed"; effect: "unknown"; reconciliation: "exact_request_required" }>
    : Readonly<{ status: "failed"; effect: "none" }>;

export type ApplicationPersistenceStatus =
  | ApplicationNotAttemptedPersistenceStatus
  | ApplicationReadPersistenceStatus
  | ApplicationCommittedPersistenceStatus
  | ApplicationRejectedPersistenceStatus
  | ApplicationFailedPersistenceStatus;

export type ApplicationOperationOptions = Readonly<{
  timeoutMs?: number;
  signal?: AbortSignal;
}>;

export type ApplicationOperationIssue =
  | Readonly<{
      kind: "omission";
      code: "response_size_limit";
      message: string;
      ordinal?: number;
    }>
  | ApplicationPersistenceError;

export type ApplicationOperationMode = "read" | "write";

type ApplicationOmissionIssue = Extract<ApplicationOperationIssue, Readonly<{ kind: "omission" }>>;

type ApplicationReadSuccessResponse<TValue> = Readonly<{
  overallStatus: "success";
  value: TValue;
  persistence: ApplicationReadPersistenceStatus;
}>;

type ApplicationReadPartialSuccessResponse<TValue> = Readonly<{
  overallStatus: "partial_success";
  value: TValue;
  issues: readonly [ApplicationOmissionIssue, ...ApplicationOmissionIssue[]];
  persistence: ApplicationReadPersistenceStatus;
}>;

type ApplicationWriteSuccessResponse<TValue> = Readonly<{
  overallStatus: "success";
  value: TValue;
  persistence: ApplicationCommittedPersistenceStatus;
}>;

type ApplicationWritePartialSuccessResponse<TValue> = {
  [TEffect in ApplicationFailureEffect]: Readonly<{
    overallStatus: "partial_success";
    value: TValue;
    issues: readonly [
      ApplicationPersistenceError & Readonly<{ effect: TEffect }>,
      ...(ApplicationPersistenceError & Readonly<{ effect: TEffect }>)[],
    ];
    persistence: ApplicationFailedPersistenceStatus<TEffect>;
  }>;
}[ApplicationFailureEffect];

type ApplicationPrePersistenceFailureResponse = Readonly<{
  overallStatus: "failure";
  error: ApplicationRequestError | ApplicationAccessError | ApplicationOperationInterruptedError;
  persistence: ApplicationNotAttemptedPersistenceStatus;
}>;

type ApplicationDomainFailureResponse = Readonly<{
  overallStatus: "failure";
  error: ApplicationDomainError;
  persistence: ApplicationRejectedPersistenceStatus;
}>;

type ApplicationPersistenceFailureEffect<TMode extends ApplicationOperationMode> = TMode extends "read"
  ? "none"
  : ApplicationFailureEffect;

type ApplicationPersistenceFailureResponse<TMode extends ApplicationOperationMode> = {
  [TEffect in ApplicationPersistenceFailureEffect<TMode>]: Readonly<{
    overallStatus: "failure";
    error: ApplicationPersistenceError & Readonly<{ effect: TEffect }>;
    persistence: ApplicationFailedPersistenceStatus<TEffect>;
  }>;
}[ApplicationPersistenceFailureEffect<TMode>];

type ApplicationInternalFailureResponse<TMode extends ApplicationOperationMode> =
  | Readonly<{
      overallStatus: "failure";
      error: ApplicationInternalError;
      persistence: ApplicationNotAttemptedPersistenceStatus;
    }>
  | Readonly<{
      overallStatus: "failure";
      error: ApplicationInternalError;
      persistence: TMode extends "read"
        ? ApplicationFailedPersistenceStatus<"none">
        : ApplicationFailedPersistenceStatus<"unknown">;
    }>;

type ApplicationOutcomeResponse<TValue, TMode extends ApplicationOperationMode> = TMode extends "read"
  ? ApplicationReadSuccessResponse<TValue> | ApplicationReadPartialSuccessResponse<TValue>
  : ApplicationWriteSuccessResponse<TValue> | ApplicationWritePartialSuccessResponse<TValue>;

export type ApplicationOperationResponse<TValue, TMode extends ApplicationOperationMode = ApplicationOperationMode> =
  | ApplicationOutcomeResponse<TValue, TMode>
  | ApplicationPrePersistenceFailureResponse
  | ApplicationDomainFailureResponse
  | ApplicationPersistenceFailureResponse<TMode>
  | ApplicationInternalFailureResponse<TMode>;

export type ApplicationSessionCreateRequest<TAuthorizationContext> = Readonly<{
  context: ApplicationSessionOperationContext<TAuthorizationContext>;
  idempotencyKey: string;
  providerId: string;
  allowedAdditionalDirectories: readonly string[];
  defaultCharacterId: string;
  maxConcurrentChildRuns: number;
}>;

export type ApplicationSessionCreateResult = Readonly<{
  sessionId: string;
  workspaceKey: string;
  lifecycleStatus: "active";
  createdAt: number;
}>;

export type ApplicationSessionListRequest<TAuthorizationContext> = Readonly<{
  context: ApplicationSessionOperationContext<TAuthorizationContext>;
  lifecycleStatus?: ApplicationSessionLifecycleStatus;
  cursor?: string;
  limit?: number;
}>;

// Repository read projectionは永続化方式に依存しないCP2公開型なので、同じfieldを複製しない。
export type ApplicationSessionListItem = SessionListItem;

export type ApplicationSessionPage = Readonly<{
  items: readonly ApplicationSessionListItem[];
  nextCursor?: string;
}>;

export type ApplicationSessionReadRequest<TAuthorizationContext> = Readonly<{
  context: ApplicationSessionOperationContext<TAuthorizationContext>;
  sessionId: string;
}>;

export type ApplicationSessionReadResult = Readonly<{
  session: ApplicationSessionDetail;
  execution: Readonly<{
    state: SessionExecutionState;
    activeRunId?: string;
    latestRunId?: string;
  }>;
}>;

export type ApplicationSessionDetail = Readonly<{
  id: string;
  providerId: string;
  workspaceKey: string;
  allowedAdditionalDirectoriesByteLength: number;
  allowedAdditionalDirectoriesState: "inline" | "chunked";
  defaultCharacterId: string;
  maxConcurrentChildRuns: number;
  lifecycleStatus: ApplicationSessionLifecycleStatus;
  createdAt: number;
  updatedAt: number;
  lastActivityAt: number;
}>;

export type ApplicationSessionDirectoriesChunkRequest<TAuthorizationContext> = Readonly<{
  context: ApplicationSessionOperationContext<TAuthorizationContext>;
  sessionId: string;
  offset: number;
  maxBytes: number;
}>;

export type ApplicationSessionDirectoriesChunkResult = Readonly<{
  sessionId: string;
  offset: number;
  totalBytes: number;
  eof: boolean;
  bytes: ArrayBuffer;
}>;

export type ApplicationSessionWriteRequest<TAuthorizationContext> = Readonly<{
  context: ApplicationSessionOperationContext<TAuthorizationContext>;
  sessionId: string;
  idempotencyKey: string;
}>;

export type ApplicationSessionCloseRequest<TAuthorizationContext> =
  ApplicationSessionWriteRequest<TAuthorizationContext> & Readonly<{ expectedLifecycleStatus: "active" | "archived" }>;

export type ApplicationSessionLifecycleStatus = "active" | "archived" | "closed";

export type ApplicationSessionTransitionResult = Readonly<{
  sessionId: string;
  lifecycleStatus: ApplicationSessionLifecycleStatus;
  updatedAt: number;
}>;

export interface ApplicationSessionOperations<TAuthorizationContext> {
  create(
    request: ApplicationSessionCreateRequest<TAuthorizationContext>,
    options?: ApplicationOperationOptions,
  ): Promise<ApplicationOperationResponse<ApplicationSessionCreateResult, "write">>;
  list(
    request: ApplicationSessionListRequest<TAuthorizationContext>,
    options?: ApplicationOperationOptions,
  ): Promise<ApplicationOperationResponse<ApplicationSessionPage, "read">>;
  read(
    request: ApplicationSessionReadRequest<TAuthorizationContext>,
    options?: ApplicationOperationOptions,
  ): Promise<ApplicationOperationResponse<ApplicationSessionReadResult, "read">>;
  readDirectoriesChunk(
    request: ApplicationSessionDirectoriesChunkRequest<TAuthorizationContext>,
    options?: ApplicationOperationOptions,
  ): Promise<ApplicationOperationResponse<ApplicationSessionDirectoriesChunkResult, "read">>;
  archive(
    request: ApplicationSessionWriteRequest<TAuthorizationContext>,
    options?: ApplicationOperationOptions,
  ): Promise<ApplicationOperationResponse<ApplicationSessionTransitionResult, "write">>;
  unarchive(
    request: ApplicationSessionWriteRequest<TAuthorizationContext>,
    options?: ApplicationOperationOptions,
  ): Promise<ApplicationOperationResponse<ApplicationSessionTransitionResult, "write">>;
  close(
    request: ApplicationSessionCloseRequest<TAuthorizationContext>,
    options?: ApplicationOperationOptions,
  ): Promise<ApplicationOperationResponse<ApplicationSessionTransitionResult, "write">>;
}
