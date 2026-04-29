import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import { resolveModelSelection, type ModelCatalogProvider } from "../../src/model-catalog.js";
import {
  applyCopilotCustomAgentSelection,
  applySessionModelMetadataUpdate,
  buildNewSession,
  buildSessionSummarySignature,
  selectHydrationTarget,
  type SessionSummary,
} from "../../src/session-state.js";

const COPILOT_PROVIDER_CATALOG: ModelCatalogProvider = {
  id: "copilot",
  label: "GitHub Copilot",
  defaultModelId: "gpt-4.1",
  defaultReasoningEffort: "high",
  models: [
    {
      id: "gpt-4.1",
      label: "GPT-4.1",
      reasoningEfforts: ["low", "medium", "high"],
    },
    {
      id: "gpt-4.1-mini",
      label: "GPT-4.1 mini",
      reasoningEfforts: ["low", "medium"],
    },
  ],
};

const CODEX_PROVIDER_CATALOG: ModelCatalogProvider = {
  id: "codex",
  label: "OpenAI Codex",
  defaultModelId: "gpt-5.4",
  defaultReasoningEffort: "high",
  models: [
    {
      id: "gpt-5.4",
      label: "GPT-5.4",
      reasoningEfforts: ["medium", "high", "xhigh"],
    },
    {
      id: "gpt-5.4-mini",
      label: "GPT-5.4 mini",
      reasoningEfforts: ["low", "medium", "high"],
    },
  ],
};

function createSession(provider: string) {
  return buildNewSession({
    provider,
    taskTitle: `${provider} session`,
    workspaceLabel: "workspace",
    workspacePath: "F:/repo",
    branch: "main",
    characterId: "char-a",
    character: "A",
    characterIconPath: "",
    characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
    approvalMode: DEFAULT_APPROVAL_MODE,
    model: provider === "copilot" ? "gpt-4.1" : "gpt-5.4",
    reasoningEffort: "high",
  });
}

describe("session-state custom agent selection", () => {
  it("Copilot custom agent 切り替え時は threadId を維持する", () => {
    const session = {
      ...buildNewSession({
        provider: "copilot",
        taskTitle: "copilot",
        workspaceLabel: "workspace",
        workspacePath: "F:/repo",
        branch: "main",
        characterId: "char-a",
        character: "A",
        characterIconPath: "",
        characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
        approvalMode: DEFAULT_APPROVAL_MODE,
        customAgentName: "reviewer",
      }),
      threadId: "thread-keep",
    };

    const next = applyCopilotCustomAgentSelection(session, "planner", "2026-03-29 12:00");

    assert.equal(next.customAgentName, "planner");
    assert.equal(next.threadId, "thread-keep");
    assert.equal(next.updatedAt, "2026-03-29 12:00");
  });
});

