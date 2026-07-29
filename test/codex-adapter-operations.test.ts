import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  CODEX_ADAPTER_LIMITS,
  CodexAdapter,
  CodexTransportError,
  type CodexAdapterRequestOptions,
  type CodexAdapterTransportEvent,
  type CodexAdapterTransportPort,
  type CodexTransportFailure,
} from "../src/main/providers/codex/index.js";

test("listModels preserves page order and emits the verified pagination tuple", async () => {
  const transport = new FakeTransport([
    { data: [], nextCursor: "page-2" },
    {
      data: [modelFixture({ id: "visible", model: "visible" }), modelFixture({ id: "hidden", hidden: true })],
      nextCursor: null,
    },
  ]);
  const adapter = createAdapter(transport);

  const result = await adapter.listModels({ pageSize: 2 });

  assert.equal(result.kind, "accepted");
  if (result.kind !== "accepted") assert.fail("expected model catalog");
  assert.deepEqual(
    result.value.models.map((model) => ({ id: model.id, selectable: model.selectable })),
    [
      { id: "visible", selectable: true },
      { id: "hidden", selectable: false },
    ],
  );
  assert.equal(result.value.cliVersion, "0.145.0");
  assert.equal(result.value.schemaBaseline, "0.145.0");
  assert.deepEqual(transport.requests, [
    { method: "model/list", params: { limit: 2, includeHidden: true }, options: {} },
    { method: "model/list", params: { cursor: "page-2", limit: 2, includeHidden: true }, options: {} },
  ]);
});

test("listModels rejects duplicate IDs and cursor cycles without overwriting or retrying", async () => {
  const duplicate = new FakeTransport([
    { data: [modelFixture({ id: "same" })], nextCursor: "next" },
    { data: [modelFixture({ id: "same" })], nextCursor: null },
  ]);
  assert.deepEqual(await createAdapter(duplicate).listModels(), {
    kind: "invalid_response",
    effect: "none",
    code: "invalid_response",
  });
  assert.equal(duplicate.requests.length, 2);

  const cycle = new FakeTransport([
    { data: [], nextCursor: "repeat" },
    { data: [], nextCursor: "repeat" },
  ]);
  assert.deepEqual(await createAdapter(cycle).listModels(), {
    kind: "invalid_response",
    effect: "none",
    code: "invalid_response",
  });
  assert.equal(cycle.requests.length, 2);

  const duplicateRequestModel = new FakeTransport([
    {
      data: [modelFixture({ id: "first" }), modelFixture({ id: "second" })],
      nextCursor: null,
    },
  ]);
  assert.deepEqual(await createAdapter(duplicateRequestModel).listModels(), {
    kind: "invalid_response",
    effect: "none",
    code: "invalid_response",
  });
});

test("mutations validate selectable model and reasoning tuples against the connection catalog", async () => {
  const unknownModel = new FakeTransport([{ data: [modelFixture()], nextCursor: null }]);
  assert.deepEqual(
    await createAdapter(unknownModel).startThread({
      model: "not-in-catalog",
      workspacePath: process.cwd(),
      approvalPolicy: "never",
      sandboxMode: "read-only",
      persistence: "persistent",
    }),
    { kind: "not_sent", effect: "none", code: "invalid_input" },
  );
  assert.deepEqual(
    unknownModel.requests.map((request) => request.method),
    ["model/list"],
  );

  const hiddenModel = new FakeTransport([{ data: [modelFixture({ hidden: true })], nextCursor: null }]);
  assert.deepEqual(
    await createAdapter(hiddenModel).startThread({
      model: "gpt-5.4",
      workspacePath: process.cwd(),
      approvalPolicy: "never",
      sandboxMode: "read-only",
      persistence: "persistent",
    }),
    { kind: "not_sent", effect: "none", code: "invalid_input" },
  );

  const unsupportedEffort = new FakeTransport([{ data: [modelFixture()], nextCursor: null }]);
  assert.deepEqual(
    await createAdapter(unsupportedEffort).startThread({
      model: "gpt-5.4",
      reasoningEffort: "unsupported",
      workspacePath: process.cwd(),
      approvalPolicy: "never",
      sandboxMode: "read-only",
      persistence: "persistent",
    }),
    { kind: "not_sent", effect: "none", code: "invalid_input" },
  );
  assert.deepEqual(
    unsupportedEffort.requests.map((request) => request.method),
    ["model/list"],
  );

  const unsupportedResumeEffort = new FakeTransport([{ data: [modelFixture()], nextCursor: null }]);
  assert.deepEqual(
    await createAdapter(unsupportedResumeEffort).resumeThread({
      threadId: "thread-1",
      model: "gpt-5.4",
      reasoningEffort: "unsupported",
    }),
    { kind: "not_sent", effect: "none", code: "invalid_input" },
  );
  assert.deepEqual(
    unsupportedResumeEffort.requests.map((request) => request.method),
    ["model/list"],
  );

  const audioOnly = new FakeTransport([{ data: [modelFixture({ inputModalities: ["audio"] })], nextCursor: null }]);
  assert.deepEqual(
    await createAdapter(audioOnly).startThread({
      model: "gpt-5.4",
      workspacePath: process.cwd(),
      approvalPolicy: "never",
      sandboxMode: "read-only",
      persistence: "persistent",
    }),
    { kind: "not_sent", effect: "none", code: "invalid_input" },
  );
  assert.deepEqual(
    audioOnly.requests.map((request) => request.method),
    ["model/list"],
  );

  const unsupportedResponseEffort = new FakeTransport([
    { data: [modelFixture()], nextCursor: null },
    threadOperationFixture({ reasoningEffort: "ultra" }),
  ]);
  assert.deepEqual(
    await createAdapter(unsupportedResponseEffort).startThread({
      model: "gpt-5.4",
      workspacePath: process.cwd(),
      approvalPolicy: "never",
      sandboxMode: "read-only",
      persistence: "persistent",
    }),
    { kind: "ambiguous", effect: "unknown", code: "invalid_response" },
  );
});

