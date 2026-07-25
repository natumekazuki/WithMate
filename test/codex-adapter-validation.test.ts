import assert from "node:assert/strict";
import test from "node:test";

import { CODEX_ADAPTER_LIMITS } from "../src/main/providers/codex/index.js";
import { resolveWorkspaceIdentity } from "../src/shared/workspace-path.js";
import {
  classifyCodexNotification,
  decodeModelListResponse,
  decodeThreadReadResponse,
  decodeThreadStartResponse,
  decodeTurnInterruptResponse,
  decodeTurnStartResponse,
  decodeTurnSteerResponse,
  snapshotInterruptTurnInput,
  snapshotListModelsInput,
  snapshotReadThreadInput,
  snapshotResumeThreadInput,
  snapshotStartThreadInput,
  snapshotStartTurnInput,
  snapshotSteerTurnInput,
  toAdapterThreadStatus,
  toAdapterTurnStatus,
} from "../src/main/providers/codex/codex-adapter-validation.js";

test("adapter snapshots supported operation inputs into immutable exact values", () => {
  assert.deepEqual(snapshotListModelsInput(undefined), { ok: true, value: {} });
  assert.deepEqual(snapshotListModelsInput({ pageSize: 25 }), { ok: true, value: { pageSize: 25 } });

  const startThread = snapshotStartThreadInput({
    model: "gpt-5.4",
    workspacePath: process.cwd(),
    approvalPolicy: "never",
    sandboxMode: "workspace-write",
    persistence: "persistent",
  });
  assert.equal(startThread.ok, true);
  if (!startThread.ok) assert.fail("expected a valid thread/start input");
  assert.equal(Object.isFrozen(startThread.value), true);
  assert.equal(startThread.value.workspacePath, process.cwd());

  assert.equal(
    snapshotResumeThreadInput({
      threadId: "thread-1",
      model: "gpt-5.4",
      workspacePath: process.cwd(),
      approvalPolicy: "never",
      sandboxMode: "read-only",
    }).ok,
    true,
  );
  assert.deepEqual(snapshotReadThreadInput({ threadId: "thread-1", includeTurns: true }), {
    ok: true,
    value: { threadId: "thread-1", includeTurns: true },
  });

  const startTurn = snapshotStartTurnInput({
    threadId: "thread-1",
    contentBlocks: [{ type: "text", text: "hello" }],
    workspacePath: process.cwd(),
    approvalPolicy: "never",
    sandboxPolicy: {
      mode: "workspace-write",
      writableRoots: [process.cwd()],
      networkAccess: false,
    },
    model: "gpt-5.4",
    reasoningEffort: "medium",
    reasoningSummary: "concise",
  });
  assert.equal(startTurn.ok, true);
  if (!startTurn.ok) assert.fail("expected a valid turn/start input");
  assert.equal(Object.isFrozen(startTurn.value.contentBlocks), true);
  assert.equal(Object.isFrozen(startTurn.value.contentBlocks[0]), true);

  assert.equal(
    snapshotSteerTurnInput({
      threadId: "thread-1",
      expectedTurnId: "turn-1",
      contentBlocks: [{ type: "text", text: "updated" }],
    }).ok,
    true,
  );
  assert.deepEqual(snapshotInterruptTurnInput({ threadId: "thread-1", turnId: "turn-1" }), {
    ok: true,
    value: { threadId: "thread-1", turnId: "turn-1" },
  });
});

