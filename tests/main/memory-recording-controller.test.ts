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
  const authority = () => ({ userId: "local-user" as const, characterId: "character", allowedProjectIds: ["project"] });
  const runtime = new BackgroundProductionRuntime({ executions, runAgent: async (input) => {
    agents.push(input); if (failAgent) throw new Error("Agent failed"); await new Promise<void>((done) => releases.push(done));
  }, getAppSettings: () => settings, getModelCatalog: async () => {
    await catalogGate;
    if (failCatalog) throw new Error("catalog unavailable");
    return { providers: [{ id: "claude", label: "Claude", defaultModelId: "test", defaultReasoningEffort: "",
      models: [{ id: "test", label: "Test", reasoningEfforts: [] }] }] };
  }, captureSource: capture, resolveAuthority: authority,
    sourceKinds: { "character-memory": ["main", "auxiliary"], "target-memory": ["main", "auxiliary"] } });
  const controller = new MemoryRecordingController({ runtime, captureSource: capture, getSettings: () => settings,
    resolveAuthority: authority, clock, onError: (error) => errors.push(error) });
  runtime.start(); controller.start();
  function source(kind: "main" | "auxiliary", id: string) {
    const session = { ...buildNewSession({ taskTitle: id, workspaceLabel: "fixture", workspacePath: "C:/fixture", branch: "test",
      characterId: "character", character: "Character", characterIconPath: "", characterThemeColors: { main: "#123456", sub: "#abcdef" }, approvalMode: "on-request" }),
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
    setFailAgent(value: boolean) { failAgent = value; }, setFailCatalog(value: boolean) { failCatalog = value; },
    blockCatalog() { let release!: () => void; catalogGate = new Promise<void>((done) => { release = done; }); return () => { catalogGate = undefined; release(); }; },
    async advance(ms: number) { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback(); } await settle(); },
    async close() { runtime.stop(); for (const release of releases) release(); await settle(); } };
}

// @test-value v2
// kind = "contract"
// claim = "実保存Turnの件数で発火し、同名Mainと各Auxiliary・二用途の位置と並行bindingと固定範囲を分離する"
// oracle = { type = "contract", ref = "docs/design/background-execution.md#memoryの自動発火と開始位置" }
// fault = "ID差を件数にするか、用途や会話を混ぜるか、先行Agent完了まで次範囲を待たせる"
// observable = "共通prepare/runOnceを経たAgentの件数・processing/history・binding ID"
// observation_boundary = "consumer"
// scope = "Memory controller with real production runtime and execution service, fake source and Agent"
// lifecycle = "permanent"
// @end-test-value
test("実件数で発火しownerと用途を分離して先行Agentと並行開始する", async () => {
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
    await settle(); assert.equal(f.agents.length, 12);
    assert.equal(new Set(f.agents.map((agent) => agent.binding.bindingId)).size, 12);
    assert.deepEqual(f.agents.slice(0, 6).map((agent) => agent.scope), fixed);
    for (const agent of f.agents.slice(6)) {
      assert.deepEqual(agent.scope.processing, { afterTurnId: 100, throughTurnId: 900 });
      assert.equal(agent.scope.memoryTargets.some((target) => target.owner === "user"), false);
      assert.ok(agent.userInput.includes("edited"));
    }
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

// @test-value v2
// kind = "contract"
// claim = "端数の連続idleを会話再開で解除し、設定変更で未開始条件だけを再評価する"
// oracle = { type = "contract", ref = "docs/design/background-execution.md#memoryの自動発火と開始位置" }
// fault = "会話再開前のidle時間を流用するか、設定変更で開始済み範囲を再送する"
// observable = "fake clockでのAgent開始数・タイマー数・processing範囲"
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
    assert.equal(f.agents.length, 3);
    assert.deepEqual(f.agents[2].scope.processing, { afterTurnId: 10, throughTurnId: 80 });
    assert.ok(f.agents[2].userInput.includes("new body"));
    assert.ok(f.agents[0].userInput.includes("edited"));
    f.controller.forget("main", "idle"); assert.equal(f.timers.size, 0);
  } finally { await f.close(); }
});

// @test-value v2
// kind = "contract"
// claim = "prepareとbeginの失敗で位置を進めず、Agent失敗後は戻さず、停止再開で過去と初回通知を区別する"
// oracle = { type = "contract", ref = "docs/design/background-execution.md#memoryの自動発火と開始位置" }
// fault = "準備時に位置を進めるか、Agent失敗を再送するか、再起動時に過去を処理し最初の通知を捨てる"
// observable = "失敗後と再起動後のAgent開始件数・processing位置・timer解放"
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
    for (const agent of f.agents) assert.deepEqual(agent.scope.processing, { afterTurnId: 5, throughTurnId: 50 });
    f.runtime.publish({ kind: "settings_changed", settings: f.settings }); await settle(); assert.equal(f.agents.length, 2);
    f.runtime.stop(); assert.equal(f.timers.size, 0); owner.add(100);
    f.runtime.start(); f.controller.start(); f.controller.start(); owner.terminal(200); await settle();
    assert.equal(f.agents.length, 4);
    for (const agent of f.agents.slice(2)) assert.deepEqual(agent.scope.processing, { afterTurnId: 100, throughTurnId: 200 });
    assert.equal(f.errors.length, 2);
  } finally { await f.close(); }
});
