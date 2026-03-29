import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildNewSession,
  DEFAULT_CHARACTER_SESSION_COPY,
  type CharacterProfile,
} from "../../src/app-state.js";
import { createDefaultSessionMemory, type ProjectMemoryEntry } from "../../src/memory-state.js";
import { createDefaultAppSettings } from "../../src/provider-settings-state.js";
import type { ModelCatalogProvider } from "../../src/model-catalog.js";
import { composeProviderPrompt } from "../../src-electron/provider-prompt.js";

const providerCatalog: ModelCatalogProvider = {
  id: "codex",
  label: "Codex",
  defaultModelId: "gpt-5.4",
  defaultReasoningEffort: "high",
  models: [
    {
      id: "gpt-5.4",
      label: "GPT-5.4",
      reasoningEfforts: ["high"],
    },
  ],
};

const character: CharacterProfile = {
  id: "character-1",
  name: "Test",
  description: "",
  roleMarkdown: "あなたは丁寧に説明する。",
  notesMarkdown: "",
  iconPath: "",
  themeColors: {
    main: "#000000",
    sub: "#111111",
  },
  sessionCopy: DEFAULT_CHARACTER_SESSION_COPY,
  updatedAt: "2026-03-28T00:00:00.000Z",
};

function makeProjectMemoryEntry(partial: Partial<ProjectMemoryEntry> & Pick<ProjectMemoryEntry, "id" | "category" | "detail">): ProjectMemoryEntry {
  return {
    projectScopeId: "scope-1",
    sourceSessionId: "session-1",
    title: partial.detail,
    keywords: [],
    evidence: [],
    createdAt: "2026-03-28T00:00:00.000Z",
    updatedAt: "2026-03-28T00:00:00.000Z",
    lastUsedAt: null,
    ...partial,
  };
}

function assertSectionOrder(text: string, sections: string[]): void {
  let previousIndex = -1;

  for (const section of sections) {
    const index = text.indexOf(section);
    assert.notEqual(index, -1, `${section} が見つからない`);
    assert.ok(index > previousIndex, `${section} の順序が不正`);
    previousIndex = index;
  }
}

describe("composeProviderPrompt", () => {
  it("System / Character / Session Memory / Project Memory / User Input の順で合成する", () => {
    const session = buildNewSession({
      taskTitle: "task",
      workspaceLabel: "workspace",
      workspacePath: "workspace",
      branch: "",
      characterId: character.id,
      character: character.name,
      characterIconPath: "",
      characterThemeColors: character.themeColors,
      approvalMode: "safety",
    });
    const sessionMemory = {
      ...createDefaultSessionMemory(session),
      goal: "approval UI を整理する",
      decisions: ["Codex には approval callback がある"],
      openQuestions: ["Copilot 側をどう揃えるか"],
      nextActions: ["retrieval を実装する"],
      notes: ["context: UI contract は provider-neutral にする"],
    };

    const prompt = composeProviderPrompt({
      session,
      sessionMemory,
      projectMemoryEntries: [
        makeProjectMemoryEntry({
          id: "entry-1",
          category: "decision",
          detail: "Copilot の image は file attachment として扱う",
        }),
      ],
      character,
      providerCatalog,
      userMessage: "approval UI の次を進めて",
      appSettings: {
        ...createDefaultAppSettings(),
        systemPromptPrefix: "安全第一で進める。",
      },
      attachments: [],
    });

    assert.match(prompt.systemBodyText, /# System Prompt/);
    assert.match(prompt.systemBodyText, /# Character/);
    assert.equal(prompt.logicalPrompt.systemText, prompt.systemBodyText);
    assert.match(prompt.logicalPrompt.systemText, /# Character/);
    assert.equal(prompt.logicalPrompt.inputText, prompt.inputBodyText);
    assert.equal(
      prompt.logicalPrompt.composedText,
      `${prompt.logicalPrompt.systemText}\n\n${prompt.logicalPrompt.inputText}`,
    );
    assert.match(prompt.logicalPrompt.composedText, /# Character/);
    assert.match(prompt.inputBodyText, /# Session Memory/);
    assert.match(prompt.inputBodyText, /# Project Memory/);
    assert.match(prompt.inputBodyText, /# User Input/);
    assertSectionOrder(prompt.logicalPrompt.composedText, [
      "# System Prompt",
      "# Character",
      "# Session Memory",
      "# Project Memory",
      "# User Input",
    ]);
  });

  it("system prompt prefix が空でも character を Codex 用 logical prompt から落とさない", () => {
    const session = buildNewSession({
      taskTitle: "task",
      workspaceLabel: "workspace",
      workspacePath: "workspace",
      branch: "",
      characterId: character.id,
      character: character.name,
      characterIconPath: "",
      characterThemeColors: character.themeColors,
      approvalMode: "safety",
    });

    const prompt = composeProviderPrompt({
      session,
      sessionMemory: createDefaultSessionMemory(session),
      projectMemoryEntries: [],
      character,
      providerCatalog,
      userMessage: "character が消えないことを確認する",
      appSettings: {
        ...createDefaultAppSettings(),
        systemPromptPrefix: "",
      },
      attachments: [],
    });

    assert.equal(prompt.systemBodyText, "# Character\n\nあなたは丁寧に説明する。");
    assert.equal(prompt.logicalPrompt.systemText, prompt.systemBodyText);
    assert.match(prompt.logicalPrompt.systemText, /# Character/);
    assert.equal(prompt.logicalPrompt.inputText, prompt.inputBodyText);
    assert.equal(
      prompt.logicalPrompt.composedText,
      `${prompt.logicalPrompt.systemText}\n\n${prompt.logicalPrompt.inputText}`,
    );
    assert.match(prompt.logicalPrompt.composedText, /^# Character/);
    assert.match(prompt.logicalPrompt.composedText, /あなたは丁寧に説明する。/);
    assertSectionOrder(prompt.logicalPrompt.composedText, ["# Character", "# User Input"]);
  });
});
