import { ALLOWED_ADDITIONAL_DIRECTORIES_LIMITS } from "../shared/allowed-additional-directories.js";
import { SESSION_METADATA_LIMITS, type LocalRepositoryMetadata } from "../shared/session-metadata.js";

export const CLI_SCHEMA_VERSION = "withmate-cli-v1" as const;

export const CLI_EXIT_CODES = {
  success: 0,
  partialSuccess: 10,
  usageInvalid: 20,
  accessRejected: 21,
  domainRejected: 22,
  persistenceFailedNoEffect: 30,
  persistenceFailedUnknownEffect: 31,
  timeout: 40,
  canceled: 41,
  runtimeFailure: 50,
} as const;

export const CLI_SESSION_LIMITS = {
  listDefaultItems: 25,
  listMaxItems: 100,
  directoriesChunkMaxBytes: 256 * 1024,
  maxConcurrentChildRuns: 1_024,
  maxTimeoutMs: 2_147_483_647,
  maxCursorLength: 2_048,
  maxIdentifierLength: 1_024,
  maxAdditionalDirectories: ALLOWED_ADDITIONAL_DIRECTORIES_LIMITS.maxItems,
  maxTitleLength: SESSION_METADATA_LIMITS.titleMaxLength,
  maxQueryLength: SESSION_METADATA_LIMITS.queryMaxLength,
  maxRepositoryFilters: SESSION_METADATA_LIMITS.repositoryFilterMaxItems,
} as const;

export type CliExitCode = (typeof CLI_EXIT_CODES)[keyof typeof CLI_EXIT_CODES];

export type CliSessionOperation =
  "create" | "rename" | "list" | "repositories" | "read" | "directories-chunk" | "archive" | "unarchive" | "close";

export type CliCommandIdentity<TOperation extends CliSessionOperation = CliSessionOperation> = Readonly<{
  namespace: "session";
  operation: TOperation;
}>;

type CliTimeoutOption = Readonly<{ timeoutMs?: number }>;

export type CliSessionCreateCommand = CliTimeoutOption &
  Readonly<{
    identity: CliCommandIdentity<"create">;
    title: string;
    workspacePath: string;
    idempotencyKey: string;
    providerId: string;
    allowedAdditionalDirectories: readonly string[];
    defaultCharacterId: string;
    maxConcurrentChildRuns: number;
  }>;

export type CliSessionListCommand = CliTimeoutOption &
  Readonly<{
    identity: CliCommandIdentity<"list">;
    workspacePath?: string;
    lifecycleStatus?: "active" | "archived" | "closed";
    localRepositoryKeys?: readonly string[];
    query?: string;
    cursor?: string;
    limit: number;
  }>;

export type CliSessionRenameCommand = CliTimeoutOption &
  Readonly<{
    identity: CliCommandIdentity<"rename">;
    sessionId: string;
    title: string;
    idempotencyKey: string;
  }>;

export type CliLocalRepositoriesCommand = CliTimeoutOption &
  Readonly<{
    identity: CliCommandIdentity<"repositories">;
    cursor?: string;
    limit: number;
  }>;

export type CliSessionReadCommand = CliTimeoutOption &
  Readonly<{
    identity: CliCommandIdentity<"read">;
    sessionId: string;
  }>;

export type CliSessionDirectoriesChunkCommand = CliTimeoutOption &
  Readonly<{
    identity: CliCommandIdentity<"directories-chunk">;
    sessionId: string;
    offset: number;
    maxBytes: number;
  }>;

export type CliSessionWriteCommand<TOperation extends "archive" | "unarchive"> = CliTimeoutOption &
  Readonly<{
    identity: CliCommandIdentity<TOperation>;
    sessionId: string;
    idempotencyKey: string;
  }>;

export type CliSessionCloseCommand = CliTimeoutOption &
  Readonly<{
    identity: CliCommandIdentity<"close">;
    sessionId: string;
    idempotencyKey: string;
    expectedLifecycleStatus: "active" | "archived";
  }>;

export type CliValidatedCommand =
  | CliSessionCreateCommand
  | CliSessionRenameCommand
  | CliSessionListCommand
  | CliLocalRepositoriesCommand
  | CliSessionReadCommand
  | CliSessionDirectoriesChunkCommand
  | CliSessionWriteCommand<"archive">
  | CliSessionWriteCommand<"unarchive">
  | CliSessionCloseCommand;

