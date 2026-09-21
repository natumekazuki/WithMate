import assert from "node:assert/strict";
import crypto from "node:crypto";
import { describe, it } from "node:test";

import { buildNewSession, type Session } from "../../src/app-state.js";
import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import { normalizeAppSettings } from "../../src/provider-settings-state.js";
import {
  SessionRuntimeService,
  type SessionRuntimeServiceDeps,
} from "../../src-electron/session-runtime-service.js";
import { CharacterAffectTurnOwnershipCoordinator } from "../../src-electron/character-affect-turn-ownership-coordinator.js";
import { ProviderRuntimeOperationCoordinator } from "../../src-electron/provider-runtime-operation-coordinator.js";
import { admitSessionTurn } from "../../src-electron/session-turn-admission.js";
import type { ProviderCodingAdapter } from "../../src-electron/provider-runtime.js";
import { AuxiliarySessionService } from "../../src-electron/auxiliary-session-service.js";
import { AuxiliarySessionStorage } from "../../src-electron/auxiliary-session-storage.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function createSession(overrides: Partial<Session> = {}): Session {
  return {
    ...buildNewSession({
      taskTitle: "Admission test",
      workspaceLabel: "workspace",
      workspacePath: "C:/workspace",
      branch: "main",
      characterId: "char-a",
      character: "A",
      characterIconPath: "",
      characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
      approvalMode: DEFAULT_APPROVAL_MODE,
    }),
    ...overrides,
  };
}

function createRuntime(options: {
  session?: Session;
  getSession?: (sessionId: string) => Promise<Session | null>;
  runSessionAdmissionExclusive: SessionRuntimeServiceDeps["runSessionAdmissionExclusive"];
  providerStarted?: { resolve: () => void };
  abortObserved?: { resolve: () => void };
  providerCallCount?: { value: number };
  releaseProvider?: { promise: Promise<void> };
  providerCancelGraceMs?: number;
}): { service: SessionRuntimeService; session: Session; saveCount: () => number } {
  let session = options.session ?? createSession();
  let saveCount = 0;
  const adapter = {
    composePrompt: () => ({
      systemBodyText: "system",
      inputBodyText: "input",
      logicalPrompt: { systemText: "system", inputText: "input", composedText: "system\ninput" },
      imagePaths: [],
      additionalDirectories: [],
    }),
    async getProviderQuotaTelemetry() { return null; },
    async invalidateSessionThread() {},
    async invalidateAllSessionThreads() {},
    async runSessionTurn(input: Parameters<ProviderCodingAdapter["runSessionTurn"]>[0]) {
      const signal = input.signal;
      if (!signal) {
        throw new Error("test adapter requires an abort signal");
      }
      if (options.providerCallCount) {
        options.providerCallCount.value += 1;
      }
      options.providerStarted?.resolve();
      if (options.releaseProvider) {
        await Promise.race([
          options.releaseProvider.promise,
          new Promise<never>((_, reject) => {
            if (signal.aborted) {
              options.abortObserved?.resolve();
              reject(new Error("canceled"));
              return;
            }
            signal.addEventListener("abort", () => {
              options.abortObserved?.resolve();
              reject(new Error("canceled"));
            }, { once: true });
          }),
        ]);
      }
      return {
        threadId: null,
        assistantText: "ok",
        logicalPrompt: { systemText: "system", inputText: "input", composedText: "system\ninput" },
        transportPayload: null,
        operations: [],
        rawItemsJson: "[]",
        usage: null,
      };
    },
  };
  const deps: SessionRuntimeServiceDeps = {
    runSessionAdmissionExclusive: options.runSessionAdmissionExclusive,
    getSession: options.getSession ?? (async (sessionId) => sessionId === session.id ? session : null),
    upsertSession(next) {
      session = next;
      saveCount += 1;
      return next;
    },
    resolveComposerPreview: async () => ({ attachments: [], errors: [] }),
    getAppSettings: () => normalizeAppSettings({}),
    resolveProviderCatalog: () => ({
      snapshot: { revision: 1, providers: [{
        id: "codex",
        label: "Codex",
        defaultModelId: "gpt-5.4",
        defaultReasoningEffort: "high",
        models: [{ id: "gpt-5.4", label: "GPT-5.4", reasoningEfforts: ["high"] }],
      }] },
      provider: {
        id: "codex",
        label: "Codex",
        defaultModelId: "gpt-5.4",
        defaultReasoningEffort: "high",
        models: [{ id: "gpt-5.4", label: "GPT-5.4", reasoningEfforts: ["high"] }],
      },
    }),
    getProviderCodingAdapter: () => adapter,
    getSessionMemory: async (current) => ({
      sessionId: current.id,
      workspacePath: current.workspacePath,
      threadId: "",
      schemaVersion: 1,
      goal: "",
      decisions: [],
      openQuestions: [],
      nextActions: [],
      notes: [],
      updatedAt: new Date().toISOString(),
    }),
    resolveProjectMemoryEntriesForPrompt: async () => [],
    createAuditLog: async (input) => ({ id: saveCount + 1, ...input }),
    updateAuditLog: async () => undefined,
    setLiveSessionRun: () => undefined,
    getLiveSessionRun: () => null,
    waitForApprovalDecision: () => "approve",
    waitForElicitationResponse: () => ({ action: "cancel" }),
    setProviderQuotaTelemetry: () => undefined,
    setSessionContextTelemetry: () => undefined,
    invalidateProviderSessionThread: async () => undefined,
    scheduleProviderQuotaTelemetryRefresh: () => undefined,
    broadcastLiveSessionRun: () => undefined,
    resolvePendingApprovalRequest: () => undefined,
    resolvePendingElicitationRequest: () => undefined,
    providerCancelGraceMs: options.providerCancelGraceMs,
  };
  return { service: new SessionRuntimeService(deps), session, saveCount: () => saveCount };
}

