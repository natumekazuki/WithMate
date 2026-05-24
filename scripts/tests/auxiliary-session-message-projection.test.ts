import assert from "node:assert/strict";
import test from "node:test";

import { buildMessageListProjection } from "../../src/auxiliary-session-message-projection.js";
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
    createdAt: "2026-05-24T00:00:00.000Z",
    updatedAt: "2026-05-24T00:00:01.000Z",
    closedAt: "2026-05-24T00:00:01.000Z",
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
  assert.deepEqual(projection.boundaries, [
    null,
    { label: "Auxiliary", statusLabel: "Closed" },
    null,
  ]);
});

test("buildMessageListProjection は Auxiliary session ごとの境界を保持する", () => {
  const projection = buildMessageListProjection(
    [],
    [
      createAuxiliarySession([{ role: "user", text: "first aux prompt" }], {
        id: "aux-1",
        status: "closed",
      }),
      createAuxiliarySession([{ role: "user", text: "second aux prompt" }], {
        id: "aux-2",
        status: "active",
      }),
    ],
    "session-1",
  );

  assert.deepEqual(projection.keys, [
    "auxiliary-aux-1-0",
    "auxiliary-aux-2-0",
  ]);
  assert.deepEqual(projection.boundaries, [
    { label: "Auxiliary", statusLabel: "Closed" },
    { label: "Auxiliary", statusLabel: "Active" },
  ]);
});
