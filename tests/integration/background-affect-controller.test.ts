import assert from "node:assert/strict";
import { test } from "node:test";
import { BackgroundAffectController } from "../../src-electron/character/background-affect-controller.js";
import { BackgroundProductionRuntime, type BackgroundRuntimeEvent } from "../../src-electron/providers/background-production-runtime.js";
import type { BackgroundAgentInput } from "../../src-electron/providers/background-call-service.js";
import { normalizeAppSettings } from "../../src-shared/settings/provider-settings-state.js";
import type { ModelCatalogSnapshot } from "../../src-shared/settings/model-catalog.js";
import { AFFECT_SCHEMA_VERSION } from "../../src-shared/character-affect/affect-contract.js";
import { backgroundHistoryFixture } from "../helpers/background-history-fixture.js";
import { SessionRuntimeFixture } from "../main/session-runtime-fixture.js";
import { ProviderTurnError, type ProviderCodingAdapter } from "../../src-electron/providers/provider-runtime.js";
import { captureSessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";
import { createDefaultSessionMemory } from "../../src-shared/memory/session-memory-state.js";

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
  const runtime = new BackgroundProductionRuntime({ executions: f.executions, runAgent, getAppSettings: () => settings,
    getModelCatalog: () => catalog, captureSource: (source) => f.worker.stores.session.captureBackgroundSource(source),
    resolveAuthority: () => ({ userId: "local-user", characterId: "character", allowedProjectIds: [] }),
    sourceKinds: { affect: ["main", "auxiliary"] } });
  const failures: unknown[] = [];
  const readMaterials: ConstructorParameters<typeof BackgroundAffectController>[0]["readMaterials"] = async () => ({
    characterDefinition: "definition", currentAffect: { schemaVersion: AFFECT_SCHEMA_VERSION, characterId: "character",
      userId: "local-user", sessionId: "main", evaluatedAt: time, layers: [], components: [] },
  });
  const deps = { runtime, captureSource: (source: Parameters<typeof f.worker.stores.session.captureBackgroundSource>[0]) =>
    f.worker.stores.session.captureBackgroundSource(source), readMaterials,
    onFailure: (_source: unknown, error: unknown) => { failures.push(error); } };
  const controller = new BackgroundAffectController(deps);
  function event(id: number, phase: "completed" | "failed" | "canceled" = "completed"): Extract<BackgroundRuntimeEvent, { kind: "terminal_saved" }> {
    f.db.prepare(`INSERT INTO session_turns_v6(id,session_id,phase,assistant_message_seq,started_at,completed_at,updated_at)
      VALUES (?,'main',?,1,?,?,?)`).run(id, phase, time, time, time);
    return { kind: "terminal_saved", session: f.sessions.get("main")!, source: { kind: "main", sessionId: "main", incarnationId: "inc-main" },
      terminal: { turnId: id, sessionId: "main", phase, assistantMessageSeq: 1, threadId: "", errorMessage: "", completedAt: time } };
  }
  return { ...f, runtime, controller, deps, failures, settings, event };
}

