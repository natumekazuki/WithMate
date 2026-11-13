import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { runWithMateSessionCli } from "../../src-cli/session/withmate-session.js";
import { createWithMateSessionMcpServer } from "../../src-electron/platform/mcp/withmate-session-mcp.js";
import type { callWithMateMemoryRuntime, WithMateMemoryRuntimeConnection } from "../../src-electron/platform/mcp/withmate-memory-runtime-client.js";
import { SessionManagementApplication, SessionManagementError } from "../../src-electron/session/session-management-application.js";
import { SessionManagementRuntimeService } from "../../src-electron/session/session-management-runtime-service.js";
import { SessionOperatingPolicyService } from "../../src-electron/session/session-operating-policy-service.js";
import { MainSessionTurnQueueFacade, SessionTurnQueuePreflightRejectedError } from "../../src-electron/app/main-session-turn-queue-facade.js";
import { SessionTurnQueueService } from "../../src-electron/session/session-turn-queue-service.js";
import { resolveRelatedSessions } from "../../src-electron/session/session-relationship-resolver.js";
import { createV6StorageWorkerBundle } from "../../src-electron/storage/storage-worker-bundle.js";
import { AgentRuntimeBindingRegistry } from "../../src-electron/providers/agent-runtime-binding.js";
import { ProviderAgentRuntimeTurnCoordinator } from "../../src-electron/providers/provider-agent-runtime-turn-coordinator.js";
import { getSessionAgentRuntimeOperations } from "../../src-shared/session/session-management-contract.js";
import { buildNewSession, getSessionIncarnationId, type Session } from "../../src-shared/session/session-state.js";
import { captureSessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";
import type { SessionTurnQueueReceipt } from "../../src-shared/session/session-turn-queue.js";
import { createDefaultAppSettings } from "../../src-shared/settings/provider-settings-state.js";
import { SessionPersistenceService } from "../../src-electron/session/session-persistence-service.js";
import { MainSessionCommandFacade } from "../../src-electron/app/main-session-command-facade.js";
import { ProviderRuntimeOperationCoordinator } from "../../src-electron/providers/provider-runtime-operation-coordinator.js";
import { ChildSessionCreationRejectedError } from "../../src-electron/session/session-storage-errors.js";
import { SessionRuntimeService } from "../../src-electron/session/session-runtime-service.js";
import { composeProviderPrompt } from "../../src-electron/providers/provider-prompt.js";
import type { RunSessionTurnInput } from "../../src-electron/providers/provider-runtime.js";

const target = (session: Session) => ({ kind: "main" as const, sessionId: session.id, incarnationId: getSessionIncarnationId(session) });
const connection: WithMateMemoryRuntimeConnection = {
  api: { baseUrl: "http://127.0.0.1:7777", apiSecret: "secret", applicationInstanceId: "instance", runtimeGenerationId: "generation", runtimeInstanceId: "generation" },
  credential: { adapter: "mcp", adapterSecret: "adapter" },
};

async function fixture(provider = "codex") {
  const directory = await mkdtemp(join(tmpdir(), "withmate-enqueue-settings-"));
  const options = { dbPath: join(directory, "withmate-v6.db"), userDataPath: directory,
    workerUrl: new URL("../../src-electron/storage/storage-worker-entry.ts", import.meta.url),
    handlerModule: new URL("../../src-electron/storage/storage-worker-bundle.ts", import.meta.url), workerOptions: { execArgv: ["--import", "tsx"] } };
  let bundle = createV6StorageWorkerBundle(options);
  await bundle.initialize();
  const create = (id: string, parentSessionId?: string) => bundle.stores.session.insertSession(buildNewSession({
    id, taskTitle: id, workspaceLabel: id, workspacePath: join(directory, id), branch: "main",
    characterId: "unknown", character: "Unknown", characterIconPath: "", characterThemeColors: { main: "#123456", sub: "#abcdef" },
    provider, model: "deep", reasoningEffort: "high", approvalMode: "on-request",
    sessionRole: parentSessionId ? "executor" : "overall-coordinator", rootSessionId: parentSessionId ?? id,
    parentSessionId: parentSessionId ?? null, createdBySessionId: parentSessionId ?? null,
  }));
  const parent = await create("parent"), child = await create("child", parent.id);
  const sourceTurns = new Map<string, string>();
  for (const session of [parent, child]) {
    const turn = await bundle.stores.turn.createSessionTurn({ sessionId: session.id, phase: "running", createdAt: new Date().toISOString(),
      provider, model: session.model, reasoningEffort: session.reasoningEffort, approvalMode: session.approvalMode, threadId: "", errorMessage: "" });
    sourceTurns.set(session.id, String(turn.id));
  }
  const bindings = new AgentRuntimeBindingRegistry(), turns = new ProviderAgentRuntimeTurnCoordinator();
  const settings = createDefaultAppSettings();
  const models = [{ id: "fast", label: "Fast", reasoningEfforts: ["low"] }, { id: "deep", label: "Deep", reasoningEfforts: ["high"] }, { id: "plain", label: "Plain", reasoningEfforts: [] }];
  const catalog = { id: provider, label: provider, defaultModelId: "deep", defaultReasoningEffort: "high", models };
  const unused = async (): Promise<never> => { throw new Error("Unexpected operation"); };
  let cached = await bundle.stores.session.listSessions();
  const persistence = new SessionPersistenceService({
    getSessions: () => cached, setSessions: (next) => { cached = next; }, getSession: (id) => cached.find((item) => item.id === id) ?? null,
    getStoredSession: (id) => bundle.stores.session.getSession(id), isSessionRunInFlight: () => false,
    upsertStoredSession: (session, operation) => operation === "create" ? bundle.stores.session.insertSession(session) : bundle.stores.session.updateSession(session),
    replaceStoredSessions: async (sessions) => { await bundle.stores.session.replaceSessions(sessions); },
    listStoredSessions: () => bundle.stores.session.listSessions(), listStoredSessionSummaries: () => bundle.stores.session.listSessionSummaries(),
    getSessionLifecycleOperation: (id) => bundle.stores.session.getSessionLifecycleOperation(id),
    listPendingSessionLifecycleOperations: () => bundle.stores.session.listPendingSessionLifecycleOperations(),
    beginSessionLifecycleOperation: (input) => bundle.stores.session.beginSessionLifecycleOperation(input),
    prepareSessionLifecycleCreation: (id, input) => bundle.stores.session.prepareSessionLifecycleCreation(id, input),
    advanceSessionLifecycleOperation: (id, phase, resources) => bundle.stores.session.advanceSessionLifecycleOperation(id, phase, resources),
    appendStoredRunningTurnStart: (input) => bundle.stores.session.appendRunningTurnStart(input),
    appendStoredSessionTerminal: (input) => bundle.stores.session.appendSessionTerminal(input),
    checkpointStoredSessionRunMetadata: (input) => bundle.stores.session.checkpointSessionRunMetadata(input),
    getAppSettings: () => settings, getModelCatalogSnapshot: () => ({ providers: [catalog] }),
    syncSessionDependencies() {}, clearSessionContextTelemetry() {}, clearSessionBackgroundActivities() {}, invalidateProviderSessionThread() {}, closeSessionWindow() {}, broadcastSessions() {},
  });
  const coordinator = new ProviderRuntimeOperationCoordinator();
  let childSequence = 0;
  const commands = new MainSessionCommandFacade({
    getSessions: () => cached, getSession: (id) => cached.find((item) => item.id === id) ?? null,
    getStoredSessionSummaries: () => bundle.stores.session.listSessionSummaries(), getSessionStorageIdentity: () => bundle,
    runProviderRuntimeOperationExclusive: (operation) => coordinator.runExclusive(operation),
    resolveSessionLaunchSelection: unused, getSessionPersistenceService: () => persistence, getSessionRuntimeService: () => { throw new Error("Unexpected GUI runtime"); },
    getProviderQuotaTelemetry: () => null, isProviderQuotaTelemetryStale: () => false, refreshProviderQuotaTelemetry: async () => null,
    initializeCreatedSession: async (session) => { await bundle.stores.auxiliary.upsertAuxiliarySession({ ...session,
      id: `${session.id}-aux`, parentSessionId: session.id, title: "Aux", runState: "idle", createdAt: session.updatedAt,
      composerDraft: "", displayAfterMessageIndex: null, creationContext: { generationId: "test", parentIncarnationId: getSessionIncarnationId(session) } }); },
    createSessionId: () => `created-${++childSequence}`,
    createSessionFilesDirectory: async (id) => { const folder = join(directory, `files-${id}`); await mkdir(folder); return folder; },
    resolveSessionFilesDirectory: (id) => join(directory, `files-${id}`), isSessionFilesWorkspace: () => false,
    dismissSessionTurnNotification() {}, validateWorkspaceDirectory: async () => ({ valid: true }),
    listActiveCharacters: () => bundle.stores.character.listCharacters(),
    createCharacterRuntimeSnapshot: (id) => bundle.stores.character.createRuntimeSnapshot(id),
  });
  let service: SessionTurnQueueService;
  let facade: MainSessionTurnQueueFacade;
  const startQueue = () => {
    service = new SessionTurnQueueService({ store: bundle.stores.queue, isRunInFlight: () => true, dispatch: unused });
    facade = new MainSessionTurnQueueFacade({ assertActive() {}, assertAccepting() {},
      getSession: (id) => bundle.stores.session.getSession(id), getAppSettings: async () => settings,
      validateWorkspace: async () => {}, validateProvider: async (session) => { assert.equal(session.provider, catalog.id); return { provider: catalog }; },
      preview: async () => ({ errors: [], attachments: [] }), store: bundle.stores.queue, service });
  };
  startQueue();
  const operatingPolicy = new SessionOperatingPolicyService({ getStore: () => bundle.stores.settings, getQuota: () => null });
  const application = new SessionManagementApplication({
    operatingPolicy: (actor, operation, request, current) => operatingPolicy.execute(operation, request, actor.workspacePath, current),
    listSessions: async () => resolveRelatedSessions(await bundle.stores.session.listSessionSummaries(), []),
    currentTurn: async (actor) => ({ turnId: sourceTurns.get(actor.id)!, receipt: null, origin: null }),
    crewFolder: async () => ({ rootSessionId: parent.id, path: directory }),
    catalog: async (actor, input) => ({ workspacePath: input.workspacePath ?? actor.workspacePath, providers: [catalog] }),
    enqueue: async (recipient, input, actor, turnId, assertCurrent) => {
      try {
        return await facade.enqueueSessionMessage(input, { kind: "session", actorKind: actor.kind, actorSessionId: actor.id,
          actorIncarnationId: actor.incarnationId, actorTurnId: turnId, operation: "send", targetSessionId: recipient.id, targetIncarnationId: recipient.incarnationId }, assertCurrent);
      } catch (error) {
        if (error instanceof SessionTurnQueuePreflightRejectedError) throw new SessionManagementError("SESSION_REJECTED", error.message);
        throw error;
      }
    },
    getReceipt: (recipient, id) => facade.getSessionTurnQueueReceipt(recipient.id, id, recipient.incarnationId),
    createChild: async (actor, input, assertCurrent) => {
      try { return await commands.createChildSession(actor, input, assertCurrent); }
      catch (error) {
        if (error instanceof ChildSessionCreationRejectedError) throw new SessionManagementError("SESSION_REJECTED", error.message);
        throw error;
      }
    },
    directories: unused, updateMetadata: unused, cancelReceipt: unused, stopTurn: unused, steer: unused, readExecution: unused, coordinate: unused,
  });
  const runtime = new SessionManagementRuntimeService({ application, bindingRegistry: bindings, providerAgentRuntimeTurns: turns });
  const runtimeCall: typeof callWithMateMemoryRuntime = async (_connection, operation, bound) => {
    const response = await runtime.route({ ...operation, transport: "mcp", bindingReference: bound.bindingReference, turnCapability: bound.turnCapability });
    assert.ok(response);
    return { ok: response.status >= 200 && response.status < 300, status: response.status, value: response.value };
  };
  const cleanups: (() => Promise<void>)[] = [];
  async function endpoint(session: Session) {
    const binding = bindings.issueOrReuse({ actorSessionId: session.id, providerId: provider,
      authoritySnapshot: { sessionIdentity: target(session) }, operationGrants: getSessionAgentRuntimeOperations() });
    const turn = turns.begin({ actorSessionId: session.id, providerId: provider });
    const env = { WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE: binding.bindingReference, WITHMATE_AGENT_RUNTIME_TURN_CAPABILITY: turn.capability };
    const server = createWithMateSessionMcpServer({ env, connection, runtimeCall });
    const client = new Client({ name: "enqueue-settings", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b); await client.connect(a);
    cleanups.push(async () => { await client.close(); await server.close(); turns.end(turn); });
    return async (transport: "cli" | "mcp", operation: string, body: Record<string, unknown>) => {
      if (transport === "mcp") {
        const result = await client.callTool({ name: `session.${operation}`, arguments: body });
        return (result.structuredContent ?? result) as Record<string, unknown>;
      }
      let output = "";
      await runWithMateSessionCli([operation.replaceAll("_", "-"), "--json", JSON.stringify(body)], { env, connection, runtimeCall,
        stdout: { write: (text) => { output += String(text); return true; } }, stderr: { write: () => true } });
      return JSON.parse(output) as Record<string, unknown>;
    };
  }
  return { parent, child, sourceTurns, models, settings, endpoint, get bundle() { return bundle; }, get facade() { return facade; },
    async dispatchNext(session: Session) {
      const receipt = await bundle.stores.queue.claimNext(target(session));
      assert.ok(receipt);
      const executed: { provider: string | null | undefined; input: RunSessionTurnInput }[] = [];
      const runtime = new SessionRuntimeService({
        getSession: (id) => bundle.stores.session.getSession(id),
        persistRunningTurnStart: persistence.persistRunningTurnStart.bind(persistence),
        persistQueuedTurnStart: persistence.persistQueuedTurnStart.bind(persistence),
        assertCapturedComposerAttachmentsAvailable: async (_session, attachments) => { assert.deepEqual(attachments, []); },
        appendRunningInput: persistence.appendRunningInput.bind(persistence),
        appendTerminalSession: persistence.appendTerminalSession.bind(persistence),
        checkpointRuntimeMetadata: persistence.checkpointRuntimeMetadata.bind(persistence),
        resolveComposerPreview: unused, getAppSettings: () => settings,
        resolveProviderCatalog: () => ({ snapshot: { providers: [catalog] }, provider: catalog }),
        getProviderCodingAdapter: (providerId) => ({ composePrompt: composeProviderPrompt,
          getProviderQuotaTelemetry: async () => null, invalidateSessionThread: async () => {}, invalidateAllSessionThreads: async () => {},
          runSessionTurn: async (input) => { executed.push({ provider: providerId, input }); return { assistantText: "done", threadId: "fixture-thread", usage: null }; } }),
        createSessionTurn: (input) => bundle.stores.turn.createSessionTurn(input), updateSessionTurn: (id, input) => bundle.stores.turn.updateSessionTurn(id, input),
        setLiveSessionRun() {}, getLiveSessionRun: () => null, waitForApprovalDecision: () => "deny", waitForElicitationResponse: () => ({ action: "cancel" }),
        setProviderQuotaTelemetry() {}, setSessionContextTelemetry() {}, invalidateProviderSessionThread() {}, scheduleProviderQuotaTelemetryRefresh() {},
        broadcastLiveSessionRun() {}, resolvePendingApprovalRequest() {}, resolvePendingElicitationRequest() {},
      });
      const result = await runtime.runQueuedSessionTurn(receipt, async (started) => { await bundle.stores.queue.markStarted(target(session), receipt.id, started); });
      return { result, executed };
    },
    async reopen() { await service.close(); await bundle.client.close(); bundle = createV6StorageWorkerBundle(options); await bundle.initialize(); startQueue(); },
    async close() { for (const cleanup of cleanups) await cleanup(); await service.close(); await bundle.client.close(); await rm(directory, { recursive: true, force: true }); } };
}

// @test-value v2
// kind = "contract"
// claim = "親はMCP/CLIでCodex子のReviewer候補を確認・指定でき、保存と初回通常TurnのProvider入力が一致し、省略はuser・非対応指定は未作成になる"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/945; docs/design/session-run-lifecycle.md#bound-session-api" }
// fault = "Reviewerをuser固定で保存する、片入口だけ指定値を失う、初回依頼へ引き継がない、非対応指定を黙って無視して子を作る"
// observable = "両入口のcatalog/作成結果・拒否理由、実Storage Worker再読込、同requestIdの子identity、再起動後のqueue dispatchとCodex adapter境界の実行設定"
// observation_boundary = "public-boundary"
// scope = "SDK MCP/bound CLI→Session application→共通子作成/lifecycle/queue/runtime→Codex adapter境界。catalog/Workspace検証/HTTP/Provider実行はfixture"
// lifecycle = "permanent"
// impact = "許可済み作業を委譲しても子が意図しないユーザーReviewerで起動し、運用が入力待ちで止まる"
// distinction = "schemaのparityや設定単体では、子作成から実保存・初回通常依頼までのReviewer引継ぎを確認できない"
// @end-test-value
test("Codex child Reviewer selection survives creation, recovery and the first normal request", async () => {
  const f = await fixture();
  try {
    await f.bundle.stores.character.createCharacter({ name: "Child fixture" });
    const parent = await f.endpoint(f.parent);
    const base = { role: "executor", provider: "codex", model: "deep", reasoningEffort: "high", approvalMode: "on-request", codexSandboxMode: "workspace-write", workspacePath: join(f.parent.workspacePath, "..") };
    const created: { session: Session; reviewer: "user" | "auto-review"; requestId: string }[] = [];
    for (const transport of ["mcp", "cli"] as const) {
      const catalog = await parent(transport, "get_catalog", { provider: "codex", workspacePath: base.workspacePath });
      assert.equal(catalog.ok, true);
      const options = catalog.options as { provider: string; reviewers: { value: string; label: string }[] }[];
      assert.deepEqual(options.find((option) => option.provider === "codex")!.reviewers, [
        { value: "user", label: "User" }, { value: "auto-review", label: "Auto Review" },
      ]);
      const before = (await f.bundle.stores.session.listSessionSummaries()).length;
      for (const codexReviewer of ["unsupported", null, 1]) {
        const rejected = await parent(transport, "create_child", { ...base, requestId: randomUUID(), codexReviewer });
        assertRejected(rejected);
        assert.match(JSON.stringify(rejected), /codexReviewer|reviewer/i);
      }
      for (const provider of ["claude", "copilot", "opencode"]) {
        const rejected = await parent(transport, "create_child", { ...base, requestId: randomUUID(), provider, codexSandboxMode: undefined, codexReviewer: "auto-review" });
        assertRejected(rejected);
        assert.match(JSON.stringify(rejected), /Codex|reviewer/i);
      }
      assert.equal((await f.bundle.stores.session.listSessionSummaries()).length, before);
      assert.equal((await f.bundle.stores.session.listPendingSessionLifecycleOperations()).length, 0);
      for (const codexReviewer of ["auto-review", undefined, "user"] as const) {
        const request = { ...base, requestId: randomUUID(), ...(codexReviewer === undefined ? {} : { codexReviewer }) };
        const response = await parent(transport, "create_child", request);
        assert.equal(response.ok, true, JSON.stringify(response));
        const reviewer = codexReviewer ?? "user";
        const options = response.executionOptions as { codexReviewer: string; approvalMode: string };
        assert.equal(options.codexReviewer, reviewer);
        assert.equal(options.approvalMode, "on-request");
        const session = (await f.bundle.stores.session.getSession((response.session as { id: string }).id))!;
        assert.equal(session.codexReviewer, reviewer);
        assert.equal(session.approvalMode, "on-request");
        assert.deepEqual(await parent(transport === "mcp" ? "cli" : "mcp", "create_child", request), response);
        const countAfterCreation = (await f.bundle.stores.session.listSessionSummaries()).length;
        const changed = await parent(transport, "create_child", { ...request, codexReviewer: reviewer === "user" ? "auto-review" : "user" });
        assert.equal(changed.ok, false);
        assert.ok(changed.message);
        assert.equal((await f.bundle.stores.session.listSessionSummaries()).length, countAfterCreation);
        assert.equal((await f.bundle.stores.session.getSession(session.id))!.codexReviewer, reviewer);
        const requestId = randomUUID();
        const sent = await parent(transport, "enqueue", { target: target(session), requestId, message: "first assigned task", model: "deep", reasoningEffort: "high", approvalMode: "on-request", codexSandboxMode: "workspace-write" });
        assert.equal(sent.ok, true, JSON.stringify(sent));
        assert.equal((sent.receipt as SessionTurnQueueReceipt).accepted!.request.executionOptions.codexReviewer, reviewer);
        created.push({ session, reviewer, requestId });
      }
    }
    await f.reopen();
    for (const { session, reviewer, requestId } of created) {
      assert.equal((await f.bundle.stores.session.getSession(session.id))!.codexReviewer, reviewer);
      const dispatched = await f.dispatchNext(session);
      assert.deepEqual(dispatched.result, { state: "completed" });
      assert.equal(dispatched.executed.length, 1);
      assert.equal(dispatched.executed[0].provider, "codex");
      assert.equal(dispatched.executed[0].input.executionOptions.codexReviewer, reviewer);
      assert.equal(dispatched.executed[0].input.executionOptions.approvalMode, "on-request");
      assert.equal((await f.bundle.stores.queue.getReceipt(target(session), requestId))!.state, "completed");
      assert.equal((await f.bundle.stores.session.getSession(session.id))!.codexReviewer, reviewer);
    }
  } finally { await f.close(); }
});

// @test-value v2
// kind = "contract"
// claim = "親が方針と宛先catalogを読んで選ぶ単発Depth/権限は通常Turn受付だけへ反映され、共有方針は保存時のまま残る"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/926" }
// fault = "一度のenqueueで恒久方針が学習更新される、方針読取がcatalogを置き換える、単発指定が受付へ届かない"
// observable = "公開方針read、宛先catalog、receipt実効設定、送信後の同じ方針本文"
// observation_boundary = "public-boundary"
// scope = "両入口→runtime→policy service/queue facade→実Storage Worker。catalogとHTTP交換はfixture"
// lifecycle = "permanent"
// distinction = "方針CRUD単体では通常送信の単発指定と恒久方針が分離されていることを検出できない"
// @end-test-value
test("parent reads policy and recipient catalog without persisting one-off enqueue choices", async () => {
  const f = await fixture();
  try {
    const parent = await f.endpoint(f.parent);
    const policy = { selectionCriteria: "Judgment-heavy tasks use deep; routine work uses fast.", executionGuidelines: "Select Depth and permissions per task.", contractRoutes: [{ name: "subscription", provider: "codex", conditions: "Use observed contract quota." }] };
    await parent("cli", "set_selection_policy", { policy });
    for (const transport of ["mcp", "cli"] as const) {
      assert.deepEqual((await parent(transport, "get_selection_policy", {})).policy, policy);
      const choices = await parent(transport, "get_catalog", { provider: f.child.provider, workspacePath: f.child.workspacePath });
      const catalog = choices.catalog as { workspacePath: string; providers: { models: { id: string; reasoningEfforts: string[] }[] }[] };
      assert.equal(catalog.workspacePath, f.child.workspacePath);
      assert.ok(catalog.providers[0].models.some((model) => model.id === "fast" && model.reasoningEfforts.includes("low")));
      const sent = await parent(transport, "enqueue", { target: target(f.child), requestId: randomUUID(), message: "routine task with one-off low Depth", model: "fast", reasoningEffort: "low", approvalMode: "never", codexSandboxMode: "read-only" });
      assert.equal(sent.ok, true);
      const effective = (sent.receipt as SessionTurnQueueReceipt).accepted!.request.executionOptions;
      assert.equal(effective.model, "fast"); assert.equal(effective.reasoningEffort, "low"); assert.equal(effective.codexSandboxMode, "read-only");
      assert.deepEqual((await parent(transport, "get_selection_policy", {})).policy, policy);
    }
  } finally { await f.close(); }
});

// @test-value v2
// kind = "contract"
// claim = "MCPとCLIは保存関係から送信方向を判定し、必須設定・宛先Model/Depth・Provider権限・Reviewer整合を検証して不正受付を作らない"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/936" }
// fault = "親送信の省略や無効組合せを受付する、子報告の省略を拒否する、片入口だけ設定を落とす、Reviewerを自動降格する"
// observable = "両公開入口の成功receiptと実効設定、理由付きeffect noneと保存receipt不存在、宛先Provider/Workspaceとcatalog options"
// observation_boundary = "public-boundary"
// scope = "SDK MCP/bound CLI→runtime binding→application→queue facade→実Storage Worker、Provider catalogとHTTP交換はfixture"
// lifecycle = "permanent"
// impact = "親子依頼が誤ったモデルや権限で実行される"
// distinction = "schema/typecheckでは実送信方向や省略解決後の整合と両入口の保存まで確認できない"
// @end-test-value
test("enqueue settings validate both directions and all Provider options through MCP and CLI", async () => {
  for (const provider of ["codex", "copilot", "claude", "opencode"]) {
    const f = await fixture(provider);
    try {
      const parent = await f.endpoint(f.parent), child = await f.endpoint(f.child);
      const authority = { approvalMode: "on-request", ...(provider === "codex" ? { codexSandboxMode: "workspace-write" } : {}) };
      for (const transport of ["cli", "mcp"] as const) {
        const read = await parent(transport, "get", { target: target(f.child) });
        const recipient = read.session as { provider: string; workspacePath: string };
        assert.equal(recipient.provider, provider); assert.equal(recipient.workspacePath, f.child.workspacePath);
        const choices = await parent(transport, "get_catalog", { provider: recipient.provider, workspacePath: recipient.workspacePath });
        assert.equal(choices.ok, true);
        assert.equal((choices.catalog as { workspacePath: string }).workspacePath, f.child.workspacePath);
        const native = (choices.options as { provider: string; approvalModes: { value: string }[]; sandboxModes: { value: string }[] }[])[0];
        assert.equal(native.provider, provider);
        assert.ok(native.approvalModes.some((option) => option.value === "never"));
        assert.equal(native.sandboxModes.some((option) => option.value === "read-only"), provider === "codex");
        if (provider !== "codex") assert.deepEqual(native.sandboxModes, []);
        const overrides = { approvalMode: "never", ...(provider === "codex" ? { codexSandboxMode: "read-only" } : {}) };
        const request = { target: target(f.child), requestId: randomUUID(), message: "do work", ...overrides, model: "plain", reasoningEffort: "" };
        const sent = await parent(transport, "enqueue", request);
        assert.equal(sent.ok, true);
        const options = (sent.receipt as SessionTurnQueueReceipt).accepted!.request.executionOptions;
        assert.deepEqual(options, { ...captureSessionExecutionOptions(f.child), ...overrides, model: "plain", reasoningEffort: "" });
        assert.deepEqual(captureSessionExecutionOptions((await f.bundle.stores.session.getSession(f.child.id))!), captureSessionExecutionOptions(f.child));
        const report = await child(transport, "enqueue", { target: target(f.parent), requestId: randomUUID(), message: "report", ...authority });
        assert.equal(report.ok, true);
        assert.equal((report.receipt as SessionTurnQueueReceipt).accepted!.request.executionOptions.model, "deep");
        const selected = await child(transport, "enqueue", { target: target(f.parent), requestId: randomUUID(), message: "report requiring another model", ...overrides, model: "fast", reasoningEffort: "low" });
        assert.equal(selected.ok, true);
        assert.deepEqual((selected.receipt as SessionTurnQueueReceipt).accepted!.request.executionOptions,
          { ...captureSessionExecutionOptions(f.parent), ...overrides, model: "fast", reasoningEffort: "low" });
        const invalid = [
          { model: undefined }, { reasoningEffort: undefined }, { approvalMode: undefined },
          { model: "missing" }, { reasoningEffort: "high" },
          { approvalMode: provider === "claude" ? "untrusted" : "plan" },
          provider === "codex" ? { codexSandboxMode: undefined } : { codexSandboxMode: "workspace-write" },
        ];
        for (const patch of invalid) {
          const body = JSON.parse(JSON.stringify({ ...request, requestId: randomUUID(), ...patch }));
          const rejected = await parent(transport, "enqueue", body);
          assertRejected(rejected);
          assert.equal(await f.bundle.stores.queue.getReceipt(target(f.child), body.requestId), null);
        }
        for (const patch of [{ model: "fast" }, { reasoningEffort: "low" }, { approvalMode: undefined }]) {
          const body = JSON.parse(JSON.stringify({ target: target(f.parent), requestId: randomUUID(), message: "report", ...authority, ...patch }));
          const rejected = await child(transport, "enqueue", body);
          assertRejected(rejected);
          assert.equal(await f.bundle.stores.queue.getReceipt(target(f.parent), body.requestId), null);
        }
      }
      if (provider === "claude") {
        await f.bundle.stores.session.updateSession({ ...f.child, codexReviewer: "auto-review" });
        for (const transport of ["cli", "mcp"] as const) {
          const id = randomUUID();
          const rejected = await parent(transport, "enqueue", { target: target(f.child), requestId: id, message: "work", model: "deep", reasoningEffort: "high", approvalMode: "accept-edits" });
          assert.equal(rejected.effect, "none"); assert.match(String(rejected.message), /reviewer/);
          assert.equal(await f.bundle.stores.queue.getReceipt(target(f.child), id), null);
        }
        assert.equal((await f.bundle.stores.session.getSession(f.child.id))!.codexReviewer, "auto-review");
      }
    } finally { await f.close(); }
  }
});

// @test-value v2
// kind = "contract"
// claim = "即時・遅延の受付設定は再起動・保存設定変更後も固定され、同UUID再送は元受付を返し明示設定変更を拒否する"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/936" }
// fault = "再送やdispatchで省略値を再解決する、明示/省略の変更を許可する、遅延保存で設定を失う、過去受付を読めなくする"
// observable = "両入口のreceipt ID・accepted設定、再起動後claimの設定、競合effect none、保存Session設定、指定情報のない既存受付read"
// observation_boundary = "public-boundary"
// scope = "SDK MCP/bound CLI→通常キュー受付lock→Storage Worker再起動→dispatch claim"
// lifecycle = "permanent"
// impact = "依頼の重複実行や待機中にModel・実行権限が変質する"
// distinction = "単純な入力validationやqueue storage単体は受付時省略解決と公開再試行を検証しない"
// @end-test-value
test("enqueue freezes per-Turn settings across retries, delayed dispatch and restart", async () => {
  const f = await fixture();
  try {
    const child = await f.endpoint(f.child), parent = await f.endpoint(f.parent);
    const authority = { approvalMode: "never", codexSandboxMode: "read-only" };
    const accepted: { body: Record<string, unknown>; receipt: SessionTurnQueueReceipt }[] = [];
    for (const deliveryTiming of ["immediate", "after_source_turn"]) {
      const body = { target: target(f.parent), requestId: randomUUID(), message: "report", ...authority, deliveryTiming };
      const replies = await Promise.all([child("cli", "enqueue", body), child("mcp", "enqueue", body)]);
      assert.equal(replies[0].ok, true); assert.deepEqual(replies[0], replies[1]);
      accepted.push({ body, receipt: replies[0].receipt as SessionTurnQueueReceipt });
    }
    const saved = captureSessionExecutionOptions(f.parent);
    assert.deepEqual(captureSessionExecutionOptions((await f.bundle.stores.session.getSession(f.parent.id))!), saved);
    await f.bundle.stores.session.updateSession({ ...f.parent, model: "fast", reasoningEffort: "low", approvalMode: "untrusted", codexSandboxMode: "danger-full-access" });
    await f.reopen();
    for (const { body, receipt } of accepted) {
      for (const transport of ["cli", "mcp"] as const) {
        const retry = await child(transport, "enqueue", body);
        assert.equal(retry.ok, true); assert.deepEqual((retry.receipt as SessionTurnQueueReceipt).accepted, receipt.accepted);
        const recovered = await child(transport, "get_receipt", { target: target(f.parent), requestId: body.requestId });
        assert.equal((recovered.receipt as SessionTurnQueueReceipt).id, receipt.id);
        for (const patch of [{ model: "deep" }, { reasoningEffort: "high" }, { approvalMode: "on-request" }, { codexSandboxMode: "workspace-write" }, { deliveryTiming: deliveryTimingOther(String(body.deliveryTiming)) }, { message: "different" }]) {
          const rejected = await child(transport, "enqueue", { ...body, ...patch });
          assert.equal(rejected.ok, false); assert.equal(rejected.effect, "none");
        }
      }
    }
    const rows = await f.bundle.stores.queue.listReceipts(target(f.parent));
    assert.equal(rows.receipts.length, 2);
    const immediate = await f.bundle.stores.queue.claimNext(target(f.parent));
    assert.equal(immediate!.id, accepted[0].receipt.id);
    await f.bundle.stores.queue.settle(target(f.parent), immediate!.id, "completed");
    assert.equal(await f.bundle.stores.queue.claimNext(target(f.parent)), null);
    await f.bundle.stores.turn.updateSessionTurn(Number(f.sourceTurns.get(f.child.id)), { sessionId: f.child.id, phase: "completed", createdAt: new Date().toISOString(),
      provider: "codex", model: "deep", reasoningEffort: "high", approvalMode: "on-request", threadId: "", errorMessage: "" });
    const delayed = await f.bundle.stores.queue.claimNext(target(f.parent));
    assert.equal(delayed!.id, accepted[1].receipt.id);
    for (const receipt of [immediate!, delayed!]) {
      assert.deepEqual(receipt.dispatched!.request.executionOptions, { ...saved, ...authority });
    }
    const changed = await f.bundle.stores.session.getSession(f.parent.id);
    assert.equal(changed!.model, "fast"); assert.equal(changed!.approvalMode, "untrusted"); assert.equal(changed!.codexSandboxMode, "danger-full-access");
    const legacyId = randomUUID();
    await f.bundle.stores.queue.enqueue(target(f.child), { request: { clientRequestId: legacyId, userMessage: "legacy", submitSource: "composer", executionOptions: saved },
      provider: "codex", workspacePath: f.child.workspacePath, attachments: [], origin: { kind: "session", actorKind: "main", actorSessionId: f.parent.id,
        actorIncarnationId: getSessionIncarnationId(f.parent), actorTurnId: f.sourceTurns.get(f.parent.id)!, operation: "send", targetSessionId: f.child.id, targetIncarnationId: getSessionIncarnationId(f.child) } });
    for (const transport of ["cli", "mcp"] as const) {
      const read = await parent(transport, "get_receipt", { target: target(f.child), requestId: legacyId });
      assert.equal(read.ok, true); assert.equal((read.receipt as SessionTurnQueueReceipt).accepted!.origin!.requestedExecutionOptions, undefined);
    }
  } finally { await f.close(); }
});

function deliveryTimingOther(timing: string) { return timing === "immediate" ? "after_source_turn" : "immediate"; }

// @test-value v2
// kind = "contract"
// claim = "Depth候補のある親のDefaultを子の報告がそのまま継承し、MCP/CLIの保存受付と次Turnへのdispatchで空文字を保つ"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/941; docs/design/model-catalog.md" }
// fault = "Defaultを不正Depthとして拒否するか具体的Depthへ置換する、または不正Depth・必須権限欠落まで許可する"
// observable = "公開両入口のreceipt設定、再起動後dispatch requestの空Depth、理由付き拒否と未作成receipt"
// observation_boundary = "public-boundary"
// scope = "Codex/OpenCode/Claudeのbound MCP/CLI→application→queue facade→実Storage Worker、catalog fixture"
// lifecycle = "permanent"
// impact = "Default利用中の親へ子が完了報告できず作業が停止する"
// distinction = "schemaや具象Depthの既存testでは空文字の継承・具体候補validation・保存dispatchの接続を検証しない"
// @end-test-value
test("child reports inherit provider Default depth through acceptance and dispatch", async () => {
  for (const provider of ["codex", "opencode", "claude"]) {
    const f = await fixture(provider);
    try {
      await f.bundle.stores.session.updateSession({ ...f.parent, reasoningEffort: "" });
      const child = await f.endpoint(f.child);
      const authority = { approvalMode: "on-request", ...(provider === "codex" ? { codexSandboxMode: "workspace-write" } : {}) };
      const ids: string[] = [];
      for (const transport of ["mcp", "cli"] as const) {
        const body = { target: target(f.parent), requestId: randomUUID(), message: "completed", ...authority };
        const sent = await child(transport, "enqueue", body);
        assert.equal(sent.ok, true, JSON.stringify(sent));
        const receipt = sent.receipt as SessionTurnQueueReceipt;
        ids.push(receipt.id);
        assert.equal(receipt.accepted!.request.executionOptions.model, "deep");
        assert.equal(receipt.accepted!.request.executionOptions.reasoningEffort, "");
        for (const patch of [{ reasoningEffort: "low" }, { approvalMode: undefined }]) {
          const invalid = JSON.parse(JSON.stringify({ ...body, ...patch, requestId: randomUUID() }));
          assertRejected(await child(transport, "enqueue", invalid));
          assert.equal(await f.bundle.stores.queue.getReceipt(target(f.parent), invalid.requestId), null);
        }
      }
      await f.reopen();
      for (const id of ids) {
        const dispatch = await f.bundle.stores.queue.claimNext(target(f.parent));
        assert.equal(dispatch!.id, id);
        assert.equal(dispatch!.dispatched!.request.executionOptions.reasoningEffort, "");
        await f.bundle.stores.queue.settle(target(f.parent), id, "completed");
      }
      assert.equal((await f.bundle.stores.session.getSession(f.parent.id))!.reasoningEffort, "");
    } finally { await f.close(); }
  }
});

function assertRejected(result: Record<string, unknown>) {
  if (result.isError === true) {
    // SDK-level schema validation returns text rather than application structuredContent.
    assert.match(JSON.stringify(result.content), /[Ii]nvalid|[Rr]equired/);
  } else {
    assert.equal(result.ok, false); assert.equal(result.effect, "none"); assert.ok(result.message);
  }
}
