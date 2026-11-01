import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildNewSession, type Session } from "../../src-shared/session/session-state.js";
import type { SessionHistorySource } from "../../src-shared/session/session-history-read-scope.js";
import type { BackgroundPurpose, BackgroundExecutionScope } from "../../src-shared/agent-runtime/background-execution-scope.js";
import { createOrVerifyV6FreshDatabase } from "../../src-electron/storage/app-database-v6-bootstrap.js";
import { readConversationQuerySnapshot } from "../../src-electron/storage/conversation-query.js";
import { AuxiliarySessionStorage } from "../../src-electron/auxiliary/auxiliary-session-storage.js";
import { AgentRuntimeBindingRegistry, type ProviderAgentRuntimeBindingProjection } from "../../src-electron/providers/agent-runtime-binding.js";
import { ProviderAgentRuntimeTurnCoordinator } from "../../src-electron/providers/provider-agent-runtime-turn-coordinator.js";
import { BackgroundExecutionService, type BackgroundExecution } from "../../src-electron/providers/background-execution-service.js";
import { WITHMATE_MANAGED_MCP_TOKEN_HEADER } from "../../src-electron/providers/managed-http-mcp.js";
import { ManagedHttpMcpHost } from "../../src-electron/memory/managed-http-mcp-host.js";
import { createMemoryV6HttpServer } from "../../src-electron/memory/memory-v6-http-server.js";
import { MemoryV6Storage } from "../../src-electron/memory/memory-v6-storage.js";
import { MemoryV6Service } from "../../src-electron/memory/memory-v6-service.js";

import { createV6StorageWorkerBundle } from "../../src-electron/storage/storage-worker-bundle.js";
import { SessionHistoryRuntimeService } from "../../src-electron/session-history/session-history-runtime-service.js";
import { createWithMateSessionHistoryMcpServer } from "../../src-electron/platform/mcp/withmate-session-history-mcp.js";
import { SESSION_HISTORY_TOOL_OPERATIONS, getSessionHistoryAgentRuntimeOperations } from "../../src-shared/session-history/session-history-contract.js";
import type { StorageOperationDiagnosticSink } from "../../src-electron/storage/storage-operation-diagnostics.js";

export const owner = { applicationInstanceId: "11111111-1111-4111-8111-111111111111", runtimeGenerationId: "22222222-2222-4222-8222-222222222222" };
export const readOperation = "session_history.route.get_message";

