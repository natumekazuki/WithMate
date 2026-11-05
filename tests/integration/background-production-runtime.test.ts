import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { BackgroundProductionRuntime, buildBackgroundExecutionScope, type BackgroundRuntimeEvent, type PrepareBackgroundCallInput } from "../../src-electron/providers/background-production-runtime.js";
import type { BackgroundAgentInput, BackgroundAgentPort } from "../../src-electron/providers/background-call-service.js";
import type { BackgroundFailureEvent } from "../../src-electron/providers/background-failure.js";
import { backgroundMemoryRegistrationHandlers, runBackgroundMemoryRegistration } from "../../src-electron/memory/background-memory-registration.js";
import { registerBackgroundAffect } from "../../src-electron/character/background-affect-registration.js";
import { runBackgroundAffectCall } from "../../src-electron/character/background-affect-call.js";
import { normalizeAppSettings } from "../../src-shared/settings/provider-settings-state.js";
import type { ModelCatalogSnapshot } from "../../src-shared/settings/model-catalog.js";
import { currentRuntimeTurnAdmissionState, assertRuntimeTurnAdmission } from "../../src-electron/platform/memory/runtime-turn-admission.js";
import { MEMORY_REGISTRATION_PRESETS } from "../../src-shared/memory-recording/memory-registration-input.js";
import { backgroundHistoryFixture, owner } from "../helpers/background-history-fixture.js";

type Fixture = Awaited<ReturnType<typeof backgroundHistoryFixture>>;
const sourceKinds = { "character-memory": ["main"], "target-memory": ["main"], affect: ["main"] } as const;
const targets = [{ owner: "user", scope: "global" },
  { owner: "character", scope: "character", character: { type: "id", id: "character" } }] as const;
const catalog: ModelCatalogSnapshot = { providers: [{ id: "claude", label: "Claude", defaultModelId: "test",
  defaultReasoningEffort: "", models: [{ id: "test", label: "Test", reasoningEfforts: [] }] }] };

function seed(f: Fixture) {
  f.db.prepare(`INSERT INTO session_turns_v6(id,session_id,phase,assistant_message_seq,started_at,completed_at,updated_at)
    VALUES (1,'main','completed',1,'2026-11-01T01:00:00.000Z','2026-11-01T01:00:00.000Z','now')`).run();
}
function setup(f: Fixture, runAgent: BackgroundAgentPort) {
  const settings = normalizeAppSettings({ codingProviderSettings: { claude: { enabled: true } } });
  for (const purpose of ["character-memory", "target-memory", "affect"] as const) {
    settings.backgroundExecutionSettings[purpose] = { selection: { providerId: "claude", modelId: "test" } };
  }
  const deps = { executions: f.executions, runAgent, getAppSettings: () => settings,
    getModelCatalog: async () => catalog,
    captureSource: f.worker.stores.session.captureBackgroundSource.bind(f.worker.stores.session),
    resolveAuthority: () => ({ userId: "local-user" as const, characterId: "character", allowedProjectIds: [] }), sourceKinds };
  const runtime = new BackgroundProductionRuntime(deps);
  const input: PrepareBackgroundCallInput = { purpose: "target-memory", source: { kind: "main", sessionId: "main", incarnationId: "inc-main" },
    session: f.sessions.get("main")!, memoryTargets: targets };
  return { runtime, deps, settings, input };
}
function project(f: Fixture, agent: BackgroundAgentInput) {
  const binding = { ...agent.binding, memoryRuntimeOwner: owner };
  return { ...binding, managedMcp: f.host.issue(binding, agent.handle, agent.signal) };
}
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

