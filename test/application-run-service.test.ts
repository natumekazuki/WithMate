import assert from "node:assert/strict";
import test from "node:test";

import type {
  ApplicationRunAccessValidator,
  ApplicationRunPhase,
  ApplicationRunStatus,
} from "../src/shared/application-run-model.js";
import { ApplicationRunService, type ApplicationRunServiceOptions } from "../src/main/application-run-service.js";
import { PersistenceClientError } from "../src/main/persistence-worker-client.js";

type Authorization = Readonly<{ principal: string }>;
type Reads = ApplicationRunServiceOptions<Authorization>["reads"];

const authorization: Authorization = { principal: "owner" };

test("Run status authorizes the Run target and projects every persisted phase through a strict public allowlist", async () => {
  const phases: readonly ApplicationRunPhase[] = [
    "queued",
    "starting",
    "active",
    "canceling",
    "finalizing",
    "completed",
    "failed",
    "canceled",
    "interrupted",
  ];
  for (const phase of phases) {
    const authorizationTargets: unknown[] = [];
    const service = createService({
      access: allowAccess(authorizationTargets),
      reads: reads({ run: repositoryRun(phase) }),
    });
    const response = await service.status(request());
    assert.equal(response.overallStatus, "success");
    if (response.overallStatus !== "success") continue;
    assert.equal(response.value.phase, phase);
    assert.equal(response.value.sessionId, "session-1");
    assert.equal(response.value.runId, "run-1");
    assert.equal(response.value.liveActivity, null);
    assert.deepEqual(Object.keys(response.value).sort(), expectedStatusKeys(response.value));
    assert.equal(JSON.stringify(response).includes("snapshot-secret"), false);
    assert.equal(JSON.stringify(response).includes("provider-private-code"), false);
    assert.equal(JSON.stringify(response).includes("attempt-1"), false);
    assert.deepEqual(authorizationTargets, [
      {
        operation: "status",
        access: "read",
        context: { authorization },
        target: { kind: "run", sessionId: "session-1", runId: "run-1" },
      },
    ]);
  }
});

test("Run status accepts canceled persistence without cancel timestamps and exposes cancellation only when present", async () => {
  const withoutCancellation = createService({ reads: reads({ run: repositoryRun("canceled") }) });
  const absent = await withoutCancellation.status(request());
  assert.equal(absent.overallStatus, "success");
  if (absent.overallStatus === "success") assert.equal(Object.hasOwn(absent.value, "cancellation"), false);

  const withCancellation = createService({
    reads: reads({
      run: { ...repositoryRun("canceled"), cancelRequestedAt: 20, cancelAcknowledgedAt: 21 },
    }),
  });
  const present = await withCancellation.status(request());
  assert.equal(present.overallStatus, "success");
  if (present.overallStatus === "success") {
    assert.deepEqual("cancellation" in present.value ? present.value.cancellation : undefined, {
      requestedAt: 20,
      acknowledgedAt: 21,
    });
  }
});

test("Run status accepts the full persisted failure summary bound", async () => {
  const summary = "x".repeat(4_096);
  const service = createService({
    reads: reads({ run: { ...repositoryRun("failed"), errorSummary: summary } }),
  });
  const response = await service.status(request());
  assert.equal(response.overallStatus, "success");
  if (response.overallStatus === "success") {
    assert.equal(response.value.phase, "failed");
    if (response.value.phase === "failed") assert.equal(response.value.failure.summary, summary);
  }
});

test("authorization rejection prevents every Repository and live activity call", async () => {
  const calls: string[] = [];
  const service = createService({
    access: {
      async authorize() {
        calls.push("authorize");
        return {
          allowed: false,
          error: { code: "forbidden", message: "denied", retryable: false },
        } as const;
      },
    },
    reads: reads({
      sessionGet: async () => {
        calls.push("sessionGet");
        return sessionProjection();
      },
      runGet: async () => {
        calls.push("runGet");
        return runProjection(repositoryRun("active"));
      },
      runEventsPage: async () => {
        calls.push("events");
        return eventPage();
      },
    }),
    liveActivity: {
      async read() {
        calls.push("live");
        return null;
      },
    },
  });

  const response = await service.status(request());
  assert.equal(response.overallStatus, "failure");
  if (response.overallStatus === "failure") assert.equal(response.error.kind, "access");
  assert.deepEqual(calls, ["authorize"]);
});

