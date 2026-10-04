import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import { it } from "node:test";
import { CopilotClient, RuntimeConnection, type CopilotSession, type SessionEvent } from "@github/copilot-sdk";

import { CopilotAdapter } from "../../src-electron/providers/copilot/copilot-adapter.js";
import { SessionRuntimeService } from "../../src-electron/session/session-runtime-service.js";
import { buildNewSession } from "../../src-shared/session/session-state.js";
import { captureSessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";
import { createDefaultSessionMemory } from "../../src-shared/memory/session-memory-state.js";
import { normalizeAppSettings } from "../../src-shared/settings/provider-settings-state.js";
import type { AuditLogEntry, LiveSessionRunState } from "../../src-shared/session/runtime-state.js";
import type { ModelCatalogProvider } from "../../src-shared/settings/model-catalog.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  assert.fail("lifecycle boundary was not reached");
}

class FakeSession {
  readonly sessionId = "preserved-thread";
  readonly listeners = new Set<(event: SessionEvent) => void>();
  readonly retainedListeners = new Set<(event: SessionEvent) => void>();
  readonly sends: ReturnType<typeof deferred<string>>[] = [];
  readonly abortReply = deferred<void>();
  readonly abortStarted = deferred<void>();
  readonly disconnectStarted = deferred<void>();
  readonly disconnectReply = deferred<void>();
  abortCalls = 0;
  disconnectCalls = 0;
  delayDisconnect = false;
  on(listener: (event: SessionEvent) => void) {
    this.listeners.add(listener);
    this.retainedListeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  send() {
    const reply = deferred<string>();
    this.sends.push(reply);
    return reply.promise;
  }
  abort() {
    this.abortCalls += 1;
    this.abortStarted.resolve();
    return this.abortReply.promise;
  }
  disconnect() {
    this.disconnectCalls += 1;
    this.disconnectStarted.resolve();
    if (this.delayDisconnect) return this.disconnectReply.promise;
    this.listeners.clear();
    return Promise.resolve();
  }
  emit(type: string, data: Record<string, unknown> = {}, late = false) {
    for (const listener of late ? this.retainedListeners : this.listeners) {
      listener({ type, data } as SessionEvent);
    }
  }
  closeTransport() {
    this.listeners.clear();
    for (const reply of this.sends) reply.reject(new Error("Connection is closed."));
    this.abortReply.reject(new Error("Connection is closed."));
    this.disconnectReply.reject(new Error("Connection is closed."));
    // Unused RPC gates are fixture controls, not dispatched requests.
    void this.abortReply.promise.catch(() => undefined);
    void this.disconnectReply.promise.catch(() => undefined);
  }
}

class FakeProcess extends ChildProcess {
  readonly exited = deferred<void>();
  autoExit = true;
  killAccepted = true;
  killCalls = 0;
  override kill() {
    this.killCalls += 1;
    if (!this.killAccepted) return false;
    if (this.autoExit) this.exit();
    return true;
  }
  exit() {
    Reflect.set(this, "exitCode", 0);
    this.emit("exit", 0, null);
    this.exited.resolve();
  }
}

class FakeClient {
  readonly child = new FakeProcess();
  cliProcess: FakeProcess | null = this.child;
  readonly sessions: FakeSession[] = [];
  readonly resumeIds: string[] = [];
  readonly stopStarted = deferred<void>();
  readonly stopReply = deferred<Error[]>();
  readonly forceStarted = deferred<void>();
  readonly forceReply = deferred<void>();
  stopMode: "normal" | "pending" | "reject" | "failed-kill" = "normal";
  forceMode: "normal" | "pending" | "reject" = "normal";
  stopCalls = 0;
  forceCalls = 0;
  deferRpcClosure = false;
  createSession() {
    const session = new FakeSession();
    this.sessions.push(session);
    return Promise.resolve(session);
  }
  resumeSession(id: string) {
    this.resumeIds.push(id);
    return this.createSession();
  }
  closeTransport() {
    if (this.deferRpcClosure) return;
    for (const session of this.sessions) session.closeTransport();
    this.stopReply.resolve([]);
  }
  async stop() {
    this.stopCalls += 1;
    this.stopStarted.resolve();
    if (this.stopMode === "pending") return this.stopReply.promise;
    if (this.stopMode === "reject") throw new Error("stop unavailable");
    this.closeTransport();
    this.cliProcess = null;
    if (this.stopMode === "failed-kill") {
      this.child.kill();
      return [new Error("kill was not accepted")];
    }
    this.child.kill();
    await this.child.exited.promise;
    return [];
  }
  async forceStop() {
    this.forceCalls += 1;
    this.forceStarted.resolve();
    if (this.forceMode === "pending") await this.forceReply.promise;
    if (this.forceMode === "reject") throw new Error("force stop unavailable");
    this.closeTransport();
    // Match SDK 1.0.11: drop the child handle even when kill fails, and do not
    // await child exit. Transport disposal and process exit are separate gates.
    const child = this.cliProcess;
    this.cliProcess = null;
    try { child?.kill(); } catch { /* SDK suppresses kill failures. */ }
  }
}

function fixture(options: { cancelGraceMs?: number; runtimeGraceMs?: number; realForceStop?: boolean } = {}) {
  let stored = buildNewSession({
    provider: "copilot", taskTitle: "cancel lifecycle", workspaceLabel: "fixture", workspacePath: process.cwd(),
    branch: "fixture", characterId: "fixture", character: "Fixture", characterIconPath: "",
    characterThemeColors: { main: "#000000", sub: "#ffffff" }, approvalMode: "on-request",
    model: "gpt-4.1", reasoningEffort: "high",
  });
  let live: LiveSessionRunState | null = null;
  const audits: AuditLogEntry[] = [];
  const clients: FakeClient[] = [];
  const logs: string[] = [];
  const catalog: ModelCatalogProvider = { id: "copilot", label: "Copilot", defaultModelId: "gpt-4.1", defaultReasoningEffort: "high",
    models: [{ id: "gpt-4.1", label: "GPT-4.1", reasoningEfforts: ["high"] }] };
  const adapter = new CopilotAdapter({ turnCancelGraceMs: options.cancelGraceMs ?? 0,
    sessionDisconnectTimeoutMs: 0, clientStopTimeoutMs: 0, log: (entry) => { logs.push(entry.message); } });
  adapter.composePrompt = () => ({ systemBodyText: "", inputBodyText: "input", logicalPrompt: {
    systemText: "", inputText: "input", composedText: "input" }, imagePaths: [], additionalDirectories: [] });
  const ports = adapter as unknown as {
    clients: Map<string, CopilotClient>;
    getClient(): { client: CopilotClient; clientKey: string };
  };
  ports.getClient = () => {
    const clientKey = "owned-client";
    let client = ports.clients.get(clientKey);
    if (!client) {
      const fake = new FakeClient();
      clients.push(fake);
      if (options.realForceStop) {
        // Instantiate the SDK without starting a process or contacting Copilot.
        const sdk = new CopilotClient({ connection: RuntimeConnection.forStdio({ path: "unused-cancel-fixture" }) });
        sdk.createSession = async () => await fake.createSession() as unknown as CopilotSession;
        sdk.resumeSession = async (id) => await fake.resumeSession(id) as unknown as CopilotSession;
        sdk.stop = async () => {
          const result = await fake.stop();
          Reflect.set(sdk, "cliProcess", fake.cliProcess);
          return result;
        };
        Reflect.set(sdk, "cliProcess", fake.child);
        Reflect.set(sdk, "connection", { dispose: () => fake.closeTransport() });
        const forceStop = sdk.forceStop.bind(sdk);
        sdk.forceStop = async () => { fake.forceCalls += 1; fake.forceStarted.resolve(); await forceStop(); };
        client = sdk;
      } else {
        client = fake as unknown as CopilotClient;
      }
      ports.clients.set(clientKey, client);
    }
    return { client, clientKey };
  };
  const service = new SessionRuntimeService({
    providerCancelGraceMs: options.runtimeGraceMs ?? 1000,
    getSession: () => stored,
    upsertSession: (next) => { stored = next; return next; },
    upsertTerminalSession: (next, commit) => {
      stored = next;
      const index = audits.findIndex((audit) => audit.id === commit.auditLogId);
      audits[index] = { ...audits[index], phase: commit.phase, errorMessage: commit.errorMessage };
      return next;
    },
    resolveComposerPreview: async () => ({ attachments: [], errors: [] }),
    getAppSettings: () => normalizeAppSettings({ codingProviderSettings: { copilot: { enabled: true } } }),
    resolveProviderCatalog: () => ({ snapshot: { revision: 1, providers: [catalog] }, provider: catalog }),
    getProviderCodingAdapter: () => adapter,
    getSessionMemory: (session) => createDefaultSessionMemory(session),
    resolveProjectMemoryEntriesForPrompt: () => [],
    createAuditLog: (entry) => { const audit = { id: audits.length + 1, ...entry }; audits.push(audit); return audit; },
    updateAuditLog: (id, entry) => { const index = audits.findIndex((audit) => audit.id === id); audits[index] = { id, ...entry }; },
    setLiveSessionRun: (_id, next) => { live = next; }, getLiveSessionRun: () => live,
    waitForApprovalDecision: () => "deny", waitForElicitationResponse: () => ({ action: "cancel" }),
    setProviderQuotaTelemetry() {}, setSessionContextTelemetry() {}, scheduleProviderQuotaTelemetryRefresh() {},
    invalidateProviderSessionThread: (_provider, id) => adapter.invalidateSessionThread(id),
    broadcastLiveSessionRun() {}, resolvePendingApprovalRequest() {}, resolvePendingElicitationRequest() {},
  });
  return {
    adapter, ports, service, clients, audits, logs,
    stored: () => stored, live: () => live,
    start: (message = "first") => service.runSessionTurn(stored.id, { userMessage: message, executionOptions: captureSessionExecutionOptions(stored) }),
    cancel: () => service.cancelRun(stored.id),
    current: async () => { await until(() => Boolean(clients.at(-1)?.sessions.at(-1)?.sends.length)); return clients.at(-1)!.sessions.at(-1)!; },
  };
}

// @test-value v2
// kind = "contract"
// claim = "send/abort応答未完了の取消はSDK停止応答・旧child実exit・RPC終了を個別に待ち、guard解放後に同じ会話をresumeする"
// oracle = { type = "contract", ref = "docs/adr/002-provider-turn-terminal-and-cancellation.md; Issue #782 A/B" }
// fault = "send応答待ちに滞留するか、停止中の旧接続と次Sendを重ねる"
// observable = "SDK停止応答/旧child exit/RPC終了を順に解放した時の実runtime Send拒否、live取消状態、送信件数、保存phaseとresume ID"
// observation_boundary = "public-boundary"
// scope = "SessionRuntimeService through CopilotAdapter to SDK transport boundary"
// lifecycle = "permanent"
// impact = "取消後の再送不能と同一workspaceへの二重副作用を防ぐ"
// distinction = "provider stub単体ではsend/abort待ちとcache cleanup寿命が観測できず、deferred統合testでのみ検出できる"
// @end-test-value
it("無応答send/abortを強制停止で収束し、停止完了まで次Sendを拒否する", { timeout: 5000 }, async () => {
  for (const pendingSend of [true, false]) {
    const f = fixture({ runtimeGraceMs: 0 });
    const first = f.start();
    const old = await f.current();
    const owner = f.clients[0];
    if (!pendingSend) old.sends[0].resolve("first");
    owner.stopMode = "pending";
    owner.forceMode = "pending";
    owner.child.autoExit = false;
    owner.deferRpcClosure = true;
    f.cancel(); f.cancel();
    if (!pendingSend) old.emit("session.error", { message: "Connection is closed." });
    await owner.forceStarted.promise;
    await first;
    assert.equal(old.abortCalls, 1);
    assert.equal(f.service.isRunInFlight(f.stored().id), true);
    assert.equal(f.live()?.cancellationState, "terminating");
    await assert.rejects(f.start("blocked"), /already running/);
    owner.forceReply.resolve();
    await until(() => owner.cliProcess === null);
    await assert.rejects(f.start("SDK replied but child alive"), /already running/);
    owner.child.exit();
    await assert.rejects(f.start("child exited but RPC pending"), /already running/);
    owner.deferRpcClosure = false;
    owner.closeTransport();
    await until(() => !f.service.isRunInFlight(f.stored().id));
    assert.equal(old.listeners.size, 0);
    assert.equal(f.audits[0].phase, "canceled");
    const next = f.start("next");
    await until(() => f.clients.length === 2);
    const fresh = await f.current();
    assert.notEqual(fresh, old);
    assert.deepEqual(f.clients[1].resumeIds, [old.sessionId]);
    old.emit("assistant.message", { content: "old late response", messageId: "old" }, true);
    old.emit("session.idle", {}, true);
    old.sends[0].resolve("late send"); old.abortReply.resolve();
    assert.equal(f.service.isRunInFlight(f.stored().id), true);
    fresh.sends[0].resolve("next");
    fresh.emit("assistant.message", { content: "next answer", messageId: "new" }); fresh.emit("session.idle");
    await next;
    assert.match(f.stored().messages.at(-1)!.text, /next answer/);
    assert.doesNotMatch(JSON.stringify(f.stored().messages), /old late response/);
    assert.equal(owner.stopCalls, 1); assert.equal(owner.forceCalls, 1);
  }
});

// @test-value v2
// kind = "contract"
// claim = "取消中のidle単独またはabort応答単独では次Sendを許可せず、両方とsend応答および所有接続停止後に解放する"
// oracle = { type = "contract", ref = "Issue #782 B; docs/design/session-run-lifecycle.md#Session-Run-Cancel" }
// fault = "idle先行やabort先行で未完了RPCを次turnへ持ち越す"
// observable = "runtime Send拒否、abort/stop件数、guard解除、SDK listener数"
// observation_boundary = "public-boundary"
// scope = "Copilot graceful cancellation order through Main runtime"
// lifecycle = "permanent"
// impact = "遅い旧abortによる次turn停止を防ぐ"
// distinction = "強制停止caseでは確認できない正常な応答順序の両向きをdeferredで固定する"
// @end-test-value
it("idleとabortの順序が逆でも全RPCと接続停止までguardを保持する", { timeout: 5000 }, async () => {
  for (const idleFirst of [true, false]) {
    const f = fixture({ cancelGraceMs: 1000 });
    const run = f.start(); const session = await f.current();
    f.cancel(); await session.abortStarted.promise;
    if (idleFirst) session.emit("session.idle"); else session.abortReply.resolve();
    await assert.rejects(f.start("blocked"), /already running/);
    if (idleFirst) session.abortReply.resolve(); else session.emit("session.idle");
    await assert.rejects(f.start("still blocked"), /already running/);
    session.sends[0].resolve("first");
    await run;
    assert.equal(f.service.isRunInFlight(f.stored().id), false);
    assert.equal(f.clients[0].forceCalls, 0);
    assert.equal(f.clients[0].stopCalls, 1);
    assert.equal(session.listeners.size, 0);
  }
});

// @test-value v2
// kind = "contract"
// claim = "取消のabort/disconnect失敗は成功に置換せずpartial本文・operation・raw traceと共に監査へ残す"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md#Error-Handling; Issue #782" }
// fault = "停止errorをcatchで消すか取得済みpartialを取消通知だけへ置換する"
// observable = "保存messages、canceled監査の本文/operation/raw/provider metadataとadapter log"
// observation_boundary = "public-boundary"
// scope = "Copilot cancellation partial result and runtime terminal persistence"
// lifecycle = "permanent"
// impact = "途中成果と実行監査を保護し停止失敗の診断を可能にする"
// distinction = "汎用runtime partial testはCopilot event変換と停止失敗のcatchを通らない"
// @end-test-value
it("停止失敗の詳細とpartial結果を取消の履歴・監査へ保持する", { timeout: 5000 }, async () => {
  const f = fixture(); const run = f.start(); const session = await f.current();
  session.sends[0].resolve("first");
  session.emit("assistant.message", { content: "partial answer", messageId: "partial" });
  session.emit("tool.execution_start", { toolCallId: "tool", toolName: "bash", arguments: { command: "echo partial" } });
  session.emit("tool.execution_complete", { toolCallId: "tool", success: true, result: { content: "partial" } });
  session.delayDisconnect = true;
  f.clients[0].stopMode = "reject";
  f.cancel(); await session.abortStarted.promise;
  session.abortReply.reject(new Error("abort unavailable"));
  await run;
  await until(() => f.audits[0].rawItemsJson.includes("tool.execution_complete"));
  assert.match(f.stored().messages.at(-1)!.text, /partial answer/);
  assert.equal(f.audits[0].phase, "canceled");
  assert.ok(f.audits[0].operations.some((operation) => operation.summary.includes("echo partial")));
  assert.match(f.audits[0].rawItemsJson, /tool.execution_complete/);
  assert.match(JSON.stringify(f.audits[0].providerMetadata), /abort unavailable/);
  assert.match(JSON.stringify(f.audits[0].providerMetadata), /session disconnect timed out/);
  assert.match(f.logs.join("\n"), /session disconnect timed out/);
  assert.match(f.logs.join("\n"), /stop unavailable/);
  assert.equal(f.clients[0].forceCalls, 1);
});

// @test-value v2
// kind = "contract"
// claim = "旧取消cleanupは捕捉ownerだけを停止し同一keyの新接続と無関係接続を停止しない"
// oracle = { type = "contract", ref = "Issue #782 cache ownership boundary; docs/design/session-run-lifecycle.md" }
// fault = "遅いcleanupがcacheを再取得して新clientまたは別Sessionを停止する"
// observable = "旧owner/新owner/無関係clientのstop件数とcache identity"
// observation_boundary = "component-behavior"
// scope = "Copilot captured cancellation owner across cache replacement"
// lifecycle = "permanent"
// impact = "別会話と再接続の実行を取消の巻き添えから保護する"
// distinction = "既存invalidation testと異なり実turnのCancelから遅延cleanupへ進める"
// @end-test-value
it("取消の遅いcleanupは同一keyの新clientと無関係clientに触れない", { timeout: 5000 }, async () => {
  const f = fixture(); const run = f.start(); const session = await f.current();
  const old = f.clients[0]; old.stopMode = "pending"; old.forceMode = "pending";
  f.cancel(); await old.forceStarted.promise;
  const fresh = new FakeClient(); const unrelated = new FakeClient();
  f.ports.clients.set("owned-client", fresh as unknown as CopilotClient);
  f.ports.clients.set("unrelated", unrelated as unknown as CopilotClient);
  old.forceReply.resolve(); await run;
  assert.equal(f.ports.clients.get("owned-client"), fresh);
  assert.equal(f.ports.clients.get("unrelated"), unrelated);
  assert.equal(fresh.stopCalls + fresh.forceCalls, 0);
  assert.equal(unrelated.stopCalls + unrelated.forceCalls, 0);
  assert.equal(session.listeners.size, 0);
});

// @test-value v2
// kind = "contract"
// claim = "SDKがkill失敗を無視してforceStopをresolveしても旧child実exitまでruntime guardを保持し停止失敗をlogへ残す"
// oracle = { type = "contract", ref = "docs/adr/002-provider-turn-terminal-and-cancellation.md; Issue #782" }
// fault = "SDKの接続切断と成功応答を旧childの停止証明に置換して再送する"
// observable = "kill false後の停止失敗log、runtime in-flight、Send拒否、捕捉した旧child exit後のguard解除"
// observation_boundary = "public-boundary"
// scope = "Real Copilot SDK forceStop without process startup through runtime terminating guard"
// lifecycle = "permanent"
// impact = "停止不能な旧処理と新処理の二重実行を防ぐ"
// distinction = "mockのみの停止成功testではSDKがkill falseを隠すこととstop後のhandle欠落を検証できない"
// @end-test-value
it("SDKがkill失敗を隠しても旧child実exitまでguardを維持する", { timeout: 5000 }, async () => {
  for (const stopMode of ["reject", "failed-kill"] as const) {
    const f = fixture({ runtimeGraceMs: 0, realForceStop: true }); const run = f.start(); const session = await f.current();
    const owner = f.clients[0]; owner.stopMode = stopMode; owner.child.killAccepted = false;
    f.cancel(); await run; await until(() => f.logs.some((message) => message.includes("kill request was not accepted")));
    assert.equal(owner.forceCalls, 1, "real SDK forceStop resolved despite the kill failure");
    assert.equal(owner.child.killCalls, 2, "adapter still signals the captured old child");
    assert.equal(f.service.isRunInFlight(f.stored().id), true);
    await assert.rejects(f.start("blocked"), /already running/);
    assert.equal(session.listeners.size, 0, "recovery does not require idle from a disconnected session");
    owner.child.exit();
    await until(() => !f.service.isRunInFlight(f.stored().id));
  }
});

// @test-value v2
// kind = "contract"
// claim = "取消していない長時間turnは応答を期限で打ち切らず正常完了後に同じSDK Sessionを再利用する"
// oracle = { type = "contract", ref = "docs/adr/002-provider-turn-terminal-and-cancellation.md; docs/design/provider-adapter.md#Thread-Management" }
// fault = "取消用deadlineを正常turnへ適用するか正常完了で接続を破棄する"
// observable = "SDK send/stop件数、runtime in-flight、再送時Session identityと保存本文"
// observation_boundary = "public-boundary"
// scope = "Copilot normal completion and connection reuse through runtime"
// lifecycle = "permanent"
// impact = "正常な長時間応答と会話継続を保護する"
// distinction = "helperのcache key検査では実turnに対するtimerの誤適用を検出できない"
// @end-test-value
it("正常turnには取消期限を適用せず、完了後はSessionを再利用する", { timeout: 5000 }, async () => {
  const f = fixture(); const first = f.start(); const session = await f.current();
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  assert.equal(f.service.isRunInFlight(f.stored().id), true);
  assert.equal(f.clients[0].stopCalls, 0);
  session.emit("assistant.message", { content: "first answer", messageId: "first" });
  session.emit("session.idle"); session.sends[0].resolve("first"); await first;
  const next = f.start("next"); await until(() => session.sends.length === 2);
  assert.equal(f.clients.length, 1); assert.equal(f.clients[0].sessions.length, 1);
  session.emit("assistant.message", { content: "second answer", messageId: "second" });
  session.sends[1].resolve("next"); session.emit("session.idle"); await next;
  assert.match(f.stored().messages.at(-1)!.text, /second answer/);
  assert.equal(f.clients[0].stopCalls, 0);
});
