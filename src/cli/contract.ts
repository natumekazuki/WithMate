import { ALLOWED_ADDITIONAL_DIRECTORIES_LIMITS } from "../shared/allowed-additional-directories.js";
import { APPLICATION_RUN_LIMITS } from "../shared/application-run-model.js";
import {
  APPLICATION_RUN_OUTPUT_CATEGORIES,
  APPLICATION_RUN_OUTPUT_LIMITS,
} from "../shared/application-run-output-model.js";
import { APPLICATION_SESSION_MESSAGE_LIMITS } from "../shared/application-session-message-model.js";
import { APPLICATION_SESSION_RUN_LIMITS } from "../shared/application-session-run-model.js";
import type { TextContentBlock } from "../shared/message-content.js";
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

export const CLI_RUN_LIMITS = {
  maxSummaryLength: APPLICATION_RUN_LIMITS.maxSummaryLength,
  eventsDefaultItems: APPLICATION_RUN_LIMITS.eventsDefaultItems,
  eventsMaxItems: APPLICATION_RUN_LIMITS.eventsMaxItems,
  followDefaultWaitMs: APPLICATION_RUN_LIMITS.followDefaultWaitMs,
  followMaxWaitMs: APPLICATION_RUN_LIMITS.followMaxWaitMs,
  followDefaultPollMs: APPLICATION_RUN_LIMITS.followDefaultPollMs,
  followMinPollMs: APPLICATION_RUN_LIMITS.followMinPollMs,
  followMaxPollMs: APPLICATION_RUN_LIMITS.followMaxPollMs,
  outputsDefaultItems: APPLICATION_RUN_OUTPUT_LIMITS.outputsDefaultItems,
  outputsMaxItems: APPLICATION_RUN_OUTPUT_LIMITS.outputsMaxItems,
  previewDefaultBytes: APPLICATION_RUN_OUTPUT_LIMITS.previewDefaultBytes,
  previewMaxBytes: APPLICATION_RUN_OUTPUT_LIMITS.previewMaxBytes,
  chunkDefaultBytes: APPLICATION_RUN_OUTPUT_LIMITS.chunkDefaultBytes,
  chunkMaxBytes: APPLICATION_RUN_OUTPUT_LIMITS.chunkMaxBytes,
  maxDestinationPathLength: APPLICATION_RUN_OUTPUT_LIMITS.maxDestinationPathLength,
} as const;

export const CLI_RUN_OUTPUT_CATEGORIES = APPLICATION_RUN_OUTPUT_CATEGORIES;

export const CLI_SESSION_MESSAGE_LIMITS = {
  messagesDefaultItems: APPLICATION_SESSION_MESSAGE_LIMITS.messagesDefaultItems,
  messagesMaxItems: APPLICATION_SESSION_MESSAGE_LIMITS.messagesMaxItems,
  chunkMaxBytes: APPLICATION_SESSION_MESSAGE_LIMITS.chunkMaxBytes,
} as const;

export const CLI_SESSION_RUN_LIMITS = {
  runsDefaultItems: APPLICATION_SESSION_RUN_LIMITS.runsDefaultItems,
  runsMaxItems: APPLICATION_SESSION_RUN_LIMITS.runsMaxItems,
  maxSummaryLength: APPLICATION_SESSION_RUN_LIMITS.maxSummaryLength,
} as const;

export type CliExitCode = (typeof CLI_EXIT_CODES)[keyof typeof CLI_EXIT_CODES];

export type CliSessionOperation =
  | "create"
  | "rename"
  | "list"
  | "repositories"
  | "read"
  | "directories-chunk"
  | "messages"
  | "runs"
  | "message-content-chunk"
  | "archive"
  | "unarchive"
  | "close"
  | "delete";

export type CliRunOperation =
  "status" | "events" | "follow" | "output-counts" | "outputs" | "output-preview" | "output-chunk" | "output-export";
export type CliOperation = CliSessionOperation | CliRunOperation;