test("cold model capability preflight preserves transport and Provider failure provenance", async () => {
  const timeout = new FakeTransport([new CodexTransportError({ kind: "request_not_sent", code: "timeout" })], false);
  assert.deepEqual(
    await createAdapter(timeout).startThread({
      model: "gpt-5.4",
      workspacePath: process.cwd(),
      approvalPolicy: "never",
      sandboxMode: "read-only",
      persistence: "persistent",
    }),
    { kind: "not_sent", effect: "none", code: "timeout" },
  );
  assert.deepEqual(
    timeout.requests.map((request) => request.method),
    ["model/list"],
  );

  const rejected = new FakeTransport([new CodexTransportError({ kind: "remote_error", code: 429 })], false);
  assert.deepEqual(
    await createAdapter(rejected).resumeThread({
      threadId: "thread-1",
      model: "gpt-5.4",
      reasoningEffort: "medium",
    }),
    { kind: "rejected", effect: "none", code: 429 },
  );
  assert.deepEqual(
    rejected.requests.map((request) => request.method),
    ["model/list"],
  );

  const connectionLost = new FakeTransport(
    [new CodexTransportError({ kind: "response_unknown", code: "connection_lost" })],
    false,
  );
  assert.deepEqual(
    await createAdapter(connectionLost).startThread({
      model: "gpt-5.4",
      workspacePath: process.cwd(),
      approvalPolicy: "never",
      sandboxMode: "read-only",
      persistence: "persistent",
    }),
    { kind: "not_sent", effect: "none", code: "connection_lost" },
  );
});

