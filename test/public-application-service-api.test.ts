import assert from "node:assert/strict";
import test from "node:test";

import * as publicApi from "../src/main/index.js";
import type { ApplicationSessionOperations } from "../src/main/index.js";
import {
  type ApplicationCapacityExceededDetails,
  type ApplicationDomainError,
  type ApplicationDomainErrorCode,
  type ApplicationOperationResponse,
  type ApplicationPersistenceErrorCode,
  type ApplicationSessionCreateRequest,
  type ApplicationSessionDeleteResponse,
  type ApplicationSessionLifecycleStatus,
  type ApplicationSessionListItem,
  type ApplicationSessionReadResult,
} from "../src/shared/application-service-model.js";
import type { RepositoryCommandErrorCode, SessionLifecycleStatus } from "../src/shared/repository-write-model.js";

type Equal<TLeft, TRight> = (<T>() => T extends TLeft ? 1 : 2) extends <T>() => T extends TRight ? 1 : 2 ? true : false;
type Authorization = Readonly<{ principalId: string }>;
type ResponseStatus = ApplicationOperationResponse<string>["overallStatus"];
type Failure = Extract<ApplicationOperationResponse<string>, Readonly<{ overallStatus: "failure" }>>;
type Partial = Extract<ApplicationOperationResponse<string>, Readonly<{ overallStatus: "partial_success" }>>;
type OmissionIssue = Extract<Partial["issues"][number], Readonly<{ kind: "omission" }>>;
type PartialPersistenceIssue = Extract<Partial["issues"][number], Readonly<{ kind: "persistence" }>>;
type DomainError = Extract<ApplicationDomainError, Readonly<{ code: ApplicationDomainErrorCode }>>;
type CapacityError = Extract<DomainError, Readonly<{ code: "capacity_exceeded" }>>;
type Operations = ApplicationSessionOperations<Authorization>;
type CreateResponse = Awaited<ReturnType<Operations["create"]>>;
type ListResponse = Awaited<ReturnType<Operations["list"]>>;
type DirectoriesChunkResponse = Awaited<ReturnType<Operations["readDirectoriesChunk"]>>;
type DeleteResponse = Awaited<ReturnType<Operations["delete"]>>;
type DeleteCleanupIssue = Extract<DeleteResponse, Readonly<{ overallStatus: "partial_success" }>>["issues"][number];
const localRepositoryKey = `local-repository-v1-sha256-${"a".repeat(64)}`;