// @test-value v2
// kind = "contract"
// claim = "三用途の開始準備は共通Model・サービス無効設定で停止し、再有効化で保存選択のまま再開できる"
// oracle = { type = "contract", ref = "docs/design/background-execution.md#本番共通runtimeとprovider" }
// fault = "背景だけ無効設定を無視する、別Modelへfallbackする、または準備済み呼出しまで停止する"
// observable = "prepareのcode、catalog/capture回数、失敗診断、保存selectionと準備済み呼出しの完了"
// observation_boundary = "consumer"
// scope = "background shared model availability at preparation"
// lifecycle = "permanent"
// impact = "ユーザーが利用停止したModelへ背景の推論要求が送信される"
// distinction = "通常Sessionの受付検査では独立した背景prepare経路と準備済みcallの境界を検出できない"
// @end-test-value
test("Modelとサービスの無効化は三用途の次の準備に適用する", async () => {
  const f = await backgroundHistoryFixture();
  try {
    seed(f);
    let calls = 0, catalogReads = 0, captures = 0;
    const failures: BackgroundFailureEvent[] = [];
    const { deps, settings, input } = setup(f, () => { calls++; });
    settings.codingProviderSettings.opencode = { ...settings.codingProviderSettings.codex, enabled: true };
    const runtime = new BackgroundProductionRuntime({ ...deps,
      getModelCatalog: async () => { catalogReads++; return { providers: [...catalog.providers, {
        id: "opencode", label: "OpenCode", defaultModelId: "service/test", defaultReasoningEffort: "",
        models: [{ id: "service/test", label: "Test", reasoningEfforts: [] }],
      }] }; },
      captureSource: async (source) => { captures++; return deps.captureSource(source); },
      onFailure: (event) => failures.push(event),
    });
    for (const providerId of ["claude", "opencode"] as const) {
      const selection = { providerId, modelId: providerId === "claude" ? "test" : "service/test" };
      for (const purpose of ["character-memory", "target-memory", "affect"] as const) {
        settings.backgroundExecutionSettings[purpose] = { selection: { ...selection } };
      }
      const prepared = await runtime.prepare(input);
      assert.equal(prepared.status, "ready");
      const beforeReads = [catalogReads, captures];
      const beforeSettings = structuredClone(settings.backgroundExecutionSettings);
      settings.modelAvailability = { [providerId]: {
        disabledModelIds: providerId === "claude" ? ["test"] : [],
        disabledServiceIds: providerId === "opencode" ? ["service"] : [],
      } };
      for (const purpose of ["character-memory", "target-memory", "affect"] as const) {
        const result = await runtime.prepare({ ...input, purpose });
        assert.equal(result.status, "unavailable");
        assert.equal(result.code, "BACKGROUND_MODEL_DISABLED");
        assert.equal(failures.at(-1)!.code, "BACKGROUND_MODEL_DISABLED");
        assert.equal(failures.at(-1)!.purpose, purpose);
      }
      assert.deepEqual([catalogReads, captures], beforeReads);
      assert.deepEqual(settings.backgroundExecutionSettings, beforeSettings);
      assert.deepEqual(await runBackgroundMemoryRegistration(runtime.calls, { ...prepared.call,
        context: { ...prepared.call.context, scope: { ...prepared.call.context.scope, purpose: "target-memory" } },
        materials: "saved answer", onAdmitted() {},
      }), { kind: "completed" });
      settings.modelAvailability = {};
      const resumed = await runtime.prepare(input);
      assert.equal(resumed.status, "ready");
      assert.deepEqual(resumed.call.selection, selection);
    }
    assert.equal(calls, 2);
    assert.equal(failures.length, 6);
    assert.equal(f.bindings.getActiveBindingCount(), 0);
  } finally { await f.close(); }
});

