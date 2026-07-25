import assert from "node:assert/strict";
import test from "node:test";

import { CODEX_ADAPTER_LIMITS, type CodexAdapterThreadSnapshot } from "../src/main/providers/codex/index.js";
import {
  CodexAdapterLifecycle,
  type CodexThreadLifecycleIdentity,
} from "../src/main/providers/codex/codex-adapter-lifecycle.js";
import type { CodexValidatedThread } from "../src/main/providers/codex/codex-adapter-validation.js";
import { assertBoundedPublicSummary } from "./codex-adapter-test-support.js";

test("Thread response and notification converge once in either arrival order", () => {
  const notificationFirst = new CodexAdapterLifecycle();
  assert.deepEqual(notificationFirst.acceptThreadStartedNotification(validatedThread()), {
    events: [],
    fatal: false,
  });
  assert.deepEqual(eventKinds(notificationFirst.acceptThreadResponse(threadSnapshot(), threadIdentity())), [
    "thread_started",
  ]);
  const duplicate = notificationFirst.acceptThreadStartedNotification(validatedThread()).events[0];
  assert.equal(duplicate?.kind, "diagnostic");
  if (duplicate?.kind !== "diagnostic") assert.fail("expected duplicate diagnostic");
  const { summary, ...diagnostic } = duplicate.diagnostic;
  assertBoundedPublicSummary(summary);
  assert.deepEqual(diagnostic, {
    code: "duplicate_event",
    redaction: "not_required",
  });

  const responseFirst = new CodexAdapterLifecycle();
  assert.deepEqual(eventKinds(responseFirst.acceptThreadResponse(threadSnapshot(), threadIdentity())), [
    "thread_started",
  ]);
  assert.deepEqual(responseFirst.acceptThreadStartedNotification(validatedThread()), {
    events: [],
    fatal: false,
  });
});

test("a delayed start response does not roll back a newer Thread status", () => {
  const lifecycle = new CodexAdapterLifecycle();
  lifecycle.acceptThreadStartedNotification(validatedThread());
  assert.deepEqual(eventKinds(lifecycle.acceptThreadStatus("thread-1", { type: "active", activeFlags: [] })), [
    "thread_status_observed",
  ]);
  const delayedResponse = lifecycle.acceptThreadResponse(threadSnapshot(), threadIdentity());
  assert.deepEqual(eventKinds(delayedResponse), ["thread_started"]);
  assert.equal(
    delayedResponse.events[0]?.kind === "thread_started" && delayedResponse.events[0].thread.status,
    "active",
  );
  assert.deepEqual(eventKinds(lifecycle.acceptThreadStatus("thread-1", { type: "idle", activeFlags: [] })), [
    "thread_status_observed",
  ]);
});

test("Thread start status differences do not invalidate the same Thread identity", () => {
  const lifecycle = new CodexAdapterLifecycle();
  lifecycle.acceptThreadStartedNotification(validatedThread());
  const response = lifecycle.acceptThreadResponse(threadSnapshot({ status: "active" }), threadIdentity());
  assert.deepEqual(eventKinds(response), ["thread_started"]);
  assert.equal(response.events[0]?.kind === "thread_started" && response.events[0].thread.status, "idle");
});

test("a notification-first Thread fixes its full correlation identity before the response", () => {
  const conflicts: readonly Readonly<{
    response: CodexAdapterThreadSnapshot;
    identity: CodexThreadLifecycleIdentity;
  }>[] = [
    { response: threadSnapshot({ cliVersion: "0.146.0" }), identity: threadIdentity() },
    { response: threadSnapshot({ modelProvider: "other-provider" }), identity: threadIdentity() },
    { response: threadSnapshot(), identity: threadIdentity({ workspaceKey: "other-workspace-key" }) },
    { response: threadSnapshot(), identity: threadIdentity({ ephemeral: true }) },
  ];
  for (const { response, identity } of conflicts) {
    const lifecycle = new CodexAdapterLifecycle();
    lifecycle.acceptThreadStartedNotification(validatedThread());
    const result = lifecycle.acceptThreadResponse(response, identity);
    assert.equal(diagnosticCode(result), "identity_mismatch");
    assert.equal(lifecycle.snapshot().trackedThreads, 1);
  }
});

