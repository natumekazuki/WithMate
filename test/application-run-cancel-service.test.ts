import assert from "node:assert/strict";
import test from "node:test";

import {
  ApplicationRunCancelService,
  type ApplicationRunCancelOwnerReservation,
  type ApplicationRunCancelServiceOptions,
} from "../src/main/application-run-cancel-service.js";

type Authorization = Readonly<{ principal: string }>;

const authorization: Authorization = { principal: "owner" };
const idempotencyKey = "018f1f4e-7f0a-7000-8000-000000000921";

test("cancel authorizes, preflights the live owner, commits, hands off, and exposes only public status", async () => {
  const calls: string[] = [];
  const handoffs: unknown[] = [];
  const service = createService({
    access: {
      async authorize(input) {
        calls.push("authorize");
        assert.deepEqual(input, {
          operation: "cancel",
          access: "write",
          context: { authorization },
          target: { kind: "run_cancel", sessionId: "session-1", runId: "run-1" },
        });
        return { allowed: true };
      },
    },
    replay: {
      async probe() {
        calls.push("replay");
        return { kind: "absent" };
      },
    },
    reads: {
      async sessionGet() {
        calls.push("sessionGet");
        return sessionProjection();
      },
      async runGet() {
        calls.push("runGet");
        return runProjection(cancelingRun(10));
      },
    },
    owner: {
      async preflight() {
        calls.push("preflight");
        return { ok: true, value: { kind: "active_execution", reservation: reservation() } };
      },
      handoff(record) {
        calls.push("handoff");
        handoffs.push(record);
      },
      release() {
        calls.push("release");
      },
    },
    admission: {
      async admit(command) {
        calls.push("admit");
        assert.deepEqual(command, {
          sessionId: "session-1",
          workspaceKey: "workspace",
          runId: "run-1",
          idempotencyKey,
          owner: {
            kind: "active_execution",
            attemptId: "attempt-private",
            bindingId: "binding-private",
            ephemeralOwnerToken: null,
            externalConversationId: "conversation-private",
            externalExecutionId: "execution-private",
          },
        });
        return { ok: true, value: cancelAdmission(10), replayed: false };
      },
    },
  });

  const response = await service.cancel(request());

  assert.deepEqual(calls, ["authorize", "replay", "sessionGet", "preflight", "admit", "handoff", "runGet"]);
  assert.equal(handoffs.length, 1);
  assert.deepEqual(response, {
    overallStatus: "success",
    value: {
      sessionId: "session-1",
      runId: "run-1",
      phase: "canceling",
      createdAt: 1,
      startedAt: 2,
      updatedAt: 10,
      cancellation: { requestedAt: 10 },
      liveActivity: null,
    },
    persistence: { status: "committed", effect: "none", replayed: false },
  });
  const serialized = JSON.stringify(response);
  for (const secret of [
    "attempt-private",
    "binding-private",
    "conversation-private",
    "execution-private",
    "generation-private",
  ]) {
    assert.equal(serialized.includes(secret), false);
  }
});

test("invalid and unauthorized cancel requests stop before replay, owner, and Repository work", async () => {
  const calls: string[] = [];
  const service = createService({
    access: {
      async authorize() {
        calls.push("authorize");
        return {
          allowed: false,
          error: { code: "forbidden", message: "denied", retryable: false },
        };
      },
    },
    replay: {
      async probe() {
        calls.push("replay");
        return { kind: "absent" };
      },
    },
    owner: {
      async preflight() {
        calls.push("preflight");
        return { ok: true, value: { kind: "terminal_only" } };
      },
      handoff() {
        calls.push("handoff");
      },
      release() {
        calls.push("release");
      },
    },
    admission: {
      async admit() {
        calls.push("admit");
        return { ok: true, value: cancelAdmission(10), replayed: false };
      },
    },
  });

  const invalid = await service.cancel({ ...request(), attemptId: "caller-attempt" } as never);
  assert.equal(invalid.overallStatus, "failure");
  assert.equal(invalid.overallStatus === "failure" && invalid.error.code, "request_invalid");
  assert.deepEqual(calls, []);

  const denied = await service.cancel(request());
  assert.equal(denied.overallStatus, "failure");
  assert.equal(denied.overallStatus === "failure" && denied.error.code, "forbidden");
  assert.deepEqual(calls, ["authorize"]);
});