const listItemBase = {
  id: "session-1",
  title: "Session 1",
  workspacePath: "C:\\workspace-1",
  localRepositoryKey: null,
  repositoryName: null,
  defaultCharacterId: "character-1",
  lifecycleStatus: "active" as const,
  createdAt: 1,
  updatedAt: 1,
  lastActivityAt: 1,
  stateChangedAt: 1,
};
// @ts-expect-error not_started cannot expose an active Run
const invalidNotStartedExecution: ApplicationSessionListItem = {
  ...listItemBase,
  executionState: "not_started",
  activeRunId: "run-1",
};
// @ts-expect-error running requires both active and latest Run IDs
const invalidRunningExecution: ApplicationSessionListItem = {
  ...listItemBase,
  executionState: "running",
  activeRunId: "run-1",
};
// @ts-expect-error a terminal execution requires the latest Run ID
const invalidTerminalReadExecution: ApplicationSessionReadResult["execution"] = { state: "completed" };
// @ts-expect-error archived Sessions cannot expose a running execution
const invalidArchivedRunningListItem: ApplicationSessionListItem = {
  ...listItemBase,
  lifecycleStatus: "archived",
  executionState: "running",
  activeRunId: "run-1",
  latestRunId: "run-1",
};
// @ts-expect-error closed Sessions cannot expose a running execution
const invalidClosedRunningRead: ApplicationSessionReadResult = {
  session: {
    id: "session-1",
    title: "Session 1",
    providerId: "codex",
    workspacePath: "C:\\workspace-1",
    localRepositoryKey: null,
    repositoryName: null,
    allowedAdditionalDirectoriesByteLength: 2,
    allowedAdditionalDirectoriesState: "inline",
    defaultCharacterId: "character-1",
    maxConcurrentChildRuns: 2,
    lifecycleStatus: "closed",
    createdAt: 1,
    updatedAt: 1,
    lastActivityAt: 1,
  },
  execution: { state: "running", activeRunId: "run-1", latestRunId: "run-1" },
};
// @ts-expect-error local repository metadata must be both present or both null
const invalidListRepositoryPair: ApplicationSessionListItem = {
  ...listItemBase,
  localRepositoryKey,
  executionState: "not_started",
};
// @ts-expect-error local repository metadata must be both present or both null
const invalidReadRepositoryPair: ApplicationSessionReadResult["session"] = {
  id: "session-1",
  title: "Session 1",
  providerId: "codex",
  workspacePath: "C:\\workspace-1",
  localRepositoryKey,
  repositoryName: null,
  allowedAdditionalDirectoriesByteLength: 2,
  allowedAdditionalDirectoriesState: "inline",
  defaultCharacterId: "character-1",
  maxConcurrentChildRuns: 2,
  lifecycleStatus: "active",
  createdAt: 1,
  updatedAt: 1,
  lastActivityAt: 1,
};
void invalidNotStartedExecution;
void invalidRunningExecution;
void invalidTerminalReadExecution;
void invalidArchivedRunningListItem;
void invalidClosedRunningRead;
void invalidListRepositoryPair;
void invalidReadRepositoryPair;

const capacityDetails: ApplicationCapacityExceededDetails = { scope: "application", current: 1, limit: 1 };

// @ts-expect-error capacity details are invalid for non-capacity domain errors
const invalidDomainError: ApplicationDomainError = {
  kind: "domain",
  code: "session_busy",
  message: "Session is busy.",
  retryable: true,
  details: capacityDetails,
};
void invalidDomainError;

