import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { CodexTurnInteractions, type CodexInteractionRequest } from "../../src-electron/providers/codex/codex-app-server-interactions.js";
import type { LiveElicitationRequest, LiveElicitationResponse } from "../../src-shared/session/runtime-state.js";

function request(id: string | number, method: string, params: unknown) {
  const results: unknown[] = [];
  const errors: unknown[] = [];
  const wire: CodexInteractionRequest = { id, method, params, respond: async (result) => { results.push(result); }, reject: async (error) => { errors.push(error); } };
  return { wire, results, errors };
}

function question(id: string, options: unknown = null, isOther = false, isSecret = false) {
  return { id, header: id, question: `Answer ${id}`, options, isOther, isSecret };
}

const command = "item/commandExecution/requestApproval";
const inputMethod = "item/tool/requestUserInput";
const mcpMethod = "mcpServer/elicitation/request";

// @test-value v2
// kind = "invariant"
// claim = "承認・質問・MCPを一つずつ表示し元のRPCへ回答する"
// oracle = { type = "contract", ref = "Issue #780: concurrent server requests use the one-slot interaction services" }
// fault = "異種requestを同時表示してcallbackを上書きする"
// observable = "callback表示順と各requestのRPC応答"
// observation_boundary = "consumer"
// scope = "CodexTurnInteractions"
// lifecycle = "permanent"
// impact = "利用者が別の操作を誤承認する"
// distinction = "型検査では非同期callback競合を検出できない"
// @end-test-value
test("serializes approval, native question and MCP with original response ports", async () => {
  const shown: string[] = [];
  let release!: (value: "approve") => void;
  const helper = new CodexTurnInteractions({
    onApprovalRequest: () => { shown.push("approval"); return new Promise((resolve) => { release = resolve; }); },
    onElicitationRequest: (ui): LiveElicitationResponse => { shown.push(ui.source ?? "question"); return { action: "accept", content: ui.source ? { count: 2 } : { q: "yes" } }; },
  });
  const first = request(1, command, { command: "echo test" });
  const second = request("1", inputMethod, { isBlocking: false, questions: [question("q")] });
  const third = request(2, mcpMethod, { mode: "form", serverName: "MCP", message: "Count", requestedSchema: { type: "object", properties: { count: { type: "integer", minimum: 1 } }, required: ["count"] } });
  helper.accept(first.wire); helper.accept(second.wire); helper.accept(third.wire);
  await setImmediate();
  assert.deepEqual(shown, ["approval"]);
  release("approve");
  await setImmediate();
  assert.deepEqual(shown, ["approval", "question", "MCP"]);
  assert.deepEqual(first.results, [{ decision: "accept" }]);
  assert.deepEqual(JSON.parse(JSON.stringify(second.results)), [{ answers: { q: { answers: ["yes"] } } }]);
  assert.deepEqual(third.results, [{ action: "accept", content: { count: 2 } }]);
  helper.close();
});

// @test-value v2
// kind = "invariant"
// claim = "resolvedは該当requestだけを取り消し次の表示を可能にする"
// oracle = { type = "contract", ref = "Issue #780: serverRequest/resolved clears queued and visible interactions" }
// fault = "解決済みcallbackが次のRPCへ回答する、またはqueueを停止する"
// observable = "callback signalと元RPCの応答件数"
// observation_boundary = "consumer"
// scope = "CodexTurnInteractions cancellation"
// lifecycle = "permanent"
// impact = "解決済み承認画面が残りturnが進まない"
// distinction = "callbackがabortを無視する場合の進行はruntime検証が必要"
// @end-test-value
test("resolves visible and queued requests without stale response or numeric/string ID mixup", async () => {
  const signals: AbortSignal[] = [];
  const releases: ((value: "approve") => void)[] = [];
  const helper = new CodexTurnInteractions({ onApprovalRequest: (_ui, signal) => {
    signals.push(signal!); return new Promise((resolve) => releases.push(resolve));
  } });
  const first = request(1, command, {});
  const queued = request(2, command, {});
  const next = request("1", command, {});
  helper.accept(first.wire); helper.accept(queued.wire); helper.accept(next.wire);
  await setImmediate();
  helper.resolve(2); helper.resolve(1);
  await setImmediate();
  assert.equal(signals.length, 2);
  assert.equal(signals[0].aborted, true);
  assert.equal(signals[1].aborted, false);
  releases[0]("approve"); releases[1]("approve");
  await setImmediate();
  assert.deepEqual(first.results, []); assert.deepEqual(queued.results, []);
  assert.deepEqual(next.results, [{ decision: "accept" }]);
  helper.close();
});