test("exact replay returns the current terminal status without live owner preflight or admission", async () => {
  const calls: string[] = [];
  const service = createService({
    replay: {
      async probe() {
        calls.push("replay");
        return {
          kind: "replay",
          value: {
            sessionId: "session-1",
            runId: "run-1",
            phase: "completed",
            cancelRequestedAt: 10,
            cancelAcknowledgedAt: null,
            terminalAt: 20,
          },
        };
      },
    },
    reads: {
      async sessionGet() {
        calls.push("sessionGet");
        return sessionProjection();
      },
      async runGet() {
        calls.push("runGet");
        return runProjection(completedRun(10, 20));
      },
    },
    owner: {
      async preflight() {
        calls.push("preflight");
        return { ok: true, value: { kind: "terminal_only" } };
      },
      handoff() {
        calls.push("handoff");
      },
      release() {
        calls.push("release");
      },
    },
    admission: {
      async admit() {
        calls.push("admit");
        throw new Error("unexpected admission");
      },
    },
  });

  const response = await service.cancel(request());

  assert.deepEqual(calls, ["replay", "sessionGet", "runGet"]);
  assert.equal(response.overallStatus, "success");
  if (response.overallStatus === "success") {
    assert.equal(response.value.phase, "completed");
    assert.deepEqual(response.value.cancellation, { requestedAt: 10 });
    assert.equal(response.persistence.replayed, true);
  }
});

test("a canceling exact replay reacquires a live owner for a commit-response-loss handoff", async () => {
  const calls: string[] = [];
  const handoffs: unknown[] = [];
  const service = createService({
    replay: {
      async probe() {
        calls.push("replay");
        return { kind: "replay", value: cancelAdmission(10) };
      },
    },
    reads: {
      async sessionGet() {
        calls.push("sessionGet");
        return sessionProjection();
      },
      async runGet() {
        calls.push("runGet");
        return runProjection(cancelingRun(10));
      },
    },
    owner: {
      async preflight() {
        calls.push("preflight");
        return { ok: true, value: { kind: "active_execution", reservation: reservation() } };
      },
      handoff(record) {
        calls.push("handoff");
        handoffs.push(record);
      },
      release() {
        calls.push("release");
      },
    },
    admission: {
      async admit() {
        calls.push("admit");
        throw new Error("unexpected admission");
      },
    },
  });

  const response = await service.cancel(request());
  await waitFor(() => calls.includes("handoff"));

  assert.equal(response.overallStatus, "success");
  assert.equal(response.overallStatus === "success" && response.value.phase, "canceling");
  assert.equal(response.overallStatus === "success" && response.persistence.replayed, true);
  assert.equal(calls.filter((call) => call === "preflight").length, 1);
  assert.equal(calls.filter((call) => call === "handoff").length, 1);
  assert.equal(calls.includes("admit"), false);
  assert.equal(calls.includes("release"), false);
  assert.equal(handoffs.length, 1);
});

test("fresh terminal cancel commits an idempotency result without a live reservation or handoff", async () => {
  const calls: string[] = [];
  const service = createService({
    reads: {
      async sessionGet() {
        calls.push("sessionGet");
        return sessionProjection();
      },
      async runGet() {
        calls.push("runGet");
        return runProjection(completedRun(null, 20));
      },
    },
    owner: {
      async preflight() {
        calls.push("preflight");
        return { ok: true, value: { kind: "terminal_only" } };
      },
      handoff() {
        calls.push("handoff");
      },
      release() {
        calls.push("release");
      },
    },
    admission: {
      async admit(command) {
        calls.push("admit");
        assert.deepEqual(command.owner, { kind: "terminal_only" });
        return {
          ok: true,
          value: {
            sessionId: "session-1",
            runId: "run-1",
            phase: "completed",
            cancelRequestedAt: null,
            cancelAcknowledgedAt: null,
            terminalAt: 20,
          },
          replayed: false,
        };
      },
    },
  });

  const response = await service.cancel(request());

  assert.equal(response.overallStatus, "success");
  assert.deepEqual(calls, ["sessionGet", "preflight", "admit", "runGet"]);
});

