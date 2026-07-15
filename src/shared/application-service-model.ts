import type { SessionDetail, SessionExecutionState, SessionListItem } from "./repository-read-model.js";

export type ApplicationSessionOperation = "create" | "list" | "read" | "archive" | "unarchive" | "close";

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

export type ApplicationAccessValidationInput<TAuthorizationContext> = Readonly<{
  operation: ApplicationSessionOperation;
  access: "read" | "write";
  context: ApplicationSessionOperationContext<TAuthorizationContext>;
}>;

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

export type ApplicationDomainError = Readonly<{
  kind: "domain";
  code: ApplicationDomainErrorCode;
  message: string;
  retryable: boolean;
  details?: ApplicationCapacityExceededDetails;
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
  | ApplicationDomainError
  | ApplicationPersistenceError
  | ApplicationInternalError;

export type ApplicationPersistenceStatus =
  | Readonly<{ status: "not_attempted"; effect: "none" }>
  | Readonly<{ status: "read"; effect: "none" }>
  | Readonly<{ status: "committed"; effect: "none"; replayed: boolean }>
  | Readonly<{ status: "rejected"; effect: "none" }>
  | Readonly<{ status: "failed"; effect: ApplicationFailureEffect }>;

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

export type ApplicationOperationResponse<TValue> =
  | Readonly<{
      overallStatus: "success";
      value: TValue;
      persistence: ApplicationPersistenceStatus;
    }>
  | Readonly<{
      overallStatus: "partial_success";
      value: TValue;
      issues: readonly ApplicationOperationIssue[];
      persistence: ApplicationPersistenceStatus;
    }>
  | Readonly<{
      overallStatus: "failure";
      error: ApplicationOperationError;
      persistence: ApplicationPersistenceStatus;
    }>;

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
  session: SessionDetail;
  execution: Readonly<{
    state: SessionExecutionState;
    activeRunId?: string;
    latestRunId?: string;
  }>;
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
  ): Promise<ApplicationOperationResponse<ApplicationSessionCreateResult>>;
  list(
    request: ApplicationSessionListRequest<TAuthorizationContext>,
    options?: ApplicationOperationOptions,
  ): Promise<ApplicationOperationResponse<ApplicationSessionPage>>;
  read(
    request: ApplicationSessionReadRequest<TAuthorizationContext>,
    options?: ApplicationOperationOptions,
  ): Promise<ApplicationOperationResponse<ApplicationSessionReadResult>>;
  archive(
    request: ApplicationSessionWriteRequest<TAuthorizationContext>,
    options?: ApplicationOperationOptions,
  ): Promise<ApplicationOperationResponse<ApplicationSessionTransitionResult>>;
  unarchive(
    request: ApplicationSessionWriteRequest<TAuthorizationContext>,
    options?: ApplicationOperationOptions,
  ): Promise<ApplicationOperationResponse<ApplicationSessionTransitionResult>>;
  close(
    request: ApplicationSessionCloseRequest<TAuthorizationContext>,
    options?: ApplicationOperationOptions,
  ): Promise<ApplicationOperationResponse<ApplicationSessionTransitionResult>>;
}