export type CliHelpTopic =
  | Readonly<{ kind: "root" }>
  | Readonly<{ kind: "session" }>
  | Readonly<{ kind: "operation"; command: CliCommandIdentity }>;

export type CliUsageErrorCode =
  | "unknown_command"
  | "unknown_option"
  | "missing_option"
  | "duplicate_option"
  | "invalid_option_value"
  | "unexpected_argument";

export type CliUsageFailureOutput = Readonly<{
  schemaVersion: typeof CLI_SCHEMA_VERSION;
  kind: "usage_failure";
  command: CliCommandIdentity | null;
  error: Readonly<{
    kind: "usage";
    code: CliUsageErrorCode;
    message: string;
  }>;
}>;

export type CliPersistenceStatus =
  | Readonly<{ status: "not_attempted"; effect: "none" }>
  | Readonly<{ status: "read"; effect: "none" }>
  | Readonly<{ status: "committed"; effect: "none"; replayed: boolean }>
  | Readonly<{ status: "rejected"; effect: "none" }>
  | Readonly<{ status: "failed"; effect: "none" }>
  | Readonly<{ status: "failed"; effect: "unknown"; reconciliation: "exact_request_required" }>;

export type CliApplicationError =
  | Readonly<{
      kind: "request";
      code: "request_invalid";
      message: string;
      retryable: false;
    }>
  | Readonly<{
      kind: "access";
      code: "workspace_invalid" | "workspace_unavailable" | "authorization_invalid" | "forbidden";
      message: string;
      retryable: boolean;
    }>
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
    }>
  | Readonly<{
      kind: "domain";
      code: "capacity_exceeded";
      message: string;
      retryable: true;
      details:
        | Readonly<{ scope: "root"; rootSessionId: string; current: number; limit: number }>
        | Readonly<{ scope: "application"; current: number; limit: number }>
        | Readonly<{ scope: "provider"; providerId: string; current: number; limit: number }>;
    }>
  | Readonly<{
      kind: "domain";
      code:
        | "request_invalid"
        | "cursor_invalid"
        | "not_found"
        | "reference_invalid"
        | "lifecycle_conflict"
        | "session_busy"
        | "idempotency_conflict"
        | "idempotency_in_progress"
        | "idempotency_expired";
      message: string;
      retryable: boolean;
      details?: never;
    }>
  | CliPersistenceError<"none">
  | CliPersistenceError<"unknown">
  | Readonly<{
      kind: "application";
      code: "internal_error";
      message: string;
      retryable: false;
    }>;

export type CliPersistenceError<TEffect extends "none" | "unknown"> = Readonly<{
  kind: "persistence";
  code:
    | "persistence_unavailable"
    | "persistence_busy"
    | "persistence_timeout"
    | "persistence_canceled"
    | "persistence_configuration_invalid"
    | "persistence_integrity_failed"
    | "persistence_response_too_large"
    | "persistence_operation_failed";
  message: string;
  retryable: boolean;
  effect: TEffect;
}>;

export type CliApplicationIssue =
  | Readonly<{
      kind: "omission";
      code: "response_size_limit";
      message: string;
      ordinal?: number;
    }>
  | CliPersistenceError<"none">
  | CliPersistenceError<"unknown">;

type CliReadSuccess<TValue> = Readonly<{
  overallStatus: "success";
  value: TValue;
  persistence: Readonly<{ status: "read"; effect: "none" }>;
}>;

type CliReadPartialSuccess<TValue> = Readonly<{
  overallStatus: "partial_success";
  value: TValue;
  issues: readonly [
    Extract<CliApplicationIssue, Readonly<{ kind: "omission" }>>,
    ...Extract<CliApplicationIssue, Readonly<{ kind: "omission" }>>[],
  ];
  persistence: Readonly<{ status: "read"; effect: "none" }>;
}>;

type CliWriteSuccess<TValue> = Readonly<{
  overallStatus: "success";
  value: TValue;
  persistence: Readonly<{ status: "committed"; effect: "none"; replayed: boolean }>;
}>;

type CliWritePartialSuccess<TValue> =
  | Readonly<{
      overallStatus: "partial_success";
      value: TValue;
      issues: readonly [CliPersistenceError<"none">, ...CliPersistenceError<"none">[]];
      persistence: Readonly<{ status: "failed"; effect: "none" }>;
    }>
  | Readonly<{
      overallStatus: "partial_success";
      value: TValue;
      issues: readonly [CliPersistenceError<"unknown">, ...CliPersistenceError<"unknown">[]];
      persistence: Readonly<{
        status: "failed";
        effect: "unknown";
        reconciliation: "exact_request_required";
      }>;
    }>;

