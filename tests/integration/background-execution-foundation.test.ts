import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildNewSession, type Session } from "../../src-shared/session/session-state.js";
import { matchesSessionHistorySource, type SessionHistorySource } from "../../src-shared/session/session-history-read-scope.js";
import type { BackgroundPurpose, BackgroundExecutionScope } from "../../src-shared/agent-runtime/background-execution-scope.js";
import { createOrVerifyV6FreshDatabase } from "../../src-electron/storage/app-database-v6-bootstrap.js";
import { readConversationQuerySnapshot, type MessageTable } from "../../src-electron/storage/conversation-query.js";
import { AuxiliarySessionStorage } from "../../src-electron/auxiliary/auxiliary-session-storage.js";
import { AgentRuntimeBindingRegistry, type ProviderAgentRuntimeBindingProjection } from "../../src-electron/providers/agent-runtime-binding.js";
import { ProviderAgentRuntimeTurnCoordinator } from "../../src-electron/providers/provider-agent-runtime-turn-coordinator.js";
import { BackgroundExecutionService, type BackgroundExecution } from "../../src-electron/providers/background-execution-service.js";
import { authorizeSessionHistoryRead } from "../../src-electron/providers/session-history-runtime-authorization.js";
import { buildCodexManagedHttpMcpArguments, buildCodexManagedHttpMcpConfig, buildManagedHttpMcpServers,
  WITHMATE_MANAGED_MCP_TOKEN_HEADER } from "../../src-electron/providers/managed-http-mcp.js";
import { resolveAgentRuntimeBindingReference, resolveAgentRuntimeTurnCapability } from "../../src-electron/platform/mcp/withmate-memory-runtime-client.js";
import { WITHMATE_AGENT_RUNTIME_EXTENSION_EXCHANGE_PATH } from "../../src-electron/platform/memory/memory-runtime-exchange.js";
import { assertRuntimeTurnAdmission, runWithRuntimeTurnAdmission } from "../../src-electron/platform/memory/runtime-turn-admission.js";
import { ManagedHttpMcpHost, type SessionHistoryMcpRegistration } from "../../src-electron/memory/managed-http-mcp-host.js";
import { createMemoryV6HttpServer } from "../../src-electron/memory/memory-v6-http-server.js";
import { MemoryV6Storage } from "../../src-electron/memory/memory-v6-storage.js";
import { MemoryV6Service } from "../../src-electron/memory/memory-v6-service.js";

const owner = { applicationInstanceId: "11111111-1111-4111-8111-111111111111", runtimeGenerationId: "22222222-2222-4222-8222-222222222222" };
// Synthetic #908 factory/route: the registry, coordinator, host, authenticated exchange and source snapshots are production code.
const operations = { "session_history.read_messages": "session_history.route.read_messages",
  "session_history.get_operation": "session_history.route.get_operation" };