test("Run scope mismatch is rejected and Repository not_found stays a domain rejection", async () => {
  const malformedScope = createService({
    reads: reads({ sessionGet: async () => sessionProjection("other-session") }),
  });
  const malformed = await malformedScope.status(request());
  assert.deepEqual(malformed, internalReadFailure());

  const notFound = createService({
    reads: reads({
      runGet: async () => {
        throw persistenceError("not_found");
      },
    }),
  });
  const missing = await notFound.status(request());
  assert.equal(missing.overallStatus, "failure");
  if (missing.overallStatus === "failure") {
    assert.equal(missing.error.kind, "domain");
    assert.equal(missing.error.code, "not_found");
    assert.deepEqual(missing.persistence, { status: "rejected", effect: "none" });
  }
});

test("worker transport failure and malformed persisted phase are not domain terminal outcomes", async () => {
  const unavailable = createService({
    reads: reads({
      runGet: async () => {
        throw persistenceError("worker_crashed");
      },
    }),
  });
  const transport = await unavailable.status(request());
  assert.equal(transport.overallStatus, "failure");
  if (transport.overallStatus === "failure") {
    assert.equal(transport.error.kind, "persistence");
    assert.equal(transport.error.code, "persistence_unavailable");
  }

  const malformed = createService({ reads: reads({ run: { ...repositoryRun("active"), phase: "provider_waiting" } }) });
  assert.deepEqual(await malformed.status(request()), internalReadFailure());
});

test("live activity is explicit, version-correlated, and never projected for a terminal Run", async () => {
  const active = createService({
    reads: reads({ run: repositoryRun("active") }),
    liveActivity: {
      async read() {
        return { sessionId: "session-1", runId: "run-1", runVersion: 7, activity: "waiting_input" };
      },
    },
  });
  const activeResponse = await active.status(request());
  assert.equal(activeResponse.overallStatus, "success");
  if (activeResponse.overallStatus === "success") assert.equal(activeResponse.value.liveActivity, "waiting_input");

  const stale = createService({
    reads: reads({ run: repositoryRun("active") }),
    liveActivity: {
      async read() {
        return { sessionId: "session-1", runId: "run-1", runVersion: 6, activity: "running" };
      },
    },
  });
  const staleResponse = await stale.status(request());
  assert.equal(staleResponse.overallStatus, "success");
  if (staleResponse.overallStatus === "success") assert.equal(staleResponse.value.liveActivity, null);

  let terminalLiveReads = 0;
  const terminal = createService({
    reads: reads({ run: repositoryRun("completed") }),
    liveActivity: {
      async read() {
        terminalLiveReads += 1;
        return { sessionId: "session-1", runId: "run-1", runVersion: 7, activity: "running" };
      },
    },
  });
  const terminalResponse = await terminal.status(request());
  assert.equal(terminalResponse.overallStatus, "success");
  if (terminalResponse.overallStatus === "success") assert.equal(terminalResponse.value.liveActivity, null);
  assert.equal(terminalLiveReads, 0);
});

test("Run events preserve omissions, advance an opaque continuation, and safely map unknown event kinds", async () => {
  const service = createService({
    reads: reads({
      events: eventPage({
        items: [
          {
            id: "event-1",
            runId: "run-1",
            ordinal: 1,
            eventCode: "run.terminal",
            subjectType: "run",
            subjectId: "run-1",
            createdAt: 10,
            internalPayload: "must-not-leak",
          },
          { omitted: true, reason: "response_size_limit", ordinal: 2 },
          {
            id: "event-3",
            runId: "run-1",
            ordinal: 3,
            eventCode: "provider.future.event",
            subjectType: "provider_internal",
            subjectId: "internal-1",
            summary: "redacted diagnostic",
            createdAt: 12,
          },
        ],
        continuationCursor: "v1.after-three",
      }),
    }),
  });
  const response = await service.events({ ...request(), limit: 3 });
  assert.equal(response.overallStatus, "partial_success");
  if (response.overallStatus !== "partial_success") return;
  assert.deepEqual(response.value, {
    sessionId: "session-1",
    runId: "run-1",
    items: [
      { ordinal: 1, kind: "run_terminal", createdAt: 10 },
      { ordinal: 3, kind: "unknown", summary: "redacted diagnostic", createdAt: 12 },
    ],
    nextCursor: "v1.after-three",
  });
  assert.deepEqual(response.issues, [
    {
      kind: "omission",
      code: "response_size_limit",
      message: "Run event was omitted because the response size limit was reached.",
      ordinal: 2,
    },
  ]);
  assert.equal(JSON.stringify(response).includes("provider.future.event"), false);
  assert.equal(JSON.stringify(response).includes("internal-1"), false);
  assert.equal(JSON.stringify(response).includes("must-not-leak"), false);
});

