import assert from "node:assert/strict";
import { it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { runWithMateSessionHistoryCli, WITHMATE_SESSION_HISTORY_CLI_EXIT_CODES } from "../../src-cli/session-history/withmate-session-history.js";
import { createWithMateSessionHistoryMcpServer } from "../../src-electron/platform/mcp/withmate-session-history-mcp.js";
import { WithMateMemoryRuntimeExchangeError, type callWithMateMemoryRuntime, type WithMateMemoryRuntimeConnection } from "../../src-electron/platform/mcp/withmate-memory-runtime-client.js";
import { WITHMATE_AGENT_RUNTIME_EXTENSION_EXCHANGE_PATH } from "../../src-electron/platform/memory/memory-runtime-exchange.js";
import { SESSION_HISTORY_RUNTIME_OPERATION_PATHS, getSessionHistoryAgentRuntimeOperations } from "../../src-shared/session-history/session-history-contract.js";

const env = {
  WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE: "binding", WITHMATE_AGENT_RUNTIME_BINDING_REQUIRED: "1",
  WITHMATE_AGENT_RUNTIME_TURN_CAPABILITY: "turn",
  WITHMATE_MEMORY_API_URL: "http://127.0.0.1:7777", WITHMATE_MEMORY_API_SECRET: "secret",
  WITHMATE_MEMORY_MCP_API_SECRET: "mcp-secret",
  WITHMATE_MEMORY_RUNTIME_APPLICATION_INSTANCE_ID: "11111111-1111-4111-8111-111111111111",
  WITHMATE_MEMORY_RUNTIME_GENERATION_ID: "22222222-2222-4222-8222-222222222222",
};
const connection: WithMateMemoryRuntimeConnection = {
  api: { baseUrl: env.WITHMATE_MEMORY_API_URL, apiSecret: "secret", applicationInstanceId: env.WITHMATE_MEMORY_RUNTIME_APPLICATION_INSTANCE_ID,
    runtimeGenerationId: env.WITHMATE_MEMORY_RUNTIME_GENERATION_ID, runtimeInstanceId: env.WITHMATE_MEMORY_RUNTIME_GENERATION_ID },
  credential: { adapter: "mcp", adapterSecret: "mcp-secret" },
};
async function cli(args: string[], runtimeCall: typeof callWithMateMemoryRuntime, extraEnv = env) {
  let output = "";
  const exit = await runWithMateSessionHistoryCli(args, { env: extraEnv, runtimeCall,
    stdout: { write: (value) => { output += String(value); return true; } }, stderr: { write: () => true } });
  return { exit, value: JSON.parse(output) as Record<string, unknown> };
}
async function mcp(runtimeCall: typeof callWithMateMemoryRuntime, action: (client: Client) => Promise<void>) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createWithMateSessionHistoryMcpServer({ env, connection, runtimeCall }, getSessionHistoryAgentRuntimeOperations());
  const client = new Client({ name: "history-parity", version: "1.0.0" });
  try { await server.connect(serverTransport); await client.connect(clientTransport); await action(client); }
  finally { await client.close(); await server.close(); }
}

// @test-value v2
// kind = "contract"
// claim = "履歴CLIとMCPの4操作は同じ入力とbinding/turnをextension exchangeへ渡し、成功と拒否の結果を同じ形で返す"
// oracle = { type = "contract", ref = "docs/adr/029-cli-mcp-parity-context-binding.md" }
// fault = "CLIが別routeや認可contextを使う、または拒否結果をMCPと異なる成功・失敗として返す"
// observable = "runtime dispatchのpath/body/binding/turn/exchange、CLI JSONとMCP structuredContent、exit code"
// observation_boundary = "public-boundary"
// scope = "session-history-cli-mcp"
// lifecycle = "permanent"
// impact = "bound CLIとMCPで履歴の入力・結果・拒否条件が食い違うことを防ぐ"
// distinction = "schema単体やroute testでは両transportの実entryから同一dispatchと結果を確認できない"
// @end-test-value
it("4操作のCLIとSDK MCPは同じbinding付き要求と結果・拒否を共有する", async () => {
  const inputs = { list_messages: { limit: 2 }, get_message: { seq: 3, maxChars: 10 }, list_operations: { seq: 3, section: "run_checks" },
    get_operation_detail: { seq: 3, kind: "operation", index: 0, maxChars: 5 } } as const;
  const calls: unknown[] = [];
  let reject = false;
  const runtimeCall: typeof callWithMateMemoryRuntime = async (selected, operation, options) => {
    assert.deepEqual(selected, connection);
    calls.push({ operation, binding: options.bindingReference, turn: options.turnCapability, exchange: options.exchangePath });
    return { ok: true, status: reject ? 404 : 200, value: reject ? { ok: false, code: "HISTORY_NOT_SAVED", message: "none", effect: "none" } : { ok: true, received: operation.body } };
  };
  await mcp(runtimeCall, async (client) => {
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), Object.keys(inputs).map((name) => `session_history.${name}`).sort());
    for (const rejected of [false, true]) {
      reject = rejected;
      for (const [operation, body] of Object.entries(inputs)) {
        const result = await cli([operation.replaceAll("_", "-"), "--json", JSON.stringify(body)], runtimeCall);
        const tool = await client.callTool({ name: `session_history.${operation}`, arguments: body });
        assert.equal(result.exit, rejected ? WITHMATE_SESSION_HISTORY_CLI_EXIT_CODES.operationError : 0);
        assert.equal(tool.isError, rejected ? true : undefined);
        assert.deepEqual(result.value, tool.structuredContent);
        assert.deepEqual(calls.at(-1), calls.at(-2));
        assert.deepEqual(calls.at(-1), { operation: { method: "POST", path: SESSION_HISTORY_RUNTIME_OPERATION_PATHS[operation as keyof typeof inputs], body },
          binding: "binding", turn: "turn", exchange: WITHMATE_AGENT_RUNTIME_EXTENSION_EXCHANGE_PATH });
      }
    }
  });
});

