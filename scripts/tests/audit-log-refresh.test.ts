import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildNewSession,
  type AuditLogEntry,
  type LiveSessionRunState,
  type SessionBackgroundActivityState,
} from "../../src/app-state.js";
import { DEFAULT_APPROVAL_MODE, normalizeApprovalMode } from "../../src/approval-mode.js";
import { buildAuditLogRefreshSignature, buildDisplayedAuditLogs } from "../../src/audit-log-refresh.js";

function makeBackgroundActivity(
  partial: Partial<SessionBackgroundActivityState> & Pick<SessionBackgroundActivityState, "kind" | "status">,
): SessionBackgroundActivityState {
  return {
    sessionId: "session-1",
    kind: partial.kind,
    status: partial.status,
    title: "background",
    summary: "summary",
    details: partial.details,
    errorMessage: "",
    updatedAt: partial.updatedAt ?? "2026-04-02T12:00:00.000Z",
  };
}

function makeAuditLog(partial: Partial<AuditLogEntry> & Pick<AuditLogEntry, "id" | "sessionId" | "phase">): AuditLogEntry {
  return {
    id: partial.id,
    sessionId: partial.sessionId,
    createdAt: partial.createdAt ?? "2026-04-21T10:00:00.000Z",
    phase: partial.phase,
    provider: partial.provider ?? "codex",
    model: partial.model ?? "gpt-5.4",
    reasoningEffort: partial.reasoningEffort ?? "medium",
    approvalMode: normalizeApprovalMode(partial.approvalMode, DEFAULT_APPROVAL_MODE),
    threadId: partial.threadId ?? "",
    logicalPrompt: partial.logicalPrompt ?? { systemText: "", inputText: "", composedText: "" },
    transportPayload: partial.transportPayload ?? null,
    assistantText: partial.assistantText ?? "",
    operations: partial.operations ?? [],
    rawItemsJson: partial.rawItemsJson ?? "[]",
    usage: partial.usage ?? null,
    errorMessage: partial.errorMessage ?? "",
  };
}

function makeLiveRun(overrides?: Partial<LiveSessionRunState>): LiveSessionRunState {
  return {
    sessionId: overrides?.sessionId ?? "session-1",
    threadId: overrides?.threadId ?? "",
    assistantText: overrides?.assistantText ?? "",
    steps: overrides?.steps ?? [],
    backgroundTasks: overrides?.backgroundTasks ?? [],
    usage: overrides?.usage ?? null,
    errorMessage: overrides?.errorMessage ?? "",
    approvalRequest: overrides?.approvalRequest ?? null,
    elicitationRequest: overrides?.elicitationRequest ?? null,
  };
}

describe("audit-log-refresh", () => {
  it("session が無い時は固定 signature を返す", () => {
    assert.equal(
      buildAuditLogRefreshSignature({
        selectedSession: null,
        displayedMessagesLength: 0,
      }),
      "no-session",
    );
  });

  it("memory generation の更新を audit log 再読込条件へ含める", () => {
    const session = buildNewSession({
      taskTitle: "調査",
      workspaceLabel: "repo",
      workspacePath: "/repo",
      branch: "main",
      characterId: "character-1",
      character: "WithMate",
      characterIconPath: "",
      characterThemeColors: {
        main: "#000000",
        sub: "#ffffff",
      },
      approvalMode: "safety",
    });

    const runningSignature = buildAuditLogRefreshSignature({
      selectedSession: session,
      displayedMessagesLength: session.messages.length,
      selectedMemoryGenerationActivity: makeBackgroundActivity({
        kind: "memory-generation",
        status: "running",
      }),
    });
    const completedSignature = buildAuditLogRefreshSignature({
      selectedSession: session,
      displayedMessagesLength: session.messages.length,
      selectedMemoryGenerationActivity: makeBackgroundActivity({
        kind: "memory-generation",
        status: "completed",
        updatedAt: "2026-04-02T12:01:00.000Z",
      }),
    });

    assert.notEqual(runningSignature, completedSignature);
  });

  it("message 数や session 更新時刻が同じでも monologue 更新で signature が変わる", () => {
    const session = buildNewSession({
      taskTitle: "調査",
      workspaceLabel: "repo",
      workspacePath: "/repo",
      branch: "main",
      characterId: "character-1",
      character: "WithMate",
      characterIconPath: "",
      characterThemeColors: {
        main: "#000000",
        sub: "#ffffff",
      },
      approvalMode: "safety",
    });

    const before = buildAuditLogRefreshSignature({
      selectedSession: session,
      displayedMessagesLength: 3,
      selectedMonologueActivity: makeBackgroundActivity({
        kind: "monologue",
        status: "running",
      }),
    });
    const after = buildAuditLogRefreshSignature({
      selectedSession: session,
      displayedMessagesLength: 3,
      selectedMonologueActivity: makeBackgroundActivity({
        kind: "monologue",
        status: "completed",
        updatedAt: "2026-04-02T12:02:00.000Z",
      }),
    });

    assert.notEqual(before, after);
  });
});

