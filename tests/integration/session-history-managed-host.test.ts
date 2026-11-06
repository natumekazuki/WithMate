import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildWithMateSessionHistoryCli } from "../../scripts/build/build-withmate-memory-cli.js";
import type { ProviderAgentRuntimeBindingProjection } from "../../src-electron/providers/agent-runtime-binding.js";
import { backgroundHistoryFixture } from "../helpers/background-history-fixture.js";
import { getSessionHistoryAgentRuntimeOperations } from "../../src-shared/session-history/session-history-contract.js";
import { runWithRuntimeTurnAdmission } from "../../src-electron/platform/memory/runtime-turn-admission.js";

async function invokeCli(f: Awaited<ReturnType<typeof backgroundHistoryFixture>>, binding: ProviderAgentRuntimeBindingProjection,
  command: string, body: Record<string, unknown> = {}, env = f.cliEnv(binding)) {
  try {
    const result = await promisify(execFile)(process.execPath, [resolve("resources/cli/withmate-session-history.mjs"), command, "--json", JSON.stringify(body)],
      { cwd: f.directory, env, windowsHide: true });
    return { code: 0, value: JSON.parse(result.stdout) as Record<string, any> };
  } catch (cause) {
    const result = cause as { code: number; stdout: string };
    return { code: result.code, value: JSON.parse(result.stdout) as Record<string, any> };
  }
}

// @test-value v2
// kind = "contract"
// claim = "配布履歴CLIとmanaged HTTP MCPは同じ保存履歴を非zero下端と固定末尾の範囲で読み、範囲外を同じ失敗で拒否し、通常turnと終了した背景実行をCLIで拒否する"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/908" }
// fault = "bundleが起動不能、CLIとMCPが別の範囲・結果を返す、通常turnのbindingで履歴を読める、または背景実行の終了後もCLIで読める"
// observable = "別processのCLI exit/JSON、SDK MCP応答、window外の失敗、通常turnbindingと終了後のCLI失敗code"
// observation_boundary = "consumer"
// scope = "配布履歴CLI/managed HTTP MCPからruntime challengeとSQLite読取まで"
// lifecycle = "permanent"
// impact = "背景生成が配布CLI・MCPのどちらでも同じ許可範囲の履歴だけを読めることを保護する"
// distinction = "route単体testと異なりbundleを別processで起動し、実HTTP認証・managed host・保存を通す"
// @end-test-value
test("bundled history CLI and managed MCP read the same saved history under the background binding", async () => {
  const f = await backgroundHistoryFixture();
  try {
    const rebuilt = await buildWithMateSessionHistoryCli(f.directory);
    const artifact = resolve("resources/cli/withmate-session-history.mjs");
    assert.equal((await readFile(rebuilt, "utf8")).replaceAll("\r\n", "\n"), (await readFile(artifact, "utf8")).replaceAll("\r\n", "\n"));
    const normalBinding = f.bindings.issueOrReuse({ actorSessionId: "main", providerId: "codex", operationGrants: ["memory.route.list_targets"] });
    const normalHandle = f.turns.begin({ actorSessionId: "main", providerId: "codex" });
    const normal = { binding: { ...normalBinding, turnCapability: normalHandle.capability } };
    const captured = f.scope();
    const execution = f.executions.begin({ actorSessionId: "main", providerId: "claude", session: f.sessions.get("main")!,
      scope: { ...captured, history: { ...captured.history, fromMessageSeq: 1 } },
      authoritySnapshot: { characterId: "character" }, operationGrants: getSessionHistoryAgentRuntimeOperations() });
    const background = { binding: f.project(execution) };
    const { client: mcp } = await f.connect(background.binding);
    for (const seq of [2, 3]) f.db.prepare("INSERT INTO session_messages_v6(session_id,seq,role,body,created_at) VALUES ('main',?,'user',?,'now')")
      .run(seq, JSON.stringify({ text: "later input" }));
    assert.equal((await mcp.listTools()).tools.length, 4);
    for (const [operation, body] of [["list_messages", {}], ["get_message", { seq: 1 }], ["list_operations", { seq: 1 }],
      ["get_operation_detail", { seq: 1, kind: "operation", index: 0 }]] as const) {
      const cli = await invokeCli(f, background.binding, operation.replaceAll("_", "-"), body);
      const tool = await mcp.callTool({ name: `session_history.${operation}`, arguments: body });
      assert.equal(cli.code, 0);
      assert.deepEqual(cli.value, tool.structuredContent);
    }
    const list = await invokeCli(f, background.binding, "list-messages", {});
    assert.equal(list.value.total, 1);
    assert.equal((await invokeCli(f, background.binding, "get-operation-detail", { seq: 1, kind: "operation", index: 0 })).value.text, "failure output");

    const outside = await invokeCli(f, background.binding, "get-message", { seq: 3 });
    const outsideMcp = await mcp.callTool({ name: "session_history.get_message", arguments: { seq: 3 } });
    assert.deepEqual([outside.code, outside.value.code, outsideMcp.isError], [1, "HISTORY_OUT_OF_RANGE", true]);
    assert.deepEqual(outside.value, outsideMcp.structuredContent);
    const before = await invokeCli(f, background.binding, "get-message", { seq: 0 });
    const beforeMcp = await mcp.callTool({ name: "session_history.get_message", arguments: { seq: 0 } });
    assert.deepEqual([before.code, before.value.code], [1, "HISTORY_OUT_OF_RANGE"]);
    assert.deepEqual(before.value, beforeMcp.structuredContent);

    const denied = await invokeCli(f, normal.binding, "list-messages", {});
    assert.deepEqual([denied.code, denied.value.ok, denied.value.code], [1, false, "SESSION_BINDING_FORBIDDEN"]);
    assert.equal((await invokeCli(f, background.binding, "list-messages", {})).code, 0);

    f.executions.finish(execution);
    const ended = await invokeCli(f, background.binding, "list-messages", {});
    assert.deepEqual([ended.code, ended.value.code], [1, "SESSION_BINDING_INVALID"]);
  } finally { await f.close(); }
});

