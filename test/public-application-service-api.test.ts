import assert from "node:assert/strict";
import test from "node:test";

import * as publicApi from "../src/main/index.js";
import {
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

test("public Application Service barrel exposes the transport-neutral Session contract", () => {
  const request = null as ApplicationSessionCreateRequest<Authorization> | null;
  const access = null as ApplicationAccessValidator<Authorization> | null;
  const read = null as ApplicationSessionReadResult | null;
  const operations = null as ApplicationSessionOperations<Authorization> | null;
  const typeContract: readonly [
    Equal<ResponseStatus, "success" | "partial_success" | "failure">,
    Equal<Failure["error"]["kind"], "request" | "access" | "domain" | "persistence" | "application">,
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
