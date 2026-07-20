import type { LocalRepositoryMetadata } from "./session-metadata.js";

export type ApplicationSessionOperation =
  | "create"
  | "update_title"
  | "list"
  | "list_local_repositories"
  | "read"
  | "read_directories_chunk"
  | "archive"
  | "unarchive"
  | "close"
  | "delete";

export type ApplicationSessionOperationContext<TAuthorizationContext> = Readonly<{
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
  title: string;
  workspacePath: string;
  providerId: string;
  allowedAdditionalDirectories: readonly string[];
  defaultCharacterId: string;
  maxConcurrentChildRuns: number;
}>;

export type ApplicationSessionCollectionAccessTarget = Readonly<{
  kind: "session_collection";
  scope: "all_sessions";
  workspacePath?: string;
  lifecycleStatus?: ApplicationSessionLifecycleStatus;
  localRepositoryKeys?: readonly string[];
  query?: string;
}>;

export type ApplicationLocalRepositoryCollectionAccessTarget = Readonly<{
  kind: "local_repository_collection";
  scope: "all_sessions";
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
      Readonly<{
        operation: "list_local_repositories";
        access: "read";
        target: ApplicationLocalRepositoryCollectionAccessTarget;
      }>)
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
        operation: "update_title" | "archive" | "unarchive" | "close" | "delete";
        access: "write";
        target: ApplicationSessionAccessTarget;
      }>);

