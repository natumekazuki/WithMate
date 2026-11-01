import assert from "node:assert/strict";
import { test } from "node:test";
import { buildManagedHttpMcpServers, buildCodexManagedHttpMcpConfig, buildCodexManagedHttpMcpArguments } from "../../src-electron/providers/managed-http-mcp.js";
import { authorizeSessionHistoryRead } from "../../src-electron/providers/session-history-runtime-authorization.js";
import { runWithRuntimeTurnAdmission } from "../../src-electron/platform/memory/runtime-turn-admission.js";
import { backgroundHistoryFixture as fixture, owner, readOperation } from "../helpers/background-history-fixture.js";

// @test-value v2
// kind = "contract"
// claim = "同じ実Sessionで通常次turnと同Provider背景が共存し、別Provider背景も固定した保存履歴だけを読める"
// oracle = { type = "contract", ref = "docs/design/background-execution.md" }
// fault = "背景発行や通常binding置換が相互失効するか、別Providerを元SessionのProviderとして扱いreadを拒否する"
// observable = "実MCP tools listと保存本文、背景発行/終了前後の通常Glossary接続、通常generation、各handleのadmission、Provider builderのendpoint一覧"
// observation_boundary = "public-boundary"
// scope = "real binding/handle/HTTP host/runtime exchange with saved source fixture"
// lifecycle = "permanent"
// impact = "会話の継続が背景を待つ、または用途の選択Providerで正当な履歴readができなくなる"
// distinction = "通常turn testと型検査では同じ実Sessionからの背景接続との共存を観測しない。推論なしで認可経路を検証する"
// @end-test-value
test("通常次turnと同Provider・別Providerの背景が同じ保存sourceを独立参照する", async () => {
  const f = await fixture();
  try {
    const normal = f.bindings.issueOrReuse({ actorSessionId: "main", providerId: "codex", operationGrants: ["memory.route.list_targets"] });
    const first = f.turns.begin({ actorSessionId: "main", providerId: "codex" });
    const normalProjection = { ...normal, memoryRuntimeOwner: owner, turnCapability: first.capability };
    const normalConnection = await f.connect({ ...normalProjection, managedMcp: f.host.issue(normalProjection, first) }, "glossaryUrl");
    const normalTools = (await normalConnection.client.listTools()).tools;
    const codex = f.started();
    const claude = f.started("main", "claude", "target-memory");
    const codexBinding = f.project(codex);
    const claudeBinding = f.project(claude);
    assert.deepEqual((await normalConnection.client.listTools()).tools, normalTools);
    f.turns.end(first);
    const nextBinding = f.bindings.issueOrReuse({ actorSessionId: "main", providerId: "codex", operationGrants: ["memory.route.search"] });
    const next = f.turns.begin({ actorSessionId: "main", providerId: "codex" });
    const nextProjection = { ...nextBinding, memoryRuntimeOwner: owner, turnCapability: next.capability };
    const nextConnection = await f.connect({ ...nextProjection, managedMcp: f.host.issue(nextProjection, next) }, "glossaryUrl");
    const nextTools = (await nextConnection.client.listTools()).tools;
    assert.notEqual(normal.bindingId, nextBinding.bindingId);
    f.db.prepare("INSERT INTO session_messages_v6(session_id,seq,role,body,created_at) VALUES ('main',2,'user',?,'now')")
      .run(JSON.stringify({ text: "later turn" }));
    const a = await f.connect(codexBinding);
    const b = await f.connect(claudeBinding);
    assert.deepEqual((await a.client.listTools()).tools.map((tool) => tool.name), ["session_history.list_messages", "session_history.get_message", "session_history.list_operations", "session_history.get_operation_detail"]);
    for (const client of [a.client, b.client]) {
      assert.deepEqual((await client.callTool({ name: "session_history.get_message", arguments: { seq: 0 } })).structuredContent,
        { ok: true, seq: 0, role: "user", text: "saved source", offset: 0, nextOffset: null, totalChars: 12, turn: null });
      assert.deepEqual((await client.callTool({ name: "session_history.get_message", arguments: { seq: 2 } })).structuredContent,
        { ok: false, code: "HISTORY_OUT_OF_RANGE", message: "The requested message is outside the permitted history range.", effect: "none" });
    }
    assert.equal(f.turns.admit({ actorSessionId: "main", providerId: "codex", turnCapability: next.capability }).ok, true);
    assert.equal(f.bindings.getExecutionGeneration("main", "codex"), nextBinding.executionGeneration);
    assert.deepEqual(Object.keys(buildManagedHttpMcpServers(codexBinding)!), ["withmate-session-history"]);
    assert.deepEqual(Object.keys(buildCodexManagedHttpMcpConfig(codexBinding)), ["withmate-session-history-http"]);
    assert.match(buildCodexManagedHttpMcpArguments(codexBinding).join(" "), /mcp_servers.withmate-session-history-http=/);
    assert.equal(f.sessions.get("main")!.provider, "codex");
    f.executions.finish(codex);
    f.executions.finish(claude);
    assert.deepEqual((await nextConnection.client.listTools()).tools, nextTools);
    f.turns.end(next);
  } finally { await f.close(); }
});

