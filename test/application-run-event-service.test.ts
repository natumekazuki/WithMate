import assert from "node:assert/strict";
import test from "node:test";

import {
  ApplicationRunEventService,
  type ApplicationRunEventReadPort,
  type ApplicationRunEventWritePort,
} from "../src/main/application-run-event-service.js";
import { ApplicationRunDispatchService } from "../src/main/application-run-dispatch-service.js";
import {
  APPLICATION_RUN_INTERACTION_LIMITS,
  ApplicationRunInteractionState,
} from "../src/main/application-run-interaction-state.js";
import type {
  ApplicationRunBindingOwnership,
  ApplicationRunDispatchControl,
  ApplicationRunPreparedDispatch,
  ApplicationRunProviderAdapterPort,
  ApplicationRunProviderInteractionHandle,
  ApplicationRunProviderInteractionResponse,
  ApplicationRunProviderInteractionResponseReservation,
  ApplicationRunProviderInteractionResponseResult,
} from "../src/main/application-run-runtime-service.js";
import { PersistenceClientError } from "../src/main/persistence-worker-client.js";
import type {
  CodexAdapterInteractionKind,
  CodexAdapterServerRequestPort,
  CodexAdapterEvent,
} from "../src/main/providers/codex/index.js";
import { CodexAdapterInteractionManager } from "../src/main/providers/codex/codex-adapter-interactions.js";
import type { CodexServerRequestIdentity } from "../src/main/providers/codex/protocol-session.js";
import type {
  RunDispatchResolutionCommand,
  RunInputBeginCommand,
  RunInputResolutionCommand,
  RunInteractionResponseAdmissionCommand,
  RunInteractionResponseMarkWriteAttemptCommand,
  RunInteractionResponseResult,
  RunInteractionResponseSettlementCommand,
  RunOutputAppendCommand,
  RunTerminalCommand,
} from "../src/shared/repository-write-model.js";

test("pending interactions stay provisional until durable acceptance and activity priority is computed", async () => {
  const fixture = eventFixture();
  const attempt = fixture.service.register(dispatch(), fixture.control);
  assert.ok(attempt);
  const approval = pendingInteraction(interactionHandle(), "approval-1", "codex.command_approval");
  await fixture.service.accept("codex-1", approval);
  assert.equal(await fixture.service.readInteractions({ sessionId: "session-1", runId: "run-1", runVersion: 7 }), null);

  await attempt.settleStartTurn(acceptedTurn("turn-1"));
  const active = await fixture.service.readInteractions({ sessionId: "session-1", runId: "run-1", runVersion: 7 });
  assert.deepEqual(active, {
    sessionId: "session-1",
    runId: "run-1",
    runVersion: 7,
    interactions: [approval.snapshot],
  });
  assert.equal(JSON.stringify(active).includes("handle"), false);
  assert.equal(JSON.stringify(active).includes("connectionGeneration"), false);
  assert.equal(await fixture.service.readInteractions({ sessionId: "session-1", runId: "run-1", runVersion: 6 }), null);
  assert.equal((await fixture.service.read({ sessionId: "session-1", runId: "run-1" }))?.activity, "waiting_approval");

  const input = pendingInteraction(interactionHandle(), "input-1", "codex.user_input", false);
  await fixture.service.accept("codex-1", input);
  assert.equal((await fixture.service.read({ sessionId: "session-1", runId: "run-1" }))?.activity, "waiting_input");
  await fixture.service.accept("codex-1", turnStarted("turn-1"));
  assert.equal((await fixture.service.read({ sessionId: "session-1", runId: "run-1" }))?.activity, "waiting_input");

  await fixture.service.accept("codex-1", {
    kind: "interaction_resolved",
    handle: input.handle,
    owner: input.owner,
  });
  assert.equal((await fixture.service.read({ sessionId: "session-1", runId: "run-1" }))?.activity, "waiting_approval");
  await fixture.service.accept("codex-1", {
    kind: "interaction_resolved",
    handle: approval.handle,
    owner: approval.owner,
  });
  assert.equal((await fixture.service.read({ sessionId: "session-1", runId: "run-1" }))?.activity, "running");
});

test("interaction reads require the current runtime generation owner", async () => {
  let current = true;
  const fixture = eventFixture({ isCurrent: () => current });
  const attempt = fixture.service.register(dispatch(), fixture.control);
  assert.ok(attempt);
  await attempt.settleStartTurn(acceptedTurn("turn-1"));
  await fixture.service.accept(
    "codex-1",
    pendingInteraction(interactionHandle(), "approval-1", "codex.command_approval"),
  );
  current = false;
  assert.equal(await fixture.service.readInteractions({ sessionId: "session-1", runId: "run-1", runVersion: 7 }), null);
});

test("read ignores pending interaction-derived activity when runtime generation is not current", async () => {
  let current = true;
  const fixture = eventFixture({ isCurrent: () => current });
  const attempt = fixture.service.register(dispatch(), fixture.control);
  assert.ok(attempt);
  await attempt.settleStartTurn(acceptedTurn("turn-1"));
  await fixture.service.accept(
    "codex-1",
    pendingInteraction(interactionHandle(), "approval-1", "codex.command_approval"),
  );
  assert.equal((await fixture.service.read({ sessionId: "session-1", runId: "run-1" }))?.activity, "waiting_approval");
  current = false;
  assert.equal((await fixture.service.read({ sessionId: "session-1", runId: "run-1" }))?.activity, "running");
});

test("interaction response consumes the live handle synchronously and settles without holding the Attempt chain", async () => {
  let resolveProvider!: (result: ApplicationRunProviderInteractionResponseResult) => void;
  const providerSettlement = new Promise<ApplicationRunProviderInteractionResponseResult>((resolve) => {
    resolveProvider = resolve;
  });
  let consumed = false;
  const fixture = eventFixture({
    respondOperation(handle) {
      assert.equal(handle, pending.handle);
      consumed = true;
      return providerSettlement;
    },
  });
  const attempt = fixture.service.register(dispatch(), fixture.control);
  assert.ok(attempt);
  await attempt.settleStartTurn(acceptedTurn("turn-1"));
  const pending = pendingInteraction(interactionHandle(), "approval-response-1", "codex.command_approval");
  await fixture.service.accept("codex-1", pending);

  const response = fixture.service.respond(interactionResponseInput("approval-response-1"));
  await waitFor(() => consumed);
  assert.equal(fixture.interactionResponses.length, 1);
  assert.equal(await isSettled(response.then(() => undefined)), false);
  assert.equal(
    (await fixture.service.readInteractions({ sessionId: "session-1", runId: "run-1", runVersion: 7 }))?.interactions[0]
      ?.answerable,
    false,
  );

  const cancel = await fixture.service.cancelOwner.preflight({ sessionId: "session-1", runId: "run-1" });
  assert.equal(cancel.ok, true);
  if (cancel.ok && cancel.value.kind === "active_execution")
    fixture.service.cancelOwner.release(cancel.value.reservation);

  resolveProvider({ kind: "write_attempted", effect: "unknown", providerResolution: "resolved" });
  const result = await response;
  assert.equal(result.ok && result.value.effectCertainty, "resolved");
  assert.equal(fixture.interactionSettlements.length, 1);
});

test("interaction response reserves synchronously before resolved or terminal evidence can retire its handle", async () => {
  for (const evidence of ["resolved", "terminal"] as const) {
    let releaseAdmission!: () => void;
    const admissionGate = new Promise<void>((resolve) => {
      releaseAdmission = resolve;
    });
    const fixture = eventFixture({ interactionAdmissionGate: admissionGate });
    const attempt = fixture.service.register(dispatch(), fixture.control);
    assert.ok(attempt);
    await attempt.settleStartTurn(acceptedTurn("turn-1"));
    const pending = pendingInteraction(
      interactionHandle(),
      `approval-reservation-${evidence}`,
      "codex.command_approval",
    );
    await fixture.service.accept("codex-1", pending);

    const response = fixture.service.respond(interactionResponseInput(pending.snapshot.interactionId));
    assert.equal(fixture.reservedInteractionHandles.length, 1);
    assert.equal(fixture.interactionResponses.length, 0);
    const laterEvidence =
      evidence === "resolved"
        ? fixture.service.accept("codex-1", {
            kind: "interaction_resolved",
            handle: pending.handle,
            owner: pending.owner,
          })
        : fixture.service.accept("codex-1", {
            kind: "turn_terminal",
            threadId: "thread-1",
            turnId: "turn-1",
            status: "completed",
            finalAssistantMessage: null,
            contentFailure: null,
          });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(fixture.interactionResponses.length, 0);

    releaseAdmission();
    const result = await response;
    await laterEvidence;
    assert.equal(result.ok && result.value.effectCertainty, evidence === "resolved" ? "resolved" : "ambiguous");
    assert.equal(fixture.interactionResponses.length, 1);
  }
});

test("Application response ownership keeps a real Codex reservation through early resolved evidence", async () => {
  let releaseAdmission!: () => void;
  const admissionGate = new Promise<void>((resolve) => {
    releaseAdmission = resolve;
  });
  const manager = new CodexAdapterInteractionManager();
  const providerResponses: unknown[] = [];
  const request: CodexAdapterServerRequestPort = {
    identity: Object.freeze(Object.create(null)) as CodexServerRequestIdentity,
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      startedAtMs: 1,
      command: "npm test",
      cwd: process.cwd(),
    },
    async respond(result) {
      providerResponses.push(result);
    },
  };
  const admission = manager.admit(
    request,
    process.cwd(),
    (threadId, turnId) => threadId === "thread-1" && turnId === "turn-1",
  );
  assert.ok(admission.event);
  const fixture = eventFixture({
    interactionAdmissionGate: admissionGate,
    interactionAdapter: {
      reserveInteractionResponse: (handle, response) => manager.reserve(handle, response),
      writeReservedInteractionResponse: (reservation) => manager.writeReserved(reservation),
      releaseInteractionResponseReservation: (reservation) => manager.releaseReservation(reservation),
    },
  });
  const attempt = fixture.service.register(dispatch(), fixture.control);
  assert.ok(attempt);
  await attempt.settleStartTurn(acceptedTurn("turn-1"));
  await fixture.service.accept("codex-1", admission.event);

  const response = fixture.service.respond(interactionResponseInput(admission.event.snapshot.interactionId));
  assert.equal(fixture.reservedInteractionHandles.length, 1);
  const resolution = manager.resolve(request.identity, "thread-1");
  assert.equal(resolution.kind, "resolved");
  assert.equal(providerResponses.length, 0);
  const resolvedEvidence =
    resolution.kind === "resolved" ? fixture.service.accept("codex-1", resolution.event) : Promise.resolve();

  releaseAdmission();
  const result = await response;
  await resolvedEvidence;
  assert.equal(result.ok && result.value.effectCertainty, "resolved");
  assert.equal(providerResponses.length, 1);
});

test("fail-closed admission retains a real Codex reservation through one interrupt and release retry", async () => {
  const manager = new CodexAdapterInteractionManager();
  const providerResponses: unknown[] = [];
  const request: CodexAdapterServerRequestPort = {
    identity: Object.freeze(Object.create(null)) as CodexServerRequestIdentity,
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-fail-closed",
      startedAtMs: 1,
      command: "npm test",
      cwd: process.cwd(),
    },
    async respond(result) {
      providerResponses.push(result);
    },
  };
  const admission = manager.admit(
    request,
    process.cwd(),
    (threadId, turnId) => threadId === "thread-1" && turnId === "turn-1",
  );
  assert.ok(admission.event);
  let releaseCalls = 0;
  const fixture = eventFixture({
    interactionAdmissionErrorSequence: ["nonretryable_none"],
    terminalUnknownOnce: true,
    interactionAdapter: {
      reserveInteractionResponse: (handle, response) => manager.reserve(handle, response),
      writeReservedInteractionResponse: (reservation) => manager.writeReserved(reservation),
      releaseInteractionResponseReservation(reservation) {
        releaseCalls += 1;
        if (releaseCalls === 1) throw new Error("release unavailable");
        manager.releaseReservation(reservation);
      },
    },
  });
  const attempt = fixture.service.register(dispatch(), fixture.control);
  assert.ok(attempt);
  await attempt.settleStartTurn(acceptedTurn("turn-1"));
  await fixture.service.accept("codex-1", admission.event);

  const result = await fixture.service.respond(interactionResponseInput(admission.event.snapshot.interactionId));
  await attempt.done;

  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.error.retryable, false);
  assert.equal(fixture.interactionAdmissions.length, 1);
  assert.equal(fixture.interactionWriteMarks.length, 0);
  assert.equal(fixture.interactionResponses.length, 0);
  assert.equal(providerResponses.length, 0);
  assert.equal(fixture.interruptInputs.length, 1);
  assert.equal(releaseCalls, 2);
  assert.equal(manager.reserve(admission.event.handle, { decision: "accept" }).kind, "not_reserved");
  assert.equal(await fixture.service.readInteractions({ sessionId: "session-1", runId: "run-1", runVersion: 7 }), null);
  assert.equal(await fixture.service.read({ sessionId: "session-1", runId: "run-1" }), null);
  assert.equal(fixture.terminals.length, 2);
  assert.equal(fixture.terminals[0], fixture.terminals[1]);
  assert.deepEqual(fixture.terminals[0]?.outcome, {
    kind: "interrupted",
    failureOrigin: "application",
    providerErrorCode: null,
    errorSummary: "Interaction response persistence could not safely admit the Provider response.",
  });
  assert.deepEqual(fixture.terminals[0]?.cancelCorrelation, { kind: "none" });
});

test("interaction response exact-retries frozen admission and write marker after commit response loss", async () => {
  const fixture = eventFixture({
    interactionAdmissionUnknownAfterCommitCount: 1,
    interactionMarkUnknownAfterCommitCount: 1,
  });
  const attempt = fixture.service.register(dispatch(), fixture.control);
  assert.ok(attempt);
  await attempt.settleStartTurn(acceptedTurn("turn-1"));
  await fixture.service.accept(
    "codex-1",
    pendingInteraction(interactionHandle(), "approval-frozen-commands", "codex.command_approval"),
  );

  const response = await fixture.service.respond(interactionResponseInput("approval-frozen-commands"));
  assert.equal(response.ok && response.value.effectCertainty, "resolved");
  assert.equal(fixture.interactionAdmissions.length, 2);
  assert.equal(fixture.interactionAdmissions[0], fixture.interactionAdmissions[1]);
  assert.equal(fixture.interactionWriteMarks.length, 2);
  assert.equal(fixture.interactionWriteMarks[0], fixture.interactionWriteMarks[1]);
  assert.equal(fixture.interactionResponses.length, 1);
});

test("retryable no-effect admission failure retains the reservation and retryability for an exact same-key retry", async () => {
  const fixture = eventFixture({ interactionAdmissionErrorSequence: ["none"] });
  const attempt = fixture.service.register(dispatch(), fixture.control);
  assert.ok(attempt);
  await attempt.settleStartTurn(acceptedTurn("turn-1"));
  await fixture.service.accept(
    "codex-1",
    pendingInteraction(interactionHandle(), "approval-admission-none", "codex.command_approval"),
  );

  const input = interactionResponseInput("approval-admission-none");
  const first = await fixture.service.respond(input);
  assert.equal(first.ok, false);
  assert.equal(!first.ok && first.error.retryable, true);
  assert.equal(fixture.reservedInteractionHandles.length, 1);
  assert.equal(fixture.interactionResponses.length, 0);
  assert.equal(fixture.interactionWriteMarks.length, 0);

  const retry = await fixture.service.respond(input);
  assert.equal(retry.ok && retry.value.effectCertainty, "resolved");
  assert.equal(fixture.reservedInteractionHandles.length, 1);
  assert.equal(fixture.releasedInteractionReservations.length, 0);
  assert.equal(fixture.interactionResponses.length, 1);
  assert.equal(fixture.interactionWriteMarks.length, 1);
});

test("nonretryable no-effect admission failure remains nonretryable and releases its reservation", async () => {
  const fixture = eventFixture({ interactionAdmissionErrorSequence: ["nonretryable_none"] });
  const attempt = fixture.service.register(dispatch(), fixture.control);
  assert.ok(attempt);
  await attempt.settleStartTurn(acceptedTurn("turn-1"));
  await fixture.service.accept(
    "codex-1",
    pendingInteraction(interactionHandle(), "approval-admission-nonretryable", "codex.command_approval"),
  );

  const result = await fixture.service.respond(interactionResponseInput("approval-admission-nonretryable"));
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.error.retryable, false);
  assert.equal(fixture.reservedInteractionHandles.length, 1);
  assert.equal(fixture.releasedInteractionReservations.length, 1);
  assert.equal(fixture.interactionResponses.length, 0);
  assert.equal(fixture.interactionWriteMarks.length, 0);
  assert.equal(fixture.interruptInputs.length, 1);
  assert.equal(fixture.terminals[0]?.outcome.kind, "interrupted");
  assert.equal(
    fixture.terminals[0]?.outcome.kind === "interrupted" && fixture.terminals[0].outcome.failureOrigin,
    "application",
  );
});

test("nonretryable admission result and durable pre-write settlement both fail closed without Provider response", async () => {
  const admissionRejected = eventFixture({
    interactionAdmissionOperation: async () => ({
      ok: false,
      replayed: false,
      error: {
        code: "lifecycle_conflict",
        message: "interaction admission was rejected",
        retryable: false,
      },
    }),
  });
  const rejectedAttempt = admissionRejected.service.register(dispatch(), admissionRejected.control);
  assert.ok(rejectedAttempt);
  await rejectedAttempt.settleStartTurn(acceptedTurn("turn-1"));
  await admissionRejected.service.accept(
    "codex-1",
    pendingInteraction(interactionHandle(), "approval-admission-rejected", "codex.command_approval"),
  );

  const rejected = await admissionRejected.service.respond(interactionResponseInput("approval-admission-rejected"));
  await rejectedAttempt.done;
  assert.equal(rejected.ok, false);
  assert.equal(admissionRejected.interactionAdmissions.length, 1);
  assert.equal(admissionRejected.interactionResponses.length, 0);
  assert.equal(admissionRejected.interruptInputs.length, 1);
  assert.equal(admissionRejected.terminals[0]?.outcome.kind, "interrupted");

  const markerRejected = eventFixture({ interactionMarkErrorSequence: ["none"] });
  const markerAttempt = markerRejected.service.register(dispatch(), markerRejected.control);
  assert.ok(markerAttempt);
  await markerAttempt.settleStartTurn(acceptedTurn("turn-1"));
  await markerRejected.service.accept(
    "codex-1",
    pendingInteraction(interactionHandle(), "approval-marker-rejected", "codex.command_approval"),
  );

  const settled = await markerRejected.service.respond(interactionResponseInput("approval-marker-rejected"));
  await markerAttempt.done;
  assert.equal(settled.ok && settled.value.effectCertainty, "not_sent");
  assert.equal(markerRejected.interactionAdmissions.length, 1);
  assert.equal(markerRejected.interactionWriteMarks.length, 1);
  assert.equal(markerRejected.interactionSettlements.length, 1);
  assert.equal(markerRejected.interactionResponses.length, 0);
  assert.equal(markerRejected.interruptInputs.length, 1);
  assert.equal(markerRejected.terminals[0]?.outcome.kind, "interrupted");
});