test("fresh terminal cancel recovers from an absent live owner without handing off", async () => {
  const calls: string[] = [];
  const service = createService({
    reads: {
      async sessionGet() {
        calls.push("sessionGet");
        return sessionProjection();
      },
      async runGet() {
        calls.push("runGet");
        return runProjection(completedRun(null, 20));
      },
    },
    owner: {
      async preflight() {
        calls.push("preflight");
        return {
          ok: false,
          error: { code: "not_found", message: "The active Run owner was not found.", retryable: false },
        };
      },
      handoff() {
        calls.push("handoff");
      },
      release() {
        calls.push("release");
      },
    },
    admission: {
      async admit(command) {
        calls.push("admit");
        assert.deepEqual(command.owner, { kind: "terminal_only" });
        return {
          ok: true,
          value: {
            sessionId: "session-1",
            runId: "run-1",
            phase: "completed",
            cancelRequestedAt: null,
            cancelAcknowledgedAt: null,
            terminalAt: 20,
          },
          replayed: false,
        };
      },
    },
  });

  const response = await service.cancel(request());

  assert.equal(response.overallStatus, "success");
  assert.deepEqual(calls, ["sessionGet", "preflight", "runGet", "admit", "runGet"]);
});

test("live owner conflicts remain failures even when the durable Run is terminal", async () => {
  const calls: string[] = [];
  const service = createService({
    reads: {
      async sessionGet() {
        calls.push("sessionGet");
        return sessionProjection();
      },
      async runGet() {
        calls.push("runGet");
        return runProjection(completedRun(null, 20));
      },
    },
    owner: {
      async preflight() {
        calls.push("preflight");
        return {
          ok: false,
          error: { code: "lifecycle_conflict", message: "Cancel work is already owned.", retryable: false },
        };
      },
      handoff() {
        calls.push("handoff");
      },
      release() {
        calls.push("release");
      },
    },
    admission: {
      async admit() {
        calls.push("admit");
        return cancelSuccess();
      },
    },
  });

  const response = await service.cancel(request());

  assert.equal(response.overallStatus, "failure");
  if (response.overallStatus === "failure") {
    assert.equal(response.error.code, "lifecycle_conflict");
    assert.deepEqual(response.persistence, { status: "not_attempted", effect: "none" });
  }
  assert.deepEqual(calls, ["sessionGet", "preflight"]);
});

test("terminal progression after cancel admission wins the public read-back without losing the request fact", async () => {
  const calls: string[] = [];
  const service = createService({
    reads: {
      async sessionGet() {
        return sessionProjection();
      },
      async runGet() {
        return runProjection(completedRun(10, 20));
      },
    },
    owner: {
      async preflight() {
        return { ok: true, value: { kind: "active_execution", reservation: reservation() } };
      },
      handoff() {
        calls.push("handoff");
      },
      release() {
        calls.push("release");
      },
    },
  });

  const response = await service.cancel(request());

  assert.equal(response.overallStatus, "success");
  if (response.overallStatus === "success") {
    assert.equal(response.value.phase, "completed");
    assert.deepEqual(response.value.cancellation, { requestedAt: 10 });
  }
  assert.deepEqual(calls, ["handoff"]);
});