type CliApplicationFailure<TMode extends "read" | "write"> =
  | Readonly<{
      overallStatus: "failure";
      error: Extract<CliApplicationError, Readonly<{ kind: "request" | "access" | "operation" }>>;
      persistence: Readonly<{ status: "not_attempted"; effect: "none" }>;
    }>
  | Readonly<{
      overallStatus: "failure";
      error: Extract<CliApplicationError, Readonly<{ kind: "domain" }>>;
      persistence: Readonly<{ status: "rejected"; effect: "none" }>;
    }>
  | Readonly<{
      overallStatus: "failure";
      error: CliPersistenceError<"none">;
      persistence: Readonly<{ status: "failed"; effect: "none" }>;
    }>
  | Readonly<{
      overallStatus: "failure";
      error: TMode extends "write" ? CliPersistenceError<"unknown"> : never;
      persistence: Readonly<{
        status: "failed";
        effect: "unknown";
        reconciliation: "exact_request_required";
      }>;
    }>
  | Readonly<{
      overallStatus: "failure";
      error: Extract<CliApplicationError, Readonly<{ kind: "application" }>>;
      persistence:
        | Readonly<{ status: "not_attempted"; effect: "none" }>
        | (TMode extends "read"
            ? Readonly<{ status: "failed"; effect: "none" }>
            : Readonly<{
                status: "failed";
                effect: "unknown";
                reconciliation: "exact_request_required";
              }>);
    }>;

export type CliApplicationResponse<TValue, TMode extends "read" | "write"> =
  | (TMode extends "read"
      ? CliReadSuccess<TValue> | CliReadPartialSuccess<TValue>
      : CliWriteSuccess<TValue> | CliWritePartialSuccess<TValue>)
  | CliApplicationFailure<TMode>;

export type CliSessionCreateValue = Readonly<{
  sessionId: string;
  title: string;
  workspacePath: string;
  lifecycleStatus: "active";
  createdAt: number;
}> &
  LocalRepositoryMetadata;

export type CliSessionListValue = Readonly<{
  items: readonly CliSessionListItem[];
  nextCursor?: string;
}>;

export type CliSessionExecutionState = "not_started" | "running" | "completed" | "failed" | "canceled" | "interrupted";

type CliSessionListItemBase = Readonly<{
  id: string;
  title: string;
  workspacePath: string;
  defaultCharacterId: string;
  lifecycleStatus: "active" | "archived" | "closed";
  createdAt: number;
  updatedAt: number;
  lastActivityAt: number;
  stateChangedAt: number;
}> &
  LocalRepositoryMetadata;

type CliSessionListExecution =
  | Readonly<{ executionState: "not_started"; activeRunId?: never; latestRunId?: never }>
  | Readonly<{ executionState: "running"; activeRunId: string; latestRunId: string }>
  | Readonly<{
      executionState: Exclude<CliSessionExecutionState, "not_started" | "running">;
      activeRunId?: never;
      latestRunId: string;
    }>;

export type CliSessionListItem =
  | (CliSessionListItemBase & Readonly<{ lifecycleStatus: "active" }> & CliSessionListExecution)
  | (CliSessionListItemBase &
      Readonly<{ lifecycleStatus: "archived" | "closed" }> &
      Exclude<CliSessionListExecution, Readonly<{ executionState: "running" }>>);

export type CliSessionDetail = Readonly<{
  id: string;
  title: string;
  providerId: string;
  workspacePath: string;
  allowedAdditionalDirectoriesByteLength: number;
  allowedAdditionalDirectoriesState: "inline" | "chunked";
  defaultCharacterId: string;
  maxConcurrentChildRuns: number;
  lifecycleStatus: "active" | "archived" | "closed";
  createdAt: number;
  updatedAt: number;
  lastActivityAt: number;
}> &
  LocalRepositoryMetadata;

export type CliSessionExecution =
  | Readonly<{ state: "not_started"; activeRunId?: never; latestRunId?: never }>
  | Readonly<{ state: "running"; activeRunId: string; latestRunId: string }>
  | Readonly<{
      state: Exclude<CliSessionExecutionState, "not_started" | "running">;
      activeRunId?: never;
      latestRunId: string;
    }>;

