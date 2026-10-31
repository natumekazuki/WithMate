import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { runWithMateSessionGraphCli, WITHMATE_SESSION_GRAPH_CLI_EXIT_CODES } from "../../src-cli/session-graph/withmate-session-graph.js";
import { createWithMateSessionGraphMcpServer } from "../../src-electron/platform/mcp/withmate-session-graph-mcp.js";
import { WithMateMemoryRuntimeExchangeError, type callWithMateMemoryRuntime, type WithMateMemoryRuntimeConnection } from "../../src-electron/platform/mcp/withmate-memory-runtime-client.js";
import { WITHMATE_AGENT_RUNTIME_EXTENSION_EXCHANGE_PATH } from "../../src-electron/platform/memory/memory-runtime-exchange.js";
import { SESSION_GRAPH_RUNTIME_OPERATION_PATHS } from "../../src-shared/session-graph/session-graph-operation-schema.js";

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
  const exit = await runWithMateSessionGraphCli(args, { env: extraEnv, runtimeCall,
    stdout: { write: (value) => { output += String(value); return true; } }, stderr: { write: () => true } });
  return { exit, value: JSON.parse(output) as Record<string, unknown> };
}
async function mcp(runtimeCall: typeof callWithMateMemoryRuntime, action: (client: Client) => Promise<void>) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createWithMateSessionGraphMcpServer({ env, connection, runtimeCall });
  const client = new Client({ name: "graph-parity", version: "1.0.0" });
  try { await server.connect(serverTransport); await client.connect(clientTransport); await action(client); }
  finally { await client.close(); await server.close(); }
}

// @test-value v2
// kind = "contract"
// claim = "Graph CLIとMCPの6操作は同じ入力とbinding/turnをextension exchangeへ渡し同じ結果を返す"
// oracle = { type = "contract", ref = "docs/design/session-graph.md#MCPと更新" }
// fault = "CLIが別routeや認可contextを使い、MCPと異なる要求または結果になる"
// observable = "runtime dispatchのpath/body/binding/turn/exchangeとCLI JSONおよびMCP structuredContent"
// observation_boundary = "public-boundary"
// scope = "session-graph-cli-mcp"
// lifecycle = "permanent"
// distinction = "schema単体やHTTP認可testではなく両transportの実entryから同一dispatchと結果を確認する"
// impact = "CLI経由の復元と更新がMCPと異なるGraph操作になることを防ぐ"
// @end-test-value
it("6操作のCLIとSDK MCPは同じbinding付き要求と結果を共有する", async () => {
  const inputs = { list_topics: { limit: 1 }, recent: { limit: 1 }, context: { kind: "issue" }, get: { ids: ["r"] }, search: { query: "work" },
    apply: { expectedRevision: 1, records: [{ id: "r", topicId: "t", kind: "decision", title: "decision", detail: "detail", scope: "task", references: [],
      origin: { type: "user" }, actorRole: null, adoption: "accepted", adoptionOrigin: { type: "user" } }] } } as const;
  const calls: unknown[] = [];
  const runtimeCall: typeof callWithMateMemoryRuntime = async (selected, operation, options) => {
    assert.deepEqual(selected, connection);
    calls.push({ operation, binding: options.bindingReference, turn: options.turnCapability, exchange: options.exchangePath });
    return { ok: true, status: 200, value: { ok: true, revision: 2, received: operation.body } };
  };
  await mcp(runtimeCall, async (client) => {
    assert.equal((await client.listTools()).tools.length, 6);
    for (const [operation, body] of Object.entries(inputs)) {
      const result = await cli([operation === "list_topics" ? "list-topics" : operation, "--json", JSON.stringify(body)], runtimeCall);
      const tool = await client.callTool({ name: `session_graph.${operation}`, arguments: body });
      assert.equal(result.exit, 0);
      assert.deepEqual(result.value, tool.structuredContent);
      assert.deepEqual(calls.at(-1), calls.at(-2));
      assert.deepEqual(calls.at(-1), { operation: { method: "POST", path: SESSION_GRAPH_RUNTIME_OPERATION_PATHS[operation as keyof typeof inputs], body },
        binding: "binding", turn: "turn", exchange: WITHMATE_AGENT_RUNTIME_EXTENSION_EXCHANGE_PATH });
    }
  });
});

