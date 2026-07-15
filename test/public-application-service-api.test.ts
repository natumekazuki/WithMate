import assert from "node:assert/strict";
import test from "node:test";

import * as publicApi from "../src/main/index.js";
import {
  type ApplicationAccessValidationInput,
  type ApplicationAccessValidator,
  type ApplicationCapacityExceededDetails,
  type ApplicationDomainError,
  type ApplicationDomainErrorCode,
  type ApplicationOperationResponse,
  type ApplicationPersistenceErrorCode,
  type ApplicationSessionCreateRequest,
  type ApplicationSessionLifecycleStatus,
  type ApplicationSessionListItem,
  type ApplicationSessionOperations,
  type ApplicationSessionReadResult,
} from "../src/main/index.js";
import type { SessionDetail, SessionListItem } from "../src/shared/repository-read-model.js";
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

function assertAuthorizationTarget(input: ApplicationAccessValidationInput<Authorization>): void {
  if (input.operation === "create") {
    const directories: readonly string[] = input.target.allowedAdditionalDirectories;
    void directories;
    // @ts-expect-error create authorization does not target an existing Session
    void input.target.sessionId;
    return;
  }
  if (input.operation === "list") {
    const lifecycle = input.target.lifecycleStatus;
    void lifecycle;
    return;
  }
  const sessionId: string = input.target.sessionId;
  void sessionId;
}
void assertAuthorizationTarget;

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

// @ts-expect-error a successful operation cannot have an unknown persistence effect
const invalidSuccessPersistence: ApplicationOperationResponse<string> = {
  overallStatus: "success",
  value: "ok",
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
  value: { sessionId: "session-1", workspaceKey: "workspace-1", lifecycleStatus: "active", createdAt: 1 },
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
  persistence: { status: "failed", effect: "unknown" },
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
void invalidSuccessPersistence;
void invalidRequestFailurePersistence;
void invalidDomainFailurePersistence;
void invalidPersistenceFailureEffect;
void invalidCreateReadSuccess;
void invalidListCommittedSuccess;
void invalidPartialPersistenceEffect;
void invalidWritePartialPersistenceEffect;
void validWritePartialPersistenceEffect;
void validDirectoriesChunk;

test("public Application Service barrel exposes the transport-neutral Session contract", () => {
  const request = null as ApplicationSessionCreateRequest<Authorization> | null;
  const access = null as ApplicationAccessValidator<Authorization> | null;
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
    Equal<ApplicationSessionListItem, SessionListItem>,
    Equal<ApplicationSessionReadResult["session"], SessionDetail>,
    Equal<ApplicationDomainErrorCode, RepositoryCommandErrorCode | "cursor_invalid">,
    Equal<ApplicationSessionLifecycleStatus, SessionLifecycleStatus>,
    Equal<CapacityError["details"], ApplicationCapacityExceededDetails>,
    Equal<CapacityError["retryable"], true>,
  ] = [true, true, true, true, true, true, true, true, true, true, true];

  assert.equal("ApplicationSessionService" in publicApi, false);
  assert.equal(request, null);
  assert.equal(access, null);
  assert.equal(read, null);
  assert.equal(operations, null);
  assert.deepEqual(typeContract, [true, true, true, true, true, true, true, true, true, true, true]);
});
