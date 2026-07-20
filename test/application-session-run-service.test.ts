import assert from "node:assert/strict";
import test from "node:test";

import {
  ApplicationSessionRunService,
  type ApplicationSessionRunServiceOptions,
} from "../src/main/application-session-run-service.js";
import { PersistenceClientError } from "../src/main/persistence-worker-client.js";
import {
  APPLICATION_SESSION_RUN_LIMITS,
  type ApplicationSessionRunAccessValidator,
} from "../src/shared/application-session-run-model.js";

type Authorization = Readonly<{ principal: "owner" }>;
type Reads = ApplicationSessionRunServiceOptions<Authorization>["reads"];
type RunPageProjection = Awaited<ReturnType<Reads["runsPage"]>>;

test("Run history validates the complete request before authorization or persistence", async () => {
  let authorizationCalls = 0;
  let repositoryCalls = 0;
  const service = createService({
    access: {
      async authorize() {
        authorizationCalls += 1;
        return { allowed: true };
      },
    },
    reads: reads({
      sessionGet: async () => {
        repositoryCalls += 1;
        return sessionProjection();
      },
      runsPage: async () => {
        repositoryCalls += 1;
        return pageProjection();
      },
    }),
  });
  const invalid = [
    { ...runsRequest(), sessionId: "" },
    { ...runsRequest(), cursor: "x".repeat(APPLICATION_SESSION_RUN_LIMITS.maxCursorLength + 1) },
    { ...runsRequest(), limit: 0 },
    { ...runsRequest(), limit: APPLICATION_SESSION_RUN_LIMITS.runsMaxItems + 1 },
    { ...runsRequest(), unexpected: true },
    { ...runsRequest(), context: { authorization: { principal: "other" } } },
  ];

  for (const request of invalid) {
    const response = await service.runs(request as never);
    assertFailure(response, "request", "request_invalid", "not_attempted");
  }
  assert.equal(authorizationCalls, 0);
  assert.equal(repositoryCalls, 0);
});

test("Run history denial uses the exact Session target and prevents every Repository call", async () => {
  const calls: unknown[] = [];
  const service = createService({
    access: {
      async authorize(input) {
        calls.push(input);
        return {
          allowed: false,
          error: { code: "forbidden", message: "secret policy", retryable: false },
        };
      },
    },
    reads: reads({
      sessionGet: async () => {
        throw new Error("must not read");
      },
      runsPage: async () => {
        throw new Error("must not read");
      },
    }),
  });

  const response = await service.runs(runsRequest());
  assertFailure(response, "access", "forbidden", "not_attempted");
  assert.equal(JSON.stringify(response).includes("secret policy"), false);
  assert.deepEqual(calls, [
    {
      operation: "runs",
      access: "read",
      context: { authorization: { principal: "owner" } },
      target: { kind: "session_runs", sessionId: "session-1" },
    },
  ]);
});

test("Run history resolves a closed Session scope, applies the default, and projects every phase", async () => {
  const calls: unknown[] = [];
  const rawItems = runPhaseProjections();
  const service = createService({
    access: {
      async authorize(input) {
        calls.push({ operation: "authorize", input });
        return { allowed: true };
      },
    },
    reads: reads({
      sessionGet: async (input, options) => {
        calls.push({ operation: "sessionGet", input, signal: options?.signal instanceof AbortSignal });
        return sessionProjection("closed");
      },
      runsPage: async (input, options) => {
        calls.push({ operation: "runsPage", input, signal: options?.signal instanceof AbortSignal });
        return pageProjection(rawItems, "cursor-2");
      },
    }),
  });

  const response = await service.runs(runsRequest());
  assert.equal(response.overallStatus, "success");
  if (response.overallStatus !== "success") return;
  assert.equal(response.value.sessionId, "session-1");
  assert.equal(response.value.items.length, 9);
  assert.deepEqual(
    response.value.items.map((item) => item.phase),
    ["queued", "starting", "active", "canceling", "finalizing", "completed", "failed", "interrupted", "canceled"],
  );
  assert.equal(
    response.value.items[5]?.phase === "completed" && response.value.items[5].finalAssistantMessageId,
    undefined,
  );
  assert.equal("liveActivity" in (response.value.items[2] ?? {}), false);
  assert.equal("sessionId" in (response.value.items[0] ?? {}), false);
  assert.equal(response.value.nextCursor, "cursor-2");
  assert.deepEqual(calls[1], {
    operation: "sessionGet",
    input: { sessionId: "session-1" },
    signal: true,
  });
  assert.deepEqual(calls[2], {
    operation: "runsPage",
    input: {
      sessionId: "session-1",
      workspaceKey: "workspace",
      limit: APPLICATION_SESSION_RUN_LIMITS.runsDefaultItems,
    },
    signal: true,
  });

  (rawItems[0] as { phase: string }).phase = "completed";
  assert.equal(response.value.items[0]?.phase, "queued");
});