test("a response-first Thread rejects a notification with a different workspace or persistence identity", () => {
  for (const notification of [
    validatedThread({ workspaceKey: "other-workspace-key" }),
    validatedThread({ ephemeral: true }),
  ]) {
    const lifecycle = new CodexAdapterLifecycle();
    lifecycle.acceptThreadResponse(threadSnapshot(), threadIdentity());
    assert.equal(diagnosticCode(lifecycle.acceptThreadStartedNotification(notification)), "identity_mismatch");
  }
});

test("Turn response and notification converge once in either arrival order", () => {
  const notificationFirst = readyLifecycle();
  assert.deepEqual(
    eventKinds(
      notificationFirst.acceptTurnStarted(
        { threadId: "thread-1", turnId: "turn-1", status: "in_progress" },
        "notification",
      ),
    ),
    ["turn_started"],
  );
  assert.deepEqual(
    notificationFirst.acceptTurnStarted({ threadId: "thread-1", turnId: "turn-1", status: "in_progress" }, "response"),
    { events: [], fatal: false },
  );

  const responseFirst = readyLifecycle();
  assert.deepEqual(
    eventKinds(
      responseFirst.acceptTurnStarted({ threadId: "thread-1", turnId: "turn-1", status: "in_progress" }, "response"),
    ),
    ["turn_started"],
  );
  assert.deepEqual(
    responseFirst.acceptTurnStarted({ threadId: "thread-1", turnId: "turn-1", status: "in_progress" }, "notification"),
    { events: [], fatal: false },
  );
});

test("interleaved Threads keep active and terminal Turns separated", () => {
  const lifecycle = new CodexAdapterLifecycle();
  lifecycle.acceptThreadResponse(threadSnapshot({ threadId: "thread-a" }), threadIdentity());
  lifecycle.acceptThreadResponse(threadSnapshot({ threadId: "thread-b" }), threadIdentity());
  lifecycle.acceptTurnStarted({ threadId: "thread-a", turnId: "turn-a", status: "in_progress" }, "response");
  lifecycle.acceptTurnStarted({ threadId: "thread-b", turnId: "turn-b", status: "in_progress" }, "notification");

  const terminalB = lifecycle.acceptTurnTerminal("thread-b", "turn-b", "interrupted");
  const terminalA = lifecycle.acceptTurnTerminal("thread-a", "turn-a", "completed");
  assert.deepEqual(terminalB.events[0], {
    kind: "turn_terminal",
    threadId: "thread-b",
    turnId: "turn-b",
    status: "interrupted",
    finalAssistantMessage: null,
    contentFailure: null,
  });
  assert.deepEqual(terminalA.events[0], {
    kind: "turn_terminal",
    threadId: "thread-a",
    turnId: "turn-a",
    status: "completed",
    finalAssistantMessage: null,
    contentFailure: null,
  });
  assert.deepEqual(lifecycle.snapshot(), {
    failed: false,
    trackedThreads: 2,
    activeTurns: 0,
    terminalTurnTombstones: 2,
  });
});

test("nested identity maps keep delimiter-like Thread and Turn IDs distinct", () => {
  const lifecycle = new CodexAdapterLifecycle();
  const first = { threadId: "a\0b", turnId: "c" };
  const second = { threadId: "a", turnId: "b\0c" };
  lifecycle.acceptThreadResponse(threadSnapshot({ threadId: first.threadId }), threadIdentity());
  lifecycle.acceptThreadResponse(threadSnapshot({ threadId: second.threadId }), threadIdentity());
  lifecycle.acceptTurnStarted({ ...first, status: "in_progress" }, "response");
  lifecycle.acceptTurnStarted({ ...second, status: "in_progress" }, "response");

  assert.deepEqual(eventKinds(lifecycle.acceptTurnTerminal(first.threadId, first.turnId, "completed")), [
    "turn_terminal",
  ]);
  assert.deepEqual(eventKinds(lifecycle.acceptTurnTerminal(second.threadId, second.turnId, "failed")), [
    "turn_terminal",
  ]);
  assert.equal(lifecycle.snapshot().terminalTurnTombstones, 2);
});