test("Run events reject malformed known subjects and non-increasing ordinals", async () => {
  for (const items of [
    [
      {
        id: "event-1",
        runId: "run-1",
        ordinal: 1,
        eventCode: "run.terminal",
        subjectType: "run",
        subjectId: "other-run",
        createdAt: 1,
      },
    ],
    [unknownEvent(2), unknownEvent(2)],
  ]) {
    const service = createService({ reads: reads({ events: eventPage({ items, continuationCursor: "v1.next" }) }) });
    assert.deepEqual(await service.events(request()), internalReadFailure());
  }

  const changedEmptyCursor = createService({
    reads: reads({ events: eventPage({ continuationCursor: "v1.changed" }) }),
  });
  assert.deepEqual(await changedEmptyCursor.events({ ...request(), cursor: "v1.input" }), internalReadFailure());
});

test("Run events and follow normalize a schema-valid empty event summary to absence", async () => {
  const emptySummaryPage = eventPage({
    items: [{ ...unknownEvent(1), summary: "" }],
    continuationCursor: "v1.one",
  });
  const events = await createService({ reads: reads({ events: emptySummaryPage }) }).events(request());
  assert.equal(events.overallStatus, "success");
  if (events.overallStatus === "success") {
    assert.equal(Object.hasOwn(events.value.items[0] ?? {}, "summary"), false);
  }

  const follow = await createService({ reads: reads({ events: emptySummaryPage }) }).follow({
    ...request(),
    waitMs: 100,
    pollMs: 25,
  });
  assert.equal(follow.overallStatus, "success");
  if (follow.overallStatus === "success") {
    assert.equal(follow.value.reason, "events");
    assert.equal(Object.hasOwn(follow.value.events.items[0] ?? {}, "summary"), false);
  }
});

test("follow returns immediately for an event and closes terminal only when the terminal event is observed", async () => {
  let sleeps = 0;
  const immediate = createService({
    reads: reads({
      run: repositoryRun("active"),
      events: eventPage({ items: [unknownEvent(1)], continuationCursor: "v1.one" }),
    }),
    sleeper: {
      async sleep() {
        sleeps += 1;
      },
    },
  });
  const eventResponse = await immediate.follow({ ...request(), waitMs: 100, pollMs: 25 });
  assert.equal(eventResponse.overallStatus, "success");
  if (eventResponse.overallStatus === "success") assert.equal(eventResponse.value.reason, "events");
  assert.equal(sleeps, 0);

  const terminalPage = eventPage({
    items: [
      {
        id: "event-terminal",
        runId: "run-1",
        ordinal: 1,
        eventCode: "run.terminal",
        subjectType: "run",
        subjectId: "run-1",
        createdAt: 11,
      },
    ],
    continuationCursor: "v1.terminal",
  });
  const terminal = createService({
    reads: reads({ run: repositoryRun("completed"), events: terminalPage }),
  });
  const terminalResponse = await terminal.follow({ ...request(), waitMs: 100, pollMs: 25 });
  assert.equal(terminalResponse.overallStatus, "success");
  if (terminalResponse.overallStatus === "success") {
    assert.equal(terminalResponse.value.reason, "terminal");
    assert.equal(terminalResponse.value.events.items[0]?.kind, "run_terminal");
  }
});

