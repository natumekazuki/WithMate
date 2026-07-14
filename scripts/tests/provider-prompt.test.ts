import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildNewSession } from "../../src/app-state.js";
import type { CharacterRuntimeSnapshot } from "../../src/character/character-catalog.js";
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

function createCharacterRuntimeSnapshot(overrides?: Partial<CharacterRuntimeSnapshot>): CharacterRuntimeSnapshot {
  return {
    characterId: "character-1",
    name: "Saved Character",
    description: "保存済み Character",
    iconFilePath: "icon.png",
    theme: characterThemeColors,
    definitionMarkdown: [
      "---",
      "schema: withmate.character.v1",
      "name: Saved Character",
      "---",
      "# Character",
      "保存済みの character.md だけを runtime persona として扱う。",
    ].join("\n"),
    definitionSha256: "sha256-character-definition",
    definitionByteSize: 128,
    snapshotAt: "2026-06-14T00:00:00.000Z",
    ...overrides,
  };
}

describe("composeProviderPrompt", () => {
  it("User Input 境界を明示し、Memory は注入しない", () => {
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
    assert.equal(prompt.inputBodyText, "# User Input\n\napproval UI の次を進めて");
    assert.equal(prompt.logicalPrompt.inputText, prompt.inputBodyText);
    assert.equal(prompt.logicalPrompt.inputText, "# User Input\n\napproval UI の次を進めて");
    assert.equal(
      prompt.logicalPrompt.composedText,
      prompt.logicalPrompt.systemText
        ? `${prompt.logicalPrompt.systemText}\n\n${prompt.logicalPrompt.inputText}`
        : prompt.logicalPrompt.inputText,
    );
    assert.doesNotMatch(prompt.logicalPrompt.composedText, /# Character/);
    assert.doesNotMatch(prompt.inputBodyText, /# Session Memory/);
    assert.doesNotMatch(prompt.inputBodyText, /# Project Memory/);
    assert.doesNotMatch(prompt.inputBodyText, /# Project Context/);
    assert.match(prompt.inputBodyText, /^# User Input\n\napproval UI の次を進めて$/);
    assertSectionOrder(prompt.logicalPrompt.composedText, ["# User Input", "approval UI の次を進めて"]);
  });

  it("空白のみの user input では User Input 見出しだけを注入しない", () => {
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
      userMessage: "   \n\t  ",
      appSettings: createDefaultAppSettings(),
      attachments: [],
    });

    assert.equal(prompt.inputBodyText, "");
    assert.equal(prompt.logicalPrompt.inputText, "");
    assert.equal(prompt.logicalPrompt.composedText, "");
    assert.doesNotMatch(prompt.inputBodyText, /# User Input/);
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
    assert.equal(prompt.inputBodyText, "# User Input\n\nsystem prompt が空でも user input は残ることを確認する");
    assert.equal(
      prompt.logicalPrompt.composedText,
      prompt.logicalPrompt.systemText
        ? `${prompt.logicalPrompt.systemText}\n\n${prompt.logicalPrompt.inputText}`
        : prompt.logicalPrompt.inputText,
    );
    assert.match(prompt.logicalPrompt.composedText, /system prompt が空でも user input は残ることを確認する/);
    assertSectionOrder(prompt.logicalPrompt.composedText, [
      "# User Input",
      "system prompt が空でも user input は残ることを確認する",
    ]);
  });

  it("保存済み CharacterRuntimeSnapshot の character.md だけを system prompt に注入する", () => {
    const session = buildNewSession({
      taskTitle: "task",
      workspaceLabel: "workspace",
      workspacePath: "workspace",
      branch: "",
      characterId: "character-1",
      character: "Current Catalog Name",
      characterIconPath: "",
      characterThemeColors,
      characterRuntimeSnapshot: createCharacterRuntimeSnapshot({
        name: "Saved Character",
        description: "frontmatter に頼らず保持する説明",
        definitionMarkdown: [
          "---",
          "schema: withmate.character.v1",
          "name: Saved Character",
          "description: frontmatter only description",
          "---",
          "# Runtime Definition",
          "保存済み snapshot の口調で話す。",
        ].join("\n"),
      }),
      approvalMode: "untrusted",
    });

    const prompt = composeProviderPrompt({
      session,
      sessionMemory: createDefaultSessionMemory(session),
      projectMemoryEntries: [],
      providerCatalog,
      userMessage: "続けて",
      appSettings: createDefaultAppSettings(),
      attachments: [],
    });

    assert.match(prompt.systemBodyText, /# Character Definition Snapshot/);
    assert.match(prompt.systemBodyText, /Character: Saved Character/);
    assert.match(prompt.systemBodyText, /Description: frontmatter に頼らず保持する説明/);
    assert.match(prompt.systemBodyText, /保存済み snapshot の口調で話す。/);
    assert.match(prompt.systemBodyText, /ユーザー向け自然言語レスポンスの話し方・温度・反応パターンに反映してください。/);
    assert.match(prompt.systemBodyText, /通常のcoding agentとして正確に扱い、Character定義で置き換えないでください。/);
    assert.doesNotMatch(prompt.systemBodyText, /開始時点の Character 定義/);
    assert.match(prompt.systemBodyText, /# Output Boundary/);
    assert.match(prompt.systemBodyText, /生成ファイル、diff、artifact summary には、ユーザーが明示しない限り Character の口調・設定・台詞・メタ説明を混ぜないでください。/);
    assert.match(prompt.systemBodyText, /成果物は repository instruction、既存文体、対象ファイルの目的を優先してください。/);
    assert.match(prompt.systemBodyText, /# Tool Call Presence/);
    assert.match(prompt.systemBodyText, /最初の tool call より前に、ユーザーへ1〜3文程度の短い自然言語レスポンスを返してください/);
    assert.match(prompt.systemBodyText, /キャラクターが無言のまま作業へ入り、応答が止まったように見える体験を避ける/);
    assert.match(prompt.systemBodyText, /routine な tool call ごとに実況する必要はありません/);
    assert.match(prompt.systemBodyText, /tool call が不要な応答では、このルールのためだけに前置きを追加する必要はありません/);
    assert.doesNotMatch(prompt.systemBodyText, /厳密な無人格回答へ戻りすぎず/);
    assert.doesNotMatch(prompt.systemBodyText, /character-notes\.md/);
    assert.doesNotMatch(prompt.systemBodyText, /^---$/m);
    assert.doesNotMatch(prompt.systemBodyText, /^schema:/m);
    assert.doesNotMatch(prompt.systemBodyText, /^name: Saved Character$/m);
    assert.doesNotMatch(prompt.systemBodyText, /frontmatter only description/);
    assert.doesNotMatch(prompt.systemBodyText, /notes-only secret/);
    assert.doesNotMatch(prompt.systemBodyText, /Current Catalog Name/);
    assert.doesNotMatch(prompt.inputBodyText, /保存済み snapshot の口調で話す。/);
    assert.equal(prompt.logicalPrompt.systemText, prompt.systemBodyText);
    assert.equal(prompt.logicalPrompt.inputText, prompt.inputBodyText);
    assertSectionOrder(prompt.logicalPrompt.composedText, [
      "# Character Definition Snapshot",
      "# Output Boundary",
      "# Tool Call Presence",
      "# User Input",
      "続けて",
    ]);
  });

  it("character-authoring session では Character の成果物境界を注入しない", () => {
    const session = buildNewSession({
      taskTitle: "task",
      workspaceLabel: "workspace",
      workspacePath: "workspace",
      branch: "",
      sessionKind: "character-authoring",
      characterId: "character-1",
      character: "Saved Character",
      characterIconPath: "",
      characterThemeColors,
      characterRuntimeSnapshot: createCharacterRuntimeSnapshot({
        definitionMarkdown: [
          "# Runtime Definition",
          "authoring 対象の character.md。",
        ].join("\n"),
      }),
      approvalMode: "untrusted",
    });

    const prompt = composeProviderPrompt({
      session,
      sessionMemory: createDefaultSessionMemory(session),
      projectMemoryEntries: [],
      providerCatalog,
      userMessage: "character.md を改善して",
      appSettings: createDefaultAppSettings(),
      attachments: [],
    });

    assert.match(prompt.systemBodyText, /# Character Definition Snapshot/);
    assert.match(prompt.systemBodyText, /authoring 対象の character\.md。/);
    assert.doesNotMatch(prompt.systemBodyText, /開始時点の Character 定義/);
    assert.doesNotMatch(prompt.systemBodyText, /# Output Boundary/);
    assert.doesNotMatch(prompt.systemBodyText, /# Tool Call Presence/);
    assert.doesNotMatch(prompt.systemBodyText, /ユーザー向け自然言語レスポンスの話し方・温度・反応パターンに反映してください。/);
    assert.doesNotMatch(prompt.systemBodyText, /通常のcoding agentとして正確に扱い、Character定義で置き換えないでください。/);
    assert.doesNotMatch(prompt.systemBodyText, /生成ファイル、diff、artifact summary/);
    assertSectionOrder(prompt.logicalPrompt.composedText, [
      "# Character Definition Snapshot",
      "# User Input",
      "character.md を改善して",
    ]);
  });

  it("character.md 内の code fence より長い外側 fence で snapshot を囲む", () => {
    const session = buildNewSession({
      taskTitle: "task",
      workspaceLabel: "workspace",
      workspacePath: "workspace",
      branch: "",
      characterId: "character-1",
      character: "Saved Character",
      characterIconPath: "",
      characterThemeColors,
      characterRuntimeSnapshot: createCharacterRuntimeSnapshot({
        definitionMarkdown: [
          "# Examples",
          "```ts",
          "console.log(\"triple fence\");",
          "```",
          "````markdown",
          "quad fence",
          "````",
        ].join("\n"),
      }),
      approvalMode: "untrusted",
    });

    const prompt = composeProviderPrompt({
      session,
      sessionMemory: createDefaultSessionMemory(session),
      projectMemoryEntries: [],
      providerCatalog,
      userMessage: "続けて",
      appSettings: createDefaultAppSettings(),
      attachments: [],
    });

    assert.match(prompt.systemBodyText, /`````markdown\n# Examples/);
    assert.match(prompt.systemBodyText, /````\n`````\n\n# Output Boundary/);
    assertSectionOrder(prompt.systemBodyText, [
      "`````markdown",
      "quad fence",
      "`````\n\n# Output Boundary",
      "# Tool Call Presence",
    ]);
  });
});