test("fail-closed pre-write settlement automatically retries one frozen retryable command", async () => {
  let releaseSecondSettlement!: () => void;
  const secondSettlementGate = new Promise<void>((resolve) => {
    releaseSecondSettlement = resolve;
  });
  const fixture = eventFixture({
    interactionMarkErrorSequence: ["none"],
    interactionSettlementErrorSequence: ["none"],
    beforeInteractionSettlement: (_command, call) => (call === 2 ? secondSettlementGate : undefined),
  });
  const attempt = fixture.service.register(dispatch(), fixture.control);
  assert.ok(attempt);
  await attempt.settleStartTurn(acceptedTurn("turn-1"));
  await fixture.service.accept(
    "codex-1",
    pendingInteraction(interactionHandle(), "approval-settlement-retryable", "codex.command_approval"),
  );

  const response = fixture.service.respond(interactionResponseInput("approval-settlement-retryable"));
  await waitFor(() => fixture.interactionSettlements.length === 2);
  assert.equal(await isSettled(response.then(() => undefined)), false);
  assert.equal(fixture.interactionResponses.length, 0);
  assert.equal(fixture.releasedInteractionReservations.length, 0);
  assert.equal(fixture.terminals.length, 0);

  releaseSecondSettlement();
  const result = await response;
  await attempt.done;
  assert.equal(result.ok && result.value.effectCertainty, "not_sent");
  assert.equal(fixture.interactionSettlements.length, 2);
  assert.equal(fixture.interactionSettlements[0], fixture.interactionSettlements[1]);
  assert.equal(fixture.interactionResponses.length, 0);
  assert.equal(fixture.releasedInteractionReservations.length, 1);
  assert.equal(fixture.interruptInputs.length, 1);
  assert.equal(fixture.terminals.length, 1);
});

test("deterministic nonretryable settlement failure closes the Attempt without Provider response", async () => {
  const fixture = eventFixture({
    interactionMarkErrorSequence: ["none"],
    interactionSettlementErrorSequence: ["nonretryable_none"],
  });
  const attempt = fixture.service.register(dispatch(), fixture.control);
  assert.ok(attempt);
  await attempt.settleStartTurn(acceptedTurn("turn-1"));
  await fixture.service.accept(
    "codex-1",
    pendingInteraction(interactionHandle(), "approval-settlement-nonretryable", "codex.command_approval"),
  );

  const result = await fixture.service.respond(interactionResponseInput("approval-settlement-nonretryable"));
  await attempt.done;
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.error.retryable, false);
  assert.equal(fixture.interactionSettlements.length, 1);
  assert.equal(fixture.interactionResponses.length, 0);
  assert.equal(fixture.releasedInteractionReservations.length, 1);
  assert.equal(fixture.interruptInputs.length, 1);
  assert.equal(fixture.terminals[0]?.outcome.kind, "interrupted");
  assert.equal(await fixture.service.readInteractions({ sessionId: "session-1", runId: "run-1", runVersion: 7 }), null);
});

test("one fail-closed response seals every synchronously reserved sibling before Provider write", async () => {
  const fixture = eventFixture({
    interactionAdmissionErrorSequence: ["nonretryable_none"],
    interactionReleaseRejectCount: 1,
  });
  const attempt = fixture.service.register(dispatch(), fixture.control);
  assert.ok(attempt);
  await attempt.settleStartTurn(acceptedTurn("turn-1"));
  const firstPending = pendingInteraction(interactionHandle(), "approval-fail-closed-first", "codex.command_approval");
  const secondPending = pendingInteraction(
    interactionHandle(),
    "approval-fail-closed-second",
    "codex.command_approval",
  );
  await fixture.service.accept("codex-1", firstPending);
  await fixture.service.accept("codex-1", secondPending);

  const first = fixture.service.respond(interactionResponseInput("approval-fail-closed-first"));
  const second = fixture.service.respond(interactionResponseInput("approval-fail-closed-second"));
  assert.equal(fixture.reservedInteractionHandles.length, 2);
  const [firstResult, secondResult] = await Promise.all([first, second]);
  await attempt.done;

  assert.equal(firstResult.ok, false);
  assert.equal(secondResult.ok && secondResult.value.effectCertainty, "not_sent");
  assert.equal(fixture.interactionAdmissions.length, 2);
  assert.equal(fixture.interactionWriteMarks.length, 0);
  assert.equal(fixture.interactionSettlements.length, 1);
  assert.equal(fixture.interactionResponses.length, 0);
  assert.equal(fixture.interruptInputs.length, 1);
  assert.equal(fixture.releasedInteractionReservations.length, 2);
  assert.equal(fixture.terminals.length, 1);
  assert.equal(fixture.terminals[0]?.outcome.kind, "interrupted");
});

test("fail-closed hard gate preserves queued resolved evidence without Provider write", async () => {
  let settleInterrupt!: (
    result: Awaited<ReturnType<NonNullable<ApplicationRunProviderAdapterPort["interruptTurn"]>>>,
  ) => void;
  const fixture = eventFixture({
    interactionAdmissionErrorSequence: ["success", "nonretryable_none"],
    interactionMarkErrorSequence: ["unknown_after_commit", "none"],
    interactionReleaseRejectCount: 1,
    interruptOperation: () => new Promise((resolve) => (settleInterrupt = resolve)),
  });
  const attempt = fixture.service.register(dispatch(), fixture.control);
  assert.ok(attempt);
  await attempt.settleStartTurn(acceptedTurn("turn-1"));
  const retriedPending = pendingInteraction(
    interactionHandle(),
    "approval-fail-closed-retried",
    "codex.command_approval",
  );
  const rejectedPending = pendingInteraction(
    interactionHandle(),
    "approval-fail-closed-rejected",
    "codex.command_approval",
  );
  await fixture.service.accept("codex-1", retriedPending);
  await fixture.service.accept("codex-1", rejectedPending);

  const retried = fixture.service.respond(interactionResponseInput("approval-fail-closed-retried"));
  const rejected = fixture.service.respond(interactionResponseInput("approval-fail-closed-rejected"));
  const resolved = fixture.service.accept("codex-1", {
    kind: "interaction_resolved",
    handle: retriedPending.handle,
    owner: retriedPending.owner,
  });
  assert.equal(fixture.reservedInteractionHandles.length, 2);
  await waitFor(() => fixture.interruptInputs.length === 1);
  settleInterrupt({
    kind: "accepted",
    effect: "present",
    value: { threadId: "thread-1", turnId: "turn-1", terminal: false },
  });

  await resolved;
  const [retriedResult, rejectedResult] = await Promise.all([retried, rejected]);
  await attempt.done;

  assert.equal(retriedResult.ok && retriedResult.value.effectCertainty, "resolved");
  assert.equal(rejectedResult.ok, false);
  assert.equal(fixture.interactionAdmissions.length, 2);
  assert.equal(fixture.interactionWriteMarks.length, 3);
  assert.ok(fixture.interactionWriteMarks.every((command) => command === fixture.interactionWriteMarks[0]));
  assert.equal(fixture.interactionSettlements.length, 1);
  assert.equal(fixture.interactionSettlements[0]?.outcome.effectCertainty, "resolved");
  assert.equal(fixture.interactionResponses.length, 0);
  assert.equal(fixture.interruptInputs.length, 1);
  assert.equal(fixture.releasedInteractionReservations.length, 2);
  assert.equal(fixture.terminals.length, 1);
  assert.equal(fixture.terminals[0]?.outcome.kind, "interrupted");
});

test("fail-closed interaction interrupt dispositions are observed at most once", async () => {
  const scenarios: readonly Readonly<{
    name: string;
    operation: NonNullable<ApplicationRunProviderAdapterPort["interruptTurn"]>;
  }>[] = [
    {
      name: "accepted",
      operation: async (input) => ({
        kind: "accepted",
        effect: "present",
        value: { threadId: input.threadId, turnId: input.turnId, terminal: false },
      }),
    },
    { name: "rejected", operation: async () => ({ kind: "rejected", effect: "none", code: -32_000 }) },
    {
      name: "not_sent",
      operation: async () => ({ kind: "not_sent", effect: "none", code: "capability_unavailable" }),
    },
    { name: "ambiguous", operation: async () => ({ kind: "ambiguous", effect: "unknown", code: "timeout" }) },
    {
      name: "throw",
      operation: async () => {
        throw new Error("interrupt failed");
      },
    },
  ];

  for (const scenario of scenarios) {
    const fixture = eventFixture({
      interactionAdmissionErrorSequence: ["nonretryable_none"],
      interruptOperation: scenario.operation,
    });
    const attempt = fixture.service.register(dispatch(), fixture.control);
    assert.ok(attempt);
    await attempt.settleStartTurn(acceptedTurn("turn-1"));
    await fixture.service.accept(
      "codex-1",
      pendingInteraction(interactionHandle(), `approval-interrupt-${scenario.name}`, "codex.command_approval"),
    );

    await fixture.service.respond(interactionResponseInput(`approval-interrupt-${scenario.name}`));
    await attempt.done;
    assert.equal(fixture.interruptInputs.length, 1, scenario.name);
    assert.equal(fixture.interactionResponses.length, 0, scenario.name);
    assert.equal(fixture.terminals.length, 1, scenario.name);
    assert.equal(fixture.terminals[0]?.outcome.kind, "interrupted", scenario.name);
  }
});

test("fail-closed interaction response retires a handed-off cancel without a second Provider interrupt", async () => {
  let settleProvider!: (result: ApplicationRunProviderInteractionResponseResult) => void;
  let settleInterrupt!: (
    result: Awaited<ReturnType<NonNullable<ApplicationRunProviderAdapterPort["interruptTurn"]>>>,
  ) => void;
  const fixture = eventFixture({
    interactionSettlementErrorSequence: ["nonretryable_none"],
    interactionReleaseRejectCount: 1,
    respondOperation: () => new Promise((resolve) => (settleProvider = resolve)),
    interruptOperation: () => new Promise((resolve) => (settleInterrupt = resolve)),
  });
  const attempt = fixture.service.register(dispatch(), fixture.control);
  assert.ok(attempt);
  await attempt.settleStartTurn(acceptedTurn("turn-1"));
  await fixture.service.accept(
    "codex-1",
    pendingInteraction(interactionHandle(), "approval-fail-closed-cancel", "codex.command_approval"),
  );

  const response = fixture.service.respond(interactionResponseInput("approval-fail-closed-cancel"));
  await waitFor(() => fixture.interactionResponses.length === 1);
  const cancel = await reserveCancel(fixture);
  settleProvider({
    kind: "write_attempted",
    effect: "unknown",
    providerResolution: "resolved",
  });
  await waitFor(() => fixture.interruptInputs.length === 1);
  fixture.service.cancelOwner.handoff(cancelHandoff(cancel));
  settleInterrupt({
    kind: "accepted",
    effect: "present",
    value: { threadId: "thread-1", turnId: "turn-1", terminal: false },
  });

  const result = await response;
  await attempt.done;
  assert.equal(result.ok, false);
  assert.equal(fixture.interactionResponses.length, 1);
  assert.equal(fixture.interactionSettlements.length, 1);
  assert.equal(fixture.interruptInputs.length, 1);
  assert.equal(fixture.releasedInteractionReservations.length, 0);
  assert.equal(fixture.terminals.length, 1);
  assert.equal(fixture.terminals[0]?.outcome.kind, "interrupted");
  const retired = await fixture.service.cancelOwner.preflight({ sessionId: "session-1", runId: "run-1" });
  assert.equal(retired.ok, false);
  assert.equal(!retired.ok && retired.error.code, "not_found");
});

test("cancel-first and response-fail-close-second share one Attempt interrupt latch", async () => {
  const scenarios: readonly Readonly<{
    name: string;
    disposition: Awaited<ReturnType<NonNullable<ApplicationRunProviderAdapterPort["interruptTurn"]>>> | "throw";
  }>[] = [
    {
      name: "accepted",
      disposition: {
        kind: "accepted",
        effect: "present",
        value: { threadId: "thread-1", turnId: "turn-1", terminal: false },
      },
    },
    {
      name: "not_sent",
      disposition: { kind: "not_sent", effect: "none", code: "capability_unavailable" },
    },
    { name: "throw", disposition: "throw" },
  ];

  for (const scenario of scenarios) {
    let settleProvider!: (result: ApplicationRunProviderInteractionResponseResult) => void;
    let settleInterrupt!: (
      result: Awaited<ReturnType<NonNullable<ApplicationRunProviderAdapterPort["interruptTurn"]>>>,
    ) => void;
    let rejectInterrupt!: (error: Error) => void;
    const fixture = eventFixture({
      interactionSettlementErrorSequence: ["nonretryable_none"],
      respondOperation: () => new Promise((resolve) => (settleProvider = resolve)),
      interruptOperation: () =>
        new Promise((resolve, reject) => {
          settleInterrupt = resolve;
          rejectInterrupt = reject;
        }),
    });
    const attempt = fixture.service.register(dispatch(), fixture.control);
    assert.ok(attempt);
    await attempt.settleStartTurn(acceptedTurn("turn-1"));
    await fixture.service.accept(
      "codex-1",
      pendingInteraction(interactionHandle(), `approval-cancel-first-${scenario.name}`, "codex.command_approval"),
    );

    const response = fixture.service.respond(interactionResponseInput(`approval-cancel-first-${scenario.name}`));
    await waitFor(() => fixture.interactionResponses.length === 1);
    const cancel = await reserveCancel(fixture);
    fixture.service.cancelOwner.handoff(cancelHandoff(cancel));
    await waitFor(() => fixture.interruptInputs.length === 1);
    settleProvider({
      kind: "write_attempted",
      effect: "unknown",
      providerResolution: "resolved",
    });
    await Promise.resolve();
    if (scenario.disposition === "throw") {
      rejectInterrupt(new Error("interrupt failed"));
    } else {
      settleInterrupt(scenario.disposition);
    }

    const result = await response;
    await attempt.done;
    assert.equal(result.ok, false, scenario.name);
    assert.equal(fixture.interactionResponses.length, 1, scenario.name);
    assert.equal(fixture.interactionSettlements.length, 1, scenario.name);
    assert.equal(fixture.interruptInputs.length, 1, scenario.name);
    assert.equal(fixture.releasedInteractionReservations.length, 0, scenario.name);
    assert.equal(fixture.terminals.length, 1, scenario.name);
    assert.deepEqual(
      fixture.terminals[0]?.outcome,
      {
        kind: "interrupted",
        failureOrigin: "application",
        providerErrorCode: null,
        errorSummary: "Interaction response persistence could not safely admit the Provider response.",
      },
      scenario.name,
    );
    assert.deepEqual(fixture.terminals[0]?.cancelCorrelation, { kind: "none" }, scenario.name);
  }
});

test("fail-closed interaction response retires handed-off supplemental input without steering Provider", async () => {
  let settleInterrupt!: (
    result: Awaited<ReturnType<NonNullable<ApplicationRunProviderAdapterPort["interruptTurn"]>>>,
  ) => void;
  const fixture = eventFixture({
    interactionAdmissionErrorSequence: ["nonretryable_none"],
    interactionReleaseRejectCount: 1,
    interruptOperation: () => new Promise((resolve) => (settleInterrupt = resolve)),
  });
  const attempt = fixture.service.register(dispatch(), fixture.control);
  assert.ok(attempt);
  await attempt.settleStartTurn(acceptedTurn("turn-1"));
  const input = await reserveInput(fixture);
  await fixture.service.accept(
    "codex-1",
    pendingInteraction(interactionHandle(), "approval-fail-closed-input", "codex.command_approval"),
  );

  const response = fixture.service.respond(interactionResponseInput("approval-fail-closed-input"));
  await waitFor(() => fixture.interruptInputs.length === 1);
  fixture.service.handoff(inputHandoff(input, "input-message-fail-closed", 2));
  settleInterrupt({
    kind: "accepted",
    effect: "present",
    value: { threadId: "thread-1", turnId: "turn-1", terminal: false },
  });

  const result = await response;
  await attempt.done;
  assert.equal(result.ok, false);
  assert.equal(fixture.inputBegins.length, 0);
  assert.equal(fixture.steerInputs.length, 0);
  assert.equal(fixture.inputResolutions.length, 0);
  assert.equal(fixture.releasedInteractionReservations.length, 1);
  assert.equal(fixture.terminals.length, 1);
  assert.equal(fixture.terminals[0]?.outcome.kind, "interrupted");
  const retired = await fixture.service.preflight({ sessionId: "session-1", runId: "run-1" });
  assert.equal(retired.ok, false);
  assert.equal(!retired.ok && retired.error.code, "not_found");
});

test("fail-closed interaction response blocks Provider steering after an exact input begin retry", async () => {
  let inputBeginAvailable = false;
  let settleInterrupt!: (
    result: Awaited<ReturnType<NonNullable<ApplicationRunProviderAdapterPort["interruptTurn"]>>>,
  ) => void;
  const fixture = eventFixture({
    interactionAdmissionErrorSequence: ["nonretryable_none"],
    async inputBeginOperation(command) {
      if (!inputBeginAvailable) throw nonePersistenceFailure();
      return {
        ok: true,
        replayed: false,
        value: {
          sessionId: command.sessionId,
          runId: command.runId,
          attemptId: command.attemptId,
          messageId: command.messageId,
          bindingId: command.bindingId,
          deliveryState: "dispatching" as const,
          dispatchingAt: 15,
          sendAllowed: true,
        },
      };
    },
    interruptOperation: () => new Promise((resolve) => (settleInterrupt = resolve)),
  });
  const attempt = fixture.service.register(dispatch(), fixture.control);
  assert.ok(attempt);
  await attempt.settleStartTurn(acceptedTurn("turn-1"));
  const input = await reserveInput(fixture);
  fixture.service.handoff(inputHandoff(input, "input-message-fail-closed-begin", 2));
  await waitFor(() => fixture.inputBegins.length >= 1);
  await fixture.service.accept(
    "codex-1",
    pendingInteraction(interactionHandle(), "approval-fail-closed-input-begin", "codex.command_approval"),
  );

  const response = fixture.service.respond(interactionResponseInput("approval-fail-closed-input-begin"));
  await waitFor(() => fixture.interruptInputs.length === 1);
  inputBeginAvailable = true;
  settleInterrupt({
    kind: "accepted",
    effect: "present",
    value: { threadId: "thread-1", turnId: "turn-1", terminal: false },
  });

  const result = await response;
  await attempt.done;
  assert.equal(result.ok, false);
  assert.ok(fixture.inputBegins.length >= 2);
  assert.ok(fixture.inputBegins.every((command) => command === fixture.inputBegins[0]));
  assert.equal(fixture.steerInputs.length, 0);
  assert.equal(fixture.inputResolutions.length, 1);
  assert.deepEqual(fixture.inputResolutions[0]?.outcome, {
    kind: "rejected",
    resolutionCode: "delivery_not_sent",
  });
  assert.equal(fixture.terminals.length, 1);
  assert.equal(fixture.terminals[0]?.outcome.kind, "interrupted");
});