test("event-first connection failure preserves its cause for in-flight Thread and Turn mutations", async () => {
  const threadModelCatalog = deferred<unknown>();
  const threadTransportFailure = deferred<CodexAdapterTransportEvent>();
  const threadTransport = new FakeTransport([threadModelCatalog.promise], false, threadTransportFailure.promise);
  const threadAdapter = createAdapter(threadTransport);
  const threadMutation = threadAdapter.startThread({
    model: "gpt-5.4",
    workspacePath: process.cwd(),
    approvalPolicy: "never",
    sandboxMode: "read-only",
    persistence: "persistent",
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(threadTransport.requests.at(-1)?.method, "model/list");
  threadTransportFailure.reject(new CodexTransportError({ kind: "connection_failure", code: "process_exited" }));
  await new Promise((resolve) => setImmediate(resolve));
  threadModelCatalog.reject(new CodexTransportError({ kind: "request_not_sent", code: "write_rejected" }));
  assert.deepEqual(await threadMutation, {
    kind: "not_sent",
    effect: "none",
    code: "process_exited",
  });
  assert.deepEqual(await threadAdapter.nextEvent(), {
    kind: "connection_failure",
    code: "process_exited",
  });

  const turnTransportFailure = deferred<CodexAdapterTransportEvent>();
  const turnTransport = new FakeTransport([threadOperationFixture()], true, turnTransportFailure.promise);
  const turnAdapter = createAdapter(turnTransport);
  await establishThread(turnAdapter);
  turnTransportFailure.reject(new CodexTransportError({ kind: "connection_failure", code: "process_exited" }));
  assert.deepEqual(
    await turnAdapter.startTurn({
      threadId: "thread-1",
      model: "gpt-5.4",
      contentBlocks: [{ type: "text", text: "start" }],
    }),
    { kind: "not_sent", effect: "none", code: "process_exited" },
  );
  assert.deepEqual(await turnAdapter.nextEvent(), {
    kind: "connection_failure",
    code: "process_exited",
  });
});

test("event-first connection failure remains canonical when an in-flight Provider mutation settles not_sent", async () => {
  const mutationResponse = deferred<unknown>();
  const transportFailure = deferred<CodexAdapterTransportEvent>();
  const transport = new FakeTransport(
    [{ data: [modelFixture()], nextCursor: null }, mutationResponse.promise],
    false,
    transportFailure.promise,
  );
  const adapter = createAdapter(transport);
  assert.equal((await adapter.listModels()).kind, "accepted");

  const mutation = adapter.startThread({
    model: "gpt-5.4",
    workspacePath: process.cwd(),
    approvalPolicy: "never",
    sandboxMode: "read-only",
    persistence: "persistent",
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(transport.requests.at(-1)?.method, "thread/start");

  transportFailure.resolve({
    kind: "serverRequest",
    request: { method: "future/request", params: { ignored: true } },
  });
  await new Promise((resolve) => setImmediate(resolve));
  mutationResponse.reject(new CodexTransportError({ kind: "request_not_sent", code: "write_rejected" }));

  assert.deepEqual(await mutation, {
    kind: "not_sent",
    effect: "none",
    code: "unsupported_server_request",
  });
  assert.equal((await adapter.nextEvent()).kind, "diagnostic");
  assert.deepEqual(await adapter.nextEvent(), {
    kind: "connection_failure",
    code: "unsupported_server_request",
  });
});

test("listModels enforces the page cap before issuing an extra request", async () => {
  const pages = Array.from({ length: CODEX_ADAPTER_LIMITS.maxModelPages }, (_, index) => ({
    data: [],
    nextCursor: `cursor-${index}`,
  }));
  const transport = new FakeTransport(pages);

  assert.deepEqual(await createAdapter(transport).listModels(), {
    kind: "invalid_response",
    effect: "none",
    code: "invalid_response",
  });
  assert.equal(transport.requests.length, CODEX_ADAPTER_LIMITS.maxModelPages);
});

test("listModels applies the catalog cap to complete JSON bytes across pages", async () => {
  const pages = Array.from({ length: 16 }, (_, pageIndex) => ({
    data: Array.from({ length: 256 }, (_, modelIndex) =>
      modelFixture({
        id: `model-${pageIndex}-${modelIndex}`,
        model: `model-${pageIndex}-${modelIndex}`,
        description: "x".repeat(109),
      }),
    ),
    nextCursor: pageIndex === 15 ? null : `page-${pageIndex + 1}`,
  }));
  assert.ok(
    pages.reduce((bytes, page) => bytes + Buffer.byteLength(JSON.stringify(page), "utf8"), 0) >
      CODEX_ADAPTER_LIMITS.maxModelCatalogBytes,
  );
  const transport = new FakeTransport(pages);

  assert.deepEqual(await createAdapter(transport).listModels({ pageSize: 256 }), {
    kind: "invalid_response",
    effect: "none",
    code: "invalid_response",
  });
  assert.equal(transport.requests.length, 16);
});

test("thread operations validate inputs, send approval never, and preserve bounded snapshots", async () => {
  const startTransport = new FakeTransport([threadOperationFixture({ thread: threadFixture({ ephemeral: true }) })]);
  const startResult = await createAdapter(startTransport).startThread({
    model: "gpt-5.4",
    workspacePath: process.cwd(),
    approvalPolicy: "never",
    sandboxMode: "read-only",
    persistence: "ephemeral",
  });
  assert.equal(startResult.kind, "accepted");
  if (startResult.kind !== "accepted") assert.fail("expected accepted thread/start");
  assert.deepEqual(startResult.value, {
    threadId: "thread-1",
    status: "idle",
    model: "gpt-5.4",
    modelProvider: "openai",
    cliVersion: "0.145.0",
    reasoningEffort: "medium",
  });
  assert.deepEqual(startTransport.requests[1]?.params, {
    model: "gpt-5.4",
    cwd: process.cwd(),
    approvalPolicy: "never",
    sandbox: "read-only",
    ephemeral: true,
  });

  const resumeTransport = new FakeTransport([threadOperationFixture()]);
  const resumeResult = await createAdapter(resumeTransport).resumeThread({ threadId: "thread-1" });
  assert.equal(resumeResult.kind, "accepted");
  assert.deepEqual(resumeTransport.requests[0]?.params, { threadId: "thread-1", approvalPolicy: "never" });

  const mismatch = new FakeTransport([threadOperationFixture({ thread: threadFixture({ id: "other-thread" }) })]);
  assert.deepEqual(await createAdapter(mismatch).resumeThread({ threadId: "thread-1" }), {
    kind: "ambiguous",
    effect: "unknown",
    code: "invalid_response",
  });

  const readTransport = new FakeTransport([
    { thread: threadFixture({ turns: [turnFixture({ status: "completed" })] }) },
  ]);
  assert.deepEqual(await createAdapter(readTransport).readThread({ threadId: "thread-1", includeTurns: true }), {
    kind: "accepted",
    effect: "none",
    value: {
      threadId: "thread-1",
      status: "idle",
      cliVersion: "0.145.0",
      turns: [{ turnId: "turn-1", status: "completed", itemCount: 0 }],
    },
  });
});

test("resumeThread validates the effective model tuple without treating hidden history as a new selection", async () => {
  const missingModel = new FakeTransport([
    threadOperationFixture({ model: "missing-model" }),
    { data: [modelFixture()], nextCursor: null },
  ]);
  assert.deepEqual(await createAdapter(missingModel).resumeThread({ threadId: "thread-1" }), {
    kind: "ambiguous",
    effect: "unknown",
    code: "invalid_response",
  });

  const unsupportedModality = new FakeTransport([
    threadOperationFixture({ model: "audio-only" }),
    { data: [modelFixture({ id: "audio-only", model: "audio-only", inputModalities: ["audio"] })], nextCursor: null },
  ]);
  assert.deepEqual(await createAdapter(unsupportedModality).resumeThread({ threadId: "thread-1" }), {
    kind: "ambiguous",
    effect: "unknown",
    code: "invalid_response",
  });

  const hiddenHistory = new FakeTransport([
    threadOperationFixture({ model: "hidden-model" }),
    { data: [modelFixture({ id: "hidden-model", model: "hidden-model", hidden: true })], nextCursor: null },
    { turn: turnFixture() },
  ]);
  const hiddenHistoryAdapter = createAdapter(hiddenHistory);
  assert.equal((await hiddenHistoryAdapter.resumeThread({ threadId: "thread-1" })).kind, "accepted");
  assert.equal(
    (
      await hiddenHistoryAdapter.startTurn({
        threadId: "thread-1",
        contentBlocks: [{ type: "text", text: "continue existing history" }],
      })
    ).kind,
    "accepted",
  );
});

test("an inherited source model may restore hidden history without becoming an explicit selection", async () => {
  const inheritedTransport = new FakeTransport([
    {
      data: [modelFixture({ id: "source-model", model: "source-model", hidden: true })],
      nextCursor: null,
    },
    threadOperationFixture({ model: "source-model" }),
    { turn: turnFixture() },
  ]);
  const inheritedAdapter = createAdapter(inheritedTransport);
  assert.equal(
    (
      await inheritedAdapter.resumeThread({
        threadId: "thread-1",
        model: "source-model",
        modelSelection: "inherited",
        reasoningEffort: "medium",
      })
    ).kind,
    "accepted",
  );
  assert.equal(
    (
      await inheritedAdapter.startTurn({
        threadId: "thread-1",
        contentBlocks: [{ type: "text", text: "retry the source Run" }],
        model: "source-model",
        modelSelection: "inherited",
        reasoningEffort: "medium",
      })
    ).kind,
    "accepted",
  );
  assert.deepEqual(
    inheritedTransport.requests
      .filter((request) => request.method === "thread/resume" || request.method === "turn/start")
      .map((request) => request.params),
    [
      {
        threadId: "thread-1",
        model: "source-model",
        approvalPolicy: "never",
      },
      {
        threadId: "thread-1",
        input: [{ type: "text", text: "retry the source Run", text_elements: [] }],
        approvalPolicy: "never",
        model: "source-model",
        effort: "medium",
      },
    ],
  );

  const explicitTransport = new FakeTransport([
    {
      data: [modelFixture({ id: "source-model", model: "source-model", hidden: true })],
      nextCursor: null,
    },
  ]);
  assert.deepEqual(
    await createAdapter(explicitTransport).resumeThread({
      threadId: "thread-1",
      model: "source-model",
      modelSelection: "explicit",
      reasoningEffort: "medium",
    }),
    { kind: "not_sent", effect: "none", code: "invalid_input" },
  );
});

test("resumeThread rejects Thread snapshots without exactly one current Turn when active", async () => {
  const inconsistentThreads = [
    threadFixture({ status: { type: "active", activeFlags: [] }, turns: [] }),
    threadFixture({ status: { type: "idle" }, turns: [turnFixture()] }),
    threadFixture({
      status: { type: "active", activeFlags: [] },
      turns: [turnFixture(), turnFixture({ id: "turn-2" })],
    }),
  ];

  for (const thread of inconsistentThreads) {
    const transport = new FakeTransport([threadOperationFixture({ thread })]);
    assert.deepEqual(await createAdapter(transport).resumeThread({ threadId: "thread-1" }), {
      kind: "ambiguous",
      effect: "unknown",
      code: "invalid_response",
    });
    assert.deepEqual(
      transport.requests.map((request) => request.method),
      ["thread/resume"],
    );
  }
});

test("thread mutations reject mismatched effective model, cwd, approval, and sandbox tuples as ambiguous", async () => {
  const mismatches = [
    { model: "other-model" },
    { cwd: path.join(process.cwd(), "other-workspace") },
    { approvalPolicy: "on-request" },
    { sandbox: { type: "dangerFullAccess" } },
    { thread: threadFixture({ ephemeral: true }) },
    { thread: threadFixture({ cwd: path.join(process.cwd(), "other-workspace") }) },
    { thread: threadFixture({ cliVersion: "0.144.6" }) },
  ];
  for (const mismatch of mismatches) {
    const transport = new FakeTransport([threadOperationFixture(mismatch)]);
    assert.deepEqual(
      await createAdapter(transport).startThread({
        model: "gpt-5.4",
        workspacePath: process.cwd(),
        approvalPolicy: "never",
        sandboxMode: "read-only",
        persistence: "persistent",
      }),
      { kind: "ambiguous", effect: "unknown", code: "invalid_response" },
    );
    assert.equal(transport.requests.length, 2);
  }

  const resumeTransport = new FakeTransport([
    threadOperationFixture({ sandbox: { type: "readOnly", networkAccess: false } }),
  ]);
  assert.deepEqual(
    await createAdapter(resumeTransport).resumeThread({
      threadId: "thread-1",
      sandboxMode: "workspace-write",
    }),
    { kind: "ambiguous", effect: "unknown", code: "invalid_response" },
  );
});

test(
  "thread mutations correlate Windows cwd values by Workspace identity instead of display casing",
  { skip: process.platform !== "win32" },
  async () => {
    const workspacePath = process.cwd();
    const responseCwd =
      workspacePath.toUpperCase() === workspacePath ? workspacePath.toLowerCase() : workspacePath.toUpperCase();
    assert.notEqual(responseCwd, workspacePath);
    const transport = new FakeTransport([
      threadOperationFixture({
        cwd: responseCwd,
        thread: threadFixture({ cwd: responseCwd }),
      }),
    ]);

    assert.equal(
      (
        await createAdapter(transport).startThread({
          model: "gpt-5.4",
          workspacePath,
          approvalPolicy: "never",
          sandboxMode: "read-only",
          persistence: "persistent",
        })
      ).kind,
      "accepted",
    );

    const resumeTransport = new FakeTransport([
      threadOperationFixture({
        cwd: responseCwd,
        thread: threadFixture({ cwd: responseCwd }),
      }),
    ]);
    assert.equal(
      (
        await createAdapter(resumeTransport).resumeThread({
          threadId: "thread-1",
          workspacePath,
        })
      ).kind,
      "accepted",
    );
  },
);

test("turn/start is not dispatched from not_loaded or system_error Thread states", async () => {
  for (const status of [{ type: "notLoaded" }, { type: "systemError" }] as const) {
    const transport = new FakeTransport([
      threadOperationFixture({
        thread: threadFixture({ status }),
      }),
    ]);
    const adapter = createAdapter(transport);
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

    assert.deepEqual(
      await adapter.startTurn({
        threadId: "thread-1",
        contentBlocks: [{ type: "text", text: "must wait for idle" }],
      }),
      { kind: "not_sent", effect: "none", code: "capability_unavailable" },
    );
    assert.equal(transport.requests.filter((request) => request.method === "turn/start").length, 0);
    await adapter.close();
  }
});

test("turn operations build stable 0.145 params and keep interrupt acknowledgement non-terminal", async () => {
  const startTransport = new FakeTransport([
    threadOperationFixture(),
    { turn: turnFixture() },
    { turnId: "turn-1" },
    {},
  ]);
  const startAdapter = createAdapter(startTransport);
  assert.equal(
    (
      await startAdapter.startThread({
        model: "gpt-5.4",
        workspacePath: process.cwd(),
        approvalPolicy: "never",
        sandboxMode: "read-only",
        persistence: "persistent",
      })
    ).kind,
    "accepted",
  );
  const startResult = await startAdapter.startTurn({
    threadId: "thread-1",
    contentBlocks: [
      { type: "text", text: "first" },
      { type: "text", text: "second" },
    ],
    workspacePath: process.cwd(),
    sandboxPolicy: {
      mode: "workspace-write",
      writableRoots: [process.cwd()],
      networkAccess: false,
    },
    model: "gpt-5.4",
    reasoningEffort: "medium",
    reasoningSummary: "concise",
  });
  assert.deepEqual(startResult, {
    kind: "accepted",
    effect: "present",
    value: { threadId: "thread-1", turnId: "turn-1", status: "in_progress" },
  });
  assert.deepEqual(startTransport.requests[2]?.params, {
    threadId: "thread-1",
    input: [
      { type: "text", text: "first", text_elements: [] },
      { type: "text", text: "second", text_elements: [] },
    ],
    cwd: process.cwd(),
    approvalPolicy: "never",
    sandboxPolicy: {
      type: "workspaceWrite",
      writableRoots: [process.cwd()],
      networkAccess: false,
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true,
    },
    model: "gpt-5.4",
    effort: "medium",
    summary: "concise",
  });

  assert.deepEqual(
    await startAdapter.steerTurn({
      threadId: "thread-1",
      expectedTurnId: "turn-1",
      contentBlocks: [{ type: "text", text: "steer" }],
    }),
    {
      kind: "accepted",
      effect: "present",
      value: { threadId: "thread-1", turnId: "turn-1" },
    },
  );
  const steerParams = startTransport.requests[3]?.params as Readonly<Record<string, unknown>>;
  assert.equal(typeof steerParams.clientUserMessageId, "string");
  assert.deepEqual(
    { ...steerParams, clientUserMessageId: "<generated>" },
    {
      threadId: "thread-1",
      expectedTurnId: "turn-1",
      input: [{ type: "text", text: "steer", text_elements: [] }],
      clientUserMessageId: "<generated>",
    },
  );

  assert.deepEqual(await startAdapter.interruptTurn({ threadId: "thread-1", turnId: "turn-1" }), {
    kind: "accepted",
    effect: "present",
    value: { threadId: "thread-1", turnId: "turn-1", terminal: false },
  });
});

test("operation identity and response shape mismatches preserve mutation ambiguity", async () => {
  const unknownThread = new FakeTransport([]);
  assert.deepEqual(
    await createAdapter(unknownThread).startTurn({
      threadId: "thread-1",
      contentBlocks: [{ type: "text", text: "must not send" }],
    }),
    { kind: "not_sent", effect: "none", code: "capability_unavailable" },
  );
  assert.equal(unknownThread.requests.length, 0);

  const steerMismatch = new FakeTransport([
    threadOperationFixture(),
    { turn: turnFixture() },
    { turnId: "other-turn" },
  ]);
  const steerMismatchAdapter = createAdapter(steerMismatch);
  await establishActiveTurn(steerMismatchAdapter);
  assert.deepEqual(
    await steerMismatchAdapter.steerTurn({
      threadId: "thread-1",
      expectedTurnId: "turn-1",
      contentBlocks: [{ type: "text", text: "steer" }],
    }),
    { kind: "ambiguous", effect: "unknown", code: "invalid_response" },
  );
  assert.equal(steerMismatch.requests.length, 4);

  const invalidStart = new FakeTransport([threadOperationFixture(), { turn: turnFixture({ status: "completed" }) }]);
  const invalidStartAdapter = createAdapter(invalidStart);
  await establishThread(invalidStartAdapter);
  assert.deepEqual(
    await invalidStartAdapter.startTurn({
      threadId: "thread-1",
      contentBlocks: [{ type: "text", text: "start" }],
    }),
    { kind: "ambiguous", effect: "unknown", code: "invalid_response" },
  );
  assert.deepEqual(
    await invalidStartAdapter.startTurn({
      threadId: "thread-1",
      contentBlocks: [{ type: "text", text: "must not retry" }],
    }),
    { kind: "not_sent", effect: "none", code: "capability_unavailable" },
  );
  assert.equal(invalidStart.requests.length, 3);

  const invalidRead = new FakeTransport([{ thread: threadFixture({ id: "other-thread" }) }]);
  assert.deepEqual(await createAdapter(invalidRead).readThread({ threadId: "thread-1", includeTurns: false }), {
    kind: "invalid_response",
    effect: "none",
    code: "invalid_response",
  });

  const duplicateHistory = new FakeTransport([
    { thread: threadFixture({ turns: [turnFixture(), turnFixture({ status: "completed" })] }) },
  ]);
  assert.deepEqual(await createAdapter(duplicateHistory).readThread({ threadId: "thread-1", includeTurns: true }), {
    kind: "invalid_response",
    effect: "none",
    code: "invalid_response",
  });

  const duplicateMutationHistory = new FakeTransport([
    threadOperationFixture({ thread: threadFixture({ turns: [turnFixture(), turnFixture()] }) }),
  ]);
  assert.deepEqual(
    await createAdapter(duplicateMutationHistory).startThread({
      model: "gpt-5.4",
      workspacePath: process.cwd(),
      approvalPolicy: "never",
      sandboxMode: "read-only",
      persistence: "persistent",
    }),
    { kind: "ambiguous", effect: "unknown", code: "invalid_response" },
  );
});

test("unsupported approval and CLI versions fail before any provider send", async () => {
  const approvalTransport = new FakeTransport([]);
  assert.deepEqual(
    await createAdapter(approvalTransport).startThread({
      model: "gpt-5.4",
      workspacePath: process.cwd(),
      approvalPolicy: "on-request",
      sandboxMode: "read-only",
      persistence: "persistent",
    }),
    { kind: "not_sent", effect: "none", code: "capability_unavailable" },
  );
  assert.equal(approvalTransport.requests.length, 0);

  const versionTransport = new FakeTransport([]);
  assert.deepEqual(await new CodexAdapter(versionTransport, { cliVersion: "0.146.0" }).listModels(), {
    kind: "not_sent",
    effect: "none",
    code: "capability_unavailable",
  });
  assert.equal(versionTransport.requests.length, 0);

  let getterReads = 0;
  const invalidInput = {
    threadId: "thread-1",
    get includeTurns(): boolean {
      getterReads += 1;
      return true;
    },
  };
  assert.deepEqual(await createAdapter(versionTransport).readThread(invalidInput as never), {
    kind: "not_sent",
    effect: "none",
    code: "invalid_input",
  });
  assert.equal(getterReads, 0);
  assert.equal(versionTransport.requests.length, 0);
});

test("transport failures retain send certainty and never trigger an Adapter retry", async () => {
  const cases: readonly Readonly<{
    failure: CodexTransportFailure;
    read: unknown;
    mutation: unknown;
  }>[] = [
    {
      failure: { kind: "request_not_sent", code: "timeout" },
      read: { kind: "not_sent", effect: "none", code: "timeout" },
      mutation: { kind: "not_sent", effect: "none", code: "timeout" },
    },
    {
      failure: { kind: "remote_error", code: -32600 },
      read: { kind: "rejected", effect: "none", code: -32600 },
      mutation: { kind: "rejected", effect: "none", code: -32600 },
    },
    {
      failure: { kind: "response_unknown", code: "connection_lost" },
      read: { kind: "ambiguous", effect: "none", code: "connection_lost" },
      mutation: { kind: "ambiguous", effect: "unknown", code: "connection_lost" },
    },
    {
      failure: { kind: "connection_failure", code: "process_exited" },
      read: { kind: "connection_failure", effect: "none", code: "process_exited" },
      mutation: { kind: "connection_failure", effect: "unknown", code: "process_exited" },
    },
  ];

  for (const candidate of cases) {
    const readTransport = new FakeTransport([new CodexTransportError(candidate.failure)]);
    assert.deepEqual(
      await createAdapter(readTransport).readThread({ threadId: "thread-1", includeTurns: false }),
      candidate.read,
    );
    assert.equal(readTransport.requests.length, 1);

    const mutationTransport = new FakeTransport([
      threadOperationFixture(),
      { turn: turnFixture() },
      new CodexTransportError(candidate.failure),
    ]);
    const mutationAdapter = createAdapter(mutationTransport);
    await establishActiveTurn(mutationAdapter);
    assert.deepEqual(
      await mutationAdapter.interruptTurn({ threadId: "thread-1", turnId: "turn-1" }),
      candidate.mutation,
    );
    assert.equal(mutationTransport.requests.length, 4);
  }

  const lookalikeTransport = new FakeTransport([
    threadOperationFixture(),
    { turn: turnFixture() },
    Object.assign(new Error("lookalike"), {
      failure: { kind: "request_not_sent", code: "timeout" },
    }),
  ]);
  const lookalikeAdapter = createAdapter(lookalikeTransport);
  await establishActiveTurn(lookalikeAdapter);
  assert.deepEqual(await lookalikeAdapter.interruptTurn({ threadId: "thread-1", turnId: "turn-1" }), {
    kind: "connection_failure",
    effect: "unknown",
    code: "protocol_failed",
  });
  assert.equal(lookalikeTransport.requests.length, 4);
});

test("a known connection failure closes the Adapter before any sibling operation can send", async () => {
  const transport = new FakeTransport([
    threadOperationFixture(),
    { turn: turnFixture() },
    new CodexTransportError({ kind: "connection_failure", code: "process_exited" }),
    { turnId: "turn-1" },
  ]);
  const adapter = createAdapter(transport);
  await establishActiveTurn(adapter);
  assert.deepEqual(await adapter.interruptTurn({ threadId: "thread-1", turnId: "turn-1" }), {
    kind: "connection_failure",
    effect: "unknown",
    code: "process_exited",
  });
  assert.deepEqual(
    await adapter.steerTurn({
      threadId: "thread-1",
      expectedTurnId: "turn-1",
      contentBlocks: [{ type: "text", text: "do not send" }],
    }),
    { kind: "not_sent", effect: "none", code: "process_exited" },
  );
  assert.equal(transport.requests.length, 4);
  assert.deepEqual(await adapter.nextEvent(), { kind: "connection_failure", code: "process_exited" });
});

test("Thread mutation reservations reject aggregate overflow before provider send and retain ambiguity", async () => {
  const pendingResponses = Array.from({ length: CODEX_ADAPTER_LIMITS.maxTrackedThreads }, () => deferred<unknown>());
  const concurrentTransport = new FakeTransport([
    { data: [modelFixture()], nextCursor: null },
    ...pendingResponses.map((response) => response.promise),
  ]);
  const concurrentAdapter = createAdapter(concurrentTransport);
  const starts = pendingResponses.map(() =>
    concurrentAdapter.startThread({
      model: "gpt-5.4",
      workspacePath: process.cwd(),
      approvalPolicy: "never",
      sandboxMode: "read-only",
      persistence: "persistent",
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    await concurrentAdapter.startThread({
      model: "gpt-5.4",
      workspacePath: process.cwd(),
      approvalPolicy: "never",
      sandboxMode: "read-only",
      persistence: "persistent",
    }),
    { kind: "not_sent", effect: "none", code: "capability_unavailable" },
  );
  assert.equal(
    concurrentTransport.requests.filter((request) => request.method === "thread/start").length,
    CODEX_ADAPTER_LIMITS.maxTrackedThreads,
  );
  pendingResponses.forEach((response, index) => {
    response.resolve(threadOperationFixture({ thread: threadFixture({ id: `concurrent-${index}` }) }));
  });
  assert.equal(
    (await Promise.all(starts)).every((result) => result.kind === "accepted"),
    true,
  );
  await concurrentAdapter.close();

  const ambiguousTransport = new FakeTransport([
    { data: [modelFixture()], nextCursor: null },
    ...Array.from(
      { length: CODEX_ADAPTER_LIMITS.maxTrackedThreads },
      () => new CodexTransportError({ kind: "response_unknown", code: "connection_lost" }),
    ),
  ]);
  const ambiguousAdapter = createAdapter(ambiguousTransport);
  for (let index = 0; index < CODEX_ADAPTER_LIMITS.maxTrackedThreads; index += 1) {
    assert.equal(
      (
        await ambiguousAdapter.startThread({
          model: "gpt-5.4",
          workspacePath: process.cwd(),
          approvalPolicy: "never",
          sandboxMode: "read-only",
          persistence: "persistent",
        })
      ).kind,
      "ambiguous",
    );
  }
  assert.deepEqual(
    await ambiguousAdapter.startThread({
      model: "gpt-5.4",
      workspacePath: process.cwd(),
      approvalPolicy: "never",
      sandboxMode: "read-only",
      persistence: "persistent",
    }),
    { kind: "not_sent", effect: "none", code: "capability_unavailable" },
  );
  assert.equal(
    ambiguousTransport.requests.filter((request) => request.method === "thread/start").length,
    CODEX_ADAPTER_LIMITS.maxTrackedThreads,
  );
  await ambiguousAdapter.close();

  const reusableTransport = new FakeTransport([
    { data: [modelFixture()], nextCursor: null },
    new CodexTransportError({ kind: "request_not_sent", code: "timeout" }),
    threadOperationFixture(),
  ]);
  const reusableAdapter = createAdapter(reusableTransport);
  const startInput = {
    model: "gpt-5.4",
    workspacePath: process.cwd(),
    approvalPolicy: "never" as const,
    sandboxMode: "read-only" as const,
    persistence: "persistent" as const,
  };
  assert.deepEqual(await reusableAdapter.startThread(startInput), {
    kind: "not_sent",
    effect: "none",
    code: "timeout",
  });
  assert.equal((await reusableAdapter.startThread(startInput)).kind, "accepted");
  assert.equal(reusableTransport.requests.filter((request) => request.method === "thread/start").length, 2);
  await reusableAdapter.close();
});

test("ambiguous turn starts retain only a bounded per-Thread reconciliation context", async () => {
  const responses: unknown[] = [];
  for (let index = 0; index < CODEX_ADAPTER_LIMITS.maxTrackedThreads; index += 1) {
    responses.push(
      threadOperationFixture({ thread: threadFixture({ id: `thread-${index}` }) }),
      new CodexTransportError({ kind: "response_unknown", code: "connection_lost" }),
    );
  }
  const transport = new FakeTransport(responses);
  const adapter = createAdapter(transport);
  for (let index = 0; index < CODEX_ADAPTER_LIMITS.maxTrackedThreads; index += 1) {
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
    assert.equal(
      (
        await adapter.startTurn({
          threadId: `thread-${index}`,
          contentBlocks: [{ type: "text", text: "ambiguous" }],
          model: "gpt-5.4",
        })
      ).kind,
      "ambiguous",
    );
  }
  assert.deepEqual(
    await adapter.startTurn({
      threadId: "thread-0",
      contentBlocks: [{ type: "text", text: "must not send" }],
      model: "gpt-5.4",
    }),
    { kind: "not_sent", effect: "none", code: "capability_unavailable" },
  );
  assert.equal(transport.requests.length, 1 + CODEX_ADAPTER_LIMITS.maxTrackedThreads * 2);
  await adapter.close();
});

test("request options are snapshotted before send", async () => {
  const controller = new AbortController();
  const transport = new FakeTransport([threadOperationFixture(), { turn: turnFixture() }, { turnId: "turn-1" }]);
  const adapter = createAdapter(transport);
  await establishActiveTurn(adapter);
  const replacementController = new AbortController();
  const options = { timeoutMs: 123, signal: controller.signal };
  const steering = adapter.steerTurn(
    {
      threadId: "thread-1",
      expectedTurnId: "turn-1",
      contentBlocks: [{ type: "text", text: "steer" }],
    },
    options,
  );
  options.timeoutMs = 456;
  options.signal = replacementController.signal;
  await steering;

  const sentOptions = transport.requests[3]?.options;
  assert.ok(sentOptions);
  assert.notStrictEqual(sentOptions, options);
  assert.equal(Object.isFrozen(sentOptions), true);
  assert.equal(sentOptions.timeoutMs, 123);
  assert.equal(sentOptions.signal, controller.signal);

  const invalidTransport = new FakeTransport([]);
  assert.deepEqual(await createAdapter(invalidTransport).listModels({}, { timeoutMs: 0 }), {
    kind: "not_sent",
    effect: "none",
    code: "invalid_input",
  });
  assert.equal(invalidTransport.requests.length, 0);
});

function createAdapter(transport: CodexAdapterTransportPort): CodexAdapter {
  return new CodexAdapter(transport, { cliVersion: "0.145.0" });
}

function deferred<T>(): Readonly<{
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return Object.freeze({ promise, resolve, reject });
}

async function establishThread(adapter: CodexAdapter): Promise<void> {
  const result = await adapter.startThread({
    model: "gpt-5.4",
    workspacePath: process.cwd(),
    approvalPolicy: "never",
    sandboxMode: "read-only",
    persistence: "persistent",
  });
  assert.equal(result.kind, "accepted");
  assert.equal((await adapter.nextEvent()).kind, "thread_started");
}

async function establishActiveTurn(adapter: CodexAdapter): Promise<void> {
  await establishThread(adapter);
  const result = await adapter.startTurn({
    threadId: "thread-1",
    contentBlocks: [{ type: "text", text: "start" }],
  });
  assert.equal(result.kind, "accepted");
  assert.equal((await adapter.nextEvent()).kind, "turn_started");
}

class FakeTransport implements CodexAdapterTransportPort {
  readonly requests: Array<Readonly<{ method: string; params: unknown; options: CodexAdapterRequestOptions }>> = [];
  readonly #responses: unknown[];

  constructor(
    responses: readonly unknown[],
    readonly autoModelCatalog = true,
    readonly eventResult?: Promise<CodexAdapterTransportEvent>,
  ) {
    this.#responses = [...responses];
  }

  request<TResult>(method: string, params?: unknown, options: CodexAdapterRequestOptions = {}): Promise<TResult> {
    this.requests.push(Object.freeze({ method, params, options }));
    if (this.autoModelCatalog && method === "model/list" && !isModelPage(this.#responses[0])) {
      return Promise.resolve({ data: [modelFixture()], nextCursor: null } as TResult);
    }
    if (this.#responses.length === 0) return Promise.reject(new Error("missing fake response"));
    const response = this.#responses.shift();
    return response instanceof Error ? Promise.reject(response) : Promise.resolve(response as TResult);
  }

  nextEvent(): Promise<CodexAdapterTransportEvent> {
    return this.eventResult ?? new Promise(() => undefined);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

function isModelPage(value: unknown): boolean {
  return typeof value === "object" && value !== null && Object.hasOwn(value, "data");
}

function modelFixture(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: "gpt-5.4",
    model: "gpt-5.4",
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    displayName: "GPT-5.4",
    description: "General model",
    hidden: false,
    supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Balanced" }],
    defaultReasoningEffort: "medium",
    inputModalities: ["text", "image"],
    supportsPersonality: true,
    additionalSpeedTiers: [],
    serviceTiers: [],
    defaultServiceTier: null,
    isDefault: true,
    ...overrides,
  };
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
