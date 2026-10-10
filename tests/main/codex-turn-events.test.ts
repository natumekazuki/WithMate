import assert from "node:assert/strict";
import { toMessageOperations } from "../../src-electron/providers/codex/codex-event-projection.js";
import test from "node:test";
import {
  applyCodexTurnEvent,
  createCodexTurnStreamState,
  getLiveCodexAssistantPreview,
  getLiveCodexAssistantText,
  getLiveCodexReasoningPreview,
} from "../../src-electron/providers/codex/codex-turn-events.js";
import { PROVIDER_TEXT_PREVIEW_LIMIT, toProviderTextPreview } from "../../src-electron/session/provider-payload-limits.js";

// @test-value v2
// kind = "invariant"
// claim = "assistantとreasoningの置換・delta・terminal一括適用は最初のitem順序で原文とpreviewを保持する"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md: Codex projection owner / Streaming Policy" }
// fault = "cacheの更新順で並べ替える、separatorや省略長を誤る、全文をpreview長で失う"
// observable = "assistant全文、reasoning全文、両preview、terminal状態"
// observation_boundary = "component-behavior"
// scope = "codex-turn-events"
// lifecycle = "permanent"
// impact = "利用者の進捗本文と最終応答に欠落や順序逆転が生じる"
// distinction = "型検査では複数itemの置換とpreview境界の文字列結果を検証できず、既存adapter testは両preview APIを検証しない"
// @end-test-value
test("ordered text cache preserves replacements, deltas and bounded previews", () => {
  const state = createCodexTurnStreamState("thread");
  const apply = (method: string, params: Record<string, unknown>) => applyCodexTurnEvent(state, {
    method, params: { threadId: "thread", turnId: "turn", ...params },
  });
  apply("turn/started", { turn: { id: "turn" } });
  apply("item/started", { item: { id: "a", type: "agentMessage", text: " " } });
  apply("item/started", { item: { id: "r", type: "reasoning", summary: ["初期"], content: [] } });
  apply("item/started", { item: { id: "b", type: "agentMessage", text: "後" } });
  apply("item/started", { item: { id: "s", type: "reasoning", summary: [], content: ["後続"] } });
  const first = "x".repeat(PROVIDER_TEXT_PREVIEW_LIMIT - 1);
  apply("item/completed", { item: { id: "a", type: "agentMessage", text: first } });
  apply("item/agentMessage/delta", { itemId: "b", delta: "続" });
  apply("item/completed", { item: { id: "r", type: "reasoning", summary: [first], content: [] } });
  apply("item/reasoning/textDelta", { itemId: "s", contentIndex: 1, delta: "本文" });
  const assistant = `${first}\n\n後続`;
  const reasoning = `${first}\n\n後続\n本文`;
  assert.equal(getLiveCodexAssistantText(state), assistant);
  assert.equal(state.reasoningText, reasoning);
  assert.equal(getLiveCodexAssistantPreview(state), toProviderTextPreview(assistant));
  assert.equal(getLiveCodexReasoningPreview(state), toProviderTextPreview(reasoning));
  apply("turn/completed", { turn: { id: "turn", status: "completed", items: [
    { id: "s", type: "reasoning", summary: ["確定後続"], content: [] },
    { id: "b", type: "agentMessage", text: "確定後" },
    { id: "a", type: "agentMessage", text: "確定先" },
    { id: "r", type: "reasoning", summary: ["確定先行"], content: ["本文"] },
  ] } });
  assert.equal(getLiveCodexAssistantText(state), "確定先\n\n確定後");
  assert.equal(state.reasoningText, "確定先行\n本文\n\n確定後続");
  assert.equal(getLiveCodexAssistantPreview(state), "確定先\n\n確定後");
  assert.equal(getLiveCodexReasoningPreview(state), state.reasoningText);
  assert.equal(state.turnCompleted, true);
  const next = createCodexTurnStreamState("thread");
  assert.equal(getLiveCodexAssistantPreview(next), "");
  assert.equal(getLiveCodexReasoningPreview(next), "");
});

// @test-value v2
// kind = "invariant"
// claim = "表示の意味が変わるeventだけがrevisionを進め、重複・scope外・未知eventは進めずterminal一括更新は一回進める"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md: Codex projection owner" }
// fault = "不変eventでrevisionを進める、errorクリアを見逃す、terminalの各itemでrevisionを進める"
// observable = "event適用前後のrevision、error、usage、terminal状態"
// observation_boundary = "component-behavior"
// scope = "codex-turn-events"
// lifecycle = "permanent"
// impact = "表示更新の抑制が失われるかerror・terminal表示が更新されない"
// distinction = "revisionはWorker表示受付の契約であり、型検査や既存adapter応答testでは変更検出の値を確認しない"
// @end-test-value
test("revision follows visible changes and preserves scoped error clearing", () => {
  const state = createCodexTurnStreamState("thread");
  applyCodexTurnEvent(state, { method: "turn/started", params: { threadId: "thread", turn: { id: "turn" } } });
  const item = { id: "a", type: "agentMessage", text: "本文" };
  const accept = { method: "item/started", params: { threadId: "thread", turnId: "turn", item } };
  applyCodexTurnEvent(state, accept);
  const revision = state.revision;
  for (const event of [accept, { method: "unknown" },
    { ...accept, params: { ...accept.params, threadId: "other" } },
    { ...accept, params: { ...accept.params, turnId: "other" } },
    { method: "item/agentMessage/delta", params: { itemId: "a", delta: "" } },
  ]) applyCodexTurnEvent(state, event);
  assert.equal(state.revision, revision);
  const error = { method: "error", params: { error: { message: "retry" } } };
  applyCodexTurnEvent(state, error);
  assert.equal(state.revision, revision + 1);
  applyCodexTurnEvent(state, error);
  assert.equal(state.revision, revision + 1);
  applyCodexTurnEvent(state, accept);
  assert.equal(state.streamErrorMessage, "");
  assert.equal(state.revision, revision + 2);
  const usage = { method: "thread/tokenUsage/updated", params: { tokenUsage: {
    total: { inputTokens: 15, outputTokens: 4 }, last: { inputTokens: 5, outputTokens: 2 },
  } } };
  applyCodexTurnEvent(state, usage);
  const usageRevision = state.revision;
  applyCodexTurnEvent(state, usage);
  assert.equal(state.revision, usageRevision);
  assert.equal(state.usage?.inputTokens, 5);
  const terminal = { method: "turn/completed", params: { turn: { id: "turn", status: "failed", error: { message: "terminal" }, items: [
    { id: "a", type: "agentMessage", text: "確定" },
    { id: "r", type: "reasoning", summary: ["理由"], content: [] },
  ] } } };
  applyCodexTurnEvent(state, terminal);
  assert.equal(state.revision, usageRevision + 1);
  applyCodexTurnEvent(state, terminal);
  assert.equal(state.revision, usageRevision + 1);
  applyCodexTurnEvent(state, { method: "item/completed", params: { item: { ...item, text: "確定" } } });
  assert.equal(state.streamErrorMessage, "terminal");
  assert.equal(state.revision, usageRevision + 1);
});