const readOperation = operations["session_history.read_messages"];

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "withmate-background-foundation-"));
  const { dbPath } = await createOrVerifyV6FreshDatabase(directory);
  const auxiliary = new AuxiliarySessionStorage(dbPath);
  const db = new DatabaseSync(dbPath);
  const sessions = new Map<string, Session>();
  db.prepare("INSERT INTO characters(id,name,created_at,updated_at) VALUES ('character','Character','now','now')").run();
  for (const id of ["main", "other"]) {
    const session = { ...buildNewSession({ taskTitle: id, workspaceLabel: "fixture", workspacePath: directory, branch: "main",
      characterId: "character", character: "Character", characterIconPath: "", characterThemeColors: { main: "#123456", sub: "#abcdef" },
      approvalMode: "on-request" }), id, incarnationId: `inc-${id}` };
    sessions.set(id, session);
    db.prepare(`INSERT INTO sessions_v6(id,incarnation_id,title,state,provider_id,catalog_revision,model_id,approval_mode,
      character_id,character_snapshot_json,created_at,updated_at,last_active_at)
      VALUES (?,?,'Source','active','codex',1,'test','on-request','character','{}','now','now','now')`).run(id, session.incarnationId);
    db.prepare("INSERT INTO session_messages_v6(session_id,seq,role,body,created_at) VALUES (?,0,'user',?, 'now')")
      .run(id, JSON.stringify({ role: "user", text: "saved source" }));
  }
  db.prepare("INSERT INTO auxiliary_sessions(id,parent_session_id,status,created_at,updated_at) VALUES ('aux','main','active','same-created-at','now')").run();
  db.prepare("INSERT INTO auxiliary_session_drafts(auxiliary_session_id,parent_session_id,incarnation,updated_at) VALUES ('aux','main','draft-a','now')").run();
  db.prepare("INSERT INTO auxiliary_session_messages(auxiliary_session_id,seq,role,body,created_at) VALUES ('aux',0,'user',?,'now')")
    .run(JSON.stringify({ role: "user", text: "auxiliary source" }));
  sessions.set("aux", { ...sessions.get("main")!, id: "aux", incarnationId: "same-created-at" });
  const bindings = new AgentRuntimeBindingRegistry();
  const turns = new ProviderAgentRuntimeTurnCoordinator();
  const storage = new MemoryV6Storage(dbPath);
  const runtime = createMemoryV6HttpServer({ ...owner, apiSecret: "api", mcpApiSecret: "mcp", operatorApiSecret: "operator",
    service: new MemoryV6Service({ storage }), agentRuntimeBindingRegistry: bindings, providerAgentRuntimeTurns: turns,
    resolveActorSession: (id) => sessions.has(id) ? { id, providerId: "codex", characterId: "character" } : null,
    routeAgentRuntimeExtension: (request) => {
      if (request.path !== "/v1/session-history/fixture-read") return null;
      const result = authorizeSessionHistoryRead({ bindings, turns }, { bindingReference: request.bindingReference,
        turnCapability: request.turnCapability, operation: readOperation });
      if (!result.ok) return { status: 403, value: { ok: false, code: result.code } };
      return runWithRuntimeTurnAdmission(result.context.admission, () => {
        const scope = result.context.scope;
        const table: MessageTable = scope.source.kind === "main" ? "session_messages_v6" : "auxiliary_session_messages";
        if (!matchesSessionHistorySource(scope.source, readConversationQuerySnapshot(db, table, scope.source.sessionId))) {
          return { status: 409, value: { ok: false, code: "source_changed" } };
        }
        const input = request.body as { seq?: number };
        const seq = input.seq ?? scope.fromMessageSeq;
        if (seq < scope.fromMessageSeq || seq > scope.throughMessageSeq) return { status: 403, value: { ok: false, code: "outside_range" } };
        const column = scope.source.kind === "main" ? "session_id" : "auxiliary_session_id";
        const row = db.prepare(`SELECT body FROM ${table} WHERE ${column} = ? AND seq = ?`).get(scope.source.sessionId, seq) as { body: string } | undefined;
        assertRuntimeTurnAdmission();
        return { status: 200, value: { ok: true, body: row ? JSON.parse(row.body) : null } };
      });
    },
  });
  await runtime.start();
  const registration: SessionHistoryMcpRegistration = { toolOperations: operations, createServer(deps, allowed) {
    const server = new McpServer({ name: "withmate-session-history", version: "fixture" });
    for (const [name, operation] of Object.entries(operations)) {
      if (!allowed.includes(operation)) continue;
      server.registerTool(name, { inputSchema: z.object({ seq: z.number().int().nonnegative().optional() }).strict() }, async (input) => {
        const response = await deps.runtimeCall(deps.connection, { method: "POST", path: "/v1/session-history/fixture-read", body: input }, {
          signal: new AbortController().signal, bindingReference: resolveAgentRuntimeBindingReference(deps.env),
          turnCapability: resolveAgentRuntimeTurnCapability(deps.env), exchangePath: WITHMATE_AGENT_RUNTIME_EXTENSION_EXCHANGE_PATH,
        });
        const value = response.value as Record<string, unknown>;
        return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value, isError: value.ok === false };
      });
    }
    return server;
  } };
  const host = new ManagedHttpMcpHost({ connection: { api: { ...owner, runtimeInstanceId: owner.runtimeGenerationId,
    baseUrl: `http://127.0.0.1:${runtime.address()!.port}`, apiSecret: "api" }, credential: { adapter: "mcp", adapterSecret: "mcp" } },
    bindingRegistry: bindings, turns, fallbackAdmissionSecret: "fallback", sessionHistory: registration });
  await host.start();
  const executions = new BackgroundExecutionService({ bindings, turns, closeConnection: (handle) => host.closeConnection(handle) });
  executions.start();
  const clients: Client[] = [];
  function scope(id = "main", purpose: BackgroundPurpose = "affect"): BackgroundExecutionScope {
    const kind = id === "aux" ? "auxiliary" : "main";
    const snapshot = readConversationQuerySnapshot(db, kind === "main" ? "session_messages_v6" : "auxiliary_session_messages", id)!;
    const source: SessionHistorySource = kind === "auxiliary"
      ? { kind, sessionId: id, incarnationId: snapshot.incarnationId, ownerIdentity: snapshot.ownerIdentity,
        parent: { sessionId: "main", incarnationId: "inc-main" } }
      : { kind, sessionId: id, incarnationId: snapshot.incarnationId, ownerIdentity: snapshot.ownerIdentity };
    return { purpose, history: { source, fromMessageSeq: 0, throughMessageSeq: 0 },
      processing: { afterTurnId: null, throughTurnId: 1 }, memoryTargets: [] };
  }
  function start(id = "main", providerId = "codex", purpose: BackgroundPurpose = "affect", signal?: AbortSignal) {
    return executions.begin({ actorSessionId: id, providerId, session: sessions.get(id)!, scope: scope(id, purpose),
      authoritySnapshot: { userId: "local-user", characterId: "character", allowedProjectIds: [] }, operationGrants: [readOperation], signal });
  }
  function started(id = "main", providerId = "codex", purpose: BackgroundPurpose = "affect", signal?: AbortSignal) {
    const result = start(id, providerId, purpose, signal);
    if (!result.ok) assert.fail(result.reason);
    return result.execution;
  }
  function project(execution: BackgroundExecution): ProviderAgentRuntimeBindingProjection {
    const binding = { ...execution.binding, memoryRuntimeOwner: owner };
    return { ...binding, managedMcp: host.issue(binding, execution.handle, execution.signal) };
  }
  async function connect(binding: ProviderAgentRuntimeBindingProjection) {
    const client = new Client({ name: "background-test", version: "1" });
    clients.push(client);
    const transport = new StreamableHTTPClientTransport(new URL(binding.managedMcp!.sessionHistoryUrl!), {
      requestInit: { headers: { [WITHMATE_MANAGED_MCP_TOKEN_HEADER]: binding.managedMcp!.token } },
    });
    await client.connect(transport);
    return { client, transport };
  }
  async function request(binding: ProviderAgentRuntimeBindingProjection, url: string, name: string, sessionId?: string) {
    return fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream",
      [WITHMATE_MANAGED_MCP_TOKEN_HEADER]: binding.managedMcp!.token, ...(sessionId ? { "mcp-session-id": sessionId } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 71, method: "tools/call", params: { name, arguments: {} } }) });
  }
  return { db, sessions, scope, start, started, project, connect, request, bindings, turns, executions, host,
    async close() {
      executions.stop();
      await Promise.all(clients.map((client) => client.close()));
      await host.stop(); await runtime.stop(); storage.close(); auxiliary.close(); db.close();
      await rm(directory, { recursive: true, force: true });
    } };
}