test("Run history accepts exact 1, 50, and 100 limits and forwards cursor without widening scope", async () => {
  for (const limit of [1, 50, APPLICATION_SESSION_RUN_LIMITS.runsMaxItems]) {
    let observed: unknown;
    const service = createService({
      reads: reads({
        runsPage: async (input) => {
          observed = input;
          return pageProjection([]);
        },
      }),
    });
    const response = await service.runs({ ...runsRequest(), cursor: "cursor-1", limit });
    assert.equal(response.overallStatus, "success");
    assert.deepEqual(observed, {
      sessionId: "session-1",
      workspaceKey: "workspace",
      cursor: "cursor-1",
      limit,
    });
  }
});

test("Run history exposes bounded omissions as partial success with ordinal progress", async () => {
  const service = createService({
    reads: reads({
      runsPage: async () =>
        pageProjection(
          [{ omitted: true, reason: "response_size_limit", ordinal: 1 }, runProjection({ runId: "run-2", ordinal: 2 })],
          "cursor-2",
        ),
    }),
  });

  const response = await service.runs(runsRequest());
  assert.equal(response.overallStatus, "partial_success");
  if (response.overallStatus !== "partial_success") return;
  assert.deepEqual(
    response.value.items.map((item) => item.runId),
    ["run-2"],
  );
  assert.deepEqual(response.issues, [
    {
      kind: "omission",
      code: "response_size_limit",
      message: "Run was omitted because the response size limit was reached.",
      ordinal: 1,
    },
  ]);
  assert.equal(response.value.nextCursor, "cursor-2");
});

test("Run history rejects scope drift, forbidden fields, phase tuple drift, ordering, and cursor stalls", async () => {
  const invalidPages: unknown[] = [
    pageProjection([], undefined, { sessionId: "session-other" }),
    pageProjection([], undefined, { workspaceKey: "other" }),
    { ...pageProjection(), unexpected: true },
    pageProjection([{ ...runProjection(), version: 1 }]),
    pageProjection([runProjection({ sessionId: "session-other" })]),
    pageProjection([
      runProjection({ phase: "active", terminalAt: undefined }),
      runProjection({ runId: "run-2", ordinal: 1 }),
    ]),
    pageProjection([runProjection({ phase: "active", terminalAt: undefined, cancelRequestedAt: 1 })]),
    pageProjection([
      runProjection({ phase: "active", terminalAt: undefined, finalAssistantMessageId: "message-final" }),
    ]),
    pageProjection([runProjection({ phase: "completed", failureOrigin: "provider" })]),
    pageProjection([runProjection({ phase: "failed", failureOrigin: undefined })]),
    pageProjection([{ omitted: true, reason: "response_size_limit" }]),
    pageProjection(
      Array.from({ length: 2 }, (_, index) => runProjection({ runId: `run-${index}`, ordinal: index + 1 })),
    ),
  ];

  for (const [index, page] of invalidPages.entries()) {
    const service = createService({ reads: reads({ runsPage: async () => page as RunPageProjection }) });
    const request = index === invalidPages.length - 1 ? { ...runsRequest(), limit: 1 } : runsRequest();
    const response = await service.runs(request);
    assertFailure(response, "application", "internal_error", "failed");
  }

  const stalled = createService({
    reads: reads({ runsPage: async () => pageProjection([runProjection()], "cursor-1") }),
  });
  assertFailure(
    await stalled.runs({ ...runsRequest(), cursor: "cursor-1" }),
    "application",
    "internal_error",
    "failed",
  );
});

test("Run history maps Repository not_found and aborts timeout and cancellation after persistence starts", async () => {
  const notFound = createService({
    reads: reads({
      sessionGet: async () => {
        throw new PersistenceClientError({
          code: "not_found",
          message: "secret path",
          retryable: false,
          effect: "none",
        });
      },
    }),
  });
  const missing = await notFound.runs(runsRequest());
  assertFailure(missing, "domain", "not_found", "rejected");
  assert.equal(JSON.stringify(missing).includes("secret path"), false);

  let timeoutAborted = false;
  const timeoutService = createService({
    reads: reads({
      runsPage: async (_input, options) =>
        pendingUntilAbort(options?.signal, () => {
          timeoutAborted = true;
        }),
    }),
  });
  const timeout = await timeoutService.runs(runsRequest(), { timeoutMs: 5 });
  assertFailure(timeout, "persistence", "persistence_timeout", "failed");
  assert.equal(timeoutAborted, true);

  let cancelAborted = false;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const cancelService = createService({
    reads: reads({
      runsPage: async (_input, options) => {
        markStarted();
        return pendingUntilAbort(options?.signal, () => {
          cancelAborted = true;
        });
      },
    }),
  });
  const controller = new AbortController();
  const pending = cancelService.runs(runsRequest(), { signal: controller.signal });
  await started;
  controller.abort();
  const canceled = await pending;
  assertFailure(canceled, "persistence", "persistence_canceled", "failed");
  assert.equal(cancelAborted, true);
});

