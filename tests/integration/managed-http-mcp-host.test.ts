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
import { SessionGraphApplicationService, type SessionGraphStore } from "../../src-electron/session-graph/session-graph-application-service.js";
import { SessionGraphRuntimeService } from "../../src-electron/session-graph/session-graph-runtime-service.js";
import { SessionGraphStorageV6 } from "../../src-electron/session-graph/session-graph-storage-v6.js";
import { getSessionGraphAgentRuntimeOperations } from "../../src-shared/session-graph/session-graph-operation-schema.js";
import type { SessionGraphIdentity, SessionGraphOperation, SessionGraphOwner, SessionGraphRecord, SessionGraphRequest } from "../../src-shared/session-graph/session-graph-contract.js";
import { buildWithMateSessionGraphCli } from "../../scripts/build/build-withmate-memory-cli.js";

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
      character_id,character_snapshot_json,created_at,updated_at,last_active_at,incarnation_id)
      VALUES (?, 'Actor', 'active', 'codex', 1, 'test', 'on-request', 'character', '{}', ?, ?, ?, ?)`)
      .run(id, "2026-10-10T00:00:00Z", "2026-10-10T00:00:00Z", "2026-10-10T00:00:00Z", `incarnation-${id}`);
  }
  const incarnations = new Map((database.prepare("SELECT id, incarnation_id FROM sessions_v6").all() as { id: string; incarnation_id: string }[]).map((row) => [row.id, row.incarnation_id]));
  database.prepare("INSERT INTO auxiliary_sessions (id,parent_session_id,status,created_at,updated_at,character_id) VALUES ('aux-a','actor-a','active',?,?,'character')")
    .run("2026-10-10T00:00:00Z", "2026-10-10T00:00:00Z");
  database.close();
  const graphOwner = (id: string) => {
    const parentId = id === "aux-a" ? "actor-a" : id;
    const incarnationId = incarnations.get(parentId);
    return incarnationId ? { sessionId: parentId, incarnationId } : null;
  };
  const storage = new MemoryV6Storage(dbPath);
  const bindings = new AgentRuntimeBindingRegistry();
  const turns = new ProviderAgentRuntimeTurnCoordinator();
  const graphStorage = new SessionGraphStorageV6(dbPath);
  const graphStore: SessionGraphStore = { async execute<K extends SessionGraphOperation>(scope: SessionGraphOwner, operation: K, request: SessionGraphRequest<K>, identity?: SessionGraphIdentity, actors?: SessionGraphIdentity[]) {
    return graphStorage.execute(scope, operation, request, identity, actors);
  } };
  const graphApplication = new SessionGraphApplicationService({ getStore: () => graphStore, resolveSession: (id) => {
    const owner = graphOwner(id);
    return owner ? { owner, providerId: "codex", generation: "fixture",
      identity: { sessionId: id, sessionTitle: "Actor", role: id === "aux-a" ? "auxiliary" : "main", character: { id: "character", name: "Character" } } } : null;
  } });
  const graphRuntime = new SessionGraphRuntimeService({ applicationService: graphApplication, bindingRegistry: bindings, providerAgentRuntimeTurns: turns });
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
    routeAgentRuntimeExtension: async (request) => await glossary.route(request) ?? await graphRuntime.route(request),
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
      actorSessionId, providerId: "codex", operationGrants: [...getMemoryV6AgentRuntimeOperations(), ...getGlossaryAgentRuntimeOperations(), ...getSessionGraphAgentRuntimeOperations()],
      authoritySnapshot: { userId: "local-user", characterId: "character", allowedProjectIds: [],
        glossaryPrimaryCheckout: projectGlossaryCheckoutAuthority(checkout), sessionGraphOwner: graphOwner(actorSessionId) },
    });
    const turn = await glossary.beginProviderTurn(actorSessionId, { ...projection, memoryRuntimeOwner: owner });
    const managedMcp = host.issue(turn.binding, turn.handle, signal);
    return { ...turn, binding: { ...turn.binding, managedMcp } };
  }
  async function connect(binding: ProviderAgentRuntimeBindingProjection, endpoint: "memory" | "glossary" | "graph") {
    const client = new Client({ name: "http-integration", version: "1" });
    clients.push(client);
    const transport = new StreamableHTTPClientTransport(new URL(endpoint === "memory"
      ? binding.managedMcp!.memoryUrl : endpoint === "glossary" ? binding.managedMcp!.glossaryUrl : binding.managedMcp!.sessionGraphUrl), {
      requestInit: { headers: { [WITHMATE_MANAGED_MCP_TOKEN_HEADER]: binding.managedMcp!.token } },
    });
    await client.connect(transport);
    return { client, transport };
  }
  return {
    begin, connect, host, bindings, turns, storage, directory, glossary,
    cliEnv(binding: ProviderAgentRuntimeBindingProjection): NodeJS.ProcessEnv {
      return { ...process.env,
        WITHMATE_AGENT_RUNTIME_BINDING_REQUIRED: "1",
        WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE: binding.bindingReference,
        WITHMATE_AGENT_RUNTIME_TURN_CAPABILITY: binding.turnCapability,
        WITHMATE_MEMORY_RUNTIME_APPLICATION_INSTANCE_ID: owner.applicationInstanceId,
        WITHMATE_MEMORY_RUNTIME_GENERATION_ID: owner.runtimeGenerationId,
        WITHMATE_MEMORY_API_URL: `http://127.0.0.1:${runtime.address()!.port}`,
        WITHMATE_MEMORY_API_SECRET: "api", WITHMATE_MEMORY_MCP_API_SECRET: "mcp",
      };
    },
    async close() {
      await Promise.all(clients.map((client) => client.close()));
      await host.stop();
      await runtime.stop();
      storage.close();
      graphStorage.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

// @test-value v2
// kind = "contract"
// claim = "Graphの第3HTTP endpointは6操作を公開し、同CharacterのMain/Auxを別Sessionとして自己解決・明示担当保存・由来保持し、別parent・由来欠落・競合・失効turnを拒否する"
// oracle = { type = "contract", ref = "docs/design/session-graph.md" }
// fault = "provider向けURLからGraphを発見・実行できないか、recordが別actorへ帰属しCASを無視する"
// observable = "SDK tools list、apply/recent/context/conflict応答、担当・由来・recorder snapshotと失効後HTTP status"
// observation_boundary = "public-boundary"
// scope = "managed HTTP Graph MCP SDKからruntime challenge・SQLiteまで"
// lifecycle = "permanent"
// impact = "実際のmanaged provider接続でGraph復元と競合制御が利用不能になる"
// distinction = "application単体testは第3endpointのdiscoveryとHTTP認証・tool routingを通らない"
// @end-test-value
test("third managed HTTP MCP endpoint discovers and executes Session Graph", async () => {
  const f = await fixture();
  try {
    const turn = await f.begin();
    const graph = await f.connect(turn.binding, "graph");
    assert.deepEqual((await graph.client.listTools()).tools.map((tool) => tool.name).sort(), [
      "session_graph.apply", "session_graph.context", "session_graph.get", "session_graph.list_topics", "session_graph.recent", "session_graph.search",
    ]);
    const topics = await graph.client.callTool({ name: "session_graph.list_topics", arguments: {} });
    assert.deepEqual(topics.structuredContent, { status: "ok", revision: 0, items: [], total: 0, offset: 0, hasMore: false, incomplete: false });
    const record = { id: "requirement", topicId: "topic", kind: "requirement", title: "Restore scope", detail: "Trusted record", scope: "feature", references: [] };
    const missingOrigin = await graph.client.callTool({ name: "session_graph.apply", arguments: { expectedRevision: 0,
      topics: [{ id: "topic", title: "Topic" }], records: [record] } });
    assert.equal(missingOrigin.isError, true);
    assert.deepEqual((await graph.client.callTool({ name: "session_graph.list_topics", arguments: {} })).structuredContent, topics.structuredContent);
    const applied = await graph.client.callTool({ name: "session_graph.apply", arguments: { expectedRevision: 0,
      topics: [{ id: "topic", title: "Topic" }], records: [{ ...record, origin: { type: "user" } }] } });
    assert.deepEqual(applied.structuredContent, { status: "ok", revision: 1 });
    assert.notEqual(applied.isError, true);
    const auxTurn = await f.begin("aux-a");
    const auxGraph = await f.connect(auxTurn.binding, "graph");
    const foreignActor = await auxGraph.client.callTool({ name: "session_graph.apply", arguments: { expectedRevision: 1,
      records: [{ ...record, id: "foreign", origin: { type: "agent" }, actor: { sessionId: "actor-b" } }] } });
    assert.equal(foreignActor.isError, true);
    const auxApplied = await auxGraph.client.callTool({ name: "session_graph.apply", arguments: { expectedRevision: 1, records: [
      { ...record, id: "external", origin: { type: "external", label: "Specification" } },
      { ...record, id: "assigned", origin: { type: "agent" }, actor: { sessionId: "actor-a" }, actorRole: "実装担当" },
    ] } });
    assert.deepEqual(auxApplied.structuredContent, { status: "ok", revision: 2 });
    const updated = await auxGraph.client.callTool({ name: "session_graph.apply", arguments: { expectedRevision: 2,
      records: [{ ...record, title: "Updated by Aux" }] } });
    assert.deepEqual(updated.structuredContent, { status: "ok", revision: 3 });
    for (const operation of ["recent", "context"] as const) {
      const result = await graph.client.callTool({ name: `session_graph.${operation}`, arguments: { limit: 10 } });
      assert.notEqual(result.isError, true, JSON.stringify(result));
      const page = result.structuredContent as { revision: number; items: SessionGraphRecord[] };
      assert.equal(page.revision, 3);
      assert.equal(page.items.length, 3);
      const byId = new Map(page.items.map((item) => [item.id, item]));
      const main = byId.get("requirement")!;
      assert.equal(main.title, "Updated by Aux");
      assert.deepEqual(main.origin, { type: "user" });
      assert.deepEqual(main.actor, { sessionId: "actor-a" });
      assert.deepEqual(main.recordedBy, { sessionId: "actor-a", sessionTitle: "Actor", role: "main", character: { id: "character", name: "Character" } });
      assert.deepEqual(main.actorSnapshot, main.recordedBy);
      const external = byId.get("external")!;
      assert.deepEqual(external.origin, { type: "external", label: "Specification" });
      assert.deepEqual(external.actor, { sessionId: "aux-a" });
      assert.equal(external.actorSnapshot.role, "auxiliary");
      assert.equal(external.recordedBy.sessionId, "aux-a");
      assert.deepEqual(external.actorSnapshot.character, main.actorSnapshot.character);
      const assigned = byId.get("assigned")!;
      assert.deepEqual(assigned.actor, { sessionId: "actor-a" });
      assert.deepEqual(assigned.origin, { type: "agent" });
      assert.equal(assigned.recordedBy.sessionId, "aux-a");
      assert.deepEqual(assigned.actorSnapshot, main.actorSnapshot);
      assert.equal(assigned.actorRole, "実装担当");
    }
    const auxRecords = await graph.client.callTool({ name: "session_graph.context", arguments: { recordedBySessionId: "aux-a" } });
    assert.deepEqual((auxRecords.structuredContent as { items: SessionGraphRecord[] }).items.map((item) => item.id).sort(), ["assigned", "external"]);
    const otherTurn = await f.begin("actor-b");
    const otherGraph = await f.connect(otherTurn.binding, "graph");
    assert.deepEqual((await otherGraph.client.callTool({ name: "session_graph.recent", arguments: {} })).structuredContent,
      { status: "ok", revision: 0, items: [], total: 0, offset: 0, hasMore: false, incomplete: false, relations: [], externalEndpoints: [], relationsTruncated: false });
    const conflict = await graph.client.callTool({ name: "session_graph.apply", arguments: { expectedRevision: 0, topics: [{ id: "other", title: "Other" }] } });
    assert.equal(conflict.isError, true);
    assert.deepEqual(conflict.structuredContent, { status: "conflict", revision: 3 });
    f.glossary.endProviderTurn(auxTurn.handle);
    assert.equal((await fetch(auxTurn.binding.managedMcp!.sessionGraphUrl, { method: "POST", headers: {
      [WITHMATE_MANAGED_MCP_TOKEN_HEADER]: auxTurn.binding.managedMcp!.token,
    } })).status, 401);
  } finally { await f.close(); }
});

// @test-value v2
// kind = "contract"
// claim = "配布Graph CLIとmanaged HTTP MCPは同じ保存Graphを読み書きし、競合と失効turnを両入口で拒否する"
// oracle = { type = "contract", ref = "docs/design/session-graph.md" }
// fault = "単体bundleが起動不能、CLIが別Graphを更新、または認証・CASを迂回する"
// observable = "分離directoryのCLI process exit/JSON、SDK MCP応答、保存後の全5読取操作と失効後の結果"
// observation_boundary = "consumer"
// scope = "配布Graph CLI/managed HTTP MCPからruntime challengeとSQLite保存まで"
// lifecycle = "permanent"
// impact = "配布CLIから共有Graphへ安全に復元・記録できなくなる"
// distinction = "adapter単体testと異なりbundleを別processで起動し実HTTP認証と保存を通す"
// @end-test-value
test("bundled Graph CLI and managed MCP share storage and authorization", async () => {
  const f = await fixture();
  try {
    const artifact = await buildWithMateSessionGraphCli(f.directory);
    const turn = await f.begin("aux-a");
    const graph = await f.connect(turn.binding, "graph");
    const invokeCli = async (command: string, body: Record<string, unknown>) => {
      try {
        const result = await promisify(execFile)(process.execPath, [artifact, command, "--json", JSON.stringify(body)],
          { cwd: f.directory, env: f.cliEnv(turn.binding), windowsHide: true });
        return { code: 0, value: JSON.parse(result.stdout) as Record<string, unknown> };
      } catch (cause) {
        const result = cause as { code: number; stdout: string };
        return { code: result.code, value: JSON.parse(result.stdout) as Record<string, unknown> };
      }
    };
    const batch = { expectedRevision: 0, topics: [{ id: "parity", title: "Parity" }], records: [{
      id: "work", topicId: "parity", kind: "activity", title: "CLI work", detail: "Shared scope", scope: "parity",
      origin: { type: "agent" }, references: [], progress: "in_progress",
    }] };
    assert.deepEqual(await invokeCli("apply", batch), { code: 0, value: { status: "ok", revision: 1 } });
    const updated = await graph.client.callTool({ name: "session_graph.apply", arguments: {
      expectedRevision: 1, records: [{ ...batch.records[0], title: "MCP work" }],
    } });
    assert.deepEqual(updated.structuredContent, { status: "ok", revision: 2 });
    for (const [operation, body] of [
      ["list_topics", {}], ["recent", {}], ["context", { topicId: "parity" }],
      ["get", { ids: ["work"] }], ["search", { query: "MCP work" }],
    ] as const) {
      const cli = await invokeCli(operation, body);
      const mcp = await graph.client.callTool({ name: `session_graph.${operation}`, arguments: body });
      assert.equal(cli.code, 0);
      assert.deepEqual(cli.value, mcp.structuredContent);
      assert.equal((cli.value.items as unknown[]).length, 1);
      if (operation !== "list_topics") {
        const record = (cli.value.items as SessionGraphRecord[])[0];
        assert.equal(record.actor.sessionId, "aux-a");
        assert.equal(record.recordedBy.sessionId, "aux-a");
      }
    }
    const conflictCli = await invokeCli("apply", batch);
    const conflictMcp = await graph.client.callTool({ name: "session_graph.apply", arguments: batch });
    assert.equal(conflictCli.code, 1);
    assert.deepEqual(conflictCli.value, conflictMcp.structuredContent);
    assert.equal(conflictMcp.isError, true);
    const foreign = { expectedRevision: 2, records: [{ ...batch.records[0], actor: { sessionId: "actor-b" } }] };
    const foreignCli = await invokeCli("apply", foreign);
    const foreignMcp = await graph.client.callTool({ name: "session_graph.apply", arguments: foreign });
    assert.equal(foreignCli.code, 1);
    assert.deepEqual(foreignCli.value, foreignMcp.structuredContent);
    f.glossary.endProviderTurn(turn.handle);
    const expired = await invokeCli("apply", { expectedRevision: 2 });
    assert.equal(expired.code, 1);
    assert.equal(expired.value.code, "SESSION_GRAPH_TURN_INACTIVE");
    assert.equal((await fetch(turn.binding.managedMcp!.sessionGraphUrl, { method: "POST", headers: {
      [WITHMATE_MANAGED_MCP_TOKEN_HEADER]: turn.binding.managedMcp!.token,
    } })).status, 401);
  } finally { await f.close(); }
});

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
    const invalid = await memory.client.callTool({ name: "memory.append", arguments: {
      ...append, target: { kind: "project", project: { type: "id", id: "ungranted-project" } },
    } });
    assert.equal(invalid.isError, true);
    assert.deepEqual((invalid.structuredContent as { error: Record<string, unknown> }).error, {
      code: "MEMORY_INVALID_FIELD", message: "Memory target is invalid or not authorized.", field: "target",
      retryable: false, conversationMayContinue: true, effect: "none",
    });
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
