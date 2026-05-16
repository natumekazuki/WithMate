import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildNewSession } from "../../src/app-state.js";
import { createDefaultSessionMemory, type ProjectMemoryEntry } from "../../src/memory/memory-state.js";
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

const characterThemeColors = {
  main: "#000000",
  sub: "#111111",
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
  it("System / User Input と Memory は注入しない", () => {
    const session = buildNewSession({
      taskTitle: "task",
      workspaceLabel: "workspace",
      workspacePath: "workspace",
      branch: "",
      characterId: "character-1",
      character: "Test",
      characterIconPath: "",
      characterThemeColors,
      approvalMode: "untrusted",
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
      providerCatalog,
      userMessage: "approval UI の次を進めて",
      appSettings: createDefaultAppSettings(),
      attachments: [],
    });

    assert.equal(prompt.systemBodyText, "");
    assert.doesNotMatch(prompt.systemBodyText, /# Character/);
    assert.equal(prompt.logicalPrompt.systemText, prompt.systemBodyText);
    assert.doesNotMatch(prompt.logicalPrompt.systemText, /# Character/);
    assert.equal(prompt.inputBodyText, "approval UI の次を進めて");
    assert.equal(prompt.logicalPrompt.inputText, prompt.inputBodyText);
    assert.equal(prompt.logicalPrompt.inputText, "approval UI の次を進めて");
    assert.equal(
      prompt.logicalPrompt.composedText,
      prompt.logicalPrompt.systemText
        ? `${prompt.logicalPrompt.systemText}\n\n${prompt.logicalPrompt.inputText}`
        : prompt.logicalPrompt.inputText,
    );
    assert.doesNotMatch(prompt.logicalPrompt.composedText, /# Character/);
    assert.doesNotMatch(prompt.inputBodyText, /# Session Memory/);
    assert.doesNotMatch(prompt.inputBodyText, /# Project Memory/);
    assert.doesNotMatch(prompt.inputBodyText, /# User Input/);
    assertSectionOrder(prompt.logicalPrompt.composedText, ["approval UI の次を進めて"]);
  });

  it("projectContextText がある場合、User Input より前に Project Context を注入する", () => {
    const session = buildNewSession({
      taskTitle: "task",
      workspaceLabel: "workspace",
      workspacePath: "workspace",
      branch: "",
      characterId: "character-1",
      character: "Test",
      characterIconPath: "",
      characterThemeColors,
      approvalMode: "untrusted",
    });
    const sessionMemory = createDefaultSessionMemory(session);

    const prompt = composeProviderPrompt({
      session,
      sessionMemory,
      projectMemoryEntries: [],
      projectContextText: "  # Digest\n- item 1\n- item 2  ",
      providerCatalog,
      userMessage: "次の実装を進めて",
      appSettings: createDefaultAppSettings(),
      attachments: [],
    });

    assert.match(prompt.inputBodyText, /# Project Context/);
    assert.match(prompt.inputBodyText, /このセクションは参照用のプロジェクト情報です/);
    assert.match(prompt.inputBodyText, /# Digest/);
    assert.match(prompt.inputBodyText, /- item 1/);
    assert.match(prompt.inputBodyText, /- item 2/);
    assertSectionOrder(prompt.inputBodyText, ["# Project Context", "ユーザー入力と上位指示が最優先です。", "# Digest", "# User Input"]);
    assertSectionOrder(prompt.inputBodyText, ["# Project Context", "# Digest"]);
    assertSectionOrder(prompt.logicalPrompt.composedText, [
      "# Project Context",
      "ユーザー入力と上位指示が最優先です。",
      "# Digest",
      "# User Input",
    ]);
  });

  it("空文字/null/undefined の projectContextText は注入しない", () => {
    const session = buildNewSession({
      taskTitle: "task",
      workspaceLabel: "workspace",
      workspacePath: "workspace",
      branch: "",
      characterId: "character-1",
      character: "Test",
      characterIconPath: "",
      characterThemeColors,
      approvalMode: "untrusted",
    });
    const sessionMemory = createDefaultSessionMemory(session);

    const promptWithoutContext = composeProviderPrompt({
      session,
      sessionMemory,
      projectMemoryEntries: [],
      projectContextText: "",
      providerCatalog,
      userMessage: "次の実装を進めて",
      appSettings: createDefaultAppSettings(),
      attachments: [],
    });

    assert.doesNotMatch(promptWithoutContext.inputBodyText, /# Project Context/);
    assert.equal(promptWithoutContext.inputBodyText, "次の実装を進めて");
    assert.equal(promptWithoutContext.logicalPrompt.inputText, "次の実装を進めて");
    assert.doesNotMatch(promptWithoutContext.inputBodyText, /# User Input/);
    assertSectionOrder(promptWithoutContext.logicalPrompt.composedText, ["次の実装を進めて"]);

    const promptWithNullContext = composeProviderPrompt({
      session,
      sessionMemory,
      projectMemoryEntries: [],
      projectContextText: null,
      providerCatalog,
      userMessage: "次の実装を進めて",
      appSettings: createDefaultAppSettings(),
      attachments: [],
    });
    assert.doesNotMatch(promptWithNullContext.inputBodyText, /# Project Context/);

    const promptWithUndefinedContext = composeProviderPrompt({
      session,
      sessionMemory,
      projectMemoryEntries: [],
      providerCatalog,
      userMessage: "次の実装を進めて",
      appSettings: createDefaultAppSettings(),
      attachments: [],
    });
    assert.doesNotMatch(promptWithUndefinedContext.inputBodyText, /# Project Context/);
  });

  it("共通 system prompt を空文字にする", () => {
    const session = buildNewSession({
      taskTitle: "task",
      workspaceLabel: "workspace",
      workspacePath: "workspace",
      branch: "",
      characterId: "character-1",
      character: "Test",
      characterIconPath: "",
      characterThemeColors,
      approvalMode: "untrusted",
    });

    const prompt = composeProviderPrompt({
      session,
      sessionMemory: createDefaultSessionMemory(session),
      projectMemoryEntries: [],
      providerCatalog,
      userMessage: "system prompt が空でも user input は残ることを確認する",
      appSettings: createDefaultAppSettings(),
      attachments: [],
    });

    assert.equal(prompt.systemBodyText, "");
    assert.equal(prompt.logicalPrompt.systemText, prompt.systemBodyText);
    assert.equal(prompt.logicalPrompt.systemText, "");
    assert.doesNotMatch(prompt.inputBodyText, /# Character/);
    assert.doesNotMatch(prompt.inputBodyText, /あなたは丁寧に説明する。/);
    assert.doesNotMatch(prompt.logicalPrompt.composedText, /# Character/);
    assert.doesNotMatch(prompt.logicalPrompt.composedText, /あなたは丁寧に説明する。/);
    assert.equal(prompt.logicalPrompt.inputText, prompt.inputBodyText);
    assert.equal(prompt.inputBodyText, "system prompt が空でも user input は残ることを確認する");
    assert.equal(
      prompt.logicalPrompt.composedText,
      prompt.logicalPrompt.systemText
        ? `${prompt.logicalPrompt.systemText}\n\n${prompt.logicalPrompt.inputText}`
        : prompt.logicalPrompt.inputText,
    );
    assert.doesNotMatch(prompt.logicalPrompt.composedText, /# User Input/);
    assert.match(prompt.logicalPrompt.composedText, /system prompt が空でも user input は残ることを確認する/);
    assertSectionOrder(prompt.logicalPrompt.composedText, ["system prompt が空でも user input は残ることを確認する"]);
  });
});