// @test-value v2
// kind = "contract"
// claim = "保存済み終端通知ごとに独立Affect実行を開始し、初回の新規Turnを捨てず過去を生成せず、実行中の設定・scopeを固定する"
// oracle = { type = "contract", ref = "docs/design/background-execution.md" }
// fault = "Mainの通知元を背景終了待ちにする、同用途を直列化する、初通知を初期化で消費する、または後続設定で実行中入力が変わる"
// observable = "実Workerのcaptureを通したAgentの処理範囲・選択・本文、通知直後の返却、並行Agent数"
// observation_boundary = "consumer"
// scope = "real production runtime and BackgroundCallService with saved Main terminal events and fake Agent"
// lifecycle = "permanent"
// distinction = "共通runtimeのprepare単体では用途controllerの初期位置と通知非待機・同用途並行を確認できない"
// @end-test-value
test("保存済み終端から同用途を並行開始し入力を固定する", async () => {
  const entered = gate(), release = gate();
  const agents: BackgroundAgentInput[] = [];
  const f = await fixture(async (agent) => {
    agents.push(agent);
    if (agents.length === 3) entered.resolve();
    await release.promise;
  });
  try {
    f.event(1);
    f.controller.start(); f.controller.start();
    for (const [id, phase] of [[2, "completed"], [3, "failed"], [4, "canceled"]] as const) {
      assert.equal(f.runtime.publish(f.event(id, phase)), undefined);
    }
    await entered.promise;
    assert.equal(agents.length, 3);
    assert.equal(agents.find((agent) => agent.scope.processing.throughTurnId === 2)!.scope.processing.afterTurnId, 1);
    assert.ok(agents.every((agent) => (agent.scope.processing.afterTurnId ?? 0) >= 1
      && (agent.scope.processing.afterTurnId ?? 0) < agent.scope.processing.throughTurnId));
    assert.deepEqual(agents.map((agent) => agent.scope.processing.throughTurnId).sort(), [2, 3, 4]);
    assert.equal(new Set(agents.map((agent) => agent.binding.bindingId)).size, 3);
    f.settings.backgroundExecutionSettings.affect = { selection: { providerId: "claude", modelId: "changed" }, instructionText: "changed" };
    f.runtime.publish({ kind: "settings_changed", settings: f.settings });
    assert.ok(agents.every((agent) => agent.selection.modelId === "test" && agent.userInput.includes("edited") && !agent.userInput.includes("changed")));
    assert.equal(f.failures.length, 0);
  } finally { release.resolve(); f.runtime.stop(); await f.close(); }
});

// @test-value v2
// kind = "contract"
// claim = "未設定・材料失敗は開始位置を進めず、source解放は遅延読取を無効にし、停止再購読後は最新の新規通知を処理する"
// oracle = { type = "contract", ref = "docs/design/background-execution.md" }
// fault = "空Affectで失敗を救済する、not_configuredで位置を進める、source解放後の遅延読取から実行する、または停止再購読が重複・欠落する"
// observable = "Agent開始件数、onFailure、再購読後のprocessing範囲、source解放後の未実行"
// observation_boundary = "consumer"
// scope = "controller material/prepare failures and subscription/source lifetime using real capture and runtime"
// lifecycle = "permanent"
// distinction = "共通admission testは用途の材料取得と実開始位置や購読再開を所有しない"
// @end-test-value
test("開始前失敗と停止を区別し再開始で最初の新規通知を処理する", async () => {
  const started = gate(), failed = gate();
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
    f.deps.readMaterials = async () => { throw new Error("definition unavailable"); };
    f.deps.onFailure = (_source, error) => { f.failures.push(error); failed.resolve(); };
    f.runtime.publish(f.event(4)); await failed.promise;
    assert.equal(agents.length, 0);
    assert.match(String(f.failures[0]), /definition unavailable/);
    f.deps.readMaterials = async () => ({ characterDefinition: "definition", currentAffect: { schemaVersion: AFFECT_SCHEMA_VERSION,
      characterId: "character", userId: "local-user", sessionId: "main", evaluatedAt: time, layers: [], components: [] } });
    f.runtime.publish(f.event(5)); await started.promise;
    assert.deepEqual(agents[0]!.scope.processing, { afterTurnId: 2, throughTurnId: 5 });
    assert.equal(agents.length, 1);
  } finally { release.resolve(); f.runtime.stop(); await f.close(); }
});