test("a fresh active Run without a live owner cannot mutate or hand off", async () => {
  const calls: string[] = [];
  const service = createService({
    owner: {
      async preflight() {
        calls.push("preflight");
        return { ok: true, value: { kind: "terminal_only" } };
      },
      handoff() {
        calls.push("handoff");
      },
      release() {
        calls.push("release");
      },
    },
    admission: {
      async admit(command) {
        calls.push("admit");
        assert.deepEqual(command.owner, { kind: "terminal_only" });
        return {
          ok: false,
          error: {
            code: "lifecycle_conflict",
            message: "The active Run has no matching runtime owner.",
            retryable: true,
          },
          replayed: false,
        };
      },
    },
  });

  const response = await service.cancel(request());

  assert.equal(response.overallStatus, "failure");
  if (response.overallStatus === "failure") {
    assert.equal(response.error.code, "lifecycle_conflict");
    assert.deepEqual(response.persistence, { status: "rejected", effect: "none" });
  }
  assert.deepEqual(calls, ["preflight", "admit"]);
});

test("client timeout after admission starts preserves unknown effect while detached handoff continues once", async () => {
  const admission = deferred<ReturnType<typeof cancelSuccess>>();
  const calls: string[] = [];
  let currentReplay = false;
  let cancelWorkOwned = false;
  const service = createService({
    replay: {
      async probe() {
        calls.push("replay");
        return currentReplay ? { kind: "replay", value: cancelAdmission(10) } : { kind: "absent" };
      },
    },
    reads: {
      async sessionGet() {
        calls.push("sessionGet");
        return sessionProjection();
      },
      async runGet() {
        calls.push("runGet");
        return runProjection(cancelingRun(10));
      },
    },
    owner: {
      async preflight() {
        calls.push("preflight");
        if (cancelWorkOwned) {
          return {
            ok: false,
            error: {
              code: "lifecycle_conflict",
              message: "Cancel work is already owned.",
              retryable: false,
            },
          };
        }
        return { ok: true, value: { kind: "active_execution", reservation: reservation() } };
      },
      handoff() {
        calls.push("handoff");
        cancelWorkOwned = true;
      },
      release() {
        calls.push("release");
      },
    },
    admission: {
      async admit() {
        calls.push("admit");
        return admission.promise;
      },
    },
  });

  const first = service.cancel(request(), { timeoutMs: 10 });
  await waitFor(() => calls.includes("admit"));
  const timedOut = await first;
  assert.equal(timedOut.overallStatus, "failure");
  if (timedOut.overallStatus === "failure") {
    assert.equal(timedOut.error.code, "persistence_timeout");
    assert.equal(timedOut.persistence.effect, "unknown");
  }

  admission.resolve(cancelSuccess());
  await waitFor(() => calls.includes("handoff"));
  currentReplay = true;
  const replay = await service.cancel(request());

  assert.equal(replay.overallStatus, "success");
  assert.equal(calls.filter((call) => call === "handoff").length, 1);
  assert.equal(calls.filter((call) => call === "preflight").length, 2);
  assert.equal(calls.filter((call) => call === "admit").length, 1);
});

test("concurrent same-key admissions hand off only the fresh durable cancel and release the replay reservation", async () => {
  const admissions: Array<{
    promise: Promise<ReturnType<typeof cancelSuccess>>;
    resolve: (value: ReturnType<typeof cancelSuccess>) => void;
  }> = [];
  const handoffs: ApplicationRunCancelOwnerReservation[] = [];
  const releases: ApplicationRunCancelOwnerReservation[] = [];
  const service = createService({
    owner: {
      async preflight() {
        return { ok: true, value: { kind: "active_execution", reservation: reservation() } };
      },
      handoff(record) {
        handoffs.push(record.reservation);
      },
      release(value) {
        releases.push(value);
      },
    },
    admission: {
      async admit() {
        const admission = deferred<ReturnType<typeof cancelSuccess>>();
        admissions.push(admission);
        return admission.promise;
      },
    },
  });

  const first = service.cancel(request());
  const concurrentReplay = service.cancel(request());
  await waitFor(() => admissions.length === 2);
  admissions[0]?.resolve(cancelSuccess());
  admissions[1]?.resolve(cancelSuccess(true));

  const responses = await Promise.all([first, concurrentReplay]);

  assert.equal(
    responses.every((response) => response.overallStatus === "success"),
    true,
  );
  assert.equal(handoffs.length, 1);
  assert.equal(releases.length, 1);
  assert.notEqual(handoffs[0]?.token, releases[0]?.token);
});

