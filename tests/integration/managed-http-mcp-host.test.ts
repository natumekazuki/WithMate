import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createOrVerifyV6FreshDatabase } from "../../src-electron/storage/app-database-v6-bootstrap.js";
import { MemoryV6Storage } from "../../src-electron/memory/memory-v6-storage.js";
import { MemoryV6Service } from "../../src-electron/memory/memory-v6-service.js";
import { createMemoryV6HttpServer, getMemoryV6AgentRuntimeOperations } from "../../src-electron/memory/memory-v6-http-server.js";
import { ManagedHttpMcpHost } from "../../src-electron/memory/managed-http-mcp-host.js";
import { AgentRuntimeBindingRegistry, type ProviderAgentRuntimeBindingProjection } from "../../src-electron/providers/agent-runtime-binding.js";
import { ProviderAgentRuntimeTurnCoordinator } from "../../src-electron/providers/provider-agent-runtime-turn-coordinator.js";
import { GlossaryApplicationService, projectGlossaryCheckoutAuthority } from "../../src-electron/glossary/glossary-application-service.js";
import { GlossaryRuntimeService } from "../../src-electron/glossary/glossary-runtime-service.js";
import { getGlossaryAgentRuntimeOperations } from "../../src-shared/glossary/glossary-operation-schema.js";
import { WITHMATE_MEMORY_MCP_TOOL_DEFINITIONS } from "../../src-electron/platform/mcp/withmate-memory-mcp.js";
import { GLOSSARY_MCP_TOOL_DEFINITIONS } from "../../src-electron/platform/mcp/withmate-glossary-mcp.js";
import { WITHMATE_MANAGED_MCP_TOKEN_HEADER } from "../../src-electron/providers/managed-http-mcp.js";

const owner = { applicationInstanceId: "11111111-1111-4111-8111-111111111111",
  runtimeGenerationId: "22222222-2222-4222-8222-222222222222" };