export interface ApplicationAccessValidator<TAuthorizationContext> {
  validateWorkspace(
    input: Extract<ApplicationAccessValidationInput<TAuthorizationContext>, Readonly<{ operation: "create" }>>,
  ): Promise<ApplicationAccessDecision>;
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
  | "insufficient_disk_space"
  | "idempotency_conflict"
  | "idempotency_in_progress"
  | "idempotency_expired"
  | "identity_exhausted"
  | "payload_unavailable"
  | "payload_format_unsupported"
  | "destination_exists"
  | "destination_invalid"
  | "payload_integrity_mismatch";

export type ApplicationRunOutputPayloadUnavailableDetails = Readonly<{
  reason: "no_payload" | "pending" | "size_limit" | "redaction" | "persistence_failure";
}>;

export type ApplicationRunOutputPayloadUnavailableError =
  | Readonly<{
      kind: "domain";
      code: "payload_unavailable";
      message: string;
      retryable: true;
      details: Readonly<{ reason: "pending" }>;
    }>
  | Readonly<{
      kind: "domain";
      code: "payload_unavailable";
      message: string;
      retryable: false;
      details: Readonly<{
        reason: Exclude<ApplicationRunOutputPayloadUnavailableDetails["reason"], "pending">;
      }>;
    }>;

export type ApplicationRunOutputPayloadFormatDetails = Readonly<{
  format: "binary";
  supportedAction: "export";
}>;

export type ApplicationCapacityExceededDetails =
  | Readonly<{ scope: "root"; rootSessionId: string; current: number; limit: number }>
  | Readonly<{ scope: "session_tree"; rootSessionId: string; current: number; limit: number }>
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
  | ApplicationRunOutputPayloadUnavailableError
  | Readonly<{
      kind: "domain";
      code: "payload_format_unsupported";
      message: string;
      retryable: false;
      details: ApplicationRunOutputPayloadFormatDetails;
    }>
  | Readonly<{
      kind: "domain";
      code: Exclude<
        ApplicationDomainErrorCode,
        "capacity_exceeded" | "payload_unavailable" | "payload_format_unsupported"
      >;
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

export type ApplicationSessionCleanupIssue = Readonly<{
  kind: "cleanup";
  code: "session_files_cleanup_pending";
  message: string;
  cleanupToken: string;
  retryable: true;
  reconciliation: "exact_request_required";
}>;

export type ApplicationOperationIssue =
  | Readonly<{
      kind: "omission";
      code: "response_size_limit";
      message: string;
      ordinal?: number;
    }>
  | ApplicationSessionCleanupIssue
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
  title: string;
  workspacePath: string;
  idempotencyKey: string;
  providerId: string;
  allowedAdditionalDirectories: readonly string[];
  defaultCharacterId: string;
  maxConcurrentChildRuns: number;
}>;

export type ApplicationSessionCreateResult = Readonly<{
  sessionId: string;
  title: string;
  workspacePath: string;
  lifecycleStatus: "active";
  createdAt: number;
}> &
  LocalRepositoryMetadata;

export type ApplicationSessionListRequest<TAuthorizationContext> = Readonly<{
  context: ApplicationSessionOperationContext<TAuthorizationContext>;
  workspacePath?: string;
  lifecycleStatus?: ApplicationSessionLifecycleStatus;
  localRepositoryKeys?: readonly string[];
  query?: string;
  cursor?: string;
  limit?: number;
}>;

export type ApplicationLocalRepositoryListRequest<TAuthorizationContext> = Readonly<{
  context: ApplicationSessionOperationContext<TAuthorizationContext>;
  cursor?: string;
  limit?: number;
}>;

export type ApplicationLocalRepositoryListItem = Readonly<{
  localRepositoryKey: string;
  repositoryNames: readonly string[];
  repositoryNameCount: number;
  sessionCount: number;
  lastActivityAt: number;
}>;

export type ApplicationLocalRepositoryPage = Readonly<{
  items: readonly ApplicationLocalRepositoryListItem[];
  nextCursor?: string;
}>;

export type ApplicationSessionExecutionState =
  "not_started" | "running" | "completed" | "failed" | "canceled" | "interrupted";

type ApplicationNotStartedExecution = Readonly<{
  state: "not_started";
  activeRunId?: never;
  latestRunId?: never;
}>;

type ApplicationRunningExecution = Readonly<{
  state: "running";
  activeRunId: string;
  latestRunId: string;
}>;

type ApplicationTerminalExecution = Readonly<{
  state: Exclude<ApplicationSessionExecutionState, "not_started" | "running">;
  activeRunId?: never;
  latestRunId: string;
}>;

export type ApplicationSessionExecution =
  ApplicationNotStartedExecution | ApplicationRunningExecution | ApplicationTerminalExecution;

type ApplicationNonRunningSessionExecution = ApplicationNotStartedExecution | ApplicationTerminalExecution;

type ApplicationSessionListItemBase = Readonly<{
  id: string;
  title: string;
  workspacePath: string;
  defaultCharacterId: string;
  lifecycleStatus: ApplicationSessionLifecycleStatus;
  createdAt: number;
  updatedAt: number;
  lastActivityAt: number;
  stateChangedAt: number;
}> &
  LocalRepositoryMetadata;

type ApplicationSessionListExecution =
  | Readonly<{ executionState: "not_started"; activeRunId?: never; latestRunId?: never }>
  | Readonly<{ executionState: "running"; activeRunId: string; latestRunId: string }>
  | Readonly<{
      executionState: Exclude<ApplicationSessionExecutionState, "not_started" | "running">;
      activeRunId?: never;
      latestRunId: string;
    }>;

type ApplicationNonRunningSessionListExecution = Exclude<
  ApplicationSessionListExecution,
  Readonly<{ executionState: "running" }>
>;

export type ApplicationSessionListItem =
  | (ApplicationSessionListItemBase & Readonly<{ lifecycleStatus: "active" }> & ApplicationSessionListExecution)
  | (ApplicationSessionListItemBase &
      Readonly<{ lifecycleStatus: Exclude<ApplicationSessionLifecycleStatus, "active"> }> &
      ApplicationNonRunningSessionListExecution);

export type ApplicationSessionPage = Readonly<{
  items: readonly ApplicationSessionListItem[];
  nextCursor?: string;
}>;

export type ApplicationSessionReadRequest<TAuthorizationContext> = Readonly<{
  context: ApplicationSessionOperationContext<TAuthorizationContext>;
  sessionId: string;
}>;

type ApplicationSessionDetailBase = Readonly<{
  id: string;
  title: string;
  providerId: string;
  workspacePath: string;
  allowedAdditionalDirectoriesByteLength: number;
  allowedAdditionalDirectoriesState: "inline" | "chunked";
  defaultCharacterId: string;
  maxConcurrentChildRuns: number;
  createdAt: number;
  updatedAt: number;
  lastActivityAt: number;
}> &
  LocalRepositoryMetadata;

export type ApplicationSessionDetail = ApplicationSessionDetailBase &
  Readonly<{ lifecycleStatus: ApplicationSessionLifecycleStatus }>;

export type ApplicationSessionReadResult =
  | Readonly<{
      session: ApplicationSessionDetailBase & Readonly<{ lifecycleStatus: "active" }>;
      execution: ApplicationSessionExecution;
    }>
  | Readonly<{
      session: ApplicationSessionDetailBase &
        Readonly<{ lifecycleStatus: Exclude<ApplicationSessionLifecycleStatus, "active"> }>;
      execution: ApplicationNonRunningSessionExecution;
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

export type ApplicationSessionDeleteRequest<TAuthorizationContext> =
  ApplicationSessionWriteRequest<TAuthorizationContext>;

type ApplicationSessionDeleteResultBase = Readonly<{
  sessionId: string;
  cleanupToken: string;
  deletedSessionCount: number;
  localOnly: true;
}>;

export type ApplicationSessionDeleteResult =
  | (ApplicationSessionDeleteResultBase & Readonly<{ cleanupStatus: "completed" }>)
  | (ApplicationSessionDeleteResultBase & Readonly<{ cleanupStatus: "pending" }>);

type ApplicationSessionDeleteFailureResponse = Extract<
  ApplicationOperationResponse<never, "read"> | ApplicationOperationResponse<never, "write">,
  Readonly<{ overallStatus: "failure" }>
>;

export type ApplicationSessionDeleteResponse =
  | Readonly<{
      overallStatus: "success";
      value: Extract<ApplicationSessionDeleteResult, Readonly<{ cleanupStatus: "completed" }>>;
      persistence: ApplicationCommittedPersistenceStatus;
    }>
  | Readonly<{
      overallStatus: "partial_success";
      value: Extract<ApplicationSessionDeleteResult, Readonly<{ cleanupStatus: "pending" }>>;
      issues: readonly [ApplicationSessionCleanupIssue];
      persistence: ApplicationCommittedPersistenceStatus;
    }>
  | ApplicationSessionDeleteFailureResponse;

export type ApplicationSessionUpdateTitleRequest<TAuthorizationContext> =
  ApplicationSessionWriteRequest<TAuthorizationContext> & Readonly<{ title: string }>;

export type ApplicationSessionUpdateTitleResult = Readonly<{
  sessionId: string;
  title: string;
  updatedAt: number;
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
  updateTitle(
    request: ApplicationSessionUpdateTitleRequest<TAuthorizationContext>,
    options?: ApplicationOperationOptions,
  ): Promise<ApplicationOperationResponse<ApplicationSessionUpdateTitleResult, "write">>;
  list(
    request: ApplicationSessionListRequest<TAuthorizationContext>,
    options?: ApplicationOperationOptions,
  ): Promise<ApplicationOperationResponse<ApplicationSessionPage, "read">>;
  listLocalRepositories(
    request: ApplicationLocalRepositoryListRequest<TAuthorizationContext>,
    options?: ApplicationOperationOptions,
  ): Promise<ApplicationOperationResponse<ApplicationLocalRepositoryPage, "read">>;
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
  delete(
    request: ApplicationSessionDeleteRequest<TAuthorizationContext>,
    options?: ApplicationOperationOptions,
  ): Promise<ApplicationSessionDeleteResponse>;
}