test("client abort after durable admission does not retract the server-side handoff", async () => {
  const runRead = deferred<ReturnType<typeof runProjection>>();
  const controller = new AbortController();
  const calls: string[] = [];
  const service = createService({
    reads: {
      async sessionGet() {
        return sessionProjection();
      },
      async runGet() {
        calls.push("runGet");
        return runRead.promise;
      },
    },
    owner: {
      async preflight() {
        return { ok: true, value: { kind: "active_execution", reservation: reservation() } };
      },
      handoff() {
        calls.push("handoff");
      },
      release() {
        calls.push("release");
      },
    },
  });

  const pending = service.cancel(request(), { signal: controller.signal });
  await waitFor(() => calls.includes("handoff") && calls.includes("runGet"));
  controller.abort();
  const response = await pending;

  assert.equal(response.overallStatus, "failure");
  if (response.overallStatus === "failure") {
    assert.equal(response.error.code, "persistence_canceled");
    assert.equal(response.persistence.effect, "unknown");
  }
  assert.deepEqual(calls, ["handoff", "runGet"]);

  runRead.resolve(runProjection(cancelingRun(10)));
});

function createService(
  options: Partial<ApplicationRunCancelServiceOptions<Authorization>> = {},
): ApplicationRunCancelService<Authorization> {
  return new ApplicationRunCancelService({
    reads: options.reads ?? {
      async sessionGet() {
        return sessionProjection();
      },
      async runGet() {
        return runProjection(cancelingRun(10));
      },
    },
    access: options.access ?? {
      async authorize() {
        return { allowed: true };
      },
    },
    snapshotAuthorization(value) {
      assert.deepEqual(value, authorization);
      return authorization;
    },
    owner: options.owner ?? {
      async preflight() {
        return { ok: true, value: { kind: "active_execution", reservation: reservation() } };
      },
      handoff() {},
      release() {},
    },
    admission: options.admission ?? {
      async admit() {
        return cancelSuccess();
      },
    },
    replay: options.replay ?? {
      async probe() {
        return { kind: "absent" };
      },
    },
  });
}

function request() {
  return {
    context: { authorization },
    sessionId: "session-1",
    runId: "run-1",
    idempotencyKey,
  };
}

function reservation(): ApplicationRunCancelOwnerReservation {
  return {
    token: {},
    sessionId: "session-1",
    runId: "run-1",
    workspaceKey: "workspace",
    providerId: "provider-private",
    attemptId: "attempt-private",
    bindingId: "binding-private",
    persistenceMode: "persistent",
    ephemeralOwnerToken: null,
    generationId: "generation-private",
    conversationId: "conversation-private",
    executionId: "execution-private",
  };
}

function cancelAdmission(requestedAt: number) {
  return {
    sessionId: "session-1",
    runId: "run-1",
    phase: "canceling" as const,
    cancelRequestedAt: requestedAt,
    cancelAcknowledgedAt: null,
    terminalAt: null,
  };
}

function cancelSuccess(replayed = false) {
  return { ok: true, value: cancelAdmission(10), replayed } as const;
}

function sessionProjection() {
  return {
    session: {
      id: "session-1",
      workspaceKey: "workspace",
      privatePath: "private",
    },
    execution: { state: "running" },
  } as never;
}

function runProjection(run: Readonly<Record<string, unknown>>) {
  return {
    sessionId: "session-1",
    workspaceKey: "workspace",
    run: { id: "run-1", privateAttemptId: "attempt-private", ...run },
  } as never;
}

function cancelingRun(requestedAt: number) {
  return {
    phase: "canceling",
    cancelRequestedAt: requestedAt,
    createdAt: 1,
    startedAt: 2,
    updatedAt: requestedAt,
  };
}

function completedRun(requestedAt: number | null, terminalAt: number) {
  return {
    phase: "completed",
    ...(requestedAt === null ? {} : { cancelRequestedAt: requestedAt }),
    createdAt: 1,
    startedAt: 2,
    terminalAt,
    updatedAt: terminalAt,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition was not reached");
}