test("follow probes events after a terminal status and rechecks status when the terminal commit wins the race", async () => {
  const terminalEvent = eventPage({
    items: [
      {
        id: "event-terminal",
        runId: "run-1",
        ordinal: 1,
        eventCode: "run.terminal",
        subjectType: "run",
        subjectId: "run-1",
        createdAt: 11,
      },
    ],
    continuationCursor: "v1.terminal",
  });

  const terminalFirstOrder: string[] = [];
  const terminalFirst = createService({
    reads: reads({
      runGet: async () => {
        terminalFirstOrder.push("status");
        return runProjection(repositoryRun("completed"));
      },
      runEventsPage: async () => {
        terminalFirstOrder.push("events");
        return terminalEvent;
      },
    }),
  });
  const terminalFirstResponse = await terminalFirst.follow({ ...request(), waitMs: 100, pollMs: 25 });
  assert.deepEqual(terminalFirstOrder, ["status", "events"]);
  assert.equal(terminalFirstResponse.overallStatus, "success");
  if (terminalFirstResponse.overallStatus === "success") {
    assert.equal(terminalFirstResponse.value.reason, "terminal");
    assert.equal(terminalFirstResponse.value.events.items[0]?.kind, "run_terminal");
  }

  let phase: ApplicationRunPhase = "active";
  let statusReads = 0;
  const eventWinsRace = createService({
    reads: reads({
      runGet: async () => {
        statusReads += 1;
        return runProjection(repositoryRun(phase));
      },
      runEventsPage: async () => {
        phase = "completed";
        return terminalEvent;
      },
    }),
  });
  const raceResponse = await eventWinsRace.follow({ ...request(), waitMs: 100, pollMs: 25 });
  assert.equal(statusReads, 2);
  assert.equal(raceResponse.overallStatus, "success");
  if (raceResponse.overallStatus === "success") assert.equal(raceResponse.value.reason, "terminal");
});

test("follow drains terminal backlog before closure and closes an empty terminal tail", async () => {
  let eventReads = 0;
  const backlog = createService({
    reads: reads({
      run: repositoryRun("completed"),
      runEventsPage: async () => {
        eventReads += 1;
        return eventReads === 1
          ? eventPage({ items: [unknownEvent(1)], continuationCursor: "v1.one", hasMore: true })
          : eventPage({
              items: [terminalEvent(2)],
              continuationCursor: "v1.two",
            });
      },
    }),
  });

  const first = await backlog.follow({ ...request(), waitMs: 100, pollMs: 25 });
  assert.equal(first.overallStatus, "success");
  if (first.overallStatus === "success") {
    assert.equal(first.value.reason, "events");
    assert.equal(first.value.events.nextCursor, "v1.one");
  }

  const second = await backlog.follow({ ...request(), cursor: "v1.one", waitMs: 100, pollMs: 25 });
  assert.equal(second.overallStatus, "success");
  if (second.overallStatus === "success") {
    assert.equal(second.value.reason, "terminal");
    assert.equal(second.value.events.items[0]?.kind, "run_terminal");
  }

  const emptyTail = createService({ reads: reads({ run: repositoryRun("completed") }) });
  const empty = await emptyTail.follow({ ...request(), waitMs: 100, pollMs: 25 });
  assert.equal(empty.overallStatus, "success");
  if (empty.overallStatus === "success") {
    assert.equal(empty.value.reason, "terminal");
    assert.deepEqual(empty.value.events.items, []);
  }
});

test("follow returns omission-only progress as a partial event page without polling", async () => {
  let sleeps = 0;
  const service = createService({
    reads: reads({
      events: eventPage({
        items: [{ omitted: true, reason: "response_size_limit", ordinal: 1 }],
        continuationCursor: "v1.one",
      }),
    }),
    sleeper: {
      async sleep() {
        sleeps += 1;
      },
    },
  });

  const response = await service.follow({ ...request(), waitMs: 100, pollMs: 25 });
  assert.equal(response.overallStatus, "partial_success");
  if (response.overallStatus === "partial_success") {
    assert.equal(response.value.reason, "events");
    assert.equal(response.value.events.nextCursor, "v1.one");
    assert.equal(response.issues[0]?.ordinal, 1);
  }
  assert.equal(sleeps, 0);
});