export type CliSessionReadValue = Readonly<{
  session: CliSessionDetail;
  execution: CliSessionExecution;
}>;

export type CliSessionDirectoriesChunkValue = Readonly<{
  sessionId: string;
  offset: number;
  totalBytes: number;
  eof: boolean;
  chunk: Readonly<{
    encoding: "base64";
    byteLength: number;
    data: string;
  }>;
}>;

export type CliSessionTransitionValue<TLifecycleStatus extends "active" | "archived" | "closed"> = Readonly<{
  sessionId: string;
  lifecycleStatus: TLifecycleStatus;
  updatedAt: number;
}>;

export type CliSessionRenameValue = Readonly<{ sessionId: string; title: string; updatedAt: number }>;
export type CliLocalRepositoryListValue = Readonly<{
  items: readonly Readonly<{
    localRepositoryKey: string;
    repositoryNames: readonly string[];
    repositoryNameCount: number;
    sessionCount: number;
    lastActivityAt: number;
  }>[];
  nextCursor?: string;
}>;

type CliOperationContract = {
  create: Readonly<{ mode: "write"; value: CliSessionCreateValue }>;
  rename: Readonly<{ mode: "write"; value: CliSessionRenameValue }>;
  list: Readonly<{ mode: "read"; value: CliSessionListValue }>;
  repositories: Readonly<{ mode: "read"; value: CliLocalRepositoryListValue }>;
  read: Readonly<{ mode: "read"; value: CliSessionReadValue }>;
  "directories-chunk": Readonly<{ mode: "read"; value: CliSessionDirectoriesChunkValue }>;
  archive: Readonly<{ mode: "write"; value: CliSessionTransitionValue<"archived"> }>;
  unarchive: Readonly<{ mode: "write"; value: CliSessionTransitionValue<"active"> }>;
  close: Readonly<{ mode: "write"; value: CliSessionTransitionValue<"closed"> }>;
};

export type CliOperationOutput<TOperation extends CliSessionOperation = CliSessionOperation> = {
  [TCurrent in TOperation]: Readonly<{
    schemaVersion: typeof CLI_SCHEMA_VERSION;
    kind: "operation";
    command: CliCommandIdentity<TCurrent>;
    applicationResponse: CliApplicationResponse<
      CliOperationContract[TCurrent]["value"],
      CliOperationContract[TCurrent]["mode"]
    >;
  }>;
}[TOperation];

export type CliRuntimeFailureCode =
  "bootstrap_failed" | "malformed_application_response" | "shutdown_failed" | "internal_failure";

export type CliRuntimeError =
  | Readonly<{
      kind: "runtime";
      code: "bootstrap_failed";
      stage: "bootstrap";
      message: string;
    }>
  | Readonly<{
      kind: "runtime";
      code: "malformed_application_response";
      stage: "operation";
      message: string;
    }>
  | Readonly<{
      kind: "runtime";
      code: "shutdown_failed";
      stage: "shutdown";
      message: string;
    }>
  | Readonly<{
      kind: "runtime";
      code: "internal_failure";
      stage: "bootstrap" | "operation" | "shutdown";
      message: string;
    }>;

export type CliRuntimeFailureOutput = Readonly<{
  schemaVersion: typeof CLI_SCHEMA_VERSION;
  kind: "runtime_failure";
  command: CliCommandIdentity | null;
  error: CliRuntimeError;
}>;

export type CliLifecycleFailureOutput<TOperation extends CliSessionOperation = CliSessionOperation> = {
  [TCurrent in TOperation]: Readonly<{
    schemaVersion: typeof CLI_SCHEMA_VERSION;
    kind: "lifecycle_failure";
    command: CliCommandIdentity<TCurrent>;
    applicationResponse: CliOperationOutput<TCurrent>["applicationResponse"];
    error: Extract<CliRuntimeError, Readonly<{ code: "shutdown_failed" }>>;
  }>;
}[TOperation];

export type CliStructuredOutput =
  CliUsageFailureOutput | CliOperationOutput | CliRuntimeFailureOutput | CliLifecycleFailureOutput;

export type CliParseResult =
  | Readonly<{ kind: "command"; command: CliValidatedCommand }>
  | Readonly<{ kind: "help"; topic: CliHelpTopic }>
  | Readonly<{ kind: "version" }>
  | Readonly<{ kind: "usage_failure"; output: CliUsageFailureOutput; exitCode: typeof CLI_EXIT_CODES.usageInvalid }>;