test("adapter input validators reject accessors, sparse arrays, aliases, prototypes, and unknown fields", () => {
  let getterReads = 0;
  const accessorInput = {
    threadId: "thread-1",
    get includeTurns(): boolean {
      getterReads += 1;
      return true;
    },
  };
  assert.deepEqual(snapshotReadThreadInput(accessorInput), { ok: false });
  assert.equal(getterReads, 0);

  const sparseBlocks = Array<{ type: "text"; text: string }>(1);
  assert.deepEqual(snapshotStartTurnInput({ threadId: "thread-1", contentBlocks: sparseBlocks }), { ok: false });

  const sharedBlock = { type: "text", text: "same object" } as const;
  assert.deepEqual(
    snapshotSteerTurnInput({
      threadId: "thread-1",
      expectedTurnId: "turn-1",
      contentBlocks: [sharedBlock, sharedBlock],
    }),
    { ok: false },
  );

  const customPrototype = Object.create({}) as Record<string, unknown>;
  Object.assign(customPrototype, { threadId: "thread-1", turnId: "turn-1" });
  assert.deepEqual(snapshotInterruptTurnInput(customPrototype), { ok: false });
  assert.deepEqual(snapshotListModelsInput({ pageSize: 1, future: true }), { ok: false });

  const hostile = new Proxy(
    {},
    {
      getPrototypeOf: () => {
        throw new Error("must be contained");
      },
    },
  );
  assert.deepEqual(snapshotListModelsInput(hostile), { ok: false });

  const prototypeKeyInput = Object.create(null) as Record<string, unknown>;
  prototypeKeyInput.threadId = "thread-1";
  prototypeKeyInput.includeTurns = true;
  prototypeKeyInput.__proto__ = { polluted: true };
  assert.deepEqual(snapshotReadThreadInput(prototypeKeyInput), { ok: false });
});

test("adapter decodes exact 0.145 model, thread, and turn responses", () => {
  const models = decodeModelListResponse({
    data: [modelFixture({ inputModalities: ["text", "image", "audio"] })],
    nextCursor: "next-page",
  });
  assert.equal(models.ok, true);
  if (!models.ok) assert.fail("expected a valid model/list response");
  assert.deepEqual(models.value.models[0], {
    id: "gpt-5.4",
    requestModel: "gpt-5.4",
    displayName: "GPT-5.4",
    hidden: false,
    selectable: true,
    supportedReasoningEfforts: ["medium"],
    defaultReasoningEffort: "medium",
    inputModalities: ["text", "image", "audio"],
    supportsPersonality: true,
    isDefault: true,
  });
  assert.equal(models.value.nextCursor, "next-page");
  assert.ok(models.value.byteLength > 0);

  const threadStart = decodeThreadStartResponse(threadOperationFixture());
  assert.equal(threadStart.ok, true);
  if (!threadStart.ok) assert.fail("expected a valid thread/start response");
  assert.equal(threadStart.value.thread.id, "thread-1");
  assert.equal(threadStart.value.thread.cliVersion, "0.145.0");
  assert.equal(threadStart.value.model, "gpt-5.4");

  assert.deepEqual(decodeThreadReadResponse({ thread: threadFixture({ turns: [turnFixture()] }) }), {
    ok: true,
    value: {
      thread: {
        id: "thread-1",
        status: { type: "idle", activeFlags: [] },
        cliVersion: "0.145.0",
        modelProvider: "openai",
        cwd: process.cwd(),
        workspaceKey: resolveWorkspaceIdentity(process.cwd())?.workspaceKey,
        ephemeral: false,
        turns: [{ id: "turn-1", status: "inProgress", items: [] }],
      },
    },
  });
  assert.deepEqual(decodeTurnStartResponse({ turn: turnFixture() }), {
    ok: true,
    value: { turn: { id: "turn-1", status: "inProgress", items: [] } },
  });
  assert.deepEqual(decodeTurnSteerResponse({ turnId: "turn-1" }), {
    ok: true,
    value: { turnId: "turn-1" },
  });
  assert.deepEqual(decodeTurnInterruptResponse({}), { ok: true, value: {} });
});

