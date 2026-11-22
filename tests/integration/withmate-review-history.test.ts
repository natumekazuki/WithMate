import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startAgentRuntimeApi } from "../../src-electron/platform/agent-runtime/runtime-api.js";
import { AgentRuntimeBindingRegistry } from "../../src-electron/providers/agent-runtime-binding.js";
import { ProviderAgentRuntimeTurnCoordinator } from "../../src-electron/providers/provider-agent-runtime-turn-coordinator.js";
import { WITHMATE_MANAGED_MCP_TOKEN_HEADER } from "../../src-electron/providers/managed-http-mcp.js";
import { SessionManagementApplication } from "../../src-electron/session/session-management-application.js";
import { SessionManagementRuntimeService } from "../../src-electron/session/session-management-runtime-service.js";
import { getSessionAgentRuntimeOperations } from "../../src-shared/session/session-management-contract.js";

// @test-value v2
// kind = "security"
// claim = "審査資格は認証済みの通常履歴読取へだけ届き、他Crewの保存履歴も既存範囲で読み、元Turn終了で失効する"
// oracle = { type = "contract", ref = "docs/design/withmate-auto-review.md#審査会話と履歴の境界" }
// fault = "審査資格を通常MCPへ流用できる、履歴以外を呼べる、別履歴を不当に遮断する、またはTurn終了後も資格が使える"
// observable = "実HTTP MCP tool一覧・読取結果、禁止操作の非配送、endpoint・失効HTTP status"
// observation_boundary = "public-boundary"
// scope = "review MCP hostの認証から既存Session Runtime Applicationの履歴読取境界"
// lifecycle = "permanent"
// impact = "審査役が委譲やSession変更を実行するか、終了後も履歴を取得できる"
// distinction = "通常MCP testは同一Turnに別資格を持たせたときの認可と履歴範囲を検証しない"
// risk_tags = ["authentication", "authorization", "privacy"]
// @end-test-value
test("review credentials admit only saved-history operations and expire with the source turn", async () => {
  const directory = await mkdtemp(join(tmpdir(), "withmate-review-history-"));
  const bindings = new AgentRuntimeBindingRegistry();
  const turns = new ProviderAgentRuntimeTurnCoordinator();
  const source = { kind: "main", sessionId: "source", incarnationId: "generation-source" } as const;
  const other = { kind: "main", sessionId: "other", incarnationId: "generation-other" } as const;
  let writes = 0;
  let reads = 0;
  const unused = async () => { writes++; throw new Error("unexpected operation"); };
  const application = new SessionManagementApplication({
    listSessions: async () => [source, other].map((target) => ({ id: target.sessionId, incarnationId: target.incarnationId,
      kind: "main", role: "standalone", sessionRole: "standalone", rootSessionId: target.sessionId, parentSessionId: null,
      createdBySessionId: null, mainSessionId: target.sessionId, mainIncarnationId: target.incarnationId,
      title: target.sessionId, description: "", runState: "idle", provider: "copilot", workspacePath: directory })),
    operatingPolicy: unused, currentTurn: unused, updateMetadata: unused, directories: unused, enqueue: unused,
    getReceipt: unused, cancelReceipt: unused, stopTurn: unused, steer: unused, crewFolder: unused, coordinate: unused,
    createChild: unused, catalog: unused,
    readExecution: async (destination, operation) => {
      assert.equal(operation, "get_message");
      assert.equal(destination.id, other.sessionId);
      reads++;
      const text = "Saved user instruction in a different Crew";
      return { ok: true, seq: 0, role: "user", turn: null, text, offset: 0, nextOffset: null, totalChars: text.length };
    },
  });
  const routing = new SessionManagementRuntimeService({ application, bindingRegistry: bindings, providerAgentRuntimeTurns: turns });
  const runtime = await startAgentRuntimeApi({ applicationInstanceId: "11111111-1111-4111-8111-111111111111",
    buildChannel: "development", registryDirectoryPath: join(directory, "registry"), runtimePathSecurity: async () => {},
    agentRuntimeBindingRegistry: bindings, providerAgentRuntimeTurns: turns, routeAgentRuntimeExtension: (request) => routing.route(request) });
  const client = new Client({ name: "review-history-test", version: "1" });
  try {
    const providerId = "copilot";
    const binding = bindings.issueOrReuse({ actorSessionId: source.sessionId, actorSource: source, providerId,
      operationGrants: getSessionAgentRuntimeOperations(), authoritySnapshot: { sessionIdentity: source } });
    const handle = turns.begin({ actorSessionId: source.sessionId, providerId });
    const normal = runtime.managedMcp.issue({ ...binding, turnCapability: handle.capability,
      runtimeOwner: { applicationInstanceId: runtime.applicationInstanceId, runtimeGenerationId: runtime.runtimeGenerationId } }, handle);
    const history = runtime.managedMcp.issueReviewHistory(handle);
    const headers = { [WITHMATE_MANAGED_MCP_TOKEN_HEADER]: history.token };
    assert.notEqual(history.token, normal.token);
    assert.deepEqual(history.source, source);
    assert.equal((await fetch(normal.sessionUrl!, { headers })).status, 403);
    assert.equal((await fetch(history.url, { headers: { [WITHMATE_MANAGED_MCP_TOKEN_HEADER]: normal.token } })).status, 403);
    await client.connect(new StreamableHTTPClientTransport(new URL(history.url), { requestInit: { headers } }));
    assert.deepEqual((await client.listTools()).tools.map(({ name }) => name).sort(), [
      "get_execution", "get_execution_input", "get_message", "list_execution_inputs", "list_executions", "list_messages", "list_sent_deliveries", "list_sent_steers",
    ]);
    const result = await client.callTool({ name: "get_message", arguments: { target: other, seq: 0 } });
    assert.match(JSON.stringify(result.structuredContent), /Saved user instruction in a different Crew/);
    const rejected = await client.callTool({ name: "session.enqueue", arguments: {} });
    assert.equal(rejected.isError, true);
    assert.deepEqual([reads, writes, history.readCount()], [1, 0, 1]);
    runtime.managedMcp.release(handle);
    assert.equal(history.isCurrent(), false);
    assert.equal((await fetch(history.url, { headers })).status, 401);
  } finally {
    await client.close();
    await runtime.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
