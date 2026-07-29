import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  CODEX_ADAPTER_LIMITS,
  CodexAdapter,
  CodexAppServerTransport,
  CodexTransportError,
  type CodexAdapterEvent,
  type CodexAdapterRequestOptions,
  type CodexAdapterTransportEvent,
  type CodexAdapterTransportPort,
} from "../src/main/providers/codex/index.js";
import { assertBoundedPublicSummary } from "./codex-adapter-test-support.js";

const fixturePath = fileURLToPath(new URL("./fixtures/codex-app-server-fixture.mjs", import.meta.url));

test("operation responses and notifications converge into one lifecycle with a final Message", async () => {
  const transport = new ControlledTransport([threadOperationFixture(), { turn: turnFixture() }]);
  const adapter = createAdapter(transport);

  const thread = await adapter.startThread({
    model: "gpt-5.4",
    workspacePath: process.cwd(),
    approvalPolicy: "never",
    sandboxMode: "read-only",
    persistence: "persistent",
  });
  assert.equal(thread.kind, "accepted");
  assert.equal((await adapter.nextEvent()).kind, "thread_started");
  transport.emit({ kind: "notification", method: "thread/started", params: { thread: threadFixture() } });

  const turn = await adapter.startTurn({
    threadId: "thread-1",
    contentBlocks: [{ type: "text", text: "hello" }],
  });
  assert.equal(turn.kind, "accepted");
  assert.deepEqual(await adapter.nextEvent(), {
    kind: "turn_started",
    turn: { threadId: "thread-1", turnId: "turn-1", status: "in_progress" },
  });
  transport.emit({
    kind: "notification",
    method: "turn/started",
    params: { threadId: "thread-1", turn: turnFixture() },
  });
  transport.emit({
    kind: "notification",
    method: "item/started",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: agentMessageFixture({ text: "" }),
      startedAtMs: 1,
    },
  });
  transport.emit({
    kind: "notification",
    method: "item/agentMessage/delta",
    params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: "final " },
  });
  transport.emit({
    kind: "notification",
    method: "item/agentMessage/delta",
    params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: "answer" },
  });
  transport.emit({
    kind: "notification",
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: agentMessageFixture(),
      completedAtMs: 2,
    },
  });
  transport.emit({
    kind: "notification",
    method: "turn/completed",
    params: { threadId: "thread-1", turn: turnFixture({ status: "completed" }) },
  });

  assert.deepEqual(await adapter.nextEvent(), {
    kind: "turn_terminal",
    threadId: "thread-1",
    turnId: "turn-1",
    status: "completed",
    finalAssistantMessage: { contentBlocks: [{ type: "text", text: "final answer" }] },
    contentFailure: null,
  });
  await adapter.close();
});