test("stable 0.145 response defaults preserve omitted optional fields", () => {
  const models = decodeModelListResponse({
    data: [
      {
        id: "minimal-model",
        model: "minimal-model",
        displayName: "Minimal",
        description: "",
        hidden: false,
        supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "" }],
        defaultReasoningEffort: "medium",
        inputModalities: ["text", "image"],
        isDefault: true,
      },
    ],
  });
  assert.equal(models.ok, true);
  if (!models.ok) assert.fail("expected a stable-valid minimal model response");
  assert.equal(models.value.nextCursor, null);
  assert.deepEqual(models.value.models[0]?.inputModalities, ["text", "image"]);
  assert.equal(models.value.models[0]?.supportsPersonality, false);

  const minimalItems: Record<string, unknown>[] = [
    { type: "agentMessage", id: "agent", text: "answer", phase: null },
    { type: "reasoning", id: "reasoning" },
    {
      type: "commandExecution",
      id: "command",
      command: "command",
      cwd: process.cwd(),
      status: "completed",
      commandActions: [{ type: "listFiles", command: "list" }],
    },
    {
      type: "mcpToolCall",
      id: "mcp",
      server: "server",
      tool: "tool",
      status: "completed",
      arguments: {},
      appContext: { connectorId: "connector" },
    },
    {
      type: "dynamicToolCall",
      id: "dynamic",
      tool: "tool",
      arguments: {},
      status: "completed",
      contentItems: [{ type: "inputAudio", audioUrl: "https://example.test/audio" }],
    },
    {
      type: "userMessage",
      id: "user",
      clientId: "client-user-message-1",
      content: [
        { type: "text", text: "hello" },
        { type: "audio", url: "https://example.test/audio" },
        { type: "localAudio", path: "audio.wav" },
      ],
    },
    {
      type: "collabAgentToolCall",
      id: "collab",
      tool: "wait",
      status: "completed",
      senderThreadId: "thread-1",
      receiverThreadIds: ["thread-2"],
      agentsStates: { "thread-2": { status: "completed" } },
    },
    { type: "webSearch", id: "search", query: "query", results: [{ title: "result" }] },
    { type: "imageGeneration", id: "image", status: "completed", result: "result" },
  ];
  const minimalThread = {
    id: "thread-1",
    sessionId: "session-1",
    preview: "",
    ephemeral: false,
    modelProvider: "openai",
    createdAt: 1,
    updatedAt: 1,
    status: { type: "idle" },
    cwd: process.cwd(),
    cliVersion: "0.145.0",
    source: "appServer",
    turns: [{ id: "turn-1", items: minimalItems, status: "completed" }],
  };
  const read = decodeThreadReadResponse({ thread: minimalThread });
  assert.equal(read.ok, true);
  if (!read.ok) assert.fail("expected a stable-valid minimal Thread response");
  assert.deepEqual(
    read.value.thread.turns[0]?.items.map((item) => item.classification),
    [
      "agentMessage",
      "reasoning",
      "operation",
      "operation",
      "operation",
      "userMessage",
      "unsupported",
      "unsupported",
      "unsupported",
    ],
  );
  const userMessage = read.value.thread.turns[0]?.items.find((item) => item.classification === "userMessage");
  assert.deepEqual(userMessage, {
    classification: "userMessage",
    id: "user",
    clientId: "client-user-message-1",
  });

  const started = decodeThreadStartResponse({
    thread: minimalThread,
    model: "minimal-model",
    modelProvider: "openai",
    cwd: process.cwd(),
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "readOnly" },
  });
  assert.equal(started.ok, true);
  if (!started.ok) assert.fail("expected omitted response defaults to be accepted");
  assert.equal(started.value.reasoningEffort, null);
});

test("model/list applies the stable default when inputModalities is omitted", () => {
  const modelWithoutInputModalities = modelFixture();
  delete modelWithoutInputModalities.inputModalities;
  const decoded = decodeModelListResponse({ data: [modelWithoutInputModalities], nextCursor: null });
  assert.equal(decoded.ok, true);
  if (!decoded.ok) assert.fail("expected the stable input modality default");
  assert.deepEqual(decoded.value.models[0]?.inputModalities, ["text", "image"]);
});

test("model/list does not apply the inputModalities default to explicitly invalid values", () => {
  const sparseModalities = new Array<string>(2);
  sparseModalities[0] = "text";
  for (const inputModalities of [null, ["text", "video"], sparseModalities]) {
    assert.deepEqual(
      decodeModelListResponse({
        data: [modelFixture({ inputModalities })],
        nextCursor: null,
      }),
      { ok: false },
    );
  }
});