// @test-value v2
// kind = "contract"
// claim = "通常turnと背景の許可外直接操作は拒否され、別bindingやcapability欠落でread権限を作れない"
// oracle = { type = "contract", ref = "docs/design/background-execution.md#履歴readの共通契約" }
// fault = "tool非表示だけで認可を済ませ、直接callや通常turnへ背景read・Memory writeを許可する"
// observable = "authorizeの拒否code、HTTP 403、継続可能な正当read"
// observation_boundary = "public-boundary"
// scope = "dedicated MCP endpoint and exact operation grant"
// lifecycle = "permanent"
// impact = "元会話の情報公開範囲か補助処理の読取限定を突破できる"
// distinction = "正常readや公開tool一覧だけでは直接requestの認可を検証できない。固定入力で拒否と正当readの両方を確認する"
// risk_tags = ["authorization", "privacy"]
// @end-test-value
test("専用endpointと具体的grantで通常turn・許可外操作・別bindingを拒否する", async () => {
  const f = await fixture();
  try {
    const execution = f.started("main", "codex", "affect", undefined, [readOperation]);
    const binding = f.project(execution);
    const { client, transport } = await f.connect(binding);
    assert.equal((await f.request(binding, binding.managedMcp!.sessionHistoryUrl!, "session_history.list_operations", transport.sessionId)).status, 403);
    assert.equal((await f.request(binding, binding.managedMcp!.sessionHistoryUrl!, "memory.append", transport.sessionId)).status, 403);
    assert.equal((await f.request(binding, binding.managedMcp!.memoryUrl, "memory.append")).status, 403);
    const normal = f.bindings.issueOrReuse({ actorSessionId: "main", providerId: "codex", operationGrants: [readOperation] });
    const turn = f.turns.begin({ actorSessionId: "main", providerId: "codex" });
    const projected = { ...normal, memoryRuntimeOwner: owner, turnCapability: turn.capability };
    const ordinary = { ...projected, managedMcp: f.host.issue(projected, turn) };
    assert.equal((await f.request(ordinary, binding.managedMcp!.sessionHistoryUrl!, "session_history.get_message")).status, 403);
    const auth = (reference: string, capability?: string, operation = readOperation) => authorizeSessionHistoryRead({ bindings: f.bindings, turns: f.turns },
      { bindingReference: reference, turnCapability: capability, operation });
    assert.deepEqual(auth(normal.bindingReference, turn.capability), { ok: false, code: "SESSION_BINDING_FORBIDDEN" });
    assert.deepEqual(auth(binding.bindingReference), { ok: false, code: "SESSION_BINDING_INVALID" });
    assert.deepEqual(auth(binding.bindingReference, turn.capability), { ok: false, code: "SESSION_BINDING_INVALID" });
    assert.deepEqual(auth(binding.bindingReference, binding.turnCapability, "session_history.route.list_operations"), { ok: false, code: "SESSION_BINDING_FORBIDDEN" });
    assert.partialDeepStrictEqual((await client.callTool({ name: "session_history.get_message", arguments: { seq: 0 } })).structuredContent, { ok: true });
    f.host.release(turn);
  } finally { await f.close(); }
});

// @test-value v2
// kind = "contract"
// claim = "native終端でHTTP tokenは失効するが保存admissionは残り、論理finish・取消後は同じadmissionが拒否される"
// oracle = { type = "contract", ref = "docs/design/background-execution.md#接続と論理実行の寿命" }
// fault = "tool接続の閉鎖が保存まで失効するか、finish後も未確定保存を認可する"
// observable = "旧tokenのHTTP 401、保存callbackの実行回数、admissionの例外、取消signal"
// observation_boundary = "public-boundary"
// scope = "native completion versus logical application completion"
// lifecycle = "permanent"
// impact = "正常生成結果を保存できないか、取消済みの遅延結果を適用する"
// distinction = "通常turnの一段階endのtestでは二つの寿命を区別できない。保存callbackはfixtureでatomic保存の証明ではない"
// @end-test-value
test("MCPを閉じてから論理finishまでの保存admissionを保持する", async () => {
  const f = await fixture();
  try {
    const execution = f.started();
    const binding = f.project(execution);
    f.executions.nativeCompleted(execution);
    assert.equal((await f.request(binding, binding.managedMcp!.sessionHistoryUrl!, "session_history.get_message")).status, 401);
    let saved = 0;
    runWithRuntimeTurnAdmission(execution.admission, () => { saved += 1; });
    assert.equal(saved, 1);
    f.executions.finish(execution);
    assert.throws(() => runWithRuntimeTurnAdmission(execution.admission, () => { saved += 1; }), /no longer active/);
    const cancelled = f.started();
    f.executions.cancel(cancelled.binding.bindingId);
    assert.equal(cancelled.signal.aborted, true);
    assert.throws(() => runWithRuntimeTurnAdmission(cancelled.admission, () => undefined), /no longer active/);
  } finally { await f.close(); }
});