test("notification-first Thread start cannot admit a Turn and converges to the latest observed status", async () => {
  const response = deferred<unknown>();
  const transport = new ControlledTransport([response.promise]);
  const adapter = createAdapter(transport);
  const pending = adapter.startThread({
    model: "gpt-5.4",
    workspacePath: process.cwd(),
    approvalPolicy: "never",
    sandboxMode: "read-only",
    persistence: "persistent",
  });
  transport.emit({ kind: "notification", method: "thread/started", params: { thread: threadFixture() } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    await adapter.startTurn({
      threadId: "thread-1",
      contentBlocks: [{ type: "text", text: "must wait" }],
      model: "gpt-5.4",
    }),
    { kind: "not_sent", effect: "none", code: "capability_unavailable" },
  );
  assert.equal(transport.requests.filter((method) => method === "turn/start").length, 0);
  transport.emit({
    kind: "notification",
    method: "thread/status/changed",
    params: { threadId: "thread-1", status: { type: "active", activeFlags: [] } },
  });
  assert.equal((await adapter.nextEvent()).kind, "thread_status_observed");
  response.resolve(threadOperationFixture());

  const result = await pending;
  assert.equal(result.kind, "accepted");
  if (result.kind !== "accepted") assert.fail("expected accepted Thread response");
  assert.equal(result.value.status, "active");
  const started = await adapter.nextEvent();
  assert.equal(started.kind, "thread_started");
  if (started.kind !== "thread_started") assert.fail("expected Thread projection");
  assert.equal(started.thread.status, "active");
  assert.deepEqual(
    await adapter.startTurn({
      threadId: "thread-1",
      contentBlocks: [{ type: "text", text: "must not race an uncorrelated active Turn" }],
    }),
    { kind: "not_sent", effect: "none", code: "capability_unavailable" },
  );
  assert.equal(transport.requests.filter((method) => method === "turn/start").length, 0);
  await adapter.close();
});

test("notification-first Thread identity conflicts make the mutation ambiguous without a start projection", async () => {
  const conflicts = [
    { label: "model provider", thread: { modelProvider: "other-provider" } },
    { label: "workspace", thread: { cwd: resolve(process.cwd(), "other-workspace") } },
    { label: "persistence", thread: { ephemeral: true } },
  ] as const;

  for (const conflict of conflicts) {
    const response = deferred<unknown>();
    const transport = new ControlledTransport([response.promise]);
    const adapter = createAdapter(transport);
    try {
      const pending = adapter.startThread({
        model: "gpt-5.4",
        workspacePath: process.cwd(),
        approvalPolicy: "never",
        sandboxMode: "read-only",
        persistence: "persistent",
      });
      transport.emit({
        kind: "notification",
        method: "thread/started",
        params: { thread: threadFixture(conflict.thread) },
      });
      response.resolve(threadOperationFixture());

      assert.deepEqual(
        await pending,
        { kind: "ambiguous", effect: "unknown", code: "invalid_response" },
        conflict.label,
      );
      assert.equal(diagnosticCode(await adapter.nextEvent()), "identity_mismatch", conflict.label);
    } finally {
      await adapter.close();
    }
  }
});

test("a response-first Thread identity conflict quarantines later Turn mutations", async () => {
  const transport = new ControlledTransport([threadOperationFixture(), { turn: turnFixture() }]);
  const adapter = createAdapter(transport);
  await adapter.startThread({
    model: "gpt-5.4",
    workspacePath: process.cwd(),
    approvalPolicy: "never",
    sandboxMode: "read-only",
    persistence: "persistent",
  });
  assert.equal((await adapter.nextEvent()).kind, "thread_started");
  transport.emit({
    kind: "notification",
    method: "thread/started",
    params: { thread: threadFixture({ ephemeral: true }) },
  });
  assert.equal(diagnosticCode(await adapter.nextEvent()), "identity_mismatch");

  assert.deepEqual(
    await adapter.startTurn({
      threadId: "thread-1",
      contentBlocks: [{ type: "text", text: "must not dispatch" }],
    }),
    { kind: "not_sent", effect: "none", code: "capability_unavailable" },
  );
  assert.equal(transport.requests.filter((method) => method === "turn/start").length, 0);
  assert.deepEqual(await adapter.resumeThread({ threadId: "thread-1" }), {
    kind: "not_sent",
    effect: "none",
    code: "capability_unavailable",
  });
  assert.equal(transport.requests.filter((method) => method === "thread/resume").length, 0);
  await adapter.close();
});

test("a Thread identity conflict while turn/start is pending prevents an accepted projection", async () => {
  const turnResponse = deferred<unknown>();
  const transport = new ControlledTransport([threadOperationFixture(), turnResponse.promise]);
  const adapter = createAdapter(transport);
  await adapter.startThread({
    model: "gpt-5.4",
    workspacePath: process.cwd(),
    approvalPolicy: "never",
    sandboxMode: "read-only",
    persistence: "persistent",
  });
  assert.equal((await adapter.nextEvent()).kind, "thread_started");
  const pending = adapter.startTurn({
    threadId: "thread-1",
    contentBlocks: [{ type: "text", text: "already dispatched" }],
  });
  await new Promise((resolve) => setImmediate(resolve));
  transport.emit({
    kind: "notification",
    method: "thread/started",
    params: { thread: threadFixture({ ephemeral: true }) },
  });
  assert.equal(diagnosticCode(await adapter.nextEvent()), "identity_mismatch");
  turnResponse.resolve({ turn: turnFixture() });

  assert.deepEqual(await pending, { kind: "ambiguous", effect: "unknown", code: "invalid_response" });
  assert.equal(transport.requests.filter((method) => method === "turn/start").length, 1);
  await adapter.close();
});

test("a Thread identity conflict while an active Turn mutation is pending prevents an accepted projection", async () => {
  for (const operation of ["steer", "interrupt"] as const) {
    const operationResponse = deferred<unknown>();
    const transport = new ControlledTransport([
      threadOperationFixture({
        thread: threadFixture({
          status: { type: "active", activeFlags: [] },
          turns: [turnFixture({ id: "turn-restored" })],
        }),
      }),
      operationResponse.promise,
    ]);
    const adapter = createAdapter(transport);
    const resumed = await adapter.resumeThread({ threadId: "thread-1" });
    assert.equal(resumed.kind, "accepted");
    assert.equal((await adapter.nextEvent()).kind, "thread_started");
    assert.equal((await adapter.nextEvent()).kind, "turn_started");

    const pending =
      operation === "steer"
        ? adapter.steerTurn({
            threadId: "thread-1",
            expectedTurnId: "turn-restored",
            contentBlocks: [{ type: "text", text: "already dispatched" }],
          })
        : adapter.interruptTurn({ threadId: "thread-1", turnId: "turn-restored" });
    await new Promise((resolve) => setImmediate(resolve));
    transport.emit({
      kind: "notification",
      method: "thread/started",
      params: {
        thread: threadFixture({
          ephemeral: true,
          status: { type: "active", activeFlags: [] },
          turns: [turnFixture({ id: "turn-restored" })],
        }),
      },
    });
    assert.equal(diagnosticCode(await adapter.nextEvent()), "identity_mismatch");
    operationResponse.resolve(operation === "steer" ? { turnId: "turn-restored" } : {});

    assert.deepEqual(await pending, { kind: "ambiguous", effect: "unknown", code: "invalid_response" }, operation);
    assert.equal(
      transport.requests.filter((method) => method === (operation === "steer" ? "turn/steer" : "turn/interrupt"))
        .length,
      1,
    );
    await adapter.close();
  }
});

test("Thread identity quarantine is rechecked after asynchronous capability validation and before send", async () => {
  for (const operation of ["turn/start", "thread/resume"] as const) {
    const transport = new ControlledTransport([
      threadOperationFixture(),
      operation === "turn/start" ? { turn: turnFixture() } : threadOperationFixture(),
    ]);
    const adapter = createAdapter(transport);
    await adapter.startThread({
      model: "gpt-5.4",
      workspacePath: process.cwd(),
      approvalPolicy: "never",
      sandboxMode: "read-only",
      persistence: "persistent",
    });
    assert.equal((await adapter.nextEvent()).kind, "thread_started");

    transport.emit({
      kind: "notification",
      method: "thread/started",
      params: { thread: threadFixture({ ephemeral: true }) },
    });
    const pending =
      operation === "turn/start"
        ? adapter.startTurn({
            threadId: "thread-1",
            contentBlocks: [{ type: "text", text: "must stop before send" }],
          })
        : adapter.resumeThread({ threadId: "thread-1", model: "gpt-5.4" });
    assert.equal(diagnosticCode(await adapter.nextEvent()), "identity_mismatch");

    assert.deepEqual(await pending, { kind: "not_sent", effect: "none", code: "capability_unavailable" }, operation);
    assert.equal(transport.requests.filter((method) => method === operation).length, 0);
    await adapter.close();
  }
});

test("an observed thread/started makes a contradictory Thread start remote error ambiguous", async () => {
  const threadResponse = deferred<unknown>();
  const transport = new ControlledTransport([threadResponse.promise]);
  const adapter = createAdapter(transport);
  const pending = adapter.startThread({
    model: "gpt-5.4",
    workspacePath: process.cwd(),
    approvalPolicy: "never",
    sandboxMode: "read-only",
    persistence: "persistent",
  });
  await new Promise((resolve) => setImmediate(resolve));
  transport.emit({ kind: "notification", method: "thread/started", params: { thread: threadFixture() } });
  await new Promise((resolve) => setImmediate(resolve));
  threadResponse.reject(new CodexTransportError({ kind: "remote_error", code: -32600 }));

  assert.deepEqual(await pending, { kind: "ambiguous", effect: "unknown", code: "invalid_response" });
  assert.equal(transport.requests.filter((method) => method === "thread/start").length, 1);
  await adapter.close();
});

test("an observed thread/started makes a contradictory Thread resume remote error ambiguous", async () => {
  const threadResponse = deferred<unknown>();
  const transport = new ControlledTransport([threadResponse.promise]);
  const adapter = createAdapter(transport);
  const pending = adapter.resumeThread({ threadId: "thread-1" });
  await new Promise((resolve) => setImmediate(resolve));
  transport.emit({ kind: "notification", method: "thread/started", params: { thread: threadFixture() } });
  await new Promise((resolve) => setImmediate(resolve));
  threadResponse.reject(new CodexTransportError({ kind: "remote_error", code: -32600 }));

  assert.deepEqual(await pending, { kind: "ambiguous", effect: "unknown", code: "invalid_response" });
  assert.equal(transport.requests.filter((method) => method === "thread/resume").length, 1);
  await adapter.close();
});

test("a repeated Thread resume observes a duplicate thread/started before remote error", async () => {
  const firstResponse = deferred<unknown>();
  const repeatedResponse = deferred<unknown>();
  const transport = new ControlledTransport([firstResponse.promise, repeatedResponse.promise]);
  const adapter = createAdapter(transport);
  const first = adapter.resumeThread({ threadId: "thread-1" });
  await new Promise((resolve) => setImmediate(resolve));
  transport.emit({ kind: "notification", method: "thread/started", params: { thread: threadFixture() } });
  await new Promise((resolve) => setImmediate(resolve));
  firstResponse.reject(new CodexTransportError({ kind: "request_not_sent", code: "timeout" }));
  assert.deepEqual(await first, { kind: "not_sent", effect: "none", code: "timeout" });

  const repeated = adapter.resumeThread({ threadId: "thread-1" });
  await new Promise((resolve) => setImmediate(resolve));
  transport.emit({ kind: "notification", method: "thread/started", params: { thread: threadFixture() } });
  await new Promise((resolve) => setImmediate(resolve));
  repeatedResponse.reject(new CodexTransportError({ kind: "remote_error", code: -32600 }));

  assert.deepEqual(await repeated, { kind: "ambiguous", effect: "unknown", code: "invalid_response" });
  assert.equal(diagnosticCode(await adapter.nextEvent()), "duplicate_event");
  await adapter.close();
});

test("request_not_sent remains effect none after a Thread resume notification", async () => {
  const threadResponse = deferred<unknown>();
  const transport = new ControlledTransport([threadResponse.promise, threadOperationFixture()]);
  const adapter = createAdapter(transport);
  const pending = adapter.resumeThread({ threadId: "thread-1" });
  await new Promise((resolve) => setImmediate(resolve));
  transport.emit({ kind: "notification", method: "thread/started", params: { thread: threadFixture() } });
  await new Promise((resolve) => setImmediate(resolve));
  threadResponse.reject(new CodexTransportError({ kind: "request_not_sent", code: "timeout" }));

  assert.deepEqual(await pending, { kind: "not_sent", effect: "none", code: "timeout" });
  assert.equal((await adapter.resumeThread({ threadId: "thread-1" })).kind, "accepted");
  await adapter.close();
});

test("a single pending Thread start rejects different notification and response IDs", async () => {
  const threadResponse = deferred<unknown>();
  const transport = new ControlledTransport([threadResponse.promise]);
  const adapter = createAdapter(transport);
  const pending = adapter.startThread({
    model: "gpt-5.4",
    workspacePath: process.cwd(),
    approvalPolicy: "never",
    sandboxMode: "read-only",
    persistence: "persistent",
  });
  await new Promise((resolve) => setImmediate(resolve));
  transport.emit({ kind: "notification", method: "thread/started", params: { thread: threadFixture() } });
  await new Promise((resolve) => setImmediate(resolve));
  threadResponse.resolve(
    threadOperationFixture({
      thread: threadFixture({ id: "thread-response" }),
    }),
  );

  assert.deepEqual(await pending, { kind: "ambiguous", effect: "unknown", code: "invalid_response" });
  assert.deepEqual(
    await adapter.startTurn({
      threadId: "thread-response",
      contentBlocks: [{ type: "text", text: "must not select a candidate" }],
      model: "gpt-5.4",
    }),
    { kind: "not_sent", effect: "none", code: "capability_unavailable" },
  );
  assert.equal(transport.requests.filter((method) => method === "turn/start").length, 0);
  await adapter.close();
});

test("a notification during concurrent Thread starts keeps an uncorrelated failure ambiguous", async () => {
  const firstResponse = deferred<unknown>();
  const secondResponse = deferred<unknown>();
  const transport = new ControlledTransport([
    { data: [modelFixture()], nextCursor: null },
    firstResponse.promise,
    secondResponse.promise,
  ]);
  const adapter = createAdapter(transport);
  const input = {
    model: "gpt-5.4",
    workspacePath: process.cwd(),
    approvalPolicy: "never" as const,
    sandboxMode: "read-only" as const,
    persistence: "persistent" as const,
  };
  const first = adapter.startThread(input);
  const second = adapter.startThread(input);
  await new Promise((resolve) => setImmediate(resolve));
  transport.emit({
    kind: "notification",
    method: "thread/started",
    params: { thread: threadFixture({ id: "thread-observed" }) },
  });
  await new Promise((resolve) => setImmediate(resolve));
  firstResponse.resolve(
    threadOperationFixture({
      thread: threadFixture({ id: "thread-observed" }),
    }),
  );
  secondResponse.reject(new CodexTransportError({ kind: "remote_error", code: -32600 }));

  assert.equal((await first).kind, "accepted");
  assert.deepEqual(await second, { kind: "ambiguous", effect: "unknown", code: "invalid_response" });
  assert.equal(transport.requests.filter((method) => method === "thread/start").length, 2);
  await adapter.close();
});

test("a delayed notification for a response-confirmed Thread is not attributed to a later thread/start", async () => {
  const secondResponse = deferred<unknown>();
  const transport = new ControlledTransport([
    threadOperationFixture({
      thread: threadFixture({ id: "thread-a", sessionId: "session-a" }),
    }),
    secondResponse.promise,
  ]);
  const adapter = createAdapter(transport);
  const input = {
    model: "gpt-5.4",
    workspacePath: process.cwd(),
    approvalPolicy: "never" as const,
    sandboxMode: "read-only" as const,
    persistence: "persistent" as const,
  };

  const first = await adapter.startThread(input);
  assert.equal(first.kind, "accepted");
  assert.equal(first.kind === "accepted" ? first.value.threadId : undefined, "thread-a");
  assert.equal((await adapter.nextEvent()).kind, "thread_started");

  const second = adapter.startThread(input);
  await new Promise((resolve) => setImmediate(resolve));
  transport.emit({
    kind: "notification",
    method: "thread/started",
    params: {
      thread: threadFixture({ id: "thread-a", sessionId: "session-a" }),
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  secondResponse.resolve(
    threadOperationFixture({
      thread: threadFixture({ id: "thread-b", sessionId: "session-b" }),
    }),
  );

  const secondResult = await second;
  assert.equal(secondResult.kind, "accepted");
  assert.equal(secondResult.kind === "accepted" ? secondResult.value.threadId : undefined, "thread-b");
  assert.equal((await adapter.nextEvent()).kind, "thread_started");
  assert.equal(transport.requests.filter((method) => method === "thread/start").length, 2);
  await adapter.close();
});

test("unknown notifications preserve their full correlation tuple without suppressing a distinct occurrence", async () => {
  const transport = new ControlledTransport([threadOperationFixture()]);
  const adapter = createAdapter(transport);
  const unknown = {
    kind: "notification" as const,
    method: "future/progress",
    params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", progress: 1 },
  };
  transport.emit(unknown);
  const metadata = await adapter.nextEvent();
  assert.equal(metadata.kind, "provider_metadata");
  if (metadata.kind !== "provider_metadata") assert.fail("expected provider metadata");
  const { summary: metadataSummary, ...metadataOutput } = metadata.output;
  assertBoundedPublicSummary(metadataSummary);
  assert.deepEqual(
    { ...metadata, output: metadataOutput },
    {
      kind: "provider_metadata",
      correlation: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1" },
      output: {
        category: "provider_metadata",
        kind: "future/progress",
        completionState: "complete",
        payload: { kind: "none", redaction: "not_required" },
      },
    },
  );
  const diagnostic = await adapter.nextEvent();
  assert.equal(diagnostic.kind, "diagnostic");
  if (diagnostic.kind !== "diagnostic") assert.fail("expected diagnostic");
  const { summary: diagnosticSummary, ...diagnosticDetails } = diagnostic.diagnostic;
  assertBoundedPublicSummary(diagnosticSummary);
  assert.deepEqual(diagnosticDetails, {
    code: "unknown_notification",
    method: "future/progress",
    correlation: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
    },
    redaction: "not_required",
  });

  transport.emit(unknown);
  assert.equal((await adapter.nextEvent()).kind, "provider_metadata");
  assert.equal(diagnosticCode(await adapter.nextEvent()), "unknown_notification");

  assert.equal(
    (
      await adapter.startThread({
        model: "gpt-5.4",
        workspacePath: process.cwd(),
        approvalPolicy: "never",
        sandboxMode: "read-only",
        persistence: "persistent",
      })
    ).kind,
    "accepted",
  );
  assert.equal((await adapter.nextEvent()).kind, "thread_started");
  await adapter.close();
});

test("stable token usage, warning, and error notifications map without raw provider details", async () => {
  const transport = new ControlledTransport([threadOperationFixture(), { turn: turnFixture() }]);
  const adapter = createAdapter(transport);
  await adapter.startThread({
    model: "gpt-5.4",
    workspacePath: process.cwd(),
    approvalPolicy: "never",
    sandboxMode: "read-only",
    persistence: "persistent",
  });
  await adapter.nextEvent();
  await adapter.startTurn({ threadId: "thread-1", contentBlocks: [{ type: "text", text: "go" }] });
  await adapter.nextEvent();
  const providerBreakdown = {
    inputTokens: 10,
    cachedInputTokens: 2,
    outputTokens: 4,
    reasoningOutputTokens: 1,
    totalTokens: 14,
  };
  const breakdown = { ...providerBreakdown, cacheWriteInputTokens: 0 };
  transport.emit({
    kind: "notification",
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      tokenUsage: {
        last: { ...providerBreakdown },
        total: { ...providerBreakdown },
        modelContextWindow: 128_000,
      },
    },
  });
  const tokenUsage = await adapter.nextEvent();
  assert.equal(tokenUsage.kind, "turn_output");
  if (tokenUsage.kind !== "turn_output") assert.fail("expected token usage output");
  const { summary: tokenUsageSummary, ...tokenUsageOutput } = tokenUsage.output;
  assertBoundedPublicSummary(tokenUsageSummary);
  assert.deepEqual(
    { ...tokenUsage, output: tokenUsageOutput },
    {
      kind: "turn_output",
      threadId: "thread-1",
      turnId: "turn-1",
      output: {
        category: "telemetry",
        kind: "token_usage",
        completionState: "complete",
        payload: {
          kind: "token_usage",
          last: breakdown,
          total: breakdown,
          modelContextWindow: 128_000,
          redaction: "not_required",
        },
      },
    },
  );

  transport.emit({ kind: "notification", method: "warning", params: { message: "private warning" } });
  const warning = await adapter.nextEvent();
  assert.equal(warning.kind, "diagnostic");
  if (warning.kind !== "diagnostic") assert.fail("expected provider warning diagnostic");
  const { summary: warningSummary, ...warningDetails } = warning.diagnostic;
  assertBoundedPublicSummary(warningSummary, ["private warning"]);
  assert.deepEqual(warningDetails, {
    code: "provider_warning",
    method: "warning",
    redaction: "applied",
  });

  transport.emit({
    kind: "notification",
    method: "error",
    params: {
      error: { message: "private error" },
      threadId: "thread-1",
      turnId: "turn-1",
      willRetry: true,
    },
  });
  const error = await adapter.nextEvent();
  if (error.kind !== "diagnostic") assert.fail("expected provider diagnostic");
  const { summary: errorSummary, ...errorDetails } = error.diagnostic;
  assertBoundedPublicSummary(errorSummary, ["private error"]);
  assert.deepEqual(errorDetails, {
    code: "provider_error",
    method: "error",
    correlation: { threadId: "thread-1", turnId: "turn-1" },
    willRetry: true,
    redaction: "applied",
  });

  transport.emit({
    kind: "notification",
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      tokenUsage: {
        last: { ...providerBreakdown },
        total: { ...providerBreakdown },
        modelContextWindow: 128_000,
      },
    },
  });
  assert.equal(diagnosticCode(await adapter.nextEvent()), "duplicate_event");
  transport.emit({
    kind: "notification",
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      tokenUsage: {
        last: { ...providerBreakdown },
        total: { ...providerBreakdown, totalTokens: 13 },
      },
    },
  });
  assert.equal(diagnosticCode(await adapter.nextEvent()), "out_of_order_event");
  transport.emit({
    kind: "notification",
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      tokenUsage: {
        last: { ...providerBreakdown },
        total: { ...providerBreakdown, inputTokens: 9, totalTokens: 15 },
      },
    },
  });
  assert.equal(diagnosticCode(await adapter.nextEvent()), "out_of_order_event");
  transport.emit({
    kind: "notification",
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      tokenUsage: {
        last: { ...providerBreakdown, inputTokens: 11, totalTokens: 15 },
        total: { ...providerBreakdown, totalTokens: 15 },
      },
    },
  });
  assert.equal(diagnosticCode(await adapter.nextEvent()), "out_of_order_event");
  transport.emit({
    kind: "notification",
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "thread-1",
      turnId: "turn-2",
      tokenUsage: { last: { ...providerBreakdown }, total: { ...providerBreakdown } },
    },
  });
  assert.equal(diagnosticCode(await adapter.nextEvent()), "identity_mismatch");
  transport.emit({
    kind: "notification",
    method: "turn/completed",
    params: { threadId: "thread-1", turn: turnFixture({ status: "completed" }) },
  });
  assert.equal((await adapter.nextEvent()).kind, "turn_terminal");
  transport.emit({
    kind: "notification",
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      tokenUsage: { last: { ...providerBreakdown }, total: { ...providerBreakdown } },
    },
  });
  assert.equal(diagnosticCode(await adapter.nextEvent()), "out_of_order_event");
  transport.emit({
    kind: "notification",
    method: "error",
    params: {
      error: { message: "late private error" },
      threadId: "thread-1",
      turnId: "turn-1",
      willRetry: false,
    },
  });
  const lateError = await adapter.nextEvent();
  assert.equal(lateError.kind, "diagnostic");
  if (lateError.kind !== "diagnostic") assert.fail("expected late error diagnostic");
  const { summary: lateErrorSummary, ...lateErrorDetails } = lateError.diagnostic;
  assertBoundedPublicSummary(lateErrorSummary, ["late private error"]);
  assert.deepEqual(lateErrorDetails, {
    code: "out_of_order_event",
    method: "error",
    correlation: { threadId: "thread-1", turnId: "turn-1" },
    redaction: "not_required",
  });
  await adapter.close();
});

