import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMessageListProjection,
  loadProjectedMessageArtifact,
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
    runState: "idle",
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