// @test-value v2
// kind = "contract"
// claim = "親Sessionの失効通知がMainと配下Auxiliaryの背景実行・保存admissionを終了する"
// oracle = { type = "contract", ref = "docs/adr/035-background-execution-binding-and-history-scope.md" }
// fault = "親失効時にAuxiliaryの背景bindingを列挙せず、未確定保存の権限を残す"
// observable = "親失効後のMain/Auxiliary signalと保存admission例外"
// observation_boundary = "public-boundary"
// scope = "source/parent binding revocation"
// lifecycle = "permanent"
// impact = "再作成された別会話の本文が古い背景処理へ公開される"
// distinction = "storageのsource拒否とは異なり、既存親失効通知で実行と未確定保存の両方が終了することを確認する"
// risk_tags = ["authorization", "privacy"]
// @end-test-value
test("親Session失効がMainとAuxiliaryの背景保存権限を終了する", async () => {
  const f = await fixture();
  try {
    const main = f.started();
    const aux = f.started("aux");
    f.bindings.revokeSession("main");
    assert.equal(aux.signal.aborted, true);
    assert.equal(main.signal.aborted, true);
    for (const execution of [main, aux]) assert.throws(() => runWithRuntimeTurnAdmission(execution.admission, () => undefined), /no longer active/);
  } finally { await f.close(); }
});

// @test-value v2
// kind = "contract"
// claim = "全体3・用途会話1の起動見送りはbindingを増やさず、現在のread-onlyとauthoring sourceを背景に採用しない"
// oracle = { type = "contract", ref = "docs/design/background-execution.md#共通基盤の責務" }
// fault = "満杯で実行を積み増す、source保護を新旧accessModeだけの比較で落とす、または制作会話を自動記録対象にする"
// observable = "beginのreason、binding件数、終了後の再受付、source適格性の例外"
// observation_boundary = "public-boundary"
// scope = "background invocation admission without queue or inference"
// lifecycle = "permanent"
// impact = "背景呼出しが無制限に増えるか、保護中の履歴・制作上の仮定を自動生成へ渡す"
// distinction = "型検査ではresource枠や旧schema保護を確認できない。固定3件の小さいfixtureで未起動と実行中を区別する"
// @end-test-value
test("背景の上限・重複起動とsourceの適格性を守る", async () => {
  const f = await fixture();
  try {
    const first = f.started();
    f.started("main", "codex", "character-memory");
    f.started("main", "claude", "target-memory");
    assert.deepEqual(f.start(), { ok: false, reason: "already_active" });
    assert.deepEqual(f.start("other"), { ok: false, reason: "capacity" });
    assert.equal(f.bindings.getActiveBindingCount(), 3);
    f.executions.finish(first);
    f.started("other");
    const session = f.sessions.get("main")!;
    for (const override of [{ accessMode: "legacy_readonly" as const }, { sourceSchemaVersion: 1 }, { sessionKind: "character-authoring" as const }]) {
      f.sessions.set("main", { ...session, ...override });
      assert.throws(() => f.start(), /eligible source/);
    }
  } finally { await f.close(); }
});

// @test-value v2
// kind = "contract"
// claim = "背景Provider失効は元会話Providerに依存せず該当呼出しを取消し、runtime停止は接続閉鎖後のadmissionも失効して再起動まで開始を拒否する"
// oracle = { type = "contract", ref = "docs/design/background-execution.md#接続と論理実行の寿命" }
// fault = "credential変更で元SessionのProviderだけを見て背景を残すか、接続閉鎖後のlogical runを終了対象から漏らす"
// observable = "Provider別signal、残った正常read、停止後admissionと開始の例外、再起動後の受付"
// observation_boundary = "component-behavior"
// scope = "provider-specific revocation and Main-owned runtime shutdown"
// lifecycle = "permanent"
// impact = "無効化されたProviderの遅延結果が保存可能なまま残る"
// distinction = "host停止だけではnative完了後の論理admissionを列挙しないため、Mainと同じstop/startで終了・新規開始停止・再開を確認する"
// @end-test-value
test("Provider失効とruntime停止が背景の論理寿命まで終了する", async () => {
  const f = await fixture();
  try {
    const codex = f.started();
    const claude = f.started("main", "claude", "target-memory");
    const connected = await f.connect(f.project(codex));
    f.bindings.revokeBackgroundProvider("claude");
    assert.equal(claude.signal.aborted, true);
    assert.equal(codex.signal.aborted, false);
    assert.partialDeepStrictEqual((await connected.client.callTool({ name: "session_history.get_message", arguments: { seq: 0 } })).structuredContent, { ok: true });
    f.executions.nativeCompleted(codex);
    f.executions.stop();
    assert.throws(() => runWithRuntimeTurnAdmission(codex.admission, () => undefined), /no longer active/);
    assert.throws(() => runWithRuntimeTurnAdmission(claude.admission, () => undefined), /no longer active/);
    assert.throws(() => f.start(), /runtime is unavailable/);
    f.executions.start();
    assert.equal(f.started().signal.aborted, false);
  } finally { await f.close(); }
});