export async function backgroundHistoryFixture(diagnosticSink?: StorageOperationDiagnosticSink) {
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
  const artifact = { title: "Run", activitySummary: [], operationTimeline: [
    { type: "command_execution", summary: "npm test", status: "failed", exitCode: 1, details: "failure output" }
  ], changedFiles: [], runChecks: [] };
  db.prepare("INSERT INTO session_messages_v6(session_id,seq,role,body,artifact_body,created_at) VALUES ('main',1,'assistant',?,?,'now')")
    .run(JSON.stringify({ role: "assistant", text: "saved answer", artifact }), JSON.stringify(artifact));
  db.prepare("INSERT INTO auxiliary_sessions(id,parent_session_id,status,created_at,updated_at) VALUES ('aux','main','active','same-created-at','now')").run();
  db.prepare("INSERT INTO auxiliary_session_drafts(auxiliary_session_id,parent_session_id,incarnation,updated_at) VALUES ('aux','main','draft-a','now')").run();
  db.prepare("INSERT INTO auxiliary_session_messages(auxiliary_session_id,seq,role,body,created_at) VALUES ('aux',0,'user',?,'now')")
    .run(JSON.stringify({ role: "user", text: "auxiliary source" }));
  sessions.set("aux", { ...sessions.get("main")!, id: "aux", incarnationId: "same-created-at" });
  const bindings = new AgentRuntimeBindingRegistry();
  const turns = new ProviderAgentRuntimeTurnCoordinator();
  const storage = new MemoryV6Storage(dbPath);
  const worker = createV6StorageWorkerBundle({ dbPath, userDataPath: directory, diagnosticSink });
  await worker.initialize();
  let readGate: (() => Promise<void>) | undefined;
  const history = new SessionHistoryRuntimeService({ bindingRegistry: bindings, providerAgentRuntimeTurns: turns,
    read: async (input) => {
      await readGate?.();
      return input.scope.source.kind === "main" ? worker.stores.session.readSessionHistory(input) : worker.stores.auxiliary.readSessionHistory(input);
    } });
  const runtime = createMemoryV6HttpServer({ ...owner, apiSecret: "api", mcpApiSecret: "mcp", operatorApiSecret: "operator",
    service: new MemoryV6Service({ storage }), agentRuntimeBindingRegistry: bindings, providerAgentRuntimeTurns: turns,
    resolveActorSession: (id) => sessions.has(id) ? { id, providerId: "codex", characterId: "character" } : null,
    routeAgentRuntimeExtension: (request) => history.route(request),
  });
  await runtime.start();
  const connection = { api: { ...owner, runtimeInstanceId: owner.runtimeGenerationId,
    baseUrl: `http://127.0.0.1:${runtime.address()!.port}`, apiSecret: "api" }, credential: { adapter: "mcp" as const, adapterSecret: "mcp" } };
  const host = new ManagedHttpMcpHost({ connection,
    bindingRegistry: bindings, turns, fallbackAdmissionSecret: "fallback",
    sessionHistory: { toolOperations: SESSION_HISTORY_TOOL_OPERATIONS, createServer: createWithMateSessionHistoryMcpServer } });
  await host.start();
  const executions = new BackgroundExecutionService({ bindings, turns, closeConnection: (handle) => host.closeConnection(handle) });
  executions.start();
  const clients: Client[] = [];
  const servers: ReturnType<typeof createWithMateSessionHistoryMcpServer>[] = [];
  function scope(id = "main", purpose: BackgroundPurpose = "affect"): BackgroundExecutionScope {
    const kind = id === "aux" ? "auxiliary" : "main";
    const snapshot = readConversationQuerySnapshot(db, kind === "main" ? "session_messages_v6" : "auxiliary_session_messages", id)!;
    const source: SessionHistorySource = kind === "auxiliary"
      ? { kind, sessionId: id, incarnationId: snapshot.incarnationId, ownerIdentity: snapshot.ownerIdentity,
        parent: { sessionId: "main", incarnationId: readConversationQuerySnapshot(db, "session_messages_v6", "main")!.incarnationId } }
      : { kind, sessionId: id, incarnationId: snapshot.incarnationId, ownerIdentity: snapshot.ownerIdentity };
    return { purpose, history: { source, fromMessageSeq: 0, throughMessageSeq: id === "main" ? 1 : 0 },
      processing: { afterTurnId: null, throughTurnId: 1 }, memoryTargets: [] };
  }
  function start(id = "main", providerId = "codex", purpose: BackgroundPurpose = "affect", signal?: AbortSignal, operationGrants = getSessionHistoryAgentRuntimeOperations()) {
    return executions.begin({ actorSessionId: id, providerId, session: sessions.get(id)!, scope: scope(id, purpose),
      authoritySnapshot: { userId: "local-user", characterId: "character", allowedProjectIds: [] }, operationGrants, signal });
  }
  function started(id = "main", providerId = "codex", purpose: BackgroundPurpose = "affect", signal?: AbortSignal, operationGrants = getSessionHistoryAgentRuntimeOperations()) {
    const result = start(id, providerId, purpose, signal, operationGrants);
    if (!result.ok) assert.fail(result.reason);
    return result.execution;
  }
  function project(execution: BackgroundExecution): ProviderAgentRuntimeBindingProjection {
    const binding = { ...execution.binding, memoryRuntimeOwner: owner };
    return { ...binding, managedMcp: host.issue(binding, execution.handle, execution.signal) };
  }
  async function connect(binding: ProviderAgentRuntimeBindingProjection, endpoint: "sessionHistoryUrl" | "glossaryUrl" = "sessionHistoryUrl") {
    const client = new Client({ name: "background-test", version: "1" });
    clients.push(client);
    const transport = new StreamableHTTPClientTransport(new URL(binding.managedMcp![endpoint]!), {
      requestInit: { headers: { [WITHMATE_MANAGED_MCP_TOKEN_HEADER]: binding.managedMcp!.token } },
    });
    await client.connect(transport);
    return { client, transport };
  }
  async function request(binding: ProviderAgentRuntimeBindingProjection, url: string, name: string, sessionId?: string) {
    return fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream",
      [WITHMATE_MANAGED_MCP_TOKEN_HEADER]: binding.managedMcp!.token, ...(sessionId ? { "mcp-session-id": sessionId } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 71, method: "tools/call", params: { name, arguments: { seq: 0 } } }) });
  }
  return { directory, db, sessions, scope, start, started, project, connect, request, bindings, turns, executions, host, worker, auxiliary,
    async connectRuntimeContext(env: NodeJS.ProcessEnv, credential = connection.credential) {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const server = createWithMateSessionHistoryMcpServer({ env, connection: { ...connection, credential } }, getSessionHistoryAgentRuntimeOperations());
      const client = new Client({ name: "history-context", version: "1" });
      clients.push(client); servers.push(server);
      await server.connect(serverTransport); await client.connect(clientTransport);
      return client;
    },
    setReadGate: (gate?: () => Promise<void>) => { readGate = gate; },
    cliEnv: (binding: ProviderAgentRuntimeBindingProjection): NodeJS.ProcessEnv => ({ ...process.env,
      WITHMATE_AGENT_RUNTIME_BINDING_REQUIRED: "1", WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE: binding.bindingReference,
      WITHMATE_AGENT_RUNTIME_TURN_CAPABILITY: binding.turnCapability, WITHMATE_MEMORY_RUNTIME_APPLICATION_INSTANCE_ID: owner.applicationInstanceId,
      WITHMATE_MEMORY_RUNTIME_GENERATION_ID: owner.runtimeGenerationId, WITHMATE_MEMORY_API_URL: `http://127.0.0.1:${runtime.address()!.port}`,
      WITHMATE_MEMORY_API_SECRET: "api", WITHMATE_MEMORY_MCP_API_SECRET: "mcp" }),
    async close() {
      executions.stop();
      await Promise.all(clients.map((client) => client.close()));
      await Promise.all(servers.map((server) => server.close()));
      await host.stop(); await runtime.stop(); await worker.client.close(); storage.close(); auxiliary.close(); db.close();
      await rm(directory, { recursive: true, force: true });
    } };
}