// @test-value v2
// kind = "security"
// claim = "実背景の履歴grantとcapabilityをMCP/配布CLIが共通検証し、通常turn・部分grantの許可外操作・capability欠落と別実行・終了済みbinding・実HTTP認証拒否を失敗にする"
// oracle = { type = "contract", ref = "docs/design/session-history.md" }
// fault = "MCPのtool非表示だけで認可し直接callを許す、通常bindingや別handleを認可する、またはHTTP認証拒否を成功にする"
// observable = "hostの公開toolと直接HTTP 403、実runtimeへ接続するSDK MCPと別process CLIのcode/ok、許可操作の継続成功"
// observation_boundary = "consumer"
// scope = "managed host and MCP adapter/CLI through production runtime authorization"
// lifecycle = "permanent"
// impact = "通常turnや権限の狭い背景処理が許可外の保存履歴へ到達するか、取得失敗を成功として後続処理を進める"
// distinction = "正常系parityとroute単体では配布bundleとfactoryが環境capabilityを正しく伝えることを確認できない。異常envのMCPはSDK in-memory transportから実HTTP runtimeへ接続する"
// @end-test-value
test("両入口で実背景のoperation grantとcapability境界を守る", async () => {
  const f = await backgroundHistoryFixture();
  try {
    const execution = f.started();
    const binding = f.project(execution);
    const other = f.started("main", "claude", "target-memory");
    const partial = f.project(f.started("main", "claude", "character-memory", undefined, ["session_history.route.get_message"]));
    const { client, transport } = await f.connect(partial);
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), ["session_history.get_message"]);
    assert.equal((await f.request(partial, partial.managedMcp!.sessionHistoryUrl!, "session_history.list_messages", transport.sessionId)).status, 403);
    assert.equal((await invokeCli(f, partial, "list-messages")).value.code, "SESSION_BINDING_FORBIDDEN");
    assert.equal((await invokeCli(f, partial, "get-message", { seq: 0 })).value.ok, true);
    assert.partialDeepStrictEqual((await client.callTool({ name: "session_history.get_message", arguments: { seq: 0 } })).structuredContent, { ok: true });

    const normal = f.bindings.issueOrReuse({ actorSessionId: "main", providerId: "codex", operationGrants: getSessionHistoryAgentRuntimeOperations() });
    const normalHandle = f.turns.begin({ actorSessionId: "main", providerId: "codex" });
    const contexts = [
      { env: f.cliEnv({ ...normal, turnCapability: normalHandle.capability }), code: "SESSION_BINDING_FORBIDDEN" },
      { env: { ...f.cliEnv(binding), WITHMATE_AGENT_RUNTIME_TURN_CAPABILITY: "" }, code: "SESSION_BINDING_INVALID" },
      { env: { ...f.cliEnv(binding), WITHMATE_AGENT_RUNTIME_TURN_CAPABILITY: "wrong" }, code: "SESSION_BINDING_INVALID" },
      { env: { ...f.cliEnv(binding), WITHMATE_AGENT_RUNTIME_TURN_CAPABILITY: other.handle.capability }, code: "SESSION_BINDING_INVALID" },
    ];
    const check = async (env: NodeJS.ProcessEnv, code: string) => {
      const mcp = await f.connectRuntimeContext(env);
      const tool = await mcp.callTool({ name: "session_history.list_messages", arguments: {} });
      const cli = await invokeCli(f, binding, "list-messages", {}, env);
      assert.equal(cli.code, 1);
      assert.equal(cli.value.code, code);
      assert.equal(tool.isError, true);
      assert.deepEqual(tool.structuredContent, cli.value);
    };
    for (const { env, code } of contexts) await check(env, code);
    const rejectedEnv = { ...f.cliEnv(binding), WITHMATE_MEMORY_MCP_API_SECRET: "wrong-mcp-secret" };
    const rejectedMcp = await f.connectRuntimeContext(rejectedEnv, { adapter: "mcp", adapterSecret: "wrong-mcp-secret" });
    const rejectedTool = await rejectedMcp.callTool({ name: "session_history.list_messages", arguments: {} });
    const rejectedCli = await invokeCli(f, binding, "list-messages", {}, rejectedEnv);
    assert.equal(rejectedCli.code, 3);
    assert.equal(rejectedCli.value.code, "SESSION_HISTORY_TRANSPORT_ERROR");
    assert.equal(rejectedTool.isError, true);
    assert.deepEqual(rejectedTool.structuredContent, rejectedCli.value);
    assert.equal((await invokeCli(f, binding, "list-messages")).value.ok, true);
    f.executions.finish(execution);
    await check(f.cliEnv(binding), "SESSION_BINDING_INVALID");
  } finally { await f.close(); }
});

