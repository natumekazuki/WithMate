import assert from "node:assert/strict";
import test from "node:test";

import * as publicApi from "../src/main/index.js";
import {
  PERSISTENCE_PROTOCOL_VERSION,
  RepositoryReadClient,
  type PersistenceError,
  type RecoveryProjection,
  type RunOutputCategory,
  type SessionExecutionState,
  type SessionLifecycleStatus,
} from "../src/main/index.js";

type Equal<TLeft, TRight> = (<T>() => T extends TLeft ? 1 : 2) extends <T>() => T extends TRight ? 1 : 2 ? true : false;

type SessionsPageInput = Parameters<RepositoryReadClient["sessionsPage"]>[0];
type RunOutputsPageInput = Parameters<RepositoryReadClient["runOutputsPage"]>[0];
type SessionGetState = Awaited<ReturnType<RepositoryReadClient["sessionGet"]>>["execution"]["state"];

test("public barrel exposes read infrastructure without Repository write construction", () => {
  const transportError: PersistenceError = {
    code: "request_timeout",
    message: "timed out",
    retryable: false,
    effect: "unknown",
  };
  const recovery = null as RecoveryProjection | null;
  const typeContract: readonly [
    Equal<SessionsPageInput["lifecycleStatus"], SessionLifecycleStatus | undefined>,
    Equal<RunOutputsPageInput["category"], RunOutputCategory | undefined>,
    Equal<SessionGetState, SessionExecutionState>,
  ] = [true, true, true];

  assert.equal(PERSISTENCE_PROTOCOL_VERSION, 1);
  assert.equal(typeof RepositoryReadClient, "function");
  assert.equal("RepositoryWriteClient" in publicApi, false);
  assert.equal(transportError.effect, "unknown");
  assert.equal(recovery, null);
  assert.deepEqual(typeContract, [true, true, true]);
});
