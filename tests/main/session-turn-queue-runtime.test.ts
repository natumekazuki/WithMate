import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createV6StorageWorkerBundle } from "../../src-electron/storage/storage-worker-bundle.js";
import { createMainSessionRuntime } from "../../src-electron/app/main-session-runtime-assembly.js";
import { MainSessionCommandFacade } from "../../src-electron/app/main-session-command-facade.js";
import { MainSessionTurnQueueFacade } from "../../src-electron/app/main-session-turn-queue-facade.js";
import { SessionPersistenceService } from "../../src-electron/session/session-persistence-service.js";
import { SessionApprovalService } from "../../src-electron/session/session-approval-service.js";
import { SessionObservabilityService } from "../../src-electron/session/session-observability-service.js";
import { readSessionMonitorPage } from "../../src-electron/session/session-monitor-query.js";
import { SessionTurnQueueService } from "../../src-electron/session/session-turn-queue-service.js";
import { sessionSummaryToSession } from "../../src-electron/session/session-summary-adapter.js";
import { assertCapturedComposerAttachmentsAvailable, resolveComposerPreview } from "../../src-electron/files/composer-attachments.js";
import { buildNewSession, getSessionIncarnationId, type Session } from "../../src-shared/session/session-state.js";
import { captureSessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";
import { projectLiveSessionRunStatus, type LiveSessionRunStatus } from "../../src-shared/session/live-session-run-status.js";
import { normalizeAppSettings } from "../../src-shared/settings/provider-settings-state.js";
import type { LiveSessionRunState } from "../../src-shared/session/runtime-state.js";
import type { ProviderCodingAdapter, RunSessionTurnInput } from "../../src-electron/providers/provider-runtime.js";
import { composeProviderPrompt } from "../../src-electron/providers/provider-prompt.js";
import { SessionWindowBridge, type SessionWindowLike } from "../../src-electron/windows/session-window-bridge.js";
import { WindowBroadcastService } from "../../src-electron/windows/window-broadcast-service.js";
import { WITHMATE_LIVE_SESSION_RUN_STATUS_EVENT } from "../../src-shared/ipc/withmate-ipc-channels.js";
import { buildHomeSessionProjection } from "../../src/home/home-session-projection.js";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

// @test-value v2
// kind = "contract"
// claim = "親が作成または復旧した子はWindowなしで保存・実行でき、両Monitorは実行・承認待ちとWindowなしで終了した子を表示する。明示openは一つのWindowを作り、続くopenは同じWindowを再利用する"
// oracle = { type = "contract", ref = "docs/design/window-architecture.md#sessionの起動と継続; docs/design/session-run-lifecycle.md#session-window-close" }
// fault = "子の公開やqueue実行でSession Windowを生成する、作成復旧を完了しない、実Windowのない子を実行中・実行後にMonitorから落とす、明示openでWindowを二重生成する"
// observable = "Window factoryの呼出数とopen identity、復旧直後の公開summary、保存receiptの状態、両Monitor送信先のlive状態通知、MonitorのRunning・Attention・Stopped対象、公開済み承認要求、Stopped close後のMonitor query"
// observation_boundary = "component-behavior"
// scope = "Main child lifecycle, queued runtime, Monitor query and Session Window bridge with real SQLite Worker and a synthetic provider and window factory"
// lifecycle = "permanent"
// @end-test-value
test("子の作成・復旧と実行にはWindowを作らずMonitorから明示openする", { timeout: 15000 }, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "withmate-child-window-"));
  const bundle = createV6StorageWorkerBundle({ dbPath: path.join(temporary, "withmate-v6.db"), userDataPath: temporary });
  const saved = bundle.stores.session;
  const queueStore = bundle.stores.queue;
  const running = gate(), allowApproval = gate(), attention = gate();
  const settings = normalizeAppSettings({});
  let queue: SessionTurnQueueService | undefined;
  let closeConfirmations = 0;
  let windowCount = 0;
  let providerCalls = 0;
  type Window = SessionWindowLike & { emit(event: "ready-to-show"): boolean; focusCount: number };
  const bridge = new SessionWindowBridge<Window>({
    createWindow: () => {
      windowCount += 1;
      let destroyed = false;
      const events = new EventEmitter();
      const window = Object.assign(events, {
        focusCount: 0, isDestroyed: () => destroyed, isMinimized: () => false,
        minimize() {}, restore() {}, show() {}, focus() { this.focusCount += 1; },
        close: () => { let prevented = false; events.emit("close", { preventDefault: () => { prevented = true; } }); if (!prevented) window.destroy(); },
        destroy: () => { destroyed = true; events.emit("closed"); },
      });
      return window;
    },
    loadChatEntry: async (window) => { window.emit("ready-to-show"); },
    getSession: (id) => cache.find((session) => session.id === id) ?? null,
    isRunInFlight: (id) => runtime.isRunInFlight(id),
    confirmCloseWhileRunning: () => { closeConfirmations += 1; return true; },
    broadcastOpenSessionWindowIds() {},
  });
  type MonitorSignal = { sessionId: string; status: LiveSessionRunStatus | null };
  const monitorSignals: [MonitorSignal[], MonitorSignal[]] = [[], []];
  const monitorWindows = monitorSignals.map((signals) => ({ isDestroyed: () => false, webContents: {
    send: (channel: string, payload: unknown) => { if (channel === WITHMATE_LIVE_SESSION_RUN_STATUS_EVENT) signals.push(payload as MonitorSignal); },
  } }));
  const broadcast = new WindowBroadcastService({ getAllWindows: () => monitorWindows, getHomeWindows: () => monitorWindows.slice(0, 1),
    getPrimaryHomeWindow: () => monitorWindows[0], getLiveSessionRunStatusWindows: () => monitorWindows,
    getSessionWindows: () => [], getLiveSessionRunWindow: () => null });
  const live = new SessionObservabilityService({ onProviderQuotaTelemetryChanged() {}, onSessionContextTelemetryChanged() {},
    onLiveSessionRunChanged: (id, state) => {
      const status = projectLiveSessionRunStatus(state);
      // 通常の実行（Auxiliary ではない）でも同じ Main の組み立て用コールバックを使う。
      if (status?.runState === "running" || status?.cancellationState || status?.approvalPending) bridge.retainSessionForMonitor(id);
      broadcast.broadcastLiveSessionRun(id, state);
      if (state?.approvalRequest) attention.resolve();
    },
  });
  const approvals = new SessionApprovalService({ updateLiveSessionRun: live.updateLiveSessionRun.bind(live) });
  let cache: Session[] = [];
  const model = { id: "model", label: "Model", reasoningEfforts: ["high" as const] };
  const provider = { id: "codex", label: "Codex", defaultModelId: model.id, defaultReasoningEffort: "high" as const, models: [model] };
  const snapshot = { providers: [provider] };
  const persistence = new SessionPersistenceService({
    getSessions: () => cache, setSessions: (next) => { cache = next; }, getSession: (id) => cache.find((session) => session.id === id) ?? null,
    getStoredSession: saved.getSession, getStoredSessionSummary: saved.getSessionSummary, listStoredSessionSummaries: saved.listSessionSummaries,
    isSessionRunInFlight: (id) => runtime.isRunInFlight(id), upsertStoredSession: (session, op) => op === "create" ? saved.insertSession(session) : saved.updateSession(session),
    appendStoredRunningTurnStart: saved.appendRunningTurnStart, appendStoredSessionTerminal: saved.appendSessionTerminal,
    checkpointStoredSessionRunMetadata: saved.checkpointSessionRunMetadata, replaceStoredSessions: async (sessions) => { await saved.replaceSessions(sessions); },
    listStoredSessions: saved.listSessions, getAppSettings: () => settings, getModelCatalogSnapshot: () => snapshot,
    getSessionLifecycleOperation: saved.getSessionLifecycleOperation, listPendingSessionLifecycleOperations: saved.listPendingSessionLifecycleOperations,
    beginSessionLifecycleOperation: saved.beginSessionLifecycleOperation, prepareSessionLifecycleCreation: saved.prepareSessionLifecycleCreation,
    advanceSessionLifecycleOperation: saved.advanceSessionLifecycleOperation,
    clearSessionContextTelemetry() {}, invalidateProviderSessionThread() {}, closeSessionWindow() {}, broadcastSessions() {},
  });
  const approval = { requestId: "approval", provider: "codex", kind: "test", title: "Synthetic approval", summary: "Fixture", decisionMode: "direct-decision" as const };
  const waitForApproval = "Wait for approval without a Window";
  const runtime = createMainSessionRuntime({
    owner: { assertActive() {}, isActive: () => true }, admission: { runSessionAdmissionExclusive: async (_, reserve) => reserve() },
    sessions: { getSession: saved.getSession, persistRunningTurnStart: persistence.persistRunningTurnStart.bind(persistence),
      persistQueuedTurnStart: persistence.persistQueuedTurnStart.bind(persistence), appendRunningInput: persistence.appendRunningInput.bind(persistence),
      appendTerminalSession: persistence.appendTerminalSession.bind(persistence), checkpointRuntimeMetadata: persistence.checkpointRuntimeMetadata.bind(persistence),
      clearCharacterAuthoringRuntimeState: persistence.clearCharacterAuthoringRuntimeState.bind(persistence) },
    resolution: { resolveRuntimeSessionForTurn: (session) => session, resolveProviderSession: (session) => session,
      resolveComposerPreview, assertCapturedComposerAttachmentsAvailable, resolveSessionFolderPath: () => temporary,
      resolveProviderCatalog: () => ({ snapshot, provider }) },
    provider: { getProviderCodingAdapter: () => ({ composePrompt: composeProviderPrompt, getProviderQuotaTelemetry: async () => null,
      invalidateSessionThread: async () => {}, invalidateAllSessionThreads: async () => {}, runSessionTurn: async (input) => {
        providerCalls += 1;
        if (input.userMessage === waitForApproval) {
          running.resolve();
          await allowApproval.promise;
          await input.onApprovalRequest!(approval);
          input.signal?.throwIfAborted();
        }
        return { assistantText: "fixture result", threadId: "fixture-thread", usage: null };
      } }) },
    context: { getAppSettings: () => settings, readSessionInstructions: async () => "" }, turn: { createSessionTurn: bundle.stores.turn.createSessionTurn, updateSessionTurn: bundle.stores.turn.updateSessionTurn },
    live: { setLiveSessionRun: live.setLiveSessionRun.bind(live), getLiveSessionRun: live.getLiveSessionRun.bind(live),
      setProviderQuotaTelemetry() {}, setSessionContextTelemetry() {}, scheduleProviderQuotaTelemetryRefresh() {}, broadcastLiveSessionRun() {} },
    interaction: { waitForApprovalDecision: approvals.waitForLiveApprovalDecision.bind(approvals), waitForElicitationResponse: () => ({ action: "cancel" }),
      resolvePendingApprovalRequest: (id) => approvals.cancelSession(id), resolvePendingElicitationRequest() {}, invalidateProviderSessionThread() {} },
    notification: { onSessionRunReleased: (id) => queue?.wake(id) }, timing: {},
  });
  try {
    await bundle.initialize();
    await bundle.stores.character.createCharacter({ name: "Child fixture" });
    const parent = await saved.insertSession(buildNewSession({ id: "parent", taskTitle: "Parent", workspaceLabel: "Fixture",
      workspacePath: temporary, branch: "", characterId: "unknown", character: "Unknown", characterIconPath: "", characterThemeColors: { main: "#fff", sub: "#000" },
      provider: "codex", model: model.id, reasoningEffort: "high", approvalMode: "on-request", sessionRole: "overall-coordinator" }));
    cache = [parent];
    let interruptAuxiliary = false;
    const commands = new MainSessionCommandFacade({
      getSessions: () => cache, getSession: (id) => cache.find((session) => session.id === id) ?? null, getStoredSessionSummaries: saved.listSessionSummaries,
      getSessionStorageIdentity: () => bundle, runProviderRuntimeOperationExclusive: async (operation) => operation(),
      resolveSessionLaunchSelection: async () => assert.fail("Not a Home launch"), getSessionPersistenceService: () => persistence, getSessionRuntimeService: () => runtime,
      getProviderQuotaTelemetry: () => null, isProviderQuotaTelemetryStale: () => false, refreshProviderQuotaTelemetry: async () => null,
      initializeCreatedSession: async (session) => {
        if (interruptAuxiliary) { interruptAuxiliary = false; throw new Error("Initial Auxiliary interrupted"); }
        await bundle.stores.auxiliary.upsertAuxiliarySession({ ...session, id: `${session.id}-aux`, parentSessionId: session.id, title: "Aux",
          runState: "idle", createdAt: "now", composerDraft: "", displayAfterMessageIndex: null, creationContext: { generationId: "test", parentIncarnationId: getSessionIncarnationId(session) } });
      },
      createSessionId: randomUUID, createSessionFilesDirectory: (id) => path.join(temporary, id), resolveSessionFilesDirectory: (id) => path.join(temporary, id),
      isSessionFilesWorkspace: () => false, dismissSessionTurnNotification() {}, validateWorkspaceDirectory: async () => ({ valid: true }),
      listActiveCharacters: bundle.stores.character.listCharacters, createCharacterRuntimeSnapshot: bundle.stores.character.createRuntimeSnapshot,
    });
    const request = { requestId: randomUUID(), role: "executor" as const, provider: "codex", model: model.id, reasoningEffort: "high", workspacePath: temporary };
    const actor = { id: parent.id, incarnationId: getSessionIncarnationId(parent) };
    const actorExecution = { providerId: parent.provider, executionOptions: captureSessionExecutionOptions(parent) };
    const create = (input: typeof request) => commands.createChildSession(actor, input, () => {}, actorExecution);
    const readMonitor = () => readSessionMonitorPage({ listMonitorSessionIds: () => bridge.listMonitorSessionIds(),
      readSummaries: async (ids) => (await saved.listSessionSummaryPage({ scope: "open", sessionIds: ids })).entries,
      readAuxiliarySummaries: bundle.stores.auxiliary.listAuxiliarySessionSummaries, getLiveSessionRun: live.getLiveSessionRun.bind(live), hasUnreadResult: () => false });
    const readCrew = () => saved.listHomeCrewMembersPage(bridge.listOpenSessionWindowIdentities(), null, 100);
    const child = await create(request);
    assert.equal((await create(request)).id, child.id);
    interruptAuxiliary = true;
    const recoveryRequest = { ...request, requestId: randomUUID() };
    await assert.rejects(create(recoveryRequest), /Initial Auxiliary interrupted/);
    const recoveryTarget = (await saved.listPendingSessionLifecycleOperations())[0]!.targets[0]!.id;
    const isPublished = async (id: string) => (await saved.listSessionSummaries()).some((summary) => summary.id === id);
    assert.equal(await isPublished(recoveryTarget), false);
    await commands.recoverPendingSessionLifecycleOperations();
    assert.equal(await isPublished(recoveryTarget), true);
    const recovered = await create(recoveryRequest);
    assert.equal(recovered.id, recoveryTarget);
    assert.notEqual(recovered.id, child.id);
    assert.equal(windowCount, 0, "created and recovered children must not call the Window factory");
    assert.deepEqual((await readMonitor()).entries, []);
    assert.deepEqual(await readCrew(), []);

    queue = new SessionTurnQueueService({ store: queueStore, isRunInFlight: (id) => runtime.isRunInFlight(id),
      dispatch: (receipt, started, control) => runtime.runQueuedSessionTurn(receipt, started, control) });
    await queue.start();
    const senderTurn = await bundle.stores.turn.createSessionTurn({ sessionId: parent.id, phase: "running", createdAt: "now",
      provider: "codex", model: parent.model, reasoningEffort: parent.reasoningEffort, approvalMode: parent.approvalMode, threadId: "", errorMessage: "" });
    const sender = new MainSessionTurnQueueFacade({ assertActive() {}, assertAccepting() {}, getSession: saved.getSession,
      getAppSettings: async () => settings, validateWorkspace: async () => {}, validateProvider: async () => ({ provider }),
      preview: async (session, text) => resolveComposerPreview(session, text), store: queueStore, service: queue });
    const targetOf = (session: Session) => ({ kind: "main" as const, sessionId: session.id, incarnationId: getSessionIncarnationId(session) });
    const enqueue = (target: ReturnType<typeof targetOf>, message: string) =>
      sender.enqueueSessionMessage({ requestId: randomUUID(), target, message }, {
        kind: "session", operation: "send", actorKind: "main", actorSessionId: parent.id, actorIncarnationId: actor.incarnationId,
        actorTurnId: String(senderTurn.id), targetSessionId: target.sessionId, targetIncarnationId: target.incarnationId,
      }, () => {});
    const target = targetOf(child);
    const accepted = await enqueue(target, waitForApproval);
    assert.equal(accepted.state, "starting");
    await running.promise;
    const active = await queueStore.getReceipt(target, accepted.requestId);
    assert.equal(active?.state, "running");
    assert.deepEqual((await readMonitor()).entries.map(({ id, runState }) => [id, runState]), [[child.id, "running"]]);
    assert.deepEqual(await readCrew(), []);
    allowApproval.resolve();
    await attention.promise;
    assert.equal(windowCount, 0);
    const snapshot = await readMonitor();
    const attentionEntries = buildHomeSessionProjection(snapshot.entries, snapshot.entries.map(({ id }) => id), "", snapshot.auxiliarySessions).approvalMonitorEntries;
    assert.deepEqual(attentionEntries.map(({ session, state }) => [session.id, state.label]), [[child.id, "Attention"]]);
    for (const signals of monitorSignals) assert.ok(signals.some(({ sessionId, status }) => sessionId === child.id && status?.approvalPending));

    const fromAttention = attentionEntries[0]!.session.id;
    const window = await bridge.openSessionWindow(fromAttention);
    assert.equal(await bridge.openSessionWindow(fromAttention), window);
    assert.equal(windowCount, 1);
    assert.equal(window.focusCount, 2);
    assert.ok((await readCrew()).some((member) => member.id === child.id));
    assert.equal(live.getLiveSessionRun(child.id)?.approvalRequest?.requestId, approval.requestId);
    assert.ok(active?.turnId);
    assert.equal((await runtime.stopSessionTurn(child.id, target.incarnationId, active.turnId)).outcome, "applied");
    await queue.waitForPending();
    await runtime.waitForPendingRuns();
    assert.equal((await queueStore.getReceipt(target, accepted.requestId))?.state, "canceled");
    assert.equal(providerCalls, 1);
    assert.deepEqual((await readMonitor()).entries.map(({ id, runState, approvalPending }) => [id, runState, approvalPending]), [[child.id, "idle", false]]);
    assert.equal(await bridge.requestCloseSessionWindow(child.id), true);
    assert.equal(closeConfirmations, 0);
    assert.deepEqual((await readMonitor()).entries, []);

    const recoveredTarget = targetOf(recovered);
    const finishing = await enqueue(recoveredTarget, "Complete without a Window");
    await queue.waitForPending();
    await runtime.waitForPendingRuns();
    assert.equal((await queueStore.getReceipt(recoveredTarget, finishing.requestId))?.state, "completed");
    assert.equal(providerCalls, 2);
    assert.equal(windowCount, 1, "the recovered child never opened a Window");
    const stopped = await readMonitor();
    const stoppedEntries = buildHomeSessionProjection(stopped.entries, stopped.entries.map(({ id }) => id), "", stopped.auxiliarySessions).nonRunningMonitorEntries;
    assert.deepEqual(stoppedEntries.map(({ session }) => session.id), [recovered.id]);
    assert.deepEqual(await readCrew(), []);
    await bridge.openSessionWindow(recovered.id);
    assert.equal(await bridge.requestCloseSessionWindow(recovered.id), true);
    assert.deepEqual((await readMonitor()).entries, []);
  } finally {
    allowApproval.resolve();
    runtime.cancelAllRuns();
    approvals.reset();
    await Promise.all([queue?.close(), runtime.waitForPendingRuns()]);
    live.dispose();
    await bundle.client.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

// @test-value v2
// kind = "contract"
// claim = "初回受付で実行枠を同時確保し、後続の固定入力・Provider thread・会話枠を保持する。終端返信喪失は正本を保持し、開始保存の返信不明は稼働中に実guard解放後だけ照合して後続を進める"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md#gui-turn-queue; docs/design/electron-session-store.md#turn-queue; docs/design/prompt-composition.md#metadataと必要時取得" }
// fault = "即時開始の受付を先にqueuedでcommitまたは通知する、同時送信も開始する、受付後に入力や表示所属が変わる、または不明実行を自動再送する"
// observable = "Worker commit直後と受付通知からの一覧、ACK、保存receipt、Provider入力に含む会話枠と呼出順、公開履歴seq、実guard解除前後の実WorkerのTurn状態・thread・終端"
// observation_boundary = "public-boundary"
// scope = "MainSessionRuntimeAssembly + QueueFacade/Service + SessionPersistenceService + V6StorageWorkerBundle"
// lifecycle = "permanent"
// impact = "受付した指示が異なる設定/pathで実行される、同じ会話が重複実行される、receiptと履歴が乖離することを防ぐ"
// distinction = "個別fake port testではMain owner guard・async Worker proxy・partial persistenceの実結合を検証できない"
// @end-test-value
/** キューへの受付時に入力と設定を取得するが、指示は実行を送出する時点で初めて Worker から読み取る。 */
test("Main queued runtimeは実Worker保存でFIFO捕捉とthread継承を結合する", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "withmate-queue-runtime-"));
  const bundle = createV6StorageWorkerBundle({ dbPath: path.join(temporary, "withmate-v6.db"), userDataPath: temporary });
  let queue: SessionTurnQueueService | undefined;
  const finishFirst = gate();
  const allowDispatch = gate();
  const firstCommit = gate();
  const releaseFirstReply = gate();
  try {
    await bundle.initialize();
    await writeFile(path.join(temporary, "input.txt"), "captured path fixture");
    const saved = await bundle.stores.session.insertSession({ ...buildNewSession({ id: "queue-runtime", taskTitle: "Queue", workspaceLabel: "workspace",
      workspacePath: temporary, branch: "main", characterId: "unknown", character: "Unknown", characterIconPath: "",
      characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" }, approvalMode: "on-request",
      model: "captured-native-model", reasoningEffort: "native-depth" }), sessionRole: "overall-coordinator", rootSessionId: "queue-runtime" });
    const owner = { sessionId: saved.id, incarnationId: getSessionIncarnationId(saved) };
    const target = { kind: "main" as const, ...owner };
    await bundle.stores.instructions.set(target, "before acceptance");
    const [a, b] = await Promise.all(["peer-a", "peer-b"].map(async (id) => {
      const peer = await bundle.stores.session.insertSession({ ...saved, id, incarnationId: id + "-v1", sessionRole: "executor",
        parentSessionId: saved.id, createdBySessionId: saved.id });
      return { kind: "main" as const, sessionId: peer.id, incarnationId: getSessionIncarnationId(peer) };
    }));
    const provider = { id: "codex", label: "Codex", defaultModelId: saved.model, defaultReasoningEffort: saved.reasoningEffort,
      models: [{ id: saved.model, label: "Model", reasoningEfforts: ["medium", "high"] as Array<"medium" | "high"> }] };
    const snapshot = { providers: [provider] };
    let cache: Session[] = [saved];
    const getSession = async (id: string) => {
      const metadata = await bundle.stores.session.getSessionMetadata(id);
      return metadata ? { ...sessionSummaryToSession(metadata.summary), characterRuntimeSnapshot: metadata.characterRuntimeSnapshot, messageCount: metadata.messageCount } : null;
    };
    const persistence = new SessionPersistenceService({
      getSessions: () => cache, setSessions: (next) => { cache = next; }, getSession: (id) => cache.find((session) => session.id === id) ?? null,
      isSessionRunInFlight: () => runtime.isRunInFlight(saved.id), upsertStoredSession: () => { throw new Error("Queued runtime cannot full-upsert history"); },
      appendStoredRunningTurnStart: (input) => bundle.stores.session.appendRunningTurnStart(input),
      appendStoredSessionSteer: (input) => bundle.stores.session.appendSessionSteer(input),
      appendStoredSessionTerminal: (input) => bundle.stores.session.appendSessionTerminal(input),
      checkpointStoredSessionRunMetadata: (input) => bundle.stores.session.checkpointSessionRunMetadata(input),
      replaceStoredSessions: () => { throw new Error("Unexpected replace"); }, listStoredSessions: () => { throw new Error("Unexpected full list"); },
      getAppSettings: () => normalizeAppSettings({}), getModelCatalogSnapshot: () => snapshot,
       clearSessionContextTelemetry() {},
      invalidateProviderSessionThread() {}, closeSessionWindow() {}, broadcastSessions() {},
    });
    const startedFirst = gate();
    const calls: Array<{ text: string; thread: string; model: string; depth: string; attachment: string }> = [];
    const providerInputs: RunSessionTurnInput[] = [];
    const firstRequestId = randomUUID();
    const secondRequestId = randomUUID();
    const unknownRequestId = randomUUID();
    const followerRequestId = randomUUID();
    let rejectStarted = false;
    let cleanupGuard = false;
    let dispatches = 0;
    let acceptanceWrites = 0;
    const adapter: ProviderCodingAdapter = {
      composePrompt: composeProviderPrompt,
      getProviderQuotaTelemetry: async () => null, invalidateSessionThread: async () => {}, invalidateAllSessionThreads: async () => {},
      runSessionTurn: async (input) => {
        const requestId = calls.length === 0 ? firstRequestId : calls.length === 1 ? secondRequestId : followerRequestId;
        const receipt = await bundle.stores.queue.getReceipt(owner, requestId);
        const turn = await bundle.stores.turn.getLatestSessionTurn(saved.id);
        assert.equal(receipt?.state, "running");
        assert.equal(receipt?.turnId, String(turn?.id));
        assert.equal(receipt?.userMessageSeq, turn?.userMessageSeq);
        providerInputs.push(input);
        calls.push({ text: input.userMessage, thread: input.session.threadId, model: input.executionOptions.model,
          depth: input.executionOptions.reasoningEffort, attachment: input.attachments[0]?.absolutePath ?? "" });
        if (calls.length === 1) { startedFirst.resolve(); await finishFirst.promise; }
        return { assistantText: `answer-${calls.length}`, threadId: `thread-${calls.length}`, usage: null };
      },
    };
    let live: LiveSessionRunState | null = null;
    let terminalReplyLost = false;
    const runtime = createMainSessionRuntime({
      owner: { assertActive() {}, isActive: () => true }, admission: { runSessionAdmissionExclusive: async (_, operation) => operation() },
      sessions: { getSession, persistRunningTurnStart: (session, count) => persistence.persistRunningTurnStart(session, count),
        persistQueuedTurnStart: (session, count, id, turn) => persistence.persistQueuedTurnStart(session, count, id, turn),
        appendRunningInput: (session, text, id) => persistence.appendRunningInput(session, text, id),
        appendTerminalSession: async (session, terminal) => {
          const committed = await persistence.appendTerminalSession(session, terminal);
          if (!terminalReplyLost) { terminalReplyLost = true; throw new Error("First terminal commit reply lost"); }
          return committed;
        },
        checkpointRuntimeMetadata: (session, expected) => persistence.checkpointRuntimeMetadata(session, expected),
        clearCharacterAuthoringRuntimeState: (session) => persistence.clearCharacterAuthoringRuntimeState(session) },
      resolution: { resolveRuntimeSessionForTurn: (session) => session, resolveProviderSession: (session) => session,
        resolveComposerPreview: async () => { assert.fail("Accepted queue body must not be re-previewed"); },
        assertCapturedComposerAttachmentsAvailable, resolveSessionFolderPath: () => temporary,
        resolveProviderCatalog: () => ({ snapshot, provider }) },
      provider: { getProviderCodingAdapter: () => adapter },
      context: { getAppSettings: () => normalizeAppSettings({}), readSessionInstructions: async (owner) => {
        const body = await bundle.stores.instructions.get(owner);
        assert.ok(body !== null);
        return body;
      } },
      turn: { createSessionTurn: (input) => bundle.stores.turn.createSessionTurn(input), updateSessionTurn: (id, input) => bundle.stores.turn.updateSessionTurn(id, input) },
      live: { setLiveSessionRun: (_, next) => { live = next; }, getLiveSessionRun: () => live,
        setProviderQuotaTelemetry() {}, setSessionContextTelemetry() {}, scheduleProviderQuotaTelemetryRefresh() {}, broadcastLiveSessionRun() {} },
      interaction: { waitForApprovalDecision: () => "approve", waitForElicitationResponse: () => ({ action: "cancel" }),
        resolvePendingApprovalRequest() {}, resolvePendingElicitationRequest() {}, invalidateProviderSessionThread() {} },
      notification: { onSessionRunReleased: (id) => queue?.wake(id) }, timing: {},
    });
    const admitWithGatedReply = async (...args: Parameters<typeof bundle.stores.queue.admit>) => {
      const result = await bundle.stores.queue.admit(...args);
      acceptanceWrites += 1;
      if (acceptanceWrites === 1) { firstCommit.resolve(); await releaseFirstReply.promise; }
      return result;
    };
    const queueStore = new Proxy(bundle.stores.queue, {
      get: (target, property) => property === "admit" ? admitWithGatedReply : Reflect.get(target, property),
    });
    const notifications: Array<ReturnType<MainSessionTurnQueueFacade["listSessionTurnQueue"]>> = [];
    queue = new SessionTurnQueueService({ store: queueStore, isRunInFlight: (id) => cleanupGuard || runtime.isRunInFlight(id),
      onChanged: () => { notifications.push(facade.listSessionTurnQueue(saved.id)); },
      dispatch: async (receipt, started) => {
        dispatches += 1;
        if (receipt.requestId === firstRequestId) await allowDispatch.promise;
        return runtime.runQueuedSessionTurn(receipt, async (input) => {
          if (rejectStarted) { rejectStarted = false; cleanupGuard = true; throw new Error("Atomic start acknowledgement lost"); }
          await started(input);
        });
      } });
    await queue.start();
    let previews = 0;
    const facade = new MainSessionTurnQueueFacade({ assertActive() {}, assertAccepting() {}, getSession,
      getAppSettings: async () => normalizeAppSettings({}),
      validateWorkspace: async () => {}, validateProvider: async () => ({ provider }),
      preview: async (session, text) => { previews += 1; return resolveComposerPreview(session, text); }, store: bundle.stores.queue, service: queue });
    const options = captureSessionExecutionOptions(saved);
    const firstInput = { incarnationId: owner.incarnationId, clientRequestId: firstRequestId,
      submitSource: "composer" as const, userMessage: "First @input.txt", executionOptions: options, mainConversationFrame: a };
    const secondInput = { incarnationId: owner.incarnationId, clientRequestId: secondRequestId, submitSource: "composer" as const,
      userMessage: "Second @input.txt", executionOptions: { ...options, reasoningEffort: "medium" as const }, mainConversationFrame: b };
    const accepting = Promise.all([facade.enqueueSessionTurn(saved.id, firstInput), facade.enqueueSessionTurn(saved.id, secondInput)]);
    await Promise.race([firstCommit.promise, accepting]);
    const committed = (await facade.listSessionTurnQueue(saved.id)).map(({ requestId, state }) => [requestId, state]);
    assert.equal(dispatches, 0);
    releaseFirstReply.resolve();
    const [first, second] = await accepting;
    assert.deepEqual(committed, [[firstRequestId, "starting"]]);
    assert.equal(first.state, "starting");
    assert.equal(second.state, "queued");
    assert.equal((await notifications[0])?.find((entry) => entry.id === first.id)?.state, "starting");
    assert.equal(dispatches, 1);
    const reconciled = await facade.enqueueSessionTurn(saved.id, firstInput);
    assert.equal(reconciled.id, first.id);
    assert.equal(reconciled.state, "starting");
    assert.equal(acceptanceWrites, 2);
    await bundle.stores.instructions.set(target, "before first dispatch");
    allowDispatch.resolve();
    await startedFirst.promise;
    await bundle.stores.instructions.set(target, "after first dispatch");
    assert.match(composeProviderPrompt(providerInputs[0]).systemBodyText, /# Session Instructions\n\nbefore first dispatch$/);
    secondInput.userMessage = "Edited after durable ACK";
    secondInput.executionOptions = { ...secondInput.executionOptions, model: "invalid-after-ACK" };
    secondInput.mainConversationFrame = a;
    assert.equal(calls.length, 1);
    finishFirst.resolve();
    await queue.waitForPending();
    await runtime.waitForPendingRuns();
    assert.deepEqual(calls, [
      { text: "First @input.txt", thread: "", model: options.model, depth: options.reasoningEffort, attachment: path.join(temporary, "input.txt") },
      { text: "Second @input.txt", thread: "thread-1", model: options.model, depth: "medium", attachment: path.join(temporary, "input.txt") },
    ]);
    assert.match(composeProviderPrompt(providerInputs[1]).systemBodyText, /# Session Instructions\n\nafter first dispatch$/);
    assert.equal(previews, 2);
    const page = await bundle.stores.queue.listReceipts(owner);
    assert.deepEqual(page.receipts.map((receipt) => [receipt.id, receipt.state, receipt.userMessageSeq]), [[first.id, "completed", 0], [second.id, "completed", 2]]);
    assert.notEqual(page.receipts[0]!.turnId, page.receipts[1]!.turnId);
    const stored = await bundle.stores.session.getSession(saved.id);
    assert.deepEqual(stored?.messages.map((message) => message.text), ["First @input.txt", "answer-1", "Second @input.txt", "answer-2"]);
    assert.equal(stored?.threadId, "thread-2");
    for (const [index, thread] of [a, b].entries()) {
      const prompt = composeProviderPrompt(providerInputs[index]);
      const identity = `sessionId: "${saved.id}"\nincarnationId: "${owner.incarnationId}"\nseq: ${2 * index}\n`;
      assert.ok(prompt.inputBodyText.includes(identity));
      const frame = prompt.inputBodyText.match(/^# Conversation Thread\n\nthread: (.+)$/m);
      assert.ok(frame);
      assert.deepEqual(JSON.parse(frame[1]), thread);
      assert.doesNotMatch(prompt.systemBodyText, /Conversation Thread/);
      const result = await bundle.stores.execution.execute({ target, operation: "list_messages", request: { target, thread } });
      assert.ok(result.ok);
      assert.deepEqual((result.items as Array<{ seq: number }>).map(({ seq }) => seq), [2 * index, 2 * index + 1]);
    }

    rejectStarted = true;
    const unknown = await facade.enqueueSessionTurn(saved.id, { incarnationId: owner.incarnationId, clientRequestId: unknownRequestId,
      submitSource: "composer", userMessage: "Unknown start", executionOptions: options });
    await queue.waitForPending();
    assert.equal((await bundle.stores.queue.getReceipt(owner, unknownRequestId))?.state, "interrupted");
    const follower = await facade.enqueueSessionTurn(saved.id, { incarnationId: owner.incarnationId, clientRequestId: followerRequestId,
      submitSource: "composer", userMessage: "After recovery", executionOptions: options });
    queue.wake(owner.sessionId);
    await queue.waitForPending();
    assert.equal(dispatches, 3);
    assert.equal((await bundle.stores.session.getSession(saved.id))?.runState, "running");
    assert.equal((await bundle.stores.turn.getLatestSessionTurn(saved.id))?.phase, "running");
    assert.equal((await bundle.stores.queue.getReceipt(owner, followerRequestId))?.state, "queued");
    cleanupGuard = false;
    queue.wake(owner.sessionId);
    await queue.waitForPending();
    await runtime.waitForPendingRuns();
    assert.equal(dispatches, 4);
    assert.equal((await bundle.stores.queue.getReceipt(owner, followerRequestId))?.state, "completed",
      (await bundle.stores.queue.getReceipt(owner, followerRequestId))?.reason ?? "Follower must complete");
    assert.equal(calls.length, 3);
    assert.equal(calls[2]?.thread, "thread-2");
    assert.equal(calls[2]?.text, "After recovery");
    const recoveredUnknown = await bundle.stores.queue.getReceipt(owner, unknownRequestId);
    assert.equal(recoveredUnknown?.id, unknown.id);
    assert.equal(recoveredUnknown?.state, "failed");
    assert.equal(recoveredUnknown?.releasedAt, null);
    const recoveredMessage = (await bundle.stores.session.getSession(saved.id))?.messages[5];
    assert.equal(recoveredMessage?.text, "");
    assert.equal(recoveredMessage?.runFailure, recoveredUnknown?.reason);
    assert.equal((await bundle.stores.queue.getReceipt(owner, followerRequestId))?.id, follower.id);
    assert.equal((await bundle.stores.session.getSession(saved.id))?.threadId, "thread-3");
  } finally {
    releaseFirstReply.resolve();
    allowDispatch.resolve();
    finishFirst.resolve();
    await queue?.close();
    await bundle.client.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