test("queued interaction resolution and terminal evidence cannot overtake fail-closed terminalization", async () => {
  let settleInterrupt!: (
    result: Awaited<ReturnType<NonNullable<ApplicationRunProviderAdapterPort["interruptTurn"]>>>,
  ) => void;
  const fixture = eventFixture({
    interactionAdmissionErrorSequence: ["nonretryable_none"],
    interactionReleaseRejectCount: 1,
    interruptOperation: () => new Promise((resolve) => (settleInterrupt = resolve)),
  });
  const attempt = fixture.service.register(dispatch(), fixture.control);
  assert.ok(attempt);
  await attempt.settleStartTurn(acceptedTurn("turn-1"));
  const pending = pendingInteraction(interactionHandle(), "approval-fail-closed-race", "codex.command_approval");
  await fixture.service.accept("codex-1", pending);

  const response = fixture.service.respond(interactionResponseInput("approval-fail-closed-race"));
  await waitFor(() => fixture.interruptInputs.length === 1);
  assert.equal((await fixture.service.read({ sessionId: "session-1", runId: "run-1" }))?.activity, "running");
  const terminal = fixture.service.accept("codex-1", terminalEvent("completed"));
  const resolved = fixture.service.accept("codex-1", {
    kind: "interaction_resolved",
    handle: pending.handle,
    owner: pending.owner,
  });
  settleInterrupt({
    kind: "accepted",
    effect: "present",
    value: { threadId: "thread-1", turnId: "turn-1", terminal: false },
  });

  await response;
  await resolved;
  await terminal;
  await attempt.done;
  assert.equal(fixture.interruptInputs.length, 1);
  assert.equal(fixture.interactionResponses.length, 0);
  assert.equal(fixture.terminals.length, 1);
  assert.deepEqual(fixture.terminals[0]?.outcome, {
    kind: "interrupted",
    failureOrigin: "application",
    providerErrorCode: null,
    errorSummary: "Interaction response persistence could not safely admit the Provider response.",
  });
});

test("resolved-first and cancel-first interaction response races never call Provider", async () => {
  const resolvedFixture = eventFixture();
  const resolvedAttempt = resolvedFixture.service.register(dispatch(), resolvedFixture.control);
  assert.ok(resolvedAttempt);
  await resolvedAttempt.settleStartTurn(acceptedTurn("turn-1"));
  const resolvedPending = pendingInteraction(interactionHandle(), "approval-resolved-first", "codex.command_approval");
  await resolvedFixture.service.accept("codex-1", resolvedPending);
  await resolvedFixture.service.accept("codex-1", {
    kind: "interaction_resolved",
    handle: resolvedPending.handle,
    owner: resolvedPending.owner,
  });
  const resolved = await resolvedFixture.service.respond(interactionResponseInput("approval-resolved-first"));
  assert.equal(resolved.ok, false);
  assert.equal(resolvedFixture.interactionResponses.length, 0);

  const cancelFixture = eventFixture();
  const cancelAttempt = cancelFixture.service.register(dispatch(), cancelFixture.control);
  assert.ok(cancelAttempt);
  await cancelAttempt.settleStartTurn(acceptedTurn("turn-1"));
  await cancelFixture.service.accept(
    "codex-1",
    pendingInteraction(interactionHandle(), "approval-cancel-first", "codex.command_approval"),
  );
  const cancel = await cancelFixture.service.cancelOwner.preflight({ sessionId: "session-1", runId: "run-1" });
  assert.equal(cancel.ok, true);
  const canceled = await cancelFixture.service.respond(interactionResponseInput("approval-cancel-first"));
  assert.equal(canceled.ok, false);
  assert.equal(cancelFixture.interactionResponses.length, 0);
  if (cancel.ok && cancel.value.kind === "active_execution")
    cancelFixture.service.cancelOwner.release(cancel.value.reservation);
});

test("a queued cancel preflight wins before a later interaction response can reserve Provider", async () => {
  const fixture = eventFixture();
  const attempt = fixture.service.register(dispatch(), fixture.control);
  assert.ok(attempt);
  await attempt.settleStartTurn(acceptedTurn("turn-1"));
  await fixture.service.accept(
    "codex-1",
    pendingInteraction(interactionHandle(), "approval-cancel-queued", "codex.command_approval"),
  );

  const cancel = fixture.service.cancelOwner.preflight({ sessionId: "session-1", runId: "run-1" });
  const response = fixture.service.respond(interactionResponseInput("approval-cancel-queued"));

  const cancelResult = await cancel;
  assert.equal(cancelResult.ok, true);
  const responseResult = await response;
  assert.equal(responseResult.ok, false);
  assert.equal(fixture.reservedInteractionHandles.length, 0);
  assert.equal(fixture.interactionAdmissions.length, 0);
  assert.equal(fixture.interactionWriteMarks.length, 0);
  assert.equal(fixture.interactionResponses.length, 0);
  if (cancelResult.ok && cancelResult.value.kind === "active_execution") {
    fixture.service.cancelOwner.release(cancelResult.value.reservation);
  }
});

test("an exact persistence retry never downgrades earlier unknown certainty to no effect", async () => {
  for (const phase of ["admission", "mark", "settlement"] as const) {
    const fixture = eventFixture({
      ...(phase === "admission"
        ? { interactionAdmissionErrorSequence: ["unknown_after_commit", "none", "none"] as const }
        : {}),
      ...(phase === "mark" ? { interactionMarkErrorSequence: ["unknown_after_commit", "none", "none"] as const } : {}),
      ...(phase === "settlement"
        ? { interactionSettlementErrorSequence: ["unknown_after_commit", "none", "none"] as const }
        : {}),
    });
    const attempt = fixture.service.register(dispatch(), fixture.control);
    assert.ok(attempt);
    await attempt.settleStartTurn(acceptedTurn("turn-1"));
    await fixture.service.accept(
      "codex-1",
      pendingInteraction(interactionHandle(), `approval-unknown-none-${phase}`, "codex.command_approval"),
    );

    const result = await fixture.service.respond(interactionResponseInput(`approval-unknown-none-${phase}`));
    assert.equal(result.ok && result.value.effectCertainty, "resolved", phase);
    assert.equal(fixture.interactionResponses.length, 1, phase);
    assert.equal(fixture.reservedInteractionHandles.length, 1, phase);
    assert.equal(fixture.releasedInteractionReservations.length, 0, phase);
    assert.equal(fixture.interactionAdmissions.length, phase === "admission" ? 4 : 1, phase);
    assert.equal(fixture.interactionWriteMarks.length, phase === "mark" ? 4 : 1, phase);
    assert.equal(fixture.interactionSettlements.length, phase === "settlement" ? 4 : 1, phase);
    const exactCommands =
      phase === "admission"
        ? fixture.interactionAdmissions
        : phase === "mark"
          ? fixture.interactionWriteMarks
          : fixture.interactionSettlements;
    assert.ok(
      exactCommands.every((command) => command === exactCommands[0]),
      phase,
    );
  }
});

test("interaction response settlement retries persistence without resending Provider write", async () => {
  const fixture = eventFixture({ interactionSettlementUnknownCount: 1 });
  const attempt = fixture.service.register(dispatch(), fixture.control);
  assert.ok(attempt);
  await attempt.settleStartTurn(acceptedTurn("turn-1"));
  await fixture.service.accept(
    "codex-1",
    pendingInteraction(interactionHandle(), "approval-retry", "codex.command_approval"),
  );

  const response = await fixture.service.respond(interactionResponseInput("approval-retry"));
  assert.equal(response.ok && response.value.effectCertainty, "resolved");
  assert.equal(fixture.interactionResponses.length, 1);
  assert.equal(fixture.interactionSettlements.length, 2);
});

test("resolved evidence upgrades an ambiguous interaction response without another Provider write", async () => {
  const fixture = eventFixture({
    respondOperation() {
      return Promise.resolve({
        kind: "ambiguous",
        effect: "unknown",
        code: "connection_lost",
        providerResolution: "pending",
      });
    },
  });
  const attempt = fixture.service.register(dispatch(), fixture.control);
  assert.ok(attempt);
  await attempt.settleStartTurn(acceptedTurn("turn-1"));
  const pending = pendingInteraction(interactionHandle(), "approval-ambiguous", "codex.command_approval");
  await fixture.service.accept("codex-1", pending);
  const response = await fixture.service.respond(interactionResponseInput("approval-ambiguous"));
  assert.equal(response.ok && response.value.effectCertainty, "ambiguous");

  await fixture.service.accept("codex-1", {
    kind: "interaction_resolved",
    handle: pending.handle,
    owner: pending.owner,
  });
  assert.equal(fixture.interactionResponses.length, 1);
  assert.equal(fixture.interactionSettlements.at(-1)?.outcome.effectCertainty, "resolved");
});

test("resolved evidence survives an in-flight ambiguous exact command and converges in two durable steps", async () => {
  const fixture = eventFixture({
    interactionSettlementUnknownCount: 4,
    respondOperation() {
      return Promise.resolve({
        kind: "ambiguous",
        effect: "unknown",
        code: "connection_lost",
        providerResolution: "pending",
      });
    },
  });
  const attempt = fixture.service.register(dispatch(), fixture.control);
  assert.ok(attempt);
  await attempt.settleStartTurn(acceptedTurn("turn-1"));
  const pending = pendingInteraction(interactionHandle(), "approval-ambiguous-inflight", "codex.command_approval");
  await fixture.service.accept("codex-1", pending);
  const response = fixture.service.respond(interactionResponseInput("approval-ambiguous-inflight"));
  await waitFor(() => fixture.interactionSettlements.length >= 2);

  await fixture.service.accept("codex-1", {
    kind: "interaction_resolved",
    handle: pending.handle,
    owner: pending.owner,
  });
  const result = await response;
  await waitFor(() => fixture.interactionSettlements.at(-1)?.outcome.effectCertainty === "resolved");
  assert.equal(result.ok && result.value.effectCertainty, "ambiguous");
  assert.equal(fixture.interactionResponses.length, 1);
  const outcomes = fixture.interactionSettlements.map((command) => command.outcome.effectCertainty);
  const firstResolved = outcomes.indexOf("resolved");
  assert.ok(firstResolved > 0);
  assert.deepEqual(new Set(outcomes.slice(0, firstResolved)), new Set(["ambiguous"]));
});

test("same-key owner replay and a second client key never resend an admitted interaction response", async () => {
  const fixture = eventFixture({
    respondOperation() {
      return Promise.resolve({ kind: "write_attempted", effect: "unknown", providerResolution: "pending" });
    },
  });
  const attempt = fixture.service.register(dispatch(), fixture.control);
  assert.ok(attempt);
  await attempt.settleStartTurn(acceptedTurn("turn-1"));
  await fixture.service.accept(
    "codex-1",
    pendingInteraction(interactionHandle(), "approval-owner-replay", "codex.command_approval"),
  );
  const firstInput = interactionResponseInput("approval-owner-replay");
  const first = await fixture.service.respond(firstInput);
  const replay = await fixture.service.respond(firstInput);
  const conflict = await fixture.service.respond({
    ...firstInput,
    idempotencyKey: "20000000-0000-4000-8000-000000000002",
  });
  assert.equal(first.ok && first.value.effectCertainty, "write_attempted");
  assert.equal(replay.ok && replay.replayed, true);
  assert.equal(conflict.ok, false);
  assert.equal(fixture.interactionResponses.length, 1);
});

test("same-key joins a reserved admission while a different key conflicts before Provider write", async () => {
  let releaseAdmission!: () => void;
  const admissionGate = new Promise<void>((resolve) => {
    releaseAdmission = resolve;
  });
  const fixture = eventFixture({ interactionAdmissionGate: admissionGate });
  const attempt = fixture.service.register(dispatch(), fixture.control);
  assert.ok(attempt);
  await attempt.settleStartTurn(acceptedTurn("turn-1"));
  await fixture.service.accept(
    "codex-1",
    pendingInteraction(interactionHandle(), "approval-reserved-replay", "codex.command_approval"),
  );
  const input = interactionResponseInput("approval-reserved-replay");
  const first = fixture.service.respond(input);
  const same = fixture.service.respond(input);
  const conflict = await fixture.service.respond({
    ...input,
    idempotencyKey: "20000000-0000-4000-8000-000000000002",
  });
  assert.equal(conflict.ok, false);
  assert.equal(fixture.reservedInteractionHandles.length, 1);
  assert.equal(fixture.interactionResponses.length, 0);

  releaseAdmission();
  const [firstResult, sameResult] = await Promise.all([first, same]);
  assert.equal(firstResult.ok && firstResult.replayed, false);
  assert.equal(sameResult.ok && sameResult.replayed, true);
  assert.equal(fixture.interactionResponses.length, 1);
});

test("generation release before and after interaction write produce not-found or ambiguous without resend", async () => {
  const beforeFixture = eventFixture();
  const beforeAttempt = beforeFixture.service.register(dispatch(), beforeFixture.control);
  assert.ok(beforeAttempt);
  await beforeAttempt.settleStartTurn(acceptedTurn("turn-1"));
  await beforeFixture.service.accept(
    "codex-1",
    pendingInteraction(interactionHandle(), "approval-before-release", "codex.command_approval"),
  );
  await beforeFixture.service.releaseGeneration("codex-1", { kind: "shutdown" });
  const before = await beforeFixture.service.respond(interactionResponseInput("approval-before-release"));
  assert.equal(before.ok, false);
  assert.equal(beforeFixture.interactionResponses.length, 0);

  const afterFixture = eventFixture({
    respondOperation() {
      return Promise.resolve({ kind: "write_attempted", effect: "unknown", providerResolution: "pending" });
    },
  });
  const afterAttempt = afterFixture.service.register(dispatch(), afterFixture.control);
  assert.ok(afterAttempt);
  await afterAttempt.settleStartTurn(acceptedTurn("turn-1"));
  await afterFixture.service.accept(
    "codex-1",
    pendingInteraction(interactionHandle(), "approval-after-release", "codex.command_approval"),
  );
  const after = await afterFixture.service.respond(interactionResponseInput("approval-after-release"));
  assert.equal(after.ok && after.value.effectCertainty, "write_attempted");
  await afterFixture.service.releaseGeneration("codex-1", { kind: "shutdown" });
  assert.equal(afterFixture.interactionResponses.length, 1);
  assert.equal(afterFixture.interactionSettlements.at(-1)?.outcome.effectCertainty, "ambiguous");
  assert.equal(afterFixture.interactionResponses.length, 1);
});

test("generation release barrier preserves no-effect before marker and ambiguity after marker", async () => {
  const beforeFixture = eventFixture({ interactionAdmissionUnknownAfterCommitCount: 2 });
  const beforeAttempt = beforeFixture.service.register(dispatch(), beforeFixture.control);
  assert.ok(beforeAttempt);
  await beforeAttempt.settleStartTurn(acceptedTurn("turn-1"));
  await beforeFixture.service.accept(
    "codex-1",
    pendingInteraction(interactionHandle(), "approval-before-marker", "codex.command_approval"),
  );
  const beforeResponse = beforeFixture.service.respond(interactionResponseInput("approval-before-marker"));
  await waitFor(() => beforeFixture.interactionAdmissions.length === 2);
  assert.deepEqual(await beforeFixture.service.prepareGenerationRelease("codex-1", { kind: "shutdown" }), {
    kind: "ready",
  });
  const before = await beforeResponse;
  assert.equal(before.ok && before.value.effectCertainty, "not_sent");
  assert.equal(beforeFixture.interactionWriteMarks.length, 0);
  assert.equal(beforeFixture.interactionResponses.length, 0);
  assert.equal(beforeFixture.releasedInteractionReservations.length, 1);

  const afterFixture = eventFixture({ interactionMarkUnknownAfterCommitCount: 2 });
  const afterAttempt = afterFixture.service.register(dispatch(), afterFixture.control);
  assert.ok(afterAttempt);
  await afterAttempt.settleStartTurn(acceptedTurn("turn-1"));
  await afterFixture.service.accept(
    "codex-1",
    pendingInteraction(interactionHandle(), "approval-after-marker", "codex.command_approval"),
  );
  const afterResponse = afterFixture.service.respond(interactionResponseInput("approval-after-marker"));
  await waitFor(() => afterFixture.interactionWriteMarks.length === 2);
  assert.deepEqual(await afterFixture.service.prepareGenerationRelease("codex-1", { kind: "shutdown" }), {
    kind: "ready",
  });
  const after = await afterResponse;
  assert.equal(after.ok && after.value.effectCertainty, "ambiguous");
  assert.equal(afterFixture.interactionResponses.length, 0);
  assert.equal(afterFixture.releasedInteractionReservations.length, 1);
});

test("read ignores pending interaction-derived activity after attempt signal is aborted", async () => {
  const abortController = new AbortController();
  const fixture = eventFixture({ signal: abortController.signal });
  const attempt = fixture.service.register(dispatch(), fixture.control);
  assert.ok(attempt);
  await attempt.settleStartTurn(acceptedTurn("turn-1"));
  await fixture.service.accept(
    "codex-1",
    pendingInteraction(interactionHandle(), "approval-1", "codex.command_approval"),
  );
  assert.equal((await fixture.service.read({ sessionId: "session-1", runId: "run-1" }))?.activity, "waiting_approval");
  abortController.abort();
  assert.equal((await fixture.service.read({ sessionId: "session-1", runId: "run-1" }))?.activity, "running");
});

test("resolved-before-activation is never published and terminal close prevents late resurrection", async () => {
  const fixture = eventFixture({ terminalUnknownCount: 2 });
  const attempt = fixture.service.register(dispatch(), fixture.control);
  assert.ok(attempt);
  const pending = pendingInteraction(interactionHandle(), "approval-1", "codex.command_approval");
  await fixture.service.accept("codex-1", pending);
  await fixture.service.accept("codex-1", {
    kind: "interaction_resolved",
    handle: pending.handle,
    owner: pending.owner,
  });
  await attempt.settleStartTurn(acceptedTurn("turn-1"));
  assert.deepEqual(
    (await fixture.service.readInteractions({ sessionId: "session-1", runId: "run-1", runVersion: 7 }))?.interactions,
    [],
  );

  const live = pendingInteraction(interactionHandle(), "approval-2", "codex.command_approval");
  await fixture.service.accept("codex-1", live);
  await fixture.service.accept("codex-1", {
    kind: "turn_terminal",
    threadId: "thread-1",
    turnId: "turn-1",
    status: "completed",
    finalAssistantMessage: null,
    contentFailure: null,
  });
  assert.equal(await fixture.service.readInteractions({ sessionId: "session-1", runId: "run-1", runVersion: 7 }), null);
  await fixture.service.accept("codex-1", live);
  assert.equal(await fixture.service.readInteractions({ sessionId: "session-1", runId: "run-1", runVersion: 7 }), null);
});

test("interaction owner conflicts and per-Attempt capacity fail the event consumer instead of overwriting", async () => {
  const fixture = eventFixture({ limits: { maxPendingInteractions: 1 } });
  const attempt = fixture.service.register(dispatch(), fixture.control);
  assert.ok(attempt);
  await attempt.settleStartTurn(acceptedTurn("turn-1"));
  const first = pendingInteraction(interactionHandle(), "approval-1", "codex.command_approval");
  await fixture.service.accept("codex-1", first);
  await assert.rejects(
    fixture.service.accept("codex-1", pendingInteraction(interactionHandle(), "approval-2", "codex.command_approval")),
    /capacity/u,
  );
  await assert.rejects(
    fixture.service.accept("codex-1", {
      kind: "interaction_resolved",
      handle: first.handle,
      owner: { ...first.owner, connectionGeneration: "adapter-other" },
    }),
    /generation/u,
  );
  assert.deepEqual(
    (await fixture.service.readInteractions({ sessionId: "session-1", runId: "run-1", runVersion: 7 }))?.interactions,
    [first.snapshot],
  );
});

