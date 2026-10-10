import assert from "node:assert/strict";
import { it } from "node:test";

import { buildNewSession, getSessionIncarnationId, type Session } from "../../src-shared/session/session-state.js";
import { captureSessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";
import type { SessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";
import { normalizeAppSettings } from "../../src-shared/settings/provider-settings-state.js";
import type { ModelCatalogProvider } from "../../src-shared/settings/model-catalog.js";
import { SessionRuntimeService, type SessionRuntimeServiceDeps } from "../../src-electron/session/session-runtime-service.js";
import type { RunSessionTurnInput } from "../../src-electron/providers/provider-runtime.js";
import { createSessionPersistenceAssembly } from "../../src-electron/session/session-persistence-assembly.js";
import { CurrentExecutionSelections } from "../../src-electron/session/current-execution-selections.js";

const providerCatalog: ModelCatalogProvider = {
  id: "codex",
  label: "Codex",
  defaultModelId: "model-a",
  defaultReasoningEffort: "high",
  models: [
    { id: "model-a", label: "Model A", reasoningEfforts: ["high"] },
    { id: "model-b", label: "Model B", reasoningEfforts: ["medium"] },
  ],
};

function makeService(observe: {
  composed: RunSessionTurnInput[];
  executed: RunSessionTurnInput[];
  turn: Array<Parameters<SessionRuntimeServiceDeps["createSessionTurn"]>[0]>;
  persisted: Session[];
}, overrides: Partial<SessionRuntimeServiceDeps> = {}) {
  const stored = buildNewSession({
    taskTitle: "Execution options",
    workspaceLabel: "workspace",
    workspacePath: "C:/workspace",
    branch: "main",
    provider: "codex",
    approvalMode: "untrusted",
    model: "model-a",
    reasoningEffort: "high",
    characterId: "character-1",
    character: "Character",
    characterIconPath: "",
    characterThemeColors: { main: "#111111", sub: "#222222" },
  });
  let current = stored;
  const adapter = {
    composePrompt(input: RunSessionTurnInput) {
      observe.composed.push(input);
      return {
        systemBodyText: "system",
        inputBodyText: "input",
        logicalPrompt: { systemText: "system", inputText: "input", composedText: "system\ninput" },
        imagePaths: [],
        additionalDirectories: [],
      };
    },
    async getProviderQuotaTelemetry() { return null; },
    async invalidateSessionThread() {},
    async invalidateAllSessionThreads() {},
    async runSessionTurn(input: RunSessionTurnInput) {
      observe.executed.push(input);
      return {
        threadId: "thread-1",
        assistantText: "done",


        usage: null,
      };
    },
  };
  const service = new SessionRuntimeService({
    getSession: () => current,
    upsertSession(next) {
      current = { ...next, model: stored.model, reasoningEffort: stored.reasoningEffort, approvalMode: stored.approvalMode };
      observe.persisted.push(current);
      return current;
    },
    resolveComposerPreview: async () => ({ attachments: [], errors: [] }),
    getAppSettings: () => normalizeAppSettings({}),
    resolveProviderCatalog: () => ({ snapshot: { revision: 1, providers: [providerCatalog] }, provider: providerCatalog }),
    getProviderCodingAdapter: () => adapter,
    getSessionMemory: () => ({
      sessionId: stored.id,
      workspacePath: stored.workspacePath,
      threadId: "",
      schemaVersion: 1,
      updatedAt: "",
      goal: "",
      decisions: [],
      openQuestions: [],
      nextActions: [],
      notes: [],
    }),
    resolveProjectMemoryEntriesForPrompt: () => [],
    createSessionTurn(input) {
      observe.turn.push(input);
      return { id: 1, ...input };
    },
    updateSessionTurn(_id, input) { observe.turn.push(input); },
    setLiveSessionRun() {},
    getLiveSessionRun: () => null,
    waitForApprovalDecision: () => "deny",
    waitForElicitationResponse: () => ({ action: "cancel" }),
    setProviderQuotaTelemetry() {},
    setSessionContextTelemetry() {},
    invalidateProviderSessionThread() {},
    scheduleProviderQuotaTelemetryRefresh() {},
    broadcastLiveSessionRun() {},
    resolvePendingApprovalRequest() {},
    resolvePendingElicitationRequest() {},
    ...overrides,
  });
  return { service, stored, adapter };
}

function makePersistence(runtime: SessionRuntimeService, stored: Session, auxiliaryOptions: Map<string, SessionExecutionOptions>) {
  let cached = [stored];
  const selections = new CurrentExecutionSelections();
  const checkpoints: SessionExecutionOptions[] = [];
  const persistence = createSessionPersistenceAssembly({
    owner: { assertActive() {} },
    storage: {
      setSessionExecutionOptions(_id: string, _owner: string, options: SessionExecutionOptions) { checkpoints.push(options); },
    } as never,
    pinStorage: {} as never,
    cache: {
      getSessions: () => cached,
      setSessions: (next) => { cached = next; },
      getSession: (id) => cached.find((entry) => entry.id === id) ?? null,
      overlayCurrentExecutionOptions: (session) => selections.apply(session),
      rememberExecutionOptions: (session, options) => selections.remember(session, options),
    },
    runtime: {
      isSessionRunInFlight: (id, scope = "with-auxiliary") => runtime.isRunInFlight(id)
        || (id === stored.id && scope === "with-auxiliary" && auxiliaryOptions.size > 0),
    },
    auxiliary: { listAuxiliarySessionRuntimeIdentities: () => [] },
    settings: {
      getAppSettings: () => normalizeAppSettings({}),
      getModelCatalogSnapshot: () => ({ revision: 1, providers: [providerCatalog] }),
    },
    character: { createCharacterRuntimeSnapshot: () => null },
    effects: {
      syncSessionDependencies() {},
      clearSessionContextTelemetry() {},
      clearSessionBackgroundActivities() {},
      invalidateProviderSessionThread() {},
      revokeSessionAgentRuntimeBindings() {},
      closeSessionWindow() {},
      discardSessionWindow() {},
      broadcastSessions() {},
      runCharacterAffectTurnOwnershipExclusive: async (operation) => operation(),
    },
  });
  return { persistence, selections, checkpoints, getCached: () => cached[0]! };
}

// @test-value v2
// kind = "invariant"
// claim = "待機Mainは複数Auxiliary実行中でも権限等の選択を受理し次turnへ渡すが、親削除を拒否し別会話の現在選択を保持する"
// oracle = { type = "contract", ref = "Issue #800; docs/design/electron-session-store.md#実行設定と-send" }
// fault = "子を含むguardでMain選択を拒否する、子を含む削除guardを弱める、または次turnへ古い選択を渡す"
// observable = "assemblyの選択受理結果、checkpoint、削除拒否、会話別CurrentExecutionSelectionsとProvider/turnの実行設定"
// observation_boundary = "component-behavior"
// scope = "Main execution options through persistence assembly and SessionRuntimeService; simulated Auxiliary in-flight registry"
// lifecycle = "permanent"
// impact = "待機中Mainの権限変更と次送信が阻害される、または実行中の子を親削除で失う"
// distinction = "既存runtime testの送信値固定と異なり、子実行中の選択受理から次turnのProvider入力までを結合する。小さいin-memory fixtureでDB/外部Providerを要しない"
// @end-test-value
it("Auxiliary実行中のMain選択を次turnへ渡し親削除を保護する", async () => {
  const observe = { composed: [] as RunSessionTurnInput[], executed: [] as RunSessionTurnInput[], turn: [] as Array<Parameters<SessionRuntimeServiceDeps["createSessionTurn"]>[0]>, persisted: [] as Session[] };
  const { service: runtime, stored } = makeService(observe);
  const auxiliaryOptions = new Map<string, SessionExecutionOptions>();
  const { persistence, selections, checkpoints, getCached } = makePersistence(runtime, stored, auxiliaryOptions);
  const capturedAuxiliaryOptions = captureSessionExecutionOptions(stored);
  for (const count of [1, 2]) {
    auxiliaryOptions.set(`aux-${count}`, capturedAuxiliaryOptions);
    const otherConversation = { ...stored, id: `aux-${count}` };
    selections.remember(otherConversation, capturedAuxiliaryOptions);
    const chosen: SessionExecutionOptions = {
      ...captureSessionExecutionOptions(stored),
      approvalMode: "never", codexSandboxMode: count === 1 ? "read-only" : "danger-full-access",
      codexSpeed: "fast", codexReviewer: "auto-review", customAgentName: "reviewer",
    };
    assert.deepEqual(await persistence.setSessionExecutionOptions(stored.id, getSessionIncarnationId(stored), chosen), {
      status: "accepted", checkpointSaved: true,
    });
    assert.deepEqual(checkpoints.at(-1), chosen);
    assert.deepEqual(captureSessionExecutionOptions(getCached()), chosen);
    await assert.rejects(persistence.deleteSession(stored.id), /running session cannot be deleted/);
    await runtime.runSessionTurn(stored.id, {
      userMessage: `run with ${count} auxiliaries`, executionOptions: captureSessionExecutionOptions(selections.apply(stored)),
    });
    assert.deepEqual(observe.executed.at(-1)?.executionOptions, chosen);
    const turn = observe.turn.findLast((entry) => entry.phase === "running");
    assert.equal(turn?.approvalMode, chosen.approvalMode);
    assert.equal(turn?.sandboxMode, chosen.codexSandboxMode);
    for (let index = 1; index <= count; index += 1) {
      assert.deepEqual(captureSessionExecutionOptions(selections.apply({ ...stored, id: `aux-${index}` })), capturedAuxiliaryOptions);
    }
  }
});

// @test-value v2
// kind = "invariant"
// claim = "Main自身がstarting/running/取消終了待ちの間は権限等の変更を拒否し、runtimeの実終了後にだけ受理する"
// oracle = { type = "contract", ref = "Issue #800; docs/design/session-run-lifecycle.md#decision" }
// fault = "self scopeが開始予約または取消終了待ちを見落とし実行中の権限選択を受理する"
// observable = "setSessionExecutionOptionsの拒否/受理、checkpoint件数、現在選択、SessionRuntimeServiceのin-flight"
// observation_boundary = "component-behavior"
// scope = "Main persistence execution guard with real SessionRuntimeService lifecycle and controlled provider/preview"
// lifecycle = "permanent"
// impact = "開始中や取消未終了のMainに別権限が表示され、実行条件との不一致を招く"
// distinction = "既存cancel testは再送可否を確認するが、各phaseで五つの制限対象の選択受理を確認しない。短いcancel graceと手動gateで外部Providerを不要にする"
// @end-test-value
it("Mainの開始中・実行中・取消終了待ちは実行設定変更を拒否する", async () => {
  const observe = { composed: [] as RunSessionTurnInput[], executed: [] as RunSessionTurnInput[], turn: [] as Array<Parameters<SessionRuntimeServiceDeps["createSessionTurn"]>[0]>, persisted: [] as Session[] };
  let releasePreview!: () => void;
  let previewEntered!: () => void;
  const previewGate = new Promise<void>((resolve) => { releasePreview = resolve; });
  const previewStarted = new Promise<void>((resolve) => { previewEntered = resolve; });
  let releaseProvider!: () => void;
  let providerEntered!: () => void;
  const providerGate = new Promise<void>((resolve) => { releaseProvider = resolve; });
  const providerStarted = new Promise<void>((resolve) => { providerEntered = resolve; });
  const { service: runtime, stored, adapter } = makeService(observe, {
    providerCancelGraceMs: 1,
    resolveComposerPreview: async () => {
      previewEntered();
      await previewGate;
      return { attachments: [], errors: [] };
    },
  });
  const runProvider = adapter.runSessionTurn.bind(adapter);
  adapter.runSessionTurn = async (input) => {
    providerEntered();
    await providerGate;
    return runProvider(input);
  };
  const { persistence, selections, checkpoints } = makePersistence(runtime, stored, new Map());
  const original = captureSessionExecutionOptions(stored);
  const changes: SessionExecutionOptions[] = [
    { ...original, approvalMode: "never" },
    { ...original, codexSandboxMode: "read-only" },
    { ...original, codexSpeed: "fast" },
    { ...original, codexReviewer: "auto-review" },
    { ...original, customAgentName: "reviewer" },
  ];
  const assertBlocked = async () => {
    assert.equal(runtime.isRunInFlight(stored.id), true);
    for (const changed of changes) {
      await assert.rejects(persistence.setSessionExecutionOptions(stored.id, getSessionIncarnationId(stored), changed), /running session cannot change these execution options/);
    }
    assert.deepEqual(checkpoints, []);
    assert.deepEqual(captureSessionExecutionOptions(selections.apply(stored)), original);
  };
  const run = runtime.runSessionTurn(stored.id, { userMessage: "run", executionOptions: original });
  try {
    await previewStarted;
    await assertBlocked();
    releasePreview();
    await providerStarted;
    await assertBlocked();
    runtime.cancelRun(stored.id);
    await run;
    await assertBlocked();
  } finally {
    releasePreview();
    releaseProvider();
    await run;
  }
  for (let attempt = 0; attempt < 100 && runtime.isRunInFlight(stored.id); attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(runtime.isRunInFlight(stored.id), false);
  assert.deepEqual(await persistence.setSessionExecutionOptions(stored.id, getSessionIncarnationId(stored), changes[0]!), {
    status: "accepted", checkpointSaved: true,
  });
});

// @test-value v2
// kind = "invariant"
// claim = "送信時に選んだ model/depth/approval は、開始・終了保存が古いSession設定を返しても同一turnのProviderと最小turnへ伝わる"
// oracle = { type = "contract", ref = "Issue #738 turn execution options boundary" }
// fault = "保存済みSession設定または保存戻り値からturn実行設定を再取得する"
// observable = "provider inputのexecutionOptionsとrunning/terminal turn fields"
// observation_boundary = "component-behavior"
// scope = "SessionRuntimeService turn execution"
// lifecycle = "permanent"
// impact = "表示選択と異なるmodelやapprovalでProviderを実行し、turnに誤設定が残る"
// distinction = "既存のSession永続化・Provider単体testでは保存戻り値と送信値の不一致を観測しない"
// @end-test-value
it("turn送信値を保存済み設定と独立にProviderと最小turnへ固定する", async () => {
  const observe = { composed: [] as RunSessionTurnInput[], executed: [] as RunSessionTurnInput[], turn: [] as Array<Parameters<SessionRuntimeServiceDeps["createSessionTurn"]>[0]>, persisted: [] as Session[] };
  const { service, stored } = makeService(observe);
  const selected = Object.freeze({ ...captureSessionExecutionOptions(stored), model: "model-b", reasoningEffort: "medium" as const, approvalMode: "never" as const });

  await service.runSessionTurn(stored.id, { userMessage: "run", executionOptions: selected });
  for (let attempt = 0; attempt < 20 && !observe.turn.some((entry) => entry.phase === "completed"); attempt += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }

  assert.equal(observe.persisted[0]?.model, "model-a");
  assert.deepEqual(observe.executed[0]?.executionOptions, selected);
  assert.equal(observe.executed[0]?.session.model, "model-a");
  assert.equal(Object.isFrozen(observe.executed[0]?.executionOptions), true);
  for (const phase of ["running", "completed"] as const) {
    const turn = observe.turn.find((entry) => entry.phase === phase);
    assert.equal(turn?.model, "model-b");
    assert.equal(turn?.reasoningEffort, "medium");
    assert.equal(turn?.approvalMode, "never");
  }
});

// @test-value v2
// kind = "invariant"
// claim = "catalogに無いmodelまたは当該model非対応depthはProvider起動とturn開始保存の前に拒否される"
// oracle = { type = "contract", ref = "Issue #738 invalid turn selection rejection" }
// fault = "無効な送信値をDB値・default・clampへ置き換えて実行する"
// observable = "runSessionTurn rejection、provider call数、保存数"
// observation_boundary = "component-behavior"
// scope = "SessionRuntimeService turn selection validation"
// lifecycle = "permanent"
// impact = "利用者が選ばなかったmodel/depthで実行される"
// distinction = "型検査ではIPC実行時値とcatalog対応関係を検証できない"
// @end-test-value
it("無効なmodel・depthを保存とProvider起動前に拒否する", async () => {
  const observe = { composed: [] as RunSessionTurnInput[], executed: [] as RunSessionTurnInput[], turn: [] as Array<Parameters<SessionRuntimeServiceDeps["createSessionTurn"]>[0]>, persisted: [] as Session[] };
  const { service, stored } = makeService(observe);
  const selected = captureSessionExecutionOptions(stored);
  await assert.rejects(service.runSessionTurn(stored.id, { userMessage: "run", executionOptions: { ...selected, model: "unknown" } }), /model catalog/);
  await assert.rejects(service.runSessionTurn(stored.id, { userMessage: "run", executionOptions: { ...selected, model: "model-b", reasoningEffort: "high" } }), /reasoning effort/);
  assert.equal(observe.persisted.length, 0);
  assert.equal(observe.composed.length, 0);
  assert.equal(observe.executed.length, 0);
  assert.equal(observe.turn.length, 0);
});