test("token usage accepts a smaller latest request when cumulative totals advance", async () => {
  const transport = new ControlledTransport([threadOperationFixture(), { turn: turnFixture() }]);
  const adapter = createAdapter(transport);
  await adapter.startThread({
    model: "gpt-5.4",
    workspacePath: process.cwd(),
    approvalPolicy: "never",
    sandboxMode: "read-only",
    persistence: "persistent",
  });
  await adapter.nextEvent();
  await adapter.startTurn({ threadId: "thread-1", contentBlocks: [{ type: "text", text: "go" }] });
  await adapter.nextEvent();

  const first = {
    inputTokens: 100,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 100,
  };
  transport.emit({
    kind: "notification",
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      tokenUsage: { last: { ...first }, total: { ...first } },
    },
  });
  const firstEvent = await adapter.nextEvent();
  assert.equal(firstEvent.kind, "turn_output", JSON.stringify(firstEvent));

  const last = {
    inputTokens: 10,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 10,
  };
  const total = {
    inputTokens: 110,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 110,
  };
  transport.emit({
    kind: "notification",
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      tokenUsage: { last: { ...last }, total: { ...total } },
    },
  });

  const event = await adapter.nextEvent();
  assert.equal(event.kind, "turn_output");
  if (
    event.kind !== "turn_output" ||
    event.output.kind !== "token_usage" ||
    event.output.payload.kind !== "token_usage"
  ) {
    assert.fail("expected a token usage output");
  }
  assert.deepEqual(event.output.payload.last, { ...last, cacheWriteInputTokens: 0 });
  assert.deepEqual(event.output.payload.total, { ...total, cacheWriteInputTokens: 0 });
  await adapter.close();
});

test("terminal-first turn/start converges while an active Turn still rejects duplicate send", async () => {
  const delayedTurn = deferred<unknown>();
  const terminalFirstTransport = new ControlledTransport([threadOperationFixture(), delayedTurn.promise]);
  const terminalFirstAdapter = createAdapter(terminalFirstTransport);
  await terminalFirstAdapter.startThread({
    model: "gpt-5.4",
    workspacePath: process.cwd(),
    approvalPolicy: "never",
    sandboxMode: "read-only",
    persistence: "persistent",
  });
  assert.equal((await terminalFirstAdapter.nextEvent()).kind, "thread_started");
  const terminalFirstResult = terminalFirstAdapter.startTurn({
    threadId: "thread-1",
    contentBlocks: [{ type: "text", text: "go" }],
  });
  await new Promise((resolve) => setImmediate(resolve));
  terminalFirstTransport.emit({
    kind: "notification",
    method: "turn/completed",
    params: { threadId: "thread-1", turn: turnFixture({ status: "completed" }) },
  });
  assert.deepEqual(await terminalFirstAdapter.nextEvent(), {
    kind: "turn_started",
    turn: { threadId: "thread-1", turnId: "turn-1", status: "in_progress" },
  });
  assert.deepEqual(await terminalFirstAdapter.nextEvent(), {
    kind: "turn_terminal",
    threadId: "thread-1",
    turnId: "turn-1",
    status: "completed",
    finalAssistantMessage: null,
    contentFailure: null,
  });
  delayedTurn.resolve({ turn: turnFixture() });
  assert.deepEqual(await terminalFirstResult, {
    kind: "accepted",
    effect: "present",
    value: { threadId: "thread-1", turnId: "turn-1", status: "completed" },
  });
  await terminalFirstAdapter.close();

  const notificationFirstTurn = deferred<unknown>();
  const activeTurnTransport = new ControlledTransport([threadOperationFixture(), notificationFirstTurn.promise]);
  const activeTurnAdapter = createAdapter(activeTurnTransport);
  await activeTurnAdapter.startThread({
    model: "gpt-5.4",
    workspacePath: process.cwd(),
    approvalPolicy: "never",
    sandboxMode: "read-only",
    persistence: "persistent",
  });
  await activeTurnAdapter.nextEvent();
  const notificationFirstResult = activeTurnAdapter.startTurn({
    threadId: "thread-1",
    contentBlocks: [{ type: "text", text: "first" }],
  });
  await new Promise((resolve) => setImmediate(resolve));
  activeTurnTransport.emit({
    kind: "notification",
    method: "turn/started",
    params: { threadId: "thread-1", turn: turnFixture() },
  });
  assert.equal((await activeTurnAdapter.nextEvent()).kind, "turn_started");
  assert.deepEqual(
    await activeTurnAdapter.startTurn({
      threadId: "thread-1",
      contentBlocks: [{ type: "text", text: "must-not-send" }],
    }),
    { kind: "not_sent", effect: "none", code: "capability_unavailable" },
  );
  assert.equal(activeTurnTransport.requests.filter((method) => method === "turn/start").length, 1);
  notificationFirstTurn.resolve({ turn: turnFixture() });
  assert.equal((await notificationFirstResult).kind, "accepted");
  await activeTurnAdapter.close();
});

test("resume restores the current active Turn before admitting steer, interrupt, or another Turn", async () => {
  const transport = new ControlledTransport([
    threadOperationFixture({
      thread: threadFixture({
        status: { type: "active", activeFlags: [] },
        turns: [turnFixture({ id: "turn-restored" })],
      }),
    }),
    { turnId: "turn-restored" },
    {},
  ]);
  const adapter = createAdapter(transport);

  const resumed = await adapter.resumeThread({ threadId: "thread-1" });
  assert.equal(resumed.kind, "accepted");
  assert.equal((await adapter.nextEvent()).kind, "thread_started");
  assert.deepEqual(await adapter.nextEvent(), {
    kind: "turn_started",
    turn: { threadId: "thread-1", turnId: "turn-restored", status: "in_progress" },
  });

  assert.deepEqual(
    await adapter.startTurn({
      threadId: "thread-1",
      contentBlocks: [{ type: "text", text: "must not start a second Turn" }],
    }),
    { kind: "not_sent", effect: "none", code: "capability_unavailable" },
  );
  assert.equal(transport.requests.filter((method) => method === "turn/start").length, 0);
  assert.deepEqual(
    await adapter.steerTurn({
      threadId: "thread-1",
      expectedTurnId: "turn-restored",
      contentBlocks: [{ type: "text", text: "continue" }],
    }),
    {
      kind: "accepted",
      effect: "present",
      value: { threadId: "thread-1", turnId: "turn-restored" },
    },
  );
  assert.deepEqual(await adapter.interruptTurn({ threadId: "thread-1", turnId: "turn-restored" }), {
    kind: "accepted",
    effect: "present",
    value: { threadId: "thread-1", turnId: "turn-restored", terminal: false },
  });
  await adapter.close();
});

test("an observed turn/started proves a contradictory remote error was accepted without retry", async () => {
  const turnResponse = deferred<unknown>();
  const transport = new ControlledTransport([threadOperationFixture(), turnResponse.promise]);
  const adapter = createAdapter(transport);
  await adapter.startThread({
    model: "gpt-5.4",
    workspacePath: process.cwd(),
    approvalPolicy: "never",
    sandboxMode: "read-only",
    persistence: "persistent",
  });
  await adapter.nextEvent();

  const pending = adapter.startTurn({
    threadId: "thread-1",
    contentBlocks: [{ type: "text", text: "start" }],
  });
  await new Promise((resolve) => setImmediate(resolve));
  transport.emit({
    kind: "notification",
    method: "turn/started",
    params: { threadId: "thread-1", turn: turnFixture() },
  });
  assert.equal((await adapter.nextEvent()).kind, "turn_started");
  turnResponse.reject(new CodexTransportError({ kind: "remote_error", code: -32600 }));

  assert.deepEqual(await pending, {
    kind: "accepted",
    effect: "present",
    value: { threadId: "thread-1", turnId: "turn-1", status: "in_progress" },
  });
  assert.deepEqual(
    await adapter.startTurn({
      threadId: "thread-1",
      contentBlocks: [{ type: "text", text: "must not retry" }],
    }),
    { kind: "not_sent", effect: "none", code: "capability_unavailable" },
  );
  await adapter.close();
});

test("a terminal-only observed Turn proves acceptance and preserves the terminal without retry", async () => {
  for (const status of ["completed", "failed", "interrupted"] as const) {
    const turnResponse = deferred<unknown>();
    const transport = new ControlledTransport([threadOperationFixture(), turnResponse.promise]);
    const adapter = createAdapter(transport);
    await adapter.startThread({
      model: "gpt-5.4",
      workspacePath: process.cwd(),
      approvalPolicy: "never",
      sandboxMode: "read-only",
      persistence: "persistent",
    });
    await adapter.nextEvent();

    const pending = adapter.startTurn({
      threadId: "thread-1",
      contentBlocks: [{ type: "text", text: "start" }],
    });
    await new Promise((resolve) => setImmediate(resolve));
    transport.emit({
      kind: "notification",
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: turnFixture({ status }),
      },
    });
    assert.deepEqual(await adapter.nextEvent(), {
      kind: "turn_started",
      turn: { threadId: "thread-1", turnId: "turn-1", status: "in_progress" },
    });
    assert.deepEqual(await adapter.nextEvent(), {
      kind: "turn_terminal",
      threadId: "thread-1",
      turnId: "turn-1",
      status,
      finalAssistantMessage: null,
      contentFailure: null,
    });
    turnResponse.reject(new CodexTransportError({ kind: "remote_error", code: -32600 }));

    assert.deepEqual(
      await pending,
      {
        kind: "accepted",
        effect: "present",
        value: { threadId: "thread-1", turnId: "turn-1", status },
      },
      status,
    );
    assert.equal(transport.requests.filter((method) => method === "turn/start").length, 1);
    await adapter.close();
  }
});

test("a duplicate terminal from an earlier Turn is not side-effect evidence for a new turn/start", async () => {
  const turnResponse = deferred<unknown>();
  const transport = new ControlledTransport([
    threadOperationFixture(),
    { turn: turnFixture({ id: "turn-earlier" }) },
    turnResponse.promise,
  ]);
  const adapter = createAdapter(transport);
  await adapter.startThread({
    model: "gpt-5.4",
    workspacePath: process.cwd(),
    approvalPolicy: "never",
    sandboxMode: "read-only",
    persistence: "persistent",
  });
  await adapter.nextEvent();
  await adapter.startTurn({
    threadId: "thread-1",
    contentBlocks: [{ type: "text", text: "first" }],
  });
  await adapter.nextEvent();
  transport.emit({
    kind: "notification",
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: turnFixture({ id: "turn-earlier", status: "completed" }),
    },
  });
  assert.equal((await adapter.nextEvent()).kind, "turn_terminal");

  const pending = adapter.startTurn({
    threadId: "thread-1",
    contentBlocks: [{ type: "text", text: "second" }],
  });
  await new Promise((resolve) => setImmediate(resolve));
  transport.emit({
    kind: "notification",
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: turnFixture({ id: "turn-earlier", status: "completed" }),
    },
  });
  assert.equal(diagnosticCode(await adapter.nextEvent()), "duplicate_event");
  turnResponse.reject(new CodexTransportError({ kind: "remote_error", code: -32600 }));

  assert.deepEqual(await pending, { kind: "rejected", effect: "none", code: -32600 });
  assert.equal(transport.requests.filter((method) => method === "turn/start").length, 2);
  await adapter.close();
});

test("a delayed turn/started from an earlier terminal Turn is not evidence for a new turn/start", async () => {
  const turnResponse = deferred<unknown>();
  const transport = new ControlledTransport([
    threadOperationFixture(),
    { turn: turnFixture({ id: "turn-earlier" }) },
    turnResponse.promise,
  ]);
  const adapter = createAdapter(transport);
  await adapter.startThread({
    model: "gpt-5.4",
    workspacePath: process.cwd(),
    approvalPolicy: "never",
    sandboxMode: "read-only",
    persistence: "persistent",
  });
  await adapter.nextEvent();
  await adapter.startTurn({
    threadId: "thread-1",
    contentBlocks: [{ type: "text", text: "first" }],
  });
  await adapter.nextEvent();
  transport.emit({
    kind: "notification",
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: turnFixture({ id: "turn-earlier", status: "completed" }),
    },
  });
  assert.equal((await adapter.nextEvent()).kind, "turn_terminal");

  const pending = adapter.startTurn({
    threadId: "thread-1",
    contentBlocks: [{ type: "text", text: "second" }],
  });
  await new Promise((resolve) => setImmediate(resolve));
  transport.emit({
    kind: "notification",
    method: "turn/started",
    params: {
      threadId: "thread-1",
      turn: turnFixture({ id: "turn-earlier" }),
    },
  });
  assert.equal(diagnosticCode(await adapter.nextEvent()), "out_of_order_event");
  turnResponse.reject(new CodexTransportError({ kind: "remote_error", code: -32600 }));

  assert.deepEqual(await pending, { kind: "rejected", effect: "none", code: -32600 });
  assert.equal(transport.requests.filter((method) => method === "turn/start").length, 2);
  await adapter.close();
});