test("Thread items apply the stable null default when agentMessage phase is omitted", () => {
  const agentMessageWithoutPhase = agentMessageFixture();
  delete agentMessageWithoutPhase.phase;
  const decoded = decodeThreadReadResponse({
    thread: threadFixture({
      turns: [turnFixture({ items: [agentMessageWithoutPhase] })],
    }),
  });
  assert.equal(decoded.ok, true);
  if (!decoded.ok) assert.fail("expected the stable agent message phase default");
  assert.equal(decoded.value.thread.turns[0]?.items[0]?.classification, "agentMessage");
  assert.deepEqual(decoded.value.thread.turns[0]?.items[0], {
    classification: "agentMessage",
    id: "item-1",
    text: "final answer",
    phase: null,
  });
});

test("item notifications apply the stable null default when agentMessage phase is omitted", () => {
  const agentMessageWithoutPhase = agentMessageFixture();
  delete agentMessageWithoutPhase.phase;
  const classified = classifyCodexNotification("item/completed", {
    item: agentMessageWithoutPhase,
    threadId: "thread-1",
    turnId: "turn-1",
    completedAtMs: 1,
  });
  assert.equal(classified.kind, "known");
  if (classified.kind !== "known" || classified.notification.method !== "item/completed") {
    assert.fail("expected a known item/completed notification");
  }
  assert.deepEqual(classified.notification.item, {
    classification: "agentMessage",
    id: "item-1",
    text: "final answer",
    phase: null,
  });
});

test("item notifications reject an explicitly invalid agentMessage phase", () => {
  const classified = classifyCodexNotification("item/completed", {
    item: agentMessageFixture({ phase: "draft" }),
    threadId: "thread-1",
    turnId: "turn-1",
    completedAtMs: 1,
  });
  assert.equal(classified.kind, "known_invalid");
});

test("response validators reject schema drift, aggregate overflow, and invalid status payload combinations", () => {
  assert.deepEqual(decodeModelListResponse({ data: [modelFixture({ future: true })], nextCursor: null }), {
    ok: false,
  });
  assert.deepEqual(
    decodeModelListResponse({
      data: Array.from({ length: 33 }, (_, index) =>
        modelFixture({ id: `model-${index}`, description: "x".repeat(64 * 1_024) }),
      ),
      nextCursor: null,
    }),
    { ok: false },
  );

  const invalidCompleted = turnFixture({
    status: "completed",
    error: { message: "must not exist", codexErrorInfo: null, additionalDetails: null },
  });
  assert.deepEqual(decodeTurnStartResponse({ turn: invalidCompleted }), { ok: false });

  const failedWithoutDetails = turnFixture({ status: "failed", error: null });
  assert.equal(decodeTurnStartResponse({ turn: failedWithoutDetails }).ok, true);
  assert.deepEqual(
    decodeThreadReadResponse({
      thread: threadFixture({ turns: [turnFixture(), turnFixture()] }),
    }),
    { ok: false },
  );
  assert.deepEqual(
    decodeThreadReadResponse({
      thread: threadFixture({
        turns: [
          turnFixture({
            items: [agentMessageFixture({ id: "duplicate-item" }), agentMessageFixture({ id: "duplicate-item" })],
          }),
        ],
      }),
    }),
    { ok: false },
  );
  assert.deepEqual(decodeThreadStartResponse(threadOperationFixture({ reasoningEffort: "" })), { ok: false });
  assert.equal(decodeThreadStartResponse(threadOperationFixture({ reasoningEffort: null })).ok, true);
  assert.deepEqual(decodeTurnInterruptResponse({ unexpected: true }), { ok: false });
  assert.deepEqual(decodeTurnSteerResponse({ turnId: "turn-1", future: true }), { ok: false });
  assert.deepEqual(
    classifyCodexNotification("item/completed", {
      item: {
        type: "mcpToolCall",
        id: "mcp",
        server: "server",
        tool: "tool",
        status: "completed",
        arguments: {},
        appContext: { connectorId: "connector", templateId: "not-stable" },
      },
      threadId: "thread-1",
      turnId: "turn-1",
      completedAtMs: 1,
    }),
    { kind: "known_invalid", method: "item/completed" },
  );

  assert.deepEqual(
    decodeModelListResponse({
      data: [
        modelFixture({
          supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Low" }],
          defaultReasoningEffort: "high",
        }),
      ],
      nextCursor: null,
    }),
    { ok: false },
  );
  assert.deepEqual(
    decodeModelListResponse({
      data: [
        modelFixture({
          serviceTiers: [{ id: "flex", name: "Flex", description: "Flexible" }],
          defaultServiceTier: "priority",
        }),
      ],
      nextCursor: null,
    }),
    { ok: false },
  );
});