test("durable cancel handoff clears interactions after owner validation and before Provider interrupt", async () => {
  let fixture!: ReturnType<typeof eventFixture>;
  let activityAtInterrupt: unknown = "not-called";
  fixture = eventFixture({
    interruptOperation: async (input) => {
      activityAtInterrupt = (await fixture.service.read({ sessionId: "session-1", runId: "run-1" }))?.activity;
      return {
        kind: "accepted",
        effect: "present",
        value: { threadId: input.threadId, turnId: input.turnId, terminal: false },
      };
    },
  });
  const attempt = fixture.service.register(dispatch(), fixture.control);
  assert.ok(attempt);
  await attempt.settleStartTurn(acceptedTurn("turn-1"));
  await fixture.service.accept(
    "codex-1",
    pendingInteraction(interactionHandle(), "approval-1", "codex.command_approval"),
  );
  const reservation = await reserveCancel(fixture);
  fixture.service.cancelOwner.handoff(cancelHandoff(reservation));
  await waitFor(() => fixture.interruptInputs.length === 1);
  assert.equal(activityAtInterrupt, "running");
});

test("interaction state validates full dynamic owner tuple, definition tuple, aggregate bytes, and closed races", () => {
  assert.deepEqual(APPLICATION_RUN_INTERACTION_LIMITS, {
    maxPendingPerAttempt: 32,
    maxProjectionBytesPerAttempt: 384 * 1_024,
    maxTombstonesPerAttempt: 128,
  });
  const owner = {
    sessionId: "session-1",
    runId: "run-1",
    attemptId: "attempt-1",
    bindingId: "binding-1",
    workspaceKey: "workspace-1",
    providerId: "codex",
    definitionVersion: "codex-provider-v1",
    persistenceMode: "persistent" as const,
    ephemeralOwnerToken: null,
    runtimeGenerationId: "codex-1",
    externalConversationId: "thread-1",
  };
  const state = new ApplicationRunInteractionState(owner, interactionActivity, {
    maxPending: 2,
    maxProjectionBytes: 1_000,
    maxTombstones: 1,
  });
  const handle = interactionHandle();
  const pending = pendingInteraction(handle, "approval-1", "codex.command_approval");
  state.pending(handle, pending.owner, pending.snapshot);
  assert.throws(() => state.resolved(handle, { ...pending.owner, itemId: "item-other" }), /owner/u);
  assert.throws(
    () => state.pending(interactionHandle(), pending.owner, { ...pending.snapshot, providerId: "other" } as never),
    /definition owner/u,
  );
  assert.throws(
    () =>
      state.pending(interactionHandle(), pending.owner, {
        ...pending.snapshot,
        interactionId: "large",
        display: { summary: "x".repeat(512), command: "x".repeat(512) },
      }),
    /projection capacity/u,
  );
  assert.throws(
    () =>
      state.pending(interactionHandle(), pending.owner, {
        ...pending.snapshot,
        interactionId: "fractional",
        display: { maxLength: 1.5 },
      }),
    /number is invalid/u,
  );
  state.close();
  state.pending(interactionHandle(), pending.owner, { ...pending.snapshot, interactionId: "late" });
  state.activate("turn-1");
  assert.deepEqual(state.snapshot(), []);
});

test("accepted Provider events persist safe output once, expose versioned live state, and terminalize exactly", async () => {
  const fixture = eventFixture({
    resolutionUnknownOnce: true,
    outputUnknownOnce: true,
    terminalUnknownOnce: true,
  });
  const handle = fixture.service.register(dispatch(), fixture.control);
  assert.ok(handle);

  await handle.settleStartTurn(acceptedTurn("turn-1"));
  assert.deepEqual(fixture.resolutions[0], fixture.resolutions[1]);
  assert.deepEqual(await fixture.service.read({ sessionId: "session-1", runId: "run-1" }), {
    sessionId: "session-1",
    runId: "run-1",
    runVersion: 7,
    activity: "running",
  });

  const output = {
    kind: "item_output",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    output: {
      category: "assistant_detail",
      kind: "reasoning",
      summary: "bounded detail",
      completionState: "complete",
      payload: {
        kind: "text",
        text: "must not be persisted",
        originalByteLength: 21,
        redaction: "undetermined",
      },
    },
  } as const;
  await fixture.service.accept("codex-1", output);
  await fixture.service.accept("codex-1", output);

  assert.equal(fixture.outputs.length, 2);
  assert.deepEqual(fixture.outputs[0], fixture.outputs[1]);
  assert.deepEqual(fixture.outputs[0]?.item.payload, {
    state: "omitted_redaction",
    originalByteLength: 21,
  });
  assert.equal(JSON.stringify(fixture.outputs).includes("must not be persisted"), false);

  await fixture.service.accept("codex-1", {
    kind: "turn_terminal",
    threadId: "thread-1",
    turnId: "turn-1",
    status: "completed",
    finalAssistantMessage: { contentBlocks: [{ type: "text", text: "done" }] },
    contentFailure: { code: "size_limit" },
  });
  await handle.done;

  assert.equal(fixture.terminals.length, 2);
  assert.deepEqual(fixture.terminals[0], fixture.terminals[1]);
  assert.equal(fixture.terminals[0]?.outcome.kind, "completed");
  assert.equal(
    fixture.terminals[0]?.outcome.kind === "completed" && fixture.terminals[0].outcome.finalAssistantMessage,
    null,
  );
  assert.equal(fixture.terminals[0]?.outputs[0]?.kind, "assistant_content_failure");
  assert.deepEqual(await fixture.service.read({ sessionId: "session-1", runId: "run-1" }), null);

  await fixture.service.accept("codex-1", output);
  assert.equal(fixture.outputs.length, 2);
});

test("persistence-only ownership automatically retries accepted resolution and terminal commands", async () => {
  const fixture = eventFixture({
    resolutionUnknownCount: 2,
    terminalUnknownCount: 2,
    recoveryUnavailableCount: 1,
  });
  const handle = fixture.service.register(dispatch(), fixture.control);
  assert.ok(handle);

  await handle.settleStartTurn(acceptedTurn("turn-1"));
  await waitFor(() => fixture.resolutions.length === 3);
  assert.equal((await fixture.service.read({ sessionId: "session-1", runId: "run-1" }))?.activity, "running");

  await fixture.service.accept("codex-1", {
    kind: "turn_terminal",
    threadId: "thread-1",
    turnId: "turn-1",
    status: "completed",
    finalAssistantMessage: null,
    contentFailure: null,
  });
  await waitFor(() => fixture.terminals.length === 3);
  await handle.done;

  assert.ok(fixture.resolutions.every((command) => JSON.stringify(command) === JSON.stringify(fixture.resolutions[0])));
  assert.ok(fixture.terminals.every((command) => JSON.stringify(command) === JSON.stringify(fixture.terminals[0])));
});

test("not-sent and rejected Provider results resolve rejected before their bounded terminal", async () => {
  for (const result of [
    { kind: "not_sent", effect: "none", code: "invalid_input" },
    { kind: "rejected", effect: "none", code: -32_000 },
  ] as const) {
    const fixture = eventFixture();
    const handle = fixture.service.register(dispatch(), fixture.control);
    assert.ok(handle);
    await handle.settleStartTurn(result);
    await handle.done;
    assert.deepEqual(
      fixture.resolutions.map((command) => command.outcome.kind),
      ["rejected"],
    );
    assert.equal(fixture.terminalized.length, 1);
    assert.equal(fixture.terminalized[0]?.outcomeKind, "failed");
    assert.equal(fixture.terminalized[0]?.failureOrigin, result.kind === "rejected" ? "provider" : "application");
  }
});

test("a queued operation rejection retains the exact startTurn result and Attempt owner", async () => {
  const fixture = eventFixture({ terminalizeRejectOnce: true });
  const handle = fixture.service.register(dispatch(), fixture.control);
  assert.ok(handle);
  const result = { kind: "not_sent", effect: "none", code: "invalid_input" } as const;

  await assert.rejects(handle.settleStartTurn(result), /terminal persistence failed/u);
  assert.equal(await isSettled(handle.done), false);
  assert.equal(await fixture.service.retryRun("run-1"), true);
  await handle.done;

  assert.equal(fixture.terminalized.length, 2);
  assert.deepEqual(fixture.terminalized[0], fixture.terminalized[1]);
  assert.equal(fixture.resolutions.length, 2);
  assert.deepEqual(fixture.resolutions[0], fixture.resolutions[1]);
});

test("Turn failure code distinguishes deterministic input from shutdown abort", async () => {
  for (const expected of [
    {
      result: { kind: "not_sent", effect: "none", code: "aborted" },
      outcomeKind: "interrupted",
      failureOrigin: "application",
    },
    {
      result: { kind: "not_sent", effect: "none", code: "invalid_input" },
      outcomeKind: "failed",
      failureOrigin: "application",
    },
  ] as const) {
    const fixture = eventFixture();
    const handle = fixture.service.register(dispatch(), fixture.control);
    assert.ok(handle);

    await fixture.service.releaseGeneration("codex-1", { kind: "shutdown" });
    await handle.settleStartTurn(expected.result);
    await handle.done;

    assert.deepEqual(
      fixture.resolutions.map((command) => command.outcome.kind),
      ["rejected"],
    );
    assert.equal(fixture.terminalized.length, 1);
    assert.equal(fixture.terminalized[0]?.outcomeKind, expected.outcomeKind);
    assert.equal(fixture.terminalized[0]?.failureOrigin, expected.failureOrigin);
  }
});

test("event-first connection failure keeps a later not-sent Turn result as a transport interruption", async () => {
  const fixture = eventFixture();
  const handle = fixture.service.register(dispatch(), fixture.control);
  assert.ok(handle);

  await fixture.service.accept("codex-1", {
    kind: "connection_failure",
    code: "process_exited",
  });
  await handle.settleStartTurn({
    kind: "not_sent",
    effect: "none",
    code: "process_exited",
  });
  await handle.done;

  assert.deepEqual(
    fixture.resolutions.map((command) => command.outcome.kind),
    ["rejected"],
  );
  assert.equal(fixture.terminalized.length, 1);
  assert.equal(fixture.terminalized[0]?.outcomeKind, "interrupted");
  assert.equal(fixture.terminalized[0]?.failureOrigin, "transport");
});

test("event-first acceptance is buffered, while an ambiguous response needs new post-response evidence", async () => {
  const accepted = eventFixture();
  const acceptedHandle = accepted.service.register(dispatch(), accepted.control);
  assert.ok(acceptedHandle);
  await accepted.service.accept("codex-1", turnStarted("turn-1"));
  await acceptedHandle.settleStartTurn(acceptedTurn("turn-1"));
  assert.equal(accepted.resolutions[0]?.outcome.kind, "accepted");

  const ambiguous = eventFixture();
  const ambiguousHandle = ambiguous.service.register(dispatch(), ambiguous.control);
  assert.ok(ambiguousHandle);
  await ambiguous.service.accept("codex-1", turnStarted("turn-conflicted"));
  await ambiguousHandle.settleStartTurn({
    kind: "ambiguous",
    effect: "unknown",
    code: "connection_lost",
  });
  await ambiguous.service.accept("codex-1", turnStarted("turn-conflicted"));
  assert.deepEqual(
    ambiguous.resolutions.map((command) => command.outcome.kind),
    ["ambiguous"],
  );
  assert.deepEqual(await ambiguous.service.read({ sessionId: "session-1", runId: "run-1" }), null);

  await ambiguous.service.accept("codex-1", turnStarted("turn-late"));
  assert.deepEqual(
    ambiguous.resolutions.map((command) => command.outcome.kind),
    ["ambiguous", "accepted"],
  );
  assert.equal((await ambiguous.service.read({ sessionId: "session-1", runId: "run-1" }))?.activity, "running");
});

test("generation loss terminalizes accepted and ambiguous execution without claiming ambiguous delivery was absent", async () => {
  const accepted = eventFixture();
  const acceptedHandle = accepted.service.register(dispatch(), accepted.control);
  assert.ok(acceptedHandle);
  await accepted.service.accept("codex-1", {
    kind: "connection_failure",
    code: "process_exited",
  });
  await acceptedHandle.settleStartTurn(acceptedTurn("turn-1"));
  await acceptedHandle.done;
  assert.equal(accepted.terminals[0]?.outcome.kind, "interrupted");
  assert.equal(
    accepted.terminals[0]?.outcome.kind === "interrupted" && accepted.terminals[0].outcome.failureOrigin,
    "transport",
  );

  const ambiguous = eventFixture({
    terminalUnknownCount: 2,
    limits: { maxBufferedEventsPerAttempt: 1 },
  });
  const ambiguousHandle = ambiguous.service.register(dispatch(), ambiguous.control);
  assert.ok(ambiguousHandle);
  await ambiguous.service.accept("codex-1", {
    kind: "thread_status_observed",
    threadId: "thread-1",
    status: "active",
  });
  await ambiguous.service.accept("codex-1", {
    kind: "thread_status_observed",
    threadId: "thread-1",
    status: "idle",
  });
  await ambiguousHandle.settleStartTurn({
    kind: "connection_failure",
    effect: "unknown",
    code: "process_exited",
  });
  await assert.rejects(
    ambiguous.service.releaseGeneration("codex-1", {
      kind: "connection_failure",
      code: "process_exited",
    }),
    /persistence outcome is still unknown/u,
  );
  assert.equal(await isSettled(ambiguousHandle.done), false);
  assert.equal(await ambiguous.service.retryRun("run-1"), true);
  await ambiguousHandle.done;
  assert.equal(ambiguous.terminals.length, 3);
  assert.deepEqual(ambiguous.terminals[0], ambiguous.terminals[1]);
  assert.deepEqual(ambiguous.terminals[1], ambiguous.terminals[2]);
  assert.equal(ambiguous.terminals[0]?.outcome.kind, "interrupted");
  assert.equal(ambiguous.terminals[0]?.preDispatchResolution.kind, "dispatch_ambiguous");
  assert.equal(ambiguous.terminals[0]?.providerExecution, null);
  assert.deepEqual(
    ambiguous.terminals[0]?.outputs.map((output) => output.kind),
    ["runtime_resource_limit"],
  );
  assert.deepEqual(
    ambiguous.resolutions.map((command) => command.outcome.kind),
    ["ambiguous"],
  );
});

test("generation release waits for an in-flight startTurn result before closing the attempt", async () => {
  const fixture = eventFixture();
  const handle = fixture.service.register(dispatch(), fixture.control);
  assert.ok(handle);

  await fixture.service.accept("codex-1", {
    kind: "connection_failure",
    code: "process_exited",
  });
  await fixture.service.releaseGeneration("codex-1", {
    kind: "connection_failure",
    code: "process_exited",
  });
  await handle.settleStartTurn(acceptedTurn("turn-1"));
  await handle.done;

  assert.equal(fixture.terminals[0]?.outcome.kind, "interrupted");
  assert.equal(
    fixture.terminals[0]?.outcome.kind === "interrupted" && fixture.terminals[0].outcome.failureOrigin,
    "transport",
  );
});

test("output-bearing metadata requires exact Turn correlation", async () => {
  const fixture = eventFixture();
  const handle = fixture.service.register(dispatch(), fixture.control);
  assert.ok(handle);
  await handle.settleStartTurn(acceptedTurn("turn-1"));

  const output = {
    category: "provider_metadata" as const,
    kind: "provider/progress",
    summary: "progress",
    completionState: "complete" as const,
    payload: { kind: "none" as const, redaction: "not_required" as const },
  };
  await fixture.service.accept("codex-1", {
    kind: "provider_metadata",
    correlation: { threadId: "thread-1" },
    output,
  });
  await fixture.service.accept("codex-1", {
    kind: "diagnostic",
    diagnostic: {
      code: "provider_warning",
      summary: "notice",
      correlation: { threadId: "thread-1" },
      redaction: "not_required",
    },
  });
  assert.equal(fixture.outputs.length, 0);

  await fixture.service.accept("codex-1", {
    kind: "provider_metadata",
    correlation: { threadId: "thread-1", turnId: "turn-1" },
    output,
  });
  assert.equal(fixture.outputs.length, 1);
});

test("unknown output writes reserve the count bound and retry only the same frozen command", async () => {
  const fixture = eventFixture({
    outputUnknownCount: 2,
    limits: { maxPersistedOutputsPerAttempt: 1 },
  });
  const handle = fixture.service.register(dispatch(), fixture.control);
  assert.ok(handle);
  await handle.settleStartTurn(acceptedTurn("turn-1"));

  const first = itemOutput("item-1", "first", "first");
  await fixture.service.accept("codex-1", first);
  await fixture.service.accept("codex-1", itemOutput("item-2", "second", "second"));
  assert.equal(fixture.outputs.length, 2);

  assert.equal(await fixture.service.retryRun("run-1"), true);
  assert.equal(fixture.outputs.length, 3);
  assert.deepEqual(fixture.outputs[0], fixture.outputs[1]);
  assert.deepEqual(fixture.outputs[1], fixture.outputs[2]);

  await fixture.service.accept("codex-1", itemOutput("item-2", "second", "second"));
  assert.equal(fixture.outputs.length, 3);
});

test("an unknown output remains ahead of later outputs until its exact command is confirmed", async () => {
  const fixture = eventFixture({ outputUnknownCount: 2 });
  const handle = fixture.service.register(dispatch(), fixture.control);
  assert.ok(handle);
  await handle.settleStartTurn(acceptedTurn("turn-1"));

  await fixture.service.accept("codex-1", itemOutput("item-1", "first", "first"));
  await fixture.service.accept("codex-1", itemOutput("item-2", "second", "second"));

  assert.equal(fixture.outputs.length, 4);
  assert.deepEqual(fixture.outputs[0], fixture.outputs[1]);
  assert.deepEqual(fixture.outputs[1], fixture.outputs[2]);
  assert.equal(fixture.outputs[2]?.item.providerItemId, "item-1");
  assert.equal(fixture.outputs[3]?.item.providerItemId, "item-2");

  await fixture.service.releaseGeneration("codex-1", { kind: "shutdown" });
  await handle.done;
});

test("accepted Dispatch resolution keeps its exact persistence owner through retry and generation release", async () => {
  const fixture = eventFixture({
    resolutionUnknownCount: 6,
    recoveryUnavailableCount: 3,
  });
  const handle = fixture.service.register(dispatch(), fixture.control);
  assert.ok(handle);

  await handle.settleStartTurn(acceptedTurn("turn-1"));
  assert.equal(await isSettled(handle.done), false);
  assert.deepEqual(await fixture.service.read({ sessionId: "session-1", runId: "run-1" }), null);

  assert.equal(await fixture.service.retryRun("run-1"), true);
  assert.equal(await isSettled(handle.done), false);
  await assert.rejects(
    fixture.service.releaseGeneration("codex-1", { kind: "shutdown" }),
    /persistence outcome is still unknown/u,
  );
  assert.equal(await isSettled(handle.done), false);

  await fixture.service.releaseGeneration("codex-1", { kind: "shutdown" });
  await handle.done;
  assert.equal(fixture.resolutions.length, 7);
  assert.ok(fixture.resolutions.every((command) => JSON.stringify(command) === JSON.stringify(fixture.resolutions[0])));
  assert.equal(fixture.terminals.length, 1);
  assert.equal(fixture.terminals[0]?.outcome.kind, "interrupted");
});

