import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { runWithMateSessionCli } from "../../src-cli/session/withmate-session.js";
import { createWithMateSessionMcpServer } from "../../src-electron/platform/mcp/withmate-session-mcp.js";
import type { callWithMateMemoryRuntime, WithMateMemoryRuntimeConnection } from "../../src-electron/platform/mcp/withmate-memory-runtime-client.js";
import { SessionManagementApplication, SessionManagementError } from "../../src-electron/session/session-management-application.js";
import { SessionManagementRuntimeService } from "../../src-electron/session/session-management-runtime-service.js";
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
  const application = new SessionManagementApplication({
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
    directories: unused, updateMetadata: unused, cancelReceipt: unused, stopTurn: unused, readExecution: unused, createChild: unused, coordinate: unused,
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
    async reopen() { await service.close(); await bundle.client.close(); bundle = createV6StorageWorkerBundle(options); await bundle.initialize(); startQueue(); },
    async close() { for (const cleanup of cleanups) await cleanup(); await service.close(); await bundle.client.close(); await rm(directory, { recursive: true, force: true }); } };
}

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

function assertRejected(result: Record<string, unknown>) {
  if (result.isError === true) {
    // SDK-level schema validation returns text rather than application structuredContent.
    assert.match(JSON.stringify(result.content), /[Ii]nvalid|[Rr]equired/);
  } else {
    assert.equal(result.ok, false); assert.equal(result.effect, "none"); assert.ok(result.message);
  }
}