const append = { target: { kind: "user-global" }, kind: "decision", title: "HTTP turn",
  body: "Captured actor", preview: "Captured actor", tags: [], idempotencyKey: "http-host-entry" };

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "withmate-managed-http-"));
  await promisify(execFile)("git", ["init", "--quiet", "--initial-branch=main", directory], { windowsHide: true });
  const { dbPath } = await createOrVerifyV6FreshDatabase(directory);
  const database = new DatabaseSync(dbPath);
  database.prepare("INSERT INTO characters (id, name, created_at, updated_at) VALUES ('character', 'Character', ?, ?)")
    .run("2026-10-10T00:00:00Z", "2026-10-10T00:00:00Z");
  for (const id of ["actor-a", "actor-b"]) {
    database.prepare(`INSERT INTO sessions_v6 (id,title,state,provider_id,catalog_revision,model_id,approval_mode,
      character_id,character_snapshot_json,created_at,updated_at,last_active_at)
      VALUES (?, 'Actor', 'active', 'codex', 1, 'test', 'on-request', 'character', '{}', ?, ?, ?)`)
      .run(id, "2026-10-10T00:00:00Z", "2026-10-10T00:00:00Z", "2026-10-10T00:00:00Z");
  }
  database.close();
  const storage = new MemoryV6Storage(dbPath);
  const bindings = new AgentRuntimeBindingRegistry();
  const turns = new ProviderAgentRuntimeTurnCoordinator();
  const glossaryApplication = new GlossaryApplicationService();
  const checkout = await glossaryApplication.resolvePrimaryCheckout(directory);
  const glossary = new GlossaryRuntimeService({
    applicationService: glossaryApplication, bindingRegistry: bindings, providerAgentRuntimeTurns: turns,
    resolveActorSession: (id) => ({ id, providerId: "codex", characterId: "character", workspacePath: directory }),
    getProactiveCreateLimit: () => 1,
  });
  const service = new MemoryV6Service({ storage, resolveCharacterById: () => ({ id: "character", name: "Character" }) });
  const runtime = createMemoryV6HttpServer({
    service, apiSecret: "api", operatorApiSecret: "operator", mcpApiSecret: "mcp",
    fallbackAdmissionApiSecret: "fallback", ...owner,
    agentRuntimeBindingRegistry: bindings, providerAgentRuntimeTurns: turns,
    resolveActorSession: (id) => ({ id, providerId: "codex", characterId: "character", workspacePath: directory }),
    routeAgentRuntimeExtension: (request) => glossary.route(request),
  });
  await runtime.start();
  const host = new ManagedHttpMcpHost({
    connection: { api: { ...owner, runtimeInstanceId: owner.runtimeGenerationId,
      baseUrl: `http://127.0.0.1:${runtime.address()!.port}`, apiSecret: "api" },
      credential: { adapter: "mcp", adapterSecret: "mcp" } },
    fallbackAdmissionSecret: "fallback", bindingRegistry: bindings, turns,
  });
  await host.start();
  const clients: Client[] = [];
  async function begin(actorSessionId = "actor-a", signal?: AbortSignal) {
    const projection = bindings.issueOrReuse({
      actorSessionId, providerId: "codex", operationGrants: [...getMemoryV6AgentRuntimeOperations(), ...getGlossaryAgentRuntimeOperations()],
      authoritySnapshot: { userId: "local-user", characterId: "character", allowedProjectIds: [],
        glossaryPrimaryCheckout: projectGlossaryCheckoutAuthority(checkout) },
    });
    const turn = await glossary.beginProviderTurn(actorSessionId, { ...projection, memoryRuntimeOwner: owner });
    const managedMcp = host.issue(turn.binding, turn.handle, signal);
    return { ...turn, binding: { ...turn.binding, managedMcp } };
  }
  async function connect(binding: ProviderAgentRuntimeBindingProjection, endpoint: "memory" | "glossary") {
    const client = new Client({ name: "http-integration", version: "1" });
    clients.push(client);
    const transport = new StreamableHTTPClientTransport(new URL(endpoint === "memory"
      ? binding.managedMcp!.memoryUrl : binding.managedMcp!.glossaryUrl), {
      requestInit: { headers: { [WITHMATE_MANAGED_MCP_TOKEN_HEADER]: binding.managedMcp!.token } },
    });
    await client.connect(transport);
    return { client, transport };
  }
  return {
    begin, connect, host, bindings, turns, storage, directory, glossary,
    async close() {
      await Promise.all(clients.map((client) => client.close()));
      await host.stop();
      await runtime.stop();
      storage.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

// @test-value v2
// kind = "contract"
// claim = "共有HTTP入口はcanonical Memory・Glossaryのtool名一覧を公開し、list_targets・append・createとappendのdomain errorを届け、保存entryを接続actor-aへ帰属させる"
// oracle = { type = "adr", ref = "docs/adr/027-shared-localhost-http-mcp-turn-identity.md" }
// fault = "HTTPのtool名一覧がcanonical一覧と異なる、実行したread・mutation・domain errorが届かない、または保存entryのsource Sessionが接続actor-aと異なる"
// observable = "SDK tools list・call resultとSQLite entry source、および保存済みGlossary YAML"
// observation_boundary = "public-boundary"
// scope = "実HTTP MCP SDKから既存runtime challenge・SQLite・Glossary filesystemまで"
// lifecycle = "permanent"
// impact = "provider変更でMemory・Glossary機能やSession識別が欠けると利用者データを誤保存する"
// distinction = "stdio testと型検査は共有HTTP listener・protocol・実保存の接続を通らない。モデル不要の小さいfixtureで確認する"
// @end-test-value
test("shared HTTP MCP preserves canonical tools and actor-bound operations", async () => {
  const f = await fixture();
  try {
    const turn = await f.begin();
    const memory = await f.connect(turn.binding, "memory");
    const glossary = await f.connect(turn.binding, "glossary");
    assert.deepEqual((await memory.client.listTools()).tools.map((tool) => tool.name).sort(),
      WITHMATE_MEMORY_MCP_TOOL_DEFINITIONS.map((tool) => tool.name).sort());
    assert.deepEqual((await glossary.client.listTools()).tools.map((tool) => tool.name).sort(),
      GLOSSARY_MCP_TOOL_DEFINITIONS.map((tool) => tool.name).sort());
    const targets = await memory.client.callTool({ name: "memory.list_targets", arguments: {} });
    assert.notEqual(targets.isError, true);
    const saved = await memory.client.callTool({ name: "memory.append", arguments: append });
    assert.notEqual(saved.isError, true, JSON.stringify(saved));
    const id = (saved.structuredContent as { entry: { id: string } }).entry.id;
    assert.equal(f.storage.getEntry(id)?.source.sessionId, "actor-a");
    const invalid = await memory.client.callTool({ name: "memory.append", arguments: { ...append, target: { kind: "character", characterId: "other" } } });
    assert.equal(invalid.isError, true);
    const created = await glossary.client.callTool({ name: "glossary.create", arguments: {
      selector: { kind: "primary" }, mode: "explicit", entry: { term: "Captured", definition: "Actor-bound HTTP" },
    } });
    assert.notEqual(created.isError, true, JSON.stringify(created));
    assert.match(await readFile(join(f.directory, ".withmate", "glossary.yaml"), "utf8"), /Captured/);
    const before = turn.binding.managedMcp!.token;
    await memory.transport.terminateSession();
    const reconnected = await f.connect(turn.binding, "memory");
    assert.notEqual((await reconnected.client.callTool({ name: "memory.list_targets", arguments: {} })).isError, true);
    assert.equal(f.host.issue(turn.binding, turn.handle).token, before);
  } finally { await f.close(); }
});

// @test-value v2
// kind = "security"
// claim = "MCP session IDは別actorの権限にならず、全HTTP methodはturn tokenを検証し、取消・旧turn cleanupは次turnに権限を渡さない"
// oracle = { type = "adr", ref = "docs/adr/027-shared-localhost-http-mcp-turn-identity.md" }
// fault = "protocol session IDだけで認可する、GET・DELETEの認証を省く、またはold handle cleanupで次turnを失効する"
// observable = "HTTP statusと取消前後の共有state、新turn SDK read結果"
// observation_boundary = "public-boundary"
// scope = "shared listenerのtoken・MCP session分離とexact turn終了"
// lifecycle = "permanent"
// impact = "終了済み・別actorのproviderが現turnの操作を実行するか正常な次turnが誤拒否される"
// distinction = "coordinator単体testはHTTP header認証とprotocol session選択の組合せを通らない"
// @end-test-value
test("HTTP session selectors never replace captured turn credentials", async () => {
  const f = await fixture();
  try {
    const cancel = new AbortController();
    const old = await f.begin("actor-a", cancel.signal);
    const other = await f.begin("actor-b");
    const memory = await f.connect(old.binding, "memory");
    const url = old.binding.managedMcp!.memoryUrl;
    for (const method of ["GET", "DELETE", "POST"]) {
      assert.equal((await fetch(url, { method, headers: { "mcp-session-id": memory.transport.sessionId! } })).status, 401);
    }
    const cross = await fetch(url, { method: "DELETE", headers: {
      "mcp-session-id": memory.transport.sessionId!, [WITHMATE_MANAGED_MCP_TOKEN_HEADER]: other.binding.managedMcp!.token,
    } });
    assert.equal(cross.status, 404);
    assert.equal((await fetch(url, { method: "GET", headers: {
      [WITHMATE_MANAGED_MCP_TOKEN_HEADER]: old.binding.managedMcp!.token, origin: "http://localhost",
    } })).status, 403);
    cancel.abort();
    assert.equal(Atomics.load(new Int32Array(old.handle.revocationState), 0), 1);
    const next = await f.begin();
    assert.notEqual(next.binding.managedMcp!.token, old.binding.managedMcp!.token);
    f.host.release(old.handle);
    f.glossary.endProviderTurn(old.handle);
    assert.equal((await fetch(url, { headers: { [WITHMATE_MANAGED_MCP_TOKEN_HEADER]: old.binding.managedMcp!.token } })).status, 401);
    const live = await f.connect(next.binding, "memory");
    assert.notEqual((await live.client.callTool({ name: "memory.list_targets", arguments: {} })).isError, true);
  } finally { await f.close(); }
});

// @test-value v2
// kind = "security"
// claim = "HTTP credentialはownerとbinding generationに固定され、binding撤回とhost shutdownはqueued副作用に渡す共有turn stateも即時失効する"
// oracle = { type = "adr", ref = "docs/adr/027-shared-localhost-http-mcp-turn-identity.md" }
// fault = "owner違いでtokenを発行する、registry変更を見逃す、またはsocketだけ閉じてWorker側stateをactiveに残す"
// observable = "issue拒否・失効後HTTP status・共有stateと新generationのread結果"
// observation_boundary = "public-boundary"
// scope = "HTTP hostのcanonical registry subscriptionとruntime lifetime"
// lifecycle = "permanent"
// impact = "削除Session・reset前runtimeの遅延処理がDBまたはfileへ副作用を残す"
// distinction = "Worker testはstateを受ける側だけを検証する。本testはMain側lifecycleがそのstateを失効する結線を確認する"
// @end-test-value
test("binding revocation and host shutdown revoke the captured shared state", async () => {
  const f = await fixture();
  try {
    const old = await f.begin();
    assert.throws(() => f.host.issue({ ...old.binding,
      memoryRuntimeOwner: { ...owner, runtimeGenerationId: "another-generation" } }, old.handle));
    f.bindings.revokeSession("actor-a");
    assert.equal(Atomics.load(new Int32Array(old.handle.revocationState), 0), 1);
    assert.equal((await fetch(old.binding.managedMcp!.memoryUrl, { headers: {
      [WITHMATE_MANAGED_MCP_TOKEN_HEADER]: old.binding.managedMcp!.token,
    } })).status, 401);
    const next = await f.begin();
    const connected = await f.connect(next.binding, "memory");
    assert.notEqual((await connected.client.callTool({ name: "memory.list_targets", arguments: {} })).isError, true);
    await f.host.stop();
    assert.equal(Atomics.load(new Int32Array(next.handle.revocationState), 0), 1);
    assert.throws(() => f.host.issue(next.binding, next.handle), /unavailable/);
  } finally { await f.close(); }
});