test("events received while an accepted resolution is unknown are replayed after exact confirmation", async () => {
  const fixture = eventFixture({
    resolutionUnknownCount: 4,
    recoveryUnavailableCount: 2,
  });
  const handle = fixture.service.register(dispatch(), fixture.control);
  assert.ok(handle);

  await handle.settleStartTurn(acceptedTurn("turn-1"));
  await fixture.service.accept("codex-1", itemOutput("item-1", "pending", "pending"));
  await fixture.service.accept("codex-1", {
    kind: "turn_terminal",
    threadId: "thread-1",
    turnId: "turn-1",
    status: "completed",
    finalAssistantMessage: null,
    contentFailure: null,
  });
  assert.equal(fixture.outputs.length, 0);
  assert.equal(fixture.terminals.length, 0);

  assert.equal(await fixture.service.retryRun("run-1"), true);
  assert.equal(await isSettled(handle.done), false);
  assert.equal(await fixture.service.retryRun("run-1"), true);
  assert.equal(await isSettled(handle.done), true);
  await handle.done;

  assert.equal(fixture.outputs.length, 1);
  assert.equal(fixture.terminals.length, 1);
  assert.ok(fixture.resolutions.every((command) => command.outcome.kind === "accepted"));
});

test("post-response terminal evidence survives an unknown ambiguous resolution and corrects it to accepted", async () => {
  const fixture = eventFixture({
    resolutionUnknownCount: 4,
    recoveryUnavailableCount: 2,
  });
  const handle = fixture.service.register(dispatch(), fixture.control);
  assert.ok(handle);

  await handle.settleStartTurn({
    kind: "ambiguous",
    effect: "unknown",
    code: "connection_lost",
  });
  await fixture.service.accept("codex-1", {
    kind: "turn_terminal",
    threadId: "thread-1",
    turnId: "turn-late",
    status: "completed",
    finalAssistantMessage: null,
    contentFailure: null,
  });
  assert.equal(fixture.terminals.length, 0);

  assert.equal(await fixture.service.retryRun("run-1"), true);
  assert.equal(await isSettled(handle.done), false);
  await fixture.service.releaseGeneration("codex-1", { kind: "shutdown" });
  await handle.done;

  assert.deepEqual(
    fixture.resolutions.map((command) => command.outcome.kind),
    ["ambiguous", "ambiguous", "ambiguous", "ambiguous", "ambiguous", "accepted"],
  );
  assert.equal(fixture.terminals.length, 1);
  assert.equal(fixture.terminals[0]?.outcome.kind, "completed");
});

test("ordered output and terminal evidence survive consecutive unknown ambiguous and accepted resolutions", async () => {
  const fixture = eventFixture({
    resolutionUnknownCountByOutcome: {
      ambiguous: 2,
      accepted: 2,
    },
    recoveryUnavailableCount: 2,
  });
  const handle = fixture.service.register(dispatch(), fixture.control);
  assert.ok(handle);

  await handle.settleStartTurn({
    kind: "ambiguous",
    effect: "unknown",
    code: "connection_lost",
  });
  await fixture.service.accept("codex-1", itemOutput("item-late", "pending", "pending", "turn-late"));
  await fixture.service.accept("codex-1", {
    kind: "turn_terminal",
    threadId: "thread-1",
    turnId: "turn-late",
    status: "completed",
    finalAssistantMessage: null,
    contentFailure: null,
  });

  await assert.rejects(
    fixture.service.releaseGeneration("codex-1", { kind: "shutdown" }),
    /persistence outcome is still unknown/u,
  );
  assert.equal(fixture.terminals.length, 0);
  assert.equal(await isSettled(handle.done), false);

  await fixture.service.releaseGeneration("codex-1", { kind: "shutdown" });
  await handle.done;

  assert.equal(fixture.outputs.length, 1);
  assert.equal(fixture.outputs[0]?.item.providerItemId, "item-late");
  assert.deepEqual(
    fixture.resolutions.map((command) => command.outcome.kind),
    ["ambiguous", "ambiguous", "ambiguous", "accepted", "accepted", "accepted"],
  );
  assert.equal(fixture.terminals.length, 1);
  assert.equal(fixture.terminals[0]?.outcome.kind, "completed");
});

test("terminal persistence waits until every frozen output command is confirmed", async () => {
  const fixture = eventFixture({ outputUnknownCount: 4 });
  const handle = fixture.service.register(dispatch(), fixture.control);
  assert.ok(handle);
  await handle.settleStartTurn(acceptedTurn("turn-1"));

  await fixture.service.accept("codex-1", itemOutput("item-1", "pending", "pending"));
  await fixture.service.accept("codex-1", {
    kind: "turn_terminal",
    threadId: "thread-1",
    turnId: "turn-1",
    status: "completed",
    finalAssistantMessage: null,
    contentFailure: null,
  });
  assert.equal(fixture.outputs.length, 4);
  assert.equal(fixture.terminals.length, 0);

  await handle.done;
  assert.equal(fixture.outputs.length, 5);
  assert.ok(fixture.outputs.every((command) => JSON.stringify(command) === JSON.stringify(fixture.outputs[0])));
  assert.equal(fixture.terminals.length, 1);
});

test("unconfirmed terminal and rejected resolution retain their exact retry owner", async () => {
  const terminal = eventFixture({ terminalUnknownCount: 2 });
  const terminalHandle = terminal.service.register(dispatch(), terminal.control);
  assert.ok(terminalHandle);
  await terminalHandle.settleStartTurn(acceptedTurn("turn-1"));
  await assert.rejects(
    terminal.service.releaseGeneration("codex-1", { kind: "shutdown" }),
    /persistence outcome is still unknown/u,
  );
  assert.equal((await terminal.service.read({ sessionId: "session-1", runId: "run-1" }))?.activity, "running");
  assert.equal(await isSettled(terminalHandle.done), false);

  await terminal.service.releaseGeneration("codex-1", { kind: "shutdown" });
  await terminalHandle.done;
  assert.equal(terminal.terminals.length, 3);
  assert.deepEqual(terminal.terminals[0], terminal.terminals[1]);
  assert.deepEqual(terminal.terminals[1], terminal.terminals[2]);

  const rejected = eventFixture({ resolutionUnknownCount: 2 });
  const rejectedHandle = rejected.service.register(dispatch(), rejected.control);
  assert.ok(rejectedHandle);
  await rejectedHandle.settleStartTurn({ kind: "not_sent", effect: "none", code: "capability_unavailable" });
  assert.equal(await isSettled(rejectedHandle.done), false);
  await rejected.service.releaseGeneration("codex-1", { kind: "shutdown" });
  await rejectedHandle.done;
  assert.equal(rejected.resolutions.length, 4);
  assert.ok(
    rejected.resolutions.every((command) => JSON.stringify(command) === JSON.stringify(rejected.resolutions[0])),
  );
  assert.equal(rejected.terminalized.length, 1);
  assert.equal(rejected.terminalized[0]?.outcomeKind, "failed");
  assert.equal(rejected.terminalized[0]?.failureOrigin, "application");
});

test("failed and interrupted terminal events never create a final Message", async () => {
  for (const status of ["failed", "interrupted"] as const) {
    const fixture = eventFixture();
    const handle = fixture.service.register(dispatch(), fixture.control);
    assert.ok(handle);
    await handle.settleStartTurn(acceptedTurn("turn-1"));
    await fixture.service.accept("codex-1", {
      kind: "turn_terminal",
      threadId: "thread-1",
      turnId: "turn-1",
      status,
      finalAssistantMessage: { contentBlocks: [{ type: "text", text: "ignored" }] },
      contentFailure: null,
    });
    await handle.done;
    assert.equal(fixture.terminals[0]?.outcome.kind, status);
    assert.equal(JSON.stringify(fixture.terminals).includes("ignored"), false);
  }
});

test("event bounds preserve terminal progress and safely map exact and overflowing output metadata", async () => {
  const fixture = eventFixture({
    limits: { maxBufferedEventsPerAttempt: 2, maxPersistedOutputsPerAttempt: 2 },
  });
  const handle = fixture.service.register(dispatch(), fixture.control);
  assert.ok(handle);
  await fixture.service.accept("codex-1", itemOutput("item-dropped", "dropped by the bound", "kind"));
  await fixture.service.accept("codex-1", itemOutput("item-survivor", "retained before terminal", "kind"));
  await fixture.service.accept("codex-1", {
    kind: "turn_terminal",
    threadId: "thread-1",
    turnId: "turn-1",
    status: "completed",
    finalAssistantMessage: null,
    contentFailure: null,
  });
  await handle.settleStartTurn(acceptedTurn("turn-1"));
  await handle.done;
  assert.equal(fixture.outputs.length, 1);
  assert.equal(fixture.outputs[0]?.item.providerItemId, "item-survivor");
  assert.equal(fixture.terminals.length, 1);
  assert.deepEqual(
    fixture.terminals[0]?.outputs.map((output) => output.kind),
    ["runtime_resource_limit"],
  );

  const metadata = eventFixture({
    limits: { maxPersistedOutputsPerAttempt: 2 },
  });
  const metadataHandle = metadata.service.register(dispatch(), metadata.control);
  assert.ok(metadataHandle);
  await metadataHandle.settleStartTurn(acceptedTurn("turn-1"));
  await metadata.service.accept("codex-1", itemOutput("item-exact", "s".repeat(4_096), "k".repeat(64)));
  await metadata.service.accept("codex-1", itemOutput("item-over", "s".repeat(4_097), "k".repeat(65)));
  await metadata.service.accept("codex-1", itemOutput("item-dropped", "third", "third"));
  assert.equal(metadata.outputs.length, 2);
  assert.equal(metadata.outputs[0]?.item.summary.length, 4_096);
  assert.equal(metadata.outputs[0]?.item.kind.length, 64);
  assert.equal(metadata.outputs[1]?.item.summary, "Provider output summary exceeded the persistence limit.");
  assert.equal(metadata.outputs[1]?.item.kind, "provider_output");
  await metadata.service.releaseGeneration("codex-1", { kind: "shutdown" });
  await metadataHandle.done;
  assert.deepEqual(
    metadata.terminals[0]?.outputs.map((output) => output.kind),
    ["runtime_resource_limit"],
  );

  const adapterOverflow = eventFixture();
  const adapterOverflowHandle = adapterOverflow.service.register(dispatch(), adapterOverflow.control);
  assert.ok(adapterOverflowHandle);
  await adapterOverflowHandle.settleStartTurn(acceptedTurn("turn-1"));
  await adapterOverflow.service.accept("codex-1", {
    kind: "turn_terminal",
    threadId: "thread-1",
    turnId: "turn-1",
    status: "completed",
    finalAssistantMessage: null,
    contentFailure: null,
    resourceLimitExceeded: true,
  });
  await adapterOverflowHandle.done;
  assert.equal(adapterOverflow.terminals[0]?.outcome.kind, "completed");
  assert.deepEqual(
    adapterOverflow.terminals[0]?.outputs.map((output) => output.kind),
    ["runtime_resource_limit"],
  );
});

test("Provider resource failures terminalize accepted execution with a resource diagnostic", async () => {
  for (const code of ["adapter_resource_limit", "event_queue_overflow"] as const) {
    const fixture = eventFixture();
    const handle = fixture.service.register(dispatch(), fixture.control);
    assert.ok(handle);
    await handle.settleStartTurn(acceptedTurn("turn-1"));

    await fixture.service.accept("codex-1", {
      kind: "connection_failure",
      code,
    });
    await handle.done;

    assert.equal(fixture.terminals[0]?.outcome.kind, "interrupted");
    assert.deepEqual(
      fixture.terminals[0]?.outputs.map((output) => output.kind),
      ["runtime_resource_limit"],
    );
  }
});

test("transport event queue overflow preserves a resource diagnostic for ambiguous execution", async () => {
  const fixture = eventFixture();
  const handle = fixture.service.register(dispatch(), fixture.control);
  assert.ok(handle);
  await handle.settleStartTurn({
    kind: "connection_failure",
    effect: "unknown",
    code: "event_queue_overflow",
  });

  await fixture.service.accept("codex-1", {
    kind: "connection_failure",
    code: "event_queue_overflow",
  });
  await handle.done;

  assert.equal(fixture.terminals[0]?.outcome.kind, "interrupted");
  assert.deepEqual(
    fixture.terminals[0]?.outputs.map((output) => output.kind),
    ["runtime_resource_limit"],
  );
});

test("Dispatch registration keeps runtime work owned until the Provider terminal event is durable", async () => {
  const fixture = eventFixture();
  const service = new ApplicationRunDispatchService({
    writes: {
      async beginRunDispatch(command) {
        return success({
          sessionId: command.sessionId,
          runId: command.runId,
          attemptId: command.attemptId,
          bindingId: command.bindingId,
          runPhase: "starting",
          dispatchState: "dispatching",
          dispatchingAt: 5,
          sendAllowed: true,
        });
      },
      resolveRunDispatch: fixture.writes.resolveRunDispatch,
    },
    attempts: fixture.service,
  });
  const control: ApplicationRunDispatchControl = {
    ...fixture.control,
    adapter: {
      async startTurn() {
        setImmediate(() => {
          void fixture.service.accept("codex-1", {
            kind: "turn_terminal",
            threadId: "thread-1",
            turnId: "turn-1",
            status: "completed",
            finalAssistantMessage: null,
            contentFailure: null,
          });
        });
        return acceptedTurn("turn-1");
      },
    } as never,
  };

  await service.ready(dispatch(), control);

  assert.deepEqual(
    fixture.resolutions.map((command) => command.outcome.kind),
    ["accepted"],
  );
  assert.equal(fixture.terminals.length, 1);
});

test("supplemental input sends once only after a fresh durable begin and persists the accepted outcome", async () => {
  const fixture = eventFixture();
  await activateInputOwner(fixture);
  const reservation = await reserveInput(fixture);

  fixture.service.handoff(inputHandoff(reservation, "input-message-1", 2));
  await waitFor(() => fixture.inputResolutions.length === 1);

  assert.equal(fixture.inputBegins.length, 1);
  assert.equal(fixture.steerInputs.length, 1);
  assert.deepEqual(fixture.steerInputs[0], {
    threadId: "thread-1",
    expectedTurnId: "turn-1",
    contentBlocks: [{ type: "text", text: "follow up" }],
  });
  assert.deepEqual(fixture.inputResolutions[0]?.outcome, { kind: "accepted" });
});

test("supplemental input preserves an ephemeral Binding owner token through every Repository Gate", async () => {
  const fixture = eventFixture();
  await activateInputOwner(
    fixture,
    dispatch({
      persistenceMode: "ephemeral",
      ephemeralOwnerToken: EPHEMERAL_OWNER_TOKEN,
    }),
  );
  const reservation = await reserveInput(fixture);

  assert.equal(fixture.resolutions[0]?.ephemeralOwnerToken, EPHEMERAL_OWNER_TOKEN);
  assert.equal(reservation.persistenceMode, "ephemeral");
  assert.equal(reservation.ephemeralOwnerToken, EPHEMERAL_OWNER_TOKEN);

  fixture.service.handoff(inputHandoff(reservation, "input-message-ephemeral", 2));
  await waitFor(() => fixture.inputResolutions.length === 1);

  assert.equal(fixture.inputBegins[0]?.ephemeralOwnerToken, EPHEMERAL_OWNER_TOKEN);
  assert.equal(fixture.inputResolutions[0]?.ephemeralOwnerToken, EPHEMERAL_OWNER_TOKEN);
  assert.equal(fixture.steerInputs.length, 1);
});

test("a replayed earlier ordinal unblocks a retryable later input without losing its live delivery owner", async () => {
  const fixture = eventFixture({
    async inputBeginOperation(command, call) {
      if (command.messageId === "input-message-later" && call === 1) {
        return {
          ok: false,
          error: {
            code: "lifecycle_conflict",
            message: "An earlier supplemental input is unresolved.",
            retryable: true,
          },
          replayed: false,
        };
      }
      return {
        ok: true,
        replayed: false,
        value: {
          sessionId: command.sessionId,
          runId: command.runId,
          attemptId: command.attemptId,
          messageId: command.messageId,
          bindingId: command.bindingId,
          deliveryState: "dispatching",
          dispatchingAt: 15,
          sendAllowed: true,
        },
      };
    },
  });
  await activateInputOwner(fixture);

  const later = await reserveInput(fixture);
  fixture.service.handoff(inputHandoff(later, "input-message-later", 3, "later"));
  await waitFor(() => fixture.inputBegins.length === 1);

  const earlierReplay = await reserveInput(fixture);
  fixture.service.handoff(inputHandoff(earlierReplay, "input-message-earlier", 2, "earlier"));
  await waitFor(() => fixture.steerInputs.length === 2);

  assert.deepEqual(
    fixture.inputBegins.map((command) => command.messageId),
    ["input-message-later", "input-message-earlier", "input-message-later"],
  );
  assert.deepEqual(
    fixture.steerInputs.map((input) => input.contentBlocks),
    [[{ type: "text", text: "earlier" }], [{ type: "text", text: "later" }]],
  );
  assert.deepEqual(
    fixture.inputResolutions.map((command) => command.messageId),
    ["input-message-earlier", "input-message-later"],
  );
});

test("begin replay never sends and converges the dispatching Delivery to ambiguous", async () => {
  for (const options of [{ inputBeginAlreadyCommitted: true }, { inputBeginReplayWithSendAllowed: true }]) {
    const fixture = eventFixture(options);
    await activateInputOwner(fixture);
    const reservation = await reserveInput(fixture);

    fixture.service.handoff(inputHandoff(reservation, "input-message-1", 2));
    await waitFor(() => fixture.inputResolutions.length === 1);

    assert.equal(fixture.steerInputs.length, 0);
    assert.deepEqual(fixture.inputResolutions[0]?.outcome, {
      kind: "ambiguous",
      resolutionCode: "process_unknown",
    });
  }
});

test("duplicate pending handoff is deduplicated while the frozen resolution retries without another Provider call", async () => {
  const fixture = eventFixture({ inputResolutionUnknownCount: 6 });
  await activateInputOwner(fixture);
  const first = await reserveInput(fixture);
  fixture.service.handoff(inputHandoff(first, "input-message-1", 2));
  await waitFor(() => fixture.inputResolutions.length >= 2);

  const replay = await reserveInput(fixture);
  fixture.service.handoff(inputHandoff(replay, "input-message-1", 2));
  await waitFor(() => fixture.inputResolutions.length === 7);

  assert.equal(fixture.steerInputs.length, 1);
  assert.ok(
    fixture.inputResolutions.every(
      (command) => JSON.stringify(command) === JSON.stringify(fixture.inputResolutions[0]),
    ),
  );
});

test("supplemental input maps bounded Provider outcomes without retaining raw Provider codes", async () => {
  const cases = [
    {
      result: { kind: "rejected", effect: "none", code: -32_000 } as const,
      expected: { kind: "rejected", resolutionCode: "provider_rejected" } as const,
    },
    {
      result: { kind: "not_sent", effect: "none", code: "capability_unavailable" } as const,
      expected: { kind: "rejected", resolutionCode: "delivery_not_sent" } as const,
    },
    {
      result: { kind: "ambiguous", effect: "unknown", code: "connection_lost" } as const,
      expected: { kind: "ambiguous", resolutionCode: "transport_unknown" } as const,
    },
    {
      result: { kind: "connection_failure", effect: "unknown", code: "process_exited" } as const,
      expected: { kind: "ambiguous", resolutionCode: "process_unknown" } as const,
    },
  ];
  for (const [index, entry] of cases.entries()) {
    const fixture = eventFixture({ steerResult: entry.result });
    await activateInputOwner(fixture);
    const reservation = await reserveInput(fixture);
    fixture.service.handoff(inputHandoff(reservation, `input-message-${index}`, index + 2));
    await waitFor(() => fixture.inputResolutions.length === 1);

    assert.deepEqual(fixture.inputResolutions[0]?.outcome, entry.expected);
    assert.equal(JSON.stringify(fixture.inputResolutions).includes(String(entry.result.code)), false);
  }
});