// @test-value v2
// kind = "invariant"
// claim = "command deltaはpreview budgetと省略長を保持し、重複step通知で既存stepを置換せず過去stepを変更しない"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md: Codex projection owner; docs/design/provider-adapter.md" }
// fault = "同じstepを再setする、過去stepをmutateする、commandの元文字数を失う"
// observable = "liveStepsのstep参照、details、revisionとcommandのretained prefix長"
// observation_boundary = "component-behavior"
// scope = "codex-turn-events"
// lifecycle = "permanent"
// impact = "不要なstep転送・redactionが発生し、長いcommand出力の省略表示が不正になる"
// distinction = "既存budget testはdelta後のstep参照の不変性と重複通知の変更検出を確認しない"
// @end-test-value
test("command updates retain bounded output and stable unchanged steps", () => {
  const state = createCodexTurnStreamState("thread");
  const output = "a".repeat(PROVIDER_TEXT_PREVIEW_LIMIT + 1);
  const item = { type: "commandExecution", id: "command", command: "run", aggregatedOutput: output, exitCode: null, status: "inProgress" };
  const event = { method: "item/started", params: { item } };
  applyCodexTurnEvent(state, event);
  const initialStep = state.liveSteps.get("command");
  const revision = state.revision;
  applyCodexTurnEvent(state, event);
  assert.equal(state.liveSteps.get("command"), initialStep);
  assert.equal(state.revision, revision);
  applyCodexTurnEvent(state, { method: "item/commandExecution/outputDelta", params: { itemId: "command", delta: "後続" } });
  assert.equal(state.liveSteps.get("command")?.details, toProviderTextPreview(output + "後続"));
  assert.equal(initialStep?.details, toProviderTextPreview(output));
  assert.equal(state.revision, revision + 1);
  const retained = state.items.get("command");
  assert.equal(retained?.type === "commandExecution" && retained.aggregatedOutput?.length, PROVIDER_TEXT_PREVIEW_LIMIT);
});

// @test-value v2
// kind = "contract"
// claim = "Codexの操作はnative個別statusとexitCode/errorを保持しturn失敗で未確定操作を失敗へ補完しない"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md" }
// fault = "turn結果から個別結果を生成するか取得済みexitCode/error/truncationを落とす"
// observable = "native通知後のlive stepと通常履歴operationTimelineの順序・個別結果"
// observation_boundary = "component-behavior"
// scope = "Codex live and message operation projection"
// lifecycle = "permanent"
// impact = "失敗や取消turn内の成功・未確定コマンドを誤表示する"
// distinction = "型検査と既存本文testはnative個別結果からartifactへの投影を比較しない"
// @end-test-value
test("Codexは個別操作結果と未確定結果を通常履歴へ投影する", () => {
  const state = createCodexTurnStreamState("thread");
  applyCodexTurnEvent(state, { method: "item/completed", params: { item: {
    id: "first", type: "commandExecution", command: "check", status: "completed", exitCode: 0,
    aggregatedOutput: "x".repeat(PROVIDER_TEXT_PREVIEW_LIMIT + 5),
  } } });
  applyCodexTurnEvent(state, { method: "item/completed", params: { item: {
    id: "second", type: "mcpToolCall", server: "server", tool: "tool", status: "failed",
    arguments: {}, result: null, error: { message: "tool failure" },
  } } });
  applyCodexTurnEvent(state, { method: "item/started", params: { item: {
    id: "third", type: "commandExecution", command: "pending", status: "inProgress", exitCode: null, aggregatedOutput: null,
  } } });
  applyCodexTurnEvent(state, { method: "turn/completed", params: { turn: { id: "turn", status: "failed", items: [], error: { message: "turn failure" } } } });
  const operations = toMessageOperations([...state.items.values()]);
  assert.deepEqual(operations.map(({ id, status }) => ({ id, status })), [
    { id: "first", status: "completed" }, { id: "second", status: "failed" }, { id: "third", status: "in_progress" },
  ]);
  assert.equal(operations[0].exitCode, 0);
  assert.equal(operations[0].truncated, true);
  assert.deepEqual(operations[1].error, { message: "tool failure" });
  assert.equal(operations[2].exitCode, undefined);
  assert.equal(state.liveSteps.get("third")?.status, "in_progress");
  assert.equal(state.liveSteps.get("first")?.exitCode, 0);
});
