import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";

import { buildNewSession } from "../../src-shared/session/session-state.js";
import { captureSessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";
import type { CharacterRuntimeSnapshot } from "../../src-shared/character/character-catalog.js";
import { NEUTRAL_CHARACTER_ID } from "../../src-shared/character/character-owner.js";
import { createDefaultAppSettings } from "../../src-shared/settings/provider-settings-state.js";
import type { ModelCatalogProvider } from "../../src-shared/settings/model-catalog.js";
import { composeProviderPrompt } from "../../src-electron/providers/provider-prompt.js";

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
  // @test-value v2
  // kind = "contract"
  // claim = "共通promptはAgentの公開人物情報を出自として渡し、自己personaとSession入力を分離してAgent間の自然文にも自己表現を適用する"
  // oracle = { type = "contract", ref = "docs/design/prompt-composition.md" }
  // fault = "自己personaの正本やAgent間表現の指示を失うか、公開sender情報またはSession入力の出自を混同する"
  // observable = "system本文のpersona正本とAgent間表現の指示、input本文のsender participant/public profile・Session Input末尾"
  // observation_boundary = "consumer"
  // scope = "provider-character-peer-prompt"
  // lifecycle = "permanent"
  // @end-test-value
  it("相手の公開情報と自己の人格・発話者を分離する", () => {
    const session = buildNewSession({ id: "a", taskTitle: "Task", workspaceLabel: "Workspace", workspacePath: "C:/work", branch: "main",
      characterId: "character-1", character: "A", characterIconPath: "", characterThemeColors, approvalMode: "untrusted",
      characterRuntimeSnapshot: createCharacterRuntimeSnapshot() });
    const base = { session, executionOptions: captureSessionExecutionOptions(session), providerCatalog, userMessage: "相談", appSettings: createDefaultAppSettings(), attachments: [],
    };
    const peer = composeProviderPrompt({ ...base, inputProvenance: { originalChanged: false,
      origin: { kind: "session", operation: "send", actorSessionId: "b-session", actorIncarnationId: "v1", actorKind: "main",
        actorSnapshot: { sessionTitle: "Peer task", character: { id: "b", name: "B", description: "短い公開紹介", iconPath: "" } },
        targetSessionId: "a", targetIncarnationId: "v1" } } });
    assert.ok(peer.systemBodyText.includes("MCPのmessage本文も対象"));
    assert.ok(peer.systemBodyText.includes("保存済みの character.md だけを runtime persona"));
    assert.match(peer.inputBodyText, /"participant":\s*\{\s*"type":\s*"character",\s*"id":\s*"b"/);
    assert.ok(peer.inputBodyText.includes("短い公開紹介"));
    assert.ok(peer.inputBodyText.endsWith("# Session Input\n\n相談"));
    const unknown = composeProviderPrompt({ ...base, inputProvenance: { origin: null, originalChanged: null } });
  });
  // @test-value v2
  // kind = "contract"
  // claim = "通常Mainは保存Role名、Auxiliaryは実行owner種別に対応する自身のRole名を共通Provider入力へ渡す"
  // oracle = { type = "contract", ref = "GitHub Issue #834 第6節 Role情報の入力; docs/design/prompt-composition.md" }
  // fault = "Roleを入力から落とす、別Roleへ固定する、Auxiliaryへ所属MainのRoleを渡す"
  // observable = "systemBodyTextのSession Role sectionとlogicalPromptのsystemText/composedText"
  // observation_boundary = "public-boundary"
  // scope = "composeProviderPromptの通常Main/Auxiliary Role投影"
  // lifecycle = "permanent"
  // distinction = "保存と認可のtestでは4 Providerへ渡るRole名の欠落やMain/Auxiliary取り違えを検出できない"
  // @end-test-value
  it("保存Roleと実Auxiliary種別から自身のRole名だけを共通promptへ投影する", () => {
    const session = buildNewSession({ id: "target", taskTitle: "Task", workspaceLabel: "Workspace", workspacePath: "C:/workspace", branch: "main",
      characterId: "unknown", character: "Unknown", characterIconPath: "", characterThemeColors, approvalMode: "untrusted" });
    const base = { session, executionOptions: captureSessionExecutionOptions(session), providerCatalog, userMessage: "work", appSettings: createDefaultAppSettings(), attachments: [] };
    for (const role of ["standalone", "overall-coordinator", "task-coordinator", "executor"] as const) {
      const prompt = composeProviderPrompt({ ...base, session: { ...session, sessionRole: role } });
      assert.equal(prompt.systemBodyText.split("# Session Role\n\n")[1]?.split("\n\n")[0], role);
      assert.equal(prompt.logicalPrompt.systemText, prompt.systemBodyText);
      assert.ok(prompt.logicalPrompt.composedText.includes(`# Session Role\n\n${role}\n\n`));
    }
    const auxiliary = composeProviderPrompt({ ...base, session: { ...session, sessionRole: "overall-coordinator" },
      runtimeOwner: { kind: "auxiliary", id: session.id, incarnationId: session.incarnationId! } });
    assert.equal(auxiliary.systemBodyText.split("# Session Role\n\n")[1]?.split("\n\n")[0], "auxiliary");
    const implicitStandalone = composeProviderPrompt({ ...base, session: { ...session, sessionRole: undefined } });
    assert.equal(implicitStandalone.systemBodyText.split("# Session Role\n\n")[1]?.split("\n\n")[0], "standalone");
  });

  // @test-value v2
  // kind = "contract"
  // claim = "Session由来の開始入力は実送信元・操作・受付後変更有無をProvider本文へ明示し、ユーザーの直接発言として表示しない"
  // oracle = { type = "contract", ref = "GitHub Issue #837: 実送信元と編集差分のProvider入力への反映" }
  // fault = "Session送信をUser Inputへ偽装する、実actor/Turn/操作を落とす、比較不能な過去入力を変更なしと断定する"
  // observable = "4 Provider共通compositionのinputBodyTextにある送信元JSON・変更値・入力見出しと採用本文"
  // observation_boundary = "public-boundary"
  // scope = "composeProviderPromptの共通Provider入力composition"
  // lifecycle = "permanent"
  // distinction = "UI表示testとqueue保存testではProvider transportへ渡る本文の送信者偽装を検出できない"
  // @end-test-value
  it("Session入力の送信者と原文変更有無を共通Provider promptへ明示する", () => {
    const session = buildNewSession({ id: "target", taskTitle: "Task", workspaceLabel: "Workspace", workspacePath: "C:/workspace", branch: "main",
      characterId: "unknown", character: "Unknown", characterIconPath: "", characterThemeColors, approvalMode: "untrusted" });
    const base = { session, executionOptions: captureSessionExecutionOptions(session), providerCatalog, userMessage: "Fixed edited instruction", appSettings: createDefaultAppSettings(), attachments: [] };
    const prompt = composeProviderPrompt({ ...base, inputProvenance: { origin: { kind: "session", actorKind: "auxiliary", actorSessionId: "actual-sender",
      actorIncarnationId: "sender-incarnation", actorTurnId: "17", operation: "send", targetSessionId: session.id, targetIncarnationId: session.incarnationId! }, originalChanged: true } });
    assert.match(prompt.inputBodyText, /not spoken directly by the user/);
    assert.match(prompt.inputBodyText, /"actorKind": "auxiliary"/);
    assert.match(prompt.inputBodyText, /"actorSessionId": "actual-sender"/);
    assert.match(prompt.inputBodyText, /"actorTurnId": "17"/);
    assert.match(prompt.inputBodyText, /"operation": "send"/);
    assert.match(prompt.inputBodyText, /"changedSinceAcceptance": true/);
    assert.match(prompt.inputBodyText, /# Session Input\n\nFixed edited instruction/);
    assert.doesNotMatch(prompt.inputBodyText, /# User Input/);
    const unknown = composeProviderPrompt({ ...base, inputProvenance: { origin: null, originalChanged: null } });
    assert.match(unknown.inputBodyText, /original sender.*not recorded/);
    assert.match(unknown.inputBodyText, /"changedSinceAcceptance": null/);
    assert.match(unknown.inputBodyText, /# Queued Input/);
    assert.doesNotMatch(unknown.inputBodyText, /# User Input/);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "promptは実行workspaceとSessionFolder・Crew Folderおよび許可directoryをsystem側へ配置する"
  // oracle = { type = "contract", ref = "docs/design/prompt-composition.md" }
  // fault = "保存workspaceまたは許可外directoryをpromptに載せる"
  // observable = "systemBodyTextの各section"
  // observation_boundary = "component-behavior"
  // scope = "実行 workspace を基準に"
  // lifecycle = "permanent"
  // impact = "providerが誤workspaceやdirectoryを前提に動く"
  // distinction = "添付path解決testとは異なるprompt本文を観測する"
  // @end-test-value
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
      executionOptions: captureSessionExecutionOptions(session),
      executionWorkspacePath: "execution-workspace",
      sessionFolderPath: "F:/user-data/session-files/session-1",
      crewFolderPath: "F:/user-data/crew-files/root",
      providerCatalog,
      userMessage: "実行して",
      appSettings: createDefaultAppSettings(),
      attachments: [],
    });

    assert.match(prompt.systemBodyText, /^# Workspace\n\nexecution-workspace/);
    assert.match(prompt.systemBodyText, /# SessionFolder\n\nF:\/user-data\/session-files\/session-1/);
    assert.match(prompt.systemBodyText, /# Crew Folder\n\nF:\/user-data\/crew-files\/root/);
    assert.match(prompt.systemBodyText, /# Additional Directories\n\n- /);
    assert.doesNotMatch(prompt.systemBodyText, /雑多な作業ファイル|filesystem access grant|sandbox|approval policy/);
    assert.equal(prompt.systemBodyText.includes(path.resolve("execution-workspace", "nested")), false);
    assert.equal(prompt.systemBodyText.includes(`- ${path.resolve("external")}`), true);
    assert.deepEqual(prompt.additionalDirectories, [path.resolve("external")]);
    assertSectionOrder(prompt.systemBodyText, ["# Workspace", "# SessionFolder", "# Crew Folder", "# Additional Directories"]);
    assert.equal(prompt.logicalPrompt.systemText, prompt.systemBodyText);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "Conversation TimingはUser Input直前のinput側へ置きsystem側へ入れない"
  // oracle = { type = "contract", ref = "docs/design/prompt-composition.md" }
  // fault = "timingを固定system promptへ混入する"
  // observable = "systemBodyText/inputBodyTextのsection順序"
  // observation_boundary = "component-behavior"
  // scope = "Conversation Timingをinput側"
  // lifecycle = "permanent"
  // impact = "可変timingがsystem session cacheへ固定される"
  // distinction = "timingの位置をprompt本文で直接観測する"
  // @end-test-value
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
      executionOptions: captureSessionExecutionOptions(session),
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

  // @test-value v2
  // kind = "invariant"
  // claim = "履歴と共同作業時間が無くても基準時刻を出し未取得行を省略する"
  // oracle = { type = "contract", ref = "docs/design/prompt-composition.md" }
  // fault = "未取得情報を虚偽の値としてpromptへ出す"
  // observable = "inputBodyTextのtiming行"
  // observation_boundary = "component-behavior"
  // scope = "履歴と共同作業時間がない時"
  // lifecycle = "permanent"
  // impact = "providerが存在しない活動履歴を前提にする"
  // distinction = "timing情報欠落時のprojectionを観測する"
  // @end-test-value
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
      executionOptions: captureSessionExecutionOptions(session),
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

  // @test-value v2
  // kind = "invariant"
  // claim = "User Input sectionは作業directory情報と分離し、論理promptと表示用promptで同じ入力本文を保持する"
  // oracle = { type = "contract", ref = "docs/design/prompt-composition.md" }
  // fault = "ユーザー入力をsystem側へ混ぜるか、論理promptと表示用promptで本文または結合順序を変える"
  // observable = "logicalPrompt/inputBodyTextのsection"
  // observation_boundary = "component-behavior"
  // scope = "User Input 境界を明示"
  // lifecycle = "permanent"
  // impact = "Providerの会話文脈が重複または混乱する"
  // distinction = "user本文を含む入力に対し、system/inputの分離と論理promptの対応を観測する"
  // @end-test-value
  it("User Input 境界を明示し、論理promptの本文と順序を保持する", () => {
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
      executionOptions: captureSessionExecutionOptions(session),
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
    assert.match(prompt.inputBodyText, /^# User Input\n\napproval UI の次を進めて$/);
    assertSectionOrder(prompt.logicalPrompt.composedText, ["# User Input", "approval UI の次を進めて"]);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "空白だけのuser inputではUser Input見出しを作らない"
  // oracle = { type = "contract", ref = "docs/design/prompt-composition.md" }
  // fault = "空入力を有効本文としてpromptへ混ぜる"
  // observable = "inputBodyTextのUser Input section"
  // observation_boundary = "component-behavior"
  // scope = "空白のみの user input"
  // lifecycle = "permanent"
  // impact = "空のuser指示がproviderへ送られる"
  // distinction = "通常入力時の境界testと異なる空入力case"
  // @end-test-value
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
      executionOptions: captureSessionExecutionOptions(session),
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

  // @test-value v2
  // kind = "invariant"
  // claim = "Character snapshot不在ではCharacter sectionを出さずfolder contextはsystem promptへ残る"
  // oracle = { type = "contract", ref = "docs/design/prompt-composition.md" }
  // fault = "Character欠落を理由にworkspace contextまで落とすか、未採用のCharacter情報をpromptへ出す"
  // observable = "systemBodyTextのfolder sectionとlogicalPrompt.composedTextのCharacter sectionの有無"
  // observation_boundary = "component-behavior"
  // scope = "Character がなくても folder context"
  // lifecycle = "permanent"
  // impact = "providerが作業場所を把握できない"
  // distinction = "Character有無の分岐を観測する"
  // @end-test-value
  it("Character がなくても folder context を system prompt に残す", () => {
    const session = buildNewSession({
      taskTitle: "task",
      workspaceLabel: "workspace",
      workspacePath: "workspace",
      branch: "",
      characterId: "character-1",
      character: "Test",
      characterIconPath: "display-only.png",
      characterThemeColors,
      approvalMode: "untrusted",
    });

    const prompt = composeProviderPrompt({
      session,
      executionOptions: captureSessionExecutionOptions(session),
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

  // @test-value v2
  // kind = "invariant"
  // claim = "保存済みCharacter定義をsystem側へ投影し、作業中の声と発話量の独立調整、会話内の再利用本文との境界、正確性およびtool前応答を指示する"
  // oracle = { type = "contract", ref = "docs/design/prompt-composition.md" }
  // fault = "現在のCharacter profileを代用する、作業中のCharacter表現や発話量の独立調整を落とす、または会話内の成果物・正確性・tool前応答の指示を落とす"
  // observable = "systemBodyTextのCharacter metadata・Output Boundary・Tool Call Presence、inputBodyText、imagePaths、additionalDirectories"
  // observation_boundary = "component-behavior"
  // scope = "保存済み CharacterRuntimeSnapshot"
  // lifecycle = "permanent"
  // impact = "手元の共有記録でCharacter表現が制限される、または外部向け成果物に意図しないCharacter表現が混入する"
  // distinction = "typecheckで検出できないprovider向け指示の欠落を観測する。モデルの本人らしさや成果物品質は実応答比較で別に確認する"
  // @end-test-value
  it("保存済み CharacterRuntimeSnapshot の名前・説明・定義を system prompt に投影する", () => {
    const session = buildNewSession({
      taskTitle: "task",
      workspaceLabel: "workspace",
      workspacePath: "workspace",
      branch: "",
      characterId: "character-1",
      character: "Current Catalog Name",
      characterIconPath: "current-catalog-icon.png",
      characterThemeColors,
      characterRuntimeSnapshot: createCharacterRuntimeSnapshot({
        name: "Saved Character",
        description: "frontmatter に頼らず保持する説明",
        iconFilePath: "C:\\Character Data\\保存済み キャラ\\icon.png",
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
      executionOptions: captureSessionExecutionOptions(session),
      providerCatalog,
      userMessage: "続けて",
      appSettings: createDefaultAppSettings(),
      attachments: [],
    });

    assert.match(prompt.systemBodyText, /# Character Definition Snapshot/);
    assert.match(prompt.systemBodyText, /Character: Saved Character/);
    assert.match(prompt.systemBodyText, /Description: frontmatter に頼らず保持する説明/);
    assert.equal(prompt.inputBodyText, "# User Input\n\n続けて");
    assert.deepEqual(prompt.imagePaths, []);
    assert.deepEqual(prompt.additionalDirectories, []);
    assert.match(prompt.systemBodyText, /保存済み snapshot の口調で話す。/);
    assert.match(prompt.systemBodyText, /# Output Boundary/);
    assert.match(prompt.systemBodyText, /Session Graphや非公開の手元の自然文/);
    assert.match(prompt.systemBodyText, /一人称・呼称・語彙・構文・距離感・着眼点・反応・説明の組み立て/);
    assert.match(prompt.systemBodyText, /技術説明・進捗・発見・訂正・不一致・最終報告でも保ち/);
    assert.match(prompt.systemBodyText, /発話量・反応頻度と個性の強さは別に調整/);
    assert.match(prompt.systemBodyText, /癖・強さ・状態差は定義に従い/);
    assert.match(prompt.systemBodyText, /Character表現で技術判断の根拠・確度、権限、検証結果、未確認事実を変えない/);
    assert.match(prompt.systemBodyText, /手元の記録でも主体と事実・条件・状態を保ち/);
    assert.match(prompt.systemBodyText, /ID・数値・列挙値・状態値・コマンド出力・正確な引用は書き換えません/);
    assert.match(prompt.systemBodyText, /repository内・外部提出\/公開用の成果物には明示指定なしにCharacterの口調・設定・台詞・メタ説明を混ぜず/);
    assert.match(prompt.systemBodyText, /repository instruction・既存文体・目的を優先/);
    assert.match(prompt.systemBodyText, /前後の説明はCharacter表現、再利用本文は提出先・repository・ユーザー指定の文体\/形式に分け/);
    assert.match(prompt.systemBodyText, /保存先ではなく提出予定で判定し、草案も成果物として扱って/);
    assert.match(prompt.systemBodyText, /# Tool Call Presence/);
    assert.match(prompt.systemBodyText, /初回実行前は1〜3文で自然に応答/);
    assert.match(prompt.systemBodyText, /長い作業では意味のある経過・反応を伝えて/);
    assert.match(prompt.systemBodyText, /詳細な計画・操作説明・定型挨拶・操作ごとの実況、tool不要の応答への前置きは不要/);
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

  // @test-value v2
  // kind = "invariant"
  // claim = "character-authoring sessionではsnapshotの定義を渡し、通常Character成果物境界を注入しない"
  // oracle = { type = "contract", ref = "docs/design/prompt-composition.md" }
  // fault = "authoringの定義を落とすか、通常SessionのCharacter制約を混入する"
  // observable = "systemBodyTextのCharacter metadata/Output Boundary sections"
  // observation_boundary = "component-behavior"
  // scope = "character-authoring session では"
  // lifecycle = "permanent"
  // impact = "Character編集作業への不要な制約が混ざる"
  // distinction = "通常sessionとauthoring sessionのprompt分岐を観測する"
  // @end-test-value
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
      executionOptions: captureSessionExecutionOptions(session),
      providerCatalog,
      userMessage: "character.md を改善して",
      appSettings: createDefaultAppSettings(),
      attachments: [],
    });

    assert.match(prompt.systemBodyText, /# Character Definition Snapshot/);
    assert.match(prompt.systemBodyText, /authoring 対象の character\.md。/);
    assert.doesNotMatch(prompt.systemBodyText, /# Output Boundary/);
    assert.doesNotMatch(prompt.systemBodyText, /# Tool Call Presence/);
    assert.doesNotMatch(prompt.systemBodyText, /リポジトリに含めるものや外部へ提出・公開する成果物/);
    assertSectionOrder(prompt.logicalPrompt.composedText, [
      "# Character Definition Snapshot",
      "# Workspace",
      "# SessionFolder",
      "# Additional Directories",
      "# User Input",
      "character.md を改善して",
    ]);
  });


  // @test-value v2
  // kind = "invariant"
  // claim = "foreground prompt context の3つの toggle は対象 section だけを省略し、作業境界と User Input を保持する"
  // oracle = { type = "contract", ref = "docs/design/prompt-composition.md#設定とSession種別" }
  // fault = "1つの設定をOFFにしたとき別の context や作業境界まで消える、または空の section 見出しが provider prompt に残る"
  // observable = "composeProviderPrompt の systemBodyText、inputBodyText、logicalPrompt"
  // observation_boundary = "public-boundary"
  // scope = "composeProviderPrompt prompt-context-toggles"
  // lifecycle = "permanent"
  // impact = "Settings の個別切替と Codex/Copilot 共通の論理 prompt が一致しない"
  // distinction = "既存の default-on 順序・authoring test とは別に、各 toggle の単独 OFF と固定 boundary の保持を確認する"
  // @end-test-value
  it("foreground prompt context の3項目を個別にOFFにできる", () => {
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
    const baseInput = {
      session,
      executionOptions: captureSessionExecutionOptions(session),
      providerCatalog,
      userMessage: "続けて",
      attachments: [],
      conversationTimingContext: timingContext,
    };
    const defaultSettings = createDefaultAppSettings();
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

    for (const prompt of [ characterDefinitionOff, timingOff, toolCallPresenceOff]) {
      assertLogicalPromptViews(prompt);
    }

    assert.doesNotMatch(characterDefinitionOff.systemBodyText, /# Character Definition Snapshot|保存済みの character.md だけを runtime persona/);
    assert.deepEqual(characterDefinitionOff.imagePaths, []);
    assert.match(characterDefinitionOff.systemBodyText, /# Output Boundary/);
    assert.match(characterDefinitionOff.systemBodyText, /# Tool Call Presence/);
    assert.match(characterDefinitionOff.inputBodyText, /# Conversation Timing/);
    assert.match(characterDefinitionOff.systemBodyText, /# Workspace/);
    assert.match(characterDefinitionOff.inputBodyText, /# User Input\n\n続けて/);
    assert.doesNotMatch(timingOff.inputBodyText, /# Conversation Timing/);
    assert.doesNotMatch(timingOff.inputBodyText, /Observed local time|2026-08-04T21:32/);
    assert.match(timingOff.systemBodyText, /# Character Definition Snapshot|Saved Character/);
    assert.match(timingOff.systemBodyText, /# Output Boundary/);
    assert.match(timingOff.systemBodyText, /# Tool Call Presence/);
    assert.match(timingOff.systemBodyText, /# Workspace/);
    assert.match(timingOff.inputBodyText, /# User Input\n\n続けて/);
    assert.match(toolCallPresenceOff.systemBodyText, /# Character Definition Snapshot|Saved Character/);
    assert.match(toolCallPresenceOff.systemBodyText, /# Output Boundary/);
    assert.match(toolCallPresenceOff.inputBodyText, /# Conversation Timing/);
    assert.doesNotMatch(toolCallPresenceOff.systemBodyText, /# Tool Call Presence/);
    assert.doesNotMatch(toolCallPresenceOff.systemBodyText, /最初の tool call より前に/);
    assert.match(toolCallPresenceOff.systemBodyText, /# Workspace/);
    assert.match(toolCallPresenceOff.inputBodyText, /# User Input\n\n続けて/);
    assert.doesNotMatch(toolCallPresenceOff.logicalPrompt.composedText, /# Tool Call Presence/);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "Character定義内のcode fenceより長い外側fenceでsnapshotを囲む"
  // oracle = { type = "contract", ref = "docs/design/prompt-composition.md" }
  // fault = "内側fenceが外側を閉じprompt境界を壊す"
  // observable = "systemBodyTextのfence長と囲み位置"
  // observation_boundary = "component-behavior"
  // scope = "character.md 内の code fence"
  // lifecycle = "permanent"
  // impact = "Character定義の一部が別prompt sectionとして解釈される"
  // distinction = "単純なMarkdown本文testではfence衝突を観測しない"
  // @end-test-value
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
      executionOptions: captureSessionExecutionOptions(session),
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
