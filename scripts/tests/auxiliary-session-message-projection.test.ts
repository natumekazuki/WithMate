import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMessageListProjection,
  hasPersistedLiveAssistantMessage,
  loadProjectedMessageArtifact,
  resolveLiveAssistantMessageIndex,
  resolvePendingAuxiliaryMessageGroupId,
  shouldProjectLiveAssistantBridge,
} from "../../src/auxiliary-session-message-projection.js";
import type { AuxiliarySession } from "../../src/auxiliary-session-state.js";
import type { Message, MessageArtifact } from "../../src/session-state.js";

function createAuxiliarySession(
  messages: Message[],
  overrides: Partial<AuxiliarySession> = {},
): AuxiliarySession {
  return {
    id: overrides.id ?? "aux-1",
    parentSessionId: "session-1",
    status: overrides.status ?? "closed",
    runState: overrides.runState ?? "idle",
    title: "Auxiliary",
    provider: "codex",
    catalogRevision: 1,
    model: "gpt-5.2",
    reasoningEffort: "medium",
    approvalMode: "untrusted",
    codexSandboxMode: "workspace-write",
    customAgentName: "",
    allowedAdditionalDirectories: [],
    threadId: "thread-1",
    composerDraft: "",
    messages,
    displayAfterMessageIndex: overrides.displayAfterMessageIndex ?? 0,
    createdAt: overrides.createdAt ?? "2026-05-24T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-05-24T00:00:01.000Z",
    closedAt: overrides.closedAt ?? "2026-05-24T00:00:01.000Z",
  };
}

function createArtifact(): MessageArtifact {
  return {
    title: "Run result",
    activitySummary: ["updated files"],
    operationTimeline: [],
    changedFiles: [
      {
        kind: "edit",
        path: "src/App.tsx",
        summary: "updated src/App.tsx",
        diffRows: [],
      },
    ],
    runChecks: [],
    detailAvailable: true,
  };
}

test("buildMessageListProjection は Auxiliary transcript を message 単位で保持する", () => {
  const artifact = createArtifact();
  const projection = buildMessageListProjection(
    [{ role: "assistant", text: "parent response" }],
    [
      createAuxiliarySession([
        { role: "user", text: "aux prompt" },
        { role: "assistant", text: "aux response", artifact },
      ]),
    ],
    "session-1",
  );

  assert.deepEqual(
    projection.messages.map((message) => ({
      role: message.role,
      text: message.text,
      accent: message.accent ?? false,
      artifactTitle: message.artifact?.title ?? "",
    })),
    [
      { role: "assistant", text: "parent response", accent: false, artifactTitle: "" },
      { role: "user", text: "aux prompt", accent: true, artifactTitle: "" },
      { role: "assistant", text: "aux response", accent: true, artifactTitle: "Run result" },
    ],
  );
  assert.deepEqual(projection.sources, [
    { kind: "session", messageIndex: 0 },
    { kind: "auxiliary", sessionId: "aux-1", messageIndex: 0, artifact: undefined },
    { kind: "auxiliary", sessionId: "aux-1", messageIndex: 1, artifact },
  ]);
  assert.deepEqual(projection.keys, [
    "session-session-1-0",
    "auxiliary-aux-1-0",
    "auxiliary-aux-1-1",
  ]);
  assert.deepEqual(projection.groups, [
    null,
    { id: "aux-1", label: "Auxiliary" },
    { id: "aux-1", label: "Auxiliary" },
  ]);
});

test("buildMessageListProjection は Auxiliary session ごとの group を保持する", () => {
  const projection = buildMessageListProjection(
    [],
    [
      createAuxiliarySession([{ role: "user", text: "first aux prompt" }], {
        id: "aux-1",
        status: "closed",
        createdAt: "2026-05-24T00:00:00.000Z",
      }),
      createAuxiliarySession([{ role: "user", text: "second aux prompt" }], {
        id: "aux-2",
        status: "active",
        createdAt: "2026-05-24T00:00:01.000Z",
      }),
    ],
    "session-1",
  );

  assert.deepEqual(projection.keys, [
    "auxiliary-aux-1-0",
    "auxiliary-aux-2-0",
  ]);
  assert.deepEqual(projection.groups, [
    { id: "aux-1", label: "Auxiliary" },
    { id: "aux-2", label: "Auxiliary" },
  ]);
});

test("resolvePendingAuxiliaryMessageGroupId は実行中 Auxiliary だけ group id を返す", () => {
  assert.equal(resolvePendingAuxiliaryMessageGroupId(null), null);
  assert.equal(resolvePendingAuxiliaryMessageGroupId(undefined), null);
  assert.equal(resolvePendingAuxiliaryMessageGroupId(createAuxiliarySession([], { runState: "idle" })), null);
  assert.equal(resolvePendingAuxiliaryMessageGroupId(createAuxiliarySession([], { runState: "error" })), null);
  assert.equal(
    resolvePendingAuxiliaryMessageGroupId(createAuxiliarySession([], { id: "aux-running", runState: "running" })),
    "aux-running",
  );
});