// @test-value v2
// kind = "contract"
// claim = "同じ実Sessionで通常次turnと同Provider背景が共存し、別Provider背景も固定した保存履歴だけを読める"
// oracle = { type = "contract", ref = "docs/design/background-execution.md" }
// fault = "背景発行や通常binding置換が相互失効するか、別Providerを元SessionのProviderとして扱いreadを拒否する"
// observable = "実MCP tools listと保存本文、通常generation、各handleのadmission、Provider builderのendpoint一覧"
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
    const codex = f.started();
    const claude = f.started("main", "claude", "target-memory");
    const codexBinding = f.project(codex);
    const claudeBinding = f.project(claude);
    f.turns.end(first);
    const nextBinding = f.bindings.issueOrReuse({ actorSessionId: "main", providerId: "codex", operationGrants: ["memory.route.search"] });
    const next = f.turns.begin({ actorSessionId: "main", providerId: "codex" });
    assert.notEqual(normal.bindingId, nextBinding.bindingId);
    f.db.prepare("INSERT INTO session_messages_v6(session_id,seq,role,body,created_at) VALUES ('main',1,'user',?,'now')")
      .run(JSON.stringify({ text: "later turn" }));
    const a = await f.connect(codexBinding);
    const b = await f.connect(claudeBinding);
    assert.deepEqual((await a.client.listTools()).tools.map((tool) => tool.name), ["session_history.read_messages"]);
    for (const client of [a.client, b.client]) {
      assert.deepEqual((await client.callTool({ name: "session_history.read_messages", arguments: {} })).structuredContent,
        { ok: true, body: { role: "user", text: "saved source" } });
      assert.deepEqual((await client.callTool({ name: "session_history.read_messages", arguments: { seq: 1 } })).structuredContent,
        { ok: false, code: "outside_range" });
    }
    assert.equal(f.turns.admit({ actorSessionId: "main", providerId: "codex", turnCapability: next.capability }).ok, true);
    assert.equal(f.bindings.getExecutionGeneration("main", "codex"), nextBinding.executionGeneration);
    assert.deepEqual(Object.keys(buildManagedHttpMcpServers(codexBinding)!), ["withmate-session-history"]);
    assert.deepEqual(Object.keys(buildCodexManagedHttpMcpConfig(codexBinding)), ["withmate-session-history-http"]);
    assert.match(buildCodexManagedHttpMcpArguments(codexBinding).join(" "), /mcp_servers.withmate-session-history-http=/);
    assert.equal(f.sessions.get("main")!.provider, "codex");
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
    const execution = f.started();
    const binding = f.project(execution);
    const { client, transport } = await f.connect(binding);
    assert.equal((await f.request(binding, binding.managedMcp!.sessionHistoryUrl!, "session_history.get_operation", transport.sessionId)).status, 403);
    assert.equal((await f.request(binding, binding.managedMcp!.sessionHistoryUrl!, "memory.append", transport.sessionId)).status, 403);
    assert.equal((await f.request(binding, binding.managedMcp!.memoryUrl, "memory.append")).status, 403);
    const normal = f.bindings.issueOrReuse({ actorSessionId: "main", providerId: "codex", operationGrants: [readOperation] });
    const turn = f.turns.begin({ actorSessionId: "main", providerId: "codex" });
    const projected = { ...normal, memoryRuntimeOwner: owner, turnCapability: turn.capability };
    const ordinary = { ...projected, managedMcp: f.host.issue(projected, turn) };
    assert.equal((await f.request(ordinary, binding.managedMcp!.sessionHistoryUrl!, "session_history.read_messages")).status, 403);
    const auth = (reference: string, capability?: string, operation = readOperation) => authorizeSessionHistoryRead({ bindings: f.bindings, turns: f.turns },
      { bindingReference: reference, turnCapability: capability, operation });
    assert.deepEqual(auth(normal.bindingReference, turn.capability), { ok: false, code: "SESSION_BINDING_FORBIDDEN" });
    assert.deepEqual(auth(binding.bindingReference), { ok: false, code: "SESSION_BINDING_INVALID" });
    assert.deepEqual(auth(binding.bindingReference, turn.capability), { ok: false, code: "SESSION_BINDING_INVALID" });
    assert.deepEqual(auth(binding.bindingReference, binding.turnCapability, operations["session_history.get_operation"]), { ok: false, code: "SESSION_BINDING_FORBIDDEN" });
    assert.equal((await client.callTool({ name: "session_history.read_messages", arguments: {} })).isError, false);
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
// distinction = "通常turnの一段階endのtestでは二つの寿命を区別できない。保存callbackはsyntheticでatomic保存の証明ではない"
// @end-test-value
test("MCPを閉じてから論理finishまでの保存admissionを保持する", async () => {
  const f = await fixture();
  try {
    const execution = f.started();
    const binding = f.project(execution);
    f.executions.nativeCompleted(execution);
    assert.equal((await f.request(binding, binding.managedMcp!.sessionHistoryUrl!, "session_history.read_messages")).status, 401);
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
// claim = "保存sourceの再作成を拒否し、Auxiliaryは同createdAt・同親でもdraft incarnation変更を区別し本文編集だけでは失効しない"
// oracle = { type = "contract", ref = "docs/adr/035-background-execution-binding-and-history-scope.md" }
// fault = "Auxiliary ownerIdentityからdraft incarnationを落とすか、古いMainのscopeで同IDの新履歴を返す"
// observable = "実MCP readのsource_changedと通常draft編集後の本文、親失効後signal・admission"
// observation_boundary = "public-boundary"
// scope = "captured production conversation snapshot and saved SQLite source identity"
// lifecycle = "permanent"
// impact = "再作成された別会話の本文が古い背景処理へ公開される"
// distinction = "Session IDやcreatedAtの単体照合では検出できないdraft ownerの差を同じ保存fixtureとHTTP経路で観測する"
// risk_tags = ["authorization", "privacy"]
// @end-test-value
test("MainとAuxiliaryのstorage ownerIdentityをreadと同じ境界で照合する", async () => {
  const f = await fixture();
  try {
    const main = f.started();
    const aux = f.started("aux");
    const a = await f.connect(f.project(main));
    const b = await f.connect(f.project(aux));
    f.db.prepare("UPDATE auxiliary_session_drafts SET draft_text='editing', durable_revision=durable_revision+1 WHERE auxiliary_session_id='aux'").run();
    assert.equal((await b.client.callTool({ name: "session_history.read_messages", arguments: {} })).isError, false);
    f.db.prepare("UPDATE auxiliary_session_drafts SET incarnation='draft-b' WHERE auxiliary_session_id='aux'").run();
    assert.deepEqual((await b.client.callTool({ name: "session_history.read_messages", arguments: {} })).structuredContent, { ok: false, code: "source_changed" });
    f.db.prepare("UPDATE sessions_v6 SET incarnation_id='inc-recreated' WHERE id='main'").run();
    assert.deepEqual((await a.client.callTool({ name: "session_history.read_messages", arguments: {} })).structuredContent, { ok: false, code: "source_changed" });
    f.bindings.revokeSession("main");
    assert.equal(aux.signal.aborted, true);
    assert.equal(main.signal.aborted, true);
    assert.throws(() => runWithRuntimeTurnAdmission(aux.admission, () => undefined), /no longer active/);
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
    assert.equal((await connected.client.callTool({ name: "session_history.read_messages", arguments: {} })).isError, false);
    f.executions.nativeCompleted(codex);
    f.executions.stop();
    assert.throws(() => runWithRuntimeTurnAdmission(codex.admission, () => undefined), /no longer active/);
    assert.throws(() => runWithRuntimeTurnAdmission(claude.admission, () => undefined), /no longer active/);
    assert.throws(() => f.start(), /runtime is unavailable/);
    f.executions.start();
    assert.equal(f.started().signal.aborted, false);
  } finally { await f.close(); }
});