export type CliCommandIdentity<TOperation extends CliOperation = CliOperation> = TOperation extends CliSessionOperation
  ? Readonly<{ namespace: "session"; operation: TOperation }>
  : TOperation extends CliRunOperation
    ? Readonly<{ namespace: "run"; operation: TOperation }>
    : never;

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

export type CliSessionMessagesCommand = CliTimeoutOption &
  Readonly<{
    identity: CliCommandIdentity<"messages">;
    sessionId: string;
    cursor?: string;
    limit: number;
  }>;

export type CliSessionRunsCommand = CliTimeoutOption &
  Readonly<{
    identity: CliCommandIdentity<"runs">;
    sessionId: string;
    cursor?: string;
    limit: number;
  }>;

export type CliSessionMessageContentChunkCommand = CliTimeoutOption &
  Readonly<{
    identity: CliCommandIdentity<"message-content-chunk">;
    sessionId: string;
    messageId: string;
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

export type CliSessionDeleteCommand = CliTimeoutOption &
  Readonly<{
    identity: CliCommandIdentity<"delete">;
    sessionId: string;
    idempotencyKey: string;
  }>;

export type CliRunStatusCommand = CliTimeoutOption &
  Readonly<{
    identity: CliCommandIdentity<"status">;
    sessionId: string;
    runId: string;
  }>;

export type CliRunEventsCommand = CliTimeoutOption &
  Readonly<{
    identity: CliCommandIdentity<"events">;
    sessionId: string;
    runId: string;
    cursor?: string;
    limit: number;
  }>;

export type CliRunFollowCommand = CliTimeoutOption &
  Readonly<{
    identity: CliCommandIdentity<"follow">;
    sessionId: string;
    runId: string;
    cursor?: string;
    limit: number;
    waitMs: number;
    pollMs: number;
  }>;

type CliRunOutputScopeCommand<TOperation extends CliRunOperation> = CliTimeoutOption &
  Readonly<{
    identity: CliCommandIdentity<TOperation>;
    sessionId: string;
    runId: string;
  }>;

export type CliRunOutputCountsCommand = CliRunOutputScopeCommand<"output-counts">;

export type CliRunOutputsCommand = CliRunOutputScopeCommand<"outputs"> &
  Readonly<{
    category?: (typeof CLI_RUN_OUTPUT_CATEGORIES)[number];
    cursor?: string;
    limit: number;
  }>;

export type CliRunOutputPreviewCommand = CliRunOutputScopeCommand<"output-preview"> &
  Readonly<{ outputItemId: string; maxBytes: number }>;

export type CliRunOutputChunkCommand = CliRunOutputScopeCommand<"output-chunk"> &
  Readonly<{ outputItemId: string; offset: number; maxBytes: number }>;

export type CliRunOutputExportCommand = CliRunOutputScopeCommand<"output-export"> &
  Readonly<{ outputItemId: string; destination: string }>;

export type CliValidatedSessionCommand =
  | CliSessionCreateCommand
  | CliSessionRenameCommand
  | CliSessionListCommand
  | CliLocalRepositoriesCommand
  | CliSessionReadCommand
  | CliSessionDirectoriesChunkCommand
  | CliSessionMessagesCommand
  | CliSessionRunsCommand
  | CliSessionMessageContentChunkCommand
  | CliSessionWriteCommand<"archive">
  | CliSessionWriteCommand<"unarchive">
  | CliSessionCloseCommand
  | CliSessionDeleteCommand;

export type CliValidatedRunCommand =
  | CliRunStatusCommand
  | CliRunEventsCommand
  | CliRunFollowCommand
  | CliRunOutputCountsCommand
  | CliRunOutputsCommand
  | CliRunOutputPreviewCommand
  | CliRunOutputChunkCommand
  | CliRunOutputExportCommand;

export type CliValidatedCommand = CliValidatedSessionCommand | CliValidatedRunCommand;

export type CliHelpTopic =
  | Readonly<{ kind: "root" }>
  | Readonly<{ kind: "session" }>
  | Readonly<{ kind: "run" }>
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

export type CliRunOutputPayloadUnavailableError =
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
      details: Readonly<{ reason: "no_payload" | "size_limit" | "redaction" | "persistence_failure" }>;
    }>;

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
        | Readonly<{ scope: "session_tree"; rootSessionId: string; current: number; limit: number }>
        | Readonly<{ scope: "application"; current: number; limit: number }>
        | Readonly<{ scope: "provider"; providerId: string; current: number; limit: number }>;
    }>
  | CliRunOutputPayloadUnavailableError
  | Readonly<{
      kind: "domain";
      code: "payload_format_unsupported";
      message: string;
      retryable: false;
      details: Readonly<{ format: "binary"; supportedAction: "export" }>;
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
        | "insufficient_disk_space"
        | "idempotency_conflict"
        | "idempotency_in_progress"
        | "idempotency_expired"
        | "identity_exhausted"
        | "destination_exists"
        | "destination_invalid"
        | "payload_integrity_mismatch";
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
  | CliSessionCleanupIssue
  | CliRunOutputExportCleanupIssue
  | CliPersistenceError<"none">
  | CliPersistenceError<"unknown">;

export type CliSessionCleanupIssue = Readonly<{
  kind: "cleanup";
  code: "session_files_cleanup_pending";
  message: string;
  cleanupToken: string;
  retryable: true;
  reconciliation: "exact_request_required";
}>;

export type CliRunOutputExportCleanupIssue = Readonly<{
  kind: "cleanup";
  code: "export_temporary_cleanup_pending";
  message: string;
  retryable: true;
}>;

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

type CliSessionMessageItemBase = Readonly<{
  id: string;
  ordinal: number;
  role: "user" | "assistant";
  contentByteLength: number;
  createdAt: number;
}>;

export type CliSessionMessageItem = CliSessionMessageItemBase &
  (
    | Readonly<{ content: Readonly<{ state: "inline"; blocks: readonly TextContentBlock[] }> }>
    | Readonly<{ content: Readonly<{ state: "chunked"; blocks?: never }> }>
  );

export type CliSessionMessagesValue = Readonly<{
  sessionId: string;
  items: readonly CliSessionMessageItem[];
  nextCursor?: string;
}>;

type CliSessionMessageContentChunkBase = Readonly<{
  sessionId: string;
  messageId: string;
  offset: number;
  totalBytes: number;
  chunk: Readonly<{ encoding: "base64"; byteLength: number; data: string }>;
}>;

export type CliSessionMessageContentChunkValue = CliSessionMessageContentChunkBase &
  (Readonly<{ eof: true; nextOffset?: never }> | Readonly<{ eof: false; nextOffset: number }>);

export type CliSessionTransitionValue<TLifecycleStatus extends "active" | "archived" | "closed"> = Readonly<{
  sessionId: string;
  lifecycleStatus: TLifecycleStatus;
  updatedAt: number;
}>;

export type CliSessionRenameValue = Readonly<{ sessionId: string; title: string; updatedAt: number }>;
type CliSessionDeleteValueBase = Readonly<{
  sessionId: string;
  cleanupToken: string;
  deletedSessionCount: number;
  localOnly: true;
}>;

export type CliSessionDeleteValue =
  | (CliSessionDeleteValueBase & Readonly<{ cleanupStatus: "completed" }>)
  | (CliSessionDeleteValueBase & Readonly<{ cleanupStatus: "pending" }>);

type CliSessionDeleteFailureResponse = Extract<
  CliApplicationResponse<never, "read"> | CliApplicationResponse<never, "write">,
  Readonly<{ overallStatus: "failure" }>
>;

export type CliSessionDeleteResponse =
  | Readonly<{
      overallStatus: "success";
      value: Extract<CliSessionDeleteValue, Readonly<{ cleanupStatus: "completed" }>>;
      persistence: Readonly<{ status: "committed"; effect: "none"; replayed: boolean }>;
    }>
  | Readonly<{
      overallStatus: "partial_success";
      value: Extract<CliSessionDeleteValue, Readonly<{ cleanupStatus: "pending" }>>;
      issues: readonly [CliSessionCleanupIssue];
      persistence: Readonly<{ status: "committed"; effect: "none"; replayed: boolean }>;
    }>
  | CliSessionDeleteFailureResponse;

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

export type CliRunPhase =
  "queued" | "starting" | "active" | "canceling" | "finalizing" | "completed" | "failed" | "canceled" | "interrupted";

export type CliRunLiveActivity = "running" | "waiting_approval" | "waiting_input" | "waiting_child";

export type CliRunFailureSummary = Readonly<{
  origin: "provider" | "transport" | "process" | "application" | "persistence" | "unknown";
  summary?: string;
}>;

export type CliRunCancellationSummary = Readonly<{
  requestedAt: number;
  acknowledgedAt?: number;
}>;

type CliSessionRunItemBase = Readonly<{
  runId: string;
  ordinal: number;
  initiatingMessageId: string;
  finalAssistantMessageId?: string;
  retryOfRunId?: string;
  createdAt: number;
  startedAt?: number;
  updatedAt: number;
}>;

export type CliSessionRunItem =
  | (CliSessionRunItemBase &
      Readonly<{
        phase: "queued" | "starting" | "active" | "finalizing";
        finalAssistantMessageId?: never;
        terminalAt?: never;
        failure?: never;
        cancellation?: never;
      }>)
  | (CliSessionRunItemBase &
      Readonly<{
        phase: "canceling";
        finalAssistantMessageId?: never;
        terminalAt?: never;
        failure?: never;
        cancellation?: CliRunCancellationSummary;
      }>)
  | (CliSessionRunItemBase &
      Readonly<{
        phase: "completed";
        terminalAt: number;
        failure?: never;
        cancellation?: never;
      }>)
  | (CliSessionRunItemBase &
      Readonly<{
        phase: "failed" | "interrupted";
        finalAssistantMessageId?: never;
        terminalAt: number;
        failure: CliRunFailureSummary;
        cancellation?: CliRunCancellationSummary;
      }>)
  | (CliSessionRunItemBase &
      Readonly<{
        phase: "canceled";
        finalAssistantMessageId?: never;
        terminalAt: number;
        failure?: never;
        cancellation?: CliRunCancellationSummary;
      }>);

export type CliSessionRunsValue = Readonly<{
  sessionId: string;
  items: readonly CliSessionRunItem[];
  nextCursor?: string;
}>;

type CliRunStatusBase = Readonly<{
  sessionId: string;
  runId: string;
  retryOfRunId?: string;
  createdAt: number;
  startedAt?: number;
  updatedAt: number;
}>;

type CliRunInactiveStatus = CliRunStatusBase &
  Readonly<{
    phase: "queued" | "starting" | "finalizing";
    liveActivity: null;
    failure?: never;
    cancellation?: never;
    terminalAt?: never;
  }>;

type CliRunActiveStatus = CliRunStatusBase &
  Readonly<{
    phase: "active";
    liveActivity: CliRunLiveActivity | null;
    failure?: never;
    cancellation?: never;
    terminalAt?: never;
  }>;

type CliRunCancelingStatus = CliRunStatusBase &
  Readonly<{
    phase: "canceling";
    liveActivity: null;
    cancellation?: CliRunCancellationSummary;
    failure?: never;
    terminalAt?: never;
  }>;

type CliRunCompletedStatus = CliRunStatusBase &
  Readonly<{
    phase: "completed";
    liveActivity: null;
    terminalAt: number;
    failure?: never;
    cancellation?: never;
  }>;

type CliRunFailedStatus = CliRunStatusBase &
  Readonly<{
    phase: "failed" | "interrupted";
    liveActivity: null;
    terminalAt: number;
    failure: CliRunFailureSummary;
    cancellation?: CliRunCancellationSummary;
  }>;

type CliRunCanceledStatus = CliRunStatusBase &
  Readonly<{
    phase: "canceled";
    liveActivity: null;
    terminalAt: number;
    cancellation?: CliRunCancellationSummary;
    failure?: never;
  }>;

export type CliRunStatusValue =
  | CliRunInactiveStatus
  | CliRunActiveStatus
  | CliRunCancelingStatus
  | CliRunCompletedStatus
  | CliRunFailedStatus
  | CliRunCanceledStatus;

export type CliRunEvent = Readonly<{
  ordinal: number;
  kind: "run_terminal" | "child_result_collected" | "unknown";
  summary?: string;
  createdAt: number;
}>;

export type CliRunEventsValue = Readonly<{
  sessionId: string;
  runId: string;
  items: readonly CliRunEvent[];
  nextCursor: string;
}>;

type CliTerminalRunStatus = Extract<
  CliRunStatusValue,
  Readonly<{ phase: "completed" | "failed" | "canceled" | "interrupted" }>
>;
type CliNonTerminalRunStatus = Exclude<CliRunStatusValue, CliTerminalRunStatus>;

export type CliRunFollowValue =
  | Readonly<{ reason: "events"; status: CliRunStatusValue; events: CliRunEventsValue }>
  | Readonly<{ reason: "terminal"; status: CliTerminalRunStatus; events: CliRunEventsValue }>
  | Readonly<{ reason: "deadline"; status: CliNonTerminalRunStatus; events: CliRunEventsValue }>;

export type CliRunOutputCategory = (typeof CLI_RUN_OUTPUT_CATEGORIES)[number];
export type CliRunOutputRedaction = "not_required" | "applied" | "undetermined";

export type CliRunOutputAvailability =
  | Readonly<{ kind: "none"; redaction: "not_required" }>
  | Readonly<{
      kind: "pending";
      originalByteLength: number;
      redaction: "not_required" | "applied";
    }>
  | Readonly<{
      kind: "stored";
      originalByteLength: number;
      redaction: "not_required" | "applied";
    }>
  | Readonly<{
      kind: "omitted";
      reason: "size_limit" | "persistence_failure";
      originalByteLength: number;
      redaction: "not_required" | "applied";
    }>
  | Readonly<{
      kind: "omitted";
      reason: "redaction";
      originalByteLength: number;
      redaction: "undetermined";
    }>;

export type CliRunOutputItem = Readonly<{
  id: string;
  ordinal: number;
  category: CliRunOutputCategory;
  kind: string;
  summary: string;
  completionState: "complete" | "partial";
  availability: CliRunOutputAvailability;
  createdAt: number;
}>;

export type CliRunOutputCountsValue = Readonly<{
  sessionId: string;
  runId: string;
  totalCount: number;
  partialCount: number;
  byCategory: Readonly<Record<CliRunOutputCategory, number>>;
}>;

export type CliRunOutputsValue = Readonly<{
  sessionId: string;
  runId: string;
  items: readonly CliRunOutputItem[];
  nextCursor?: string;
}>;

type CliRunOutputStoredMetadata = Readonly<{
  sessionId: string;
  runId: string;
  outputItemId: string;
  mediaType?: string;
  storedByteLength: number;
  contentSha256: string;
}>;

export type CliRunOutputPreviewValue =
  | (CliRunOutputStoredMetadata &
      Readonly<{
        format: "text" | "json";
        preview: string;
        previewByteLength: number;
        truncated: boolean;
      }>)
  | (CliRunOutputStoredMetadata & Readonly<{ format: "binary" }>);

type CliRunOutputChunkBase = Readonly<{
  sessionId: string;
  runId: string;
  outputItemId: string;
  format: "text" | "json";
  offset: number;
  totalBytes: number;
  chunk: Readonly<{ encoding: "base64"; byteLength: number; data: string }>;
}>;

export type CliRunOutputChunkValue = CliRunOutputChunkBase &
  (Readonly<{ eof: true; nextOffset?: never }> | Readonly<{ eof: false; nextOffset: number }>);

export type CliRunOutputExportValue = Readonly<{
  sessionId: string;
  runId: string;
  outputItemId: string;
  format: "text" | "json" | "binary";
  storedByteLength: number;
  contentSha256: string;
}>;

export type CliRunOutputPublication =
  | Readonly<{ status: "published" }>
  | Readonly<{ status: "not_published"; temporaryCleanup: "complete" | "pending" }>
  | Readonly<{ status: "unknown"; reconciliation: "inspect_destination_before_retry" }>;

type CliRunOutputExportFailure =
  | Readonly<{
      overallStatus: "failure";
      error: Extract<CliApplicationError, Readonly<{ kind: "request" | "access" | "operation" | "application" }>>;
      publication: Readonly<{ status: "not_published"; temporaryCleanup: "complete" }>;
      persistence: Readonly<{ status: "not_attempted"; effect: "none" }>;
    }>
  | Readonly<{
      overallStatus: "failure";
      error: Extract<CliApplicationError, Readonly<{ code: "payload_unavailable" }>>;
      publication: Readonly<{ status: "not_published"; temporaryCleanup: "complete" }>;
      persistence: Readonly<{ status: "rejected"; effect: "none" }>;
    }>
  | Readonly<{
      overallStatus: "failure";
      error: Readonly<{
        kind: "domain";
        code: "request_invalid" | "cursor_invalid" | "not_found";
        message: string;
        retryable: boolean;
        details?: never;
      }>;
      publication: CliRunOutputFailedPublication;
      persistence: Readonly<{ status: "rejected"; effect: "none" }>;
    }>
  | Readonly<{
      overallStatus: "failure";
      error: CliPersistenceError<"none"> | Extract<CliApplicationError, Readonly<{ kind: "application" }>>;
      publication: CliRunOutputFailedPublication;
      persistence: Readonly<{ status: "failed"; effect: "none" }>;
    }>
  | Readonly<{
      overallStatus: "failure";
      error: Extract<CliApplicationError, Readonly<{ kind: "operation" | "application" }>>;
      publication: CliRunOutputFailedPublication;
      persistence: Readonly<{ status: "read"; effect: "none" }>;
    }>
  | Readonly<{
      overallStatus: "failure";
      error: Readonly<{
        kind: "domain";
        code: "destination_exists" | "destination_invalid" | "payload_integrity_mismatch";
        message: string;
        retryable: false;
        details?: never;
      }>;
      publication: Readonly<{ status: "not_published"; temporaryCleanup: "complete" | "pending" }>;
      persistence: Readonly<{ status: "read"; effect: "none" }>;
    }>;

type CliRunOutputFailedPublication = Exclude<CliRunOutputPublication, Readonly<{ status: "published" }>>;

export type CliRunOutputExportResponse =
  | Readonly<{
      overallStatus: "success";
      value: CliRunOutputExportValue;
      publication: Readonly<{ status: "published" }>;
      persistence: Readonly<{ status: "read"; effect: "none" }>;
    }>
  | Readonly<{
      overallStatus: "partial_success";
      value: CliRunOutputExportValue;
      issues: readonly [CliRunOutputExportCleanupIssue];
      publication: Readonly<{ status: "published" }>;
      persistence: Readonly<{ status: "read"; effect: "none" }>;
    }>
  | CliRunOutputExportFailure;

type CliOperationContract = {
  create: Readonly<{ mode: "write"; value: CliSessionCreateValue }>;
  rename: Readonly<{ mode: "write"; value: CliSessionRenameValue }>;
  list: Readonly<{ mode: "read"; value: CliSessionListValue }>;
  repositories: Readonly<{ mode: "read"; value: CliLocalRepositoryListValue }>;
  read: Readonly<{ mode: "read"; value: CliSessionReadValue }>;
  "directories-chunk": Readonly<{ mode: "read"; value: CliSessionDirectoriesChunkValue }>;
  messages: Readonly<{ mode: "read"; value: CliSessionMessagesValue }>;
  runs: Readonly<{ mode: "read"; value: CliSessionRunsValue }>;
  "message-content-chunk": Readonly<{ mode: "read"; value: CliSessionMessageContentChunkValue }>;
  archive: Readonly<{ mode: "write"; value: CliSessionTransitionValue<"archived"> }>;
  unarchive: Readonly<{ mode: "write"; value: CliSessionTransitionValue<"active"> }>;
  close: Readonly<{ mode: "write"; value: CliSessionTransitionValue<"closed"> }>;
  delete: Readonly<{ mode: "write"; value: CliSessionDeleteValue }>;
};

type CliOperationApplicationResponse<TOperation extends CliSessionOperation> = TOperation extends "delete"
  ? CliSessionDeleteResponse
  : TOperation extends "message-content-chunk"
    ? Exclude<
        CliApplicationResponse<CliOperationContract[TOperation]["value"], "read">,
        Readonly<{ overallStatus: "partial_success" }>
      >
    : CliApplicationResponse<CliOperationContract[TOperation]["value"], CliOperationContract[TOperation]["mode"]>;

export type CliOperationOutput<TOperation extends CliSessionOperation = CliSessionOperation> = {
  [TCurrent in TOperation]: Readonly<{
    schemaVersion: typeof CLI_SCHEMA_VERSION;
    kind: "operation";
    command: CliCommandIdentity<TCurrent>;
    applicationResponse: CliOperationApplicationResponse<TCurrent>;
  }>;
}[TOperation];

type CliRunOperationContract = {
  status: CliRunStatusValue;
  events: CliRunEventsValue;
  follow: CliRunFollowValue;
  "output-counts": CliRunOutputCountsValue;
  outputs: CliRunOutputsValue;
  "output-preview": CliRunOutputPreviewValue;
  "output-chunk": CliRunOutputChunkValue;
  "output-export": CliRunOutputExportValue;
};

type CliRunOperationApplicationResponse<TOperation extends CliRunOperation> = TOperation extends "output-export"
  ? CliRunOutputExportResponse
  : CliApplicationResponse<CliRunOperationContract[TOperation], "read">;

export type CliRunOperationOutput<TOperation extends CliRunOperation = CliRunOperation> = {
  [TCurrent in TOperation]: Readonly<{
    schemaVersion: typeof CLI_SCHEMA_VERSION;
    kind: "operation";
    command: CliCommandIdentity<TCurrent>;
    applicationResponse: CliRunOperationApplicationResponse<TCurrent>;
  }>;
}[TOperation];

export type CliAnyOperationOutput = CliOperationOutput | CliRunOperationOutput;

export type CliRuntimeFailureCode =
  | "bootstrap_failed"
  | "malformed_application_response"
  | "lifecycle_timeout"
  | "lifecycle_canceled"
  | "shutdown_failed"
  | "internal_failure";

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
      code: "lifecycle_timeout" | "lifecycle_canceled";
      stage: "bootstrap" | "operation" | "shutdown";
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

type CliApplicationResponseFor<TOperation extends CliOperation> = TOperation extends CliSessionOperation
  ? CliOperationApplicationResponse<TOperation>
  : TOperation extends CliRunOperation
    ? CliRunOperationApplicationResponse<TOperation>
    : never;

export type CliLifecycleFailureOutput<TOperation extends CliOperation = CliOperation> = TOperation extends CliOperation
  ? Readonly<{
      schemaVersion: typeof CLI_SCHEMA_VERSION;
      kind: "lifecycle_failure";
      command: CliCommandIdentity<TOperation>;
      applicationResponse: CliApplicationResponseFor<TOperation>;
      error: Extract<
        CliRuntimeError,
        Readonly<{ code: "shutdown_failed" | "lifecycle_timeout" | "lifecycle_canceled" }>
      >;
    }>
  : never;

export type CliStructuredOutput =
  | CliUsageFailureOutput
  | CliOperationOutput
  | CliRunOperationOutput
  | CliRuntimeFailureOutput
  | CliLifecycleFailureOutput;

export type CliParseResult =
  | Readonly<{ kind: "command"; command: CliValidatedCommand }>
  | Readonly<{ kind: "help"; topic: CliHelpTopic }>
  | Readonly<{ kind: "version" }>
  | Readonly<{ kind: "usage_failure"; output: CliUsageFailureOutput; exitCode: typeof CLI_EXIT_CODES.usageInvalid }>;
