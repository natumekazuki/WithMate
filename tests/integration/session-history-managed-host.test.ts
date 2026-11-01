import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildWithMateSessionHistoryCli } from "../../scripts/build/build-withmate-memory-cli.js";
import { ManagedHttpMcpHost } from "../../src-electron/memory/managed-http-mcp-host.js";
import { createMemoryV6HttpServer, getMemoryV6AgentRuntimeOperations } from "../../src-electron/memory/memory-v6-http-server.js";
import { MemoryV6Service } from "../../src-electron/memory/memory-v6-service.js";
import { MemoryV6Storage } from "../../src-electron/memory/memory-v6-storage.js";
import { AgentRuntimeBindingRegistry, type ProviderAgentRuntimeBindingProjection } from "../../src-electron/providers/agent-runtime-binding.js";
import { WITHMATE_MANAGED_MCP_TOKEN_HEADER } from "../../src-electron/providers/managed-http-mcp.js";
import { ProviderAgentRuntimeTurnCoordinator } from "../../src-electron/providers/provider-agent-runtime-turn-coordinator.js";
import { SessionHistoryRuntimeService } from "../../src-electron/session-history/session-history-runtime-service.js";
import { SessionStorageV6 } from "../../src-electron/session/session-storage-v6.js";
import { createOrVerifyV6FreshDatabase } from "../../src-electron/storage/app-database-v6-bootstrap.js";
import { DEFAULT_APPROVAL_MODE } from "../../src-shared/settings/approval-mode.js";
import { buildNewSession, getSessionIncarnationId } from "../../src-shared/session/session-state.js";
import { getSessionHistoryAgentRuntimeOperations, type SessionHistoryReadScope } from "../../src-shared/session-history/session-history-contract.js";

const owner = { applicationInstanceId: "11111111-1111-4111-8111-111111111111", runtimeGenerationId: "22222222-2222-4222-8222-222222222222" };

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "withmate-history-host-"));
  const { dbPath } = await createOrVerifyV6FreshDatabase(directory);
  const sessions = new SessionStorageV6(dbPath);
  const source = sessions.insertSession({ ...buildNewSession({
    id: "source", taskTitle: "history", workspaceLabel: "workspace", workspacePath: "C:/workspace", branch: "main", characterId: "mate", character: "Mate",
    characterIconPath: "", characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" }, approvalMode: DEFAULT_APPROVAL_MODE,
  }), messages: [{ role: "user", text: "first" }, { role: "assistant", text: "answer", artifact: { title: "Run", activitySummary: [],
    operationTimeline: [{ type: "command_execution", summary: "npm test", status: "failed", exitCode: 1, details: "failure output" }], changedFiles: [], runChecks: [] } },
  { role: "user", text: "later input" }, { role: "assistant", text: "later answer" }] });
  const scope: SessionHistoryReadScope = { source: { kind: "main", sessionId: source.id, incarnationId: getSessionIncarnationId(source) }, window: { fromSeq: 0, toSeq: 2 } };
  const storage = new MemoryV6Storage(dbPath);
  const bindings = new AgentRuntimeBindingRegistry();
  const turns = new ProviderAgentRuntimeTurnCoordinator();
  const history = new SessionHistoryRuntimeService({ read: async (input) => sessions.readSessionHistory(input), bindingRegistry: bindings, providerAgentRuntimeTurns: turns });
  const runtime = createMemoryV6HttpServer({
    service: new MemoryV6Service({ storage, resolveCharacterById: () => ({ id: "character", name: "Character" }) }),
    apiSecret: "api", operatorApiSecret: "operator", mcpApiSecret: "mcp", fallbackAdmissionApiSecret: "fallback", ...owner,
    agentRuntimeBindingRegistry: bindings, providerAgentRuntimeTurns: turns,
    resolveActorSession: (id) => ({ id, providerId: "codex", characterId: "character", workspacePath: directory }),
    routeAgentRuntimeExtension: (request) => history.route(request),
  });
  await runtime.start();
  const port = runtime.address()!.port;
  const host = new ManagedHttpMcpHost({
    connection: { api: { ...owner, runtimeInstanceId: owner.runtimeGenerationId, baseUrl: `http://127.0.0.1:${port}`, apiSecret: "api" }, credential: { adapter: "mcp", adapterSecret: "mcp" } },
    fallbackAdmissionSecret: "fallback", bindingRegistry: bindings, turns,
  });
  await host.start();
  const clients: Client[] = [];
  // The host currently judges a connection as current through a Memory grant, so the fixture bindings carry Memory grants too.
  function begin(actorSessionId: string, historyScope: SessionHistoryReadScope | null) {
    const projection = bindings.issueOrReuse({ actorSessionId, providerId: "codex",
      operationGrants: [...getMemoryV6AgentRuntimeOperations(), ...(historyScope ? getSessionHistoryAgentRuntimeOperations() : [])],
      authoritySnapshot: { userId: "local-user", characterId: "character", allowedProjectIds: [], ...(historyScope ? { sessionHistoryScope: historyScope } : {}) } });
    const handle = turns.begin({ actorSessionId, providerId: "codex" });
    const binding: ProviderAgentRuntimeBindingProjection = { ...projection, turnCapability: handle.capability, memoryRuntimeOwner: owner };
    return { handle, binding: { ...binding, managedMcp: host.issue(binding, handle) } };
  }
  async function connect(binding: ProviderAgentRuntimeBindingProjection) {
    const client = new Client({ name: "history-integration", version: "1" });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(binding.managedMcp!.sessionHistoryUrl!), {
      requestInit: { headers: { [WITHMATE_MANAGED_MCP_TOKEN_HEADER]: binding.managedMcp!.token } } }));
    return client;
  }
  const cliEnv = (binding: ProviderAgentRuntimeBindingProjection): NodeJS.ProcessEnv => ({ ...process.env,
    WITHMATE_AGENT_RUNTIME_BINDING_REQUIRED: "1", WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE: binding.bindingReference,
    WITHMATE_AGENT_RUNTIME_TURN_CAPABILITY: binding.turnCapability, WITHMATE_MEMORY_RUNTIME_APPLICATION_INSTANCE_ID: owner.applicationInstanceId,
    WITHMATE_MEMORY_RUNTIME_GENERATION_ID: owner.runtimeGenerationId, WITHMATE_MEMORY_API_URL: `http://127.0.0.1:${port}`,
    WITHMATE_MEMORY_API_SECRET: "api", WITHMATE_MEMORY_MCP_API_SECRET: "mcp" });
  return { directory, scope, begin, connect, cliEnv, host,
    async close() {
      await Promise.all(clients.map((client) => client.close().catch(() => undefined)));
      await host.stop(); await runtime.stop(); storage.close(); sessions.close();
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } };
}

