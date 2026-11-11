import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { MemoryRecordingController } from "../../src-electron/memory/memory-recording-controller.js";
import { BackgroundProductionRuntime } from "../../src-electron/providers/background-production-runtime.js";
import { BackgroundExecutionService } from "../../src-electron/providers/background-execution-service.js";
import { AgentRuntimeBindingRegistry } from "../../src-electron/providers/agent-runtime-binding.js";
import { ProviderAgentRuntimeTurnCoordinator } from "../../src-electron/providers/provider-agent-runtime-turn-coordinator.js";
import type { BackgroundAgentInput } from "../../src-electron/providers/background-call-service.js";
import { buildNewSession } from "../../src-shared/session/session-state.js";
import type { BackgroundSourceRef, CapturedBackgroundSource } from "../../src-shared/session/background-source-snapshot.js";
import { normalizeAppSettings } from "../../src-shared/settings/provider-settings-state.js";

async function settle() { for (let i = 0; i < 12; i++) await setImmediate(); }
function setup() {
  let now = 0, failCatalog = false;
  let catalogGate: Promise<void> | undefined;
  let authorityGate: Promise<void> | undefined;
  const timers = new Map<ReturnType<typeof setTimeout>, { at: number; callback(): void }>();
  const clock = { now: () => now,
    setTimeout(callback: () => void, delay: number) {
      const timer = setTimeout(() => {}, 1_000_000); clearTimeout(timer);
      timers.set(timer, { at: now + delay, callback }); return timer;
    }, clearTimeout(timer: ReturnType<typeof setTimeout>) { timers.delete(timer); } };
  const settings = normalizeAppSettings({ codingProviderSettings: { claude: { enabled: true } } });
  for (const purpose of ["character-memory", "target-memory"] as const) settings.backgroundExecutionSettings[purpose] = {
    selection: { providerId: "claude", modelId: "test" }, instructionText: "edited" };
  const executions = new BackgroundExecutionService({ bindings: new AgentRuntimeBindingRegistry(), turns: new ProviderAgentRuntimeTurnCoordinator(), closeConnection() {} });
  const sources = new Map<string, CapturedBackgroundSource>();
  const agents: BackgroundAgentInput[] = [], releases: (() => void)[] = [], errors: unknown[] = [];
  let failAgent = false;
  const capture = async (source: BackgroundSourceRef) => structuredClone(sources.get(JSON.stringify([source.kind, source.sessionId])) ?? null);
  const authority = async (session: { characterId: string }) => {
    await authorityGate;
    return { userId: "local-user" as const, characterId: session.characterId, allowedProjectIds: ["project"] };
  };
  const runtime = new BackgroundProductionRuntime({ executions, onFailure: (failure) => errors.push(failure),
    onExecutionDiagnostic: (diagnostic) => errors.push(diagnostic), runAgent: async (input) => {
    agents.push(input); if (failAgent) throw new Error("Agent failed"); await new Promise<void>((done) => releases.push(done));
  }, getAppSettings: () => settings, getModelCatalog: async () => {
    await catalogGate;
    if (failCatalog) throw new Error("catalog unavailable");
    return { providers: [{ id: "claude", label: "Claude", defaultModelId: "test", defaultReasoningEffort: "",
      models: [{ id: "test", label: "Test", reasoningEfforts: [] }] }] };
  }, captureSource: capture, resolveAuthority: authority,
    sourceKinds: { "character-memory": ["main", "auxiliary"], "target-memory": ["main", "auxiliary"] } });
  const controller = new MemoryRecordingController({ runtime, captureSource: capture, getSettings: () => settings,
    resolveAuthority: authority, clock });
  runtime.start(); controller.start();
  function source(kind: "main" | "auxiliary", id: string, characterId = "character") {
    const session = { ...buildNewSession({ taskTitle: id, workspaceLabel: "fixture", workspacePath: "C:/fixture", branch: "test",
      characterId, character: "Character", characterIconPath: "", characterThemeColors: { main: "#123456", sub: "#abcdef" }, approvalMode: "on-request" }),
      id, incarnationId: `inc-${kind}-${id}`, messageCount: 3 };
    const ref: BackgroundSourceRef = kind === "main" ? { kind, sessionId: id, incarnationId: session.incarnationId }
      : { kind, sessionId: id, incarnationId: session.incarnationId, parent: { sessionId: "parent", incarnationId: "inc-parent" } };
    const turns: CapturedBackgroundSource["snapshot"]["turns"][number][] = [];
    const saved = { history: { source: { ...ref, ownerIdentity: `owner-${kind}-${id}` }, fromMessageSeq: 0, throughMessageSeq: 1 },
      snapshot: { session, ownerIdentity: `owner-${kind}-${id}`, turns } } satisfies CapturedBackgroundSource;
    sources.set(JSON.stringify([kind, id]), saved);
    function add(turnId: number, phase: "completed" | "failed" | "canceled" = "completed") {
      const seq = saved.history.throughMessageSeq + 2;
      saved.history.throughMessageSeq = seq;
      const turn = { id: turnId, sessionId: kind === "main" ? id : null,
        ...(kind === "auxiliary" ? { auxiliarySessionId: id } : {}), phase, completedAt: "2026-11-03T00:00:00.000Z", assistantMessageSeq: seq };
      turns.push(turn);
      return { kind: "terminal_saved" as const, source: ref, session,
        terminal: { turnId, sessionId: id, phase, assistantMessageSeq: seq, completedAt: turn.completedAt, threadId: "", errorMessage: "" } };
    }
    return { ref, session, saved, add,
      running(running: boolean) { runtime.publish({ kind: "run_state", source: ref, session, running }); },
      terminal(id: number, phase?: "completed" | "failed" | "canceled") { runtime.publish(add(id, phase)); } };
  }
  return { settings, runtime, controller, executions, source, agents, errors, timers,
    releaseAgents() { for (const release of releases.splice(0)) release(); },
    setFailAgent(value: boolean) { failAgent = value; }, setFailCatalog(value: boolean) { failCatalog = value; },
    blockCatalog() { let release!: () => void; catalogGate = new Promise<void>((done) => { release = done; }); return () => { catalogGate = undefined; release(); }; },
    blockAuthority() { let release!: () => void; authorityGate = new Promise<void>((done) => { release = done; }); return () => { authorityGate = undefined; release(); }; },
    async advance(ms: number) { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback(); } await settle(); },
    async close() { runtime.stop(); for (const release of releases) release(); await settle(); } };
}