// @test-value v2
// kind = "contract"
// claim = "実会話runtimeの保存済み終端だけがAffect実行へ届き、背景実行中でも通常turnは完了し保存拒否は発火しない"
// oracle = { type = "contract", ref = "docs/design/background-execution.md" }
// fault = "終端保存と用途controllerの接続を欠落するか、背景完了を待つか、保存失敗を正常な終端通知として扱う"
// observable = "real Workerの保存phase、Agent処理throughTurnId、背景gate未解放時の主会話返却、保存拒否後のAgent件数"
// observation_boundary = "consumer"
// scope = "SessionRuntimeService terminal persistence through production runtime/controller/prepare/runOnce with fake foreground adapter and background Agent"
// lifecycle = "permanent"
// distinction = "Session通知単体とcontroller手動publish単体の間にある接続を、一時DBの保存事実をoracleとして検証する"
// @end-test-value
test("実会話の終端保存からAffectを開始し主会話と保存失敗を分離する", { timeout: 10000 }, async () => {
  const release = gate(), entered = gate();
  const agents: BackgroundAgentInput[] = [];
  const f = await fixture(async (agent) => { agents.push(agent); if (agents.length === 3) entered.resolve(); await release.promise; });
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
    getSessionMemory: (session) => createDefaultSessionMemory(session), resolveProjectMemoryEntriesForPrompt: () => [],
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
    }
    await entered.promise;
    const saved = f.db.prepare("SELECT id, phase FROM session_turns_v6 ORDER BY id").all();
    assert.deepEqual(saved.map((turn) => turn.phase), ["completed", "failed", "canceled"]);
    assert.deepEqual(agents.map((agent) => agent.scope.processing.throughTurnId).sort(), saved.map((turn) => turn.id));
    rejectSave = true; phase = "completed";
    const session = (await f.worker.stores.session.getSession("main"))!;
    await assert.rejects(foreground.runSessionTurn("main", { userMessage: "reject", executionOptions: captureSessionExecutionOptions(session) }), /terminal save rejected/);
    await foreground.waitForPendingRuns();
    assert.equal(agents.length, 3);
  } finally { release.resolve(); f.runtime.stop(); await foreground.waitForPendingRuns(); await f.close(); }
});

// @test-value v2
// kind = "contract"
// claim = "同名Main/Auxiliaryの終端通知は各実sourceの初期位置・材料取得source・bindingで独立してAffectを開始する"
// oracle = { type = "contract", ref = "docs/design/background-execution.md#affect登録入力と会話owner" }
// fault = "controllerの位置をliteral IDだけで共有するか、Auxiliaryの材料取得へMain sourceを渡す"
// observable = "実Worker captureからprepareした二Agentのkind・ownerIdentity・processing位置と材料取得source、別binding"
// observation_boundary = "consumer"
// scope = "同名Main/Auxiliaryの用途controllerとproduction prepare/runOnce（材料とAgentはfake）"
// lifecycle = "permanent"
// distinction = "登録handlerのAuxiliary testはcontrollerのkind別位置とprepareへの実source転送を通らない"
// @end-test-value
test("同名MainとAuxiliaryのcontroller位置と実行を独立させる", { timeout: 10000 }, async () => {
  const entered = gate(), release = gate();
  const agents: BackgroundAgentInput[] = [];
  const f = await fixture(async (agent) => { agents.push(agent); if (agents.length === 2) entered.resolve(); await release.promise; });
  const materials: string[] = [];
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
    const readMaterials = f.deps.readMaterials;
    f.deps.readMaterials = async (session, source) => { materials.push(source.history.source.kind); return readMaterials(session, source); };
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
    assert.deepEqual(main.scope.processing, { afterTurnId: 1, throughTurnId: 3 });
    assert.deepEqual(auxiliary.scope.processing, { afterTurnId: 2, throughTurnId: 4 });
    assert.notEqual(main.scope.history.source.ownerIdentity, auxiliary.scope.history.source.ownerIdentity);
    assert.notEqual(main.binding.bindingId, auxiliary.binding.bindingId);
    assert.deepEqual(materials.sort(), ["auxiliary", "main"]);
    assert.deepEqual(f.failures, []);
  } finally { release.resolve(); f.runtime.stop(); await f.close(); }
});
