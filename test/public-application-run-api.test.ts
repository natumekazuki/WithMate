import assert from "node:assert/strict";
import test from "node:test";

import * as publicApi from "../src/main/index.js";
import type { ApplicationRunOperations } from "../src/main/index.js";
import type { ApplicationRunFollowResult, ApplicationRunStatus } from "../src/shared/application-run-model.js";

type Authorization = Readonly<{ principalId: string }>;
type Equal<TLeft, TRight> = (<T>() => T extends TLeft ? 1 : 2) extends <T>() => T extends TRight ? 1 : 2 ? true : false;
type Assert<TValue extends true> = TValue;

type StatusRequest = Parameters<ApplicationRunOperations<Authorization>["status"]>[0];
type StatusValue = Awaited<ReturnType<ApplicationRunOperations<Authorization>["status"]>>;
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
    | _ActiveAllowsLiveActivity
    | _CompletedRequiresTerminalTime
    | _DeadlineCannotCarryTerminalStatus
    | null;

  assert.deepEqual(Object.keys(publicApi), []);
  assert.equal(operations, null);
  assert.equal(compileTimeAssertions, null);
});