// @test-value v2
// kind = "contract"
// claim = "非同期authority解決中に解放したsourceを実行せず、存続sourceは解決されたProject IDを管理targetへ渡す"
// oracle = { type = "contract", ref = "docs/design/background-execution.md#memoryの自動発火と開始位置" }
// fault = "未awaitのauthorityを使うか、source解放後の遅延結果で背景実行を開始する"
// observable = "実背景runtimeのAgent開始sourceとmemoryTargets、解放sourceの開始件数"
// observation_boundary = "consumer"
// scope = "Memory controller async authority and source lifecycle"
// lifecycle = "permanent"
// impact = "Project記憶管理が失敗するか削除済み会話から管理操作を開始する"
// distinction = "既存頻度testの即時authorityではDB Worker応答待ち中のsource解放を確認できない"
// @end-test-value
test("authority待機中のsource解放を守り正規Project targetを渡す", async () => {
  const f = setup();
  const release = f.blockAuthority();
  try {
    f.settings.memoryRecordingFrequencies = { "character-memory": { turnCount: 1, idleMinutes: 5 }, "target-memory": { turnCount: 1, idleMinutes: 5 } };
    const removed = f.source("main", "removed");
    const active = f.source("main", "active");
    removed.terminal(1); active.terminal(2); await settle();
    assert.equal(f.agents.length, 0);
    f.controller.forget("main", "removed");
    release(); await settle();
    assert.equal(f.errors.length, 0);
    assert.equal(f.agents.length, 2);
    assert.ok(f.agents.every((agent) => agent.scope.history.source.sessionId === "active"));
    const target = f.agents.find((agent) => agent.scope.purpose === "target-memory")!;
    assert.ok(target.scope.purpose === "target-memory");
    assert.deepEqual(target.scope.memoryTargets, [
      { owner: "character", scope: "character", character: { type: "id", id: "character" } },
      { owner: "project", scope: "project", project: { type: "id", id: "project" } },
    ]);
  } finally { release(); await f.close(); }
});

