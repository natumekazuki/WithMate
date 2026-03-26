import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildNewSession,
  createDefaultAppSettings,
  createDefaultSessionMemory,
} from "../../src/app-state.js";
import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import {
  buildSessionMemoryExtractionPrompt,
  getSessionMemoryExtractionSettings,
  parseSessionMemoryDeltaText,
  shouldTriggerSessionMemoryExtraction,
} from "../../src-electron/session-memory-extraction.js";

function createSession() {
  return {
    ...buildNewSession({
      taskTitle: "Memory extraction",
      workspaceLabel: "workspace",
      workspacePath: "C:/workspace",
      branch: "main",
      characterId: "char-a",
      character: "A",
      characterIconPath: "",
      characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
      approvalMode: DEFAULT_APPROVAL_MODE,
    }),
    messages: [
      { role: "user" as const, text: "Memory の設計を進めたい" },
      { role: "assistant" as const, text: "まず Session Memory の trigger を決めよう" },
    ],
  };
}

describe("session-memory-extraction", () => {
  it("provider ごとの threshold 設定を返す", () => {
    const settings = createDefaultAppSettings();
    settings.memoryExtractionProviderSettings.codex = {
      model: "gpt-5.4-mini",
      reasoningEffort: "low",
      outputTokensThreshold: 280,
    };

    const resolved = getSessionMemoryExtractionSettings(settings, "codex");
    assert.equal(resolved.model, "gpt-5.4-mini");
    assert.equal(resolved.reasoningEffort, "low");
    assert.equal(resolved.outputTokensThreshold, 280);
  });

  it("outputTokens threshold または force で発火判定する", () => {
    assert.equal(
      shouldTriggerSessionMemoryExtraction({ inputTokens: 10, cachedInputTokens: 0, outputTokens: 220 }, 200),
      true,
    );
    assert.equal(
      shouldTriggerSessionMemoryExtraction({ inputTokens: 10, cachedInputTokens: 0, outputTokens: 120 }, 200),
      false,
    );
    assert.equal(shouldTriggerSessionMemoryExtraction(null, 200, true), true);
  });

  it("prompt に current memory と recent messages を含める", () => {
    const session = createSession();
    const memory = createDefaultSessionMemory(session);
    const prompt = buildSessionMemoryExtractionPrompt(session, {
      ...memory,
      decisions: ["trigger は outputTokens threshold にする"],
    });

    assert.match(prompt.systemText, /Session Memory 抽出器/);
    assert.match(prompt.userText, /Current Session Memory/);
    assert.match(prompt.userText, /trigger は outputTokens threshold にする/);
    assert.match(prompt.userText, /Recent Messages/);
    assert.match(prompt.userText, /Memory の設計を進めたい/);
  });

  it("JSON と fenced JSON を SessionMemoryDelta として parse できる", () => {
    assert.deepEqual(
      parseSessionMemoryDeltaText('{"nextActions":["trigger を実装する"]}'),
      { nextActions: ["trigger を実装する"] },
    );
    assert.deepEqual(
      parseSessionMemoryDeltaText('```json\n{"notes":["compact 前に強制実行する"]}\n```'),
      { notes: ["compact 前に強制実行する"] },
    );
    assert.equal(parseSessionMemoryDeltaText("not json"), null);
  });
});