// @test-value v2
// kind = "contract"
// claim = "三用途の継続後は新bindingのMCP/CLIで読み書きし、旧credentialを拒否して通常会話を変えない"
// oracle = { type = "contract", ref = "docs/design/background-execution.md" }
// fault = "継続後に古い接続情報を使うか旧credentialを認可するか、native文脈・指示本文を失い通常Sessionを書き換える"
// observable = "継続ID/thread、新旧MCP/CLIの応答、admission、実Workerの保存本文、通常Session"
// observation_boundary = "public-boundary"
// scope = "production runtime prepare through purpose consumers and real bound MCP registration"
// lifecycle = "permanent"
// distinction = "用途handler単体testでは本番設定選択とsource captureからconsumerまでの組立てを通らない"
// @end-test-value
test("本番設定から三用途consumerへ接続し、bound MCPで実保存する", async () => {
  const f = await backgroundHistoryFixture(undefined, { ...backgroundMemoryRegistrationHandlers, affect: registerBackgroundAffect });
  try {
    seed(f);
    const original = structuredClone(f.sessions.get("main")!);
    let sequence = 0;
    let savedAffect = 0;
    const previous = new Map<string, { binding: ReturnType<typeof project>; id: string }>();
    let agentError: unknown;
    const { runtime, settings, input } = setup(f, async (agent) => {
      try {
        assert.equal(currentRuntimeTurnAdmissionState(), agent.handle.revocationState); assertRuntimeTurnAdmission();
        assert.equal(agent.binding.background, true);
        assert.equal(agent.selection.providerId, "claude"); assert.equal(agent.selection.modelId, "test");
        assert.deepEqual(agent.scope.history, f.scope().history);
        const purpose = agent.scope.purpose;
        const body = settings.backgroundExecutionSettings[purpose].instructionText;
        if (purpose === "affect") {
          assert.equal(agent.userInput.split("## 登録指示\n\n")[1]!.split("\n\n## 実行範囲")[0], body);
        } else assert.equal(agent.userInput.split("# 登録指示本文\n\n")[1]!.split("\n\n# 実行情報")[0], body ?? MEMORY_REGISTRATION_PRESETS[purpose]);
        const binding = project(f, agent);
        const prior = previous.get(purpose);
        assert.equal(agent.continuation.threadId, prior ? `native-${purpose}` : null);
        if (prior) {
          assert.equal(agent.continuation.id, prior.id);
          assert.notEqual(binding.bindingReference, prior.binding.bindingReference);
          assert.equal((await f.request(prior.binding, prior.binding.managedMcp!.memoryUrl, "memory.append")).status, 401);
          await assert.rejects(promisify(execFile)(process.execPath, [resolve("resources/cli/withmate-session-history.mjs"), "list-messages", "--json", "{}"],
            { cwd: f.directory, env: f.cliEnv(prior.binding), windowsHide: true }), (error: unknown) => {
              const failed = error as { stdout: string };
              assert.equal(JSON.parse(failed.stdout).code, "SESSION_BINDING_INVALID");
              return true;
            });
        }
        const { stdout } = await promisify(execFile)(process.execPath, [resolve("resources/cli/withmate-session-history.mjs"), "list-messages", "--json", "{}"],
          { cwd: f.directory, env: f.cliEnv(binding), windowsHide: true });
        assert.equal(JSON.parse(stdout).ok, true);
        agent.continuation.onThreadId(`native-${purpose}`);
        previous.set(purpose, { binding, id: agent.continuation.id });
        assert.equal(binding.bindingId, agent.handle.bindingId);
        const { client } = await f.connect(binding, "memoryUrl");
        const registrationTools = (await client.listTools()).tools.map((tool) => tool.name)
          .filter((name) => ["memory.append", "character_memory.append_episode", "character_affect.appraise"].includes(name));
        assert.deepEqual(registrationTools, [purpose === "affect" ? "character_affect.appraise"
          : purpose === "character-memory" ? "character_memory.append_episode" : "memory.append"]);
        const key = `production-${++sequence}`;
        const response = await client.callTool(purpose === "affect" ? { name: "character_affect.appraise", arguments: {
          candidates: [{ sourceTurnId: 1, layer: "session", targetType: "bug", targetId: "fixture", family: "interest",
            value: { label: "interest", valence: 0.4 }, intensity: 0.6, reason: "Reproduction found", evidence: "saved answer" }],
        } } : purpose === "character-memory" ? { name: "character_memory.append_episode", arguments: {
          idempotencyKey: key, episode: { title: key, body: key, preview: key, observedFact: "saved answer" },
        } } : { name: "memory.append", arguments: {
          target: { kind: "user-global" }, kind: "note", title: key, body: key, preview: key, tags: [], idempotencyKey: key,
        } });
        assert.equal(response.isError, undefined, JSON.stringify(response));
        if (purpose !== "affect") {
          const saved = response.structuredContent as { entry: { id: string } };
          assert.equal((await f.memoryWorker.storage.getEntry(saved.entry.id))!.body, key);
        } else assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM character_affect_events_v6").get()!.count, ++savedAffect);
      } catch (error) { agentError = error; throw error; }
    });
    for (const purpose of ["character-memory", "target-memory", "affect"] as const) for (const _iteration of [0, 1]) {
      settings.backgroundExecutionSettings[purpose].instructionText = purpose === "target-memory" ? "" : purpose === "affect" ? "Edited Affect registration instructions" : undefined;
      const prepared = await runtime.prepare({ ...input, purpose });
      assert.equal(prepared.status, "ready");
      assert.equal(prepared.instructionText, settings.backgroundExecutionSettings[purpose].instructionText);
      const result = purpose === "affect"
        ? await runBackgroundAffectCall(runtime.calls, { ...prepared.call, onAdmitted() {}, instructionBody: prepared.instructionText,
          characterDefinition: "Character", currentAffect: { schemaVersion: "withmate-affect-v1", characterId: "character", userId: "local-user",
            sessionId: "main", evaluatedAt: "2026-11-01T01:00:00Z", layers: [], components: [] } })
        : await runBackgroundMemoryRegistration(runtime.calls, { ...prepared.call,
          context: { ...prepared.call.context, scope: { ...prepared.call.context.scope, purpose } },
          onAdmitted() {}, materials: "saved answer", instructionText: prepared.instructionText });
      if (agentError) throw agentError;
      assert.deepEqual(result, { kind: "completed" });
    }
    assert.equal(sequence, 6); assert.deepEqual(f.sessions.get("main"), original);
    assert.equal(f.bindings.getActiveBindingCount(), 0);
  } finally { await f.close(); }
});