test("buildMessageListProjection は Auxiliary を parent message の保存位置へ差し込む", () => {
  const projection = buildMessageListProjection(
    [
      { role: "user", text: "main prompt 1" },
      { role: "assistant", text: "main response 1" },
      { role: "user", text: "main prompt 2" },
      { role: "assistant", text: "main response 2" },
    ],
    [
      createAuxiliarySession([{ role: "user", text: "aux prompt 2" }], {
        id: "aux-2",
        displayAfterMessageIndex: 3,
        createdAt: "2026-05-24T00:00:02.000Z",
      }),
      createAuxiliarySession([
        { role: "user", text: "aux prompt 1" },
        { role: "assistant", text: "aux response 1" },
      ], {
        id: "aux-1",
        displayAfterMessageIndex: 1,
        createdAt: "2026-05-24T00:00:01.000Z",
      }),
    ],
    "session-1",
  );

  assert.deepEqual(
    projection.messages.map((message) => message.text),
    [
      "main prompt 1",
      "main response 1",
      "aux prompt 1",
      "aux response 1",
      "main prompt 2",
      "main response 2",
      "aux prompt 2",
    ],
  );
});

test("buildMessageListProjection は live assistant を transient message として末尾に追加する", () => {
  const projection = buildMessageListProjection(
    [{ role: "user", text: "main prompt" }],
    [],
    "session-1",
    {
      liveAssistant: {
        sessionId: "session-1",
        threadId: "thread-1",
        messageIndex: 1,
        text: "streaming response",
      },
    },
  );

  assert.deepEqual(
    projection.messages.map((message) => `${message.role}:${message.text}`),
    ["user:main prompt", "assistant:streaming response"],
  );
  assert.deepEqual(projection.sources[1], {
    kind: "live-assistant",
    sessionId: "session-1",
    threadId: "thread-1",
  });
  assert.equal(projection.keys[1], "live-assistant-session-1-1-thread-1");
});

test("buildMessageListProjection は persisted assistant と live assistant を index で照合して key を引き継ぐ", () => {
  const projection = buildMessageListProjection(
    [
      { role: "user", text: "main prompt" },
      { role: "assistant", text: "final response" },
    ],
    [],
    "session-1",
    {
      liveAssistant: {
        sessionId: "session-1",
        threadId: "thread-1",
        messageIndex: 1,
        text: "streaming response",
      },
    },
  );

  assert.deepEqual(
    projection.messages.map((message) => `${message.role}:${message.text}`),
    ["user:main prompt", "assistant:final response"],
  );
  assert.deepEqual(projection.sources, [
    { kind: "session", messageIndex: 0 },
    { kind: "session", messageIndex: 1 },
  ]);
  assert.equal(projection.keys[1], "live-assistant-session-1-1-thread-1");
});

test("buildMessageListProjection は live text が既存末尾 assistant と同じでも新規 live row を追加する", () => {
  const projection = buildMessageListProjection(
    [
      { role: "assistant", text: "same response" },
      { role: "user", text: "next prompt" },
    ],
    [],
    "session-1",
    {
      liveAssistant: {
        sessionId: "session-1",
        threadId: "thread-2",
        messageIndex: 2,
        text: "same response",
      },
    },
  );

  assert.deepEqual(
    projection.messages.map((message) => `${message.role}:${message.text}`),
    ["assistant:same response", "user:next prompt", "assistant:same response"],
  );
  assert.deepEqual(projection.sources[2], {
    kind: "live-assistant",
    sessionId: "session-1",
    threadId: "thread-2",
  });
  assert.equal(projection.keys[2], "live-assistant-session-1-2-thread-2");
});

test("hasPersistedLiveAssistantMessage は final text が live text と違っても target index の assistant で完了扱いにする", () => {
  assert.equal(
    hasPersistedLiveAssistantMessage(
      [
        { role: "user", text: "main prompt" },
        { role: "assistant", text: "完了したよ。" },
      ],
      [],
      {
        sessionId: "session-1",
        threadId: "thread-1",
        messageIndex: 1,
        text: "処理中... テスト完了",
      },
      "session-1",
    ),
    true,
  );
});

test("hasPersistedLiveAssistantMessage は partial fallback notice 付き final も target index で完了扱いにする", () => {
  assert.equal(
    hasPersistedLiveAssistantMessage(
      [
        { role: "user", text: "main prompt" },
        { role: "assistant", text: "partial response\n\n実行に失敗しました。" },
      ],
      [],
      {
        sessionId: "session-1",
        threadId: "thread-1",
        messageIndex: 1,
        text: "partial response",
      },
      "session-1",
    ),
    true,
  );
});