test("follow uses an absolute application wait deadline and performs a final deterministic probe", async () => {
  const sleeps: number[] = [];
  let now = 0;
  let eventReads = 0;
  const service = createService({
    reads: reads({
      run: repositoryRun("active"),
      runEventsPage: async () => {
        eventReads += 1;
        return eventPage({ continuationCursor: "v1.zero" });
      },
    }),
    clock: { now: () => now },
    sleeper: {
      async sleep(milliseconds) {
        sleeps.push(milliseconds);
        now += milliseconds;
      },
    },
  });
  const response = await service.follow({ ...request(), waitMs: 60, pollMs: 25 });
  assert.equal(response.overallStatus, "success");
  if (response.overallStatus === "success") assert.equal(response.value.reason, "deadline");
  assert.deepEqual(sleeps, [25, 25, 10]);
  assert.equal(eventReads, 4);
});

test("follow returns an event added after one deterministic poll", async () => {
  let now = 0;
  let eventReads = 0;
  const sleeps: number[] = [];
  const service = createService({
    reads: reads({
      run: repositoryRun("active"),
      runEventsPage: async () => {
        eventReads += 1;
        return eventReads === 1
          ? eventPage({ continuationCursor: "v1.zero" })
          : eventPage({ items: [unknownEvent(1)], continuationCursor: "v1.one" });
      },
    }),
    clock: { now: () => now },
    sleeper: {
      async sleep(milliseconds) {
        sleeps.push(milliseconds);
        now += milliseconds;
      },
    },
  });
  const response = await service.follow({ ...request(), waitMs: 100, pollMs: 25 });
  assert.equal(response.overallStatus, "success");
  if (response.overallStatus === "success") {
    assert.equal(response.value.reason, "events");
    assert.equal(response.value.events.items[0]?.ordinal, 1);
  }
  assert.deepEqual(sleeps, [25]);
  assert.equal(eventReads, 2);
});

test("follow abort is an operation failure after read and never mutates the persisted Run", async () => {
  const controller = new AbortController();
  const phases: ApplicationRunPhase[] = [];
  const service = createService({
    reads: reads({
      runGet: async () => {
        phases.push("active");
        return runProjection(repositoryRun("active"));
      },
    }),
    clock: { now: () => 0 },
    sleeper: {
      async sleep() {
        controller.abort();
        throw new Error("aborted");
      },
    },
  });
  const response = await service.follow({ ...request(), waitMs: 100, pollMs: 25 }, { signal: controller.signal });
  assert.equal(response.overallStatus, "failure");
  if (response.overallStatus === "failure") {
    assert.equal(response.error.kind, "persistence");
    assert.equal(response.error.code, "persistence_canceled");
  }
  assert.deepEqual(phases, ["active"]);
});

test("follow hard timeout interrupts both a pending Repository read and a pending poll sleep", async () => {
  const pendingRead = createService({
    reads: reads({
      runEventsPage: async (_request, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new Error("read aborted")), { once: true });
        }),
    }),
  });
  const readResponse = await pendingRead.follow({ ...request(), waitMs: 100, pollMs: 25 }, { timeoutMs: 10 });
  assert.equal(readResponse.overallStatus, "failure");
  if (readResponse.overallStatus === "failure") {
    assert.equal(readResponse.error.kind, "persistence");
    assert.equal(readResponse.error.code, "persistence_timeout");
  }

  const pendingSleep = createService({
    sleeper: {
      async sleep(_milliseconds, signal) {
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("sleep aborted")), { once: true });
        });
      },
    },
  });
  const sleepResponse = await pendingSleep.follow({ ...request(), waitMs: 100, pollMs: 25 }, { timeoutMs: 10 });
  assert.equal(sleepResponse.overallStatus, "failure");
  if (sleepResponse.overallStatus === "failure") {
    assert.equal(sleepResponse.error.kind, "persistence");
    assert.equal(sleepResponse.error.code, "persistence_timeout");
  }
});

test("deadline before the first Repository port call remains a pre-persistence timeout", async () => {
  const originalNow = Date.now;
  let repositoryCalls = 0;
  Date.now = () => {
    const stack = new Error().stack ?? "";
    return stack.includes("runControlled") && stack.includes("readRepository") ? 10 : 0;
  };
  try {
    const service = createService({
      reads: reads({
        sessionGet: async () => {
          repositoryCalls += 1;
          return sessionProjection();
        },
      }),
    });

    const response = await service.status(request(), { timeoutMs: 5 });

    assert.equal(response.overallStatus, "failure");
    if (response.overallStatus === "failure") {
      assert.equal(response.error.kind, "operation");
      assert.equal(response.error.code, "operation_timeout");
      assert.deepEqual(response.persistence, { status: "not_attempted", effect: "none" });
    }
    assert.equal(repositoryCalls, 0);
  } finally {
    Date.now = originalNow;
  }
});