// @test-value v2
// kind = "contract"
// claim = "配布履歴CLIとmanaged HTTP MCPは同じ保存履歴を固定範囲で読み、window外を同じ失敗で拒否し、履歴grantのない通常turnのbindingと終了した背景実行をCLIで拒否する"
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
  const f = await fixture();
  try {
    const artifact = await buildWithMateSessionHistoryCli(f.directory);
    const normal = f.begin("main-turn", null);
    const background = f.begin("background-1", f.scope);
    const mcp = await f.connect(background.binding);
    const invokeCli = async (binding: ProviderAgentRuntimeBindingProjection, command: string, body: Record<string, unknown>) => {
      try {
        const result = await promisify(execFile)(process.execPath, [artifact, command, "--json", JSON.stringify(body)], { cwd: f.directory, env: f.cliEnv(binding), windowsHide: true });
        return { code: 0, value: JSON.parse(result.stdout) as Record<string, any> };
      } catch (cause) {
        const result = cause as { code: number; stdout: string };
        return { code: result.code, value: JSON.parse(result.stdout) as Record<string, any> };
      }
    };
    assert.equal((await mcp.listTools()).tools.length, 4);
    for (const [operation, body] of [["list_messages", {}], ["get_message", { seq: 1 }], ["list_operations", { seq: 1 }],
      ["get_operation_detail", { seq: 1, kind: "operation", index: 0 }]] as const) {
      const cli = await invokeCli(background.binding, operation.replaceAll("_", "-"), body);
      const tool = await mcp.callTool({ name: `session_history.${operation}`, arguments: body });
      assert.equal(cli.code, 0);
      assert.deepEqual(cli.value, tool.structuredContent);
    }
    const list = await invokeCli(background.binding, "list-messages", {});
    assert.equal(list.value.total, 3);
    assert.equal((await invokeCli(background.binding, "get-operation-detail", { seq: 1, kind: "operation", index: 0 })).value.text, "failure output");

    const outside = await invokeCli(background.binding, "get-message", { seq: 3 });
    const outsideMcp = await mcp.callTool({ name: "session_history.get_message", arguments: { seq: 3 } });
    assert.deepEqual([outside.code, outside.value.code, outsideMcp.isError], [1, "HISTORY_OUT_OF_RANGE", true]);
    assert.deepEqual(outside.value, outsideMcp.structuredContent);

    const denied = await invokeCli(normal.binding, "list-messages", {});
    assert.deepEqual([denied.code, denied.value.ok, denied.value.code], [1, false, "SESSION_BINDING_FORBIDDEN"]);
    assert.equal((await invokeCli(background.binding, "list-messages", {})).code, 0);

    f.host.release(background.handle);
    const ended = await invokeCli(background.binding, "list-messages", {});
    assert.deepEqual([ended.code, ended.value.code], [1, "HISTORY_EXECUTION_INACTIVE"]);
  } finally { await f.close(); }
});
