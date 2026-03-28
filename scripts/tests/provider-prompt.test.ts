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
  name: "Codex",
  models: [],
};

const character: CharacterProfile = {
  id: "character-1",
  name: "Test",
  description: "",
  roleMarkdown: "あなたは丁寧に説明する。",
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
      approvalMode: "suggest",
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
    assert.match(prompt.inputBodyText, /# Session Memory/);
    assert.match(prompt.inputBodyText, /# Project Memory/);
    assert.match(prompt.inputBodyText, /# User Input/);
    assert.ok(
      prompt.logicalPrompt.composedText.indexOf("# Character") < prompt.logicalPrompt.composedText.indexOf("# Session Memory"),
    );
    assert.ok(
      prompt.logicalPrompt.composedText.indexOf("# Project Memory") < prompt.logicalPrompt.composedText.indexOf("# User Input"),
    );
  });
});
