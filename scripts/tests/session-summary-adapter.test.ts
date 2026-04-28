import assert from "node:assert/strict";
import test from "node:test";

import type { Session, SessionSummary } from "../../src/app-state.js";
import {
  hydrateSessionsFromSummaries,
  sessionSummariesToSessions,
} from "../../src-electron/session-summary-adapter.js";

const summary = {
  id: "session-1",
  taskTitle: "Summary",
  taskSummary: "",
  status: "idle",
  updatedAt: "2026-04-28T00:00:00.000Z",
  provider: "codex",
  catalogRevision: 1,
  workspaceLabel: "workspace",
  workspacePath: "C:/workspace",
  branch: "main",
  sessionKind: "default",
  characterId: "char-a",
  character: "A",
  characterIconPath: "",
  characterThemeColors: { main: "#111", sub: "#222" },
  runState: "idle",
  approvalMode: "on-request",
  codexSandboxMode: "workspace-write",
  model: "gpt-5.4",
  reasoningEffort: "high",
  customAgentName: "",
  allowedAdditionalDirectories: [],
  threadId: "thread-1",
} satisfies SessionSummary;

test("sessionSummariesToSessions は表示用に空 messages / stream を付ける", () => {
  assert.deepEqual(sessionSummariesToSessions([summary]).map((session) => ({
    id: session.id,
    messages: session.messages,
    stream: session.stream,
  })), [
    { id: "session-1", messages: [], stream: [] },
  ]);
});

test("hydrateSessionsFromSummaries は summary shape ではなく full detail を返す", () => {
  const fullSession: Session = {
    ...summary,
    messages: [{ role: "user", text: "keep history" }],
    stream: [{ mood: "calm", time: "2026-04-28T00:00:00.000Z", text: "legacy stream" }],
  };
  let listSessionsCallCount = 0;
  const source = {
    listSessionSummaries: () => [
      summary,
      { ...summary, id: "missing-session" },
    ],
    getSession: (sessionId: string) => sessionId === fullSession.id ? fullSession : null,
    listSessions: () => {
      listSessionsCallCount += 1;
      return [];
    },
  };

  const sessions = hydrateSessionsFromSummaries(source);

  assert.deepEqual(sessions, [fullSession]);
  assert.equal(listSessionsCallCount, 0);
});