test("stale owner, waiting promotion, reservation abort, and capacity bounds never transfer input", async () => {
  let current = true;
  const fixture = eventFixture({
    isCurrent: () => current,
    limits: { maxPendingInputsPerAttempt: 1, maxTrackedInputs: 1 },
  });
  await activateInputOwner(fixture);
  const reservation = await reserveInput(fixture);
  const full = await fixture.service.preflight({ sessionId: "session-1", runId: "run-1" });
  assert.equal(full.ok, false);
  assert.equal(!full.ok && full.error.code, "capacity_exceeded");

  fixture.service.release(reservation);
  const abort = new AbortController();
  const released = await reserveInput(fixture, abort.signal);
  abort.abort();
  const next = await reserveInput(fixture);
  fixture.service.release(next);

  const stale = await reserveInput(fixture);
  current = false;
  fixture.service.handoff(inputHandoff(stale, "input-message-stale", 2));
  await waitFor(() => fixture.inputResolutions.length === 1);

  assert.equal(released.token === next.token, false);
  assert.equal(fixture.inputBegins.length, 1);
  assert.equal(fixture.steerInputs.length, 0);
  assert.deepEqual(fixture.inputResolutions[0]?.outcome, {
    kind: "rejected",
    resolutionCode: "delivery_not_sent",
  });
  current = true;
  const afterStale = await reserveInput(fixture);
  fixture.service.release(afterStale);

  let promotionCurrent = true;
  const promotion = eventFixture({
    isCurrent: () => promotionCurrent,
    limits: { maxPendingInputsPerAttempt: 2, maxTrackedInputs: 2 },
  });
  await activateInputOwner(promotion);
  const promotionFirst = await reserveInput(promotion);
  const promotionWaiting = promotion.service.preflight({ sessionId: "session-1", runId: "run-1" });
  await new Promise((resolve) => setImmediate(resolve));
  promotionCurrent = false;
  promotion.service.release(promotionFirst);
  const stalePromotion = await promotionWaiting;
  assert.equal(stalePromotion.ok, false);
  assert.equal(!stalePromotion.ok && stalePromotion.error.code, "lifecycle_conflict");
  assert.equal(promotion.inputBegins.length, 0);
  assert.equal(promotion.steerInputs.length, 0);

  promotionCurrent = true;
  const promotionRecovered = await reserveInput(promotion);
  promotion.service.release(promotionRecovered);
});

test("terminal ordering before handoff or after an unresolved send never creates a second external effect", async () => {
  const beforeHandoff = eventFixture();
  const beforeHandle = beforeHandoff.service.register(dispatch(), beforeHandoff.control);
  assert.ok(beforeHandle);
  await beforeHandle.settleStartTurn(acceptedTurn("turn-1"));
  const reserved = await reserveInput(beforeHandoff);
  const waiting = beforeHandoff.service.preflight({ sessionId: "session-1", runId: "run-1" });
  await new Promise((resolve) => setImmediate(resolve));
  await beforeHandoff.service.accept("codex-1", terminalEvent());
  await beforeHandle.done;
  const waitingAfterTerminal = await waiting;
  assert.equal(waitingAfterTerminal.ok, false);
  assert.equal(!waitingAfterTerminal.ok && waitingAfterTerminal.error.code, "lifecycle_conflict");
  beforeHandoff.service.handoff(inputHandoff(reserved, "input-message-before", 2));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(beforeHandoff.inputBegins.length, 0);
  assert.equal(beforeHandoff.steerInputs.length, 0);

  let settleSteer!: (value: Awaited<ReturnType<NonNullable<ApplicationRunProviderAdapterPort["steerTurn"]>>>) => void;
  const afterBegin = eventFixture({
    inputResolutionUnknownCount: 100,
    steerOperation: () =>
      new Promise((resolve) => {
        settleSteer = resolve;
      }),
  });
  const afterHandle = afterBegin.service.register(dispatch(), afterBegin.control);
  assert.ok(afterHandle);
  await afterHandle.settleStartTurn(acceptedTurn("turn-1"));
  const afterReservation = await reserveInput(afterBegin);
  afterBegin.service.handoff(inputHandoff(afterReservation, "input-message-after", 2));
  await waitFor(() => afterBegin.steerInputs.length === 1);
  const terminal = afterBegin.service.accept("codex-1", terminalEvent());
  settleSteer({
    kind: "accepted",
    effect: "present",
    value: { threadId: "thread-1", turnId: "turn-1" },
  });
  await terminal;
  await afterHandle.done;
  const resolutionAttempts = afterBegin.inputResolutions.length;
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.equal(afterBegin.steerInputs.length, 1);
  assert.equal(afterBegin.inputResolutions.length, resolutionAttempts);
  assert.ok(
    afterBegin.inputResolutions.every(
      (command) => JSON.stringify(command) === JSON.stringify(afterBegin.inputResolutions[0]),
    ),
  );

  let releaseLeading!: (
    value: Awaited<ReturnType<NonNullable<ApplicationRunProviderAdapterPort["steerTurn"]>>>,
  ) => void;
  let queuedSteerCalls = 0;
  const queuedTerminal = eventFixture({
    terminalUnknownCount: 2,
    steerOperation: (input) => {
      queuedSteerCalls += 1;
      if (queuedSteerCalls === 1) {
        return new Promise((resolve) => {
          releaseLeading = resolve;
        });
      }
      return Promise.resolve({
        kind: "accepted",
        effect: "present",
        value: { threadId: input.threadId, turnId: input.expectedTurnId },
      });
    },
  });
  const queuedHandle = queuedTerminal.service.register(dispatch(), queuedTerminal.control);
  assert.ok(queuedHandle);
  await queuedHandle.settleStartTurn(acceptedTurn("turn-1"));
  const leading = await reserveInput(queuedTerminal);
  const followingReservation = reserveInput(queuedTerminal);
  await new Promise((resolve) => setImmediate(resolve));
  queuedTerminal.service.handoff(inputHandoff(leading, "input-message-leading", 2, "leading"));
  const following = await followingReservation;
  queuedTerminal.service.handoff(inputHandoff(following, "input-message-following", 3, "following"));
  await waitFor(() => queuedTerminal.steerInputs.length === 1);
  const queuedTerminalEvent = queuedTerminal.service.accept("codex-1", terminalEvent());
  releaseLeading({
    kind: "accepted",
    effect: "present",
    value: { threadId: "thread-1", turnId: "turn-1" },
  });
  await queuedTerminalEvent;
  const afterTerminalPreflight = await queuedTerminal.service.preflight({
    sessionId: "session-1",
    runId: "run-1",
  });
  assert.equal(afterTerminalPreflight.ok, false);
  assert.equal(!afterTerminalPreflight.ok && afterTerminalPreflight.error.code, "lifecycle_conflict");
  await queuedHandle.done;

  assert.deepEqual(
    queuedTerminal.inputBegins.map((command) => command.messageId),
    ["input-message-leading"],
  );
  assert.equal(queuedTerminal.steerInputs.length, 1);
  assert.equal(queuedTerminal.terminals.length, 3);
  assert.ok(
    queuedTerminal.terminals.every(
      (command) => JSON.stringify(command) === JSON.stringify(queuedTerminal.terminals[0]),
    ),
  );
});

test("terminal convergence preserves an accepted input after its resolution response is lost", async () => {
  let terminal!: Promise<void>;
  let fixture!: ReturnType<typeof eventFixture>;
  fixture = eventFixture({
    inputResolutionOperation(command, call) {
      if (call === 1) {
        terminal = fixture.service.accept("codex-1", terminalEvent());
      }
      if (call <= 2) {
        throw unknownPersistenceFailure();
      }
      return Promise.resolve(
        success({
          sessionId: command.sessionId,
          runId: command.runId,
          attemptId: command.attemptId,
          messageId: command.messageId,
          bindingId: command.bindingId,
          deliveryState: command.outcome.kind,
          resolutionCode: command.outcome.kind === "accepted" ? null : command.outcome.resolutionCode,
          resolvedAt: 16,
        }),
      );
    },
  });
  const handle = fixture.service.register(dispatch(), fixture.control);
  assert.ok(handle);
  await handle.settleStartTurn(acceptedTurn("turn-1"));
  const reservation = await reserveInput(fixture);
  fixture.service.handoff(inputHandoff(reservation, "input-message-accepted-before-terminal", 2));

  await terminal;
  await handle.done;

  assert.equal(fixture.steerInputs.length, 1);
  assert.equal(fixture.terminals.length, 1);
  assert.equal(fixture.inputDeliveryStates.get("input-message-accepted-before-terminal"), "accepted");
  assert.ok(
    fixture.inputResolutions.every(
      (command) => JSON.stringify(command) === JSON.stringify(fixture.inputResolutions[0]),
    ),
  );
});

test("terminal convergence persists a not-sent resolution created by a retried begin", async () => {
  let terminal!: Promise<void>;
  let fixture!: ReturnType<typeof eventFixture>;
  fixture = eventFixture({
    inputBeginOperation(command, call) {
      fixture.inputDeliveryStates.set(command.messageId, "dispatching");
      if (call === 1) {
        terminal = fixture.service.accept("codex-1", terminalEvent());
      }
      if (call <= 2) {
        throw unknownPersistenceFailure();
      }
      return Promise.resolve({
        ok: true,
        replayed: false,
        value: {
          sessionId: command.sessionId,
          runId: command.runId,
          attemptId: command.attemptId,
          messageId: command.messageId,
          bindingId: command.bindingId,
          deliveryState: "dispatching",
          dispatchingAt: 15,
          sendAllowed: true,
        },
      });
    },
    inputResolutionOperation(command, call) {
      if (call <= 2) {
        throw unknownPersistenceFailure();
      }
      return Promise.resolve(
        success({
          sessionId: command.sessionId,
          runId: command.runId,
          attemptId: command.attemptId,
          messageId: command.messageId,
          bindingId: command.bindingId,
          deliveryState: command.outcome.kind,
          resolutionCode: command.outcome.kind === "accepted" ? null : command.outcome.resolutionCode,
          resolvedAt: 16,
        }),
      );
    },
  });
  const handle = fixture.service.register(dispatch(), fixture.control);
  assert.ok(handle);
  await handle.settleStartTurn(acceptedTurn("turn-1"));
  const reservation = await reserveInput(fixture);
  fixture.service.handoff(inputHandoff(reservation, "input-message-retried-begin-before-terminal", 2));

  await waitFor(() => fixture.inputBegins.length >= 1);
  await terminal;
  await handle.done;

  assert.equal(fixture.steerInputs.length, 0);
  assert.equal(fixture.terminals.length, 1);
  assert.equal(fixture.inputDeliveryStates.get("input-message-retried-begin-before-terminal"), "rejected");
  assert.ok(
    fixture.inputResolutions.every(
      (command) =>
        command.outcome.kind === "rejected" &&
        command.outcome.resolutionCode === "delivery_not_sent" &&
        JSON.stringify(command) === JSON.stringify(fixture.inputResolutions[0]),
    ),
  );
});