const invalidSuccessPersistence: ApplicationOperationResponse<string> = {
  overallStatus: "success",
  value: "ok",
  // @ts-expect-error a successful operation cannot have an unknown persistence effect
  persistence: { status: "failed", effect: "unknown" },
};
// @ts-expect-error request validation failures happen before persistence access
const invalidRequestFailurePersistence: ApplicationOperationResponse<string> = {
  overallStatus: "failure",
  error: { kind: "request", code: "request_invalid", message: "invalid", retryable: false },
  persistence: { status: "rejected", effect: "none" },
};
// @ts-expect-error domain rejection is not a transport failure
const invalidDomainFailurePersistence: ApplicationOperationResponse<string> = {
  overallStatus: "failure",
  error: { kind: "domain", code: "session_busy", message: "busy", retryable: true },
  persistence: { status: "failed", effect: "none" },
};
// @ts-expect-error persistence error and persistence status must report the same effect
const invalidPersistenceFailureEffect: ApplicationOperationResponse<string> = {
  overallStatus: "failure",
  error: { kind: "persistence", code: "persistence_timeout", message: "timeout", retryable: true, effect: "unknown" },
  persistence: { status: "failed", effect: "none" },
};
const invalidCreateReadSuccess: CreateResponse = {
  overallStatus: "success",
  value: {
    sessionId: "session-1",
    title: "Session 1",
    workspacePath: "C:\\workspace-1",
    localRepositoryKey: null,
    repositoryName: null,
    lifecycleStatus: "active",
    createdAt: 1,
  },
  // @ts-expect-error Session create success must report a committed write
  persistence: { status: "read", effect: "none" },
};
const invalidListCommittedSuccess: ListResponse = {
  overallStatus: "success",
  value: { items: [] },
  // @ts-expect-error Session list success must report a completed read
  persistence: { status: "committed", effect: "none", replayed: false },
};
// @ts-expect-error partial persistence issue and status must report the same failure effect
const invalidPartialPersistenceEffect: ApplicationOperationResponse<string> = {
  overallStatus: "partial_success",
  value: "partial",
  issues: [
    {
      kind: "persistence",
      code: "persistence_timeout",
      message: "timeout",
      retryable: true,
      effect: "unknown",
    },
  ],
  persistence: { status: "committed", effect: "none", replayed: false },
};
// @ts-expect-error write partial success must correlate the issue and persistence effects
const invalidWritePartialPersistenceEffect: ApplicationOperationResponse<string, "write"> = {
  overallStatus: "partial_success",
  value: "partial",
  issues: [
    {
      kind: "persistence",
      code: "persistence_timeout",
      message: "timeout",
      retryable: true,
      effect: "unknown",
    },
  ],
  persistence: { status: "failed", effect: "none" },
};
const validWritePartialPersistenceEffect: ApplicationOperationResponse<string, "write"> = {
  overallStatus: "partial_success",
  value: "partial",
  issues: [
    {
      kind: "persistence",
      code: "persistence_timeout",
      message: "timeout",
      retryable: true,
      effect: "unknown",
    },
  ],
  persistence: { status: "failed", effect: "unknown", reconciliation: "exact_request_required" },
};
const invalidUnknownEffectWithoutReconciliation: ApplicationOperationResponse<string, "write"> = {
  overallStatus: "failure",
  error: {
    kind: "persistence",
    code: "persistence_canceled",
    message: "canceled",
    retryable: false,
    effect: "unknown",
  },
  // @ts-expect-error unknown write effects must tell callers to retry the exact request
  persistence: { status: "failed", effect: "unknown" },
};
const invalidReadInternalFailureEffect: ApplicationOperationResponse<string, "read"> = {
  overallStatus: "failure",
  error: { kind: "application", code: "internal_error", message: "internal", retryable: false },
  // @ts-expect-error read-side internal failures cannot claim an unknown write effect
  persistence: { status: "failed", effect: "unknown", reconciliation: "exact_request_required" },
};
const invalidReadPersistenceFailureEffect: ApplicationOperationResponse<string, "read"> = {
  overallStatus: "failure",
  error: {
    kind: "persistence",
    code: "persistence_timeout",
    message: "timeout",
    retryable: true,
    // @ts-expect-error read persistence errors cannot claim an unknown write effect
    effect: "unknown",
  },
  // @ts-expect-error read persistence status cannot claim an unknown write effect
  persistence: { status: "failed", effect: "unknown", reconciliation: "exact_request_required" },
};
// @ts-expect-error write-side internal failures after persistence starts must preserve an unknown effect
const invalidWriteInternalFailureEffect: ApplicationOperationResponse<string, "write"> = {
  overallStatus: "failure",
  error: { kind: "application", code: "internal_error", message: "internal", retryable: false },
  persistence: { status: "failed", effect: "none" },
};
const validDirectoriesChunk: Extract<DirectoriesChunkResponse, Readonly<{ overallStatus: "success" }>> = {
  overallStatus: "success",
  value: {
    sessionId: "session-1",
    offset: 0,
    totalBytes: 2,
    eof: true,
    bytes: new ArrayBuffer(2),
  },
  persistence: { status: "read", effect: "none" },
};
const validDeletePartial: ApplicationSessionDeleteResponse = {
  overallStatus: "partial_success",
  value: {
    sessionId: "session-1",
    cleanupToken: "018f1f4e-7f0a-7000-8000-000000000001",
    deletedSessionCount: 1,
    localOnly: true,
    cleanupStatus: "pending",
  },
  issues: [
    {
      kind: "cleanup",
      code: "session_files_cleanup_pending",
      message: "cleanup pending",
      cleanupToken: "018f1f4e-7f0a-7000-8000-000000000001",
      retryable: true,
      reconciliation: "exact_request_required",
    },
  ],
  persistence: { status: "committed", effect: "none", replayed: false },
};
const invalidDeleteSuccess: ApplicationSessionDeleteResponse = {
  overallStatus: "success",
  value: {
    sessionId: "session-1",
    cleanupToken: "018f1f4e-7f0a-7000-8000-000000000001",
    deletedSessionCount: 1,
    localOnly: true,
    // @ts-expect-error delete success requires completed cleanup
    cleanupStatus: "pending",
  },
  persistence: { status: "committed", effect: "none", replayed: false },
};
const invalidDeletePartial: ApplicationSessionDeleteResponse = {
  overallStatus: "partial_success",
  value: {
    sessionId: "session-1",
    cleanupToken: "018f1f4e-7f0a-7000-8000-000000000001",
    deletedSessionCount: 1,
    localOnly: true,
    // @ts-expect-error delete partial success requires pending cleanup
    cleanupStatus: "completed",
  },
  issues: validDeletePartial.issues,
  persistence: { status: "committed", effect: "none", replayed: false },
};
void invalidSuccessPersistence;
void invalidRequestFailurePersistence;
void invalidDomainFailurePersistence;
void invalidPersistenceFailureEffect;
void invalidCreateReadSuccess;
void invalidListCommittedSuccess;
void invalidPartialPersistenceEffect;
void invalidWritePartialPersistenceEffect;
void validWritePartialPersistenceEffect;
void invalidUnknownEffectWithoutReconciliation;
void invalidReadInternalFailureEffect;
void invalidReadPersistenceFailureEffect;
void invalidWriteInternalFailureEffect;
void validDirectoriesChunk;
void validDeletePartial;
void invalidDeleteSuccess;
void invalidDeletePartial;

