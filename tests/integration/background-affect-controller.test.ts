import assert from "node:assert/strict";
import { test } from "node:test";
import { BackgroundAffectController } from "../../src-electron/character/background-affect-controller.js";
import { BackgroundProductionRuntime, type BackgroundRuntimeEvent } from "../../src-electron/providers/background-production-runtime.js";
import type { BackgroundAgentInput } from "../../src-electron/providers/background-call-service.js";
import { normalizeAppSettings } from "../../src-shared/settings/provider-settings-state.js";
import type { ModelCatalogSnapshot } from "../../src-shared/settings/model-catalog.js";
import { backgroundHistoryFixture } from "../helpers/background-history-fixture.js";
import { SessionRuntimeFixture } from "../main/session-runtime-fixture.js";
import { ProviderTurnError, type ProviderCodingAdapter } from "../../src-electron/providers/provider-runtime.js";
import { captureSessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";

const time = "2026-11-03T00:00:00.000Z";
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(runAgent: (input: BackgroundAgentInput) => Promise<void>) {
  const f = await backgroundHistoryFixture();
  const settings = normalizeAppSettings({ codingProviderSettings: { claude: { enabled: true } },
    backgroundExecutionSettings: { affect: { selection: { providerId: "claude", modelId: "test" }, instructionText: "edited" } } });
  const catalog: ModelCatalogSnapshot = { providers: [{ id: "claude", label: "Claude", defaultModelId: "test",
    defaultReasoningEffort: "", models: [{ id: "test", label: "Test", reasoningEfforts: [] }] }] };
  const failures: unknown[] = [];
  const failureObserver = { onFailure: (error: unknown) => { failures.push(error); } };
  const runtime = new BackgroundProductionRuntime({ executions: f.executions, runAgent, getAppSettings: () => settings,
    onFailure: (failure) => failureObserver.onFailure(failure),
    onExecutionDiagnostic: (diagnostic) => failureObserver.onFailure(diagnostic),
    getModelCatalog: () => catalog, captureSource: (source) => f.worker.stores.session.captureBackgroundSource(source),
    resolveAuthority: () => ({ userId: "local-user", characterId: "character", allowedProjectIds: [] }),
    sourceKinds: { affect: ["main", "auxiliary"] } });
  const deps = { runtime, captureSource: (source: Parameters<typeof f.worker.stores.session.captureBackgroundSource>[0]) =>
    f.worker.stores.session.captureBackgroundSource(source) };
  const controller = new BackgroundAffectController(deps);
  function event(id: number, phase: "completed" | "failed" | "canceled" = "completed"): Extract<BackgroundRuntimeEvent, { kind: "terminal_saved" }> {
    f.db.prepare(`INSERT INTO session_turns_v6(id,session_id,phase,assistant_message_seq,started_at,completed_at,updated_at)
      VALUES (?,'main',?,1,?,?,?)`).run(id, phase, time, time, time);
    return { kind: "terminal_saved", session: f.sessions.get("main")!, source: { kind: "main", sessionId: "main", incarnationId: "inc-main" },
      terminal: { turnId: id, sessionId: "main", phase, assistantMessageSeq: 1, threadId: "", errorMessage: "", completedAt: time } };
  }
  return { ...f, runtime, controller, deps, failures, failureObserver, settings, event };
}

// @test-value v2
// kind = "contract"
// claim = "同sourceの終端通知を実行完了後の最新prepareへ集約し、初回通知を捨てず、実行中の設定・scopeを固定する"
// oracle = { type = "contract", ref = "docs/design/background-execution.md" }
// fault = "通知元を背景終了待ちにする、同threadを重複実行する、後続通知を捨てる、または次prepareへ最新指示を反映しない"
// observable = "実Worker captureを通したAgent開始数・選択・本文と通知直後の返却"
// observation_boundary = "consumer"
// scope = "real production runtime and BackgroundCallService with saved Main terminal events and fake Agent"
// lifecycle = "permanent"
// distinction = "共通runtime単体ではcontrollerの通知集約と次prepareの指示反映を検出できない"
// @end-test-value
test("保存済み終端を同source内で直列集約し次回の最新指示を取得する", async () => {
  const entered = gate(), next = gate(), release = gate();
  const agents: BackgroundAgentInput[] = [];
  const f = await fixture(async (agent) => {
    agents.push(agent);
    if (agents.length === 1) entered.resolve();
    if (agents.length === 2) next.resolve();
    await release.promise;
  });
  try {
    f.event(1);
    f.controller.start(); f.controller.start();
    assert.equal(f.runtime.publish(f.event(2)), undefined);
    await entered.promise;
    const original = structuredClone(agents[0]!.scope);
    for (const [id, phase] of [[3, "failed"], [4, "canceled"]] as const) assert.equal(f.runtime.publish(f.event(id, phase)), undefined);
    f.settings.backgroundExecutionSettings.affect.instructionText = "changed";
    f.runtime.publish({ kind: "settings_changed", settings: f.settings });
    assert.equal(agents.length, 1);
    assert.ok(agents[0]!.userInput.includes("edited") && !agents[0]!.userInput.includes("changed"));
    release.resolve(); await next.promise;
    assert.equal(agents.length, 2);
    assert.ok(agents[1]!.userInput.includes("changed"));
    assert.deepEqual(agents[0]!.scope, original);
    assert.notEqual(agents[0]!.binding.bindingId, agents[1]!.binding.bindingId);
    assert.equal(f.failures.length, 0);
  } finally { release.resolve(); f.runtime.stop(); await f.close(); }
});

// @test-value v2
// kind = "contract"
// claim = "Affect失敗は即時再送せず次の新Turnで同native文脈と失敗材料を渡し、runtime停止再開では待機Turnを復元しない"
// oracle = { type = "contract", ref = "docs/design/background-execution.md" }
// fault = "失敗でnative文脈を捨てるか即時retryし、または停止中の待機通知を新しいruntimeへ再送する"
// observable = "Agent開始数・continuation ID/threadId・失敗材料と停止再開後の開始タイミング"
// observation_boundary = "consumer"
// scope = "Affect controller through production runtime with saved terminals, failing Agent and blocked cleanup"
// lifecycle = "permanent"
// impact = "失敗までの背景文脈を利用しつつ新しい会話を取り込み、停止前の要求を意図せず再送しない"
// distinction = "共通call serviceの直接呼出ではcontrollerが新Turnを発火しpendingを停止で破棄する接続を確認できない"
// @end-test-value
test("失敗後の新Turnは文脈を継続し停止再開は待機通知を復元しない", { timeout: 10000 }, async () => {
  const failed = gate(), second = gate(), third = gate(), release = gate();
  const agents: BackgroundAgentInput[] = [];
  const f = await fixture(async (agent) => {
    agents.push(agent);
    if (agents.length === 1) { agent.continuation.onThreadId("affect-thread"); throw new Error("appraisal interrupted"); }
    if (agents.length === 2) { second.resolve(); await release.promise; }
    if (agents.length === 3) third.resolve();
  });
  f.failureObserver.onFailure = (failure) => { f.failures.push(failure); failed.resolve(); };
  try {
    f.controller.start(); f.runtime.publish(f.event(1)); await failed.promise;
    await new Promise((resolve) => setImmediate(resolve));
    f.runtime.publish({ kind: "settings_changed", settings: f.settings });
    assert.equal(agents.length, 1);
    f.runtime.publish(f.event(2)); await second.promise;
    assert.equal(agents[1]!.continuation.id, agents[0]!.continuation.id);
    assert.equal(agents[1]!.continuation.threadId, "affect-thread");
    assert.ok(agents[1]!.userInput.includes("appraisal interrupted"));
    f.runtime.publish(f.event(3));
    f.runtime.stop(); release.resolve();
    f.runtime.start(); f.controller.start();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(agents.length, 2);
    f.runtime.publish(f.event(4)); await third.promise;
    assert.equal(agents.length, 3);
    assert.notEqual(agents[2]!.continuation.id, agents[0]!.continuation.id);
    assert.equal(agents[2]!.continuation.threadId, null);
  } finally { release.resolve(); f.runtime.stop(); await f.close(); }
});

// @test-value v2
// kind = "contract"
// claim = "未設定では開始せず、source解放は遅延読取を無効にし、停止再購読後は最新の新規通知を処理する"
// oracle = { type = "contract", ref = "docs/design/background-execution.md" }
// fault = "未設定でAgentを開始する、source解放後の遅延読取から実行する、または停止再購読が重複・欠落する"
// observable = "Agent開始件数、再購読後のhistory source、source解放後の未実行"
// observation_boundary = "consumer"
// scope = "controller unconfigured preparation and subscription/source lifetime using real capture and runtime"
// lifecycle = "permanent"
// distinction = "共通admission testはcontrollerの実開始位置や購読再開を所有しない"
// @end-test-value
test("開始前失敗と停止を区別し再開始で最初の新規通知を処理する", async () => {
  const started = gate();
  const agents: BackgroundAgentInput[] = [];
  const f = await fixture(async (agent) => { agents.push(agent); started.resolve(); });
  const capture = f.deps.captureSource;
  const captured = gate(), release = gate();
  f.deps.captureSource = async (source) => { const result = await capture(source); captured.resolve(); await release.promise; return result; };
  try {
    f.event(1);
    f.controller.start();
    f.runtime.publish(f.event(2));
    await captured.promise;
    f.controller.forgetSource("main", "main");
    release.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(agents.length, 0);
    f.runtime.stop();
    f.runtime.start(); f.controller.start();
    f.deps.captureSource = capture;
    const prepare = f.runtime.prepare.bind(f.runtime), unconfigured = gate();
    f.runtime.prepare = async (input) => {
      const result = await prepare(input);
      if (result.status === "not_configured") unconfigured.resolve();
      return result;
    };
    delete f.settings.backgroundExecutionSettings.affect.selection;
    f.runtime.publish(f.event(3)); await unconfigured.promise;
    assert.equal(agents.length, 0);
    f.settings.backgroundExecutionSettings.affect.selection = { providerId: "claude", modelId: "test" };
    f.runtime.publish(f.event(4)); await started.promise;
    assert.equal(agents[0]!.scope.history.source.sessionId, "main");
    assert.equal(agents.length, 1);
  } finally { release.resolve(); f.runtime.stop(); await f.close(); }
});

// @test-value v2
// kind = "contract"
// claim = "実会話runtimeの保存済み終端だけがAffect実行へ届き、背景実行中でも通常turnは完了し保存拒否は発火しない"
// oracle = { type = "contract", ref = "docs/design/background-execution.md" }
// fault = "終端保存と用途controllerの接続を欠落するか、背景完了を待つか、保存失敗を正常な終端通知として扱う"
// observable = "real Workerの保存phase、Agent固定history末尾、背景gate未解放時の主会話返却、保存拒否後のAgent件数"
// observation_boundary = "consumer"
// scope = "SessionRuntimeService terminal persistence through production runtime/controller/prepare/runOnce with fake foreground adapter and background Agent"
// lifecycle = "permanent"
// distinction = "Session通知単体とcontroller手動publish単体の間にある接続を、一時DBの保存事実をoracleとして検証する"
// @end-test-value
test("実会話の終端保存からAffectを開始し主会話と保存失敗を分離する", { timeout: 10000 }, async () => {
  const release = gate(), entered = gate(), next = gate();
  const agents: BackgroundAgentInput[] = [];
  const f = await fixture(async (agent) => { agents.push(agent); entered.resolve(); if (agents.length === 2) next.resolve(); await release.promise; });
  let phase: "completed" | "failed" | "canceled" = "completed";
  let rejectSave = false;
  const adapter: ProviderCodingAdapter = {
    composePrompt: () => ({ systemBodyText: "", inputBodyText: "", logicalPrompt: { systemText: "", inputText: "", composedText: "" }, imagePaths: [], additionalDirectories: [] }),
    getProviderQuotaTelemetry: async () => null, invalidateSessionThread: async () => {}, invalidateAllSessionThreads: async () => {},
    runSessionTurn: async () => {
      const result = { threadId: null, assistantText: "saved answer", usage: null };
      if (phase !== "completed") throw new ProviderTurnError("provider stopped", result, phase === "canceled");
      return result;
    },
  };
  const foreground = new SessionRuntimeFixture({
    getSession: (id) => f.worker.stores.session.getSession(id),
    upsertSession: (session) => f.worker.stores.session.upsertSession(session),
    upsertTerminalSession: async (session, terminal) => {
      if (rejectSave) throw new Error("terminal save rejected");
      return f.worker.stores.session.upsertTerminalSession(session, terminal);
    },
    resolveComposerPreview: async () => ({ attachments: [], errors: [] }), getAppSettings: () => normalizeAppSettings({}),
    resolveProviderCatalog: () => {
      const provider = { id: "codex", label: "Codex", defaultModelId: "test", defaultReasoningEffort: "", models: [{ id: "test", label: "Test", reasoningEfforts: [] }] };
      return { snapshot: { providers: [provider] }, provider };
    },
    getProviderCodingAdapter: () => adapter,
    createSessionTurn: (turn) => f.worker.stores.turn.createSessionTurn(turn),
    updateSessionTurn: (id, turn) => f.worker.stores.turn.updateSessionTurn(id, turn),
    setLiveSessionRun() {}, getLiveSessionRun: () => null, waitForApprovalDecision: () => "approve",
    waitForElicitationResponse: () => ({ action: "cancel" }), setProviderQuotaTelemetry() {}, setSessionContextTelemetry() {},
    invalidateProviderSessionThread() {}, scheduleProviderQuotaTelemetryRefresh() {}, broadcastLiveSessionRun() {},
    resolvePendingApprovalRequest() {}, resolvePendingElicitationRequest() {},
    onBackgroundEvent: (event) => f.runtime.publish({ ...event, source: { kind: "main", sessionId: "main", incarnationId: "inc-main" } }),
  });
  try {
    f.controller.start();
    for (phase of ["completed", "failed", "canceled"] as const) {
      const session = (await f.worker.stores.session.getSession("main"))!;
      await foreground.runSessionTurn("main", { userMessage: "please", executionOptions: captureSessionExecutionOptions(session) });
      await foreground.waitForPendingRuns();
      if (phase === "completed") await entered.promise;
    }
    await entered.promise;
    const saved = f.db.prepare("SELECT id, phase FROM session_turns_v6 ORDER BY id").all();
    assert.deepEqual(saved.map((turn) => turn.phase), ["completed", "failed", "canceled"]);
    assert.equal(agents.length, 1);
    rejectSave = true; phase = "completed";
    const session = (await f.worker.stores.session.getSession("main"))!;
    await assert.rejects(foreground.runSessionTurn("main", { userMessage: "reject", executionOptions: captureSessionExecutionOptions(session) }), /terminal save rejected/);
    await foreground.waitForPendingRuns();
    assert.equal(agents.length, 1);
    release.resolve(); await next.promise;
    assert.equal(agents.length, 2);
    const lastSaved = f.db.prepare("SELECT MAX(assistant_message_seq) AS seq FROM session_turns_v6 WHERE completed_at IS NOT NULL").get()!;
    assert.ok(agents[1]!.scope.history.throughMessageSeq >= Number(lastSaved.seq));
  } finally { release.resolve(); f.runtime.stop(); await foreground.waitForPendingRuns(); await f.close(); }
});

// @test-value v2
// kind = "contract"
// claim = "同名Main/Auxiliaryの終端通知は各実sourceの初期位置・bindingで独立してAffectを開始する"
// oracle = { type = "contract", ref = "docs/design/background-execution.md#affect登録入力と会話owner" }
// fault = "controllerの位置をliteral IDだけで共有するか、AuxiliaryへMain sourceを渡す"
// observable = "実Worker captureからprepareした二Agentのkind・ownerIdentityと別binding"
// observation_boundary = "consumer"
// scope = "同名Main/Auxiliaryの用途controllerとproduction prepare/runOnce（Agentはfake）"
// lifecycle = "permanent"
// distinction = "登録handlerのAuxiliary testはcontrollerのkind別位置とprepareへの実source転送を通らない"
// @end-test-value
test("同名MainとAuxiliaryのcontroller位置と実行を独立させる", { timeout: 10000 }, async () => {
  const entered = gate(), release = gate();
  const agents: BackgroundAgentInput[] = [];
  const f = await fixture(async (agent) => { agents.push(agent); if (agents.length === 2) entered.resolve(); await release.promise; });
  try {
    f.db.prepare(`INSERT INTO sessions_v6(id,incarnation_id,title,state,provider_id,catalog_revision,model_id,approval_mode,
      character_id,character_snapshot_json,created_at,updated_at,last_active_at)
      VALUES ('aux','same-created-at','Same Main','active','codex',1,'test','on-request','character','{}','now','now','now')`).run();
    for (const [table, column] of [["session_messages_v6", "session_id"], ["auxiliary_session_messages", "auxiliary_session_id"]]) {
      f.db.prepare(`INSERT INTO ${table}(${column},seq,role,body,created_at) VALUES ('aux',1,'assistant',?,'now')`)
        .run(JSON.stringify({ role: "assistant", text: "saved answer" }));
    }
    for (const [id, column] of [[1, "session_id"], [2, "auxiliary_session_id"], [3, "session_id"], [4, "auxiliary_session_id"]]) {
      f.db.prepare(`INSERT INTO session_turns_v6(id,${column},phase,assistant_message_seq,started_at,completed_at,updated_at)
        VALUES (?,'aux','completed',1,?,?,?)`).run(id!, time, time, time);
    }
    f.controller.start();
    for (const [kind, turnId] of [["main", 3], ["auxiliary", 4]] as const) {
      const source = kind === "main" ? { kind, sessionId: "aux", incarnationId: "same-created-at" } : {
        kind, sessionId: "aux", incarnationId: "same-created-at", parent: { sessionId: "main", incarnationId: "inc-main" },
      };
      f.runtime.publish({ kind: "terminal_saved", source, session: f.sessions.get("aux")!, terminal: {
        turnId, sessionId: "aux", phase: "completed", assistantMessageSeq: 1, threadId: "", errorMessage: "", completedAt: time,
      } });
    }
    await entered.promise;
    const main = agents.find((agent) => agent.scope.history.source.kind === "main")!;
    const auxiliary = agents.find((agent) => agent.scope.history.source.kind === "auxiliary")!;
    assert.equal(main.scope.history.source.sessionId, "aux");
    assert.equal(auxiliary.scope.history.source.sessionId, "aux");
    assert.notEqual(main.scope.history.source.ownerIdentity, auxiliary.scope.history.source.ownerIdentity);
    assert.notEqual(main.binding.bindingId, auxiliary.binding.bindingId);
    assert.deepEqual(f.failures, []);
  } finally { release.resolve(); f.runtime.stop(); await f.close(); }
});
