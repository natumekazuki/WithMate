import assert from "node:assert/strict";
import test from "node:test";

import * as publicApi from "../src/main/index.js";
import {
  PERSISTENCE_PROTOCOL_VERSION,
  type ApplicationSessionOperations,
  type PersistenceError,
  type RecoveryProjection,
  type RunOutputCategory,
  type SessionExecutionState,
  type SessionLifecycleStatus,
} from "../src/main/index.js";

type Equal<TLeft, TRight> = (<T>() => T extends TLeft ? 1 : 2) extends <T>() => T extends TRight ? 1 : 2 ? true : false;
type Authorization = Readonly<{ principalId: string }>;

type SessionListInput = Parameters<ApplicationSessionOperations<Authorization>["list"]>[0];
type SessionReadResponse = Awaited<ReturnType<ApplicationSessionOperations<Authorization>["read"]>>;
type SessionReadSuccess = Extract<SessionReadResponse, Readonly<{ overallStatus: "success" }>>;
type SessionGetState = SessionReadSuccess["value"]["execution"]["state"];

test("public barrel exposes Application read contracts without Repository clients", () => {
  const transportError: PersistenceError = {
    code: "request_timeout",
    message: "timed out",
    retryable: false,
    effect: "unknown",
  };
  const recovery = null as RecoveryProjection | null;
  const typeContract: readonly [
    Equal<SessionListInput["lifecycleStatus"], SessionLifecycleStatus | undefined>,
    Equal<
      RunOutputCategory,
      "assistant_detail" | "operation" | "interaction" | "telemetry" | "diagnostic" | "provider_metadata"
    >,
    Equal<SessionGetState, SessionExecutionState>,
  ] = [true, true, true];

  assert.equal(PERSISTENCE_PROTOCOL_VERSION, 1);
  assert.equal("RepositoryReadClient" in publicApi, false);
  assert.equal("PersistenceWorkerClient" in publicApi, false);
  assert.equal("RepositoryWriteClient" in publicApi, false);
  assert.equal(transportError.effect, "unknown");
  assert.equal(recovery, null);
  assert.deepEqual(typeContract, [true, true, true]);
});