// @test-value v2
// kind = "contract"
// claim = "Character Memoryの管理targetと履歴sourceは実Main/AuxiliaryのCharacterに一致する"
// oracle = { type = "contract", ref = "docs/design/background-execution.md#memoryの登録本文と直接登録" }
// fault = "親CharacterをAuxiliaryの管理targetとして渡すか履歴sourceを親へ代用する"
// observable = "AgentのCharacter targetとhistory source"
// observation_boundary = "consumer"
// scope = "Memory controller through real background runtime with distinct Main/Auxiliary Characters"
// lifecycle = "permanent"
// impact = "別Characterの記憶へ管理操作を行うことを防ぐ"
// distinction = "型検査と単体入力組立てではcontrollerの実sourceからtargetへの対応を検証できない"
// @end-test-value
test("実Characterの管理targetと履歴sourceをMainとAuxiliaryで分ける", async () => {
  const f = setup();
  try {
    f.settings.memoryRecordingFrequencies = { "character-memory": { turnCount: 1, idleMinutes: 5 }, "target-memory": { turnCount: 1, idleMinutes: 5 } };
    const main = f.source("main", "parent", "main-character");
    const aux = f.source("auxiliary", "aux", "aux-character");
    main.terminal(10); aux.terminal(20); await settle();
    assert.equal(f.agents.length, 4);
    assert.equal(f.errors.length, 0);
    const memories = f.agents.filter((agent) => agent.scope.purpose === "character-memory");
    assert.equal(memories.length, 2);
    for (const agent of memories) {
      const isMain = agent.scope.history.source.kind === "main";
      const characterId = isMain ? "main-character" : "aux-character";
      assert.deepEqual(agent.scope.memoryTargets, [{ owner: "character", scope: "character", character: { type: "id", id: characterId } }]);
      assert.equal(agent.scope.history.source.sessionId, isMain ? "parent" : "aux");
    }
  } finally { await f.close(); }
});