describe("session-state model selection", () => {
  it("Copilot session の model 更新時は threadId を維持して正規化後の設定を保存する", () => {
    const session = {
      ...createSession("copilot"),
      threadId: "thread-keep",
    };
    const selection = resolveModelSelection(COPILOT_PROVIDER_CATALOG, "gpt-4.1-mini", "medium");

    const next = applySessionModelMetadataUpdate(session, selection, 7, "2026-03-29 12:30");

    assert.equal(next.threadId, "thread-keep");
    assert.equal(next.model, "gpt-4.1-mini");
    assert.equal(next.reasoningEffort, "medium");
    assert.equal(next.catalogRevision, 7);
    assert.equal(next.updatedAt, "2026-03-29 12:30");
  });

  it("Copilot session の reasoning 更新時も threadId を維持する", () => {
    const session = {
      ...createSession("copilot"),
      threadId: "thread-keep",
    };
    const selection = resolveModelSelection(COPILOT_PROVIDER_CATALOG, session.model, "low");

    const next = applySessionModelMetadataUpdate(session, selection, 8, "2026-03-29 12:45");

    assert.equal(next.threadId, "thread-keep");
    assert.equal(next.model, "gpt-4.1");
    assert.equal(next.reasoningEffort, "low");
    assert.equal(next.catalogRevision, 8);
    assert.equal(next.updatedAt, "2026-03-29 12:45");
  });

  it("Codex session の model 更新時も threadId を維持する", () => {
    const session = {
      ...createSession("codex"),
      threadId: "thread-keep",
    };
    const selection = resolveModelSelection(CODEX_PROVIDER_CATALOG, "gpt-5.4-mini", "low");

    const next = applySessionModelMetadataUpdate(session, selection, 9, "2026-03-29 13:00");

    assert.equal(next.threadId, "thread-keep");
    assert.equal(next.model, "gpt-5.4-mini");
    assert.equal(next.reasoningEffort, "low");
    assert.equal(next.catalogRevision, 9);
    assert.equal(next.updatedAt, "2026-03-29 13:00");
  });

  it("対象外 provider の session でも threadId を維持する", () => {
    const session = {
      ...createSession("other-provider"),
      threadId: "thread-reset",
    };
    const selection = resolveModelSelection(CODEX_PROVIDER_CATALOG, "gpt-5.4", "medium");

    const next = applySessionModelMetadataUpdate(session, selection, 10, "2026-03-29 13:15");

    assert.equal(next.threadId, "thread-reset");
    assert.equal(next.model, "gpt-5.4");
    assert.equal(next.reasoningEffort, "medium");
    assert.equal(next.catalogRevision, 10);
    assert.equal(next.updatedAt, "2026-03-29 13:15");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildSessionSummarySignature / selectHydrationTarget
// ─────────────────────────────────────────────────────────────────────────────

function makeSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: "session-1",
    taskTitle: "task",
    taskSummary: "summary",
    status: "idle",
    updatedAt: "2026-04-15 12:00",
    provider: "codex",
    catalogRevision: 1,
    workspaceLabel: "workspace",
    workspacePath: "/repo",
    branch: "main",
    sessionKind: "default",
    characterId: "char-1",
    character: "A",
    characterIconPath: "",
    characterThemeColors: { main: "#000", sub: "#fff" },
    runState: "idle",
    approvalMode: DEFAULT_APPROVAL_MODE,
    model: "gpt-5.4",
    reasoningEffort: "high",
    customAgentName: "",
    allowedAdditionalDirectories: [],
    threadId: "",
    ...overrides,
  };
}

describe("buildSessionSummarySignature", () => {
  it("同一 summary は同じ signature を返す", () => {
    const s = makeSummary();
    assert.equal(buildSessionSummarySignature(s), buildSessionSummarySignature(s));
  });

  it("updatedAt が異なれば signature も異なる", () => {
    const a = makeSummary({ updatedAt: "2026-04-15 12:00" });
    const b = makeSummary({ updatedAt: "2026-04-15 12:01" });
    assert.notEqual(buildSessionSummarySignature(a), buildSessionSummarySignature(b));
  });

  it("status が異なれば signature も異なる", () => {
    const a = makeSummary({ status: "idle" });
    const b = makeSummary({ status: "saved" });
    assert.notEqual(buildSessionSummarySignature(a), buildSessionSummarySignature(b));
  });

  it("id が異なれば signature も異なる", () => {
    const a = makeSummary({ id: "session-1" });
    const b = makeSummary({ id: "session-2" });
    assert.notEqual(buildSessionSummarySignature(a), buildSessionSummarySignature(b));
  });

  it("characterThemeColors が異なれば signature も異なる", () => {
    const a = makeSummary({ characterThemeColors: { main: "#000", sub: "#fff" } });
    const b = makeSummary({ characterThemeColors: { main: "#111", sub: "#fff" } });
    assert.notEqual(buildSessionSummarySignature(a), buildSessionSummarySignature(b));
  });
});

describe("selectHydrationTarget — hydration 判定", () => {
  it("初回（lastSummarySignature=null）は必ず hydrate target を返す（完了条件 1）", () => {
    const s = makeSummary({ id: "session-1" });
    const result = selectHydrationTarget([s], "session-1", null);
    assert.ok(result !== null, "初回 hydrate は target を返すべき");
    assert.equal(result.sessionId, "session-1");
  });

  it("selected session の summary が変わっていない場合は null を返す（完了条件 2: unrelated update）", () => {
    const selected = makeSummary({ id: "session-1", updatedAt: "2026-04-15 12:00" });
    const other = makeSummary({ id: "session-2", updatedAt: "2026-04-15 12:01" });

    // selected session を一度 hydrate し signature を記録
    const firstTarget = selectHydrationTarget([selected, other], "session-1", null);
    assert.ok(firstTarget !== null);

    // other session だけが更新された次の subscription update
    const otherUpdated = { ...other, updatedAt: "2026-04-15 12:02" };
    const secondTarget = selectHydrationTarget(
      [selected, otherUpdated],
      "session-1",
      firstTarget.summarySignature,
    );

    assert.equal(secondTarget, null, "selected session が変わっていなければ null を返すべき");
  });

  it("selected session 自身の summary が変わった場合は hydrate target を返す（完了条件 3）", () => {
    const before = makeSummary({ id: "session-1", updatedAt: "2026-04-15 12:00", status: "running" });
    const firstTarget = selectHydrationTarget([before], "session-1", null);
    assert.ok(firstTarget !== null);

    const after = { ...before, updatedAt: "2026-04-15 12:05", status: "saved" as const };
    const secondTarget = selectHydrationTarget([after], "session-1", firstTarget.summarySignature);

    assert.ok(secondTarget !== null, "selected session の summary が変われば target を返すべき");
    assert.equal(secondTarget.sessionId, "session-1");
  });

  it("targetSessionId が null の場合は null を返す", () => {
    const s = makeSummary();
    assert.equal(selectHydrationTarget([s], null, null), null);
  });

  it("targetSessionId が一覧にない場合は null を返す", () => {
    const s = makeSummary({ id: "session-2" });
    assert.equal(selectHydrationTarget([s], "session-1", null), null);
  });
});