async function runRequest(service: SessionRuntimeService, sessionId: string): Promise<Session> {
  return service.runSessionTurn(sessionId, { userMessage: "hello", clientRequestId: crypto.randomUUID() });
}

describe("SessionRuntimeService session admission", () => {
  // @test-value v2
  // kind = "invariant"
  // claim = "Session turn reservationだけをglobal coordinator内で確定し、Worker read待機中も無関係なcoordinator操作を進められる"
  // oracle = { type = "contract", ref = "src-electron/session-turn-admission.ts#admitSessionTurn" }
  // fault = "provider/ownership coordinatorをWorker read完了まで保持し、無関係なmaintenance操作を不必要に待たせる"
  // observable = "readProvider barrier中のreservation、無関係なcoordinator操作の完了、最終provider validation後の開始"
  // observation_boundary = "component-behavior"
  // scope = "session-turn-admission-worker-read-barrier"
  // lifecycle = "permanent"
  // impact = "Worker準備の待機がSession削除・Settings変更など無関係なglobal操作を停止させず、同一Sessionのstarting guardだけを維持する"
  // distinction = "実装済みadmitSessionTurnを実Coordinatorで接続し、readProviderを待機させたまま別操作を同じCoordinatorへ投入して観測する"
  // @end-test-value
  it("Worker read待機中もreservationを保持したまま無関係なcoordinator操作を進める", { timeout: 10_000 }, async () => {
    const provider = new ProviderRuntimeOperationCoordinator();
    const ownership = new CharacterAffectTurnOwnershipCoordinator();
    const readStarted = deferred();
    const releaseRead = deferred();
    const providerCallCount = { value: 0 };
    const runtime = createRuntime({
      providerCallCount,
      runSessionAdmissionExclusive: (_sessionId, reserve, signal) => admitSessionTurn({
        runExclusive: (operation) => provider.runExclusive(() => ownership.runExclusive(operation)),
        assertCurrent: () => signal.throwIfAborted(),
        reserve,
        readProvider: async () => {
          readStarted.resolve();
          await releaseRead.promise;
          return "codex";
        },
        assertProviderAvailable: (providerId) => assert.equal(providerId, "codex"),
      }),
    });
    const admission = runRequest(runtime.service, runtime.session.id);
    await readStarted.promise;

    await provider.runExclusive(() => ownership.runExclusive(() => {
      assert.equal(runtime.service.isRunInFlight(runtime.session.id), true);
      assert.equal(providerCallCount.value, 0);
    }));
    releaseRead.resolve();
    await admission;
    assert.equal(providerCallCount.value, 1);
    assert.equal(runtime.service.isRunInFlight(runtime.session.id), false);
  });

  // @test-value v2
  // kind = "regression"
  // claim = "read/owner/provider validation失敗またはcancel/resetでprovider開始前にreservationを解放し、owner失効以外は同じruntimeで再試行できる"
  // oracle = { type = "contract", ref = "src-electron/session-turn-admission.ts#admitSessionTurn; src-electron/session-runtime-service.ts#runSessionTurn" }
  // fault = "Worker readまたは最終validationの失敗後もstarting reservationが残り、providerを開始できない孤児状態になる"
  // observable = "失敗時のprovider開始回数0、reservation解放、同一Sessionの再試行成功"
  // observation_boundary = "component-behavior"
  // scope = "session-turn-admission-failure-cleanup"
  // lifecycle = "permanent"
  // impact = "DB reset・owner invalidation・cancel・provider catalog拒否で失敗したturnが後続送信を恒久的に塞がない"
  // distinction = "実admitSessionTurnとSessionRuntimeServiceを実Coordinatorへ接続し、読取・最終検証・取消の各失敗後の公開inFlight判定とprovider呼出しを観測する"
  // @end-test-value
  it("validation失敗時はprovider開始前にreservationを解放して再試行できる", async () => {
    for (const failure of ["read", "owner", "provider", "cancel", "reset"] as const) {
      const provider = new ProviderRuntimeOperationCoordinator();
      const ownership = new CharacterAffectTurnOwnershipCoordinator();
      const providerCallCount = { value: 0 };
      let failing = true;
      let ownerChanged = false;
      const runtime = createRuntime({
        providerCallCount,
        runSessionAdmissionExclusive: (_sessionId, reserve, signal) => admitSessionTurn({
          runExclusive: (operation) => provider.runExclusive(() => ownership.runExclusive(operation)),
          assertCurrent: () => {
            if (ownerChanged) throw new Error("owner is no longer active");
            if (signal.aborted) throw new Error("Session run canceled.");
          },
          reserve,
          readProvider: async () => {
            assert.equal(runtime.service.isRunInFlight(runtime.session.id), true);
            if (failing) {
              if (failure === "read") throw new Error("read failed");
              if (failure === "owner") ownerChanged = true;
              if (failure === "cancel") runtime.service.cancelRun(runtime.session.id);
              if (failure === "reset") runtime.service.reset();
            }
            return "codex";
          },
          assertProviderAvailable: () => {
            if (failing && failure === "provider") throw new Error("provider is unavailable");
          },
        }),
      });
      await assert.rejects(runRequest(runtime.service, runtime.session.id), /read failed|owner is no longer active|canceled|provider is unavailable/);
      assert.equal(providerCallCount.value, 0, failure);
      assert.equal(runtime.saveCount(), 0, failure);
      assert.equal(runtime.service.isRunInFlight(runtime.session.id), false, failure);
      if (failure !== "owner") {
        failing = false;
        await runRequest(runtime.service, runtime.session.id);
        assert.equal(providerCallCount.value, 1, failure);
      }
    }
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "Session turn は削除 admission と直列化し、delete-first では削除後に開始しない"
  // oracle = { type = "contract", ref = "src-electron/session-runtime-service.ts#runSessionTurn" }
  // fault = "DB削除待機中にturnが先にstarting登録され、削除済みsessionを再作成する"
  // observable = "delete admission 完了後のturnが対象session不在で失敗し、保存を行わない"
  // observation_boundary = "public-boundary"
  // scope = "session-turn-admission-delete-first"
  // lifecycle = "permanent"
  // impact = "Session / Auxiliary parent削除とturn開始の競合で削除済みownerを再利用しない"
  // distinction = "実coordinatorのdelete barrierと本番admission helperを接続し、turnの読込みが削除完了後にだけ発行されることを確認する"
  // @end-test-value
  it("delete-first では削除後の Session を開始しない", async () => {
    const deleteStarted = deferred();
    const releaseDelete = deferred();
    let deleted = false;
    let reads = 0;
    const provider = new ProviderRuntimeOperationCoordinator();
    const ownership = new CharacterAffectTurnOwnershipCoordinator();
    const runAdmission = <T>(_sessionId: string, operation: () => T | Promise<T>): Promise<T> =>
      provider.runExclusive(() => ownership.runExclusive(operation));
    const runtime = createRuntime({
      runSessionAdmissionExclusive: (sessionId, reserve, signal) => admitSessionTurn({
        runExclusive: (operation) => runAdmission(sessionId, operation),
        assertCurrent: () => signal.throwIfAborted(),
        reserve,
        readProvider: async () => {
          reads += 1;
          if (deleted) throw new Error("対象セッションが見つからないよ。");
          return "codex";
        },
        assertProviderAvailable: () => undefined,
      }),
      getSession: async () => deleted ? null : createSession(),
    });
    const deletion = runAdmission("session-1", async () => {
      deleteStarted.resolve();
      await releaseDelete.promise;
      deleted = true;
    });
    await deleteStarted.promise;
    const turn = runRequest(runtime.service, "session-1");
    const rejection = assert.rejects(turn, /対象セッションが見つからない/);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(reads, 0);
    assert.equal(runtime.service.isRunInFlight("session-1"), false);
    releaseDelete.resolve();
    await deletion;
    await rejection;
    assert.equal(reads, 1);
    assert.equal(runtime.service.isRunInFlight("session-1"), false);
    assert.equal(runtime.saveCount(), 0);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "Session turn は短い admission 内で starting 登録を行い、長い準備処理を admission 外で進める"
  // oracle = { type = "contract", ref = "src-electron/session-runtime-service.ts#runSessionTurn" }
  // fault = "turnの長い準備処理までglobal admissionを保持し、無関係なdeleteやturnを不必要に待たせる"
  // observable = "starting登録後のdeleteが拒否され、getSession以降の準備処理はadmission外で継続する"
  // observation_boundary = "public-boundary"
  // scope = "session-turn-admission-start-first"
  // lifecycle = "permanent"
  // impact = "実行開始済みSessionを削除してprovider実行と永続化を分離しない"
  // distinction = "getSession barrier中のdelete attemptをrun admission後のinFlight stateで判定する"
  // @end-test-value
  it("start-first では削除が inFlight guard により拒否される", { timeout: 10_000 }, async () => {
    const getStarted = deferred();
    const releaseGet = deferred();
    const providerStarted = deferred();
    const releaseProvider = deferred();
    let tail = Promise.resolve();
    const runAdmission = async <T>(_sessionId: string, operation: () => T | Promise<T>): Promise<T> => {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      try { return await operation(); } finally { release(); }
    };
    const session = createSession({ id: "session-1" });
    const runtime = createRuntime({
      session,
      runSessionAdmissionExclusive: runAdmission,
      getSession: async () => {
        getStarted.resolve();
        await releaseGet.promise;
        return session;
      },
      providerStarted,
      releaseProvider,
    });
    const turn = runRequest(runtime.service, session.id);
    await getStarted.promise;
    const deleteAttempt = runAdmission(session.id, () => {
      if (runtime.service.isRunInFlight(session.id)) {
        throw new Error("削除対象のSessionは実行中です。");
      }
      return undefined;
    });
    await assert.rejects(deleteAttempt, /実行中/);
    releaseGet.resolve();
    await providerStarted.promise;
    releaseProvider.resolve();
    await turn;
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "Auxiliary child turn は公開inFlight判定で実行中状態を観測できる"
  // oracle = { type = "contract", ref = "src-electron/session-runtime-service.ts#runSessionTurn" }
  // fault = "Auxiliary childのstarting登録後も実行中状態が公開判定へ反映されない"
  // observable = "Auxiliary child turn中のisRunInFlight(sessionId)"
  // observation_boundary = "public-boundary"
  // scope = "auxiliary-parent-turn-admission"
  // lifecycle = "permanent"
  // impact = "Auxiliary childを対象とする削除・操作guardが実行中状態を正しく参照できる"
  // distinction = "実storageからAuxiliary runtime projectionを取得してchild IDで実行し、親削除処理自体ではなく公開inFlight判定を直接確認する"
  // @end-test-value
  it("Auxiliary child の実行中状態を公開inFlight判定で観測する", async () => {
    const providerStarted = deferred();
    const releaseProvider = deferred();
    const parent = createSession();
    const storage = new AuxiliarySessionStorage(":memory:");
    try {
      const auxiliary = storage.upsertAuxiliarySession({
        id: "auxiliary-child",
        parentSessionId: parent.id,
        status: "active",
        runState: "idle",
        title: "Auxiliary",
        provider: parent.provider,
        catalogRevision: parent.catalogRevision,
        model: parent.model,
        reasoningEffort: parent.reasoningEffort,
        approvalMode: parent.approvalMode,
        codexSandboxMode: parent.codexSandboxMode,
        codexSpeed: parent.codexSpeed,
        codexReviewer: parent.codexReviewer,
        customAgentName: parent.customAgentName,
        allowedAdditionalDirectories: [],
        threadId: "",
        messages: [],
        composerDraft: "",
        displayAfterMessageIndex: null,
        createdAt: "2026-09-21T00:00:00.000Z",
        updatedAt: "2026-09-21T00:00:00.000Z",
        closedAt: "",
      });
      const auxiliaryService = new AuxiliarySessionService({
        getStorage: () => storage,
        getParentSession: (id) => id === parent.id ? parent : null,
        runProviderRuntimeOperationExclusive: async (operation) => operation(),
        resolveSessionLaunchSelection: async () => { throw new Error("unexpected launch selection"); },
        listActiveCharacters: () => { throw new Error("unexpected character listing"); },
        createCharacterRuntimeSnapshot: () => { throw new Error("unexpected snapshot creation"); },
      });
      const session = await auxiliaryService.getAuxiliaryRuntimeSession(auxiliary.id);
      assert.ok(session);
      assert.equal(session.id, auxiliary.id);
      assert.equal(session.sessionKind, parent.sessionKind);
      const runtime = createRuntime({
        session,
        runSessionAdmissionExclusive: async (_sessionId, operation) => operation(),
        providerStarted,
        releaseProvider,
      });
      const turn = runRequest(runtime.service, session.id);
      try {
        await providerStarted.promise;
        assert.equal(runtime.service.isRunInFlight(auxiliary.id), true);
        assert.equal(runtime.service.isRunInFlight(parent.id), false);
      } finally {
        releaseProvider.resolve();
        await turn;
      }
    } finally {
      storage.close();
    }
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "admission待機中のSession turn cancelを安全に処理する"
  // oracle = { type = "contract", ref = "src-electron/session-runtime-service.ts#runSessionTurn" }
  // fault = "admission待機中のcancelが遅れてproviderを開始する"
  // observable = "cancel後のprovider呼出し回数が0でadmissionが解放される"
  // observation_boundary = "public-boundary"
  // scope = "session-turn-admission-cancel"
  // lifecycle = "permanent"
  // impact = "送信連打と削除待ちcancelでSession runが重複・孤児化しない"
  // distinction = "admission barrier中のcontroller cancelを使い、provider開始前の拒否を観測する"
  // @end-test-value
  it("admission待機中cancelでproviderを開始しない", async () => {
    const releaseAdmission = deferred();
    const providerCallCount = { value: 0 };
    let hold = true;
    const runAdmission = async <T>(_sessionId: string, operation: () => T | Promise<T>): Promise<T> => {
      if (hold) await releaseAdmission.promise;
      return operation();
    };
    const runtime = createRuntime({
      runSessionAdmissionExclusive: runAdmission,
      providerCallCount,
    });
    const sessionId = runtime.session.id;
    const first = runRequest(runtime.service, sessionId);
    await Promise.resolve();
    runtime.service.cancelRun(sessionId);
    hold = false;
    releaseAdmission.resolve();
    await assert.rejects(first, /canceled|cancel/i);
    assert.equal(providerCallCount.value, 0);
  });

  // @test-value v2
  // kind = "regression"
  // claim = "開始予約後のadmission読込み待機をcancel grace内で応答し、元処理の終了までSessionをterminatingとして保持する"
  // oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md#session-run-cancel" }
  // fault = "admissionの読込み待機が監視外でcancel後も要求が未決着になる、または要求だけ終了させ元処理と再送が競合する"
  // observable = "grace後の要求拒否、terminating中の再送拒否、admission解放後のinFlight解除、provider未開始"
  // observation_boundary = "public-boundary"
  // scope = "session-turn-admission-cancel-grace"
  // lifecycle = "permanent"
  // impact = "cancel後の未終了admissionと後続turnの重複を防ぎ、providerを開始しない"
  // distinction = "実admitSessionTurnの予約後readをcancel grace超過まで保留し、待機Promiseとterminating guardの寿命を観測する"
  // @end-test-value
  it("admission待機がcancel graceを超えても終了までterminating guardを保持する", { timeout: 5_000 }, async () => {
    const provider = new ProviderRuntimeOperationCoordinator();
    const ownership = new CharacterAffectTurnOwnershipCoordinator();
    const readStarted = deferred();
    const releaseRead = deferred();
    const providerCallCount = { value: 0 };
    const runtime = createRuntime({
      providerCallCount,
      providerCancelGraceMs: 5,
      runSessionAdmissionExclusive: (_sessionId, reserve, signal) => admitSessionTurn({
        runExclusive: (operation) => provider.runExclusive(() => ownership.runExclusive(operation)),
        assertCurrent: () => signal.throwIfAborted(),
        reserve,
        readProvider: async () => {
          readStarted.resolve();
          await releaseRead.promise;
          return "codex";
        },
        assertProviderAvailable: (providerId) => assert.equal(providerId, "codex"),
      }),
    });
    const first = runRequest(runtime.service, runtime.session.id);
    await readStarted.promise;
    runtime.service.cancelRun(runtime.session.id);
    try {
      const outcome = await Promise.race([
        first.then(() => "resolved", () => "rejected"),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("cancel grace test timed out")), 250)),
      ]);
      assert.equal(outcome, "rejected");
      assert.equal(runtime.service.isRunInFlight(runtime.session.id), true);
      await assert.rejects(
        runRequest(runtime.service, runtime.session.id),
        /まだ実行中/,
      );
    } finally {
      releaseRead.resolve();
    }
    await first.catch(() => undefined);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(runtime.service.isRunInFlight(runtime.session.id), false);
    assert.equal(providerCallCount.value, 0);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "admission拒否で終了したqueued turnのcancel状態を次回turnへ持ち越さない"
  // oracle = { type = "contract", ref = "src-electron/session-runtime-service.ts#runSessionTurn" }
  // fault = "admission待機中cancel後の排他失敗でpending cancelを残し、後続turnを誤って取り消す"
  // observable = "admission rejection後の次回turnが正常完了する"
  // observation_boundary = "public-boundary"
  // scope = "session-turn-admission-rejection-cleanup"
  // lifecycle = "permanent"
  // impact = "一時的なadmission失敗が後続のユーザー送信へ影響しない"
  // distinction = "cancelを先に受けた待機turnをadmission側でrejectし、同一Sessionの次回turnを実行する"
  // @end-test-value
  it("admission rejection後にqueued cancelを持ち越さない", async () => {
    const releaseAdmission = deferred();
    let rejectAdmission = true;
    const runAdmission = async <T>(_sessionId: string, operation: () => T | Promise<T>): Promise<T> => {
      await releaseAdmission.promise;
      if (rejectAdmission) {
        throw new Error("admission failed");
      }
      return operation();
    };
    const runtime = createRuntime({
      runSessionAdmissionExclusive: runAdmission,
    });
    const first = runRequest(runtime.service, runtime.session.id);
    await Promise.resolve();
    runtime.service.cancelRun(runtime.session.id);
    releaseAdmission.resolve();
    await assert.rejects(first, /admission failed/);

    rejectAdmission = false;
    const second = runRequest(runtime.service, runtime.session.id);
    await second;
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "実行中でないSessionへのcancelは次回turnへ取消状態を持ち越さない"
  // oracle = { type = "contract", ref = "src-electron/session-runtime-service.ts#cancelRun" }
  // fault = "idle cancelをpending取消として残し、後続turnを開始直後に取り消す"
  // observable = "idle cancel後に開始したturnの正常完了"
  // observation_boundary = "public-boundary"
  // scope = "session-turn-cancel-idle"
  // lifecycle = "permanent"
  // impact = "無関係なcancel IPCが後続の通常Session turnを取り消さない"
  // distinction = "admission待機中のcancelとは別にcontrollerもadmission待機もない状態でcancelし、次のturnを完了させる"
  // @end-test-value
  it("idle cancelは次回turnを取り消さない", async () => {
    const runtime = createRuntime({
      runSessionAdmissionExclusive: async (_sessionId, operation) => operation(),
    });
    runtime.service.cancelRun(runtime.session.id);
    await runRequest(runtime.service, runtime.session.id);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "同一 Session の二重 start は inFlight admission で拒否する"
  // oracle = { type = "contract", ref = "src-electron/session-runtime-service.ts#runSessionTurn" }
  // fault = "provider turn中の再送が二つ目のstarting/inFlight runを作る"
  // observable = "二つ目のrunが拒否され、最初のrunだけが完了する"
  // observation_boundary = "public-boundary"
  // scope = "session-turn-admission-double-start"
  // lifecycle = "permanent"
  // impact = "同一 Session の重複 turn と二重 provider 実行を防ぐ"
  // distinction = "provider barrierで一つ目をinFlightに保持した状態の二つ目のadmissionを観測する"
  // @end-test-value
  it("inFlight 中の二重 start を拒否する", async () => {
    const providerStarted = deferred();
    const releaseProvider = deferred();
    const abortObserved = deferred();
    const providerCallCount = { value: 0 };
    let tail = Promise.resolve();
    const runAdmission = async <T>(_sessionId: string, operation: () => T | Promise<T>): Promise<T> => {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      try { return await operation(); } finally { release(); }
    };
    const runtime = createRuntime({
      runSessionAdmissionExclusive: runAdmission,
      providerStarted,
      releaseProvider,
      abortObserved,
      providerCallCount,
    });
    const first = runRequest(runtime.service, runtime.session.id);
    await providerStarted.promise;
    await assert.rejects(
      runRequest(runtime.service, runtime.session.id),
      /実行中/,
    );
    assert.equal(providerCallCount.value, 1);
    runtime.service.cancelRun(runtime.session.id);
    await abortObserved.promise;
    releaseProvider.resolve();
    await first;
  });
});
