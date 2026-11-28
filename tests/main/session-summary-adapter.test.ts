import assert from "node:assert/strict";
import test from "node:test";

import type {
  Session,
  SessionSummary,
} from "../../src-shared/session/session-state.js";
import {
  hydrateSessionsFromSummaries,
  sessionSummariesToSessions,
} from "../../src-electron/session/session-summary-adapter.js";

const summary = {
  id: "session-1",
  taskTitle: "Summary",
  status: "idle",
  updatedAt: "2026-04-28T00:00:00.000Z",
  isPinned: false,
  provider: "codex",
  catalogRevision: 1,
  workspaceLabel: "workspace",
  workspacePath: "C:/workspace",
  branch: "main",
  sessionKind: "default",
  accessMode: "active",
  sourceSchemaVersion: 5,
  characterId: "char-a",
  character: "A",
  characterIconPath: "",
  characterThemeColors: { main: "#111", sub: "#222" },
  runState: "idle",
  approvalMode: "on-request",
  codexSandboxMode: "workspace-write",
  codexSpeed: "standard",
  codexReviewer: "user",
  model: "gpt-5.4",
  reasoningEffort: "high",
  customAgentName: "",
  allowedAdditionalDirectories: [],
  threadId: "thread-1",
} satisfies SessionSummary;

/** 一覧表示用への変換ではIDを保ち、取得していない会話履歴を空配列で補う。 */
test("sessionSummariesToSessions は表示用に空 messages / stream を付ける", () => {
  assert.deepEqual(
    sessionSummariesToSessions([summary]).map((session) => ({
      id: session.id,
      messages: session.messages,
      stream: session.stream,
    })),
    [{ id: "session-1", messages: [], stream: [] }],
  );
});

// @test-value v2
// kind = "contract"
// claim = "summary一覧から取得できるfull detailだけを返し、全Sessionの一括取得には依存しない"
// oracle = { type = "contract", ref = "src-electron/session-summary-adapter.ts hydrateSessionsFromSummaries" }
// fault = "messagesとstreamをsummary用の空値へ置換する、取得不能なSessionを含める、またはlistSessionsを呼ぶ"
// observable = "返却Sessionのmessagesとstreamを含む全体、およびlistSessions呼び出し回数"
// observation_boundary = "public-boundary"
// scope = "hydrateSessionsFromSummaries"
// lifecycle = "permanent"
// @end-test-value
/** 詳細取得は既存の会話履歴を保ち、見つからないIDを除外し、一括取得に頼らない。 */
test("hydrateSessionsFromSummaries は summary shape ではなく full detail を返す", () => {
  const fullSession: Session = {
    ...summary,
    characterRuntimeSnapshot: null,
    messages: [{ role: "user", text: "keep history" }],
    stream: [
      { mood: "calm", time: "2026-04-28T00:00:00.000Z", text: "legacy stream" },
    ],
  };
  let listSessionsCallCount = 0;
  const source = {
    /** 詳細が存在する項目と、詳細を取得できない項目を一覧に混在させる。 */
    listSessionSummaries: () => [
      summary,
      { ...summary, id: "missing-session" },
    ],
    /** 保存済みのIDにだけ、メッセージを含む完全な詳細を返す。 */
    getSession: (sessionId: string) =>
      sessionId === fullSession.id ? fullSession : null,
    /** 詳細取得が全セッションの一括読取に退化していないかを計数する。 */
    listSessions: () => {
      listSessionsCallCount += 1;
      return [];
    },
  };

  const sessions = hydrateSessionsFromSummaries(source);

  assert.deepEqual(sessions, [fullSession]);
  assert.equal(listSessionsCallCount, 0);
});