// @test-value v2
// kind = "contract"
// claim = "本番runtimeは異なる用途を並行開始し個別finishとstopで権限を終了し、source付きeventをconsumerへ渡す"
// oracle = { type = "contract", ref = "docs/adr/035-background-execution-binding-and-history-scope.md" }
// fault = "共通runtimeが別用途まで直列化するかstopを実execution寿命へ接続しない"
// observable = "停止前のAgent二件、個別signal、binding数、終了結果、配信event"
// observation_boundary = "consumer"
// scope = "production runtime concurrency and stop delegation"
// lifecycle = "permanent"
// distinction = "runOnce単体はproduction runtimeのstart/stopとpublish接続を検証しない"
// @end-test-value
test("本番runtimeの並行実行と停止は実executionの寿命へ届く", async () => {
  const f = await backgroundHistoryFixture();
  const release = [gate(), gate()], entered = gate();
  const agents: BackgroundAgentInput[] = [];
  try {
    seed(f);
    const { runtime, input, settings } = setup(f, async (agent) => {
      const index = agents.length; agents.push(agent); if (agents.length === 2) entered.resolve();
      await release[index]!.promise;
      if (index === 0) assertRuntimeTurnAdmission();
    });
    const events: BackgroundRuntimeEvent[] = [];
    const unsubscribe = runtime.subscribe((event) => { events.push(event); });
    const facts: BackgroundRuntimeEvent[] = [
      { kind: "run_state", session: input.session, running: false, source: input.source },
      { kind: "terminal_saved", session: input.session, source: input.source,
        terminal: { turnId: 1, sessionId: "main", phase: "canceled", assistantMessageSeq: 1, threadId: "", errorMessage: "", completedAt: "2026-11-01T01:00:00.000Z" } },
      { kind: "settings_changed", settings },
    ];
    for (const fact of facts) runtime.publish(fact);
    assert.deepEqual(events, facts);
    runtime.start();
    const prepared = await runtime.prepare(input);
    assert.equal(prepared.status, "ready");
    const other = await runtime.prepare({ ...input, purpose: "character-memory" });
    assert.equal(other.status, "ready");
    const pending = [prepared, other].map((call) => runBackgroundMemoryRegistration(runtime.calls, { ...call.call,
      context: { ...call.call.context, scope: { ...call.call.context.scope, purpose: call.call.context.scope.purpose as "target-memory" | "character-memory" } },
      materials: "saved answer", onAdmitted() {} }));
    await entered.promise;
    assert.equal(f.bindings.getActiveBindingCount(), 2);
    assert.notEqual(agents[0]!.binding.bindingId, agents[1]!.binding.bindingId);
    release[0]!.resolve(); assert.deepEqual(await pending[0], { kind: "completed" });
    assert.equal(agents[1]!.signal.aborted, false); assert.equal(f.bindings.getActiveBindingCount(), 1);
    runtime.stop(); assert.equal(agents[1]!.signal.aborted, true);
    release[1]!.resolve(); assert.equal((await pending[1])!.kind, "canceled");
    assert.equal(f.bindings.getActiveBindingCount(), 0); assert.deepEqual(events, [...facts, { kind: "stopped" }]);
    unsubscribe(); runtime.publish({ kind: "settings_changed", settings });
    assert.equal(events.length, 4);
  } finally { release.forEach((item) => item.resolve()); await f.close(); }
});

