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
    async runSessionTurn(input: { signal: AbortSignal }) {
      if (options.providerCallCount) {
        options.providerCallCount.value += 1;
      }
      options.providerStarted?.resolve();
      if (options.releaseProvider) {
        await Promise.race([
          options.releaseProvider.promise,
          new Promise<never>((_, reject) => {
            if (input.signal.aborted) {
              options.abortObserved?.resolve();
              reject(new Error("canceled"));
              return;
            }
            input.signal.addEventListener("abort", () => {
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
  };
  return { service: new SessionRuntimeService(deps), session, saveCount: () => saveCount };
}

async function runRequest(service: SessionRuntimeService, sessionId: string): Promise<Session> {
  return service.runSessionTurn(sessionId, { userMessage: "hello", clientRequestId: crypto.randomUUID() });
}

describe("SessionRuntimeService session admission", () => {
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
  // distinction = "delete operationがadmissionを保持するbarrierで、turnのgetSessionが解放後にだけ進むことを確認する"
  // @end-test-value
  it("delete-first では削除後の Session を開始しない", async () => {
    const deleteStarted = deferred();
    const releaseDelete = deferred();
    let deleted = false;
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
      getSession: async () => deleted ? null : createSession(),
    });
    const deletion = runAdmission("session-1", async () => {
      deleteStarted.resolve();
      await releaseDelete.promise;
      deleted = true;
    });
    await deleteStarted.promise;
    const turn = runRequest(runtime.service, "session-1");
    releaseDelete.resolve();
    await deletion;
    await assert.rejects(turn, /対象セッションが見つからない/);
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
  // distinction = "sessionKind auxiliary のchildを実行し、親削除処理自体ではなく公開inFlight判定を直接確認する"
  // @end-test-value
  it("Auxiliary child の実行中状態を公開inFlight判定で観測する", async () => {
    const providerStarted = deferred();
    const releaseProvider = deferred();
    const session = createSession({ sessionKind: "auxiliary", parentSessionId: "parent-1" });
    const runtime = createRuntime({
      session,
      runSessionAdmissionExclusive: async (_sessionId, operation) => operation(),
      providerStarted,
      releaseProvider,
    });
    const turn = runRequest(runtime.service, session.id);
    await providerStarted.promise;
    assert.equal(runtime.service.isRunInFlight(session.id), true);
    releaseProvider.resolve();
    await turn;
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