test("a Thread cannot accept a second active Turn or another Turn terminal", () => {
  const lifecycle = readyLifecycle();
  lifecycle.acceptTurnStarted({ threadId: "thread-1", turnId: "turn-1", status: "in_progress" }, "response");
  assert.equal(
    diagnosticCode(
      lifecycle.acceptTurnStarted({ threadId: "thread-1", turnId: "turn-2", status: "in_progress" }, "notification"),
    ),
    "identity_mismatch",
  );
  assert.equal(diagnosticCode(lifecycle.acceptTurnTerminal("thread-1", "turn-2", "completed")), "identity_mismatch");
  assert.deepEqual(lifecycle.snapshot().activeTurns, 1);
});

test("Thread idle is observational and does not terminate an active Turn", () => {
  const lifecycle = readyLifecycle();
  lifecycle.acceptTurnStarted({ threadId: "thread-1", turnId: "turn-1", status: "in_progress" }, "response");
  lifecycle.acceptThreadStatus("thread-1", { type: "active", activeFlags: [] });
  assert.deepEqual(eventKinds(lifecycle.acceptThreadStatus("thread-1", { type: "idle", activeFlags: [] })), [
    "thread_status_observed",
  ]);
  assert.equal(lifecycle.snapshot().activeTurns, 1);
  assert.deepEqual(eventKinds(lifecycle.acceptTurnTerminal("thread-1", "turn-1", "completed")), ["turn_terminal"]);
});

test("terminal Turns are monotonic tombstones and interrupted is not canceled", () => {
  const lifecycle = readyLifecycle();
  lifecycle.acceptTurnStarted({ threadId: "thread-1", turnId: "turn-1", status: "in_progress" }, "response");
  const terminal = lifecycle.acceptTurnTerminal("thread-1", "turn-1", "interrupted");
  assert.deepEqual(terminal.events[0], {
    kind: "turn_terminal",
    threadId: "thread-1",
    turnId: "turn-1",
    status: "interrupted",
    finalAssistantMessage: null,
    contentFailure: null,
  });
  assert.equal(diagnosticCode(lifecycle.acceptTurnTerminal("thread-1", "turn-1", "interrupted")), "duplicate_event");
  assert.equal(diagnosticCode(lifecycle.acceptTurnTerminal("thread-1", "turn-1", "failed")), "out_of_order_event");
  assert.equal(
    diagnosticCode(
      lifecycle.acceptTurnStarted({ threadId: "thread-1", turnId: "turn-1", status: "in_progress" }, "notification"),
    ),
    "out_of_order_event",
  );
  assert.equal(lifecycle.snapshot().terminalTurnTombstones, 1);
});

test("a terminal observed before Turn start leaves a tombstone that blocks delayed started events", () => {
  const lifecycle = readyLifecycle();
  const terminal = lifecycle.acceptTurnTerminal("thread-1", "turn-early", "completed");
  assert.equal(diagnosticCode(terminal), "out_of_order_event");
  assert.equal(
    diagnosticCode(
      lifecycle.acceptTurnStarted(
        { threadId: "thread-1", turnId: "turn-early", status: "in_progress" },
        "notification",
      ),
    ),
    "out_of_order_event",
  );
  assert.deepEqual(lifecycle.snapshot(), {
    failed: false,
    trackedThreads: 1,
    activeTurns: 0,
    terminalTurnTombstones: 1,
  });
});

test("an untracked terminal tuple survives delayed Thread and Turn starts without creating a placeholder Thread", () => {
  const lifecycle = new CodexAdapterLifecycle();
  assert.equal(
    diagnosticCode(
      lifecycle.acceptTurnStarted({ threadId: "missing", turnId: "turn-1", status: "in_progress" }, "notification"),
    ),
    "out_of_order_event",
  );
  assert.equal(diagnosticCode(lifecycle.acceptTurnTerminal("missing", "turn-1", "completed")), "out_of_order_event");
  lifecycle.acceptThreadStartedNotification(validatedThread({ id: "missing" }));
  assert.equal(
    diagnosticCode(
      lifecycle.acceptTurnStarted({ threadId: "missing", turnId: "turn-1", status: "in_progress" }, "notification"),
    ),
    "out_of_order_event",
  );
  assert.deepEqual(lifecycle.snapshot(), {
    failed: false,
    trackedThreads: 1,
    activeTurns: 0,
    terminalTurnTombstones: 1,
  });
});

