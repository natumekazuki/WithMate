import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";

import { buildNewSession } from "../../src-shared/session/session-state.js";
import type { CharacterRuntimeSnapshot } from "../../src-shared/character/character-catalog.js";
import { createDefaultSessionMemory, type ProjectMemoryEntry } from "../../src-shared/memory/session-memory-state.js";
import { createDefaultAppSettings } from "../../src-shared/settings/provider-settings-state.js";
import type { ModelCatalogProvider } from "../../src-shared/settings/model-catalog.js";
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
  it("実行 workspace を基準に Workspace / SessionFolder / Additional Directories を system 側へ置く", () => {
    const session = buildNewSession({
      id: "session-1",
      taskTitle: "task",
      workspaceLabel: "workspace",
      workspacePath: "stored-workspace",
      branch: "",
      characterId: "character-1",
      character: "Test",
      characterIconPath: "",
      characterThemeColors,
      approvalMode: "untrusted",
      allowedAdditionalDirectories: [
        "execution-workspace/nested",
        "external/docs",
        "external",
      ],
    });
    const prompt = composeProviderPrompt({
      session,
      executionWorkspacePath: "execution-workspace",
      sessionFolderPath: "F:/user-data/session-files/session-1",
      sessionMemory: createDefaultSessionMemory(session),
      projectMemoryEntries: [],
      providerCatalog,
      userMessage: "実行して",
      appSettings: createDefaultAppSettings(),
      attachments: [],
    });

    assert.match(prompt.systemBodyText, /^# Workspace\n\nexecution-workspace/);
    assert.match(prompt.systemBodyText, /# SessionFolder\n\nF:\/user-data\/session-files\/session-1/);
    assert.match(prompt.systemBodyText, /# Additional Directories\n\n- /);
    assert.doesNotMatch(prompt.systemBodyText, /雑多な作業ファイル|filesystem access grant|sandbox|approval policy/);
    assert.equal(prompt.systemBodyText.includes(path.resolve("execution-workspace", "nested")), false);
    assert.equal(prompt.systemBodyText.includes(`- ${path.resolve("external")}`), true);
    assert.deepEqual(prompt.additionalDirectories, [path.resolve("external")]);
    assertSectionOrder(prompt.systemBodyText, ["# Workspace", "# SessionFolder", "# Additional Directories"]);
    assert.equal(prompt.logicalPrompt.systemText, prompt.systemBodyText);
  });

  it("Conversation Timingをinput側のUser Input直前へ置き、system側へ入れない", () => {
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
      userMessage: "続きやろっか",
      appSettings: createDefaultAppSettings(),
      attachments: [],
      conversationTimingContext: {
        observedAt: "2026-08-04T21:32:00.000+09:00",
        observedDayOfWeek: "tuesday",
        currentSession: {
          lastCompletedAt: "2026-08-04T19:19:00.000+09:00",
          elapsedMs: 2 * 60 * 60_000 + 13 * 60_000,
        },
        sameCharacterOtherSession: {
          lastCompletedAt: "2026-08-01T16:20:00.000+09:00",
          elapsedMs: 3 * 24 * 60 * 60_000 + 5 * 60 * 60_000,
        },
        sameCharacterSharedWork: {
          todayCompletedTurnDurationMs: 84 * 60_000,
          totalCompletedTurnDurationMs: 18 * 60 * 60_000 + 37 * 60_000,
        },
      },
    });

    assert.doesNotMatch(prompt.systemBodyText, /Conversation Timing|2026-08-04T21:32/);
    assert.match(prompt.inputBodyText, /Observed local time: 2026-08-04T21:32:00\.000\+09:00 \(Tuesday\)/);
    assert.match(prompt.inputBodyText, /2 hours 13 minutes ago/);
    assert.match(prompt.inputBodyText, /3 days 5 hours ago/);
    assert.match(prompt.inputBodyText, /1 hour 24 minutes today; 18 hours 37 minutes total/);
    assert.match(prompt.inputBodyText, /does not reveal what was discussed there/);
    assert.match(prompt.inputBodyText, /not continuous presence or conversation time/);
    assert.match(prompt.inputBodyText, /Do not infer or judge the user's location, schedule, sleep/);
    assertSectionOrder(prompt.inputBodyText, [
      "# Conversation Timing",
      "Use same-session timing",
      "Prioritize the current user input and tone",
      "Observed values:",
      "- Observed local time:",
      "# User Input",
      "続きやろっか",
    ]);
  });

  it("履歴と共同作業時間がない時も基準時刻だけを出し、未取得行は省略する", () => {
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
      userMessage: "開始",
      appSettings: createDefaultAppSettings(),
      attachments: [],
      conversationTimingContext: {
        observedAt: "2026-08-04T09:00:00.000+09:00",
        observedDayOfWeek: "tuesday",
        currentSession: null,
        sameCharacterOtherSession: null,
        sameCharacterSharedWork: {
          todayCompletedTurnDurationMs: 0,
          totalCompletedTurnDurationMs: 0,
        },
      },
    });

    assert.match(prompt.inputBodyText, /# Conversation Timing/);
    assert.doesNotMatch(
      prompt.inputBodyText,
      /^- (?:Previous completed exchange|Latest completed exchange|Completed turn execution time with this character:)/m,
    );
    assert.doesNotMatch(prompt.inputBodyText, /never/);
  });

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

    assert.match(prompt.systemBodyText, /# Workspace/);
    assert.match(prompt.systemBodyText, /# SessionFolder/);
    assert.match(prompt.systemBodyText, /# Additional Directories\n\nなし/);
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
    assert.equal(prompt.logicalPrompt.composedText, prompt.systemBodyText);
    assert.doesNotMatch(prompt.inputBodyText, /# User Input/);
  });

  it("Character がなくても folder context を system prompt に残す", () => {
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
      userMessage: "folder context が system 側でも user input は残ることを確認する",
      appSettings: createDefaultAppSettings(),
      attachments: [],
    });

    assert.match(prompt.systemBodyText, /# Workspace/);
    assert.match(prompt.systemBodyText, /# SessionFolder/);
    assert.match(prompt.systemBodyText, /# Additional Directories\n\nなし/);
    assert.equal(prompt.logicalPrompt.systemText, prompt.systemBodyText);
    assert.doesNotMatch(prompt.inputBodyText, /# Workspace|# SessionFolder|# Additional Directories/);
    assert.doesNotMatch(prompt.inputBodyText, /# Character/);
    assert.doesNotMatch(prompt.inputBodyText, /あなたは丁寧に説明する。/);
    assert.doesNotMatch(prompt.logicalPrompt.composedText, /# Character/);
    assert.doesNotMatch(prompt.logicalPrompt.composedText, /あなたは丁寧に説明する。/);
    assert.equal(prompt.logicalPrompt.inputText, prompt.inputBodyText);
    assert.equal(prompt.inputBodyText, "# User Input\n\nfolder context が system 側でも user input は残ることを確認する");
    assert.equal(
      prompt.logicalPrompt.composedText,
      prompt.logicalPrompt.systemText
        ? `${prompt.logicalPrompt.systemText}\n\n${prompt.logicalPrompt.inputText}`
        : prompt.logicalPrompt.inputText,
    );
    assert.match(prompt.logicalPrompt.composedText, /folder context が system 側でも user input は残ることを確認する/);
    assertSectionOrder(prompt.logicalPrompt.composedText, [
      "# Workspace",
      "# SessionFolder",
      "# Additional Directories",
      "# User Input",
      "folder context が system 側でも user input は残ることを確認する",
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
      "# Workspace",
      "# SessionFolder",
      "# Additional Directories",
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
      "# Workspace",
      "# SessionFolder",
      "# Additional Directories",
      "# User Input",
      "character.md を改善して",
    ]);
  });

  // @test-value v1
  // kind = "security"
  // claim = "provider promptのCharacter Affect Contextはidentityを含めず、baseline・affect version・全effective component・Memory previewを契約どおり投影する"
  // oracle = { type = "adr", ref = "docs/adr/024-provider-common-memory-mcp-boundary.md:59-61" }
  // failure_mode = "公開contextから除いたuser・Character・Session identityまたはMemory非公開fieldをprompt assemblyが再投影し、providerへ漏らす"
  // scope = "composeProviderPrompt Character Affect Context projection"
  // lifecycle = "permanent"
  // distinction = "application responseのfield制限ではなく、provider向けJSON envelopeがidentityを再構成しないことを検証する"
  // @end-test-value
  it("固定system sectionの後ろへidentity-free Character Affect Contextを置き、契約fieldを保持する", () => {
    const session = buildNewSession({
      taskTitle: "task",
      workspaceLabel: "workspace",
      workspacePath: "workspace",
      branch: "",
      characterId: "character-1",
      character: "Saved Character",
      characterIconPath: "",
      characterThemeColors,
      characterRuntimeSnapshot: createCharacterRuntimeSnapshot(),
      approvalMode: "untrusted",
    });
    const evaluatedAt = "2026-08-09T06:00:00.000Z";
    const prompt = composeProviderPrompt({
      session,
      sessionMemory: createDefaultSessionMemory(session),
      projectMemoryEntries: [],
      providerCatalog,
      userMessage: "続けて",
      appSettings: createDefaultAppSettings(),
      attachments: [],
      characterContext: {
        schemaVersion: "withmate-character-context-v1",
        baseline: {
          definitionSha256: "sha256-character-definition",
          snapshotAt: "2026-06-14T00:00:00.000Z",
        },
        affect: {
          mode: "active",
          effective: Array.from({ length: 13 }, (_, index) => ({
            contributingLayers: ["session" as const],
            targetType: "task",
            targetId: `current-task-${index}`,
            family: "interest",
            label: "focused",
            valence: 0.4,
            intensity: 0.5,
            ...(index === 0
              ? {
                  sourceSessionId: "session-b",
                  reason: "PRIVATE_AFTERGLOW_REASON",
                  evidence: "PRIVATE_AFTERGLOW_EVIDENCE",
                }
              : {}),
          })),
          evaluatedAt,
          version: "affect-v1-provider-prompt",
          updatedAt: "2026-08-09T00:00:00.000Z",
        },
        memory: { items: [], updatedAt: null },
      },
    });

    const contextJson = prompt.systemBodyText.match(/# Character Affect Context[\s\S]*?```json\n([\s\S]*?)\n```/)?.[1];
    assert.ok(contextJson);
    const context = JSON.parse(contextJson) as {
      characterAffect: {
        effective: unknown[];
        evaluatedAt: string;
        version: string;
        updatedAt: string | null;
      };
      relatedCharacterMemory: unknown[];
      baselineRef: { definitionSha256: string; snapshotAt: string };
    };
    assertSectionOrder(prompt.logicalPrompt.composedText, [
      "# Character Definition Snapshot",
      "# Output Boundary",
      "# Tool Call Presence",
      "# Workspace",
      "# SessionFolder",
      "# Additional Directories",
      "# Character Affect Context",
      "# User Input",
    ]);
    assert.equal(context.characterAffect.effective.length, 13);
    assert.equal(context.characterAffect.evaluatedAt, evaluatedAt);
    assert.equal(context.characterAffect.version, "affect-v1-provider-prompt");
    assert.equal(context.characterAffect.updatedAt, "2026-08-09T00:00:00.000Z");
    assert.deepEqual(Object.keys(context).sort(), ["baselineRef", "characterAffect", "relatedCharacterMemory"]);
    assert.deepEqual(Object.keys(context.characterAffect).sort(), ["effective", "evaluatedAt", "updatedAt", "version"]);
    assert.doesNotMatch(
      contextJson,
      /characterId|sessionId|userId|"scope"|sourceSessionId|PRIVATE_AFTERGLOW_REASON|PRIVATE_AFTERGLOW_EVIDENCE/,
    );
    assert.deepEqual(context.baselineRef, {
      definitionSha256: "sha256-character-definition",
      snapshotAt: "2026-06-14T00:00:00.000Z",
    });
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "foreground prompt context の4つの toggle は対象 section だけを省略し、作業境界と User Input を保持する"
  // oracle = { type = "contract", ref = "Prompt context settings" }
  // fault = "1つの設定をOFFにしたとき別の context や作業境界まで消える、または空の section 見出しが provider prompt に残る"
  // observable = "composeProviderPrompt の systemBodyText、inputBodyText、logicalPrompt"
  // observation_boundary = "public-boundary"
  // scope = "composeProviderPrompt prompt-context-toggles"
  // lifecycle = "permanent"
  // impact = "Settings の個別切替と Codex/Copilot 共通の論理 prompt が一致しない"
  // distinction = "既存の default-on 順序・authoring test とは別に、各 toggle の単独 OFF と固定 boundary の保持を確認する"
  // @end-test-value
  it("foreground prompt context の4項目を個別にOFFにできる", () => {
    const session = buildNewSession({
      taskTitle: "task",
      workspaceLabel: "workspace",
      workspacePath: "workspace",
      branch: "",
      characterId: "character-1",
      character: "Saved Character",
      characterIconPath: "",
      characterThemeColors,
      characterRuntimeSnapshot: createCharacterRuntimeSnapshot(),
      approvalMode: "untrusted",
    });
    const timingContext = {
      observedAt: "2026-08-04T21:32:00.000+09:00",
      observedDayOfWeek: "tuesday" as const,
      currentSession: {
        lastCompletedAt: "2026-08-04T19:19:00.000+09:00",
        elapsedMs: 2 * 60 * 60_000 + 13 * 60_000,
      },
      sameCharacterOtherSession: null,
      sameCharacterSharedWork: {
        todayCompletedTurnDurationMs: 84 * 60_000,
        totalCompletedTurnDurationMs: 18 * 60 * 60_000 + 37 * 60_000,
      },
    };
    const characterContext = {
      schemaVersion: "withmate-character-context-v1" as const,
      baseline: {
        definitionSha256: "sha256-character-definition",
        snapshotAt: "2026-06-14T00:00:00.000Z",
      },
      affect: {
        mode: "active" as const,
        effective: [{
          contributingLayers: ["session" as const],
          targetType: "task" as const,
          targetId: "task-1",
          family: "interest" as const,
          label: "focused",
          valence: 0.4,
          intensity: 0.5,
        }],
        evaluatedAt: "2026-08-09T06:00:00.000Z",
        version: "affect-v1-provider-prompt",
        updatedAt: "2026-08-09T00:00:00.000Z",
      },
      memory: { items: [], updatedAt: null },
    };
    const baseInput = {
      session,
      sessionMemory: createDefaultSessionMemory(session),
      projectMemoryEntries: [],
      providerCatalog,
      userMessage: "続けて",
      attachments: [],
      conversationTimingContext: timingContext,
      characterContext,
    };
    const defaultSettings = createDefaultAppSettings();
    const affectOff = composeProviderPrompt({
      ...baseInput,
      appSettings: { ...defaultSettings, characterAffectContextEnabled: false },
    });
    const characterDefinitionOff = composeProviderPrompt({
      ...baseInput,
      appSettings: { ...defaultSettings, characterDefinitionEnabled: false },
    });
    const timingOff = composeProviderPrompt({
      ...baseInput,
      appSettings: { ...defaultSettings, conversationTimingEnabled: false },
    });
    const toolCallPresenceOff = composeProviderPrompt({
      ...baseInput,
      appSettings: { ...defaultSettings, toolCallPresenceEnabled: false },
    });
    const assertLogicalPromptViews = (prompt: ReturnType<typeof composeProviderPrompt>) => {
      assert.equal(prompt.logicalPrompt.systemText, prompt.systemBodyText);
      assert.equal(prompt.logicalPrompt.inputText, prompt.inputBodyText);
      assert.equal(
        prompt.logicalPrompt.composedText,
        [prompt.systemBodyText, prompt.inputBodyText].filter((section) => section.trim().length > 0).join("\n\n"),
      );
    };

    for (const prompt of [affectOff, characterDefinitionOff, timingOff, toolCallPresenceOff]) {
      assertLogicalPromptViews(prompt);
    }

    assert.doesNotMatch(affectOff.systemBodyText, /# Character Affect Context/);
    assert.doesNotMatch(affectOff.systemBodyText, /affect-v1-provider-prompt|relatedCharacterMemory/);
    assert.match(affectOff.systemBodyText, /# Character Definition Snapshot|Saved Character/);
    assert.match(affectOff.systemBodyText, /# Output Boundary/);
    assert.match(affectOff.inputBodyText, /# Conversation Timing/);
    assert.match(affectOff.systemBodyText, /# Tool Call Presence/);
    assert.match(affectOff.systemBodyText, /# Workspace/);
    assert.match(affectOff.inputBodyText, /# User Input\n\n続けて/);
    assert.doesNotMatch(characterDefinitionOff.systemBodyText, /# Character Definition Snapshot|Saved Character/);
    assert.match(characterDefinitionOff.systemBodyText, /# Output Boundary/);
    assert.match(characterDefinitionOff.systemBodyText, /# Tool Call Presence/);
    assert.match(characterDefinitionOff.systemBodyText, /# Character Affect Context/);
    assert.match(characterDefinitionOff.inputBodyText, /# Conversation Timing/);
    assert.match(characterDefinitionOff.systemBodyText, /# Workspace/);
    assert.match(characterDefinitionOff.inputBodyText, /# User Input\n\n続けて/);
    assert.match(timingOff.systemBodyText, /# Character Affect Context/);
    assert.doesNotMatch(timingOff.inputBodyText, /# Conversation Timing/);
    assert.doesNotMatch(timingOff.inputBodyText, /Observed local time|2026-08-04T21:32/);
    assert.match(timingOff.systemBodyText, /# Character Definition Snapshot|Saved Character/);
    assert.match(timingOff.systemBodyText, /# Output Boundary/);
    assert.match(timingOff.systemBodyText, /# Tool Call Presence/);
    assert.match(timingOff.systemBodyText, /# Workspace/);
    assert.match(timingOff.inputBodyText, /# User Input\n\n続けて/);
    assert.match(toolCallPresenceOff.systemBodyText, /# Character Affect Context/);
    assert.match(toolCallPresenceOff.systemBodyText, /# Character Definition Snapshot|Saved Character/);
    assert.match(toolCallPresenceOff.systemBodyText, /# Output Boundary/);
    assert.match(toolCallPresenceOff.inputBodyText, /# Conversation Timing/);
    assert.doesNotMatch(toolCallPresenceOff.systemBodyText, /# Tool Call Presence/);
    assert.doesNotMatch(toolCallPresenceOff.systemBodyText, /最初の tool call より前に/);
    assert.match(toolCallPresenceOff.systemBodyText, /# Workspace/);
    assert.match(toolCallPresenceOff.inputBodyText, /# User Input\n\n続けて/);
    assert.doesNotMatch(toolCallPresenceOff.logicalPrompt.composedText, /# Tool Call Presence/);
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