test("notification classification separates supported, supported-invalid, and bounded unknown methods", () => {
  const completed = classifyCodexNotification("item/completed", {
    item: agentMessageFixture(),
    threadId: "thread-1",
    turnId: "turn-1",
    completedAtMs: 123,
  });
  assert.equal(completed.kind, "known");
  if (completed.kind !== "known") assert.fail("expected a known notification");
  assert.deepEqual(completed.notification, {
    method: "item/completed",
    threadId: "thread-1",
    turnId: "turn-1",
    item: {
      classification: "agentMessage",
      id: "item-1",
      text: "final answer",
      phase: "final_answer",
    },
    timestampMs: 123,
  });

  assert.deepEqual(
    classifyCodexNotification("turn/completed", {
      threadId: "thread-1",
      turn: turnFixture({
        status: "completed",
        error: { message: "bad", codexErrorInfo: null, additionalDetails: null },
      }),
    }),
    { kind: "known_invalid", method: "turn/completed" },
  );
  assert.deepEqual(
    classifyCodexNotification("turn/completed", {
      threadId: "thread-1",
      turn: turnFixture({ status: "inProgress" }),
    }),
    { kind: "known_invalid", method: "turn/completed" },
  );
  assert.deepEqual(
    classifyCodexNotification("turn/started", {
      threadId: "thread-1",
      turn: turnFixture({ status: "completed" }),
    }),
    { kind: "known_invalid", method: "turn/started" },
  );
  assert.deepEqual(
    classifyCodexNotification("item/completed", {
      item: commandExecutionFixture({ status: "inProgress" }),
      threadId: "thread-1",
      turnId: "turn-1",
      completedAtMs: 1,
    }),
    { kind: "known_invalid", method: "item/completed" },
  );
  assert.deepEqual(
    classifyCodexNotification("item/started", {
      item: commandExecutionFixture({ status: "completed" }),
      threadId: "thread-1",
      turnId: "turn-1",
      startedAtMs: 1,
    }),
    { kind: "known_invalid", method: "item/started" },
  );
  const ping = classifyCodexNotification("future/ping", undefined);
  assert.equal(ping.kind, "unknown_valid");
  if (ping.kind !== "unknown_valid") assert.fail("expected unknown notification");
  assert.equal(ping.method, "future/ping");
  assert.deepEqual(ping.correlation, {});
  assert.match(ping.fingerprint, /^sha256:[0-9a-f]{64}$/);
  const futureItem = classifyCodexNotification("future/item", { threadId: "thread-1", nested: [true] });
  assert.equal(futureItem.kind, "unknown_valid");
  if (futureItem.kind !== "unknown_valid") assert.fail("expected unknown notification");
  assert.equal(futureItem.method, "future/item");
  assert.deepEqual(futureItem.correlation, { threadId: "thread-1" });

  const accessorParams = Object.defineProperty({}, "secret", {
    enumerable: true,
    get: () => "not-read",
  });
  assert.deepEqual(classifyCodexNotification("future/item", accessorParams), { kind: "unknown_invalid" });

  let descriptorReads = 0;
  const changingParams = new Proxy(
    {},
    {
      ownKeys: () => ["threadId"],
      getOwnPropertyDescriptor: () => {
        descriptorReads += 1;
        return {
          configurable: true,
          enumerable: true,
          value: descriptorReads === 1 ? "validated-thread" : "secret-thread",
          writable: true,
        };
      },
    },
  );
  const changing = classifyCodexNotification("future/changing", changingParams);
  assert.equal(changing.kind, "unknown_valid");
  if (changing.kind !== "unknown_valid") assert.fail("expected unknown notification");
  assert.equal(changing.method, "future/changing");
  assert.deepEqual(changing.correlation, { threadId: "validated-thread" });
  assert.equal(descriptorReads, 1);
});