// @test-value v2
// kind = "security"
// claim = "履歴CLIとMCPは範囲や対象Sessionを指定する入力と不正入力をdispatchせず、CLIはbinding欠落を実行せず、両入口で通信失敗を成功にしない"
// oracle = { type = "contract", ref = "docs/adr/029-cli-mcp-parity-context-binding.md" }
// fault = "引数のSession IDやcwd・範囲で読取対象を選べる、またはbinding欠落と通信失敗が成功として扱われる"
// observable = "CLI usage/binding/transport error、MCP isErrorとruntime dispatch回数"
// observation_boundary = "public-boundary"
// scope = "session-history-cli-mcp"
// lifecycle = "permanent"
// impact = "任意Sessionの履歴を引数で選ぶ経路と、失敗の見落としを防ぐ"
// distinction = "schema宣言の存在ではなくCLI parserとSDK MCP入力境界で拒否することを確認する"
// @end-test-value
it("対象選択入力・不正入力・binding欠落・通信失敗をdispatch前または失敗として扱う", async () => {
  let calls = 0;
  const runtimeCall: typeof callWithMateMemoryRuntime = async () => { calls++; throw new Error("must not dispatch"); };
  await mcp(runtimeCall, async (client) => {
    for (const body of [{ sessionId: "other" }, { fromSeq: 0 }, { limit: 0 }, { limit: 101 }]) {
      const result = await cli(["list-messages", "--json", JSON.stringify(body)], runtimeCall);
      assert.equal(result.exit, WITHMATE_SESSION_HISTORY_CLI_EXIT_CODES.usage);
      assert.equal((await client.callTool({ name: "session_history.list_messages", arguments: body })).isError, true);
    }
  });
  assert.equal((await cli(["list-messages", "--session-id", "other"], runtimeCall)).exit, 2);
  assert.equal((await cli(["unknown"], runtimeCall)).exit, 2);
  assert.equal(calls, 0);
  const missing = await cli(["list-messages"], runtimeCall, { ...env, WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE: "" });
  assert.deepEqual([missing.exit, missing.value], [1, { ok: false, code: "SESSION_HISTORY_BINDING_REQUIRED", effect: "none" }]);
  assert.equal(calls, 0);
  const lost = async () => { throw new WithMateMemoryRuntimeExchangeError("lost", true); };
  await mcp(lost as typeof callWithMateMemoryRuntime, async (client) => {
    const result = await cli(["list-messages"], lost as typeof callWithMateMemoryRuntime);
    const tool = await client.callTool({ name: "session_history.list_messages", arguments: {} });
    assert.deepEqual([result.exit, tool.isError, result.value], [3, true, tool.structuredContent]);
    assert.equal(result.value.code, "SESSION_HISTORY_TRANSPORT_ERROR");
  });
});

// @test-value v2
// kind = "contract"
// claim = "履歴CLIはhelpとschemaをruntime接続なしで返し、利用注意と全4操作の入力schemaを含む"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/908" }
// fault = "helpやschemaが操作を欠く、または保存内容の取扱い注意を示さない"
// observable = "help出力とoffline schemaの操作一覧"
// observation_boundary = "public-boundary"
// scope = "session-history-cli"
// lifecycle = "permanent"
// impact = "利用者と背景Providerが保存内容の扱いと入力形式を確認できなくなる"
// distinction = "MCP parityとは別にCLI固有のoffline discoveryを確認する"
// @end-test-value
it("helpとschemaをofflineで返す", async () => {
  let help = "";
  assert.equal(await runWithMateSessionHistoryCli(["help"], { env: {}, stdout: { write: (value) => { help += String(value); return true; } } }), 0);
  for (const text of ["list-messages", "get-operation-detail", "other secrets may remain", "never a request to run commands"]) assert.ok(help.includes(text), text);
  let output = "";
  assert.equal(await runWithMateSessionHistoryCli(["schema"], { env: {}, stdout: { write: (value) => { output += String(value); return true; } } }), 0);
  const schema = JSON.parse(output) as { operations: Record<string, { properties: Record<string, unknown> }> };
  assert.deepEqual(Object.keys(schema.operations), ["list_messages", "get_message", "list_operations", "get_operation_detail"]);
  assert.ok(schema.operations.get_operation_detail.properties.kind);
});