describe("buildDisplayedAuditLogs", () => {
  const selectedSession = {
    ...buildNewSession({
      taskTitle: "表示確認",
      workspaceLabel: "repo",
      workspacePath: "/repo",
      branch: "main",
      characterId: "character-1",
      character: "WithMate",
      characterIconPath: "",
      characterThemeColors: {
        main: "#000000",
        sub: "#ffffff",
      },
      approvalMode: "safety",
    }),
    runState: "idle" as const, // デフォルトは idle
  };

  it("live run が無い時は persisted logs をそのまま返す", () => {
    const persistedLogs = [makeAuditLog({ id: 1, sessionId: "session-1", phase: "completed" })];

    const result = buildDisplayedAuditLogs({
      selectedSession,
      persistedEntries: persistedLogs,
      liveRun: null,
    });

    assert.deepEqual(result, persistedLogs);
  });

  it("running persisted row がある時は live state で置き換える", () => {
    const runningSession = {
      ...selectedSession,
      runState: "running" as const,
    };
    const persistedLogs = [
      makeAuditLog({
        id: 10,
        sessionId: selectedSession.id,
        phase: "running",
        assistantText: "旧 progress",
      }),
      makeAuditLog({ id: 9, sessionId: selectedSession.id, phase: "completed" }),
    ];
    const liveRun = makeLiveRun({
      sessionId: selectedSession.id,
      threadId: "thread-live",
      assistantText: "新しい progress",
      steps: [
        { id: "step-1", type: "command_execution", summary: "npm test", details: "実行中", status: "in_progress" },
      ],
      backgroundTasks: [
        {
          id: "task-1",
          kind: "shell",
          status: "running",
          title: "背景ジョブ",
          details: "継続中",
          updatedAt: "2026-04-21T10:01:00.000Z",
        },
      ],
      usage: { inputTokens: 20, cachedInputTokens: 0, outputTokens: 8 },
    });

    const result = buildDisplayedAuditLogs({
      selectedSession: runningSession,
      persistedEntries: persistedLogs,
      liveRun,
    });

    assert.equal(result[0]?.id, 10);
    assert.equal(result[0]?.phase, "running");
    assert.equal(result[0]?.assistantText, "新しい progress");
    assert.equal(result[0]?.threadId, "thread-live");
    assert.equal(result[0]?.operations.length, 2);
    assert.equal(result[0]?.operations[0]?.summary, "npm test");
    assert.equal(result[0]?.operations[1]?.type, "background-shell");
    assert.deepEqual(result[0]?.usage, { inputTokens: 20, cachedInputTokens: 0, outputTokens: 8 });
  });

  it("session.runState が running でない時は live run があっても persisted をそのまま返す (stale live state 抑止)", () => {
    const idleSession = {
      ...selectedSession,
      runState: "idle" as const,
    };
    const persistedLogs = [makeAuditLog({ id: 10, sessionId: selectedSession.id, phase: "completed" })];

    const result = buildDisplayedAuditLogs({
      selectedSession: idleSession,
      persistedEntries: persistedLogs,
      liveRun: makeLiveRun({
        sessionId: selectedSession.id,
        assistantText: "stale な遅延 progress",
      }),
    });

    // session が idle なら live run があっても無視
    assert.deepEqual(result, persistedLogs);
  });

  it("session.runState が running で、先頭が terminal persisted の時は synthetic running row を先頭へ挿入する (新 run 対応)", () => {
    const runningSession = {
      ...selectedSession,
      runState: "running" as const,
    };
    const persistedLogs = [makeAuditLog({ id: 10, sessionId: selectedSession.id, phase: "completed" })];
    const liveRun = makeLiveRun({
      sessionId: selectedSession.id,
      threadId: "thread-new-run",
      assistantText: "新しい run の progress",
      steps: [{ id: "step-1", type: "command_execution", summary: "新 run のステップ", status: "in_progress" }],
    });

    const result = buildDisplayedAuditLogs({
      selectedSession: runningSession,
      persistedEntries: persistedLogs,
      liveRun,
    });

    assert.equal(result.length, 2);
    assert.equal(result[0]?.phase, "running");
    assert.equal(result[0]?.assistantText, "新しい run の progress");
    assert.equal(result[0]?.threadId, "thread-new-run");
    assert.equal(result[1]?.id, 10);
    assert.equal(result[1]?.phase, "completed");
  });

  it("running persisted row が無い時は synthetic running row を先頭へ挿入する", () => {
    const runningSession = {
      ...selectedSession,
      runState: "running" as const,
    };
    const persistedLogs = [makeAuditLog({ id: 10, sessionId: selectedSession.id, phase: "started" })];
    const liveRun = makeLiveRun({
      sessionId: selectedSession.id,
      threadId: "thread-synthetic",
      assistantText: "処理中...",
      steps: [{ id: "step-1", type: "file_edit", summary: "src/App.tsx を更新", status: "completed" }],
      usage: { inputTokens: 30, cachedInputTokens: 1, outputTokens: 15 },
    });

    const result = buildDisplayedAuditLogs({
      selectedSession: runningSession,
      persistedEntries: persistedLogs,
      liveRun,
    });

    assert.equal(result.length, 2);
    assert.equal(result[0]?.phase, "running");
    assert.equal(result[0]?.sessionId, selectedSession.id);
    assert.equal(result[0]?.assistantText, "処理中...");
    assert.equal(result[0]?.provider, selectedSession.provider);
    assert.equal(result[0]?.model, selectedSession.model);
    assert.equal(result[0]?.threadId, "thread-synthetic");
    assert.equal(result[0]?.operations[0]?.summary, "src/App.tsx を更新");
  });
});