test("known item schemas are exact even when their projection is unsupported", () => {
  assert.deepEqual(
    classifyCodexNotification("item/completed", {
      item: { type: "hookPrompt" },
      threadId: "thread-1",
      turnId: "turn-1",
      completedAtMs: 1,
    }),
    { kind: "known_invalid", method: "item/completed" },
  );
  assert.deepEqual(
    classifyCodexNotification("item/completed", {
      item: {
        type: "hookPrompt",
        id: "item-1",
        fragments: [{ text: "prompt", hookRunId: "hook-1" }],
      },
      threadId: "thread-1",
      turnId: "turn-1",
      completedAtMs: 1,
    }),
    {
      kind: "known",
      notification: {
        method: "item/completed",
        threadId: "thread-1",
        turnId: "turn-1",
        item: { classification: "unsupported", id: "item-1", itemType: "hookPrompt" },
        timestampMs: 1,
      },
    },
  );
  assert.deepEqual(
    classifyCodexNotification("item/completed", {
      item: agentMessageFixture({
        memoryCitation: { entries: [], threadIds: [], future: true },
      }),
      threadId: "thread-1",
      turnId: "turn-1",
      completedAtMs: 1,
    }),
    { kind: "known_invalid", method: "item/completed" },
  );

  const collab = {
    type: "collabAgentToolCall",
    id: "collab-1",
    tool: "spawnAgent",
    status: "inProgress",
    senderThreadId: "thread-1",
    receiverThreadIds: [],
    prompt: null,
    model: null,
    reasoningEffort: null,
    agentsStates: {},
  };
  assert.deepEqual(
    classifyCodexNotification("item/completed", {
      item: collab,
      threadId: "thread-1",
      turnId: "turn-1",
      completedAtMs: 1,
    }),
    { kind: "known_invalid", method: "item/completed" },
  );
  const started = classifyCodexNotification("item/started", {
    item: collab,
    threadId: "thread-1",
    turnId: "turn-1",
    startedAtMs: 1,
  });
  assert.equal(started.kind, "known");
  if (started.kind !== "known" || started.notification.method !== "item/started") {
    assert.fail("expected a known collab item start");
  }
  assert.deepEqual(started.notification.item, {
    classification: "unsupported",
    id: "collab-1",
    itemType: "collabAgentToolCall",
    lifecycleStatus: "inProgress",
  });
  assert.deepEqual(
    classifyCodexNotification("item/started", {
      item: { ...collab, reasoningEffort: "" },
      threadId: "thread-1",
      turnId: "turn-1",
      startedAtMs: 1,
    }),
    { kind: "known_invalid", method: "item/started" },
  );
});

test("unknown stable item variants still require a non-empty item ID", () => {
  assert.deepEqual(
    classifyCodexNotification("item/started", {
      item: { type: "futureItem", payload: { status: "inProgress" } },
      threadId: "thread-1",
      turnId: "turn-1",
      startedAtMs: 1,
    }),
    { kind: "known_invalid", method: "item/started" },
  );
  const withId = classifyCodexNotification("item/started", {
    item: { type: "futureItem", id: "future-1", payload: { status: "inProgress" } },
    threadId: "thread-1",
    turnId: "turn-1",
    startedAtMs: 1,
  });
  assert.equal(withId.kind, "known");
});