// @test-value v2
// kind = "invariant"
// claim = "履歴read待機中の取消・finish・storage generation終了を両入口で成功にせず、Workerへ渡ったadmissionも失効を検出する"
// oracle = { type = "contract", ref = "docs/design/background-execution.md#接続と論理実行の寿命" }
// fault = "失効後に保存履歴を成功として返すか、Mainだけがadmissionを見てWorkerへ共有しない"
// observable = "実runtimeへのMCP/CLIの失敗、Worker readのRuntimeTurnInactiveError、正常readのok"
// observation_boundary = "consumer"
// scope = "runtime read completion and Storage Worker admission propagation"
// lifecycle = "permanent"
// impact = "取消済みの背景処理や旧storage ownerへ保存履歴を公開する"
// distinction = "単体の取消testではWorkerの共有buffer伝播を確認できない。runtime待機はgateで固定し、Worker dispatch直前の取消は既存diagnostic hookで固定する"
// @end-test-value
test("読取中の実行取消・終了とstorage失効を成功にしない", async () => {
  let revoke: (() => void) | undefined;
  const f = await backgroundHistoryFixture((event) => {
    if (event.operation === "session.readSessionHistory" && event.stage === "queued") revoke?.();
  });
  try {
    const workerExecution = f.started();
    revoke = () => f.executions.cancel(workerExecution.binding.bindingId);
    await assert.rejects(runWithRuntimeTurnAdmission(workerExecution.admission,
      () => f.worker.stores.session.readSessionHistory({ scope: f.scope().history, operation: "list_messages", request: {} })), /no longer active/);
    revoke = undefined;
    for (const end of ["cancel", "finish", "storage"] as const) {
      for (const entrance of ["mcp", "cli"] as const) {
        const execution = f.started();
        const binding = f.project(execution);
        const mcp = await f.connectRuntimeContext(f.cliEnv(binding));
        let ready!: () => void;
        const entered = new Promise<void>((resolve) => { ready = resolve; });
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        f.setReadGate(async () => { ready(); await gate; });
        const pending = entrance === "mcp"
          ? mcp.callTool({ name: "session_history.list_messages", arguments: {} }).then((result) => result.structuredContent as Record<string, unknown>)
          : invokeCli(f, binding, "list-messages").then((result) => result.value);
        await entered;
        if (end === "storage") await f.worker.client.close();
        else if (end === "finish") f.executions.finish(execution);
        else f.executions.cancel(execution.binding.bindingId);
        release();
        const result = await pending;
        assert.equal(result.ok, false);
        assert.equal(result.code, end === "storage" ? "HISTORY_READ_FAILED" : "HISTORY_EXECUTION_INACTIVE");
        f.setReadGate();
        f.executions.finish(execution);
      }
    }
  } finally { await f.close(); }
});