function createService(
  overrides: Partial<ApplicationSessionRunServiceOptions<Authorization>> = {},
): ApplicationSessionRunService<Authorization> {
  return new ApplicationSessionRunService({
    reads: overrides.reads ?? reads(),
    access: overrides.access ?? allowAccess(),
    snapshotAuthorization(value) {
      if (typeof value !== "object" || value === null || (value as Authorization).principal !== "owner") {
        throw new TypeError("invalid authorization");
      }
      return { principal: "owner" };
    },
  });
}

function allowAccess(): ApplicationSessionRunAccessValidator<Authorization> {
  return {
    async authorize() {
      return { allowed: true };
    },
  };
}

function reads(overrides: Partial<Reads> = {}): Reads {
  return {
    sessionGet: overrides.sessionGet ?? (async () => sessionProjection()),
    runsPage: overrides.runsPage ?? (async () => pageProjection()),
  };
}

function runsRequest() {
  return { context: { authorization: { principal: "owner" as const } }, sessionId: "session-1" };
}

function sessionProjection(lifecycleStatus: "active" | "archived" | "closed" = "active") {
  return {
    session: { id: "session-1", workspaceKey: "workspace", lifecycleStatus },
    execution: { state: "not_started" },
  } as never;
}

function pageProjection(
  items: readonly unknown[] = [runProjection()],
  nextCursor?: string,
  overrides: Readonly<Record<string, unknown>> = {},
): RunPageProjection {
  return {
    sessionId: "session-1",
    workspaceKey: "workspace",
    items,
    ...(nextCursor === undefined ? {} : { nextCursor }),
    ...overrides,
  } as RunPageProjection;
}

function runProjection(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    runId: "run-1",
    sessionId: "session-1",
    ordinal: 1,
    initiatingMessageId: "message-1",
    phase: "completed",
    createdAt: 1,
    startedAt: 2,
    terminalAt: 3,
    updatedAt: 3,
    ...overrides,
  };
}

function runPhaseProjections(): Record<string, unknown>[] {
  return [
    runProjection({ runId: "run-1", ordinal: 1, phase: "queued", startedAt: undefined, terminalAt: undefined }),
    runProjection({ runId: "run-2", ordinal: 2, phase: "starting", terminalAt: undefined }),
    runProjection({ runId: "run-3", ordinal: 3, phase: "active", terminalAt: undefined }),
    runProjection({ runId: "run-4", ordinal: 4, phase: "canceling", terminalAt: undefined, cancelRequestedAt: 4 }),
    runProjection({ runId: "run-5", ordinal: 5, phase: "finalizing", terminalAt: undefined }),
    runProjection({ runId: "run-6", ordinal: 6, finalAssistantMessageId: undefined }),
    runProjection({
      runId: "run-7",
      ordinal: 7,
      phase: "failed",
      failureOrigin: "provider",
      errorSummary: "failed",
      cancelRequestedAt: 6,
      cancelAcknowledgedAt: 7,
    }),
    runProjection({ runId: "run-8", ordinal: 8, phase: "interrupted", failureOrigin: "transport" }),
    runProjection({ runId: "run-9", ordinal: 9, phase: "canceled", cancelRequestedAt: 8 }),
  ];
}

function assertFailure(
  response: Readonly<Record<string, unknown>>,
  kind: string,
  code: string,
  persistenceStatus: string,
): void {
  assert.equal(response.overallStatus, "failure");
  const error = response.error as Readonly<Record<string, unknown>>;
  const persistence = response.persistence as Readonly<Record<string, unknown>>;
  assert.equal(error.kind, kind);
  assert.equal(error.code, code);
  assert.equal(persistence.status, persistenceStatus);
}

function pendingUntilAbort<TValue>(signal: AbortSignal | undefined, onAbort: () => void): Promise<TValue> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener(
      "abort",
      () => {
        onAbort();
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