test("Run response projections remain inside the operation deadline after Repository start", async () => {
  const blockPastDeadline = () => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < 20) {
      // Projection is synchronous, so the caller-visible deadline must be checked after it completes.
    }
  };
  const persistedRun = Object.defineProperty({ sessionId: "session-1", workspaceKey: "workspace-1" }, "run", {
    enumerable: true,
    get() {
      blockPastDeadline();
      return repositoryRun("completed");
    },
  });
  const eventPageAfterDeadline = Object.defineProperty(
    {
      sessionId: "session-1",
      runId: "run-1",
      workspaceKey: "workspace-1",
      continuationCursor: "v1.zero",
      hasMore: false,
    },
    "items",
    {
      enumerable: true,
      get() {
        blockPastDeadline();
        return [];
      },
    },
  );
  const liveActivityAfterDeadline = Object.defineProperty(
    { sessionId: "session-1", runId: "run-1", runVersion: 7 },
    "activity",
    {
      enumerable: true,
      get() {
        blockPastDeadline();
        return "running";
      },
    },
  );

  const status = await createService({
    reads: reads({ runGet: async () => persistedRun as Awaited<ReturnType<Reads["runGet"]>> }),
  }).status(request(), { timeoutMs: 5 });
  const events = await createService({
    reads: reads({
      runEventsPage: async () => eventPageAfterDeadline as Awaited<ReturnType<Reads["runEventsPage"]>>,
    }),
  }).events(request(), { timeoutMs: 5 });
  const live = await createService({
    reads: reads({ run: repositoryRun("active") }),
    liveActivity: {
      async read() {
        return liveActivityAfterDeadline as never;
      },
    },
  }).status(request(), { timeoutMs: 5 });
  let clockReads = 0;
  const followClock = await createService({
    clock: {
      now() {
        clockReads += 1;
        if (clockReads > 1) blockPastDeadline();
        return 0;
      },
    },
  }).follow({ ...request(), waitMs: 0, pollMs: 25 }, { timeoutMs: 5 });

  for (const response of [status, events, live, followClock]) {
    assert.equal(response.overallStatus, "failure");
    if (response.overallStatus !== "failure") continue;
    assert.equal(response.error.kind, "persistence");
    assert.equal(response.error.code, "persistence_timeout");
    assert.deepEqual(response.persistence, { status: "failed", effect: "none" });
  }
});

test("Run deadline starts before option decoding and wins when request decoding throws", async () => {
  const blockPastDeadline = () => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < 20) {
      // The operation deadline starts at the public method boundary.
    }
  };
  const slowOptions = Object.defineProperty({}, "timeoutMs", {
    enumerable: true,
    get() {
      blockPastDeadline();
      return 5;
    },
  });
  const throwingRequest = Object.defineProperty({ sessionId: "session-1", runId: "run-1" }, "context", {
    enumerable: true,
    get() {
      blockPastDeadline();
      throw new Error("request projection failed after deadline");
    },
  });
  const service = createService();

  const optionResponse = await service.status(request(), slowOptions as never);
  const requestResponse = await service.status(throwingRequest as never, { timeoutMs: 5 });

  for (const response of [optionResponse, requestResponse]) {
    assert.equal(response.overallStatus, "failure");
    if (response.overallStatus !== "failure") continue;
    assert.equal(response.error.kind, "operation");
    assert.equal(response.error.code, "operation_timeout");
    assert.deepEqual(response.persistence, { status: "not_attempted", effect: "none" });
  }
});

