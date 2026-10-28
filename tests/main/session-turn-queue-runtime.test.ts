import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createV6StorageWorkerBundle } from "../../src-electron/storage/storage-worker-bundle.js";
import { createMainSessionRuntime } from "../../src-electron/app/main-session-runtime-assembly.js";
import { MainSessionTurnQueueFacade } from "../../src-electron/app/main-session-turn-queue-facade.js";
import { SessionPersistenceService } from "../../src-electron/session/session-persistence-service.js";
import { SessionTurnQueueService } from "../../src-electron/session/session-turn-queue-service.js";
import { sessionSummaryToSession } from "../../src-electron/session/session-summary-adapter.js";
import { assertCapturedComposerAttachmentsAvailable, resolveComposerPreview } from "../../src-electron/files/composer-attachments.js";
import { buildNewSession, getSessionIncarnationId, type Session } from "../../src-shared/session/session-state.js";
import { captureSessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";
import { normalizeAppSettings } from "../../src-shared/settings/provider-settings-state.js";
import type { LiveSessionRunState } from "../../src-shared/session/runtime-state.js";
import type { ProviderCodingAdapter } from "../../src-electron/providers/provider-runtime.js";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

// @test-value v2
// kind = "contract"
// claim = "実Worker queued実行は捕捉入力/threadを維持し、受付/terminal返信喪失は正本へ収束し、開始保存後の不明結果は明示回復とguard解放後にFIFOを進める"
// oracle = { type = "contract", ref = "GitHub Issue #801: durable FIFO captured input and atomic turn start; docs/design/session-run-lifecycle.md" }
// fault = "捕捉入力/thread進行を失うか、保存返信喪失で再実行するか、明示回復後の保存runningが後続を不明結果へ連鎖させる"
// observable = "受付mutation/preview回数、Provider入力/呼出順、実Worker receipt/minimum turn ID、guard保持中のrunning metadataと後続queued、回復後のthreadと終端状態"
// observation_boundary = "public-boundary"
// scope = "MainSessionRuntimeAssembly + QueueFacade/Service + SessionPersistenceService + V6StorageWorkerBundle"
// lifecycle = "permanent"
// impact = "受付した指示が異なる設定/pathで実行される、同じ会話が重複実行される、receiptと履歴が乖離することを防ぐ"
// distinction = "個別fake port testではMain owner guard・async Worker proxy・partial persistenceの実結合を検証できない"
// @end-test-value
test("Main queued runtimeは実Worker保存でFIFO捕捉とthread継承を結合する", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "withmate-queue-runtime-"));
  const bundle = createV6StorageWorkerBundle({ dbPath: path.join(temporary, "withmate-v6.db"), userDataPath: temporary });
  let queue: SessionTurnQueueService | undefined;
  const finishFirst = gate();
  try {
    await bundle.initialize();
    await writeFile(path.join(temporary, "input.txt"), "captured path fixture");
    const saved = await bundle.stores.session.insertSession(buildNewSession({ id: "queue-runtime", taskTitle: "Queue", workspaceLabel: "workspace",
      workspacePath: temporary, branch: "main", characterId: "unknown", character: "Unknown", characterIconPath: "",
      characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" }, approvalMode: "on-request",
      model: "captured-native-model", reasoningEffort: "native-depth" }));
    const owner = { sessionId: saved.id, incarnationId: getSessionIncarnationId(saved) };
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
      syncSessionDependencies() {}, clearSessionContextTelemetry() {}, clearSessionBackgroundActivities() {},
      invalidateProviderSessionThread() {}, closeSessionWindow() {}, broadcastSessions() {},
    });
    const startedFirst = gate();
    const calls: Array<{ text: string; thread: string; model: string; depth: string; attachment: string }> = [];
    const firstRequestId = randomUUID();
    const secondRequestId = randomUUID();
    const unknownRequestId = randomUUID();
    const followerRequestId = randomUUID();
    let rejectStarted = false;
    let cleanupGuard = false;
    let dispatches = 0;
    let acceptanceWrites = 0;
    const adapter: ProviderCodingAdapter = {
      composePrompt: () => ({ systemBodyText: "system", inputBodyText: "input", logicalPrompt: { systemText: "system", inputText: "input", composedText: "system\ninput" }, imagePaths: [], additionalDirectories: [] }),
      getProviderQuotaTelemetry: async () => null, invalidateSessionThread: async () => {}, invalidateAllSessionThreads: async () => {},
      runSessionTurn: async (input) => {
        const requestId = calls.length === 0 ? firstRequestId : calls.length === 1 ? secondRequestId : followerRequestId;
        const receipt = await bundle.stores.queue.getReceipt(owner, requestId);
        const turn = await bundle.stores.turn.getLatestSessionTurn(saved.id);
        assert.equal(receipt?.state, "running");
        assert.equal(receipt?.turnId, String(turn?.id));
        assert.equal(receipt?.userMessageSeq, turn?.userMessageSeq);
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
      memory: { getAppSettings: () => normalizeAppSettings({}), resolveProjectMemoryEntriesForPrompt: () => [], onCharacterContextFailure() {} },
      turn: { createSessionTurn: (input) => bundle.stores.turn.createSessionTurn(input), updateSessionTurn: (id, input) => bundle.stores.turn.updateSessionTurn(id, input) },
      live: { setLiveSessionRun: (_, next) => { live = next; }, getLiveSessionRun: () => live,
        setProviderQuotaTelemetry() {}, setSessionContextTelemetry() {}, scheduleProviderQuotaTelemetryRefresh() {}, broadcastLiveSessionRun() {} },
      interaction: { waitForApprovalDecision: () => "approve", waitForElicitationResponse: () => ({ action: "cancel" }),
        resolvePendingApprovalRequest() {}, resolvePendingElicitationRequest() {}, invalidateProviderSessionThread() {} },
      notification: { onSessionRunReleased: (id) => queue?.wake(id) }, timing: {},
    });
    const enqueueWithLostReply = async (...args: Parameters<typeof bundle.stores.queue.enqueue>) => {
      const receipt = await bundle.stores.queue.enqueue(...args);
      acceptanceWrites += 1;
      if (acceptanceWrites === 1) throw new Error("Durable acceptance acknowledgement lost");
      return receipt;
    };
    const queueStore = new Proxy(bundle.stores.queue, {
      get: (target, property) => property === "enqueue" ? enqueueWithLostReply : Reflect.get(target, property),
    });
    queue = new SessionTurnQueueService({ store: queueStore, isRunInFlight: (id) => cleanupGuard || runtime.isRunInFlight(id),
      dispatch: (receipt, started) => {
        dispatches += 1;
        return runtime.runQueuedSessionTurn(receipt, async (input) => {
          if (rejectStarted) { rejectStarted = false; cleanupGuard = true; throw new Error("Atomic start acknowledgement lost"); }
          await started(input);
        });
      } });
    await queue.start();
    let previews = 0;
    const facade = new MainSessionTurnQueueFacade({ assertActive() {}, assertAccepting() {}, getSession,
      validateWorkspace: async () => {}, validateProvider: async () => ({ provider }),
      preview: async (session, text) => { previews += 1; return resolveComposerPreview(session, text); }, store: bundle.stores.queue, service: queue });
    const options = captureSessionExecutionOptions(saved);
    const firstInput = { incarnationId: owner.incarnationId, clientRequestId: firstRequestId,
      submitSource: "composer" as const, userMessage: "First @input.txt", executionOptions: options };
    await assert.rejects(facade.enqueueSessionTurn(saved.id, firstInput), /Durable acceptance acknowledgement lost/);
    assert.equal(dispatches, 0);
    const reconciled = await facade.getSessionTurnQueueReceipt(saved.id, firstRequestId);
    const first = await facade.enqueueSessionTurn(saved.id, firstInput);
    assert.equal(first.id, reconciled?.id);
    assert.equal(acceptanceWrites, 1);
    assert.equal(previews, 1);
    await startedFirst.promise;
    const secondInput = { incarnationId: owner.incarnationId, clientRequestId: secondRequestId, submitSource: "composer" as const,
      userMessage: "Second @input.txt", executionOptions: { ...options, reasoningEffort: "medium" as const } };
    const second = await facade.enqueueSessionTurn(saved.id, secondInput);
    secondInput.userMessage = "Edited after durable ACK";
    secondInput.executionOptions = { ...secondInput.executionOptions, model: "invalid-after-ACK" };
    assert.equal(calls.length, 1);
    finishFirst.resolve();
    await queue.waitForPending();
    await runtime.waitForPendingRuns();
    assert.deepEqual(calls, [
      { text: "First @input.txt", thread: "", model: options.model, depth: options.reasoningEffort, attachment: path.join(temporary, "input.txt") },
      { text: "Second @input.txt", thread: "thread-1", model: options.model, depth: "medium", attachment: path.join(temporary, "input.txt") },
    ]);
    assert.equal(previews, 2);
    const page = await bundle.stores.queue.listReceipts(owner);
    assert.deepEqual(page.receipts.map((receipt) => [receipt.id, receipt.state, receipt.userMessageSeq]), [[first.id, "completed", 0], [second.id, "completed", 2]]);
    assert.notEqual(page.receipts[0]!.turnId, page.receipts[1]!.turnId);
    const stored = await bundle.stores.session.getSession(saved.id);
    assert.deepEqual(stored?.messages.map((message) => message.text), ["First @input.txt", "answer-1", "Second @input.txt", "answer-2"]);
    assert.equal(stored?.threadId, "thread-2");

    rejectStarted = true;
    const unknown = await facade.enqueueSessionTurn(saved.id, { incarnationId: owner.incarnationId, clientRequestId: unknownRequestId,
      submitSource: "composer", userMessage: "Unknown start", executionOptions: options });
    await queue.waitForPending();
    assert.equal((await bundle.stores.queue.getReceipt(owner, unknownRequestId))?.state, "interrupted");
    const follower = await facade.enqueueSessionTurn(saved.id, { incarnationId: owner.incarnationId, clientRequestId: followerRequestId,
      submitSource: "composer", userMessage: "After recovery", executionOptions: options });
    await queue.releaseInterrupted(owner, unknown.id);
    await queue.waitForPending();
    assert.equal(dispatches, 3);
    assert.equal((await bundle.stores.session.getSession(saved.id))?.runState, "running");
    assert.equal((await bundle.stores.queue.getReceipt(owner, followerRequestId))?.state, "queued");
    cleanupGuard = false;
    queue.wake(saved.id);
    await queue.waitForPending();
    await runtime.waitForPendingRuns();
    assert.equal(dispatches, 4);
    assert.equal((await bundle.stores.queue.getReceipt(owner, followerRequestId))?.state, "completed",
      (await bundle.stores.queue.getReceipt(owner, followerRequestId))?.reason ?? "Follower must complete");
    assert.equal(calls.length, 3);
    assert.equal(calls[2]?.thread, "thread-2");
    assert.equal(calls[2]?.text, "After recovery");
    const recoveredUnknown = await bundle.stores.queue.getReceipt(owner, unknownRequestId);
    assert.equal(recoveredUnknown?.state, "interrupted");
    assert.ok(recoveredUnknown?.releasedAt);
    assert.equal((await bundle.stores.queue.getReceipt(owner, followerRequestId))?.id, follower.id);
    assert.equal((await bundle.stores.session.getSession(saved.id))?.threadId, "thread-3");
  } finally {
    finishFirst.resolve();
    await queue?.close();
    await bundle.client.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