test("public Application Service barrel exposes the transport-neutral Session contract", () => {
  const request = null as ApplicationSessionCreateRequest<Authorization> | null;
  const read = null as ApplicationSessionReadResult | null;
  const operations = null as ApplicationSessionOperations<Authorization> | null;
  const typeContract: readonly [
    Equal<ResponseStatus, "success" | "partial_success" | "failure">,
    Equal<Failure["error"]["kind"], "request" | "access" | "operation" | "domain" | "persistence" | "application">,
    Equal<OmissionIssue["code"], "response_size_limit">,
    Equal<PartialPersistenceIssue["effect"], "none" | "unknown">,
    Equal<
      ApplicationPersistenceErrorCode,
      | "persistence_unavailable"
      | "persistence_busy"
      | "persistence_timeout"
      | "persistence_canceled"
      | "persistence_configuration_invalid"
      | "persistence_integrity_failed"
      | "persistence_response_too_large"
      | "persistence_operation_failed"
    >,
    Equal<
      ApplicationSessionListItem["executionState"],
      "not_started" | "running" | "completed" | "failed" | "canceled" | "interrupted"
    >,
    Equal<"allowedAdditionalDirectories" extends keyof ApplicationSessionReadResult["session"] ? true : false, false>,
    Equal<
      ApplicationDomainErrorCode,
      | RepositoryCommandErrorCode
      | "cursor_invalid"
      | "payload_unavailable"
      | "payload_format_unsupported"
      | "destination_exists"
      | "destination_invalid"
      | "payload_integrity_mismatch"
    >,
    Equal<ApplicationSessionLifecycleStatus, SessionLifecycleStatus>,
    Equal<CapacityError["details"], ApplicationCapacityExceededDetails>,
    Equal<CapacityError["retryable"], true>,
    Equal<DeleteCleanupIssue["kind"], "cleanup">,
  ] = [true, true, true, true, true, true, true, true, true, true, true, true];

  assert.deepEqual(Object.keys(publicApi), []);
  assert.equal(request, null);
  assert.equal(read, null);
  assert.equal(operations, null);
  assert.deepEqual(typeContract, [true, true, true, true, true, true, true, true, true, true, true, true]);
});