test("parallel supplemental inputs serialize admission before Message ordinals and release their bounded slots", async () => {
  let releaseFirst!: (value: Awaited<ReturnType<NonNullable<ApplicationRunProviderAdapterPort["steerTurn"]>>>) => void;
  let steerCalls = 0;
  const fixture = eventFixture({
    steerOperation: (input) => {
      steerCalls += 1;
      if (steerCalls === 1) {
        return new Promise((resolve) => {
          releaseFirst = resolve;
        });
      }
      return Promise.resolve({
        kind: "accepted",
        effect: "present",
        value: { threadId: input.threadId, turnId: input.expectedTurnId },
      });
    },
    limits: { maxPendingInputsPerAttempt: 2 },
  });
  await activateInputOwner(fixture);
  const first = await reserveInput(fixture);
  const waitingAbort = new AbortController();
  const abortedReservation = fixture.service.preflight(
    { sessionId: "session-1", runId: "run-1" },
    { signal: waitingAbort.signal },
  );
  await new Promise((resolve) => setImmediate(resolve));
  waitingAbort.abort();
  const aborted = await abortedReservation;
  assert.equal(aborted.ok, false);
  assert.equal(!aborted.ok && aborted.error.code, "lifecycle_conflict");

  let secondReady = false;
  const secondReservation = reserveInput(fixture).then((reservation) => {
    secondReady = true;
    return reservation;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(secondReady, false);

  fixture.service.handoff(inputHandoff(first, "input-message-1", 2, "first"));
  const second = await secondReservation;
  fixture.service.handoff(inputHandoff(second, "input-message-2", 3, "second"));
  await waitFor(() => fixture.steerInputs.length === 1);
  assert.equal(fixture.steerInputs[0]?.contentBlocks[0]?.text, "first");
  releaseFirst({
    kind: "accepted",
    effect: "present",
    value: { threadId: "thread-1", turnId: "turn-1" },
  });
  await waitFor(() => fixture.steerInputs.length === 2);
  assert.equal(fixture.steerInputs[1]?.contentBlocks[0]?.text, "second");

  const availableAgain = await reserveInput(fixture);
  fixture.service.release(availableAgain);
});

test("a settled supplemental input releases a single pending slot for the next preflight", async () => {
  const fixture = eventFixture({
    limits: { maxPendingInputsPerAttempt: 1 },
  });
  await activateInputOwner(fixture);
  const first = await reserveInput(fixture);
  fixture.service.handoff(inputHandoff(first, "input-message-1", 2, "first"));
  await waitFor(() => fixture.inputResolutions.length === 1);

  const second = await reserveInput(fixture);
  fixture.service.release(second);
});

test("a non-terminal input resolution failure retains its pending slot until the Attempt closes", async () => {
  const fixture = eventFixture({
    inputResolutionOperation: () =>
      Promise.resolve({
        ok: false,
        error: {
          code: "lifecycle_conflict",
          message: "Run input resolution state changed.",
          retryable: false,
        },
        replayed: false,
      }),
    limits: { maxPendingInputsPerAttempt: 1 },
  });
  const handle = fixture.service.register(dispatch(), fixture.control);
  assert.ok(handle);
  await handle.settleStartTurn(acceptedTurn("turn-1"));
  const reservation = await reserveInput(fixture);
  fixture.service.handoff(inputHandoff(reservation, "input-message-blocked", 2));
  await waitFor(() => fixture.inputResolutions.length === 1);

  const full = await fixture.service.preflight({ sessionId: "session-1", runId: "run-1" });
  assert.equal(full.ok, false);
  assert.equal(!full.ok && full.error.code, "capacity_exceeded");
  if (full.ok || full.error.code !== "capacity_exceeded") throw new Error("input capacity was not preserved");
  assert.equal(full.error.details.current, 1);

  await fixture.service.accept("codex-1", terminalEvent());
  await handle.done;
  assert.equal(fixture.terminals.length, 1);
});

test("a stale owner detected after durable begin resolves not-sent without calling Provider", async () => {
  let current = true;
  const fixture = eventFixture({
    isCurrent: () => current,
    afterInputBegin: () => {
      current = false;
    },
  });
  await activateInputOwner(fixture);
  const reservation = await reserveInput(fixture);
  fixture.service.handoff(inputHandoff(reservation, "input-message-stale-after-begin", 2));
  await waitFor(() => fixture.inputResolutions.length === 1);

  assert.equal(fixture.inputBegins.length, 1);
  assert.equal(fixture.steerInputs.length, 0);
  assert.deepEqual(fixture.inputResolutions[0]?.outcome, {
    kind: "rejected",
    resolutionCode: "delivery_not_sent",
  });
});

test("generation release retains a frozen input resolution until persistence closure succeeds", async () => {
  const fixture = eventFixture({ inputResolutionUnknownCount: 4 });
  const handle = fixture.service.register(dispatch(), fixture.control);
  assert.ok(handle);
  await handle.settleStartTurn(acceptedTurn("turn-1"));
  const reservation = await reserveInput(fixture);
  fixture.service.handoff(inputHandoff(reservation, "input-message-shutdown", 2));
  await waitFor(() => fixture.inputResolutions.length === 2);

  await assert.rejects(
    fixture.service.releaseGeneration("codex-1", { kind: "shutdown" }),
    /persistence outcome is still unknown/u,
  );
  await waitFor(() => fixture.inputResolutions.length === 5);
  assert.equal(fixture.steerInputs.length, 1);
  assert.ok(
    fixture.inputResolutions.every(
      (command) => JSON.stringify(command) === JSON.stringify(fixture.inputResolutions[0]),
    ),
  );

  await waitFor(() => fixture.terminals.length === 1);
  await handle.done;
  assert.equal(fixture.terminals.length, 1);
});

test("a fresh durable cancel handoff invokes the current Provider receiver at most once", async () => {
  const callerAbort = new AbortController();
  const fixture = eventFixture({ receiverSensitiveInterrupt: true });
  const handle = fixture.service.register(dispatch(), fixture.control);
  assert.ok(handle);
  await handle.settleStartTurn(acceptedTurn("turn-1"));

  const reservation = await reserveCancel(fixture, callerAbort.signal);
  const record = cancelHandoff(reservation);
  fixture.service.cancelOwner.handoff(record);
  callerAbort.abort();
  fixture.service.cancelOwner.handoff(record);
  await waitFor(() => fixture.interruptInputs.length === 1);

  assert.deepEqual(fixture.interruptInputs, [{ threadId: "thread-1", turnId: "turn-1" }]);
  assert.equal(fixture.interruptSignals[0], fixture.control.signal);
  assert.equal(fixture.interruptSignals[0]?.aborted, false);
  assert.equal(fixture.terminals.length, 0);
  assert.equal(fixture.terminalized.length, 0);
  assert.equal((await fixture.service.read({ sessionId: "session-1", runId: "run-1" }))?.activity, "running");

  const duplicate = await fixture.service.cancelOwner.preflight({
    sessionId: "session-1",
    runId: "run-1",
  });
  assert.equal(duplicate.ok, false);
  assert.equal(!duplicate.ok && duplicate.error.code, "lifecycle_conflict");

  await fixture.service.accept("codex-1", terminalEvent());
  await handle.done;
  assert.equal(fixture.terminals[0]?.outcome.kind, "completed");
  assert.deepEqual(fixture.terminals[0]?.cancelCorrelation, { kind: "none" });
});

test("released, stale, terminal, and retired cancel owners never call Provider", async () => {
  let current = true;
  const fixture = eventFixture({ isCurrent: () => current });
  const handle = fixture.service.register(dispatch(), fixture.control);
  assert.ok(handle);
  await handle.settleStartTurn(acceptedTurn("turn-1"));

  const callerAbort = new AbortController();
  const aborted = await reserveCancel(fixture, callerAbort.signal);
  callerAbort.abort();
  fixture.service.cancelOwner.handoff(cancelHandoff(aborted));

  const released = await reserveCancel(fixture);
  fixture.service.cancelOwner.release(released);

  const stale = await reserveCancel(fixture);
  current = false;
  fixture.service.cancelOwner.handoff(cancelHandoff(stale));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.interruptInputs.length, 0);

  current = true;
  await fixture.service.accept("codex-1", terminalEvent());
  await handle.done;
  fixture.service.cancelOwner.handoff(cancelHandoff(stale));
  assert.equal(fixture.interruptInputs.length, 0);
  assert.equal(fixture.terminals[0]?.outcome.kind, "completed");

  const retired = eventFixture();
  const retiredHandle = retired.service.register(dispatch(), retired.control);
  assert.ok(retiredHandle);
  await retiredHandle.settleStartTurn(acceptedTurn("turn-1"));
  const retiredReservation = await reserveCancel(retired);
  await retired.service.releaseGeneration("codex-1", { kind: "shutdown" });
  await retiredHandle.done;
  retired.service.cancelOwner.handoff(cancelHandoff(retiredReservation));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(retired.interruptInputs.length, 0);
});

test("a non-accepted interrupt disposition converges to interrupted without retrying Provider", async () => {
  for (const interruptResult of [
    { kind: "not_sent", effect: "none", code: "capability_unavailable" },
    { kind: "rejected", effect: "none", code: -32_000 },
    { kind: "ambiguous", effect: "unknown", code: "timeout" },
    { kind: "connection_failure", effect: "unknown", code: "process_exited" },
  ] as const) {
    const fixture = eventFixture({ interruptResult });
    const handle = fixture.service.register(dispatch(), fixture.control);
    assert.ok(handle);
    await handle.settleStartTurn(acceptedTurn("turn-1"));
    const reservation = await reserveCancel(fixture);
    fixture.service.cancelOwner.handoff(cancelHandoff(reservation));
    await waitFor(() => fixture.interruptInputs.length === 1);
    await handle.done;

    assert.equal(fixture.interruptInputs.length, 1);
    assert.equal(fixture.terminals.length, 1);
    assert.equal(fixture.terminals[0]?.outcome.kind, "interrupted");
    assert.deepEqual(fixture.terminals[0]?.cancelCorrelation, { kind: "none" });
    assert.equal(fixture.terminalized.length, 0);

    await fixture.service.accept("codex-1", terminalEvent());
    assert.equal(fixture.terminals.length, 1);
  }
});

test("a matching interrupted terminal acknowledges the admitted user cancel", async () => {
  const fixture = eventFixture();
  const handle = fixture.service.register(dispatch(), fixture.control);
  assert.ok(handle);
  await handle.settleStartTurn(acceptedTurn("turn-1"));
  const reservation = await reserveCancel(fixture);
  fixture.service.cancelOwner.handoff(cancelHandoff(reservation));
  await waitFor(() => fixture.interruptInputs.length === 1);

  await fixture.service.accept("codex-1", terminalEvent("interrupted"));
  await handle.done;

  assert.equal(fixture.terminals.length, 1);
  assert.deepEqual(fixture.terminals[0]?.outcome, { kind: "canceled" });
  assert.deepEqual(fixture.terminals[0]?.cancelCorrelation, {
    kind: "admitted_user_cancel",
    cancelRequestedAt: 10,
  });
});

test("an interrupted terminal waits for durable cancel handoff before choosing its outcome", async () => {
  const fixture = eventFixture();
  const handle = fixture.service.register(dispatch(), fixture.control);
  assert.ok(handle);
  await handle.settleStartTurn(acceptedTurn("turn-1"));
  const reservation = await reserveCancel(fixture);

  const terminal = fixture.service.accept("codex-1", terminalEvent("interrupted"));
  assert.equal(await isSettled(terminal), false);

  fixture.service.cancelOwner.handoff(cancelHandoff(reservation));
  await terminal;
  await handle.done;

  assert.equal(fixture.interruptInputs.length, 0);
  assert.deepEqual(fixture.terminals[0]?.outcome, { kind: "canceled" });
  assert.deepEqual(fixture.terminals[0]?.cancelCorrelation, {
    kind: "admitted_user_cancel",
    cancelRequestedAt: 10,
  });
});

test("an interrupted terminal recovers durable cancel correlation after admission response loss", async () => {
  const fixture = eventFixture({
    persistedRunCancel: { phase: "canceling", requestedAt: 11 },
  });
  const handle = fixture.service.register(dispatch(), fixture.control);
  assert.ok(handle);
  await handle.settleStartTurn(acceptedTurn("turn-1"));
  const reservation = await reserveCancel(fixture);

  const terminal = fixture.service.accept("codex-1", terminalEvent("interrupted"));
  assert.equal(await isSettled(terminal), false);

  fixture.service.cancelOwner.release(reservation);
  await terminal;
  await handle.done;

  assert.equal(fixture.interruptInputs.length, 0);
  assert.deepEqual(fixture.terminals[0]?.outcome, { kind: "canceled" });
  assert.deepEqual(fixture.terminals[0]?.cancelCorrelation, {
    kind: "admitted_user_cancel",
    cancelRequestedAt: 11,
  });
});

test("an interrupted terminal recovers durable cancel correlation after the lost admission releases its owner", async () => {
  const fixture = eventFixture({
    persistedRunCancel: { phase: "canceling", requestedAt: 12 },
  });
  const handle = fixture.service.register(dispatch(), fixture.control);
  assert.ok(handle);
  await handle.settleStartTurn(acceptedTurn("turn-1"));
  const reservation = await reserveCancel(fixture);

  fixture.service.cancelOwner.release(reservation);
  await fixture.service.accept("codex-1", terminalEvent("interrupted"));
  await handle.done;

  assert.equal(fixture.interruptInputs.length, 0);
  assert.deepEqual(fixture.terminals[0]?.outcome, { kind: "canceled" });
  assert.deepEqual(fixture.terminals[0]?.cancelCorrelation, {
    kind: "admitted_user_cancel",
    cancelRequestedAt: 12,
  });
});

test("an interrupted terminal remains uncorrelated when cancel admission did not commit", async () => {
  const fixture = eventFixture();
  const handle = fixture.service.register(dispatch(), fixture.control);
  assert.ok(handle);
  await handle.settleStartTurn(acceptedTurn("turn-1"));
  const reservation = await reserveCancel(fixture);

  const terminal = fixture.service.accept("codex-1", terminalEvent("interrupted"));
  assert.equal(await isSettled(terminal), false);

  fixture.service.cancelOwner.release(reservation);
  await terminal;
  await handle.done;

  assert.deepEqual(fixture.terminals[0]?.outcome, {
    kind: "interrupted",
    failureOrigin: "provider",
    providerErrorCode: null,
    errorSummary: "Provider execution was interrupted.",
  });
  assert.deepEqual(fixture.terminals[0]?.cancelCorrelation, { kind: "none" });
});

test("a matching canceled terminal retries only its frozen correlation after response loss", async () => {
  const fixture = eventFixture({ terminalUnknownCount: 2 });
  const handle = fixture.service.register(dispatch(), fixture.control);
  assert.ok(handle);
  await handle.settleStartTurn(acceptedTurn("turn-1"));
  const reservation = await reserveCancel(fixture);
  fixture.service.cancelOwner.handoff(cancelHandoff(reservation));
  await waitFor(() => fixture.interruptInputs.length === 1);

  await fixture.service.accept("codex-1", terminalEvent("interrupted"));
  await handle.done;

  assert.equal(fixture.terminals.length, 3);
  assert.ok(
    fixture.terminals.every(
      (command) =>
        command.outcome.kind === "canceled" &&
        command.cancelCorrelation.kind === "admitted_user_cancel" &&
        JSON.stringify(command) === JSON.stringify(fixture.terminals[0]),
    ),
  );
  assert.equal(fixture.interruptInputs.length, 1);
});

test("cancel terminal waits for a frozen output persistence retry before acknowledging", async () => {
  const fixture = eventFixture({ outputUnknownCount: 2 });
  const handle = fixture.service.register(dispatch(), fixture.control);
  assert.ok(handle);
  await handle.settleStartTurn(acceptedTurn("turn-1"));
  await fixture.service.accept("codex-1", itemOutput("item-before-cancel", "persist me", "reasoning"));
  const reservation = await reserveCancel(fixture);
  fixture.service.cancelOwner.handoff(cancelHandoff(reservation));
  await waitFor(() => fixture.interruptInputs.length === 1);

  await fixture.service.accept("codex-1", terminalEvent("interrupted"));
  await handle.done;

  assert.equal(fixture.outputs.length, 3);
  assert.ok(fixture.outputs.every((command) => JSON.stringify(command) === JSON.stringify(fixture.outputs[0])));
  assert.equal(fixture.terminals.length, 1);
  assert.equal(fixture.terminals[0]?.outcome.kind, "canceled");
});

test("wrong-Turn and old-generation interruption evidence cannot acknowledge a user cancel", async () => {
  const fixture = eventFixture();
  const handle = fixture.service.register(dispatch(), fixture.control);
  assert.ok(handle);
  await handle.settleStartTurn(acceptedTurn("turn-1"));
  const reservation = await reserveCancel(fixture);
  fixture.service.cancelOwner.handoff(cancelHandoff(reservation));
  await waitFor(() => fixture.interruptInputs.length === 1);

  await fixture.service.accept("codex-old", terminalEvent("interrupted"));
  await fixture.service.accept("codex-1", {
    ...terminalEvent("interrupted"),
    turnId: "turn-other",
  });
  await fixture.service.releaseGeneration("codex-1", { kind: "shutdown" });
  await handle.done;

  assert.equal(fixture.terminals.length, 1);
  assert.equal(fixture.terminals[0]?.outcome.kind, "interrupted");
  assert.deepEqual(fixture.terminals[0]?.cancelCorrelation, { kind: "none" });
});

test("queued actual terminal evidence wins over a later non-accepted interrupt response", async () => {
  for (const scenario of [
    {
      status: "interrupted",
      interruptResult: { kind: "rejected", effect: "none", code: -32_000 },
      expected: "canceled",
    },
    {
      status: "completed",
      interruptResult: { kind: "ambiguous", effect: "unknown", code: "timeout" },
      expected: "completed",
    },
    {
      status: "failed",
      interruptResult: { kind: "not_sent", effect: "none", code: "capability_unavailable" },
      expected: "failed",
    },
  ] as const) {
    let settleInterrupt!: (
      value: Awaited<ReturnType<NonNullable<ApplicationRunProviderAdapterPort["interruptTurn"]>>>,
    ) => void;
    const fixture = eventFixture({
      interruptOperation: () =>
        new Promise((resolve) => {
          settleInterrupt = resolve;
        }),
    });
    const handle = fixture.service.register(dispatch(), fixture.control);
    assert.ok(handle);
    await handle.settleStartTurn(acceptedTurn("turn-1"));
    const reservation = await reserveCancel(fixture);
    fixture.service.cancelOwner.handoff(cancelHandoff(reservation));
    await waitFor(() => fixture.interruptInputs.length === 1);

    const terminal = fixture.service.accept("codex-1", terminalEvent(scenario.status));
    settleInterrupt(scenario.interruptResult);
    await terminal;
    await handle.done;

    assert.equal(fixture.interruptInputs.length, 1);
    assert.equal(fixture.terminals.length, 1);
    assert.equal(fixture.terminals[0]?.outcome.kind, scenario.expected);
    assert.deepEqual(
      fixture.terminals[0]?.cancelCorrelation,
      scenario.expected === "canceled" ? { kind: "admitted_user_cancel", cancelRequestedAt: 10 } : { kind: "none" },
    );
  }
});

test("cancel handoff releases a reserved supplemental input before either Provider mutation", async () => {
  const fixture = eventFixture();
  const handle = fixture.service.register(dispatch(), fixture.control);
  assert.ok(handle);
  await handle.settleStartTurn(acceptedTurn("turn-1"));
  const input = await reserveInput(fixture);
  const cancel = await reserveCancel(fixture);

  fixture.service.cancelOwner.handoff(cancelHandoff(cancel));
  fixture.service.handoff(inputHandoff(input, "input-message-after-cancel", 2));
  await waitFor(() => fixture.interruptInputs.length === 1);
  await fixture.service.accept("codex-1", terminalEvent("interrupted"));
  await handle.done;

  assert.equal(fixture.inputBegins.length, 0);
  assert.equal(fixture.steerInputs.length, 0);
  assert.equal(fixture.terminals[0]?.outcome.kind, "canceled");
});

async function activateInputOwner(
  fixture: ReturnType<typeof eventFixture>,
  preparedDispatch = dispatch(),
): Promise<void> {
  const handle = fixture.service.register(preparedDispatch, fixture.control);
  assert.ok(handle);
  await handle.settleStartTurn(acceptedTurn("turn-1"));
}

async function reserveCancel(fixture: ReturnType<typeof eventFixture>, signal?: AbortSignal) {
  const result = await fixture.service.cancelOwner.preflight(
    { sessionId: "session-1", runId: "run-1" },
    signal === undefined ? undefined : { signal },
  );
  assert.equal(result.ok, true);
  if (!result.ok || result.value.kind !== "active_execution") throw new Error("cancel reservation failed");
  return result.value.reservation;
}

function cancelHandoff(reservation: Awaited<ReturnType<typeof reserveCancel>>) {
  return {
    reservation,
    sessionId: reservation.sessionId,
    runId: reservation.runId,
    idempotencyKey: "018f1f4e-7f0a-7000-8000-000000000902",
    cancelRequestedAt: 10,
  };
}

async function reserveInput(fixture: ReturnType<typeof eventFixture>, signal?: AbortSignal) {
  const result = await fixture.service.preflight(
    { sessionId: "session-1", runId: "run-1" },
    signal === undefined ? undefined : { signal },
  );
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("input reservation failed");
  return result.value;
}

function inputHandoff(
  reservation: Awaited<ReturnType<typeof reserveInput>>,
  messageId: string,
  messageOrdinal: number,
  text = "follow up",
) {
  return {
    reservation,
    sessionId: reservation.sessionId,
    runId: reservation.runId,
    attemptId: reservation.attemptId,
    messageId,
    messageOrdinal,
    bindingId: reservation.bindingId,
    admittedAt: 10,
    contentBlocks: [{ type: "text", text }] as const,
  };
}

function terminalEvent(status: "completed" | "failed" | "interrupted" = "completed") {
  return {
    kind: "turn_terminal",
    threadId: "thread-1",
    turnId: "turn-1",
    status,
    finalAssistantMessage: null,
    contentFailure: null,
  } as const;
}

function eventFixture(
  options: Readonly<{
    resolutionUnknownOnce?: boolean;
    outputUnknownOnce?: boolean;
    terminalUnknownOnce?: boolean;
    resolutionUnknownCount?: number;
    resolutionUnknownCountByOutcome?: Readonly<
      Partial<Record<RunDispatchResolutionCommand["outcome"]["kind"], number>>
    >;
    outputUnknownCount?: number;
    terminalUnknownCount?: number;
    recoveryUnavailableCount?: number;
    terminalizeRejectOnce?: boolean;
    inputBeginAlreadyCommitted?: boolean;
    inputBeginReplayWithSendAllowed?: boolean;
    inputBeginUnknownCount?: number;
    inputBeginOperation?: (
      command: RunInputBeginCommand,
      call: number,
    ) => ReturnType<ApplicationRunEventWritePort["beginRunInput"]>;
    inputResolutionUnknownCount?: number;
    inputResolutionOperation?: (
      command: RunInputResolutionCommand,
      call: number,
    ) => ReturnType<ApplicationRunEventWritePort["resolveRunInput"]>;
    steerResult?: Awaited<ReturnType<NonNullable<ApplicationRunProviderAdapterPort["steerTurn"]>>>;
    steerOperation?: NonNullable<ApplicationRunProviderAdapterPort["steerTurn"]>;
    interruptResult?: Awaited<ReturnType<NonNullable<ApplicationRunProviderAdapterPort["interruptTurn"]>>>;
    interruptOperation?: NonNullable<ApplicationRunProviderAdapterPort["interruptTurn"]>;
    respondOperation?: (
      handle: ApplicationRunProviderInteractionHandle,
      response: ApplicationRunProviderInteractionResponse,
    ) => Promise<ApplicationRunProviderInteractionResponseResult>;
    interactionAdapter?: Readonly<{
      reserveInteractionResponse: NonNullable<ApplicationRunProviderAdapterPort["reserveInteractionResponse"]>;
      writeReservedInteractionResponse: NonNullable<
        ApplicationRunProviderAdapterPort["writeReservedInteractionResponse"]
      >;
      releaseInteractionResponseReservation: NonNullable<
        ApplicationRunProviderAdapterPort["releaseInteractionResponseReservation"]
      >;
    }>;
    interactionAdmissionGate?: Promise<void>;
    interactionAdmissionUnknownAfterCommitCount?: number;
    interactionAdmissionEffectNone?: boolean;
    interactionAdmissionErrorSequence?: readonly ("success" | "none" | "nonretryable_none" | "unknown_after_commit")[];
    interactionAdmissionOperation?: (
      command: RunInteractionResponseAdmissionCommand,
      call: number,
    ) => ReturnType<ApplicationRunEventWritePort["admitRunInteractionResponse"]>;
    interactionMarkGate?: Promise<void>;
    interactionMarkUnknownAfterCommitCount?: number;
    interactionMarkErrorSequence?: readonly ("none" | "unknown_after_commit")[];
    interactionSettlementUnknownCount?: number;
    interactionSettlementErrorSequence?: readonly ("none" | "nonretryable_none" | "unknown_after_commit")[];
    beforeInteractionSettlement?: (
      command: RunInteractionResponseSettlementCommand,
      call: number,
    ) => void | Promise<void>;
    interactionReleaseRejectCount?: number;
    receiverSensitiveInterrupt?: boolean;
    isCurrent?: () => boolean;
    signal?: AbortSignal;
    afterInputBegin?: () => void;
    persistedRunCancel?: Readonly<{ phase: "active" } | { phase: "canceling"; requestedAt: number }>;
    limits?: Readonly<{
      maxTrackedAttempts?: number;
      maxBufferedEventsPerAttempt?: number;
      maxPersistedOutputsPerAttempt?: number;
      maxPendingInputsPerAttempt?: number;
      maxTrackedInputs?: number;
      maxPendingInteractions?: number;
      maxInteractionProjectionBytes?: number;
      maxInteractionTombstones?: number;
    }>;
  }> = {},
) {
  const resolutions: RunDispatchResolutionCommand[] = [];
  const outputs: RunOutputAppendCommand[] = [];
  const inputBegins: RunInputBeginCommand[] = [];
  const inputResolutions: RunInputResolutionCommand[] = [];
  const interactionAdmissions: RunInteractionResponseAdmissionCommand[] = [];
  const interactionWriteMarks: RunInteractionResponseMarkWriteAttemptCommand[] = [];
  const interactionSettlements: RunInteractionResponseSettlementCommand[] = [];
  let interactionResponse: RunInteractionResponseResult | undefined;
  let interactionAdmissionCalls = 0;
  let interactionMarkCalls = 0;
  const inputDeliveryStates = new Map<string, "dispatching" | RunInputResolutionCommand["outcome"]["kind"]>();
  const terminals: RunTerminalCommand[] = [];
  const terminalized: Parameters<ApplicationRunDispatchControl["terminalize"]>[0][] = [];
  let terminalCalls = 0;
  let terminalizeCalls = 0;
  let outputCalls = 0;
  let resolutionCalls = 0;
  let inputBeginCalls = 0;
  const committedInputMessages = new Set<string>();
  let inputResolutionCalls = 0;
  let interactionSettlementCalls = 0;
  const steerInputs: Parameters<NonNullable<ApplicationRunProviderAdapterPort["steerTurn"]>>[0][] = [];
  const interruptInputs: Parameters<NonNullable<ApplicationRunProviderAdapterPort["interruptTurn"]>>[0][] = [];
  const interruptSignals: (AbortSignal | undefined)[] = [];
  const interactionResponses: ApplicationRunProviderInteractionResponse[] = [];
  const interactionHandles: ApplicationRunProviderInteractionHandle[] = [];
  const reservedInteractionHandles: ApplicationRunProviderInteractionHandle[] = [];
  const releasedInteractionReservations: object[] = [];
  let interactionReleaseCalls = 0;
  const interactionReservations = new WeakMap<
    object,
    Readonly<{
      handle: ApplicationRunProviderInteractionHandle;
      response: ApplicationRunProviderInteractionResponse;
    }>
  >();
  const resolutionCallsByOutcome: Record<RunDispatchResolutionCommand["outcome"]["kind"], number> = {
    accepted: 0,
    rejected: 0,
    ambiguous: 0,
  };
  let recoveryCalls = 0;
  const reads: ApplicationRunEventReadPort = {
    async recoveryGet(input) {
      recoveryCalls += 1;
      if (recoveryCalls <= (options.recoveryUnavailableCount ?? 0)) {
        throw new Error("recovery unavailable");
      }
      return {
        runId: input.runId,
        sessionId: input.sessionId,
        workspaceKey: input.workspaceKey,
        runPhase: "active",
        runUpdatedAt: 1,
        attemptId: "attempt-1",
        attemptOrdinal: 1,
        attemptState: "active",
        externalExecutionId: "turn-1",
        bindingId: "binding-1",
        providerId: "codex",
        persistenceMode: "persistent",
        bindingState: "active",
        externalConversationId: "thread-1",
        dispatchState: "accepted",
        providerIdempotencyKey: null,
      };
    },
    async runGet(input) {
      const cancel = options.persistedRunCancel ?? { phase: "active" as const };
      return {
        sessionId: input.sessionId,
        workspaceKey: input.workspaceKey,
        run: {
          id: input.runId,
          sessionId: input.sessionId,
          phase: cancel.phase,
          ...(cancel.phase === "canceling" ? { cancelRequestedAt: cancel.requestedAt } : {}),
          version: 7,
        },
      } as never;
    },
  };
  const writes: ApplicationRunEventWritePort = {
    async admitRunInteractionResponse(command) {
      interactionAdmissionCalls += 1;
      interactionAdmissions.push(command);
      await options.interactionAdmissionGate;
      const scriptedError = options.interactionAdmissionErrorSequence?.[interactionAdmissionCalls - 1];
      if (options.interactionAdmissionOperation !== undefined) {
        return options.interactionAdmissionOperation(command, interactionAdmissionCalls);
      }
      if (
        options.interactionAdmissionEffectNone === true ||
        scriptedError === "none" ||
        scriptedError === "nonretryable_none"
      ) {
        throw nonePersistenceFailure(scriptedError !== "nonretryable_none");
      }
      if (interactionResponse !== undefined) {
        if (interactionAdmissions[0]?.idempotencyKey !== command.idempotencyKey) {
          return {
            ok: false,
            replayed: false,
            error: {
              code: "lifecycle_conflict",
              message: "interaction already answered",
              retryable: false,
            },
          };
        }
        if (
          scriptedError === "unknown_after_commit" ||
          interactionAdmissionCalls <= (options.interactionAdmissionUnknownAfterCommitCount ?? 0)
        ) {
          throw unknownPersistenceFailure();
        }
        return { ok: true, replayed: true, value: interactionResponse };
      }
      interactionResponse = {
        responseRefId: "response-ref-1",
        sessionId: command.sessionId,
        runId: command.runId,
        interactionId: command.interactionId,
        providerId: command.providerId,
        definitionVersion: command.definitionVersion,
        interactionKind: command.interactionKind,
        semanticAction: command.semanticAction,
        admittedAt: 21,
        effectCertainty: "admitted",
        writeAttemptedAt: null,
        settledAt: null,
        resolutionCode: null,
      };
      if (
        scriptedError === "unknown_after_commit" ||
        interactionAdmissionCalls <= (options.interactionAdmissionUnknownAfterCommitCount ?? 0)
      ) {
        throw unknownPersistenceFailure();
      }
      return success(interactionResponse);
    },
    async markRunInteractionResponseWriteAttempt(command) {
      interactionMarkCalls += 1;
      interactionWriteMarks.push(command);
      if (interactionResponse === undefined) throw new Error("interaction response not admitted");
      await options.interactionMarkGate;
      const scriptedError = options.interactionMarkErrorSequence?.[interactionMarkCalls - 1];
      if (scriptedError === "none") {
        throw nonePersistenceFailure();
      }
      interactionResponse = {
        ...interactionResponse,
        effectCertainty: "write_attempted",
        writeAttemptedAt: 22,
        settledAt: null,
        resolutionCode: null,
      };
      if (
        scriptedError === "unknown_after_commit" ||
        interactionMarkCalls <= (options.interactionMarkUnknownAfterCommitCount ?? 0)
      ) {
        throw unknownPersistenceFailure();
      }
      return success(interactionResponse);
    },
    async settleRunInteractionResponse(command) {
      if (interactionResponse === undefined) throw new Error("interaction response not admitted");
      interactionSettlements.push(command);
      interactionSettlementCalls += 1;
      await options.beforeInteractionSettlement?.(command, interactionSettlementCalls);
      const scriptedError = options.interactionSettlementErrorSequence?.[interactionSettlementCalls - 1];
      if (scriptedError === "none" || scriptedError === "nonretryable_none") {
        throw nonePersistenceFailure(scriptedError !== "nonretryable_none");
      }
      if (interactionSettlementCalls <= (options.interactionSettlementUnknownCount ?? 0)) {
        throw unknownPersistenceFailure();
      }
      interactionResponse = {
        ...interactionResponse,
        effectCertainty: command.outcome.effectCertainty,
        writeAttemptedAt:
          interactionResponse.writeAttemptedAt ??
          (command.outcome.effectCertainty === "not_sent" &&
          command.outcome.resolutionCode === "owner_lost_before_write"
            ? null
            : 22),
        settledAt: 23,
        resolutionCode: command.outcome.resolutionCode,
      } as RunInteractionResponseResult;
      if (scriptedError === "unknown_after_commit") throw unknownPersistenceFailure();
      return success(interactionResponse);
    },
    async resolveRunDispatch(command) {
      resolutions.push(command);
      resolutionCalls += 1;
      resolutionCallsByOutcome[command.outcome.kind] += 1;
      if (
        (options.resolutionUnknownOnce === true && resolutionCalls === 1) ||
        resolutionCalls <= (options.resolutionUnknownCount ?? 0) ||
        resolutionCallsByOutcome[command.outcome.kind] <=
          (options.resolutionUnknownCountByOutcome?.[command.outcome.kind] ?? 0)
      )
        throw unknownPersistenceFailure();
      return success({
        sessionId: command.sessionId,
        runId: command.runId,
        attemptId: command.attemptId,
        bindingId: command.bindingId,
        dispatchState: command.outcome.kind,
        externalExecutionId: command.outcome.kind === "accepted" ? command.outcome.externalExecutionId : null,
        resolvedAt: 10,
      });
    },
    async appendRunOutput(command) {
      outputs.push(command);
      outputCalls += 1;
      if ((options.outputUnknownOnce === true && outputCalls === 1) || outputCalls <= (options.outputUnknownCount ?? 0))
        throw unknownPersistenceFailure();
      return success({
        sessionId: command.sessionId,
        runId: command.runId,
        outputItemId: command.item.id,
        ordinal: outputs.length,
        payloadState: command.item.payload.state,
        storedByteLength: null,
        createdAt: 20,
      });
    },
    async beginRunInput(command) {
      inputBegins.push(command);
      inputBeginCalls += 1;
      if (options.inputBeginOperation !== undefined) {
        return options.inputBeginOperation(command, inputBeginCalls);
      }
      if (inputBeginCalls <= (options.inputBeginUnknownCount ?? 0)) {
        committedInputMessages.add(command.messageId);
        throw unknownPersistenceFailure();
      }
      const sendAllowed = options.inputBeginAlreadyCommitted !== true && !committedInputMessages.has(command.messageId);
      committedInputMessages.add(command.messageId);
      inputDeliveryStates.set(command.messageId, "dispatching");
      options.afterInputBegin?.();
      return {
        ok: true,
        replayed: options.inputBeginReplayWithSendAllowed === true || !sendAllowed,
        value: {
          sessionId: command.sessionId,
          runId: command.runId,
          attemptId: command.attemptId,
          messageId: command.messageId,
          bindingId: command.bindingId,
          deliveryState: "dispatching" as const,
          dispatchingAt: 15,
          sendAllowed: options.inputBeginReplayWithSendAllowed === true || sendAllowed,
        },
      } as const;
    },
    async resolveRunInput(command) {
      inputResolutions.push(command);
      inputResolutionCalls += 1;
      if (options.inputResolutionOperation !== undefined) {
        const result = await options.inputResolutionOperation(command, inputResolutionCalls);
        if (result.ok) inputDeliveryStates.set(command.messageId, command.outcome.kind);
        return result;
      }
      if (inputResolutionCalls <= (options.inputResolutionUnknownCount ?? 0)) throw unknownPersistenceFailure();
      inputDeliveryStates.set(command.messageId, command.outcome.kind);
      return success({
        sessionId: command.sessionId,
        runId: command.runId,
        attemptId: command.attemptId,
        messageId: command.messageId,
        bindingId: command.bindingId,
        deliveryState: command.outcome.kind,
        resolutionCode: command.outcome.kind === "accepted" ? null : command.outcome.resolutionCode,
        resolvedAt: 16,
      });
    },
    async completeRun(command) {
      terminals.push(command);
      terminalCalls += 1;
      for (const [messageId, state] of inputDeliveryStates) {
        if (state === "dispatching") inputDeliveryStates.set(messageId, "ambiguous");
      }
      if (
        (options.terminalUnknownOnce === true && terminalCalls === 1) ||
        terminalCalls <= (options.terminalUnknownCount ?? 0)
      )
        throw unknownPersistenceFailure();
      return success({
        sessionId: command.sessionId,
        runId: command.runId,
        attemptId: command.attemptId,
        phase: command.outcome.kind,
        finalAssistantMessageId:
          command.outcome.kind === "completed" ? (command.outcome.finalAssistantMessage?.id ?? null) : null,
        terminalEventId: command.terminalEvent.id,
        childDeliveryId: null,
        delegationState: null,
        terminalAt: 30,
      });
    },
  };
  const service = new ApplicationRunEventService({
    reads,
    writes,
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  });
  const control: ApplicationRunDispatchControl = {
    adapter: {
      async steerTurn(input: Parameters<NonNullable<ApplicationRunProviderAdapterPort["steerTurn"]>>[0]) {
        steerInputs.push(input);
        if (options.steerOperation !== undefined) return options.steerOperation(input);
        return (
          options.steerResult ?? {
            kind: "accepted",
            effect: "present",
            value: { threadId: input.threadId, turnId: input.expectedTurnId },
          }
        );
      },
      async interruptTurn(
        input: Parameters<NonNullable<ApplicationRunProviderAdapterPort["interruptTurn"]>>[0],
        operationOptions: Parameters<NonNullable<ApplicationRunProviderAdapterPort["interruptTurn"]>>[1],
      ) {
        if (options.receiverSensitiveInterrupt === true && this !== control.adapter) {
          throw new TypeError("Provider Adapter receiver was lost.");
        }
        interruptInputs.push(input);
        interruptSignals.push(operationOptions?.signal);
        if (options.interruptOperation !== undefined) {
          return options.interruptOperation(input, operationOptions);
        }
        return (
          options.interruptResult ?? {
            kind: "accepted",
            effect: "present",
            value: { threadId: input.threadId, turnId: input.turnId, terminal: false },
          }
        );
      },
      reserveInteractionResponse(
        handle: ApplicationRunProviderInteractionHandle,
        response: ApplicationRunProviderInteractionResponse,
      ) {
        reservedInteractionHandles.push(handle);
        if (options.interactionAdapter !== undefined) {
          return options.interactionAdapter.reserveInteractionResponse(handle, response);
        }
        const token = {};
        interactionReservations.set(token, { handle, response });
        return { kind: "reserved", reservation: { token } };
      },
      writeReservedInteractionResponse(reservation: ApplicationRunProviderInteractionResponseReservation) {
        if (options.interactionAdapter !== undefined) {
          return options.interactionAdapter.writeReservedInteractionResponse(reservation);
        }
        const reserved = interactionReservations.get(reservation.token);
        if (reserved === undefined) throw new TypeError("Unknown interaction response reservation.");
        interactionReservations.delete(reservation.token);
        interactionHandles.push(reserved.handle);
        interactionResponses.push(reserved.response);
        if (options.respondOperation !== undefined) {
          return options.respondOperation.call(this, reserved.handle, reserved.response);
        }
        return Promise.resolve({
          kind: "write_attempted",
          effect: "unknown",
          providerResolution: "resolved",
        });
      },
      releaseInteractionResponseReservation(reservation: ApplicationRunProviderInteractionResponseReservation) {
        if (options.interactionAdapter !== undefined) {
          return options.interactionAdapter.releaseInteractionResponseReservation(reservation);
        }
        interactionReleaseCalls += 1;
        if (interactionReleaseCalls <= (options.interactionReleaseRejectCount ?? 0)) {
          throw new Error("interaction reservation release unavailable");
        }
        if (!interactionReservations.delete(reservation.token)) {
          throw new TypeError("Unknown interaction response reservation.");
        }
        releasedInteractionReservations.push(reservation.token);
      },
    } as unknown as ApplicationRunProviderAdapterPort,
    ...(options.signal === undefined ? { signal: new AbortController().signal } : { signal: options.signal }),
    isCurrent: options.isCurrent ?? (() => true),
    async terminalize(failure) {
      terminalizeCalls += 1;
      terminalized.push(failure);
      if (options.terminalizeRejectOnce === true && terminalizeCalls === 1) {
        throw new Error("terminal persistence failed");
      }
      return true;
    },
  };
  return {
    service,
    control,
    writes,
    resolutions,
    inputBegins,
    inputResolutions,
    interactionAdmissions,
    interactionWriteMarks,
    interactionSettlements,
    inputDeliveryStates,
    steerInputs,
    interruptInputs,
    interruptSignals,
    interactionResponses,
    interactionHandles,
    reservedInteractionHandles,
    releasedInteractionReservations,
    outputs,
    terminals,
    terminalized,
  };
}

async function isSettled(promise: Promise<void>): Promise<boolean> {
  return Promise.race([promise.then(() => true), new Promise<false>((resolve) => setImmediate(() => resolve(false)))]);
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("Condition was not met.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function dispatch(
  ownership: ApplicationRunBindingOwnership = { persistenceMode: "persistent", ephemeralOwnerToken: null },
): ApplicationRunPreparedDispatch {
  const prepared: Omit<ApplicationRunPreparedDispatch, "persistenceMode" | "ephemeralOwnerToken"> = {
    admission: {
      sessionId: "session-1",
      runId: "run-1",
      messageId: "message-1",
      attemptId: "attempt-1",
      bindingId: "binding-1",
      runPhase: "starting",
      bindingState: "active",
      dispatchState: "pending",
      admittedAt: 1,
    },
    workspaceKey: "workspace-1",
    providerId: "codex",
    threadId: "thread-1",
    generationId: "codex-1",
    executionSnapshot: {
      providerId: "codex",
      definitionVersion: "codex-provider-v1",
      modelSelection: "explicit",
      settings: {
        model: "gpt-5.6",
        reasoningEffort: "high",
        approvalPolicy: "never",
        sandbox: { mode: "workspace-write", networkAccess: false },
      },
      workspace: {
        key: "workspace-1",
        path: process.cwd(),
        allowedAdditionalDirectories: [],
      },
      character: null,
    },
    contentBlocks: [{ type: "text", text: "hello" }],
  };
  return ownership.persistenceMode === "persistent"
    ? { ...prepared, persistenceMode: "persistent", ephemeralOwnerToken: null }
    : {
        ...prepared,
        persistenceMode: "ephemeral",
        ephemeralOwnerToken: ownership.ephemeralOwnerToken,
      };
}

const EPHEMERAL_OWNER_TOKEN = "018f1f4e-7f0a-7000-8000-000000000901";

function acceptedTurn(turnId: string) {
  return {
    kind: "accepted",
    effect: "present",
    value: { threadId: "thread-1", turnId, status: "in_progress" },
  } as const;
}

function interactionHandle(): ApplicationRunProviderInteractionHandle {
  return Object.freeze({}) as unknown as ApplicationRunProviderInteractionHandle;
}

function interactionResponseInput(interactionId: string) {
  const response = {
    interactionId,
    kind: "codex.command_approval",
    payload: { decision: "accept" },
  } as const;
  return {
    sessionId: "session-1",
    runId: "run-1",
    workspaceKey: "workspace-1",
    idempotencyKey: "10000000-0000-4000-8000-000000000001",
    providerId: "codex",
    definitionVersion: "codex-provider-v1",
    response,
    semanticAction: "accept",
    canonicalResponseJson: JSON.stringify(response),
  } as const;
}

function interactionActivity(
  _providerId: string,
  _definitionVersion: string,
  kind: string,
): "waiting_input" | "waiting_approval" | undefined {
  return kind === "codex.user_input" || kind === "codex.mcp_server_form"
    ? "waiting_input"
    : kind.startsWith("codex.")
      ? "waiting_approval"
      : undefined;
}

function pendingInteraction(
  handle: ApplicationRunProviderInteractionHandle,
  interactionId: string,
  kind: CodexAdapterInteractionKind,
  answerable = true,
): Extract<CodexAdapterEvent, Readonly<{ kind: "interaction_pending" }>> {
  const display = !answerable
    ? { summary: "Interaction unavailable", unavailableReason: "unsafe_projection" as const }
    : kind === "codex.user_input"
      ? { questions: [{ questionId: "q1", header: "Input", prompt: "Continue?", allowOther: false, options: [] }] }
      : { summary: "Approve command", command: "npm test", availableDecisions: ["accept", "decline", "cancel"] };
  return {
    kind: "interaction_pending",
    handle,
    owner: {
      connectionGeneration: "adapter-1",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
    },
    snapshot: {
      interactionId,
      providerId: "codex",
      definitionVersion: "codex-provider-v1",
      kind,
      answerable,
      display,
    },
  } as unknown as Extract<CodexAdapterEvent, Readonly<{ kind: "interaction_pending" }>>;
}

function turnStarted(turnId: string) {
  return {
    kind: "turn_started",
    turn: { threadId: "thread-1", turnId, status: "in_progress" },
  } as const;
}

function itemOutput(itemId: string, summary: string, kind: string, turnId: string = "turn-1") {
  return {
    kind: "item_output",
    threadId: "thread-1",
    turnId,
    itemId,
    output: {
      category: "operation",
      kind,
      summary,
      completionState: "complete",
      payload: { kind: "none", redaction: "not_required" },
    },
  } as const;
}

function success<T>(value: T) {
  return { ok: true, value, replayed: false } as const;
}

function unknownPersistenceFailure(): PersistenceClientError {
  return new PersistenceClientError({
    code: "request_timeout",
    message: "response lost",
    retryable: true,
    effect: "unknown",
  });
}

function nonePersistenceFailure(retryable = true): PersistenceClientError {
  return new PersistenceClientError({
    code: "request_timeout",
    message: "request was not sent",
    retryable,
    effect: "none",
  });
}