test("Thread cap fails prospectively and release clears every lifecycle owner", () => {
  const lifecycle = new CodexAdapterLifecycle();
  for (let index = 0; index < CODEX_ADAPTER_LIMITS.maxTrackedThreads; index += 1) {
    assert.equal(
      lifecycle.acceptThreadResponse(threadSnapshot({ threadId: `thread-${index}` }), threadIdentity()).fatal,
      false,
    );
  }
  const overflow = lifecycle.acceptThreadResponse(threadSnapshot({ threadId: "overflow" }), threadIdentity());
  assert.equal(overflow.fatal, true);
  assert.deepEqual(eventKinds(overflow), ["diagnostic", "connection_failure"]);
  assert.equal(lifecycle.snapshot().trackedThreads, CODEX_ADAPTER_LIMITS.maxTrackedThreads);

  lifecycle.release();
  assert.deepEqual(lifecycle.snapshot(), {
    failed: true,
    trackedThreads: 0,
    activeTurns: 0,
    terminalTurnTombstones: 0,
  });
});

test("tombstone overflow preserves the accepted terminal before failing", () => {
  const lifecycle = readyLifecycle();
  for (let index = 0; index < CODEX_ADAPTER_LIMITS.maxTerminalTurnTombstones; index += 1) {
    const turnId = `turn-${index}`;
    lifecycle.acceptTurnStarted({ threadId: "thread-1", turnId, status: "in_progress" }, "response");
    assert.equal(lifecycle.acceptTurnTerminal("thread-1", turnId, "completed").fatal, false);
  }
  lifecycle.acceptTurnStarted({ threadId: "thread-1", turnId: "turn-overflow", status: "in_progress" }, "response");
  const overflow = lifecycle.acceptTurnTerminal("thread-1", "turn-overflow", "completed");
  assert.equal(overflow.fatal, true);
  assert.deepEqual(eventKinds(overflow), ["turn_terminal", "diagnostic", "connection_failure"]);
  assert.deepEqual(lifecycle.snapshot(), {
    failed: true,
    trackedThreads: 1,
    activeTurns: 0,
    terminalTurnTombstones: CODEX_ADAPTER_LIMITS.maxTerminalTurnTombstones,
  });
  assert.deepEqual(lifecycle.acceptThreadStatus("thread-1", { type: "active", activeFlags: [] }), {
    events: [],
    fatal: true,
  });
});

function readyLifecycle(): CodexAdapterLifecycle {
  const lifecycle = new CodexAdapterLifecycle();
  lifecycle.acceptThreadResponse(threadSnapshot(), threadIdentity());
  return lifecycle;
}

function threadSnapshot(overrides: Partial<CodexAdapterThreadSnapshot> = {}): CodexAdapterThreadSnapshot {
  return Object.freeze({
    threadId: "thread-1",
    status: "idle",
    model: "gpt-5.4",
    modelProvider: "openai",
    cliVersion: "0.145.0",
    reasoningEffort: "medium",
    ...overrides,
  });
}

function validatedThread(overrides: Partial<CodexValidatedThread> = {}): CodexValidatedThread {
  return Object.freeze({
    id: "thread-1",
    status: Object.freeze({ type: "idle", activeFlags: Object.freeze([]) }),
    cliVersion: "0.145.0",
    modelProvider: "openai",
    cwd: process.cwd(),
    workspaceKey: "workspace-key",
    ephemeral: false,
    turns: Object.freeze([]),
    ...overrides,
  });
}

function threadIdentity(overrides: Partial<CodexThreadLifecycleIdentity> = {}): CodexThreadLifecycleIdentity {
  return Object.freeze({
    workspaceKey: "workspace-key",
    ephemeral: false,
    ...overrides,
  });
}

function eventKinds(result: ReturnType<CodexAdapterLifecycle["acceptThreadResponse"]>): string[] {
  return result.events.map((event) => event.kind);
}

function diagnosticCode(result: ReturnType<CodexAdapterLifecycle["acceptThreadResponse"]>): string | undefined {
  const event = result.events[0];
  return event?.kind === "diagnostic" ? event.diagnostic.code : undefined;
}