test("conflicting Turn start IDs invalidate mutation admission for the observed Turn", async () => {
  const turnResponse = deferred<unknown>();
  const transport = new ControlledTransport([threadOperationFixture(), turnResponse.promise]);
  const adapter = createAdapter(transport);
  await adapter.startThread({
    model: "gpt-5.4",
    workspacePath: process.cwd(),
    approvalPolicy: "never",
    sandboxMode: "read-only",
    persistence: "persistent",
  });
  await adapter.nextEvent();

  const pending = adapter.startTurn({
    threadId: "thread-1",
    contentBlocks: [{ type: "text", text: "start" }],
  });
  await new Promise((resolve) => setImmediate(resolve));
  transport.emit({
    kind: "notification",
    method: "turn/started",
    params: { threadId: "thread-1", turn: turnFixture({ id: "turn-notification" }) },
  });
  assert.equal((await adapter.nextEvent()).kind, "turn_started");
  turnResponse.resolve({ turn: turnFixture({ id: "turn-response" }) });

  assert.deepEqual(await pending, { kind: "ambiguous", effect: "unknown", code: "invalid_response" });
  assert.equal(diagnosticCode(await adapter.nextEvent()), "identity_mismatch");
  assert.deepEqual(
    await adapter.steerTurn({
      threadId: "thread-1",
      expectedTurnId: "turn-notification",
      contentBlocks: [{ type: "text", text: "must not steer a selected candidate" }],
    }),
    { kind: "not_sent", effect: "none", code: "capability_unavailable" },
  );
  assert.deepEqual(await adapter.interruptTurn({ threadId: "thread-1", turnId: "turn-notification" }), {
    kind: "not_sent",
    effect: "none",
    code: "capability_unavailable",
  });
  assert.equal(transport.requests.filter((method) => method === "turn/steer" || method === "turn/interrupt").length, 0);
  await adapter.close();
});

test("a terminal observed Turn still conflicts with a different turn/start response ID", async () => {
  const turnResponse = deferred<unknown>();
  const transport = new ControlledTransport([threadOperationFixture(), turnResponse.promise]);
  const adapter = createAdapter(transport);
  await adapter.startThread({
    model: "gpt-5.4",
    workspacePath: process.cwd(),
    approvalPolicy: "never",
    sandboxMode: "read-only",
    persistence: "persistent",
  });
  await adapter.nextEvent();

  const pending = adapter.startTurn({
    threadId: "thread-1",
    contentBlocks: [{ type: "text", text: "start" }],
  });
  await new Promise((resolve) => setImmediate(resolve));
  transport.emit({
    kind: "notification",
    method: "turn/started",
    params: { threadId: "thread-1", turn: turnFixture({ id: "turn-notification" }) },
  });
  assert.equal((await adapter.nextEvent()).kind, "turn_started");
  transport.emit({
    kind: "notification",
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: turnFixture({ id: "turn-notification", status: "completed" }),
    },
  });
  assert.equal((await adapter.nextEvent()).kind, "turn_terminal");
  turnResponse.resolve({ turn: turnFixture({ id: "turn-response" }) });

  assert.deepEqual(await pending, { kind: "ambiguous", effect: "unknown", code: "invalid_response" });
  assert.deepEqual(
    await adapter.startTurn({
      threadId: "thread-1",
      contentBlocks: [{ type: "text", text: "must not select the response candidate" }],
    }),
    { kind: "not_sent", effect: "none", code: "capability_unavailable" },
  );
  assert.equal(transport.requests.filter((method) => method === "turn/start").length, 1);
  await adapter.close();
});

test("a delayed turn/started after terminal still conflicts with a different response ID", async () => {
  const turnResponse = deferred<unknown>();
  const transport = new ControlledTransport([threadOperationFixture(), turnResponse.promise]);
  const adapter = createAdapter(transport);
  await adapter.startThread({
    model: "gpt-5.4",
    workspacePath: process.cwd(),
    approvalPolicy: "never",
    sandboxMode: "read-only",
    persistence: "persistent",
  });
  await adapter.nextEvent();

  const pending = adapter.startTurn({
    threadId: "thread-1",
    contentBlocks: [{ type: "text", text: "start" }],
  });
  await new Promise((resolve) => setImmediate(resolve));
  transport.emit({
    kind: "notification",
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: turnFixture({ id: "turn-notification", status: "completed" }),
    },
  });
  assert.deepEqual(await adapter.nextEvent(), {
    kind: "turn_started",
    turn: { threadId: "thread-1", turnId: "turn-notification", status: "in_progress" },
  });
  assert.deepEqual(await adapter.nextEvent(), {
    kind: "turn_terminal",
    threadId: "thread-1",
    turnId: "turn-notification",
    status: "completed",
    finalAssistantMessage: null,
    contentFailure: null,
  });
  transport.emit({
    kind: "notification",
    method: "turn/started",
    params: { threadId: "thread-1", turn: turnFixture({ id: "turn-notification" }) },
  });
  assert.equal(diagnosticCode(await adapter.nextEvent()), "out_of_order_event");
  turnResponse.resolve({ turn: turnFixture({ id: "turn-response" }) });

  assert.deepEqual(await pending, { kind: "ambiguous", effect: "unknown", code: "invalid_response" });
  assert.deepEqual(
    await adapter.startTurn({
      threadId: "thread-1",
      contentBlocks: [{ type: "text", text: "must not select the response candidate" }],
    }),
    { kind: "not_sent", effect: "none", code: "capability_unavailable" },
  );
  assert.equal(transport.requests.filter((method) => method === "turn/start").length, 1);
  await adapter.close();
});

test("conflicting active Turn IDs during resume invalidate mutation admission", async () => {
  const resumeResponse = deferred<unknown>();
  const transport = new ControlledTransport([resumeResponse.promise]);
  const adapter = createAdapter(transport);
  const pending = adapter.resumeThread({ threadId: "thread-1" });
  await new Promise((resolve) => setImmediate(resolve));
  transport.emit({
    kind: "notification",
    method: "thread/started",
    params: {
      thread: threadFixture({
        status: { type: "active", activeFlags: [] },
        turns: [turnFixture({ id: "turn-notification" })],
      }),
    },
  });
  transport.emit({
    kind: "notification",
    method: "turn/started",
    params: { threadId: "thread-1", turn: turnFixture({ id: "turn-notification" }) },
  });
  assert.equal((await adapter.nextEvent()).kind, "turn_started");
  resumeResponse.resolve(
    threadOperationFixture({
      thread: threadFixture({
        status: { type: "active", activeFlags: [] },
        turns: [turnFixture({ id: "turn-response" })],
      }),
    }),
  );

  assert.deepEqual(await pending, { kind: "ambiguous", effect: "unknown", code: "invalid_response" });
  assert.equal((await adapter.nextEvent()).kind, "thread_started");
  assert.equal(diagnosticCode(await adapter.nextEvent()), "identity_mismatch");
  assert.deepEqual(await adapter.interruptTurn({ threadId: "thread-1", turnId: "turn-notification" }), {
    kind: "not_sent",
    effect: "none",
    code: "capability_unavailable",
  });
  assert.equal(transport.requests.filter((method) => method === "turn/interrupt").length, 0);
  await adapter.close();
});

test("an ambiguous Thread resume blocks a later Turn start on the same idle Thread", async () => {
  const resumeResponse = deferred<unknown>();
  const transport = new ControlledTransport([
    {
      data: [
        modelFixture(),
        modelFixture({
          id: "model-b",
          model: "model-b",
          displayName: "Model B",
          isDefault: false,
        }),
      ],
      nextCursor: null,
    },
    threadOperationFixture(),
    resumeResponse.promise,
    { turn: turnFixture({ id: "turn-after-resume" }) },
  ]);
  const adapter = createAdapter(transport);
  await adapter.startThread({
    model: "gpt-5.4",
    workspacePath: process.cwd(),
    approvalPolicy: "never",
    sandboxMode: "read-only",
    persistence: "persistent",
  });
  await adapter.nextEvent();

  const resumed = adapter.resumeThread({ threadId: "thread-1", model: "model-b" });
  await new Promise((resolve) => setImmediate(resolve));
  resumeResponse.reject(new CodexTransportError({ kind: "response_unknown", code: "connection_lost" }));
  assert.deepEqual(await resumed, { kind: "ambiguous", effect: "unknown", code: "connection_lost" });

  assert.deepEqual(
    await adapter.startTurn({
      threadId: "thread-1",
      contentBlocks: [{ type: "text", text: "must not start after an ambiguous resume" }],
    }),
    { kind: "not_sent", effect: "none", code: "capability_unavailable" },
  );
  assert.equal(transport.requests.filter((method) => method === "turn/start").length, 0);
  await adapter.close();
});

test("an ambiguous Thread resume does not block a Turn start on another Thread", async () => {
  const resumeResponse = deferred<unknown>();
  const transport = new ControlledTransport([
    threadOperationFixture(),
    threadOperationFixture({
      thread: threadFixture({ id: "thread-2", sessionId: "session-2" }),
    }),
    resumeResponse.promise,
    { turn: turnFixture({ id: "turn-thread-2" }) },
  ]);
  const adapter = createAdapter(transport);
  await adapter.startThread({
    model: "gpt-5.4",
    workspacePath: process.cwd(),
    approvalPolicy: "never",
    sandboxMode: "read-only",
    persistence: "persistent",
  });
  await adapter.nextEvent();
  await adapter.startThread({
    model: "gpt-5.4",
    workspacePath: process.cwd(),
    approvalPolicy: "never",
    sandboxMode: "read-only",
    persistence: "persistent",
  });
  await adapter.nextEvent();

  const resumed = adapter.resumeThread({ threadId: "thread-1" });
  await new Promise((resolve) => setImmediate(resolve));
  resumeResponse.reject(new CodexTransportError({ kind: "response_unknown", code: "connection_lost" }));
  assert.deepEqual(await resumed, { kind: "ambiguous", effect: "unknown", code: "connection_lost" });

  assert.deepEqual(
    await adapter.startTurn({
      threadId: "thread-2",
      contentBlocks: [{ type: "text", text: "continue another Thread" }],
    }),
    {
      kind: "accepted",
      effect: "present",
      value: { threadId: "thread-2", turnId: "turn-thread-2", status: "in_progress" },
    },
  );
  assert.equal(transport.requests.filter((method) => method === "turn/start").length, 1);
  await adapter.close();
});

test("a pending Thread resume is rechecked after Turn capability validation and before send", async () => {
  const resumeResponse = deferred<unknown>();
  const transport = new ControlledTransport([threadOperationFixture(), resumeResponse.promise]);
  const adapter = createAdapter(transport);
  await adapter.startThread({
    model: "gpt-5.4",
    workspacePath: process.cwd(),
    approvalPolicy: "never",
    sandboxMode: "read-only",
    persistence: "persistent",
  });
  await adapter.nextEvent();

  const pendingTurn = adapter.startTurn({
    threadId: "thread-1",
    contentBlocks: [{ type: "text", text: "must stop before send" }],
  });
  const pendingResume = adapter.resumeThread({ threadId: "thread-1" });

  assert.deepEqual(await pendingTurn, { kind: "not_sent", effect: "none", code: "capability_unavailable" });
  assert.equal(transport.requests.filter((method) => method === "turn/start").length, 0);
  resumeResponse.reject(new CodexTransportError({ kind: "response_unknown", code: "connection_lost" }));
  assert.deepEqual(await pendingResume, { kind: "ambiguous", effect: "unknown", code: "connection_lost" });
  await adapter.close();
});

test("an ambiguous Thread resume blocks steer and interrupt on the same active Turn", async () => {
  const resumeResponse = deferred<unknown>();
  const transport = new ControlledTransport([
    {
      data: [
        modelFixture(),
        modelFixture({
          id: "model-b",
          model: "model-b",
          displayName: "Model B",
          isDefault: false,
        }),
      ],
      nextCursor: null,
    },
    threadOperationFixture(),
    { turn: turnFixture({ id: "turn-active" }) },
    resumeResponse.promise,
    { turnId: "turn-active" },
    {},
  ]);
  const adapter = createAdapter(transport);
  await adapter.startThread({
    model: "gpt-5.4",
    workspacePath: process.cwd(),
    approvalPolicy: "never",
    sandboxMode: "read-only",
    persistence: "persistent",
  });
  await adapter.nextEvent();
  await adapter.startTurn({
    threadId: "thread-1",
    contentBlocks: [{ type: "text", text: "start" }],
  });
  await adapter.nextEvent();

  const resumed = adapter.resumeThread({ threadId: "thread-1", model: "model-b" });
  await new Promise((resolve) => setImmediate(resolve));
  resumeResponse.reject(new CodexTransportError({ kind: "response_unknown", code: "connection_lost" }));
  assert.deepEqual(await resumed, { kind: "ambiguous", effect: "unknown", code: "connection_lost" });

  assert.deepEqual(
    await adapter.steerTurn({
      threadId: "thread-1",
      expectedTurnId: "turn-active",
      contentBlocks: [{ type: "text", text: "must not steer after an ambiguous resume" }],
    }),
    { kind: "not_sent", effect: "none", code: "capability_unavailable" },
  );
  assert.deepEqual(await adapter.interruptTurn({ threadId: "thread-1", turnId: "turn-active" }), {
    kind: "not_sent",
    effect: "none",
    code: "capability_unavailable",
  });
  assert.equal(transport.requests.filter((method) => method === "turn/steer" || method === "turn/interrupt").length, 0);
  await adapter.close();
});