// @test-value v2
// kind = "contract"
// claim = "実保存Turnの件数で発火し、同じsourceと用途は実行終了後に新Turnを集約し、別sourceと用途は独立する"
// oracle = { type = "contract", ref = "docs/design/background-execution.md#memoryの自動発火と開始位置" }
// fault = "ID差を件数にするか、同threadを重複実行するか、実行中の新Turnを捨てるか、別sourceまで待たせる"
// observable = "共通prepare/runOnceを経たAgent件数・history末尾・binding IDと最新本文"
// observation_boundary = "consumer"
// scope = "Memory controller with real production runtime and execution service, fake source and Agent"
// lifecycle = "permanent"
// @end-test-value
test("実件数で発火し同source用途の次回を集約し別source用途は並行する", async () => {
  const f = setup();
  try {
    f.settings.memoryRecordingFrequencies = { "character-memory": { turnCount: 3, idleMinutes: 5 }, "target-memory": { turnCount: 3, idleMinutes: 5 } };
    const owners = [f.source("main", "same"), f.source("auxiliary", "same"), f.source("auxiliary", "second")];
    for (const owner of owners) owner.running(true);
    await settle(); assert.equal(f.agents.length, 0);
    for (const owner of owners) { owner.terminal(10); owner.terminal(70, "failed"); }
    await settle(); assert.equal(f.agents.length, 0);
    for (const owner of owners) owner.terminal(100, "canceled");
    await settle(); assert.equal(f.agents.length, 6);
    const fixed = f.agents.map((agent) => structuredClone(agent.scope));
    for (const owner of owners) { owner.terminal(200); owner.terminal(800); owner.terminal(900); }
    await settle(); assert.equal(f.agents.length, 6);
    const independent = f.source("main", "independent");
    independent.terminal(10); independent.terminal(70); independent.terminal(100);
    await settle(); assert.equal(f.agents.length, 8);
    f.settings.backgroundExecutionSettings["target-memory"].instructionText = "latest body";
    f.releaseAgents(); await settle();
    assert.equal(f.agents.length, 14);
    assert.equal(new Set(f.agents.map((agent) => agent.binding.bindingId)).size, 14);
    assert.deepEqual(f.agents.slice(0, 6).map((agent) => agent.scope), fixed);
    for (const agent of f.agents.slice(8)) {
      assert.equal(agent.scope.history.throughMessageSeq, 13);
      assert.equal(agent.scope.memoryTargets.some((target) => target.owner === "user"), false);
      assert.ok(agent.userInput.includes(agent.scope.purpose === "target-memory" ? "latest body" : "edited"));
    }
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

// @test-value v2
// kind = "contract"
// claim = "端数の連続idleを会話再開で解除し、設定変更で未開始条件だけを再評価する"
// oracle = { type = "contract", ref = "docs/design/background-execution.md#memoryの自動発火と開始位置" }
// fault = "会話再開前のidle時間を流用するか、設定変更で開始済み範囲を再送する"
// observable = "fake clockでのAgent開始数・タイマー数・固定history末尾と本文"
// observation_boundary = "consumer"
// scope = "controller one-shot idle scheduling and settings events"
// lifecycle = "permanent"
// @end-test-value
test("連続idleと再開・設定変更を再評価し設定済み本文を固定する", async () => {
  const f = setup();
  try {
    const owner = f.source("main", "idle"); owner.terminal(10); await settle();
    await f.advance(299_000); assert.equal(f.agents.length, 0);
    const release = f.blockCatalog(); await f.advance(1_000); assert.equal(f.agents.length, 0);
    owner.running(true); await settle(); assert.equal(f.timers.size, 0);
    release(); await settle(); assert.equal(f.agents.length, 0);
    await f.advance(500_000); assert.equal(f.agents.length, 0);
    owner.running(false); await settle(); await f.advance(300_000); assert.equal(f.agents.length, 2);
    owner.terminal(80); await settle();
    f.settings.memoryRecordingFrequencies = { ...f.settings.memoryRecordingFrequencies, "target-memory": { turnCount: 1, idleMinutes: 5 } };
    f.settings.backgroundExecutionSettings["target-memory"].instructionText = "new body";
    f.runtime.publish({ kind: "settings_changed", settings: f.settings }); await settle();
    assert.equal(f.agents.length, 2);
    f.releaseAgents(); await settle();
    assert.equal(f.agents.length, 3);
    assert.equal(f.agents[2].scope.history.throughMessageSeq, 5);
    assert.ok(f.agents[2].userInput.includes("new body"));
    assert.ok(f.agents[0].userInput.includes("edited"));
    f.controller.forget("main", "idle"); assert.equal(f.timers.size, 0);
  } finally { await f.close(); }
});

// @test-value v2
// kind = "contract"
// claim = "prepareとbegin失敗で頻度境界を進めず、Agent失敗後の新Turnで再発火し、停止再開で過去と初回通知を区別する"
// oracle = { type = "contract", ref = "docs/design/background-execution.md#memoryの自動発火と開始位置" }
// fault = "準備時に頻度境界を進めるか、失敗だけで再送するか、新Turnを捨てるか、再起動時に過去を処理する"
// observable = "失敗後と再起動後のAgent開始件数・history末尾・timer解放"
// observation_boundary = "consumer"
// scope = "controller start position, preparation failures and subscription lifetime"
// lifecycle = "permanent"
// @end-test-value
test("開始前後の失敗と停止再開の位置を分け初回通知を保持する", async () => {
  const f = setup();
  try {
    f.settings.memoryRecordingFrequencies = { "character-memory": { turnCount: 1, idleMinutes: 5 }, "target-memory": { turnCount: 1, idleMinutes: 5 } };
    const owner = f.source("auxiliary", "aux"); owner.add(5);
    f.setFailCatalog(true); owner.terminal(50); await settle(); assert.equal(f.agents.length, 0);
    f.setFailCatalog(false); f.executions.stop();
    f.runtime.publish({ kind: "settings_changed", settings: f.settings }); await settle(); assert.equal(f.agents.length, 0);
    f.executions.start(); f.setFailAgent(true);
    f.runtime.publish({ kind: "settings_changed", settings: f.settings }); await settle(); assert.equal(f.agents.length, 2);
    for (const agent of f.agents) assert.equal(agent.scope.history.throughMessageSeq, 5);
    f.runtime.publish({ kind: "settings_changed", settings: f.settings }); await settle(); assert.equal(f.agents.length, 2);
    owner.terminal(80); await settle(); assert.equal(f.agents.length, 4);
    for (const agent of f.agents.slice(2)) assert.equal(agent.scope.history.throughMessageSeq, 7);
    f.runtime.stop(); assert.equal(f.timers.size, 0); owner.add(100);
    f.runtime.start(); f.controller.start(); f.controller.start(); owner.terminal(200); await settle();
    assert.equal(f.agents.length, 6);
    for (const agent of f.agents.slice(4)) assert.equal(agent.scope.history.throughMessageSeq, 11);
    assert.equal(f.errors.length, 10);
  } finally { await f.close(); }
});