test("Run cancellation during projection wins over an internal projection failure", async () => {
  const accessController = new AbortController();
  const accessDecision = Object.defineProperty({}, "allowed", {
    enumerable: true,
    get() {
      accessController.abort();
      throw new Error("access projection failed after cancellation");
    },
  });
  const accessResponse = await createService({
    access: {
      async authorize() {
        return accessDecision as never;
      },
    },
  }).status(request(), { signal: accessController.signal });

  const persistenceController = new AbortController();
  const persistedRun = Object.defineProperty({ sessionId: "session-1", workspaceKey: "workspace-1" }, "run", {
    enumerable: true,
    get() {
      persistenceController.abort();
      throw new Error("Repository projection failed after cancellation");
    },
  });
  const persistenceResponse = await createService({
    reads: reads({ runGet: async () => persistedRun as Awaited<ReturnType<Reads["runGet"]>> }),
  }).status(request(), { signal: persistenceController.signal });

  assert.equal(accessResponse.overallStatus, "failure");
  if (accessResponse.overallStatus === "failure") {
    assert.equal(accessResponse.error.code, "operation_canceled");
    assert.deepEqual(accessResponse.persistence, { status: "not_attempted", effect: "none" });
  }
  assert.equal(persistenceResponse.overallStatus, "failure");
  if (persistenceResponse.overallStatus === "failure") {
    assert.equal(persistenceResponse.error.code, "persistence_canceled");
    assert.deepEqual(persistenceResponse.persistence, { status: "failed", effect: "none" });
  }
});

test("Run interruption wins when a port throws synchronously after timeout or cancellation", async () => {
  const blockPastDeadline = () => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < 20) {
      // A synchronous port failure must not hide an operation interruption.
    }
  };
  const accessTimeout = await createService({
    access: {
      authorize() {
        blockPastDeadline();
        throw new Error("access failed after timeout");
      },
    },
  }).status(request(), { timeoutMs: 5 });
  const accessController = new AbortController();
  const accessCancellation = await createService({
    access: {
      authorize() {
        accessController.abort();
        throw new Error("access failed after cancellation");
      },
    },
  }).status(request(), { signal: accessController.signal });
  const repositoryTimeout = await createService({
    reads: reads({
      sessionGet() {
        blockPastDeadline();
        throw new Error("Repository failed after timeout");
      },
    }),
  }).status(request(), { timeoutMs: 5 });
  const persistenceController = new AbortController();
  const repositoryCancellation = await createService({
    reads: reads({
      sessionGet() {
        persistenceController.abort();
        throw new Error("Repository failed after cancellation");
      },
    }),
  }).status(request(), { signal: persistenceController.signal });

  for (const [response, code] of [
    [accessTimeout, "operation_timeout"],
    [accessCancellation, "operation_canceled"],
    [repositoryTimeout, "persistence_timeout"],
    [repositoryCancellation, "persistence_canceled"],
  ] as const) {
    assert.equal(response.overallStatus, "failure");
    if (response.overallStatus !== "failure") continue;
    assert.equal(response.error.code, code);
    assert.deepEqual(
      response.persistence,
      code.startsWith("operation_")
        ? { status: "not_attempted", effect: "none" }
        : { status: "failed", effect: "none" },
    );
  }
});

function createService(
  overrides: Partial<ApplicationRunServiceOptions<Authorization>> = {},
): ApplicationRunService<Authorization> {
  return new ApplicationRunService({
    reads: overrides.reads ?? reads(),
    access: overrides.access ?? allowAccess(),
    snapshotAuthorization(value) {
      if (typeof value !== "object" || value === null || (value as Authorization).principal !== "owner") {
        throw new TypeError("invalid authorization");
      }
      return { principal: "owner" };
    },
    ...(overrides.liveActivity === undefined ? {} : { liveActivity: overrides.liveActivity }),
    ...(overrides.clock === undefined ? {} : { clock: overrides.clock }),
    ...(overrides.sleeper === undefined ? {} : { sleeper: overrides.sleeper }),
  });
}

function allowAccess(targets: unknown[] = []): ApplicationRunAccessValidator<Authorization> {
  return {
    async authorize(input) {
      targets.push(input);
      return { allowed: true };
    },
  };
}

function reads(
  overrides: Readonly<{
    run?: Readonly<Record<string, unknown>>;
    events?: Readonly<Record<string, unknown>>;
    sessionGet?: Reads["sessionGet"];
    runGet?: Reads["runGet"];
    runEventsPage?: Reads["runEventsPage"];
  }> = {},
): Reads {
  return {
    sessionGet: overrides.sessionGet ?? (async () => sessionProjection()),
    runGet:
      overrides.runGet ??
      (async () => runProjection(overrides.run ?? repositoryRun("active")) as Awaited<ReturnType<Reads["runGet"]>>),
    runEventsPage:
      overrides.runEventsPage ??
      (async () => (overrides.events ?? eventPage()) as Awaited<ReturnType<Reads["runEventsPage"]>>),
  };
}