test("an accepted Turn model override becomes the validation context for the next Turn", async () => {
  const transport = new ControlledTransport([
    {
      data: [
        modelFixture(),
        modelFixture({
          id: "model-b",
          model: "model-b",
          displayName: "Model B",
          supportedReasoningEfforts: [{ reasoningEffort: "high", description: "High" }],
          defaultReasoningEffort: "high",
          isDefault: false,
        }),
      ],
      nextCursor: null,
    },
    threadOperationFixture(),
    { turn: turnFixture({ id: "turn-b" }) },
    { turn: turnFixture({ id: "turn-c" }) },
  ]);
  const adapter = createAdapter(transport);
  await adapter.startThread({
    model: "gpt-5.4",
    workspacePath: process.cwd(),
    approvalPolicy: "never",
    sandboxMode: "read-only",
    persistence: "persistent",
  });
  await adapter.nextEvent();

  assert.equal(
    (
      await adapter.startTurn({
        threadId: "thread-1",
        contentBlocks: [{ type: "text", text: "switch model" }],
        model: "model-b",
        reasoningEffort: "high",
      })
    ).kind,
    "accepted",
  );
  await adapter.nextEvent();
  transport.emit({
    kind: "notification",
    method: "turn/completed",
    params: { threadId: "thread-1", turn: turnFixture({ id: "turn-b", status: "completed" }) },
  });
  assert.equal((await adapter.nextEvent()).kind, "turn_terminal");

  assert.equal(
    (
      await adapter.startTurn({
        threadId: "thread-1",
        contentBlocks: [{ type: "text", text: "use inherited model" }],
        reasoningEffort: "high",
      })
    ).kind,
    "accepted",
  );
  assert.deepEqual(
    transport.requestDetails.filter((request) => request.method === "turn/start").map((request) => request.params),
    [
      {
        threadId: "thread-1",
        input: [{ type: "text", text: "switch model", text_elements: [] }],
        approvalPolicy: "never",
        model: "model-b",
        effort: "high",
      },
      {
        threadId: "thread-1",
        input: [{ type: "text", text: "use inherited model", text_elements: [] }],
        approvalPolicy: "never",
        effort: "high",
      },
    ],
  );
  await adapter.close();
});

test("an inherited retry restores its source Run model after a later Turn changed the Thread model", async () => {
  const transport = new ControlledTransport([
    {
      data: [
        modelFixture(),
        modelFixture({
          id: "model-b",
          model: "model-b",
          displayName: "Model B",
          supportedReasoningEfforts: [{ reasoningEffort: "high", description: "High" }],
          defaultReasoningEffort: "high",
          isDefault: false,
        }),
      ],
      nextCursor: null,
    },
    threadOperationFixture(),
    { turn: turnFixture({ id: "turn-b" }) },
    { turn: turnFixture({ id: "turn-source-retry" }) },
  ]);
  const adapter = createAdapter(transport);
  await adapter.startThread({
    model: "gpt-5.4",
    workspacePath: process.cwd(),
    approvalPolicy: "never",
    sandboxMode: "read-only",
    persistence: "persistent",
  });
  await adapter.nextEvent();
  assert.equal(
    (
      await adapter.startTurn({
        threadId: "thread-1",
        contentBlocks: [{ type: "text", text: "switch to B" }],
        model: "model-b",
        reasoningEffort: "high",
      })
    ).kind,
    "accepted",
  );
  await adapter.nextEvent();
  transport.emit({
    kind: "notification",
    method: "turn/completed",
    params: { threadId: "thread-1", turn: turnFixture({ id: "turn-b", status: "completed" }) },
  });
  assert.equal((await adapter.nextEvent()).kind, "turn_terminal");

  assert.equal(
    (
      await adapter.startTurn({
        threadId: "thread-1",
        contentBlocks: [{ type: "text", text: "retry source A" }],
        model: "gpt-5.4",
        modelSelection: "inherited",
        reasoningEffort: "medium",
      })
    ).kind,
    "accepted",
  );
  assert.deepEqual(
    transport.requestDetails.filter((request) => request.method === "turn/start").map((request) => request.params),
    [
      {
        threadId: "thread-1",
        input: [{ type: "text", text: "switch to B", text_elements: [] }],
        approvalPolicy: "never",
        model: "model-b",
        effort: "high",
      },
      {
        threadId: "thread-1",
        input: [{ type: "text", text: "retry source A", text_elements: [] }],
        approvalPolicy: "never",
        model: "gpt-5.4",
        effort: "medium",
      },
    ],
  );
  await adapter.close();
});

test("a request_not_sent Turn override cannot replace the current model after an unrelated notification", async () => {
  const turnResponse = deferred<unknown>();
  const transport = new ControlledTransport([
    {
      data: [
        modelFixture(),
        modelFixture({
          id: "model-b",
          model: "model-b",
          displayName: "Model B",
          supportedReasoningEfforts: [{ reasoningEffort: "high", description: "High" }],
          defaultReasoningEffort: "high",
          isDefault: false,
        }),
      ],
      nextCursor: null,
    },
    threadOperationFixture(),
    turnResponse.promise,
    { turn: turnFixture({ id: "turn-next" }) },
  ]);
  const adapter = createAdapter(transport);
  await adapter.startThread({
    model: "gpt-5.4",
    workspacePath: process.cwd(),
    approvalPolicy: "never",
    sandboxMode: "read-only",
    persistence: "persistent",
  });
  await adapter.nextEvent();

  const pending = adapter.startTurn({
    threadId: "thread-1",
    contentBlocks: [{ type: "text", text: "unconfirmed override" }],
    model: "model-b",
    reasoningEffort: "high",
  });
  await new Promise((resolve) => setImmediate(resolve));
  transport.emit({
    kind: "notification",
    method: "turn/started",
    params: { threadId: "thread-1", turn: turnFixture({ id: "turn-unrelated" }) },
  });
  assert.equal((await adapter.nextEvent()).kind, "turn_started");
  turnResponse.reject(new CodexTransportError({ kind: "request_not_sent", code: "timeout" }));
  assert.deepEqual(await pending, { kind: "not_sent", effect: "none", code: "timeout" });
  transport.emit({
    kind: "notification",
    method: "turn/completed",
    params: { threadId: "thread-1", turn: turnFixture({ id: "turn-unrelated", status: "completed" }) },
  });
  assert.equal((await adapter.nextEvent()).kind, "turn_terminal");

  assert.equal(
    (
      await adapter.startTurn({
        threadId: "thread-1",
        contentBlocks: [{ type: "text", text: "use the unchanged current model" }],
        reasoningEffort: "medium",
      })
    ).kind,
    "accepted",
  );
  assert.deepEqual(transport.requestDetails.filter((request) => request.method === "turn/start").at(-1)?.params, {
    threadId: "thread-1",
    input: [{ type: "text", text: "use the unchanged current model", text_elements: [] }],
    approvalPolicy: "never",
    effort: "medium",
  });
  await adapter.close();
});

test("a steer response acknowledges delivery without projecting a Turn status after terminal", async () => {
  const steerResponse = deferred<unknown>();
  const transport = new ControlledTransport([threadOperationFixture(), { turn: turnFixture() }, steerResponse.promise]);
  const adapter = createAdapter(transport);
  await adapter.startThread({
    model: "gpt-5.4",
    workspacePath: process.cwd(),
    approvalPolicy: "never",
    sandboxMode: "read-only",
    persistence: "persistent",
  });
  await adapter.nextEvent();
  await adapter.startTurn({ threadId: "thread-1", contentBlocks: [{ type: "text", text: "start" }] });
  await adapter.nextEvent();

  const pending = adapter.steerTurn({
    threadId: "thread-1",
    expectedTurnId: "turn-1",
    contentBlocks: [{ type: "text", text: "late input" }],
  });
  await new Promise((resolve) => setImmediate(resolve));
  transport.emit({
    kind: "notification",
    method: "turn/completed",
    params: { threadId: "thread-1", turn: turnFixture({ status: "completed" }) },
  });
  assert.equal((await adapter.nextEvent()).kind, "turn_terminal");
  steerResponse.resolve({ turnId: "turn-1" });
  assert.deepEqual(await pending, {
    kind: "accepted",
    effect: "present",
    value: { threadId: "thread-1", turnId: "turn-1" },
  });
  await adapter.close();
});

