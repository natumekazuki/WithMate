import assert from "node:assert/strict";
import test from "node:test";

import * as publicApi from "../src/main/index.js";
import type { ApplicationRunOperations } from "../src/main/index.js";
import type {
  ApplicationRunAdmissionResult,
  ApplicationRunCancelResult,
  ApplicationRunFollowResult,
  ApplicationRunSendInputResult,
  ApplicationRunStatus,
} from "../src/shared/application-run-model.js";

type Authorization = Readonly<{ principalId: string }>;
type Equal<TLeft, TRight> = (<T>() => T extends TLeft ? 1 : 2) extends <T>() => T extends TRight ? 1 : 2 ? true : false;
type Assert<TValue extends true> = TValue;

type StatusRequest = Parameters<ApplicationRunOperations<Authorization>["status"]>[0];
type StatusValue = Awaited<ReturnType<ApplicationRunOperations<Authorization>["status"]>>;
type StartRequest = Parameters<ApplicationRunOperations<Authorization>["start"]>[0];
type RetryRequest = Parameters<ApplicationRunOperations<Authorization>["retry"]>[0];
type SendInputRequest = Parameters<ApplicationRunOperations<Authorization>["sendInput"]>[0];
type CancelRequest = Parameters<ApplicationRunOperations<Authorization>["cancel"]>[0];
type StartValue = Awaited<ReturnType<ApplicationRunOperations<Authorization>["start"]>>;
type _StartOwnsOnlyPublicInputs = Assert<
  Equal<keyof StartRequest, "context" | "sessionId" | "idempotencyKey" | "contentBlocks" | "execution">
>;
type _RetryOwnsOnlyPublicInputs = Assert<
  Equal<keyof RetryRequest, "context" | "sessionId" | "retryOfRunId" | "idempotencyKey" | "executionOverrides">
>;
type _SendInputOwnsOnlyPublicInputs = Assert<
  Equal<keyof SendInputRequest, "context" | "sessionId" | "runId" | "idempotencyKey" | "contentBlocks">
>;
type _SendInputCannotSupplyInternalIdentity = Assert<
  Equal<
    Extract<
      keyof SendInputRequest,
      "messageId" | "attemptId" | "bindingId" | "providerId" | "threadId" | "turnId" | "generationId" | "ownerToken"
    >,
    never
  >
>;
type _CancelOwnsOnlyPublicInputs = Assert<
  Equal<keyof CancelRequest, "context" | "sessionId" | "runId" | "idempotencyKey">
>;
type _CancelCannotSupplyInternalIdentity = Assert<
  Equal<
    Extract<
      keyof CancelRequest,
      "attemptId" | "bindingId" | "providerId" | "threadId" | "turnId" | "generationId" | "ownerToken"
    >,
    never
  >
>;
type _CancelResultUsesStatusPhases = Assert<
  Equal<ApplicationRunCancelResult["phase"], "canceling" | "completed" | "failed" | "canceled" | "interrupted">
>;
type _CancelingRequiresRequestTimestamp = Assert<
  Equal<
    Extract<ApplicationRunCancelResult, Readonly<{ phase: "canceling" }>>["cancellation"],
    Readonly<{ requestedAt: number; acknowledgedAt?: never }>
  >
>;
type _CanceledAcknowledgmentIsPaired = Assert<
  Equal<
    NonNullable<Extract<ApplicationRunCancelResult, Readonly<{ phase: "canceled" }>>["cancellation"]>,
    Readonly<{ requestedAt: number; acknowledgedAt: number }>
  >
>;
type _PendingInputUsesOptionalNeverResolution = Assert<
  Equal<
    keyof Extract<ApplicationRunSendInputResult, Readonly<{ deliveryState: "pending" }>>,
    "sessionId" | "runId" | "messageId" | "deliveryState" | "resolutionCode"
  >
>;
type _RejectedInputUsesBoundedResolution = Assert<
  Equal<
    Extract<ApplicationRunSendInputResult, Readonly<{ deliveryState: "rejected" }>>["resolutionCode"],
    "provider_rejected" | "delivery_not_sent"
  >
>;
type _StartCannotSupplyScopeOrInternalIdentity = Assert<
  Equal<
    Extract<
      keyof StartRequest,
      "providerId" | "workspaceKey" | "workspacePath" | "attemptId" | "bindingId" | "threadId" | "turnId"
    >,
    never
  >
>;
type _AdmissionResultCannotExposeInternalIdentity = Assert<
  Equal<keyof ApplicationRunAdmissionResult, "sessionId" | "runId" | "retryOfRunId" | "phase">
>;
type _StartUsesWriteEnvelope = Assert<Equal<StartValue["overallStatus"], "success" | "partial_success" | "failure">>;
type _StatusRequestOwnsRunScope = Assert<
  Equal<Pick<StatusRequest, "sessionId" | "runId">, Readonly<{ sessionId: string; runId: string }>>
>;
type _StatusResponseUsesApplicationEnvelope = Assert<
  Equal<StatusValue["overallStatus"], "success" | "partial_success" | "failure">
>;
type _ActiveAllowsLiveActivity = Assert<
  Equal<
    Extract<ApplicationRunStatus, Readonly<{ phase: "active" }>>["liveActivity"],
    "running" | "waiting_approval" | "waiting_input" | "waiting_child" | null
  >
>;
type _CompletedRequiresTerminalTime = Assert<
  Equal<Extract<ApplicationRunStatus, Readonly<{ phase: "completed" }>>["terminalAt"], number>
>;
type _DeadlineCannotCarryTerminalStatus = Assert<
  Equal<
    Extract<
      Extract<ApplicationRunFollowResult, Readonly<{ reason: "deadline" }>>["status"],
      Readonly<{ phase: "completed" }>
    >,
    never
  >
>;

test("public Run API is type-only and keeps phase-specific status contracts", () => {
  const operations = null as ApplicationRunOperations<Authorization> | null;
  const compileTimeAssertions = null as
    | _StatusRequestOwnsRunScope
    | _StatusResponseUsesApplicationEnvelope
    | _StartOwnsOnlyPublicInputs
    | _RetryOwnsOnlyPublicInputs
    | _SendInputOwnsOnlyPublicInputs
    | _SendInputCannotSupplyInternalIdentity
    | _CancelOwnsOnlyPublicInputs
    | _CancelCannotSupplyInternalIdentity
    | _CancelResultUsesStatusPhases
    | _CancelingRequiresRequestTimestamp
    | _CanceledAcknowledgmentIsPaired
    | _PendingInputUsesOptionalNeverResolution
    | _RejectedInputUsesBoundedResolution
    | _StartCannotSupplyScopeOrInternalIdentity
    | _AdmissionResultCannotExposeInternalIdentity
    | _StartUsesWriteEnvelope
    | _ActiveAllowsLiveActivity
    | _CompletedRequiresTerminalTime
    | _DeadlineCannotCarryTerminalStatus
    | null;

  assert.deepEqual(Object.keys(publicApi), []);
  assert.equal(operations, null);
  assert.equal(compileTimeAssertions, null);
});
