import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { runWithMateSessionCli } from "../../src-cli/session/withmate-session.js";
import { createWithMateSessionMcpServer } from "../../src-electron/platform/mcp/withmate-session-mcp.js";
import type {
  callAgentRuntime,
  AgentRuntimeConnection,
} from "../../src-electron/platform/agent-runtime/runtime-client.js";
import {
  SESSION_RUNTIME_OPERATION_PATHS,
  getSessionAgentRuntimeOperations,
  type SessionOperation,
} from "../../src-shared/session/session-management-contract.js";
import { SessionStorageV6 } from "../../src-electron/session/session-storage-v6.js";
import { SessionExecutionReadStorage } from "../../src-electron/storage/session-execution-read.js";
import { SessionTurnStorageV6 } from "../../src-electron/session/session-turn-storage-v6.js";
import { SessionTurnQueueStorageV6 } from "../../src-electron/session/session-turn-queue-storage-v6.js";
import { captureSessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";
import { CoordinationStorageV7 } from "../../src-electron/coordination/coordination-storage-v7.js";
import { CoordinationApplicationService } from "../../src-electron/coordination/coordination-application-service.js";
import { SessionManagementApplication } from "../../src-electron/session/session-management-application.js";
import { SessionManagementRuntimeService } from "../../src-electron/session/session-management-runtime-service.js";
import { SessionPersistenceService } from "../../src-electron/session/session-persistence-service.js";
import { manageSessionDirectories } from "../../src-electron/session/session-directory-management.js";
import { normalizeAppSettings } from "../../src-shared/settings/provider-settings-state.js";
import { AgentRuntimeBindingRegistry } from "../../src-electron/providers/agent-runtime-binding.js";
import { ProviderAgentRuntimeTurnCoordinator } from "../../src-electron/providers/provider-agent-runtime-turn-coordinator.js";
import { resolveRelatedSessions } from "../../src-electron/session/session-relationship-resolver.js";
import { fixtureSessionManagementScope } from "../main/fixtures/session-management-scope.js";
import {
  buildNewSession,
  getSessionIncarnationId,
} from "../../src-shared/session/session-state.js";
const env = {
  WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE: "binding",
  WITHMATE_AGENT_RUNTIME_TURN_CAPABILITY: "turn",
};
const connection: AgentRuntimeConnection = {
  api: {
    baseUrl: "http://127.0.0.1:7777",
    apiSecret: "secret",
    applicationInstanceId: "instance",
    runtimeGenerationId: "generation",
  },
  credential: { adapter: "mcp", adapterSecret: "adapter" },
};
async function cli(
  command: string,
  body: unknown,
  runtimeCall: typeof callAgentRuntime,
  boundEnv = env,
  run = runWithMateSessionCli,
) {
  let output = "";
  const exit = await run(
    [command, "--json", JSON.stringify(body)],
    {
      env: boundEnv,
      connection,
      runtimeCall,
      stdout: {
        write: (value) => {
          output += String(value);
          return true;
        },
      },
      stderr: { write: () => true },
    },
  );
  return { exit, value: JSON.parse(output) as Record<string, unknown> };
}

// @test-value v2
// kind = "contract"
// claim = "配布CLIとMCPのlist_messagesは同じMainの確定スレッドで絞り、無効な相手や世代を全履歴へ戻さない"
// oracle = { type = "contract", ref = "docs/design/session-history.md#通常sessionの保存実行読取" }
// fault = "配布側だけthreadを失う、相手自身の履歴に置き換える、または相手が不一致でも全履歴を返す"
// observable = "配布CLIとSDK MCPの成功結果、total・元のseq、失敗コードとCLI exit"
// observation_boundary = "public-boundary"
// scope = "合成SQLite → Session管理runtime／application → 配布bundleとSDK MCP（HTTP exchangeのみfixture）"
// lifecycle = "permanent"
// impact = "会話の文脈に無関係な本文を取得したり、要求した枠の履歴を読めなくなる"
// distinction = "storage単体と操作schema比較だけでは配布bundleのparser・実application・両入口の失敗出力を一緒に検証しない"
// @end-test-value
test("bundled CLI and MCP read the same Main thread through the persisted runtime", async () => {
  const directory = await mkdtemp(join(tmpdir(), "withmate-thread-api-"));
  const dbPath = join(directory, "sessions.db");
  const sessions = new SessionStorageV6(dbPath), queue = new SessionTurnQueueStorageV6(dbPath);
  const turns = new SessionTurnStorageV6(dbPath), execution = new SessionExecutionReadStorage(dbPath);
  const bindings = new AgentRuntimeBindingRegistry(), providerTurns = new ProviderAgentRuntimeTurnCoordinator();
  const client = new Client({ name: "thread-parity", version: "1" });
  try {
    const base = buildNewSession({ id: "thread-main", taskTitle: "Owner", workspaceLabel: "Workspace", workspacePath: directory, branch: "main",
      characterId: "unknown", character: "Unknown", characterIconPath: "", characterThemeColors: { main: "#112233", sub: "#223344" },
      approvalMode: "on-request", sessionRole: "overall-coordinator", rootSessionId: "thread-main" });
    const main = sessions.insertSession({ ...base, messages: [{ role: "user", text: "Initial" },
      { role: "user", text: "Follow-up" }, { role: "assistant", text: "Response" }] });
    const peer = sessions.insertSession({ ...base, id: "thread-peer", sessionRole: "executor", parentSessionId: main.id, createdBySessionId: main.id,
      messages: [{ role: "assistant", text: "Peer's own transcript" }] });
    const exact = (session: typeof main) => ({ kind: "main" as const, sessionId: session.id, incarnationId: getSessionIncarnationId(session) });
    const target = exact(main), thread = exact(peer);
    const request = { clientRequestId: randomUUID(), userMessage: "Follow-up", submitSource: "composer" as const,
      mainConversationFrame: thread, executionOptions: captureSessionExecutionOptions(main) };
    const receipt = queue.enqueue(target, { request, provider: main.provider, workspacePath: directory, attachments: [],
      origin: { kind: "gui", operation: "send", targetSessionId: target.sessionId, targetIncarnationId: target.incarnationId } });
    const stored = turns.createSessionTurn({ sessionId: main.id, createdAt: "now", phase: "completed", provider: main.provider,
      model: main.model, reasoningEffort: main.reasoningEffort, approvalMode: main.approvalMode, threadId: "", errorMessage: "",
      userMessageSeq: 1, assistantMessageSeq: 2 });
    queue.claimNext(target);
    queue.markStarted(target, receipt.id, { turnId: String(stored.id), userMessageSeq: 1 });
    queue.settle(target, receipt.id, "completed");
    const binding = bindings.issueOrReuse({ actorSessionId: main.id, providerId: main.provider,
      authoritySnapshot: { sessionIdentity: target }, operationGrants: getSessionAgentRuntimeOperations() });
    const turn = providerTurns.begin({ actorSessionId: main.id, providerId: main.provider });
    const boundEnv = { WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE: binding.bindingReference, WITHMATE_AGENT_RUNTIME_TURN_CAPABILITY: turn.capability };
    const unused = async () => { throw new Error("Unexpected operation"); };
    const application = new SessionManagementApplication({
      readSessionScope: async (actor, selection) => sessions.readSessionManagementScope(actor, selection),
      operatingPolicy: unused, directories: unused, currentTurn: async () => ({ turnId: "1", receipt: null, origin: null }), crewFolder: unused,
      getInstructions: unused, setInstructions: unused,
      updateMetadata: unused, enqueue: unused, getReceipt: unused, cancelReceipt: unused, stopTurn: unused, steer: unused,
      createChild: unused, catalog: unused, coordinate: unused,
      readExecution: async (destination, operation, request, assertCurrent) => {
        assertCurrent();
        assert.equal(destination.id, main.id);
        return execution.execute({ target: request.target, operation, request });
      },
    });
    const runtime = new SessionManagementRuntimeService({ application, bindingRegistry: bindings, providerAgentRuntimeTurns: providerTurns });
    const runtimeCall: typeof callAgentRuntime = async (_connection, operation, options) => {
      const response = await runtime.route({ method: operation.method, path: operation.path, body: operation.body, transport: "mcp",
        bindingReference: options.bindingReference, turnCapability: options.turnCapability });
      assert.ok(response);
      return { ok: response.status >= 200 && response.status < 300, status: response.status, value: response.value };
    };
    const server = createWithMateSessionMcpServer({ env: boundEnv, connection, runtimeCall });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const bundle = await import(new URL("../../resources/cli/withmate-session.mjs", import.meta.url).href) as { runWithMateSessionCli: typeof runWithMateSessionCli };
    try {
      await server.connect(b); await client.connect(a);
      const list = async (arguments_: Record<string, unknown>) => {
        const command = await cli("list-messages", arguments_, runtimeCall, boundEnv, bundle.runWithMateSessionCli);
        const result = await client.callTool({ name: "session.list_messages", arguments: arguments_ });
        assert.deepEqual(result.structuredContent, command.value);
        return command;
      };
      const filtered = await list({ target, thread, limit: 1, offset: 1 });
      assert.equal(filtered.exit, 0, JSON.stringify(filtered.value));
      assert.deepEqual([filtered.value.total, filtered.value.nextOffset], [2, null]);
      assert.deepEqual((filtered.value.items as Array<{ seq: number; textPreview: string }>).map(({ seq, textPreview }) => [seq, textPreview]), [[2, "Response"]]);
      const initial = await list({ target, thread: null });
      assert.equal(initial.value.total, 1);
      assert.equal((await list({ target })).value.total, 3);
      const stale = await list({ target, thread: { ...thread, incarnationId: "stale" } });
      assert.equal(stale.exit, 1);
      assert.equal(stale.value.code, "EXECUTION_THREAD_UNAVAILABLE");
      assert.equal(stale.value.items, undefined);
    } finally {
      await client.close(); await server.close();
      providerTurns.end(turn);
    }
  } finally {
    bindings.revokeAll();
    execution.close(); turns.close(); queue.close(); sessions.close();
    await rm(directory, { recursive: true, force: true });
  }
});

// @test-value v2
// kind = "contract"
// claim = "Session MCPの運用設定3操作は既存設定を置換・解除する更新、4照会は読取専用としてtools/listで通知する"
// oracle = { type = "contract", ref = "GitHub #944; https://modelcontextprotocol.io/specification/2025-11-25/schema#toolannotations" }
// fault = "設定の置換・解除を追加のみと通知する、または設定とquotaの照会を更新操作として通知する"
// observable = "SDK clientのtools/list応答に含まれる対象7操作のreadOnlyHintと更新3操作のdestructiveHint"
// observation_boundary = "public-boundary"
// scope = "Session MCP運用設定7操作の公開注釈"
// lifecycle = "permanent"
// impact = "MCP clientが既存設定を失い得る操作を追加のみと誤認する"
// distinction = "入力・結果のparityや型検査では、SDKを介したtools/listの操作属性を検出できない"
// @end-test-value
test("MCP tools list distinguishes operating policy replacement from read-only queries", async () => {
  const server = createWithMateSessionMcpServer({ env, connection });
  const client = new Client({ name: "operating-policy-annotations", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(b);
    await client.connect(a);
    const { tools } = await client.listTools();
    for (const operation of ["set_selection_policy", "set_worktree_root", "set_worktree_repository"]) {
      const tool = tools.find((entry) => entry.name === `session.${operation}`);
      assert.ok(tool, operation);
      assert.equal(tool.annotations?.readOnlyHint, false, operation);
      assert.equal(tool.annotations?.destructiveHint, true, operation);
    }
    for (const operation of ["get_selection_policy", "get_provider_quota", "get_worktree_policy", "resolve_worktree"]) {
      const tool = tools.find((entry) => entry.name === `session.${operation}`);
      assert.ok(tool, operation);
      assert.equal(tool.annotations?.readOnlyHint, true, operation);
    }
  } finally {
    await client.close();
    await server.close();
  }
});

// @test-value v2
// kind = "contract"
// claim = "子作成・通常送信のCLI/MCPは同じ入力項目を公開し、Model・Depthを受け付ける閉じた入力契約を示す"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md#bound-session-api" }
// fault = "一方の入口だけで入力項目が増減する、Model・Depthの指定を公開しなくなる、または未宣言項目を許容すると通知する"
// observable = "SDK MCPのtools/listとCLI schemaの入力項目・必須項目、およびadditionalProperties"
// observation_boundary = "public-boundary"
// scope = "SDK MCPとbound CLIのcreate_child/enqueueの公開schema"
// lifecycle = "permanent"
// impact = "入口によって送信・作成の入力が変わるか、未対応の指定を有効な入力と誤認する"
// distinction = "実Storageの受付テストは実行結果を確認するが、利用者へ公開される入力の一致と閉じた境界までは確認しない"
// @end-test-value
test("CLI and MCP publish matching closed input schemas for create and send", async () => {
  const runtimeCall: typeof callAgentRuntime = async () => {
    throw new Error("Schema discovery must not dispatch");
  };
  const server = createWithMateSessionMcpServer({ env, connection, runtimeCall });
  const client = new Client({ name: "session-input-parity", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(b);
    await client.connect(a);
    const { tools } = await client.listTools();
    const schema = await cli("schema", {}, runtimeCall);
    assert.equal(schema.exit, 0);
    const cliOperations = schema.value.operations as Record<string, { input: typeof tools[number]["inputSchema"] }>;
    for (const operation of ["create_child", "enqueue"]) {
      const published = tools.find((tool) => tool.name === `session.${operation}`);
      assert.ok(published, operation);
      const cliInput = cliOperations[operation].input;
      const mcpInput = published.inputSchema;
      const fields = Object.keys(cliInput.properties ?? {}).sort();
      assert.ok(fields.includes("model") && fields.includes("reasoningEffort"), operation);
      assert.deepEqual(Object.keys(mcpInput.properties ?? {}).sort(), fields, operation);
      assert.deepEqual([...(mcpInput.required ?? [])].sort(), [...(cliInput.required ?? [])].sort(), operation);
      assert.equal(cliInput.additionalProperties, false, operation);
      assert.equal(mcpInput.additionalProperties, false, operation);
    }
  } finally {
    await client.close();
    await server.close();
  }
});

// @test-value v2
// kind = "contract"
// claim = "Session MCPとbound CLIは保存実行設定・Coordination自然文投影・送信全文を含む同一binding/turn付き操作と結果・拒否を共有し、queue requestIdはUUIDのみ受け付け、送信応答喪失を未適用と偽らない"
// oracle = { type = "contract", ref = "GitHub #835 MCPとbound CLIの入力・結果・拒否の同一契約" }
// fault = "CLIが別actorで実行する、保存実行設定や送信本文を落とす、非UUIDをdispatchするかenqueue通信失敗をeffect noneとして返す"
// observable = "SDK MCPとCLIのstructured結果と保存実行設定・Coordination自然文投影・送信全文、dispatch identity、非UUIDの拒否とdispatch未実行、enqueue effect unknown"
// observation_boundary = "public-boundary"
// scope = "session-cli-mcp"
// lifecycle = "permanent"
// distinction = "schemaやapplication単体では実CLIとSDK MCPの接続契約と応答喪失を検出できない"
// @end-test-value
test("bound CLI and MCP share dispatch, denial and unknown mutation outcome", async () => {
  const calls: unknown[] = [];
  let lose = false;
  let reject = true;
  let successValues: Record<string, Record<string, unknown>> = {};
  const runtimeCall: typeof callAgentRuntime = async (
    _connection,
    request,
    options,
  ) => {
    calls.push({
      request,
      binding: options.bindingReference,
      turn: options.turnCapability,
    });
    if (lose) throw new Error("reply lost");
    return reject
      ? {
          ok: false,
          status: 403,
          value: { ok: false, code: "SESSION_FORBIDDEN", effect: "none" },
        }
      : { ok: true, status: 200, value: successValues[request.path] };
  };
  const server = createWithMateSessionMcpServer({
    env,
    connection,
    runtimeCall,
  });
  const client = new Client({ name: "session-parity", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(b);
    await client.connect(a);
    const target = {
      kind: "main",
      sessionId: "child",
      incarnationId: "child-v1",
    };
    const requestId = "11111111-1111-4111-8111-111111111111";
    const body = { target, requestId, message: "work", model: "model", reasoningEffort: "high" };
    const exact = { target, turnId: "1" };
    const operationId = "11111111-1111-4111-8111-111111111111";
    const coordination = { operationId, id: "consultation" };
    const prId = requestId;
    const runId = "22222222-2222-4222-8222-222222222222";
    const pr = { prId, version: 1 };
    const ci = { ...pr, runId };
    const headCommit = "a".repeat(40), targetCommit = "b".repeat(40);
    const targetBranch = "refs/heads/main";
    const inputs: Record<SessionOperation, Record<string, unknown>> = {
      pr_list: {}, pr_branches: {}, pr_get: { prId },
      pr_create: { headCommit, targetBranch, title: "Review" },
      pr_submit: { prId, headCommit, expectedVersion: 1 },
      pr_close: pr, pr_diff: { ...pr, mode: "full" }, pr_comment: { ...pr, body: "Review" },
      pr_merge: { ...pr, headCommit, targetCommit },
      pr_ci_validate: pr, pr_ci_list: pr, pr_ci_start: pr,
      pr_ci_cancel: ci, pr_ci_rerun: ci, pr_ci_log: { ...ci, offset: 0 },
      get_selection_policy: {}, set_selection_policy: { policy: null }, get_provider_quota: {},
      get_worktree_policy: {}, set_worktree_root: { rootPath: null }, set_worktree_repository: { rule: null },
      resolve_worktree: { branch: "feat/task" },
      self: {},
      get_instructions: {},
      set_instructions: { body: " Fixed instructions.\n" },
      list: { allCrews: true, limit: 2 },
      get: { target },
      list_directories: { target },
      add_directory: { target, directoryPath: "C:/shared" },
      remove_directory: { target, directoryPath: "C:/shared" },
      update_metadata: { title: "updated" },
      enqueue: body,
      get_receipt: { target, requestId },
      cancel_receipt: { target, receiptId: "receipt" },
      stop_turn: { target, turnId: "1" },
      steer: { target, turnId: "1", message: "check loading first" },
      list_sent_deliveries: { target, messageSeqs: [0, 1] },
      list_issued_coordinations: { target, messageSeqs: [0, 1] },
      list_sent_steers: { target: { kind: "main", sessionId: "parent", incarnationId: "parent-v1" }, messageSeqs: [0, 1] },
      list_executions: { target },
      get_execution: exact,
      list_execution_inputs: exact,
      get_execution_input: exact,
      list_execution_outputs: exact,
      get_execution_output: { ...exact, index: 0 },
      list_execution_operations: exact,
      get_execution_operation_detail: { ...exact, kind: "operation", index: 0 },
      coordination_list: { offset: 0, limit: 50 },
      coordination_get: { id: "consultation" },
      coordination_create: {
        operationId,
        kind: "decision",
        body: "question",
        choices: [],
        deliver: false,
      },
      coordination_deliver: coordination,
      coordination_escalate: { ...coordination, body: "need user" },
      coordination_answer: {
        ...coordination,
        body: "answer",
        selectedChoices: [],
        expectedAnswerRevision: 0,
        send: true,
      },
      coordination_withdraw: { ...coordination, reason: "" },
      coordination_resolve: coordination,
      coordination_consume: {
        ...coordination,
        answerId: "answer",
        answerRevision: 1,
      },
      coordination_correct: { ...coordination, body: "correction" },
      create_child: {
        requestId: "child-create",
        role: "executor",
        provider: "codex",
        model: "model",
        reasoningEffort: "medium",
        workspacePath: "workspace",
      },
      get_catalog: {},
      list_messages: { target },
      get_message: { target, seq: 1 },
      list_operations: { target, seq: 1 },
      get_operation_detail: { target, seq: 1, kind: "operation", index: 0 },
    };
    const session = {
      id: "child",
      incarnationId: "child-v1",
      kind: "main",
      role: "executor",
      sessionRole: "executor",
      rootSessionId: "parent",
      parentSessionId: "parent",
      createdBySessionId: "parent",
      mainSessionId: "child",
      mainIncarnationId: "child-v1",
      title: "task",
      description: "full",
      runState: "running",
      provider: "codex",
      workspacePath: "C:/workspace",
      character: { id: "character", name: "Character", description: "公開紹介" },
    };
    const receipt = {
      id: "receipt",
      requestId,
      sessionId: "child",
      incarnationId: "child-v1",
      state: "running",
      turnId: "1",
    };
    const description = {
      origin: null,
      receiptId: "receipt",
      receiptState: "running",
      turnId: "1",
      turnState: "running",
      resultState: "running",
      userMessageSeq: 1,
      assistantMessageSeq: null,
      inputs: {
        entry: null,
        startChanged: null,
        additional: {
          confirmedCount: 0,
          references: [],
          referencesNextOffset: null,
          unresolved: [],
          unresolvedCount: 0,
          unresolvedNextOffset: null,
          notSent: [],
          notSentCount: 0,
          notSentNextOffset: null,
          coverage: "recorded",
        },
      },
    };
    const page = { items: [], total: 0, offset: 0, nextOffset: null };
    const textPiece = {
      text: "saved",
      offset: 0,
      nextOffset: null,
      totalChars: 5,
    };
    const output = {
      finality: "unknown",
      unitCount: 1,
      textChars: 5,
      artifactSaved: false,
    };
    const executionSettings = {
      source: "input", provider: "codex", model: "captured-model", reasoningEffort: "high",
      approvalMode: "on-request", codexSandboxMode: "workspace-write", codexReviewer: "auto-review", codexSpeed: "fast", customAgentName: "",
    };
    const record = {
      id: "consultation",
      crewRootSessionId: "parent",
      state: "open",
      answerRevision: 0,
    };
    const submission = { id: prId, targetBranch, sourceBranch: null, title: "Review", description: "", createdBy: target,
      createdAt: "t", updatedAt: "t", state: "open", latestVersion: 1, mergedCommit: null };
    const comment = { id: prId, version: 1, anchor: null, replyTo: null, body: "Review", author: target, draft: false, createdAt: "t", updatedAt: "t" };
    const detail = { ...submission,
      versions: [{ version: 1, headCommit, targetCommit, mergeBaseCommit: targetCommit, submittedAt: "t", submittedBy: target }],
      comments: [comment], approval: null, currentTargetCommit: targetCommit };
    const run = { id: runId, version: 1, headCommit, targetCommit, state: "running", startedAt: "t", finishedAt: null, exitCode: null, error: null };
    const values: Record<SessionOperation, Record<string, unknown>> = {
      pr_list: { data: { entries: [submission], hasMore: false } },
      pr_branches: { data: { branches: [{ ref: targetBranch, commit: targetCommit }], head: headCommit, headBranch: null } },
      pr_get: { data: detail }, pr_create: { data: detail }, pr_submit: { data: detail },
      pr_close: { data: { ...detail, state: "closed" } },
      pr_diff: { data: { beforeCommit: targetCommit, afterCommit: headCommit, files: [], patch: null } },
      pr_comment: { data: comment },
      pr_merge: { data: { ...detail, state: "merged", mergedCommit: headCommit } },
      pr_ci_validate: { data: { headCommit, path: ".withmate/ci.yml", state: "not_configured", source: null, error: null } },
      pr_ci_list: { data: { runs: [run] } }, pr_ci_start: { data: run },
      pr_ci_cancel: { data: { ...run, state: "canceled", finishedAt: "t" } },
      pr_ci_rerun: { data: run }, pr_ci_log: { data: { log: "output", nextOffset: 6, hasMore: false } },
      get_selection_policy: { policy: null }, set_selection_policy: { policy: null }, get_provider_quota: { providers: [] },
      get_worktree_policy: { repositoryId: "C:/repo/.git", rootPath: null, rule: null }, set_worktree_root: { rootPath: null },
      set_worktree_repository: { repositoryId: "C:/repo/.git", rootPath: null, rule: null },
      resolve_worktree: { repositoryId: "C:/repo/.git", branch: "feat/task", status: "unconfigured", source: null, destinationPath: null, missing: ["rootPath", "repositoryRule"] },
      self: {
        session,
        currentTurn: { turnId: "1", receipt: null, origin: null },
        crewFolder: { rootSessionId: "parent", path: "crew-files/parent" },
      },
      list: { entries: [session], total: 1, hasMore: false },
      get: {
        session,
        currentTurn: { turnId: "1", receipt: null, origin: null },
        crewFolder: { rootSessionId: "parent", path: "crew-files/parent" },
      },
      list_directories: { directories: { workspacePath: "workspace", sessionFolderPath: "session-folder", crewFolder: { rootSessionId: "parent", path: "crew-folder" }, additionalDirectories: ["C:/shared"] } },
      add_directory: { directories: { workspacePath: "workspace", sessionFolderPath: "session-folder", crewFolder: { rootSessionId: "parent", path: "crew-folder" }, additionalDirectories: ["C:/shared"] } },
      remove_directory: { directories: { workspacePath: "workspace", sessionFolderPath: "session-folder", crewFolder: { rootSessionId: "parent", path: "crew-folder" }, additionalDirectories: [] } },
      get_instructions: { body: " Fixed instructions.\n" },
      set_instructions: { byteLength: 21 },
      update_metadata: {
        metadata: { id: "child", taskTitle: "updated", description: "full" },
      },
      enqueue: { receipt },
      get_receipt: { receipt },
      cancel_receipt: { result: { outcome: "not-applied", receipt } },
      stop_turn: { result: { outcome: "applied", turnId: "1" } },
      steer: { result: { outcome: "applied", turnId: "1", messageSeq: 1 } },
      list_issued_coordinations: { items: [{ id: "consultation", sourceTurnId: "1", sourceMessageSeq: 1, consultation: "Saved consultation" }], nextCursor: null },
      list_sent_deliveries: { items: [{
        receiptId: "receipt", sequence: 1, sourceTurnId: "1", sourceMessageSeq: 1, target, state: "completed",
        origin: { kind: "session", actorKind: "main", actorSessionId: "parent", actorIncarnationId: "parent-v1", actorTurnId: "1", operation: "send", targetSessionId: target.sessionId, targetIncarnationId: target.incarnationId },
        text: "Original input ".repeat(40), coordination: { id: "consultation", text: "Saved answer ".repeat(40) },
      }], nextCursor: null },
      list_sent_steers: { items: [{ sequence: 1, sourceTurnId: "1", sourceMessageSeq: 1, target, messageSeq: 2, state: "unknown",
        origin: { kind: "session", actorKind: "main", actorSessionId: "parent", actorIncarnationId: "parent-v1", actorTurnId: "1", operation: "steer", targetSessionId: target.sessionId, targetIncarnationId: target.incarnationId }, text: "Saved direct input" }], nextCursor: null },
      list_executions: {
        ...page,
        kind: "receipts",
        items: [description],
        total: 1,
      },
      get_execution: { ...description, executionSettings, output, coordination: { id: "consultation", text: "Saved authored answer" } },
      list_execution_inputs: { ...description, ...page },
      get_execution_input: {
        ...description,
        ...textPiece,
        attachments: [],
        expectedInput: "snapshot",
        originalKnown: true,
      },
      list_execution_outputs: { ...description, ...page, finality: "unknown" },
      get_execution_output: {
        ...description,
        ...textPiece,
        unit: {
          id: "unit",
          start: 0,
          end: 5,
          final: false,
          role: "unclassified",
          completion: "complete",
          phase: null,
          evidence: null,
        },
        finality: "unknown",
      },
      list_execution_operations: {
        ...description,
        ...page,
        seq: 2,
        section: "operations",
        artifactDetailSaved: false,
      },
      get_execution_operation_detail: {
        ...description,
        seq: 2,
        kind: "operation",
        index: 0,
      },
      coordination_list: { items: [record], total: 1, nextOffset: null },
      coordination_get: { record, initiatorTarget: target },
      coordination_create: { record },
      coordination_deliver: { record },
      coordination_escalate: { record },
      coordination_answer: { record },
      coordination_withdraw: { record },
      coordination_resolve: { record },
      coordination_consume: { record },
      coordination_correct: { record },
      create_child: {
        session,
        character: { id: "character", name: "Character", description: "公開紹介" },
        provider: "codex",
        workspacePath: "workspace",
        executionOptions: {
          model: "model",
          reasoningEffort: "medium",
          approvalMode: "on-request",
          codexSandboxMode: "workspace-write",
          codexReviewer: "auto-review",
        },
      },
      get_catalog: {
        catalog: {
          providers: [
            {
              id: "codex",
              models: [{ id: "model", reasoningEfforts: ["medium"] }],
            },
          ],
        },
        options: [
          {
            provider: "codex",
            approvalModes: [{ value: "untrusted", label: "Safety Focused" }],
            sandboxModes: [{ value: "workspace-write", label: "Workspace" }],
            reviewers: [{ value: "user", label: "User" }, { value: "auto-review", label: "Auto Review" }],
          },
        ],
      },
      list_messages: { ...page, window: { fromSeq: 0, toSeq: 2 } },
      get_message: { ...textPiece, seq: 1, role: "user", turn: null },
      list_operations: {
        ...page,
        seq: 1,
        section: "operations",
        artifactDetailSaved: false,
      },
      get_operation_detail: {
        ...textPiece,
        seq: 1,
        kind: "operation",
        index: 0,
      },
    };
    values.get_execution_input.inputPair = {
      original: { ok: true, ...textPiece, attachments: [] },
      comparison: { ok: true, ...textPiece, attachments: [] },
    };
    Object.assign(values.get_execution_operation_detail, textPiece);
    successValues = Object.fromEntries(
      Object.entries(values).map(([operation, value]) => [
        SESSION_RUNTIME_OPERATION_PATHS[operation as SessionOperation],
        { ok: true, ...value },
      ]),
    );
    assert.deepEqual(
      (await client.listTools()).tools.map((tool) => tool.name).sort(),
      Object.keys(inputs)
        .map((operation) => `session.${operation}`)
        .sort(),
    );
    for (const rejected of [true, false]) {
      reject = rejected;
      for (const [operation, input] of Object.entries(inputs) as [
        SessionOperation,
        Record<string, unknown>,
      ][]) {
        const command = await cli(
          operation.replaceAll("_", "-"),
          input,
          runtimeCall,
        );
        const tool = await client.callTool({
          name: `session.${operation}`,
          arguments: input,
        });
        assert.deepEqual(command.value, tool.structuredContent);
        assert.equal(tool.isError, rejected ? true : undefined, operation);
        assert.equal(command.exit, rejected ? 1 : 0);
        if (!rejected && operation === "get_execution") {
          assert.deepEqual(command.value.executionSettings, executionSettings);
          assert.deepEqual(command.value.coordination, values.get_execution.coordination);
        }
        if (!rejected && operation === "list_sent_deliveries") assert.deepEqual(command.value.items, values.list_sent_deliveries.items);
        if (!rejected && operation === "list_sent_steers") assert.deepEqual(command.value.items, values.list_sent_steers.items);
        if (rejected) assert.equal(command.value.effect, "none");
        assert.deepEqual(calls.at(-1), calls.at(-2));
        assert.deepEqual(calls.at(-1), {
          request: {
            method: "POST",
            path: SESSION_RUNTIME_OPERATION_PATHS[operation],
            body: input,
          },
          binding: "binding",
          turn: "turn",
        });
      }
    }
    for (const operation of ["enqueue", "get_receipt"] as const) {
      const input = { ...inputs[operation], requestId: "request-1" };
      const before = calls.length;
      const invalidId = await cli(operation.replaceAll("_", "-"), input, runtimeCall);
      assert.equal(invalidId.exit, 2);
      assert.equal(invalidId.value.effect, "none");
      const invalidTool = await client.callTool({ name: `session.${operation}`, arguments: input });
      assert.equal(invalidTool.isError, true);
      assert.equal(calls.length, before);
    }
    lose = true;
    const lost = await cli("enqueue", body, runtimeCall);
    assert.equal(lost.exit, 3);
    assert.equal(lost.value.effect, "unknown");
    assert.deepEqual(lost.value.recovery, {
      operation: "get_receipt",
      target,
      requestId,
    });
    assert.deepEqual(
      (await client.callTool({ name: "session.enqueue", arguments: body }))
        .structuredContent,
      lost.value,
    );
    const invalid = await cli(
      "enqueue",
      { actorSessionId: "spoofed" },
      runtimeCall,
    );
    assert.equal(invalid.exit, 2);
    assert.equal(calls.length, Object.keys(inputs).length * 4 + 2);
    // 置換の応答が失われても反映済みの場合があり、本文の専用読み取りでしか確かめられない。
    const lostInstructions = await cli("set-instructions", inputs.set_instructions, runtimeCall);
    assert.equal(lostInstructions.exit, 3);
    assert.equal(lostInstructions.value.effect, "unknown");
    assert.match(String(lostInstructions.value.message), /get_instructions/);
    assert.deepEqual(
      (await client.callTool({ name: "session.set_instructions", arguments: inputs.set_instructions })).structuredContent,
      lostInstructions.value,
    );
    for (const [operation, effect] of [["pr_diff", "none"], ["pr_ci_start", "unknown"], ["pr_merge", "unknown"]] as const) {
      const command = await cli(operation.replaceAll("_", "-"), inputs[operation], runtimeCall);
      const tool = await client.callTool({ name: `session.${operation}`, arguments: inputs[operation] });
      assert.equal(command.exit, 3);
      assert.equal(command.value.effect, effect);
      assert.match(String(command.value.message), /Read the PR or CI state/);
      assert.deepEqual(tool.structuredContent, command.value);
    }
  } finally {
    await client.close();
    await server.close();
  }
});

// @test-value v2
// kind = "contract"
// claim = "MCPとCLIはenqueueの明示配送タイミングを保持し、不正値は送信前に拒否し、遅延receiptの送信元状態を返す"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md#bound-session-api" }
// fault = "片側入口がdeliveryTimingを削除または不正値をdispatchし、sourceTurnPhaseを欠落させる"
// observable = "両入口のdispatch body、receipt.sourceTurnPhase、不正値でのdispatch件数不変、公開schemaとhelp"
// observation_boundary = "public-boundary"
// scope = "SDK MCPとbound CLIのenqueue/get_receipt入力・結果・利用説明"
// lifecycle = "permanent"
// distinction = "型検査だけでは外部JSONの不正値や実入口によるfield欠落を検出できない"
// @end-test-value
test("CLI and MCP preserve explicit enqueue timing and reject invalid timing", async () => {
  const calls: unknown[] = [];
  const target = { kind: "main", sessionId: "child", incarnationId: "child-v1" };
  const requestId = randomUUID();
  let phase = "running";
  const runtimeCall: typeof callAgentRuntime = async (_connection, request) => {
    calls.push(request.body);
    return {
      ok: true,
      status: 200,
      value: { ok: true, receipt: { id: "receipt", requestId, sessionId: "child", incarnationId: "child-v1", state: "queued", turnId: null, sourceTurnPhase: phase } },
    };
  };
  const server = createWithMateSessionMcpServer({ env, connection, runtimeCall });
  const client = new Client({ name: "delivery-timing-parity", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(b);
    await client.connect(a);
    const tools = await client.listTools();
    const schema = await cli("schema", {}, runtimeCall);
    const cliInput = (schema.value.operations as Record<string, { input: { properties: Record<string, unknown>; required: string[] } }>).enqueue.input;
    const mcpInput = tools.tools.find((tool) => tool.name === "session.enqueue")!.inputSchema;
    assert.deepEqual(cliInput.properties.deliveryTiming, { type: "string", enum: ["immediate", "after_source_turn"] });
    assert.deepEqual(mcpInput.properties?.deliveryTiming, cliInput.properties.deliveryTiming);
    assert.equal(cliInput.required.includes("deliveryTiming"), false);
    assert.equal(mcpInput.required?.includes("deliveryTiming"), false);
    let help = "";
    assert.equal(await runWithMateSessionCli(["help"], { stdout: { write: (value) => { help += String(value); return true; } } }), 0);
    assert.match(help, /deliveryTiming.*immediate.*after_source_turn/);
    for (const deliveryTiming of [undefined, "immediate", "after_source_turn"]) {
      const input = { target, requestId, message: "report", ...(deliveryTiming ? { deliveryTiming } : {}) };
      const command = await cli("enqueue", input, runtimeCall);
      const tool = await client.callTool({ name: "session.enqueue", arguments: input });
      assert.equal(command.exit, 0);
      assert.equal(tool.isError, undefined);
      assert.deepEqual(command.value, tool.structuredContent);
      assert.deepEqual(calls.slice(-2), [input, input]);
      assert.equal((command.value.receipt as { sourceTurnPhase: string }).sourceTurnPhase, "running");
    }
    for (phase of ["completed", "failed", "canceled", "unknown"]) {
      const input = { target, requestId };
      const command = await cli("get-receipt", input, runtimeCall);
      const tool = await client.callTool({ name: "session.get_receipt", arguments: input });
      assert.equal(command.exit, 0);
      assert.deepEqual(command.value, tool.structuredContent);
      assert.equal((command.value.receipt as { sourceTurnPhase: string }).sourceTurnPhase, phase);
    }
    for (const deliveryTiming of ["later", null, 1]) {
      const before = calls.length;
      const input = { target, requestId, message: "report", deliveryTiming };
      const command = await cli("enqueue", input, runtimeCall);
      const tool = await client.callTool({ name: "session.enqueue", arguments: input });
      assert.equal(command.exit, 2);
      assert.equal(command.value.effect, "none");
      assert.equal(tool.isError, true);
      assert.equal(calls.length, before);
    }
  } finally {
    await client.close();
    await server.close();
  }
});

// @test-value v2
// kind = "contract"
// claim = "bound CLIとMCPは実保存の自己・直属子Directoryを同じ契約で追加・読取・解除し、無効pathと無関係Sessionを拒否する"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md#bound-session-api; docs/runbooks/development-workflow.md MCPとCLIの機能・操作契約" }
// fault = "片入口が別Sessionを操作する、追加・解除がDBへ届かない、無効pathを受け入れる、または実ファイルを削除する"
// observable = "両入口の結果と拒否、DBから再読込したMain別一覧、解除後の実ファイル"
// observation_boundary = "public-boundary"
// scope = "SessionStorageV6 → directory management → Session runtime → SDK MCP/bound CLI"
// lifecycle = "permanent"
// risk_tags = ["authorization", "privacy"]
// distinction = "手製の全操作parity fixtureやservice単体では実保存と両入口の結合を確認できない"
// @end-test-value
test("directory management crosses persisted Session runtime, MCP and CLI", async () => {
  const directory = await mkdtemp(join(tmpdir(), "withmate-directory-api-"));
  const workspace = join(directory, "workspace"), extra = join(directory, "extra");
  await mkdir(workspace);
  await mkdir(extra);
  const retained = join(extra, "retained.txt");
  await writeFile(retained, "keep");
  const storage = new SessionStorageV6(join(directory, "sessions.db"));
  const create = (id: string, parentSessionId?: string) => storage.insertSession(buildNewSession({
    id, taskTitle: id, workspaceLabel: "Workspace", workspacePath: workspace, branch: "main",
    characterId: "unknown", character: "Unknown", characterIconPath: "",
    characterThemeColors: { main: "#123456", sub: "#234567" }, approvalMode: "untrusted",
    sessionRole: parentSessionId ? "executor" : "overall-coordinator", rootSessionId: parentSessionId ?? id,
    parentSessionId: parentSessionId ?? null, createdBySessionId: parentSessionId ?? null,
  }));
  const parent = create("dir-parent"), child = create("dir-child", parent.id), other = create("other");
  let cached = [parent, child, other];
  const persistence = new SessionPersistenceService({
    getSessions: () => cached, setSessions: (next) => { cached = next; },
    getSession: (id) => cached.find((entry) => entry.id === id) ?? null,
    getStoredSession: (id) => storage.getSession(id),
    isSessionRunInFlight: () => false,
    upsertStoredSession: (session) => storage.updateSession(session),
    setStoredSessionAdditionalDirectories: (id, incarnation, directories) => storage.setSessionAdditionalDirectories(id, incarnation, directories),
    replaceStoredSessions: (sessions) => { storage.replaceSessions(sessions); },
    listStoredSessions: () => storage.listSessions(),
    getAppSettings: () => normalizeAppSettings({}), getModelCatalogSnapshot: () => ({ providers: [] }), clearSessionContextTelemetry: () => undefined, invalidateProviderSessionThread: () => undefined,
    closeSessionWindow: () => undefined, broadcastSessions: () => undefined,
  });
  const bindings = new AgentRuntimeBindingRegistry();
  const turns = new ProviderAgentRuntimeTurnCoordinator();
  const target = (session: typeof parent) => ({ kind: "main" as const, sessionId: session.id, incarnationId: getSessionIncarnationId(session) });
  const binding = bindings.issueOrReuse({ actorSessionId: parent.id, providerId: parent.provider,
    authoritySnapshot: { sessionIdentity: target(parent) }, operationGrants: getSessionAgentRuntimeOperations() });
  const turn = turns.begin({ actorSessionId: parent.id, providerId: parent.provider });
  const boundEnv = { WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE: binding.bindingReference, WITHMATE_AGENT_RUNTIME_TURN_CAPABILITY: turn.capability };
  const unused = async () => { throw new Error("Unexpected operation"); };
  const application = new SessionManagementApplication({
    readSessionScope: async (actor, selection) => storage.readSessionManagementScope(actor, selection),
    getInstructions: unused, setInstructions: unused,
    operatingPolicy: unused,
    directories: (session, change, assertCurrent) => manageSessionDirectories(persistence, directory, session, change, assertCurrent),
    currentTurn: async () => ({ turnId: "1", receipt: null, origin: null }), crewFolder: unused,
    updateMetadata: unused, enqueue: unused, getReceipt: unused, cancelReceipt: unused, stopTurn: unused, steer: unused,
    readExecution: unused, createChild: unused, catalog: unused, coordinate: unused,
  });
  const runtime = new SessionManagementRuntimeService({ application, bindingRegistry: bindings, providerAgentRuntimeTurns: turns });
  const runtimeCall: typeof callAgentRuntime = async (_connection, operation, options) => {
    const response = await runtime.route({ method: operation.method, path: operation.path, body: operation.body, transport: "mcp",
      bindingReference: options.bindingReference, turnCapability: options.turnCapability });
    assert.ok(response);
    return { ok: response.status >= 200 && response.status < 300, status: response.status, value: response.value };
  };
  const server = createWithMateSessionMcpServer({ env: boundEnv, connection, runtimeCall });
  const client = new Client({ name: "directory-parity", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(b);
    await client.connect(a);
    assert.equal((await cli("add-directory", { target: target(child), directoryPath: extra }, runtimeCall, boundEnv)).exit, 0);
    const listed = await client.callTool({ name: "session.list_directories", arguments: { target: target(child) } });
    assert.deepEqual((listed.structuredContent as { directories: { additionalDirectories: string[] } }).directories.additionalDirectories, [extra]);
    assert.equal((await client.callTool({ name: "session.add_directory", arguments: { target: target(parent), directoryPath: extra } })).isError, undefined);
    const own = await cli("list-directories", { target: target(parent) }, runtimeCall, boundEnv);
    assert.deepEqual((own.value.directories as { additionalDirectories: string[] }).additionalDirectories, [extra]);
    assert.equal((await client.callTool({ name: "session.remove_directory", arguments: { target: target(child), directoryPath: extra } })).isError, undefined);
    assert.deepEqual(storage.getSession(child.id)?.allowedAdditionalDirectories, []);
    assert.deepEqual(storage.getSession(parent.id)?.allowedAdditionalDirectories, [extra]);
    await access(retained);
    const forbidden = await cli("add-directory", { target: target(other), directoryPath: extra }, runtimeCall, boundEnv);
    assert.equal(forbidden.value.code, "SESSION_FORBIDDEN");
    assert.equal(forbidden.value.effect, "none");
    const invalid = await cli("add-directory", { target: target(child), directoryPath: "relative" }, runtimeCall, boundEnv);
    assert.equal(invalid.value.code, "SESSION_REJECTED");
    assert.equal(invalid.value.effect, "none");
    assert.deepEqual(storage.getSession(other.id)?.allowedAdditionalDirectories, []);
  } finally {
    await client.close();
    await server.close();
    turns.end(turn);
    storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});

// @test-value v2
// kind = "contract"
// claim = "実保存のCoordination詳細はMCPとbound CLIで同じtargetと回答を返し、起票元だけの取得で回答を確定する"
// oracle = { type = "contract", ref = "docs/design/database-schema.md#coordination; docs/runbooks/development-workflow.md MCPとCLIの機能・操作契約" }
// fault = "片方の入口で取得を確定しない、他Sessionの取得で確定する、またはAuxiliary所属Main identityを失う"
// observable = "両入口の成功結果・record ID・initiatorTarget・取得済み状態、MCPの操作属性"
// observation_boundary = "public-boundary"
// scope = "CoordinationStorageV7 → CoordinationApplicationService → SessionManagementRuntimeService → SDK MCP/bound CLI（HTTP exchangeのみin-process adapter）"
// lifecycle = "permanent"
// distinction = "全操作parityの手製成功fixtureでは実保存projectionと公開success schemaの不一致を検出できない"
// @end-test-value
test("saved Coordination details cross the real application and both public schemas", async () => {
  const directory = await mkdtemp(join(tmpdir(), "withmate-coordination-api-"));
  const dbPath = join(directory, "withmate-v6.db");
  const sessions = new SessionStorageV6(dbPath);
  const source = sessions.insertSession(
    buildNewSession({
      id: "main",
      taskTitle: "Main",
      workspaceLabel: "Workspace",
      workspacePath: directory,
      branch: "main",
      characterId: "unknown",
      character: "Unknown",
      characterIconPath: "",
      characterThemeColors: { main: "#123456", sub: "#234567" },
      approvalMode: "untrusted",
      model: "test-model",
      reasoningEffort: "medium",
    }),
  );
  const incarnationId = getSessionIncarnationId(source);
  const db = new DatabaseSync(dbPath);
  db.prepare(
    "INSERT INTO session_turns_v6(id,session_id,phase,started_at,updated_at) VALUES(1,?,'completed','now','now')",
  ).run(source.id);
  db.prepare(
    "INSERT INTO auxiliary_sessions(id,parent_session_id,created_at,updated_at,character_id) VALUES ('aux',?,'aux-created','now','unknown')",
  ).run(source.id);
  db.prepare(
    "INSERT INTO session_turns_v6(id,auxiliary_session_id,phase,started_at,updated_at) VALUES(2,'aux','completed','now','now')",
  ).run();
  const store = new CoordinationStorageV7(dbPath);
  const bindings = new AgentRuntimeBindingRegistry();
  const turns = new ProviderAgentRuntimeTurnCoordinator();
  const identity = {
    kind: "main" as const,
    sessionId: source.id,
    incarnationId,
  };
  const binding = bindings.issueOrReuse({
    actorSessionId: source.id,
    providerId: source.provider,
    authoritySnapshot: { sessionIdentity: identity },
    operationGrants: getSessionAgentRuntimeOperations(),
  });
  const turn = turns.begin({
    actorSessionId: source.id,
    providerId: source.provider,
  });
  const boundEnv = {
    WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE: binding.bindingReference,
    WITHMATE_AGENT_RUNTIME_TURN_CAPABILITY: turn.capability,
  };
  const coordinationStore = {
    execute: async (input) => store.execute(input),
    deliveryTarget: async (input) => store.deliveryTarget(input),
  } satisfies import("../../src-shared/coordination/coordination-contract.js").CoordinationStore;
  const coordination = new CoordinationApplicationService({
    getStore: () => coordinationStore,
    prepareDelivery: async () => {
      throw new Error("Read must not deliver");
    },
  });
  const unused = async () => {
    throw new Error("Unexpected operation");
  };
  const application = new SessionManagementApplication({
    readSessionScope: fixtureSessionManagementScope(() => resolveRelatedSessions([source], [])),
    getInstructions: unused, setInstructions: unused,
    operatingPolicy: unused,
    currentTurn: async () => ({ turnId: "1", receipt: null, origin: null }),
    crewFolder: async () => ({ rootSessionId: source.id, path: directory }),
    directories: unused,
    updateMetadata: unused,
    enqueue: unused,
    getReceipt: unused,
    cancelReceipt: unused,
    stopTurn: unused,
    steer: unused,
    readExecution: unused,
    createChild: unused,
    catalog: unused,
    coordinate: (actor, _turnId, request, assertCurrent) =>
      coordination.read(
        {
          kind: actor.kind,
          sessionId: actor.id,
          incarnationId: actor.incarnationId,
        },
        request,
        () => {
          assertCurrent();
          return true;
        },
      ),
  });
  const runtime = new SessionManagementRuntimeService({
    application,
    bindingRegistry: bindings,
    providerAgentRuntimeTurns: turns,
  });
  const runtimeCall: typeof callAgentRuntime = async (
    _connection,
    operation,
    options,
  ) => {
    const response = await runtime.route({
      method: operation.method,
      path: operation.path,
      body: operation.body,
      transport: "mcp",
      bindingReference: options.bindingReference,
      turnCapability: options.turnCapability,
    });
    assert.ok(response);
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      value: response.value,
    };
  };
  const server = createWithMateSessionMcpServer({
    env: boundEnv,
    connection,
    runtimeCall,
  });
  const client = new Client({
    name: "coordination-real-storage",
    version: "1",
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(b);
    await client.connect(a);
    const listed = await client.listTools();
    const getTool = listed.tools.find((entry) => entry.name === "session.coordination_get")!;
    assert.equal(getTool.annotations?.readOnlyHint, false);
    assert.equal(getTool.annotations?.idempotentHint, true);
    const actors = [
      { ...identity, turnId: "1" },
      {
        kind: "auxiliary" as const,
        sessionId: "aux",
        incarnationId: "aux-created",
        turnId: "2",
      },
    ];
    for (const [actor, first] of [[actors[0], "cli"], [actors[0], "mcp"], [actors[1], "cli"]] as const) {
      const saved = store.execute({
        actor,
        request: {
          operation: "create",
          operationId: randomUUID(),
          kind: "decision",
          body: "Saved consultation",
          choices: [],
          respondent: { kind: "user" },
          deliver: false,
        },
      });
      assert.ok("record" in saved);
      store.execute({ actor: { kind: "user" }, request: { operation: "answer", id: saved.record.id, operationId: randomUUID(), body: "Use this", selectedChoices: [], expectedAnswerRevision: 0, send: false } });
      const input = { id: saved.record.id };
      let command: Awaited<ReturnType<typeof cli>>;
      let tool: Awaited<ReturnType<typeof client.callTool>>;
      const callCli = () => cli("coordination-get", input, runtimeCall, boundEnv);
      const callMcp = () => client.callTool({ name: "session.coordination_get", arguments: input });
      if (first === "cli") { command = await callCli(); tool = await callMcp(); }
      else { tool = await callMcp(); command = await callCli(); }
      assert.equal(command.exit, 0);
      assert.equal(tool.isError, undefined);
      assert.deepEqual(command.value, tool.structuredContent);
      assert.equal(
        (command.value.record as { id: string }).id,
        saved.record.id,
      );
      const answer = (command.value.record as { answers: Array<{ acquiredAt?: string }> }).answers[0];
      assert.equal(Boolean(answer?.acquiredAt), actor.kind === "main");
      assert.deepEqual(
        command.value.initiatorTarget,
        actor.kind === "main"
          ? identity
          : {
              kind: "auxiliary",
              sessionId: "aux",
              incarnationId: "aux-created",
              mainSessionId: source.id,
              mainIncarnationId: incarnationId,
            },
      );
    }
  } finally {
    await client.close();
    await server.close();
    turns.end(turn);
    bindings.revokeAll();
    store.close();
    db.close();
    sessions.close();
    await rm(directory, { recursive: true, force: true });
  }
});