test("a matching userMessage notification prevents steer delivery from reverting to effect none", async () => {
  const steerResponse = deferred<unknown>();
  const transport = new ControlledTransport([threadOperationFixture(), { turn: turnFixture() }, steerResponse.promise]);
  const adapter = createAdapter(transport);
  await adapter.startThread({
    model: "gpt-5.4",
    workspacePath: process.cwd(),
    approvalPolicy: "never",
    sandboxMode: "read-only",
    persistence: "persistent",
  });
  await adapter.nextEvent();
  await adapter.startTurn({ threadId: "thread-1", contentBlocks: [{ type: "text", text: "start" }] });
  await adapter.nextEvent();

  const pending = adapter.steerTurn({
    threadId: "thread-1",
    expectedTurnId: "turn-1",
    contentBlocks: [{ type: "text", text: "delivered input" }],
  });
  await new Promise((resolve) => setImmediate(resolve));
  const steerParams = transport.requestDetails.filter((request) => request.method === "turn/steer").at(-1)?.params as
    Readonly<Record<string, unknown>> | undefined;
  assert.equal(typeof steerParams?.clientUserMessageId, "string");
  transport.emit({
    kind: "notification",
    method: "item/started",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        type: "userMessage",
        id: "user-message-1",
        clientId: steerParams?.clientUserMessageId,
        content: [{ type: "text", text: "delivered input" }],
      },
      startedAtMs: 1,
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  steerResponse.reject(new CodexTransportError({ kind: "remote_error", code: -32600 }));

  assert.deepEqual(await pending, { kind: "ambiguous", effect: "unknown", code: "invalid_response" });
  await adapter.close();
});

test("a steer client ID observed on another Turn makes the operation and original Turn ambiguous", async () => {
  const steerResponse = deferred<unknown>();
  const transport = new ControlledTransport([threadOperationFixture(), { turn: turnFixture() }, steerResponse.promise]);
  const adapter = createAdapter(transport);
  await adapter.startThread({
    model: "gpt-5.4",
    workspacePath: process.cwd(),
    approvalPolicy: "never",
    sandboxMode: "read-only",
    persistence: "persistent",
  });
  await adapter.nextEvent();
  await adapter.startTurn({ threadId: "thread-1", contentBlocks: [{ type: "text", text: "start" }] });
  await adapter.nextEvent();

  const pending = adapter.steerTurn({
    threadId: "thread-1",
    expectedTurnId: "turn-1",
    contentBlocks: [{ type: "text", text: "misrouted input" }],
  });
  await new Promise((resolve) => setImmediate(resolve));
  const steerParams = transport.requestDetails.filter((request) => request.method === "turn/steer").at(-1)?.params as
    Readonly<Record<string, unknown>> | undefined;
  transport.emit({
    kind: "notification",
    method: "item/started",
    params: {
      threadId: "thread-1",
      turnId: "turn-other",
      item: {
        type: "userMessage",
        id: "user-message-conflict",
        clientId: steerParams?.clientUserMessageId,
        content: [{ type: "text", text: "misrouted input" }],
      },
      startedAtMs: 1,
    },
  });
  assert.equal(diagnosticCode(await adapter.nextEvent()), "identity_mismatch");
  steerResponse.resolve({ turnId: "turn-1" });

  assert.deepEqual(await pending, { kind: "ambiguous", effect: "unknown", code: "invalid_response" });
  assert.deepEqual(
    await adapter.steerTurn({
      threadId: "thread-1",
      expectedTurnId: "turn-1",
      contentBlocks: [{ type: "text", text: "must not retry" }],
    }),
    { kind: "not_sent", effect: "none", code: "capability_unavailable" },
  );
  await adapter.close();
});

test("an accepted steer retains correlation until a later userMessage observation", async () => {
  const transport = new ControlledTransport([threadOperationFixture(), { turn: turnFixture() }, { turnId: "turn-1" }]);
  const adapter = createAdapter(transport);
  await adapter.startThread({
    model: "gpt-5.4",
    workspacePath: process.cwd(),
    approvalPolicy: "never",
    sandboxMode: "read-only",
    persistence: "persistent",
  });
  await adapter.nextEvent();
  await adapter.startTurn({ threadId: "thread-1", contentBlocks: [{ type: "text", text: "start" }] });
  await adapter.nextEvent();

  assert.equal(
    (
      await adapter.steerTurn({
        threadId: "thread-1",
        expectedTurnId: "turn-1",
        contentBlocks: [{ type: "text", text: "accepted input" }],
      })
    ).kind,
    "accepted",
  );
  const steerParams = transport.requestDetails.filter((request) => request.method === "turn/steer").at(-1)?.params as
    Readonly<Record<string, unknown>> | undefined;
  transport.emit({
    kind: "notification",
    method: "item/started",
    params: {
      threadId: "thread-1",
      turnId: "turn-other",
      item: {
        type: "userMessage",
        id: "user-message-late-conflict",
        clientId: steerParams?.clientUserMessageId,
        content: [{ type: "text", text: "accepted input" }],
      },
      startedAtMs: 1,
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(
    await adapter.steerTurn({
      threadId: "thread-1",
      expectedTurnId: "turn-1",
      contentBlocks: [{ type: "text", text: "must not continue after conflict" }],
    }),
    { kind: "not_sent", effect: "none", code: "capability_unavailable" },
  );
  assert.equal(diagnosticCode(await adapter.nextEvent()), "identity_mismatch");
  assert.equal(transport.requests.filter((method) => method === "turn/steer").length, 1);
  await adapter.close();
});

test("an ambiguous steer retains correlation for a delayed conflicting userMessage observation", async () => {
  const steerResponse = deferred<unknown>();
  const transport = new ControlledTransport([
    threadOperationFixture(),
    { turn: turnFixture() },
    steerResponse.promise,
    { turnId: "turn-1" },
  ]);
  const adapter = createAdapter(transport);
  await adapter.startThread({
    model: "gpt-5.4",
    workspacePath: process.cwd(),
    approvalPolicy: "never",
    sandboxMode: "read-only",
    persistence: "persistent",
  });
  await adapter.nextEvent();
  await adapter.startTurn({ threadId: "thread-1", contentBlocks: [{ type: "text", text: "start" }] });
  await adapter.nextEvent();

  const pending = adapter.steerTurn({
    threadId: "thread-1",
    expectedTurnId: "turn-1",
    contentBlocks: [{ type: "text", text: "delivery unknown" }],
  });
  await new Promise((resolve) => setImmediate(resolve));
  const steerParams = transport.requestDetails.filter((request) => request.method === "turn/steer").at(-1)?.params as
    Readonly<Record<string, unknown>> | undefined;
  assert.equal(typeof steerParams?.clientUserMessageId, "string");
  steerResponse.reject(new CodexTransportError({ kind: "response_unknown", code: "connection_lost" }));
  assert.deepEqual(await pending, { kind: "ambiguous", effect: "unknown", code: "connection_lost" });

  transport.emit({
    kind: "notification",
    method: "item/started",
    params: {
      threadId: "thread-1",
      turnId: "turn-other",
      item: {
        type: "userMessage",
        id: "user-message-late-conflict",
        clientId: steerParams?.clientUserMessageId,
        content: [{ type: "text", text: "delivery unknown" }],
      },
      startedAtMs: 1,
    },
  });
  assert.equal(diagnosticCode(await adapter.nextEvent()), "identity_mismatch");
  assert.deepEqual(
    await adapter.steerTurn({
      threadId: "thread-1",
      expectedTurnId: "turn-1",
      contentBlocks: [{ type: "text", text: "must not continue after conflict" }],
    }),
    { kind: "not_sent", effect: "none", code: "capability_unavailable" },
  );
  assert.equal(transport.requests.filter((method) => method === "turn/steer").length, 1);
  await adapter.close();
});

test("a delayed matching userMessage releases an ambiguous steer correlation owner", async () => {
  const steerResponse = deferred<unknown>();
  const transport = new ControlledTransport([threadOperationFixture(), { turn: turnFixture() }, steerResponse.promise]);
  const adapter = createAdapter(transport);
  await adapter.startThread({
    model: "gpt-5.4",
    workspacePath: process.cwd(),
    approvalPolicy: "never",
    sandboxMode: "read-only",
    persistence: "persistent",
  });
  await adapter.nextEvent();
  await adapter.startTurn({ threadId: "thread-1", contentBlocks: [{ type: "text", text: "start" }] });
  await adapter.nextEvent();

  const pending = adapter.steerTurn({
    threadId: "thread-1",
    expectedTurnId: "turn-1",
    contentBlocks: [{ type: "text", text: "delivery unknown" }],
  });
  await new Promise((resolve) => setImmediate(resolve));
  const steerParams = transport.requestDetails.filter((request) => request.method === "turn/steer").at(-1)?.params as
    Readonly<Record<string, unknown>> | undefined;
  assert.equal(typeof steerParams?.clientUserMessageId, "string");
  steerResponse.reject(new CodexTransportError({ kind: "response_unknown", code: "connection_lost" }));
  assert.deepEqual(await pending, { kind: "ambiguous", effect: "unknown", code: "connection_lost" });

  transport.emit({
    kind: "notification",
    method: "item/started",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        type: "userMessage",
        id: "user-message-late-match",
        clientId: steerParams?.clientUserMessageId,
        content: [{ type: "text", text: "delivery unknown" }],
      },
      startedAtMs: 1,
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  transport.emit({
    kind: "notification",
    method: "item/started",
    params: {
      threadId: "thread-1",
      turnId: "turn-other",
      item: {
        type: "userMessage",
        id: "user-message-after-match",
        clientId: steerParams?.clientUserMessageId,
        content: [{ type: "text", text: "delivery unknown" }],
      },
      startedAtMs: 2,
    },
  });

  assert.equal(diagnosticCode(await adapter.nextEvent()), "out_of_order_event");
  await adapter.close();
});

test("a terminal observed before an ambiguous steer response releases its correlation owner", async () => {
  const steerResponse = deferred<unknown>();
  const transport = new ControlledTransport([threadOperationFixture(), { turn: turnFixture() }, steerResponse.promise]);
  const adapter = createAdapter(transport);
  await adapter.startThread({
    model: "gpt-5.4",
    workspacePath: process.cwd(),
    approvalPolicy: "never",
    sandboxMode: "read-only",
    persistence: "persistent",
  });
  await adapter.nextEvent();
  await adapter.startTurn({ threadId: "thread-1", contentBlocks: [{ type: "text", text: "start" }] });
  await adapter.nextEvent();

  const pending = adapter.steerTurn({
    threadId: "thread-1",
    expectedTurnId: "turn-1",
    contentBlocks: [{ type: "text", text: "delivery unknown at terminal" }],
  });
  await new Promise((resolve) => setImmediate(resolve));
  const steerParams = transport.requestDetails.filter((request) => request.method === "turn/steer").at(-1)?.params as
    Readonly<Record<string, unknown>> | undefined;
  assert.equal(typeof steerParams?.clientUserMessageId, "string");
  transport.emit({
    kind: "notification",
    method: "turn/completed",
    params: { threadId: "thread-1", turn: turnFixture({ status: "completed" }) },
  });
  assert.equal((await adapter.nextEvent()).kind, "turn_terminal");
  steerResponse.reject(new CodexTransportError({ kind: "response_unknown", code: "connection_lost" }));
  assert.deepEqual(await pending, { kind: "ambiguous", effect: "unknown", code: "connection_lost" });

  transport.emit({
    kind: "notification",
    method: "item/started",
    params: {
      threadId: "thread-1",
      turnId: "turn-other",
      item: {
        type: "userMessage",
        id: "user-message-after-terminal",
        clientId: steerParams?.clientUserMessageId,
        content: [{ type: "text", text: "delivery unknown at terminal" }],
      },
      startedAtMs: 1,
    },
  });
  assert.equal(diagnosticCode(await adapter.nextEvent()), "out_of_order_event");
  await adapter.close();
});

test("any observed matching terminal makes a contradictory interrupt remote error ambiguous", async () => {
  for (const status of ["completed", "failed", "interrupted"] as const) {
    const interruptResponse = deferred<unknown>();
    const transport = new ControlledTransport([
      threadOperationFixture(),
      { turn: turnFixture() },
      interruptResponse.promise,
    ]);
    const adapter = createAdapter(transport);
    try {
      await adapter.startThread({
        model: "gpt-5.4",
        workspacePath: process.cwd(),
        approvalPolicy: "never",
        sandboxMode: "read-only",
        persistence: "persistent",
      });
      await adapter.nextEvent();
      await adapter.startTurn({ threadId: "thread-1", contentBlocks: [{ type: "text", text: "start" }] });
      await adapter.nextEvent();

      const pending = adapter.interruptTurn({ threadId: "thread-1", turnId: "turn-1" });
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(await adapter.interruptTurn({ threadId: "thread-1", turnId: "turn-1" }), {
        kind: "not_sent",
        effect: "none",
        code: "capability_unavailable",
      });
      assert.equal(transport.requests.filter((method) => method === "turn/interrupt").length, 1);
      transport.emit({
        kind: "notification",
        method: "turn/completed",
        params: { threadId: "thread-1", turn: turnFixture({ status }) },
      });
      assert.equal((await adapter.nextEvent()).kind, "turn_terminal");
      interruptResponse.reject(new CodexTransportError({ kind: "remote_error", code: -32600 }));

      assert.deepEqual(await pending, { kind: "ambiguous", effect: "unknown", code: "invalid_response" }, status);
    } finally {
      await adapter.close();
    }
  }
});

test("request_not_sent keeps effect none despite unrelated notification observations", async () => {
  const startThreadResponse = deferred<unknown>();
  const startThreadTransport = new ControlledTransport([startThreadResponse.promise, threadOperationFixture()]);
  const startThreadAdapter = createAdapter(startThreadTransport);
  const threadInput = {
    model: "gpt-5.4",
    workspacePath: process.cwd(),
    approvalPolicy: "never" as const,
    sandboxMode: "read-only" as const,
    persistence: "persistent" as const,
  };
  const pendingThread = startThreadAdapter.startThread(threadInput);
  await new Promise((resolve) => setImmediate(resolve));
  startThreadTransport.emit({
    kind: "notification",
    method: "thread/started",
    params: { thread: threadFixture() },
  });
  await new Promise((resolve) => setImmediate(resolve));
  startThreadResponse.reject(new CodexTransportError({ kind: "request_not_sent", code: "timeout" }));
  assert.deepEqual(await pendingThread, { kind: "not_sent", effect: "none", code: "timeout" });
  assert.equal((await startThreadAdapter.startThread(threadInput)).kind, "accepted");
  await startThreadAdapter.close();

  const startTurnResponse = deferred<unknown>();
  const startTurnTransport = new ControlledTransport([threadOperationFixture(), startTurnResponse.promise]);
  const startTurnAdapter = createAdapter(startTurnTransport);
  await startTurnAdapter.startThread(threadInput);
  await startTurnAdapter.nextEvent();
  const pendingTurn = startTurnAdapter.startTurn({
    threadId: "thread-1",
    contentBlocks: [{ type: "text", text: "start" }],
  });
  await new Promise((resolve) => setImmediate(resolve));
  startTurnTransport.emit({
    kind: "notification",
    method: "turn/started",
    params: { threadId: "thread-1", turn: turnFixture() },
  });
  assert.equal((await startTurnAdapter.nextEvent()).kind, "turn_started");
  startTurnResponse.reject(new CodexTransportError({ kind: "request_not_sent", code: "timeout" }));
  assert.deepEqual(await pendingTurn, { kind: "not_sent", effect: "none", code: "timeout" });
  await startTurnAdapter.close();

  const interruptResponse = deferred<unknown>();
  const interruptTransport = new ControlledTransport([
    threadOperationFixture(),
    { turn: turnFixture() },
    interruptResponse.promise,
  ]);
  const interruptAdapter = createAdapter(interruptTransport);
  await interruptAdapter.startThread(threadInput);
  await interruptAdapter.nextEvent();
  await interruptAdapter.startTurn({
    threadId: "thread-1",
    contentBlocks: [{ type: "text", text: "start" }],
  });
  await interruptAdapter.nextEvent();
  const pendingInterrupt = interruptAdapter.interruptTurn({ threadId: "thread-1", turnId: "turn-1" });
  await new Promise((resolve) => setImmediate(resolve));
  interruptTransport.emit({
    kind: "notification",
    method: "turn/completed",
    params: { threadId: "thread-1", turn: turnFixture({ status: "interrupted" }) },
  });
  assert.equal((await interruptAdapter.nextEvent()).kind, "turn_terminal");
  interruptResponse.reject(new CodexTransportError({ kind: "request_not_sent", code: "timeout" }));
  assert.deepEqual(await pendingInterrupt, { kind: "not_sent", effect: "none", code: "timeout" });
  await interruptAdapter.close();
});

test("an older turn/start response cannot release a newer pending Turn owner", async () => {
  const delayedA = deferred<unknown>();
  const delayedB = deferred<unknown>();
  const transport = new ControlledTransport([
    {
      data: [
        modelFixture(),
        modelFixture({ id: "model-b", model: "model-b", displayName: "Model B", isDefault: false }),
      ],
      nextCursor: null,
    },
    threadOperationFixture(),
    delayedA.promise,
    delayedB.promise,
  ]);
  const adapter = createAdapter(transport);
  await adapter.startThread({
    model: "gpt-5.4",
    workspacePath: process.cwd(),
    approvalPolicy: "never",
    sandboxMode: "read-only",
    persistence: "persistent",
  });
  await adapter.nextEvent();

  const resultA = adapter.startTurn({
    threadId: "thread-1",
    contentBlocks: [{ type: "text", text: "A" }],
  });
  await new Promise((resolve) => setImmediate(resolve));
  transport.emit({
    kind: "notification",
    method: "turn/started",
    params: { threadId: "thread-1", turn: turnFixture() },
  });
  assert.equal((await adapter.nextEvent()).kind, "turn_started");
  transport.emit({
    kind: "notification",
    method: "turn/completed",
    params: { threadId: "thread-1", turn: turnFixture({ status: "completed" }) },
  });
  assert.equal((await adapter.nextEvent()).kind, "turn_terminal");

  const resultB = adapter.startTurn({
    threadId: "thread-1",
    contentBlocks: [{ type: "text", text: "B" }],
    model: "model-b",
  });
  await new Promise((resolve) => setImmediate(resolve));
  delayedA.resolve({ turn: turnFixture() });
  assert.deepEqual(await resultA, { kind: "ambiguous", effect: "unknown", code: "invalid_response" });
  assert.equal(diagnosticCode(await adapter.nextEvent()), "out_of_order_event");

  assert.deepEqual(
    await adapter.startTurn({
      threadId: "thread-1",
      contentBlocks: [{ type: "text", text: "C" }],
    }),
    { kind: "not_sent", effect: "none", code: "capability_unavailable" },
  );
  assert.equal(transport.requests.filter((method) => method === "turn/start").length, 2);

  transport.emit({
    kind: "notification",
    method: "turn/started",
    params: { threadId: "thread-1", turn: turnFixture({ id: "turn-b" }) },
  });
  assert.equal((await adapter.nextEvent()).kind, "turn_started");
  delayedB.resolve({ turn: turnFixture({ id: "turn-b" }) });
  assert.equal((await resultB).kind, "accepted");
  transport.emit({
    kind: "notification",
    method: "item/started",
    params: {
      threadId: "thread-1",
      turnId: "turn-b",
      item: agentMessageFixture({ id: "b-final", phase: null, text: "B final" }),
      startedAtMs: 1,
    },
  });
  transport.emit({
    kind: "notification",
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-b",
      item: agentMessageFixture({ id: "b-final", phase: null, text: "B final" }),
      completedAtMs: 2,
    },
  });
  transport.emit({
    kind: "notification",
    method: "turn/completed",
    params: { threadId: "thread-1", turn: turnFixture({ id: "turn-b", status: "completed" }) },
  });
  const fallback = await adapter.nextEvent();
  assert.equal(diagnosticCode(fallback), "phase_fallback");
  if (fallback.kind !== "diagnostic") assert.fail("expected a phase fallback diagnostic");
  assert.equal(fallback.diagnostic.model, "model-b");
  assert.equal((await adapter.nextEvent()).kind, "turn_terminal");
  await adapter.close();
});

test("an older request_not_sent cannot roll back a newer owner of the same model override", async () => {
  const delayedA = deferred<unknown>();
  const delayedB = deferred<unknown>();
  const transport = new ControlledTransport([
    {
      data: [
        modelFixture(),
        modelFixture({
          id: "model-b",
          model: "model-b",
          displayName: "Model B",
          supportedReasoningEfforts: [{ reasoningEffort: "high", description: "High" }],
          defaultReasoningEffort: "high",
          isDefault: false,
        }),
      ],
      nextCursor: null,
    },
    threadOperationFixture(),
    delayedA.promise,
    delayedB.promise,
    { turn: turnFixture({ id: "turn-next" }) },
  ]);
  const adapter = createAdapter(transport);
  await adapter.startThread({
    model: "gpt-5.4",
    workspacePath: process.cwd(),
    approvalPolicy: "never",
    sandboxMode: "read-only",
    persistence: "persistent",
  });
  await adapter.nextEvent();

  const resultA = adapter.startTurn({
    threadId: "thread-1",
    contentBlocks: [{ type: "text", text: "A" }],
    model: "model-b",
    reasoningEffort: "high",
  });
  await new Promise((resolve) => setImmediate(resolve));
  transport.emit({
    kind: "notification",
    method: "turn/started",
    params: { threadId: "thread-1", turn: turnFixture({ id: "turn-a" }) },
  });
  assert.equal((await adapter.nextEvent()).kind, "turn_started");
  transport.emit({
    kind: "notification",
    method: "turn/completed",
    params: { threadId: "thread-1", turn: turnFixture({ id: "turn-a", status: "completed" }) },
  });
  assert.equal((await adapter.nextEvent()).kind, "turn_terminal");

  const resultB = adapter.startTurn({
    threadId: "thread-1",
    contentBlocks: [{ type: "text", text: "B" }],
    model: "model-b",
    reasoningEffort: "high",
  });
  await new Promise((resolve) => setImmediate(resolve));
  transport.emit({
    kind: "notification",
    method: "turn/started",
    params: { threadId: "thread-1", turn: turnFixture({ id: "turn-b" }) },
  });
  assert.equal((await adapter.nextEvent()).kind, "turn_started");
  delayedA.reject(new CodexTransportError({ kind: "request_not_sent", code: "timeout" }));
  assert.deepEqual(await resultA, { kind: "not_sent", effect: "none", code: "timeout" });
  delayedB.resolve({ turn: turnFixture({ id: "turn-b" }) });
  assert.equal((await resultB).kind, "accepted");
  transport.emit({
    kind: "notification",
    method: "turn/completed",
    params: { threadId: "thread-1", turn: turnFixture({ id: "turn-b", status: "completed" }) },
  });
  assert.equal((await adapter.nextEvent()).kind, "turn_terminal");

  assert.equal(
    (
      await adapter.startTurn({
        threadId: "thread-1",
        contentBlocks: [{ type: "text", text: "inherit B" }],
        reasoningEffort: "high",
      })
    ).kind,
    "accepted",
  );
  assert.deepEqual(transport.requestDetails.filter((request) => request.method === "turn/start").at(-1)?.params, {
    threadId: "thread-1",
    input: [{ type: "text", text: "inherit B", text_elements: [] }],
    approvalPolicy: "never",
    effort: "high",
  });
  await adapter.close();
});

test("known-invalid payloads and unsupported server requests diagnose then close without responding", async () => {
  const invalidTransport = new ControlledTransport([]);
  const invalidAdapter = createAdapter(invalidTransport);
  invalidTransport.emit({ kind: "notification", method: "turn/completed", params: { threadId: "thread-1" } });
  const invalidDiagnostic = await invalidAdapter.nextEvent();
  assert.equal(invalidDiagnostic.kind, "diagnostic");
  if (invalidDiagnostic.kind !== "diagnostic") assert.fail("expected invalid payload diagnostic");
  const { summary: invalidSummary, ...invalidDetails } = invalidDiagnostic.diagnostic;
  assertBoundedPublicSummary(invalidSummary);
  assert.deepEqual(invalidDetails, {
    code: "known_invalid_payload",
    method: "turn/completed",
    redaction: "not_required",
  });
  assert.deepEqual(await invalidAdapter.nextEvent(), { kind: "connection_failure", code: "protocol_failed" });
  await waitFor(() => invalidTransport.closeCount === 1);

  let responses = 0;
  const requestTransport = new ControlledTransport([]);
  const requestAdapter = createAdapter(requestTransport);
  requestTransport.emit({
    kind: "serverRequest",
    request: {
      method: "item/requestApproval",
      params: { secret: "not-projected" },
      respond: () => {
        responses += 1;
      },
    } as never,
  });
  const requestDiagnostic = await requestAdapter.nextEvent();
  assert.equal(requestDiagnostic.kind, "diagnostic");
  if (requestDiagnostic.kind !== "diagnostic") assert.fail("expected unsupported request diagnostic");
  const { summary: requestSummary, ...requestDetails } = requestDiagnostic.diagnostic;
  assertBoundedPublicSummary(requestSummary, ["not-projected"]);
  assert.deepEqual(requestDetails, {
    code: "unsupported_server_request",
    method: "item/requestApproval",
    redaction: "not_required",
  });
  assert.deepEqual(await requestAdapter.nextEvent(), {
    kind: "connection_failure",
    code: "unsupported_server_request",
  });
  await waitFor(() => requestTransport.closeCount === 1);
  assert.equal(responses, 0);
});

test("unsupported server request methods are snapshotted and bounded before diagnostics", async () => {
  for (const method of [{ raw: "object" }, "x".repeat(CODEX_ADAPTER_LIMITS.maxShortStringBytes + 1)]) {
    const transport = new ControlledTransport([]);
    const adapter = createAdapter(transport);
    transport.emit({ kind: "serverRequest", request: { method, params: { secret: "hidden" } } as never });
    const event = await adapter.nextEvent();
    assert.equal(event.kind, "diagnostic");
    if (event.kind !== "diagnostic") assert.fail("expected bounded server request diagnostic");
    const { summary, ...diagnostic } = event.diagnostic;
    assertBoundedPublicSummary(summary, ["hidden"]);
    assert.deepEqual(diagnostic, {
      code: "unsupported_server_request",
      redaction: "applied",
    });
    assert.deepEqual(await adapter.nextEvent(), {
      kind: "connection_failure",
      code: "unsupported_server_request",
    });
    await waitFor(() => transport.closeCount === 1);
  }
});

test("transport event envelope accessors and custom prototypes cannot reach notification state", async () => {
  let getterReads = 0;
  const accessorEvent = Object.defineProperty({}, "kind", {
    enumerable: true,
    get: () => {
      getterReads += 1;
      return "notification";
    },
  });
  const paramsAccessorEvent = Object.defineProperties(
    { kind: "notification", method: "thread/status/changed" },
    {
      params: {
        enumerable: true,
        get: () => {
          getterReads += 1;
          return { threadId: "thread-1", status: { type: "active", activeFlags: [] } };
        },
      },
    },
  );
  const customPrototypeEvent = Object.assign(Object.create({ inherited: true }), {
    kind: "notification",
    method: "future/event",
    params: {},
  });

  for (const candidate of [accessorEvent, paramsAccessorEvent, customPrototypeEvent]) {
    const transport = new ControlledTransport([]);
    const adapter = createAdapter(transport);
    transport.emit(candidate as never);
    assert.equal(diagnosticCode(await adapter.nextEvent()), "known_invalid_payload");
    assert.deepEqual(await adapter.nextEvent(), { kind: "connection_failure", code: "protocol_failed" });
    await waitFor(() => transport.closeCount === 1);
  }
  assert.equal(getterReads, 0);
});

test("diagnostic aggregate overflow closes with a bounded Adapter failure", async () => {
  const transport = new ControlledTransport([]);
  const adapter = createAdapter(transport);
  for (let index = 0; index <= CODEX_ADAPTER_LIMITS.maxDiagnostics; index += 1) {
    transport.emit({
      kind: "notification",
      method: "future/progress",
      params: { threadId: "thread-1", progress: index },
    });
  }

  const events: CodexAdapterEvent[] = [];
  for (;;) {
    const event = await adapter.nextEvent();
    events.push(event);
    if (event.kind === "connection_failure") break;
  }
  assert.ok(events.filter((event) => event.kind === "diagnostic").length <= CODEX_ADAPTER_LIMITS.maxDiagnostics);
  assert.deepEqual(events.at(-1), { kind: "connection_failure", code: "adapter_resource_limit" });
  await waitFor(() => transport.closeCount === 1);
});

test("event queue accepts the exact cap and defers one terminal failure without exceeding it", async () => {
  const transport = new ControlledTransport([threadOperationFixture()]);
  const adapter = createAdapter(transport);
  await adapter.startThread({
    model: "gpt-5.4",
    workspacePath: process.cwd(),
    approvalPolicy: "never",
    sandboxMode: "read-only",
    persistence: "persistent",
  });
  await adapter.nextEvent();
  for (let index = 0; index <= CODEX_ADAPTER_LIMITS.maxQueuedEvents; index += 1) {
    transport.emit({
      kind: "notification",
      method: "thread/status/changed",
      params: {
        threadId: "thread-1",
        status: index % 2 === 0 ? { type: "active", activeFlags: [] } : { type: "idle" },
      },
    });
  }
  await waitFor(() => transport.closeCount === 1);

  let observed = 0;
  for (;;) {
    const event = await adapter.nextEvent();
    if (event.kind === "thread_status_observed") observed += 1;
    if (event.kind === "connection_failure") {
      assert.equal(event.code, "adapter_resource_limit");
      break;
    }
  }
  assert.equal(observed, CODEX_ADAPTER_LIMITS.maxQueuedEvents);
});

test("terminal overflow preserves every previously queued terminal outcome", async () => {
  const transport = new ControlledTransport([threadOperationFixture()]);
  const adapter = createAdapter(transport);
  await adapter.startThread({
    model: "gpt-5.4",
    workspacePath: process.cwd(),
    approvalPolicy: "never",
    sandboxMode: "read-only",
    persistence: "persistent",
  });
  await adapter.nextEvent();

  transport.emit({
    kind: "notification",
    method: "turn/started",
    params: { threadId: "thread-1", turn: turnFixture({ id: "turn-seed" }) },
  });
  assert.equal((await adapter.nextEvent()).kind, "turn_started");
  transport.emit({
    kind: "notification",
    method: "item/started",
    params: {
      threadId: "thread-1",
      turnId: "turn-seed",
      item: agentMessageFixture({ id: "seed-message", text: "" }),
      startedAtMs: 1,
    },
  });
  transport.emit({
    kind: "notification",
    method: "item/agentMessage/delta",
    params: {
      threadId: "thread-1",
      turnId: "turn-seed",
      itemId: "seed-message",
      delta: "seed final",
    },
  });
  transport.emit({
    kind: "notification",
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-seed",
      item: agentMessageFixture({ id: "seed-message", text: "seed final" }),
      completedAtMs: 2,
    },
  });
  transport.emit({
    kind: "notification",
    method: "turn/completed",
    params: { threadId: "thread-1", turn: turnFixture({ id: "turn-seed", status: "completed" }) },
  });
  for (let index = 0; index < CODEX_ADAPTER_LIMITS.maxQueuedEvents / 2 - 1; index += 1) {
    const turnId = `turn-${index}`;
    transport.emit({
      kind: "notification",
      method: "turn/started",
      params: { threadId: "thread-1", turn: turnFixture({ id: turnId }) },
    });
    transport.emit({
      kind: "notification",
      method: "turn/completed",
      params: { threadId: "thread-1", turn: turnFixture({ id: turnId, status: "completed" }) },
    });
  }
  transport.emit({
    kind: "notification",
    method: "turn/started",
    params: { threadId: "thread-1", turn: turnFixture({ id: "turn-overflow" }) },
  });
  transport.emit({
    kind: "notification",
    method: "turn/completed",
    params: { threadId: "thread-1", turn: turnFixture({ id: "turn-overflow", status: "completed" }) },
  });
  await waitFor(() => transport.closeCount === 1);

  const terminalIds: string[] = [];
  let seedTerminal: Extract<CodexAdapterEvent, { kind: "turn_terminal" }> | undefined;
  let overflowTerminal: Extract<CodexAdapterEvent, { kind: "turn_terminal" }> | undefined;
  for (;;) {
    const event = await adapter.nextEvent();
    if (event.kind === "turn_terminal") {
      terminalIds.push(event.turnId);
      if (event.turnId === "turn-seed") seedTerminal = event;
      if (event.turnId === "turn-overflow") overflowTerminal = event;
    }
    if (event.kind === "connection_failure") {
      assert.equal(event.code, "adapter_resource_limit");
      break;
    }
  }
  assert.equal(terminalIds.length, CODEX_ADAPTER_LIMITS.maxQueuedEvents / 2 + 1);
  assert.equal(terminalIds.includes("turn-seed"), true);
  assert.equal(terminalIds.includes("turn-overflow"), true);
  assert.deepEqual(seedTerminal?.finalAssistantMessage, {
    contentBlocks: [{ type: "text", text: "seed final" }],
  });
  assert.equal(overflowTerminal?.resourceLimitExceeded, true);
  assert.equal(overflowTerminal?.contentFailure, null);
});

test("queued output text accepts the exact connection cap and fails prospectively", async () => {
  const responses: unknown[] = [];
  for (let index = 0; index < 9; index += 1) {
    responses.push(threadOperationFixture({ thread: threadFixture({ id: `thread-${index}` }) }), {
      turn: turnFixture({ id: `turn-${index}` }),
    });
  }
  const transport = new ControlledTransport(responses);
  const adapter = createAdapter(transport);
  for (let index = 0; index < 9; index += 1) {
    await adapter.startThread({
      model: "gpt-5.4",
      workspacePath: process.cwd(),
      approvalPolicy: "never",
      sandboxMode: "read-only",
      persistence: "persistent",
    });
    await adapter.nextEvent();
    await adapter.startTurn({
      threadId: `thread-${index}`,
      contentBlocks: [{ type: "text", text: "go" }],
    });
    await adapter.nextEvent();
  }
  const chunk = "x".repeat(CODEX_ADAPTER_LIMITS.maxItemTextBytes);
  for (let threadIndex = 0; threadIndex < 8; threadIndex += 1) {
    for (let itemIndex = 0; itemIndex < 4; itemIndex += 1) {
      emitPlanItem(
        transport,
        `plan-${threadIndex}-${itemIndex}`,
        chunk,
        `thread-${threadIndex}`,
        `turn-${threadIndex}`,
      );
    }
  }
  emitPlanItem(transport, "overflow", "y", "thread-8", "turn-8");
  await waitFor(() => transport.closeCount === 1);

  let outputs = 0;
  for (;;) {
    const event = await adapter.nextEvent();
    if (event.kind === "item_output") outputs += 1;
    if (event.kind === "connection_failure") {
      assert.equal(event.code, "adapter_resource_limit");
      break;
    }
  }
  assert.equal(outputs, 32);
});

test("close is idempotent, releases live ownership, and rejects a pending waiter", async () => {
  const transport = new ControlledTransport([]);
  const adapter = createAdapter(transport);
  const pending = adapter.nextEvent();
  const first = adapter.close();
  const second = adapter.close();
  assert.equal(first, second);
  await assert.rejects(pending);
  await first;
  assert.equal(transport.closeCount, 1);
  await assert.rejects(adapter.nextEvent());
});

test("close preserves a received terminal event until the consumer drains it", async () => {
  const transport = new ControlledTransport([threadOperationFixture(), { turn: turnFixture() }]);
  const adapter = createAdapter(transport);
  await adapter.startThread({
    model: "gpt-5.4",
    workspacePath: process.cwd(),
    approvalPolicy: "never",
    sandboxMode: "read-only",
    persistence: "persistent",
  });
  await adapter.nextEvent();
  await adapter.startTurn({
    threadId: "thread-1",
    contentBlocks: [{ type: "text", text: "hello" }],
  });
  await adapter.nextEvent();

  transport.emit({
    kind: "notification",
    method: "item/started",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: agentMessageFixture({ text: "" }),
      startedAtMs: 1,
    },
  });
  transport.emit({
    kind: "notification",
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: agentMessageFixture(),
      completedAtMs: 2,
    },
  });
  transport.emit({
    kind: "notification",
    method: "turn/completed",
    params: { threadId: "thread-1", turn: turnFixture({ status: "completed" }) },
  });
  await new Promise((resolve) => setImmediate(resolve));

  await adapter.close();

  assert.deepEqual(await adapter.nextEvent(), {
    kind: "turn_terminal",
    threadId: "thread-1",
    turnId: "turn-1",
    status: "completed",
    finalAssistantMessage: {
      contentBlocks: [{ type: "text", text: "final answer" }],
    },
    contentFailure: null,
  });
  await assert.rejects(adapter.nextEvent());
});

test("a failed close can retry the same transport owner until it succeeds", async () => {
  const transport = new ControlledTransport([], true, 1);
  const adapter = createAdapter(transport);
  const pending = adapter.nextEvent();
  const first = adapter.close();

  await assert.rejects(pending);
  await assert.rejects(first);
  assert.equal(transport.closeCount, 1);

  await adapter.close();
  assert.equal(transport.closeCount, 2);
  await assert.rejects(adapter.nextEvent());
});

test("close or failure during catalog loading cannot send a later mutation or pagination request", async () => {
  const pagedCatalog = deferred<unknown>();
  const closingTransport = new ControlledTransport([pagedCatalog.promise], false);
  const closingAdapter = createAdapter(closingTransport);
  const catalogResult = closingAdapter.listModels();
  await new Promise((resolve) => setImmediate(resolve));
  await closingAdapter.close();
  pagedCatalog.resolve({ data: [], nextCursor: "page-2" });
  assert.deepEqual(await catalogResult, {
    kind: "not_sent",
    effect: "none",
    code: "capability_unavailable",
  });
  assert.deepEqual(closingTransport.requests, ["model/list"]);

  const failedCatalog = deferred<unknown>();
  const failingTransport = new ControlledTransport([failedCatalog.promise], false);
  const failingAdapter = createAdapter(failingTransport);
  const startResult = failingAdapter.startThread({
    model: "gpt-5.4",
    workspacePath: process.cwd(),
    approvalPolicy: "never",
    sandboxMode: "read-only",
    persistence: "persistent",
  });
  await new Promise((resolve) => setImmediate(resolve));
  failingTransport.emit({ kind: "notification", method: "turn/completed", params: { threadId: "invalid" } });
  assert.equal(diagnosticCode(await failingAdapter.nextEvent()), "known_invalid_payload");
  assert.equal((await failingAdapter.nextEvent()).kind, "connection_failure");
  await waitFor(() => failingTransport.closeCount === 1);
  failedCatalog.resolve({ data: [modelFixture()], nextCursor: null });
  assert.deepEqual(await startResult, {
    kind: "not_sent",
    effect: "none",
    code: "protocol_failed",
  });
  assert.deepEqual(failingTransport.requests, ["model/list"]);
});

test("production transport satisfies the Adapter process contract", async () => {
  const transport = new CodexAppServerTransport({
    executable: process.execPath,
    arguments: [fixturePath, "adapter"],
    clientInfo: { name: "withmate-adapter-test", version: "1.0.0" },
    startupTimeoutMs: 1_000,
    closeTimeoutMs: 1_000,
  });
  await transport.start();
  const adapter = new CodexAdapter(transport, { cliVersion: "0.145.0" });
  try {
    const result = await adapter.listModels({ pageSize: 10 });
    assert.equal(result.kind, "accepted");
    if (result.kind !== "accepted") assert.fail("expected an accepted production model catalog");
    assert.deepEqual(
      result.value.models.map((model) => ({
        id: model.id,
        inputModalities: model.inputModalities,
        selectable: model.selectable,
      })),
      [{ id: "gpt-5.4", inputModalities: ["text", "image"], selectable: true }],
    );
    const metadata = await adapter.nextEvent();
    assert.equal(metadata.kind, "provider_metadata");
    if (metadata.kind !== "provider_metadata") assert.fail("expected provider metadata");
    const { summary, ...metadataOutput } = metadata.output;
    assertBoundedPublicSummary(summary);
    assert.deepEqual(
      { ...metadata, output: metadataOutput },
      {
        kind: "provider_metadata",
        correlation: { threadId: "fixture-thread", turnId: "fixture-turn" },
        output: {
          category: "provider_metadata",
          kind: "future/modelCatalogObserved",
          completionState: "complete",
          payload: { kind: "none", redaction: "not_required" },
        },
      },
    );
  } finally {
    await adapter.close();
  }
});

function createAdapter(transport: CodexAdapterTransportPort): CodexAdapter {
  return new CodexAdapter(transport, { cliVersion: "0.145.0" });
}

class ControlledTransport implements CodexAdapterTransportPort {
  readonly requests: string[] = [];
  readonly requestDetails: Array<Readonly<{ method: string; params: unknown }>> = [];
  readonly #responses: Array<unknown | Promise<unknown>>;
  readonly #autoModelCatalog: boolean;
  readonly #closeFailures: number;
  readonly #events: CodexAdapterTransportEvent[] = [];
  #waiter:
    | Readonly<{
        resolve: (event: CodexAdapterTransportEvent) => void;
        reject: (error: Error) => void;
      }>
    | undefined;
  closeCount = 0;

  constructor(responses: readonly (unknown | Promise<unknown>)[], autoModelCatalog = true, closeFailures = 0) {
    this.#responses = [...responses];
    this.#autoModelCatalog = autoModelCatalog;
    this.#closeFailures = closeFailures;
  }

  request<TResult>(method: string, params?: unknown, _options?: CodexAdapterRequestOptions): Promise<TResult> {
    this.requests.push(method);
    this.requestDetails.push(Object.freeze({ method, params }));
    if (this.#autoModelCatalog && method === "model/list" && !isModelPage(this.#responses[0])) {
      return Promise.resolve({ data: [modelFixture()], nextCursor: null } as TResult);
    }
    const response = this.#responses.shift();
    if (response === undefined) return Promise.reject(new Error("missing fake response"));
    return Promise.resolve(response as TResult);
  }

  nextEvent(): Promise<CodexAdapterTransportEvent> {
    const event = this.#events.shift();
    if (event !== undefined) return Promise.resolve(event);
    return new Promise((resolve, reject) => {
      this.#waiter = { resolve, reject };
    });
  }

  emit(event: CodexAdapterTransportEvent): void {
    const waiter = this.#waiter;
    if (waiter !== undefined) {
      this.#waiter = undefined;
      waiter.resolve(event);
    } else {
      this.#events.push(event);
    }
  }

  close(): Promise<void> {
    this.closeCount += 1;
    const waiter = this.#waiter;
    this.#waiter = undefined;
    waiter?.reject(new Error("transport closed"));
    return this.closeCount <= this.#closeFailures ? Promise.reject(new Error("close_failed")) : Promise.resolve();
  }
}

function isModelPage(value: unknown): boolean {
  return typeof value === "object" && value !== null && Object.hasOwn(value, "data");
}

function diagnosticCode(event: CodexAdapterEvent): string | undefined {
  return event.kind === "diagnostic" ? event.diagnostic.code : undefined;
}

function deferred<T>(): Readonly<{
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail("condition was not reached");
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function emitPlanItem(
  transport: ControlledTransport,
  itemId: string,
  text: string,
  threadId = "thread-1",
  turnId = "turn-1",
): void {
  const item = { type: "plan", id: itemId, text };
  transport.emit({
    kind: "notification",
    method: "item/started",
    params: { threadId, turnId, item, startedAtMs: 1 },
  });
  transport.emit({
    kind: "notification",
    method: "item/completed",
    params: { threadId, turnId, item, completedAtMs: 2 },
  });
}

function threadOperationFixture(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    thread: threadFixture(),
    model: "gpt-5.4",
    modelProvider: "openai",
    serviceTier: null,
    cwd: process.cwd(),
    instructionSources: [],
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "readOnly", networkAccess: false },
    reasoningEffort: "medium",
    ...overrides,
  };
}

function threadFixture(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: "thread-1",
    sessionId: "session-1",
    forkedFromId: null,
    parentThreadId: null,
    preview: "",
    ephemeral: false,
    modelProvider: "openai",
    createdAt: 1,
    updatedAt: 1,
    recencyAt: null,
    status: { type: "idle" },
    path: null,
    cwd: process.cwd(),
    cliVersion: "0.145.0",
    source: "appServer",
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [],
    ...overrides,
  };
}

function turnFixture(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: "turn-1",
    items: [],
    itemsView: "full",
    status: "inProgress",
    error: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
    ...overrides,
  };
}

function agentMessageFixture(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    type: "agentMessage",
    id: "item-1",
    text: "final answer",
    phase: "final_answer",
    memoryCitation: null,
    ...overrides,
  };
}

function modelFixture(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: "gpt-5.4",
    model: "gpt-5.4",
    displayName: "GPT-5.4",
    description: "General model",
    hidden: false,
    supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Balanced" }],
    defaultReasoningEffort: "medium",
    inputModalities: ["text", "image"],
    isDefault: true,
    ...overrides,
  };
}