// @test-value v2
// kind = "contract"
// claim = "Graph CLIとMCPはconflictとdispatch前後の保存結果不明を同じ失敗として返す"
// oracle = { type = "contract", ref = "docs/design/session-graph.md#MCPと更新" }
// fault = "CLIだけがconflictを成功扱いし、または応答喪失を未保存と決めつける"
// observable = "CLI exit/JSONとMCP isError/structuredContentのeffectおよびstatus"
// observation_boundary = "public-boundary"
// scope = "session-graph-cli-mcp"
// lifecycle = "permanent"
// distinction = "storageのCASではなくtransport共通error分類のconsumer結果を確認する"
// impact = "保存結果不明の無条件再送やrevision conflictの見落としを防ぐ"
// @end-test-value
it("conflictとdispatch前後の失敗効果をCLIとMCPで一致させる", async () => {
  for (const scenario of ["conflict", "before", "after", "malformed"] as const) {
    const runtimeCall: typeof callWithMateMemoryRuntime = async () => {
      if (scenario === "before" || scenario === "after") throw new WithMateMemoryRuntimeExchangeError("lost", scenario === "after");
      return { ok: true, status: 200, value: scenario === "conflict" ? { status: "conflict", revision: 3 } : null };
    };
    await mcp(runtimeCall, async (client) => {
      const result = await cli(["apply", "--json", '{"expectedRevision":1}'], runtimeCall);
      const tool = await client.callTool({ name: "session_graph.apply", arguments: { expectedRevision: 1 } });
      assert.deepEqual(result.value, tool.structuredContent);
      assert.equal(tool.isError, true);
      assert.equal(result.exit, scenario === "conflict" ? 1 : 3);
      if (scenario !== "conflict") assert.equal(result.value.effect, scenario === "before" ? "none" : "unknown");
    });
  }
});

// @test-value v2
// kind = "security"
// claim = "GraphのCLIとMCPは不正入力をdispatchせずCLIはbindingなしで実行しない"
// oracle = { type = "contract", ref = "docs/design/session-graph.md#MCPと更新" }
// fault = "CLIがschemaを迂回し親Sessionや記録者を自己申告できる"
// observable = "CLI usage/binding error、MCP isErrorとruntime dispatch回数"
// observation_boundary = "public-boundary"
// scope = "session-graph-cli-mcp"
// lifecycle = "permanent"
// distinction = "schema宣言の存在ではなくCLI parserとSDK MCP入力境界で拒否することを確認する"
// impact = "未認可scopeへの要求と不正なbatchの送信を防ぐ"
// @end-test-value
it("不正入力とbinding欠落をdispatch前に拒否する", async () => {
  let calls = 0;
  const runtimeCall: typeof callWithMateMemoryRuntime = async () => { calls++; throw new Error("must not dispatch"); };
  await mcp(runtimeCall, async (client) => {
    for (const body of [{ sessionId: "other" }, { limit: 0 }, { recordedBy: "other" }]) {
      const result = await cli(["recent", "--json", JSON.stringify(body)], runtimeCall);
      assert.equal(result.exit, WITHMATE_SESSION_GRAPH_CLI_EXIT_CODES.usage);
      assert.equal((await client.callTool({ name: "session_graph.recent", arguments: body })).isError, true);
    }
  });
  assert.equal((await cli(["recent", "--session-id", "other"], runtimeCall)).exit, 2);
  const missing = await cli(["recent"], runtimeCall, { ...env, WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE: "" });
  assert.equal(missing.exit, 1);
  assert.deepEqual(missing.value, { ok: false, code: "SESSION_GRAPH_BINDING_REQUIRED", effect: "none" });
  assert.equal(calls, 0);
});

// @test-value v2
// kind = "contract"
// claim = "Graph CLIの各JSON入力元が同じschema検証済みbodyを送信しschemaをoffline取得できる"
// oracle = { type = "contract", ref = "src-cli/session-graph/withmate-session-graph.ts" }
// fault = "fileやstdinのJSONが解釈されず異なるbodyで送信される"
// observable = "runtimeへ送信されたbodyとoffline schemaの操作一覧"
// observation_boundary = "public-boundary"
// scope = "session-graph-cli"
// lifecycle = "permanent"
// distinction = "MCP parityとは別にCLI固有の入力sourceとoffline discoveryを確認する"
// impact = "batchファイルによる更新とschema確認を利用できなくなる"
// @end-test-value
it("file、at-file、stdinとschemaを扱う", async () => {
  const body = { expectedRevision: 2, topics: [{ id: "t", title: "topic" }] };
  const directory = await mkdtemp(path.join(tmpdir(), "withmate-graph-cli-"));
  const file = path.join(directory, "input.json");
  try {
    await writeFile(file, JSON.stringify(body));
    for (const input of [["--file", file], [`@${file}`], ["--stdin"]]) {
      let received: unknown;
      const exit = await runWithMateSessionGraphCli(["apply", ...input], { env,
        stdin: Readable.from([JSON.stringify(body)]), stdout: { write: () => true }, stderr: { write: () => true },
        runtimeCall: async (_selected, operation) => { received = operation.body; return { ok: true, status: 200, value: { ok: true } }; } });
      assert.equal(exit, 0); assert.deepEqual(received, body);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
  let output = "";
  assert.equal(await runWithMateSessionGraphCli(["schema"], { env: {}, stdout: { write: (value) => { output += String(value); return true; } } }), 0);
  const schema = JSON.parse(output) as { operations: Record<string, { properties: Record<string, unknown> }> };
  assert.deepEqual(Object.keys(schema.operations), ["list_topics", "recent", "context", "get", "search", "apply"]);
  assert.ok(schema.operations.apply.properties.expectedRevision);
});