// @test-value v2
// kind = "contract"
// claim = "本番prepareは未設定・disabled・source未対応・catalog失敗を区別し、保存済みterminalを含む読取権限historyを固定する"
// oracle = { type = "contract", ref = "docs/design/background-execution.md" }
// fault = "通常会話へのfallbackや同じ失敗への丸めを行うか、scopeが後続変更に追随し範囲外Turnを許可する"
// observable = "prepareのstatusとcode、固定scope、terminal不在またはhistory範囲外の例外、Agent回数"
// observation_boundary = "consumer"
// scope = "production preparation eligibility and captured execution scope"
// lifecycle = "permanent"
// distinction = "設定parserとsource reader単体では本番prepareの組合せとscope複製を確認しない"
// @end-test-value
test("本番prepareは設定失敗を区別し、保存済み範囲を固定する", async () => {
  const f = await backgroundHistoryFixture();
  try {
    seed(f); let calls = 0;
    const { runtime, deps, settings, input } = setup(f, () => { calls += 1; });
    settings.backgroundExecutionSettings["target-memory"] = {};
    assert.equal((await runtime.prepare(input)).status, "not_configured");
    settings.backgroundExecutionSettings["target-memory"] = { selection: { providerId: "claude", modelId: "test" }, instructionText: "" };
    settings.codingProviderSettings.claude.enabled = false;
    const disabled = await runtime.prepare(input);
    assert.equal(disabled.status, "unavailable"); assert.equal(disabled.code, "BACKGROUND_PROVIDER_DISABLED");
    settings.codingProviderSettings.claude.enabled = true;
    const unsupported = await runtime.prepare({ ...input, source: { kind: "auxiliary", sessionId: "aux", incarnationId: "inc-aux", parent: { sessionId: "main", incarnationId: "inc-main" } } });
    assert.equal(unsupported.status, "unavailable"); assert.equal(unsupported.code, "BACKGROUND_SOURCE_UNSUPPORTED");
    const failed = await new BackgroundProductionRuntime({ ...deps, getModelCatalog: async () => { throw new Error("offline"); } }).prepare(input);
    assert.equal(failed.status, "failed"); assert.equal(failed.code, "BACKGROUND_CATALOG_UNAVAILABLE");
    const captured = (await deps.captureSource(input.source))!;
    const history = { ...captured.history };
    const scope = buildBackgroundExecutionScope({ ...captured, history }, input);
    const original = structuredClone(captured.history);
    history.throughMessageSeq = 0;
    assert.deepEqual(scope.history, original);
    assert.throws(() => buildBackgroundExecutionScope({ ...captured, history }, input), /saved terminal Turn/);
    assert.throws(() => buildBackgroundExecutionScope({ ...captured, snapshot: { ...captured.snapshot, turns: [] } }, input), /saved terminal Turn/);
    assert.equal(calls, 0);
  } finally { await f.close(); }
});