function sessionProjection(sessionId = "session-1") {
  return {
    session: {
      id: sessionId,
      workspaceKey: "workspace-1",
      title: "Session",
      providerId: "codex",
      workspacePath: "C:\\workspace",
      localRepositoryKey: null,
      repositoryName: null,
      allowedAdditionalDirectoriesByteLength: 2,
      allowedAdditionalDirectoriesState: "inline" as const,
      defaultCharacterId: "character-1",
      maxConcurrentChildRuns: 1,
      lifecycleStatus: "active" as const,
      createdAt: 1,
      updatedAt: 1,
      lastActivityAt: 1,
    },
    execution: { state: "not_started" as const },
  };
}

function repositoryRun(phase: ApplicationRunPhase): Readonly<Record<string, unknown>> {
  const terminal = phase === "completed" || phase === "failed" || phase === "canceled" || phase === "interrupted";
  const failure = phase === "failed" || phase === "interrupted";
  return {
    id: "run-1",
    sessionId: "session-1",
    ordinal: 1,
    initiatingMessageId: "message-1",
    phase,
    executionSnapshotByteLength: 32,
    executionSnapshotState: "inline",
    executionSnapshot: { secret: "snapshot-secret", attemptId: "attempt-1" },
    externalSideEffectState: "present",
    providerErrorCode: failure ? "provider-private-code" : undefined,
    ...(failure ? { failureOrigin: "provider", errorSummary: "redacted failure" } : {}),
    createdAt: 1,
    ...(phase === "queued" ? {} : { startedAt: 2 }),
    ...(terminal ? { terminalAt: 10 } : {}),
    updatedAt: terminal ? 10 : 3,
    version: 7,
  };
}

function runProjection(run: Readonly<Record<string, unknown>>): Awaited<ReturnType<Reads["runGet"]>> {
  return { sessionId: "session-1", workspaceKey: "workspace-1", run } as Awaited<ReturnType<Reads["runGet"]>>;
}

function eventPage(
  overrides: Readonly<{
    items?: readonly unknown[];
    continuationCursor?: string;
    hasMore?: boolean;
  }> = {},
): Awaited<ReturnType<Reads["runEventsPage"]>> {
  return {
    sessionId: "session-1",
    runId: "run-1",
    workspaceKey: "workspace-1",
    items: overrides.items ?? [],
    continuationCursor: overrides.continuationCursor ?? "v1.zero",
    hasMore: overrides.hasMore ?? false,
  } as Awaited<ReturnType<Reads["runEventsPage"]>>;
}

function unknownEvent(ordinal: number) {
  return {
    id: `event-${ordinal}`,
    runId: "run-1",
    ordinal,
    eventCode: "future.event",
    createdAt: ordinal,
  };
}

function terminalEvent(ordinal: number) {
  return {
    id: `event-${ordinal}`,
    runId: "run-1",
    ordinal,
    eventCode: "run.terminal",
    subjectType: "run",
    subjectId: "run-1",
    createdAt: ordinal,
  };
}

function request() {
  return { context: { authorization }, sessionId: "session-1", runId: "run-1" } as const;
}

function expectedStatusKeys(status: ApplicationRunStatus): string[] {
  const keys = ["createdAt", "liveActivity", "phase", "runId", "sessionId", "updatedAt"];
  if (Object.hasOwn(status, "startedAt")) keys.push("startedAt");
  if (Object.hasOwn(status, "terminalAt")) keys.push("terminalAt");
  if (Object.hasOwn(status, "failure")) keys.push("failure");
  if (Object.hasOwn(status, "cancellation")) keys.push("cancellation");
  return keys.sort();
}

function internalReadFailure() {
  return {
    overallStatus: "failure",
    error: {
      kind: "application",
      code: "internal_error",
      message: "Application Service could not complete the operation.",
      retryable: false,
    },
    persistence: { status: "failed", effect: "none" },
  } as const;
}

function persistenceError(code: "not_found" | "worker_crashed") {
  return new PersistenceClientError({ code, message: code, retryable: code !== "not_found", effect: "none" });
}