test("stable usage, warning, and error notifications are known and exact", () => {
  const providerBreakdown = {
    inputTokens: 10,
    cachedInputTokens: 2,
    outputTokens: 4,
    reasoningOutputTokens: 1,
    totalTokens: 14,
  };
  const breakdown = { ...providerBreakdown, cacheWriteInputTokens: 0 };
  assert.deepEqual(
    classifyCodexNotification("thread/tokenUsage/updated", {
      threadId: "thread-1",
      turnId: "turn-1",
      tokenUsage: {
        last: { ...providerBreakdown, cacheWriteInputTokens: 3 },
        total: { ...providerBreakdown },
      },
    }),
    {
      kind: "known",
      notification: {
        method: "thread/tokenUsage/updated",
        threadId: "thread-1",
        turnId: "turn-1",
        tokenUsage: {
          last: { ...breakdown, cacheWriteInputTokens: 3 },
          total: breakdown,
          modelContextWindow: null,
        },
      },
    },
  );
  assert.deepEqual(classifyCodexNotification("warning", { message: "bounded warning" }), {
    kind: "known",
    notification: { method: "warning", threadId: null, message: "bounded warning" },
  });
  assert.deepEqual(
    classifyCodexNotification("error", {
      error: { message: "provider detail" },
      threadId: "thread-1",
      turnId: "turn-1",
      willRetry: true,
    }),
    {
      kind: "known",
      notification: { method: "error", threadId: "thread-1", turnId: "turn-1", willRetry: true },
    },
  );
  assert.deepEqual(
    classifyCodexNotification("thread/tokenUsage/updated", {
      threadId: "thread-1",
      turnId: "turn-1",
      tokenUsage: { last: { ...providerBreakdown, totalTokens: -1 }, total: providerBreakdown },
    }),
    { kind: "known_invalid", method: "thread/tokenUsage/updated" },
  );
  assert.deepEqual(classifyCodexNotification("warning", { message: "warning", future: true }), {
    kind: "known_invalid",
    method: "warning",
  });
});

test("command execution exitCode follows nullable signed int32 boundaries", () => {
  for (const exitCode of [-1, -2_147_483_648, 2_147_483_647, null]) {
    const classified = classifyCodexNotification("item/completed", {
      item: commandExecutionFixture({ exitCode }),
      threadId: "thread-1",
      turnId: "turn-1",
      completedAtMs: 1,
    });
    assert.equal(classified.kind, "known", String(exitCode));
  }

  assert.deepEqual(
    classifyCodexNotification("item/completed", {
      item: commandExecutionFixture({ exitCode: 2_147_483_648 }),
      threadId: "thread-1",
      turnId: "turn-1",
      completedAtMs: 1,
    }),
    { kind: "known_invalid", method: "item/completed" },
  );
  assert.deepEqual(
    classifyCodexNotification("item/completed", {
      item: commandExecutionFixture({ exitCode: -2_147_483_649 }),
      threadId: "thread-1",
      turnId: "turn-1",
      completedAtMs: 1,
    }),
    { kind: "known_invalid", method: "item/completed" },
  );
});

test("unknown notification aggregate budget counts structure without strings", () => {
  const structuralOverflow = Array.from({ length: 2_048 }, () => Array<null>(1_024).fill(null));
  assert.deepEqual(classifyCodexNotification("future/large-structure", structuralOverflow), {
    kind: "unknown_invalid",
  });
});

test("status mapping preserves idle versus terminal semantics", () => {
  assert.equal(toAdapterThreadStatus({ type: "idle", activeFlags: [] }), "idle");
  assert.equal(toAdapterThreadStatus({ type: "active", activeFlags: ["waitingOnUserInput"] }), "active");
  assert.equal(toAdapterTurnStatus("completed"), "completed");
  assert.equal(toAdapterTurnStatus("interrupted"), "interrupted");
});

test("item and input text caps are enforced by UTF-8 byte length", () => {
  assert.deepEqual(
    snapshotStartTurnInput({
      threadId: "thread-1",
      contentBlocks: [{ type: "text", text: "あ".repeat(Math.ceil(CODEX_ADAPTER_LIMITS.maxItemTextBytes / 3) + 1) }],
    }),
    { ok: false },
  );
  assert.deepEqual(
    classifyCodexNotification("item/agentMessage/delta", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      delta: "x".repeat(CODEX_ADAPTER_LIMITS.maxItemTextBytes + 1),
    }),
    { kind: "known_invalid", method: "item/agentMessage/delta" },
  );
});

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

function commandExecutionFixture(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    type: "commandExecution",
    id: "command-1",
    command: "sanitized command",
    cwd: process.cwd(),
    processId: null,
    source: "agent",
    status: "completed",
    commandActions: [],
    aggregatedOutput: null,
    exitCode: 0,
    durationMs: 1,
    ...overrides,
  };
}