// @test-value v2
// kind = "contract"
// claim = "準備中の設定snapshotを維持しつつProvider切替eventは旧準備済み呼出を取消し、新Providerから新しいthreadを始める"
// oracle = { type = "contract", ref = "docs/design/background-execution.md#本番共通runtimeとprovider" }
// fault = "設定読取やcatalog待機後に古い選択で切替通知を上書きするか、旧Providerを実行し旧threadを新Providerへ移す"
// observable = "準備snapshot、切替後旧呼出のcanceled、後続AgentのProvider・本文・新thread"
// observation_boundary = "consumer"
// scope = "production preparation snapshot across asynchronous catalog lookup and purpose consumer"
// lifecycle = "permanent"
// distinction = "設定保存とadapter native写像のtestだけでは非同期prepare中の共有設定変更を観測できない"
// @end-test-value
test("開始準備の選択と本文は設定変更から独立し、次の呼出しへ反映する", async () => {
  for (const delayedRead of ["settings", "catalog"] as const) {
  const f = await backgroundHistoryFixture();
  const entered = gate(), release = gate();
  try {
    seed(f);
    let observed: BackgroundAgentInput | undefined;
    const { deps, settings, input } = setup(f, (agent) => { observed = agent; });
    settings.backgroundExecutionSettings["target-memory"] = {
      selection: { providerId: "claude", modelId: "test", reasoningEffort: "high", approvalMode: "on-request", codexReviewer: "auto-review" }, instructionText: "",
    };
    settings.codingProviderSettings.codex.enabled = true;
    const snapshotCatalog: ModelCatalogSnapshot = { providers: [...catalog.providers, {
      id: "codex", label: "Codex", defaultModelId: "next", defaultReasoningEffort: "",
      models: [{ id: "next", label: "Next", reasoningEfforts: ["low"] }],
    }] };
    const runtime = new BackgroundProductionRuntime({ ...deps, getAppSettings: async () => {
      const snapshot = structuredClone(settings);
      if (delayedRead === "settings") { entered.resolve(); await release.promise; }
      return snapshot;
    }, getModelCatalog: async () => {
      if (delayedRead === "catalog") { entered.resolve(); await release.promise; }
      return snapshotCatalog;
    } });
    const pending = runtime.prepare(input);
    await entered.promise;
    const configured = settings.backgroundExecutionSettings["target-memory"];
    Object.assign(configured.selection!, { providerId: "codex", modelId: "next", reasoningEffort: "low", approvalMode: "never", codexReviewer: "user", codexSandboxMode: "read-only" });
    configured.instructionText = "Next instructions";
    runtime.publish({ kind: "settings_changed", settings });
    release.resolve();
    const prepared = await pending;
    assert.equal(prepared.status, "ready");
    assert.deepEqual(prepared.call.selection, { providerId: "claude", modelId: "test", reasoningEffort: "high", approvalMode: "on-request", codexReviewer: "auto-review" });
    assert.equal(prepared.instructionText, "");
    assert.deepEqual(await runBackgroundMemoryRegistration(runtime.calls, { ...prepared.call,
      context: { ...prepared.call.context, scope: { ...prepared.call.context.scope, purpose: "target-memory" } },
      materials: "saved materials", instructionText: prepared.instructionText, onAdmitted() {},
    }), { kind: "canceled", code: "BACKGROUND_CALL_CANCELED" });
    assert.equal(observed, undefined);
    const next = await runtime.prepare(input);
    assert.equal(next.status, "ready");
    assert.deepEqual(next.call.selection, configured.selection);
    assert.equal(next.instructionText, "Next instructions");
    await runBackgroundMemoryRegistration(runtime.calls, { ...next.call,
      context: { ...next.call.context, scope: { ...next.call.context.scope, purpose: "target-memory" } },
      materials: "new material", instructionText: next.instructionText, onAdmitted() {} });
    assert.deepEqual(observed!.selection, configured.selection);
    assert.equal(observed!.continuation.threadId, null);
    assert.equal(observed!.userInput.split("# 登録指示本文\n\n")[1]!.split("\n\n# 実行情報")[0], "Next instructions");
  } finally { release.resolve(); await f.close(); }
  }
});
