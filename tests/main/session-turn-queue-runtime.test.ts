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
import type { ProviderCodingAdapter, RunSessionTurnInput } from "../../src-electron/providers/provider-runtime.js";
import { composeProviderPrompt } from "../../src-electron/providers/provider-prompt.js";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

// @test-value v2
// kind = "contract"
// claim = "初回受付で実行枠を同時確保し、後続の固定入力・Provider thread・会話枠を保持する。終端返信喪失は正本を保持し、開始保存の返信不明は起動回収後に後続だけを実行する"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md#gui-turn-queue; docs/design/electron-session-store.md#turn-queue; docs/design/prompt-composition.md#metadataと必要時取得" }
// fault = "即時開始の受付を先にqueuedでcommitまたは通知する、同時送信も開始する、受付後に入力や表示所属が変わる、または不明実行を自動再送する"
// observable = "Worker commit直後と受付通知からの一覧、ACK、保存receipt、Provider入力に含む会話枠と呼出順、公開履歴seq、実WorkerのTurn状態と再起動後のthread・終端"
// observation_boundary = "public-boundary"
// scope = "MainSessionRuntimeAssembly + QueueFacade/Service + SessionPersistenceService + V6StorageWorkerBundle"
// lifecycle = "permanent"
// impact = "受付した指示が異なる設定/pathで実行される、同じ会話が重複実行される、receiptと履歴が乖離することを防ぐ"
// distinction = "個別fake port testではMain owner guard・async Worker proxy・partial persistenceの実結合を検証できない"
// @end-test-value
test("Main queued runtimeは実Worker保存でFIFO捕捉とthread継承を結合する", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "withmate-queue-runtime-"));
  const bundleOptions = { dbPath: path.join(temporary, "withmate-v6.db"), userDataPath: temporary };
  let bundle = createV6StorageWorkerBundle(bundleOptions);
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
      context: { getAppSettings: () => normalizeAppSettings({}),  },
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
    allowDispatch.resolve();
    await startedFirst.promise;
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
    await queue.waitForPending();
    assert.equal(dispatches, 3);
    assert.equal((await bundle.stores.session.getSession(saved.id))?.runState, "running");
    assert.equal((await bundle.stores.queue.getReceipt(owner, followerRequestId))?.state, "queued");
    await queue.close();
    await bundle.client.close();
    bundle = createV6StorageWorkerBundle(bundleOptions);
    await bundle.initialize();
    cleanupGuard = false;
    queue = new SessionTurnQueueService({ store: bundle.stores.queue, isRunInFlight: (id) => runtime.isRunInFlight(id),
      dispatch: (receipt, started, control) => { dispatches++; return runtime.runQueuedSessionTurn(receipt, started, control); } });
    await queue.start();
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