// @test-value v2
// kind = "security"
// claim = "Main/Auxiliaryと親の削除・再作成を両入口で拒否し、通常のAux draft保存は成功・read-back・incarnation保持後も同じscopeで読める"
// oracle = { type = "contract", ref = "docs/design/session-history.md#認可と範囲" }
// fault = "draft編集を再作成として拒否するか、同ID/同createdAt/同親の別Auxや再作成された親/Mainの履歴を古いscopeで返す"
// observable = "実Workerのdraft保存結果とread-back、incarnation、managed MCPと配布CLIの本文/失敗code"
// observation_boundary = "consumer"
// scope = "captured ownerIdentity through both published entries and Storage Worker"
// lifecycle = "permanent"
// impact = "別会話の本文を以前の背景処理へ公開するか、正当なdraft編集で履歴参照を失う"
// distinction = "storage単体のsource照合では実resolverからWorkerまで同じ捕捉scopeが渡ることを確認できない"
// @end-test-value
test("両入口で保存sourceのownerを照合しdraft編集と再作成を区別する", async () => {
  const f = await backgroundHistoryFixture();
  try {
    const main = f.project(f.started());
    const auxExecution = f.started("aux");
    const aux = f.project(auxExecution);
    const { client: mainClient } = await f.connect(main);
    const { client: auxClient } = await f.connect(aux);
    const check = async (binding: ProviderAgentRuntimeBindingProjection, client: Awaited<ReturnType<typeof f.connect>>["client"], code?: string) => {
      const cli = await invokeCli(f, binding, "get-message", { seq: 0 });
      const mcp = await client.callTool({ name: "session_history.get_message", arguments: { seq: 0 } });
      assert.deepEqual(mcp.structuredContent, cli.value);
      assert.equal(cli.value.ok, code === undefined);
      if (code) assert.equal(cli.value.code, code);
    };
    const draft = (await f.worker.stores.auxiliary.getAuxiliaryDraft("aux"))!;
    const saved = await f.worker.stores.auxiliary.saveAuxiliaryDraft({ auxiliarySessionId: "aux", parentSessionId: "main",
      incarnation: draft.incarnation, expectedDurableRevision: draft.durableRevision, text: "edited draft", updatedAt: "now" });
    assert.equal(saved.outcome, "saved");
    const edited = (await f.worker.stores.auxiliary.getAuxiliaryDraft("aux"))!;
    assert.equal(edited.text, "edited draft");
    assert.equal(edited.incarnation, draft.incarnation);
    await check(aux, auxClient);

    const previous = (await f.worker.stores.auxiliary.getAuxiliarySession("aux"))!;
    await f.worker.stores.auxiliary.deleteAuxiliarySessionsForParent("main");
    await check(aux, auxClient, "HISTORY_SOURCE_DELETED");
    await f.worker.stores.auxiliary.upsertAuxiliarySession(previous);
    assert.notEqual((await f.worker.stores.auxiliary.getAuxiliaryDraft("aux"))!.incarnation, draft.incarnation);
    await check(aux, auxClient, "HISTORY_SOURCE_REPLACED");
    f.executions.finish(auxExecution);
    const currentAux = f.project(f.started("aux"));
    const { client: currentAuxClient } = await f.connect(currentAux);
    await check(currentAux, currentAuxClient);

    f.db.prepare("UPDATE sessions_v6 SET incarnation_id='inc-recreated', state='completed' WHERE id='main'").run();
    await check(main, mainClient, "HISTORY_SOURCE_REPLACED");
    await check(currentAux, currentAuxClient, "HISTORY_SOURCE_REPLACED");
    await f.worker.stores.session.deleteSession("main");
    await check(main, mainClient, "HISTORY_SOURCE_DELETED");
    await check(currentAux, currentAuxClient, "HISTORY_SOURCE_DELETED");
    await f.worker.stores.session.insertSession({ ...f.sessions.get("main")!, incarnationId: "new-main",
      messages: [{ role: "user", text: "new conversation" }] });
    await check(main, mainClient, "HISTORY_SOURCE_REPLACED");
  } finally { await f.close(); }
});