// @test-value v2
// kind = "invariant"
// claim = "turn終了やabortは全pending表示を撤回し応答しない"
// oracle = { type = "contract", ref = "Issue #780: terminal, abort and disconnect cancel individual interactions" }
// fault = "切断後の遅延回答をRPCへ送信する"
// observable = "abort signal、表示件数、応答とerror件数"
// observation_boundary = "consumer"
// scope = "CodexTurnInteractions shutdown"
// lifecycle = "permanent"
// impact = "別turnへの古い回答混入と表示残留"
// distinction = "型とschemaでは終了と回答の競合を検出できない"
// @end-test-value
test("turn abort and close abort visible request and drop the queue", async () => {
  for (const abortTurn of [true, false]) {
    const turn = new AbortController();
    let uiSignal: AbortSignal | undefined;
    let release!: (response: LiveElicitationResponse) => void;
    let calls = 0;
    const helper = new CodexTurnInteractions({ signal: turn.signal, onElicitationRequest: (_ui, signal) => {
      calls++; uiSignal = signal; return new Promise((resolve) => { release = resolve; });
    } });
    const first = request(1, inputMethod, { isBlocking: true, questions: [question("q")] });
    const second = request(2, inputMethod, { isBlocking: true, questions: [question("q")] });
    helper.accept(first.wire); helper.accept(second.wire);
    await setImmediate();
    if (abortTurn) turn.abort(); else helper.close();
    release({ action: "accept", content: { q: "late" } });
    await setImmediate();
    assert.equal(uiSignal?.aborted, true); assert.equal(calls, 1);
    assert.deepEqual(first.results, []); assert.deepEqual(first.errors, []); assert.deepEqual(second.results, []);
  }
});

// @test-value v2
// kind = "invariant"
// claim = "質問のtext・secret・単一option・Otherとnonblockingを明示回答で処理する"
// oracle = { type = "contract", ref = "Codex 0.159.0 ToolRequestUserInputParams/Question: options nullable, isOther, isSecret, isBlocking" }
// fault = "optionなしを拒否または自動回答しsecretを平文表示する"
// observable = "UI投影とRPC answersおよびinvalid回答のreject"
// observation_boundary = "consumer"
// scope = "native Codex user input"
// lifecycle = "permanent"
// impact = "利用者入力が欠落し秘密が表示される"
// distinction = "schema型だけではUI投影と回答制約を確認できない"
// @end-test-value
test("projects nullable questions, secret input and one-option choices without auto answering", async () => {
  let ui!: LiveElicitationRequest;
  let release!: (response: LiveElicitationResponse) => void;
  const helper = new CodexTurnInteractions({ onElicitationRequest: (value) => { ui = value; return new Promise((resolve) => { release = resolve; }); } });
  const pending = request(3, inputMethod, { isBlocking: false, autoResolutionMs: 0, questions: [
    question("text"), question("secret", null, false, true), question("single", [{ label: "Only", description: "one" }]), question("other", [{ label: "Option", description: "" }], true),
  ] });
  helper.accept(pending.wire);
  await setImmediate();
  assert.equal(ui.blocking, false);
  assert.equal(ui.fields[0].type, "text");
  assert.equal(ui.fields[1].type === "text" && ui.fields[1].secret, true);
  assert.equal(ui.fields[2].type === "select" && ui.fields[2].options.length, 1);
  assert.equal(ui.fields[3].type === "select" && ui.fields[3].allowFreeText, true);
  assert.deepEqual(pending.results, []);
  release({ action: "accept", content: { text: "typed", secret: "hidden", single: "Only", other: "custom" } });
  await setImmediate();
  assert.deepEqual(JSON.parse(JSON.stringify(pending.results)), [{ answers: { text: { answers: ["typed"] }, secret: { answers: ["hidden"] }, single: { answers: ["Only"] }, other: { answers: ["custom"] } } }]);
  const invalid = request(4, inputMethod, { isBlocking: true, questions: [question("single", [{ label: "Only", description: "" }])] });
  helper.accept(invalid.wire); await setImmediate(); release({ action: "accept", content: { single: "invalid" } }); await setImmediate();
  assert.equal(invalid.errors.length, 1); assert.deepEqual(invalid.results, []);
  helper.close();
});