test("buildMessageListProjection は Auxiliary live assistant を対象 group 内に追加する", () => {
  const projection = buildMessageListProjection(
    [
      { role: "assistant", text: "main response" },
      { role: "assistant", text: "later main response" },
    ],
    [
      createAuxiliarySession([{ role: "user", text: "aux prompt" }], {
        id: "aux-1",
        displayAfterMessageIndex: 0,
      }),
    ],
    "session-1",
    {
      liveAssistant: {
        sessionId: "aux-1",
        threadId: "aux-thread-1",
        messageIndex: 1,
        text: "aux streaming response",
      },
    },
  );

  assert.deepEqual(
    projection.messages.map((message) => message.text),
    ["main response", "aux prompt", "aux streaming response", "later main response"],
  );
  assert.deepEqual(projection.groups, [
    null,
    { id: "aux-1", label: "Auxiliary" },
    { id: "aux-1", label: "Auxiliary" },
    null,
  ]);
  assert.equal(projection.keys[2], "live-assistant-aux-1-1-aux-thread-1");
});

test("resolveLiveAssistantMessageIndex は target session の次 assistant index を返す", () => {
  const auxiliarySession = createAuxiliarySession([{ role: "user", text: "aux prompt" }], {
    id: "aux-1",
  });

  assert.equal(
    resolveLiveAssistantMessageIndex(
      [{ role: "user", text: "main prompt" }],
      [auxiliarySession],
      "session-1",
      "session-1",
    ),
    1,
  );
  assert.equal(
    resolveLiveAssistantMessageIndex(
      [{ role: "user", text: "main prompt" }],
      [auxiliarySession],
      "aux-1",
      "session-1",
    ),
    1,
  );
});

test("shouldProjectLiveAssistantBridge は live run が消えて persisted assistant もなければ bridge を投影しない", () => {
  assert.equal(
    shouldProjectLiveAssistantBridge({
      bridge: {
        sessionId: "session-1",
        threadId: "thread-1",
        messageIndex: 1,
        text: "stale streaming response",
      },
      activeSessionId: "session-1",
      hasLiveRun: false,
      hasPersistedAssistant: false,
    }),
    false,
  );
});

test("shouldProjectLiveAssistantBridge は live run 中または persisted assistant 検知後だけ bridge を投影する", () => {
  const bridge = {
    sessionId: "session-1",
    threadId: "thread-1",
    messageIndex: 1,
    text: "streaming response",
  };

  assert.equal(
    shouldProjectLiveAssistantBridge({
      bridge,
      activeSessionId: "session-1",
      hasLiveRun: true,
      hasPersistedAssistant: false,
    }),
    true,
  );
  assert.equal(
    shouldProjectLiveAssistantBridge({
      bridge,
      activeSessionId: "session-1",
      hasLiveRun: false,
      hasPersistedAssistant: true,
    }),
    true,
  );
  assert.equal(
    shouldProjectLiveAssistantBridge({
      bridge,
      activeSessionId: "session-2",
      hasLiveRun: true,
      hasPersistedAssistant: true,
    }),
    false,
  );
});

test("loadProjectedMessageArtifact は parent source の artifact detail loader を呼ぶ", async () => {
  const artifact = createArtifact();
  const loaded = await loadProjectedMessageArtifact({
    source: { kind: "session", messageIndex: 2 },
    loadSessionArtifact: (messageIndex) => {
      assert.equal(messageIndex, 2);
      return Promise.resolve(artifact);
    },
  });

  assert.equal(loaded, artifact);
});

test("loadProjectedMessageArtifact は projected index ではなく source messageIndex で parent artifact を読む", async () => {
  const artifact = createArtifact();
  const projection = buildMessageListProjection(
    [
      { role: "assistant", text: "parent response 1" },
      { role: "assistant", text: "parent response 2" },
    ],
    [createAuxiliarySession([{ role: "assistant", text: "aux response" }], { displayAfterMessageIndex: 0 })],
    "session-1",
  );
  const loaded = await loadProjectedMessageArtifact({
    source: projection.sources[2],
    loadSessionArtifact: (messageIndex) => {
      assert.equal(messageIndex, 1);
      return artifact;
    },
  });

  assert.deepEqual(
    projection.messages.map((message) => message.text),
    ["parent response 1", "aux response", "parent response 2"],
  );
  assert.equal(loaded, artifact);
});

test("loadProjectedMessageArtifact は Auxiliary source の artifact を直接返す", async () => {
  const artifact = createArtifact();
  const loaded = await loadProjectedMessageArtifact({
    source: { kind: "auxiliary", sessionId: "aux-1", messageIndex: 1, artifact },
    loadSessionArtifact: () => {
      throw new Error("parent artifact loader should not run for auxiliary source");
    },
  });

  assert.equal(loaded, artifact);
});

test("loadProjectedMessageArtifact は source 不明または artifact なしなら null を返す", async () => {
  const missingSource = await loadProjectedMessageArtifact({
    source: undefined,
    loadSessionArtifact: () => createArtifact(),
  });
  const missingArtifact = await loadProjectedMessageArtifact({
    source: { kind: "auxiliary", sessionId: "aux-1", messageIndex: 1, artifact: undefined },
    loadSessionArtifact: () => createArtifact(),
  });
  const parentMissingArtifact = await loadProjectedMessageArtifact({
    source: { kind: "session", messageIndex: 1 },
    loadSessionArtifact: () => undefined,
  });

  assert.equal(missingSource, null);
  assert.equal(missingArtifact, null);
  assert.equal(parentMissingArtifact, null);
});
