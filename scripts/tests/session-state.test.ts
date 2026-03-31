import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import { resolveModelSelection, type ModelCatalogProvider } from "../../src/model-catalog.js";
import {
  applyCopilotCustomAgentSelection,
  applySessionModelMetadataUpdate,
  buildNewSession,
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
  it("Copilot session の model 更新時は threadId を reset して正規化後の設定を保存する", () => {
    const session = {
      ...createSession("copilot"),
      threadId: "thread-keep",
    };
    const selection = resolveModelSelection(COPILOT_PROVIDER_CATALOG, "gpt-4.1-mini", "medium");

    const next = applySessionModelMetadataUpdate(session, selection, 7, "2026-03-29 12:30");

    assert.equal(next.threadId, "");
    assert.equal(next.model, "gpt-4.1-mini");
    assert.equal(next.reasoningEffort, "medium");
    assert.equal(next.catalogRevision, 7);
    assert.equal(next.updatedAt, "2026-03-29 12:30");
  });

  it("Copilot session の reasoning 更新時も threadId を reset する", () => {
    const session = {
      ...createSession("copilot"),
      threadId: "thread-keep",
    };
    const selection = resolveModelSelection(COPILOT_PROVIDER_CATALOG, session.model, "low");

    const next = applySessionModelMetadataUpdate(session, selection, 8, "2026-03-29 12:45");

    assert.equal(next.threadId, "");
    assert.equal(next.model, "gpt-4.1");
    assert.equal(next.reasoningEffort, "low");
    assert.equal(next.catalogRevision, 8);
    assert.equal(next.updatedAt, "2026-03-29 12:45");
  });

  it("Codex session の model 更新時も threadId を reset する", () => {
    const session = {
      ...createSession("codex"),
      threadId: "thread-keep",
    };
    const selection = resolveModelSelection(CODEX_PROVIDER_CATALOG, "gpt-5.4-mini", "low");

    const next = applySessionModelMetadataUpdate(session, selection, 9, "2026-03-29 13:00");

    assert.equal(next.threadId, "");
    assert.equal(next.model, "gpt-5.4-mini");
    assert.equal(next.reasoningEffort, "low");
    assert.equal(next.catalogRevision, 9);
    assert.equal(next.updatedAt, "2026-03-29 13:00");
  });

  it("対象外 provider の session では threadId を reset する", () => {
    const session = {
      ...createSession("other-provider"),
      threadId: "thread-reset",
    };
    const selection = resolveModelSelection(CODEX_PROVIDER_CATALOG, "gpt-5.4", "medium");

    const next = applySessionModelMetadataUpdate(session, selection, 10, "2026-03-29 13:15");

    assert.equal(next.threadId, "");
    assert.equal(next.model, "gpt-5.4");
    assert.equal(next.reasoningEffort, "medium");
    assert.equal(next.catalogRevision, 10);
    assert.equal(next.updatedAt, "2026-03-29 13:15");
  });
});
