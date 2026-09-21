import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildNewSession } from "../../src-shared/session/session-state.js";
import type { AuditLogEntry, AuditLogSummary, LiveApprovalRequest, LiveElicitationRequest, LiveSessionRunState } from "../../src-shared/session/runtime-state.js";
import type { SessionBackgroundActivityState } from "../../src-shared/memory/session-memory-state.js";
import { DEFAULT_APPROVAL_MODE, normalizeApprovalMode } from "../../src-shared/settings/approval-mode.js";
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

type TestAuditLog = AuditLogSummary & Pick<AuditLogEntry, "logicalPrompt" | "transportPayload" | "assistantText" | "rawItemsJson">;

function makeAuditLog(partial: Partial<AuditLogEntry> & Pick<AuditLogEntry, "id" | "sessionId" | "phase">): TestAuditLog {
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
    assistantTextPreview: partial.assistantText ?? "",
    operations: partial.operations ?? [],
    rawItemsJson: partial.rawItemsJson ?? "[]",
    usage: partial.usage ?? null,
    errorMessage: partial.errorMessage ?? "",
    detailAvailable: true,
  };
}

function readAssistantText(entry: AuditLogSummary | undefined): string | undefined {
  if (!entry) {
    return undefined;
  }
  return "assistantText" in entry && typeof entry.assistantText === "string"
    ? entry.assistantText
    : entry.assistantTextPreview;
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
      approvalMode: "untrusted",
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
      approvalMode: "untrusted",
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
      approvalMode: "untrusted",
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

  // @test-value v2
  // kind = "contract"
  // claim = "同一sessionのrunning persisted rowはlive stateで置換される"
  // oracle = { type = "contract", ref = "src/audit-log-refresh.ts" }
  // fault = "古いpersisted progressやoperationsを表示し、live runの内容を失う"
  // observable = "先頭rowのphase、assistant text、threadId、operations、usage"
  // observation_boundary = "public-boundary"
  // scope = "audit-log-refresh.live-merge"
  // lifecycle = "permanent"
  // distinction = "refresh projectionの出力をfixtureのpersisted/live stateから直接比較する"
  // @end-test-value
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
    assert.equal(readAssistantText(result[0]), "新しい progress");
    assert.equal(result[0]?.threadId, "thread-live");
    assert.equal(result[0]?.operations.length, 2);
    assert.equal(result[0]?.operations[0]?.summary, "npm test");
    assert.equal(result[0]?.operations[1]?.type, "background-shell");
    assert.deepEqual(result[0]?.usage, { inputTokens: 20, cachedInputTokens: 0, outputTokens: 8 });
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "live stateは別sessionのpersisted running rowへmergeされない"
  // oracle = { type = "contract", ref = "src/audit-log-refresh.ts" }
  // fault = "selected sessionのlive progressを別session rowへ混入する"
  // observable = "各rowのsessionId、assistant text、detailAvailable"
  // observation_boundary = "public-boundary"
  // scope = "audit-log-refresh.session-isolation"
  // lifecycle = "permanent"
  // distinction = "同じrefresh出力に対象sessionと非対象sessionを並べて境界を確認する"
  // @end-test-value
  it("別 session の running persisted row には live state を merge しない", () => {
    const runningSession = {
      ...selectedSession,
      id: "aux-live",
      runState: "running" as const,
    };
    const persistedLogs = [
      {
        ...makeAuditLog({
          id: 20,
          sessionId: "session-parent",
          phase: "running",
          assistantText: "parent progress",
        }),
        detailAvailable: true,
      },
      makeAuditLog({
        id: 19,
        sessionId: "aux-old",
        phase: "completed",
        assistantText: "old aux",
      }),
    ];

    const result = buildDisplayedAuditLogs({
      selectedSession: runningSession,
      persistedEntries: persistedLogs,
      liveRun: makeLiveRun({
        sessionId: "aux-live",
        threadId: "thread-aux-live",
        assistantText: "aux live progress",
      }),
    });

    assert.equal(result[0]?.phase, "running");
    assert.equal(result[0]?.sessionId, "aux-live");
    assert.equal(readAssistantText(result[0]), "aux live progress");
    assert.equal(result[1]?.id, 20);
    assert.equal(result[1]?.sessionId, "session-parent");
    assert.equal(readAssistantText(result[1]), "parent progress");
    assert.equal(result[1]?.detailAvailable, false);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "複数sessionのrunning rowが混在してもlive runと同一sessionだけが更新される"
  // oracle = { type = "contract", ref = "src/audit-log-refresh.ts" }
  // fault = "rowの順序やrunning状態だけでmerge対象を選び、別sessionのprogressを上書きする"
  // observable = "各rowのid/sessionId/assistant text/threadId/operations"
  // observation_boundary = "public-boundary"
  // scope = "audit-log-refresh.session-isolation"
  // lifecycle = "permanent"
  // distinction = "複数sessionのprojection結果をrow単位で照合する"
  // @end-test-value
  it("複数 session の running row が混在しても live run と同じ sessionId の row だけ merge する", () => {
    const runningSession = {
      ...selectedSession,
      id: "aux-live",
      runState: "running" as const,
    };
    const persistedLogs = [
      makeAuditLog({
        id: 30,
        sessionId: "aux-other",
        phase: "running",
        assistantText: "other progress",
      }),
      makeAuditLog({
        id: 29,
        sessionId: "aux-live",
        phase: "running",
        assistantText: "old live progress",
      }),
    ];

    const result = buildDisplayedAuditLogs({
      selectedSession: runningSession,
      persistedEntries: persistedLogs,
      liveRun: makeLiveRun({
        sessionId: "aux-live",
        threadId: "thread-aux-live",
        assistantText: "new live progress",
        steps: [{ id: "step-1", type: "command_execution", summary: "npm test", status: "in_progress" }],
      }),
    });

    assert.equal(result[0]?.id, 30);
    assert.equal(result[0]?.sessionId, "aux-other");
    assert.equal(readAssistantText(result[0]), "other progress");
    assert.equal(result[1]?.id, 29);
    assert.equal(result[1]?.sessionId, "aux-live");
    assert.equal(readAssistantText(result[1]), "new live progress");
    assert.equal(result[1]?.threadId, "thread-aux-live");
    assert.equal(result[1]?.operations[0]?.summary, "npm test");
  });

  // @test-value v2
  // kind = "contract"
  // claim = "running persisted rowのoperationsへpending approval requestを投影する"
  // oracle = { type = "contract", ref = "src/audit-log-refresh.ts" }
  // fault = "pending approvalをoperationsから落とし、承認待ちをrunning logで確認できない"
  // observable = "operations length/type/summary/details"
  // observation_boundary = "public-boundary"
  // scope = "audit-log-refresh.pending-approval"
  // lifecycle = "permanent"
  // distinction = "live projectionのoperation artifactを公開結果で確認する"
  // @end-test-value
  it("running persisted row の operations に pending approval request を含める", () => {
    const runningSession = {
      ...selectedSession,
      runState: "running" as const,
    };
    const approvalRequest: LiveApprovalRequest = {
      requestId: "approval-1",
      provider: "codex",
      kind: "shell_command",
      title: "コマンド実行の承認",
      summary: "npm test を実行します。",
      details: "scripts/tests を対象に検証します。",
      warning: "書き込みはありません。",
      decisionMode: "direct-decision",
    };
    const persistedLogs = [
      makeAuditLog({
        id: 10,
        sessionId: selectedSession.id,
        phase: "running",
        assistantText: "承認待ち",
      }),
    ];

    const result = buildDisplayedAuditLogs({
      selectedSession: runningSession,
      persistedEntries: persistedLogs,
      liveRun: makeLiveRun({
        sessionId: selectedSession.id,
        approvalRequest,
      }),
    });

    assert.equal(result[0]?.operations.length, 1);
    assert.equal(result[0]?.operations[0]?.type, "approval_request");
    assert.equal(result[0]?.operations[0]?.summary, "コマンド実行の承認");
    assert.match(result[0]?.operations[0]?.details ?? "", /status:pending/);
    assert.match(result[0]?.operations[0]?.details ?? "", /kind:shell_command/);
  });

  it("live run で approval request が解消済みなら persisted running row の stale pending を引き継がない", () => {
    const runningSession = {
      ...selectedSession,
      runState: "running" as const,
    };
    const persistedLogs = [
      makeAuditLog({
        id: 10,
        sessionId: selectedSession.id,
        phase: "running",
        operations: [
          {
            type: "approval_request",
            summary: "古い承認待ち",
            details: "status:pending\nkind:shell_command",
          },
        ],
      }),
    ];

    const result = buildDisplayedAuditLogs({
      selectedSession: runningSession,
      persistedEntries: persistedLogs,
      liveRun: makeLiveRun({
        sessionId: selectedSession.id,
      }),
    });

    assert.deepEqual(result[0]?.operations, []);
  });

  it("live run で elicitation request が解消済みなら persisted running row の stale pending を引き継がない", () => {
    const runningSession = {
      ...selectedSession,
      runState: "running" as const,
    };
    const persistedLogs = [
      makeAuditLog({
        id: 10,
        sessionId: selectedSession.id,
        phase: "running",
        operations: [
          {
            type: "elicitation_request",
            summary: "古い入力待ち",
            details: "status:pending\nrequired:対象ブランチ",
          },
        ],
      }),
    ];

    const result = buildDisplayedAuditLogs({
      selectedSession: runningSession,
      persistedEntries: persistedLogs,
      liveRun: makeLiveRun({
        sessionId: selectedSession.id,
      }),
    });

    assert.deepEqual(result[0]?.operations, []);
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

  it("live run の sessionId が selected session と違う時は persisted をそのまま返す", () => {
    const runningSession = {
      ...selectedSession,
      runState: "running" as const,
    };
    const persistedLogs = [makeAuditLog({ id: 10, sessionId: selectedSession.id, phase: "completed" })];

    const result = buildDisplayedAuditLogs({
      selectedSession: runningSession,
      persistedEntries: persistedLogs,
      liveRun: makeLiveRun({
        sessionId: "other-session",
        assistantText: "別 session の progress",
      }),
    });

    assert.deepEqual(result, persistedLogs);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "running sessionの先頭がterminal rowなら新runのsynthetic running rowを先頭へ挿入する"
  // oracle = { type = "contract", ref = "src/audit-log-refresh.ts" }
  // fault = "新runを過去のterminal rowへ上書きする、またはrunning rowを先頭へ出さない"
  // observable = "result length、先頭rowのphase/text/threadId/detailAvailable、既存rowのid/phase"
  // observation_boundary = "public-boundary"
  // scope = "audit-log-refresh.synthetic-running"
  // lifecycle = "permanent"
  // distinction = "persisted historyを保持しつつsynthetic projectionを確認する"
  // @end-test-value
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
    assert.equal(readAssistantText(result[0]), "新しい run の progress");
    assert.equal(result[0]?.threadId, "thread-new-run");
    assert.equal(result[0]?.detailAvailable, false);
    assert.equal(result[1]?.id, 10);
    assert.equal(result[1]?.phase, "completed");
  });

  // @test-value v2
  // kind = "contract"
  // claim = "running persisted rowがない場合はselected session情報を持つsynthetic rowを先頭へ挿入する"
  // oracle = { type = "contract", ref = "src/audit-log-refresh.ts" }
  // fault = "live running状態を表示せず、provider/model/thread/operationを欠落させる"
  // observable = "result先頭rowのid/phase/sessionId/text/provider/model/threadId/operation"
  // observation_boundary = "public-boundary"
  // scope = "audit-log-refresh.synthetic-running"
  // lifecycle = "permanent"
  // distinction = "persisted historyが空でもrefresh projectionが公開するrunning rowを照合する"
  // @end-test-value
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
    assert.equal(result[0]?.id, 9);
    assert.equal(result[0]?.phase, "running");
    assert.equal(result[0]?.sessionId, selectedSession.id);
    assert.equal(readAssistantText(result[0]), "処理中...");
    assert.equal(result[0]?.provider, selectedSession.provider);
    assert.equal(result[0]?.model, selectedSession.model);
    assert.equal(result[0]?.threadId, "thread-synthetic");
    assert.equal(result[0]?.operations[0]?.summary, "src/App.tsx を更新");
  });

  it("synthetic running row の operations に pending elicitation request を含める", () => {
    const runningSession = {
      ...selectedSession,
      runState: "running" as const,
    };
    const elicitationRequest: LiveElicitationRequest = {
      requestId: "elicitation-1",
      provider: "codex",
      mode: "form",
      message: "対象ブランチを選んでね。",
      source: "copilot",
      fields: [
        {
          name: "branch",
          title: "対象ブランチ",
          required: true,
          type: "select",
          options: [
            { value: "main", label: "main" },
            { value: "feature", label: "feature" },
          ],
        },
      ],
    };
    const persistedLogs = [makeAuditLog({ id: 10, sessionId: selectedSession.id, phase: "completed" })];

    const result = buildDisplayedAuditLogs({
      selectedSession: runningSession,
      persistedEntries: persistedLogs,
      liveRun: makeLiveRun({
        sessionId: selectedSession.id,
        elicitationRequest,
      }),
    });

    assert.equal(result[0]?.phase, "running");
    assert.equal(result[0]?.operations.length, 1);
    assert.equal(result[0]?.operations[0]?.type, "elicitation_request");
    assert.equal(result[0]?.operations[0]?.summary, "対象ブランチを選んでね。");
    assert.match(result[0]?.operations[0]?.details ?? "", /required:対象ブランチ/);
  });

  // @test-value v2
  // kind = "security"
  // claim = "synthetic running rowは前回runのprompt・transport payload・raw itemsを再利用しない"
  // oracle = { type = "contract", ref = "src/audit-log-refresh.ts" }
  // fault = "前回runの入力やprovider payloadを新runのprojectionへ混入する"
  // observable = "synthetic rowのlogicalPrompt/transportPayload/rawItemsJson"
  // observation_boundary = "public-boundary"
  // scope = "audit-log-refresh.synthetic-running"
  // lifecycle = "permanent"
  // impact = "過去runの入力情報を新run表示へ漏えいさせない"
  // distinction = "projection outputのsensitive/raw fieldsを明示的に確認する"
  // @end-test-value
  it("synthetic running row は前回 run の prompt / payload / raw items を引き継がない", () => {
    const runningSession = {
      ...selectedSession,
      runState: "running" as const,
    };
    const persistedLogs = [
      makeAuditLog({
        id: 10,
        sessionId: selectedSession.id,
        phase: "completed",
        logicalPrompt: {
          systemText: "前回 system",
          inputText: "前回 input",
          composedText: "前回 composed",
        },
        transportPayload: {
          summary: "前回 payload",
          fields: [{ label: "path", value: "src/old.ts" }],
        },
        rawItemsJson: "[{\"kind\":\"previous\"}]",
      }),
    ];

    const result = buildDisplayedAuditLogs({
      selectedSession: runningSession,
      persistedEntries: persistedLogs,
      liveRun: makeLiveRun({
        sessionId: selectedSession.id,
        assistantText: "新しい run の progress",
      }),
    });

    const syntheticEntry = result[0];
    assert.ok(syntheticEntry && "logicalPrompt" in syntheticEntry);
    assert.deepEqual(syntheticEntry.logicalPrompt, {
      systemText: "",
      inputText: "",
      composedText: "",
    });
    assert.ok("transportPayload" in syntheticEntry);
    assert.equal(syntheticEntry.transportPayload, null);
    assert.ok("rawItemsJson" in syntheticEntry);
    assert.equal(syntheticEntry.rawItemsJson, "[]");
  });
});