// @test-value v2
// kind = "invariant"
// claim = "承認は単回acceptかrequested permission subsetだけを与えbackgroundは拒否する"
// oracle = { type = "contract", ref = "Codex 0.159.0 approval response schemas and Issue #780 permission preservation" }
// fault = "sessionへ権限を拡大またはcallbackなしでgrantする"
// observable = "decision・permissions・scopeとcallback件数"
// observation_boundary = "consumer"
// scope = "Codex approval safety"
// lifecycle = "permanent"
// risk_tags = ["authorization"]
// impact = "要求外のコマンド実行やfilesystem権限が許可される"
// distinction = "response schemaではrequested subsetと利用者承認を保証できない"
// @end-test-value
test("honors available decisions, grants only requested turn permissions and denies unattended", async () => {
  let calls = 0;
  const helper = new CodexTurnInteractions({ onApprovalRequest: () => { calls++; return "approve"; } });
  const restricted = request(1, command, { availableDecisions: ["acceptForSession", "cancel"] });
  const permissions = { network: { enabled: true }, fileSystem: { read: ["C:/work"], write: ["C:/work/tmp"] } };
  const grant = request(2, "item/permissions/requestApproval", { permissions });
  helper.accept(restricted.wire); helper.accept(grant.wire); await setImmediate();
  assert.deepEqual(restricted.results, [{ decision: "cancel" }]); assert.equal(calls, 1);
  assert.deepEqual(grant.results, [{ permissions, scope: "turn" }]);
  helper.close();
  const unattended = new CodexTurnInteractions({});
  const deniedCommand = request(1, command, {});
  const deniedPermissions = request(2, "item/permissions/requestApproval", { permissions });
  const noQuestionUi = request(3, inputMethod, { isBlocking: true, questions: [question("q")] });
  unattended.accept(deniedCommand.wire); unattended.accept(deniedPermissions.wire); unattended.accept(noQuestionUi.wire); await setImmediate();
  assert.deepEqual(deniedCommand.results, [{ decision: "decline" }]);
  assert.deepEqual(deniedPermissions.results, [{ permissions: {}, scope: "turn" }]);
  assert.equal(noQuestionUi.errors.length, 1); unattended.close();
});

// @test-value v2
// kind = "invariant"
// claim = "MCP formは対応制約を検査し未対応schemaを成功にしない、URLは別modeで表示する"
// oracle = { type = "contract", ref = "Codex 0.159.0 McpServerElicitationRequestParams and McpElicitationSchema" }
// fault = "数値制約や未知schemaを無視してacceptを送信する"
// observable = "MCP RPC action/content、rejectとUI mode"
// observation_boundary = "consumer"
// scope = "Codex MCP elicitation"
// lifecycle = "permanent"
// impact = "MCP serverへ利用者が承認していない不正入力が送られる"
// distinction = "UI validatorを通らないcallbackでもwire前の検査が必要"
// @end-test-value
test("validates MCP form constraints, unsupported shapes and URL mode", async () => {
  const modes: string[] = [];
  const helper = new CodexTurnInteractions({ onElicitationRequest: (ui) => { modes.push(ui.mode); return { action: "accept", content: ui.mode === "url" ? undefined : { value: 1.5 } }; } });
  const numeric = request(1, mcpMethod, { mode: "form", serverName: "s", message: "m", requestedSchema: { type: "object", properties: { value: { type: "integer", minimum: 2 } }, required: ["value"] } });
  const unsupported = request(2, mcpMethod, { mode: "form", serverName: "s", message: "m", requestedSchema: { type: "object", properties: { value: { type: "string", pattern: "x" } } } });
  const url = request(3, mcpMethod, { mode: "url", serverName: "s", message: "login", url: "https://example.test/verify" });
  helper.accept(numeric.wire); helper.accept(unsupported.wire); helper.accept(url.wire); await setImmediate();
  assert.equal(numeric.errors.length, 1); assert.deepEqual(numeric.results, []);
  assert.equal(unsupported.errors.length, 1); assert.deepEqual(unsupported.results, []);
  assert.deepEqual(modes, ["form", "url"]); assert.deepEqual(url.results, [{ action: "accept", content: null }]); helper.close();
});

// @test-value v2
// kind = "invariant"
// claim = "RPC応答書込みが失敗しても二度目のrejectを送らずfailureを通知する"
// oracle = { type = "contract", ref = "Issue #780: a server request is answered at most once; disconnect fails the active turn" }
// fault = "respond失敗を隠すか同一RPCへerrorを追加送信する"
// observable = "respond/reject件数とonError"
// observation_boundary = "consumer"
// scope = "Codex interaction transport failure"
// lifecycle = "permanent"
// impact = "切断を成功と誤認または二重応答によるprotocol不整合"
// distinction = "transport failure after response reservation is an asynchronous boundary"
// @end-test-value
test("reports response write failure without duplicate response", async () => {
  const failure = new Error("write failed");
  const errors: unknown[] = [];
  let writes = 0;
  let rejects = 0;
  const helper = new CodexTurnInteractions({}, undefined, (error) => errors.push(error));
  helper.accept({ id: 1, method: command, params: {}, respond: async () => { writes++; throw failure; }, reject: async () => { rejects++; } });
  await setImmediate();
  assert.equal(writes, 1); assert.equal(rejects, 0); assert.deepEqual(errors, [failure]); helper.close();
});
