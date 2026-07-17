import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_PERSISTENCE_RESPONSE_BYTES,
  PERSISTENCE_PROTOCOL_VERSION,
  REPOSITORY_CHUNK_LIMITS,
  RepositoryReadClient,
  RepositoryWriteClient,
  type PersistenceError,
  type RecoveryProjection,
  type RepositoryCommandError,
  type RunOutputCategory,
  type RunTerminalPreDispatchResolution,
  type SessionExecutionState,
  type SessionLifecycleStatus,
  type StartupRepairCommand,
  type StartupRepairResult,
} from "../src/main/index.js";

type Equal<TLeft, TRight> = (<T>() => T extends TLeft ? 1 : 2) extends <T>() => T extends TRight ? 1 : 2 ? true : false;

type SessionsPageInput = Parameters<RepositoryReadClient["sessionsPage"]>[0];
type RunOutputsPageInput = Parameters<RepositoryReadClient["runOutputsPage"]>[0];
type SessionGetState = Awaited<ReturnType<RepositoryReadClient["sessionGet"]>>["execution"]["state"];

test("public repository barrel exposes the CP2 repository and error contract", () => {
  const transportError: PersistenceError = {
    code: "request_timeout",
    message: "timed out",
    retryable: false,
    effect: "unknown",
  };
  const domainError: RepositoryCommandError = {
    code: "not_found",
    message: "not found",
    retryable: false,
  };
  const repairCommand: StartupRepairCommand = {};
  const repairResult = null as StartupRepairResult | null;
  const recovery = null as RecoveryProjection | null;
  const terminalPreparation: RunTerminalPreDispatchResolution = { kind: "dispatch_not_sent" };
  const typeContract: readonly [
    Equal<SessionsPageInput["lifecycleStatus"], SessionLifecycleStatus | undefined>,
    Equal<RunOutputsPageInput["category"], RunOutputCategory | undefined>,
    Equal<SessionGetState, SessionExecutionState>,
  ] = [true, true, true];

  assert.equal(PERSISTENCE_PROTOCOL_VERSION, 1);
  assert.equal(MAX_PERSISTENCE_RESPONSE_BYTES, 256 * 1024);
  assert.deepEqual(REPOSITORY_CHUNK_LIMITS, { maxRequestedBytes: 256 * 1024, maxScopeStringLength: 1_024 });
  assert.equal(typeof RepositoryReadClient, "function");
  assert.equal(typeof RepositoryWriteClient, "function");
  assert.equal(transportError.effect, "unknown");
  assert.equal(domainError.code, "not_found");
  assert.deepEqual(repairCommand, {});
  assert.equal(repairResult, null);
  assert.equal(recovery, null);
  assert.equal(terminalPreparation.kind, "dispatch_not_sent");
  assert.deepEqual(typeContract, [true, true, true]);
});
