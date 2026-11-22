import assert from "node:assert/strict";
import path from "node:path";
import { it } from "node:test";
import { composeProviderInput, composeProviderPrompt } from "../../src-electron/providers/provider-prompt.js";
import { buildNewSession } from "../../src-shared/session/session-state.js";
import { captureSessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";
import { createDefaultAppSettings } from "../../src-shared/settings/provider-settings-state.js";
import type { RunSessionTurnInput } from "../../src-electron/providers/provider-runtime.js";
import { CodexAdapter } from "../../src-electron/providers/codex/codex-adapter.js";
import { CopilotAdapter } from "../../src-electron/providers/copilot/copilot-adapter.js";
import { ClaudeAdapter } from "../../src-electron/providers/claude/claude-adapter.js";
import { OpenCodeAdapter } from "../../src-electron/providers/opencode/opencode-adapter.js";

function input(): RunSessionTurnInput {
  const session = buildNewSession({ id: "sample", taskTitle: "Task", workspacePath: "C:/work", workspaceLabel: "Workspace", branch: "",
    characterId: "azki", character: "AZKi", characterIconPath: "", characterThemeColors: { main: "#fff", sub: "#000" }, approvalMode: "on-request" });
  session.sessionRole = "executor";
  session.characterRuntimeSnapshot = { characterId: "azki", name: "AZKi", description: "公開紹介", iconFilePath: "", theme: session.characterThemeColors,
    definitionMarkdown: "---\nschema: withmate.character.v1\nname: AZKi\n---\n# Kernel\n人格の正本文。", definitionSha256: "definition", definitionByteSize: 100, snapshotAt: "2026-11-01T00:00:00Z" };
  return { session, executionOptions: captureSessionExecutionOptions(session),
    providerCatalog: { id: "codex", label: "Codex", defaultModelId: session.model, defaultReasoningEffort: session.reasoningEffort, models: [] },
    appSettings: createDefaultAppSettings(), userMessage: "依頼本文", attachments: [], currentDateTime: "2026-11-01T12:00:00.000+09:00",
    sessionFolderPath: "C:/session-files/sample", crewFolderPath: "C:/crew-files/sample" };
}

// @test-value v2
// kind = "contract"
// claim = "4Providerの新規/継続入力は同じ人格・Role・現在日時・元依頼をsystem/inputの所定境界へ渡す"
// oracle = { type = "contract", ref = "docs/design/prompt-composition.md" }
// fault = "Provider固有経路で日時をsystemへ固定するかRole・人格・元依頼を取り落とす"
// observable = "4adapter.composePromptのsystemBodyText/inputBodyText/logicalPrompt"
// observation_boundary = "consumer"
// scope = "provider共通の新規/継続prompt"
// lifecycle = "permanent"
// @end-test-value
it("4Providerで新規/継続の共通prompt境界を保つ", () => {
  for (const adapter of [new CodexAdapter(), new CopilotAdapter(), new ClaudeAdapter(), new OpenCodeAdapter()]) for (const threadId of ["", "saved-thread"]) {
    const base = input(); base.session.threadId = threadId;
    const prompt = adapter.composePrompt(base);
    assert.match(prompt.systemBodyText, /# Kernel\n人格の正本文。/);
    assert.match(prompt.systemBodyText, /# Session Role\n\nexecutor$/);
    assert.match(prompt.systemBodyText, /成果物は、明示指定がなければrepository・提出先の文体と形式を優先/);
    assert.equal(prompt.inputBodyText, "# Current Date\n\n2026-11-01T12:00:00.000+09:00\n\n# User Input\n\n依頼本文");
    assert.equal(prompt.logicalPrompt.systemText, prompt.systemBodyText);
    assert.equal(prompt.logicalPrompt.inputText, prompt.inputBodyText);
    assert.equal(prompt.logicalPrompt.composedText, prompt.systemBodyText + "\n\n" + prompt.inputBodyText);
  }
});

// @test-value v2
// kind = "contract"
// claim = "snapshotとownerから人格/Roleを選び、定義内backtickを保つfenceとauthoring・設定OFF・neutralの作業先/原依頼を保つ"
// oracle = { type = "contract", ref = "docs/design/prompt-composition.md#設定とSession種別" }
// fault = "AuxへMainのRoleを渡すか設定切替で別のcontextや原依頼を失う"
// observable = "composerのRole・人格・日時・folder"
// observation_boundary = "public-boundary"
// scope = "通常/authoring/neutral/Auxiliaryと個別toggle"
// lifecycle = "permanent"
// @end-test-value
it("Session種別・owner・toggleを適用し作業境界を保つ", () => {
  const base = input(); base.executionWorkspacePath = "C:/actual"; base.session.allowedAdditionalDirectories = ["C:/external"];
  const normal = composeProviderPrompt(base);
  assert.match(normal.systemBodyText, /# Workspace\n\nC:\/actual/);
  assert.match(normal.systemBodyText, /# SessionFolder\n\nC:\/session-files\/sample/);
  assert.match(normal.systemBodyText, /# Crew Folder\n\nC:\/crew-files\/sample/);
  assert.deepEqual(normal.additionalDirectories, [path.resolve("C:/external")]);
  assert.match(composeProviderPrompt({ ...base, runtimeOwner: { kind: "auxiliary", id: "aux", incarnationId: "v1" } }).systemBodyText, /# Session Role\n\nauxiliary$/);
  const characterOff = composeProviderPrompt({ ...base, appSettings: { ...base.appSettings, characterDefinitionEnabled: false } });
  assert.equal(characterOff.inputBodyText, normal.inputBodyText);
  assert.ok(!characterOff.systemBodyText.includes("# Character Definition Snapshot"));
  const dateOff = composeProviderPrompt({ ...base, appSettings: { ...base.appSettings, currentDateEnabled: false } });
  assert.equal(dateOff.systemBodyText, normal.systemBodyText);
  assert.equal(dateOff.inputBodyText, "# User Input\n\n依頼本文");
  const authoring = composeProviderPrompt({ ...base, session: { ...base.session, sessionKind: "character-authoring" } });
  assert.match(authoring.systemBodyText, /# Kernel\n人格の正本文。/);
  assert.equal(authoring.inputBodyText, "# User Input\n\n依頼本文");
  assert.ok(!authoring.systemBodyText.includes("# Session Role"));
  const neutral = composeProviderPrompt({ ...base, session: { ...base.session, characterRuntimeSnapshot: null } });
  assert.match(neutral.systemBodyText, /# Workspace/);
  assert.match(neutral.systemBodyText, /# Session Role\n\nexecutor$/);
  assert.equal(neutral.inputBodyText, normal.inputBodyText);
  assert.equal(composeProviderInput("  "), "");
  const nested = composeProviderPrompt({ ...base, session: { ...base.session, characterRuntimeSnapshot: {
    ...base.session.characterRuntimeSnapshot!, definitionMarkdown: "# Kernel\n```text\n内側の定義\n```",
  } } });
  assert.ok(nested.systemBodyText.includes("````markdown\n# Kernel\n```text\n内側の定義\n```\n````"));
});

// @test-value v2
// kind = "contract"
// claim = "GUI/Session/Auxiliary/unknownの出所・参照・send/steer・null/真偽を元依頼と分離する"
// oracle = { type = "contract", ref = "docs/design/prompt-composition.md" }
// fault = "不明をGUIやfalseへ補完するか送り元ID/世代/Turn/操作を混同する"
// observable = "composeProviderInputの来歴fieldと末尾の原依頼"
// observation_boundary = "public-boundary"
// scope = "来歴の表示投影"
// lifecycle = "permanent"
// @end-test-value
it("実話者・操作・参照・比較状態をデータとして保持する", () => {
  const target = { targetSessionId: "self", targetIncarnationId: "v1" };
  const gui = composeProviderInput("依頼", { origin: { kind: "gui", operation: "send", ...target }, originalChanged: false });
  assert.match(gui, /Sender: GUI user \(local-user\)/); assert.match(gui, /Changed since acceptance: false/);
  for (const kind of ["main", "auxiliary"] as const) {
    const text = composeProviderInput("依頼", { origin: { kind: "session", operation: "send", actorKind: kind, actorSessionId: "peer\nID", actorIncarnationId: "v2", actorTurnId: "42", actorMainSessionId: kind === "auxiliary" ? "owner" : undefined,
      actorSnapshot: { sessionTitle: "Peer", character: { id: "peer", name: "Peer", iconPath: "" } }, ...target }, originalChanged: true });
    assert.match(text, /Character: "Peer" \/ ID: "peer"/); assert.ok(text.includes('Session: "peer\\nID"'));
    assert.ok(text.includes('Kind: "' + kind + '"')); assert.match(text, /Incarnation: "v2"\nKind:.*\nSource Turn: "42"/);
    if (kind === "auxiliary") assert.match(text, /Owner Main Session: "owner"/);
    assert.ok(text.endsWith("# Session Input\n\n依頼"));
  }
  const steer = composeProviderInput("追加指示", { origin: { kind: "session", operation: "steer", actorKind: "main", actorSessionId: "peer", actorIncarnationId: "v2", actorTurnId: "43", ...target }, originalChanged: null });
  assert.match(steer, /Operation: "steer"\nChanged since acceptance: null/);
  assert.equal(composeProviderInput("依頼", { origin: null, originalChanged: null }), "# Input Provenance\n\nSender: unknown\nOperation: null\nChanged since acceptance: null\n\n# Queued Input\n\n依頼");
});

// @test-value v2
// kind = "contract"
// claim = "Coordination通知は輸送元と回答者を分け通知objectと原依頼を損失なく渡す"
// oracle = { type = "contract", ref = "src-shared/coordination/coordination-delivery.ts" }
// fault = "回答者userを輸送元Agentへ置換するか通知本文・回答世代・状態を省く"
// observable = "composerのCoordination objectと原依頼"
// observation_boundary = "public-boundary"
// scope = "Coordination入力投影"
// lifecycle = "permanent"
// @end-test-value
it("Coordination通知とユーザー回答者を原値で渡す", () => {
  const notice = { coordinationId: "c", kind: "decision" as const, consultation: "相談", actor: { kind: "main" as const, sessionId: "peer", incarnationId: "v2", turnId: "42" }, operation: "answer",
    answer: { id: "a", revision: 2, actor: { kind: "user" as const }, body: "回答", selectedChoices: ["選択"], createdAt: "2026-11-01T00:00:00Z" }, state: "resolved" as const, withdrawalReason: null };
  const text = composeProviderInput("元の回答本文", { origin: { kind: "session", operation: "send", actorKind: "main", actorSessionId: "peer", actorIncarnationId: "v2", actorTurnId: "42", targetSessionId: "self", targetIncarnationId: "v1" }, originalChanged: false, coordinationOperation: "answer", coordination: notice });
  assert.match(text, /Sender: Session/); assert.match(text, /Coordination operation: "answer"/);
  assert.deepEqual(JSON.parse(text.split("Coordination:\n")[1]!.split("\n\n# Session Input")[0]!), notice);
  assert.ok(text.endsWith("# Session Input\n\n元の回答本文"));
});

// @test-value v2
// kind = "contract"
// claim = "今回の保存入力と最終回答目印とは別に、明示返信の必要IDだけが来歴後・本文前へ入る"
// oracle = { type = "contract", ref = "docs/design/prompt-composition.md#metadataと必要時取得" }
// fault = "未指定入力や見出し風の本文から参照を生成する、識別情報を元本文と混ぜる、受付と保存seqを取り違える"
// observable = "実共通builderのsystemとinput、および同じ入力の明示なし・保存発言・受付参照の差"
// observation_boundary = "public-boundary"
// scope = "通常TurnとSteerが使う共通provider入力"
// lifecycle = "permanent"
// impact = "Agentが別メッセージを返信先と扱うか不要本文がコンテキストへ入る"
// distinction = "レンダラーの引用表示とSQLiteの参照保管だけではProviderへ渡る位置・最小情報を確認できない"
// @end-test-value
it("返信の必要IDのみを来歴と原文の間に置く", () => {
  const base = input();
  const target = { kind: "main" as const, sessionId: "original", incarnationId: "generation" };
  const copiedHeading = "# Reply To\n\nseq: 99\n\nこれはそのままの本文";
  const common: RunSessionTurnInput = { ...base, userMessage: copiedHeading,
    inputProvenance: { origin: { kind: "gui", operation: "send", targetSessionId: "sample", targetIncarnationId: "current" }, originalChanged: false },
    messageIdentity: { sessionId: "sample", incarnationId: "current", seq: 8, finalAnswerTurnId: "12" },
  };
  const plain = composeProviderPrompt(common);
  assert.match(plain.systemBodyText, /# Reply References\n\n.*get_message.*get_execution_input.*finalAnswerTurnId/);
  assert.ok(plain.inputBodyText.includes('# Message Identity\n\nsessionId: "sample"\nincarnationId: "current"\nseq: 8\nfinalAnswerTurnId: "12"\n\n# Input Provenance'));
  assert.ok(!plain.inputBodyText.split("# User Input")[0]!.includes("# Reply To"));
  const reply = composeProviderPrompt({ ...common, replyTo: { target, seq: 4, finalAnswerTurnId: "7" } });
  assert.ok(reply.inputBodyText.endsWith('Changed since acceptance: false\n\n# Reply To\n\nsessionId: "original"\nincarnationId: "generation"\nseq: 4\nfinalAnswerTurnId: "7"\n\n# User Input\n\n' + copiedHeading));
  const receiptId = "11111111-1111-4111-8111-111111111111";
  const receipt = composeProviderInput("補足", undefined, false, { replyTo: { target, receiptId } });
  assert.equal(receipt, '# Reply To\n\nsessionId: "original"\nincarnationId: "generation"\nreceiptId: "' + receiptId + '"\n\n# User Input\n\n補足');
});
