import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createAuxiliarySessionPendingLiveRunClearer,
  createAuxiliarySessionRunningApplier,
  createAuxiliarySessionSendResultAppliers,
  handleAuxiliarySessionSendOperationResult,
  runAuxiliarySessionSendOperation,
  runAuxiliarySessionSendOperationWithApi,
} from "../../src/chat/auxiliary/auxiliary-session-send-operation.js";
import type { AuxiliarySession } from "../../src-shared/auxiliary/auxiliary-session-state.js";
import type { OwnedLiveSessionRunState } from "../../src/chat/runtime/session-live-run-state.js";
import { captureSessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";
import { ComposerControllerRegistry } from "../../src/chat/composer-controller.js";

function makeAuxiliarySession(overrides: Partial<AuxiliarySession> = {}): AuxiliarySession {
  return {
    id: "aux-1",
    parentSessionId: "parent-1",
    status: "active",
    runState: "idle",
    title: "Auxiliary",
    provider: "codex",
    catalogRevision: 1,
    model: "gpt-5.4",
    reasoningEffort: "medium",
    approvalMode: "untrusted",
    codexSandboxMode: "workspace-write",
    codexSpeed: "standard",
    codexReviewer: "user",
    customAgentName: "",
    allowedAdditionalDirectories: [],
    threadId: "",
    composerDraft: "draft",
    messages: [],
    displayAfterMessageIndex: null,
    createdAt: "",
    updatedAt: "before",
    closedAt: "",
    ...overrides,
  };
}

function createQueueRefs(): {
  draftSaveQueue: { current: Promise<void> };
} {
  return {
    draftSaveQueue: { current: Promise.resolve() },
  };
}

describe("runAuxiliarySessionSendOperation", () => {
  // @test-value v2
  // kind = "contract"
  // claim = "Auxiliary送信の古い成功応答と失敗復旧snapshotは実行中のBookmark付与・解除を保持する"
  // oracle = { type = "contract", ref = "docs/features/message-bookmark-filter.md" }
  // fault = "送信結果の旧Bookmarkで現行の確定messageを上書きする"
  // observable = "適用されたSessionの確定本文とBookmark"
  // observation_boundary = "component-behavior"
  // scope = "auxiliary-send-bookmark-convergence"
  // lifecycle = "permanent"
  // impact = "実行中のBookmark変更が結果到着で消えるか解除済みBookmarkが復活する"
  // distinction = "実行オプション維持testはmessageのBookmarkを観測しない"
  // @end-test-value
  it("古い送信結果と失敗復旧はBookmark付与・解除を巻き戻さない", () => {
    const before = { role: "assistant" as const, text: "before" };
    const activeSessionRef = { current: makeAuxiliarySession({ messages: [{ ...before, isBookmarked: true }] }) as AuxiliarySession | null };
    const applied: AuxiliarySession[] = [];
    const appliers = createAuxiliarySessionSendResultAppliers({ activeSessionRef, setActiveSession: (next) => { applied.push(next); activeSessionRef.current = next; } });
    appliers.applySavedSession(makeAuxiliarySession({ messages: [before, { role: "assistant", text: "done" }] }));
    assert.equal(applied.at(-1)?.messages[0]?.isBookmarked, true);
    assert.equal(applied.at(-1)?.messages[1]?.text, "done");
    activeSessionRef.current = makeAuxiliarySession({ messages: [before] });
    appliers.restoreSessionAfterError(makeAuxiliarySession({ messages: [{ ...before, isBookmarked: true }] }));
    assert.equal(applied.at(-1)?.messages[0]?.isBookmarked, undefined);
  });
  // @test-value v2
  // kind = "contract"
  // claim = "Auxiliaryのturn結果が遅れて届いても送信後に選んだ実行オプションは保持される"
  // oracle = { type = "contract", ref = "docs/design/auxiliary-session.md: 実行オプションとturn" }
  // fault = "Bで送信したturnの保存結果が後から選んだCを上書きする"
  // observable = "完了会話のmessagesとmodel選択"
  // observation_boundary = "component-behavior"
  // scope = "auxiliary-send-convergence"
  // lifecycle = "permanent"
  // impact = "次の送信が利用者表示と異なるモデルで実行される"
  // distinction = "turn結果とローカル選択の非同期競合は型検査では観測できない"
  // @end-test-value
  it("遅れたturn結果は後続の実行選択を戻さず本文を反映する", () => {
    const activeSessionRef = { current: makeAuxiliarySession({ model: "model-c" }) as AuxiliarySession | null };
    const applied: AuxiliarySession[] = [];
    const { applySavedSession } = createAuxiliarySessionSendResultAppliers({
      activeSessionRef,
      setActiveSession: (session) => { applied.push(session); },
    });
    applySavedSession(makeAuxiliarySession({ model: "model-b", messages: [{ role: "assistant", text: "done" }] }));
    assert.equal(applied[0].model, "model-c");
    assert.deepEqual(applied[0].messages, [{ role: "assistant", text: "done" }]);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "Auxiliaryの送信完了と失敗復元は指定された状態ownerへSessionを反映する"
  // oracle = { type = "contract", ref = "docs/design/auxiliary-session.md: 送信直後の共通反映" }
  // fault = "送信結果または失敗復元を状態ownerへ渡さず会話を更新しない"
  // observable = "ownerへ渡された保存済Sessionと復元Session"
  // observation_boundary = "public-boundary"
  // scope = "auxiliary-send-result-owner"
  // lifecycle = "permanent"
  // @end-test-value
  it("send result appliers は saved と error restore で同じ active session 更新を使う", () => {
    const appliedSessions: AuxiliarySession[] = [];
    const { applySavedSession, restoreSessionAfterError } = createAuxiliarySessionSendResultAppliers({
      activeSessionRef: { current: makeAuxiliarySession({ id: "before" }) },
      setActiveSession: (session) => {
        appliedSessions.push(session);
      },
    });
    const saved = makeAuxiliarySession({ id: "saved" });
    const restored = makeAuxiliarySession({ id: "restored" });

    applySavedSession(saved);
    restoreSessionAfterError(restored);

    assert.deepEqual(appliedSessions, [saved, restored]);
  });

  it("pending live run clearer は owner が一致する live run だけ clear する", () => {
    const appliedStates: OwnedLiveSessionRunState[] = [];
    let currentState: OwnedLiveSessionRunState = {
      ownerSessionId: "aux-1",
      state: {
        sessionId: "aux-1",
        threadId: "thread-1",
        assistantText: "",
        reasoningText: "",
        steps: [],
        backgroundTasks: [],
        usage: null,
        errorMessage: "",
        approvalRequest: null,
        elicitationRequest: null,
      },
    };
    const clearPendingLiveRun = createAuxiliarySessionPendingLiveRunClearer({
      updateLiveRunState: (updater) => {
        currentState = updater(currentState);
        appliedStates.push(currentState);
      },
    });

    clearPendingLiveRun("aux-1");

    assert.deepEqual(appliedStates, [{ ownerSessionId: "aux-1", state: null }]);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "Auxiliary送信結果handlerはblocked・running target・errorを対応callbackへ一度ずつ振り分ける"
  // oracle = { type = "contract", ref = "src/chat/auxiliary/auxiliary-session-send-operation.ts: handleAuxiliarySessionSendOperationResult" }
  // fault = "送信結果を誤callbackへ渡し、blocked送信の副作用やerror復旧を誤った経路で処理する"
  // observable = "各callbackが受け取るblocked reason、target reason、error identity"
  // observation_boundary = "public-boundary"
  // scope = "auxiliary-send-result-routing"
  // lifecycle = "permanent"
  // distinction = "実際のprovider送信を行わず結果unionのrouting契約だけを検証する"
  // @end-test-value
  it("send operation result handler は blocked / running target / error だけ callback に渡す", () => {
    const error = new Error("failed");
    const events: string[] = [];
    const blockedReasons: Array<string | null> = [];

    handleAuxiliarySessionSendOperationResult({
      result: {
        status: "blocked",
        preflight: { blockedReason: "empty-message", blockedMessage: "empty", userMessage: "" },
      },
      onBlocked: (preflight) => {
        blockedReasons.push(preflight.blockedReason);
        events.push(`blocked:${preflight.blockedMessage}`);
      },
      onRunningTargetBlocked: () => {
        events.push("unexpected-blocked-target");
      },
      onError: () => {
        events.push("unexpected-blocked-error");
      },
    });
    handleAuxiliarySessionSendOperationResult({
      result: {
        status: "target-blocked",
        target: { session: null, blockedReason: "running" },
      },
      onBlocked: () => {
        events.push("unexpected-running-blocked");
      },
      onRunningTargetBlocked: (target) => {
        events.push(`target:${target.blockedReason}`);
      },
      onError: () => {
        events.push("unexpected-running-error");
      },
    });
    handleAuxiliarySessionSendOperationResult({
      result: {
        status: "target-blocked",
        target: { session: null, blockedReason: "session-changed" },
      },
      onBlocked: () => {
        events.push("unexpected-session-changed-blocked");
      },
      onRunningTargetBlocked: () => {
        events.push("unexpected-target");
      },
      onError: () => {
        events.push("unexpected-session-changed-error");
      },
    });
    handleAuxiliarySessionSendOperationResult({
      result: { status: "stale" },
      onBlocked: () => {
        events.push("unexpected-stale-blocked");
      },
      onRunningTargetBlocked: () => {
        events.push("unexpected-stale-target");
      },
      onError: () => {
        events.push("unexpected-stale-error");
      },
    });
    handleAuxiliarySessionSendOperationResult({
      result: { status: "error", error },
      onBlocked: () => {
        events.push("unexpected-error-blocked");
      },
      onRunningTargetBlocked: () => {
        events.push("unexpected-error-target");
      },
      onError: (nextError) => {
        events.push(nextError === error ? "error" : "other");
      },
    });
    handleAuxiliarySessionSendOperationResult({
      result: { status: "completed", saved: makeAuxiliarySession() },
      onBlocked: () => {
        events.push("unexpected-completed-blocked");
      },
      onRunningTargetBlocked: () => {
        events.push("unexpected-completed-target");
      },
      onError: () => {
        events.push("unexpected");
      },
    });

    assert.deepEqual(blockedReasons, ["empty-message"]);
    assert.deepEqual(events, ["blocked:empty", "target:running", "error"]);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "Auxiliaryのrunning adapterはSessionとPendingを同じ会話IDとthreadへ反映する"
  // oracle = { type = "contract", ref = "docs/design/auxiliary-session.md: 送信直後の共通反映" }
  // fault = "親SessionのidentityでPendingを生成するか会話の状態ownerを呼ばない"
  // observable = "適用されたSessionとPendingのsessionId/threadId"
  // observation_boundary = "public-boundary"
  // scope = "auxiliary-running-owner"
  // lifecycle = "permanent"
  // @end-test-value
  it("running applier は active session と pending live run を同じ running session から反映する", () => {
    const runningSession = makeAuxiliarySession({
      runState: "running",
      threadId: "thread-running",
      updatedAt: "running",
    });
    const appliedSessions: AuxiliarySession[] = [];
    const liveRunStates: OwnedLiveSessionRunState[] = [];
    let currentLiveRunState: OwnedLiveSessionRunState = {
      ownerSessionId: "other",
      state: {
        sessionId: "other",
        threadId: "other-thread",
        assistantText: "",
        reasoningText: "",
        steps: [],
        backgroundTasks: [],
        usage: null,
        errorMessage: "",
        approvalRequest: null,
        elicitationRequest: null,
      },
    };
    const applyRunningSession = createAuxiliarySessionRunningApplier({
      activeSessionRef: { current: null },
      setActiveSession: (session) => {
        appliedSessions.push(session);
      },
      updateLiveRunState: (updater) => {
        currentLiveRunState = updater(currentLiveRunState);
        liveRunStates.push(currentLiveRunState);
      },
    });

    applyRunningSession(runningSession);

    assert.deepEqual(appliedSessions, [runningSession]);
    assert.deepEqual(liveRunStates, [{
      ownerSessionId: "aux-1",
      state: {
        sessionId: "aux-1",
        threadId: "thread-running",
        assistantText: "",
        reasoningText: "",
        steps: [],
        backgroundTasks: [],
        usage: null,
        errorMessage: "",
        approvalRequest: null,
        elicitationRequest: null,
      },
    }]);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "Auxiliary送信は親会話anchorと本文をturn要求へ渡し、完了結果を会話へ反映する"
  // oracle = { type = "contract", ref = "docs/design/auxiliary-session.md: 送信と表示位置" }
  // fault = "anchorまたは本文を落として別位置へ応答を表示する"
  // observable = "turn要求の本文とanchor、完了会話"
  // observation_boundary = "public-boundary"
  // scope = "auxiliary-send"
  // lifecycle = "permanent"
  // distinction = "型検査では要求値と会話状態の対応を保証できない"
  // @end-test-value
  it("running transition を反映して turn 実行結果を active session へ反映する", async () => {
    const { draftSaveQueue } = createQueueRefs();
    const mutationRevision = { current: 0 };
    let currentSession = makeAuxiliarySession();
    const savedSession = makeAuxiliarySession({
      runState: "idle",
      composerDraft: "",
      messages: [
        { role: "user", text: "hello" },
        { role: "assistant", text: "done" },
      ],
      displayAfterMessageIndex: 2,
      updatedAt: "saved",
    });
    const runningSessions: AuxiliarySession[] = [];
    const appliedSavedSessions: AuxiliarySession[] = [];
    const runRequests: Array<{ sessionId: string; userMessage: string; anchor: number | undefined }> = [];

    const result = await runAuxiliarySessionSendOperation({
      activeSession: currentSession,
      executionOptions: captureSessionExecutionOptions(currentSession),
      messageText: "  hello  ",
      parentMessageCount: 3,
      updatedAt: "running",
      draftSaveQueue,
      mutationRevision,
      getCurrentSession: () => currentSession,
      applyRunningSession: (session) => {
        currentSession = session;
        runningSessions.push(session);
      },
      applySavedSession: (session) => {
        currentSession = session;
        appliedSavedSessions.push(session);
      },
      restoreSessionAfterError: (session) => {
        currentSession = session;
      },
      clearPendingLiveRun: () => undefined,
      runAuxiliarySessionTurn: async (sessionId, request) => {
        runRequests.push({ sessionId, userMessage: request.userMessage, anchor: request.displayAnchorParentMessageCount });
        return savedSession;
      },
    });

    assert.deepEqual(result, {
      status: "completed",
      saved: savedSession,
    });
    assert.equal(mutationRevision.current, 1);
    assert.deepEqual(runningSessions, [{
      ...makeAuxiliarySession(),
      runState: "running",
      composerDraft: "",
      messages: [{ role: "user", text: "hello" }],
      displayAfterMessageIndex: 2,
      updatedAt: "running",
    }]);
    assert.deepEqual(runRequests, [{ sessionId: "aux-1", userMessage: "hello", anchor: 3 }]);
    assert.deepEqual(appliedSavedSessions, [savedSession]);
    assert.equal(currentSession, savedSession);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "Auxiliary送信adapterはcaptured execution optionsを同一turn要求へ渡す"
  // oracle = { type = "contract", ref = "src-shared/session/runtime-state.ts: RunSessionTurnRequest" }
  // fault = "adapterで実行選択値を落とし、保存済み値で実行する"
  // observable = "adapterが渡すturn要求のexecutionOptions"
  // observation_boundary = "public-boundary"
  // scope = "auxiliary-send-adapter"
  // lifecycle = "permanent"
  // distinction = "Main APIへのadapter経路を直接検査する"
  // @end-test-value
  it("API adapter 経由でも update と turn 実行を呼び出す", async () => {
    const { draftSaveQueue } = createQueueRefs();
    const mutationRevision = { current: 0 };
    let currentSession = makeAuxiliarySession();
    const savedSession = makeAuxiliarySession({
      runState: "idle",
      composerDraft: "",
      messages: [
        { role: "user", text: "hello" },
        { role: "assistant", text: "done" },
      ],
      displayAfterMessageIndex: 2,
      updatedAt: "saved",
    });
    const apiRuns: Array<{ sessionId: string; userMessage: string; model: string }> = [];

    const result = await runAuxiliarySessionSendOperationWithApi({
      activeSession: currentSession,
      executionOptions: captureSessionExecutionOptions(currentSession),
      messageText: "hello",
      parentMessageCount: 3,
      updatedAt: "running",
      draftSaveQueue,
      mutationRevision,
      getCurrentSession: () => currentSession,
      applyRunningSession: (session) => {
        currentSession = session;
      },
      applySavedSession: (session) => {
        currentSession = session;
      },
      restoreSessionAfterError: (session) => {
        currentSession = session;
      },
      clearPendingLiveRun: () => undefined,
      api: {
        runAuxiliarySessionTurn: async (sessionId, request) => {
          apiRuns.push({ sessionId, userMessage: request.userMessage, model: request.executionOptions.model });
          return savedSession;
        },
      },
    });

    assert.deepEqual(result, {
      status: "completed",
      saved: savedSession,
    });
    assert.deepEqual(apiRuns, [{ sessionId: "aux-1", userMessage: "hello", model: "gpt-5.4" }]);
    assert.equal(currentSession, savedSession);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "送信不能なAuxiliary入力はdraft消費とturn開始を行わない"
  // oracle = { type = "contract", ref = "docs/design/auxiliary-session.md: Composer の更新・保存境界" }
  // fault = "blocked入力でも送信開始副作用を起こす"
  // observable = "blocked結果、mutation revision、副作用回数"
  // observation_boundary = "public-boundary"
  // scope = "auxiliary-send-preflight"
  // lifecycle = "permanent"
  // distinction = "UI disabled状態だけでは操作関数のguardを保証できない"
  // @end-test-value
  it("preflight で block された場合は副作用なしで返す", async () => {
    const { draftSaveQueue } = createQueueRefs();
    const mutationRevision = { current: 0 };
    let sideEffectCount = 0;

    const result = await runAuxiliarySessionSendOperation({
      activeSession: makeAuxiliarySession(),
      executionOptions: captureSessionExecutionOptions(makeAuxiliarySession()),
      composerBlockedReason: "blocked",
      messageText: "hello",
      parentMessageCount: 1,
      updatedAt: "running",
      draftSaveQueue,
      mutationRevision,
      getCurrentSession: () => makeAuxiliarySession(),
      applyRunningSession: () => {
        sideEffectCount += 1;
      },
      applySavedSession: () => {
        sideEffectCount += 1;
      },
      restoreSessionAfterError: () => {
        sideEffectCount += 1;
      },
      clearPendingLiveRun: () => {
        sideEffectCount += 1;
      },
      runAuxiliarySessionTurn: async () => makeAuxiliarySession(),
    });

    assert.equal(result.status, "blocked");
    assert.equal(result.status === "blocked" ? result.preflight.blockedReason : null, "composer-blocked");
    assert.equal(mutationRevision.current, 0);
    assert.equal(sideEffectCount, 0);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "draft保存待機中にAuxiliaryが変更された送信は古いcaptureを実行しない"
  // oracle = { type = "contract", ref = "docs/design/auxiliary-session.md: Composer の更新・保存境界" }
  // fault = "古いdraftと別の会話状態でturnを開始する"
  // observable = "stale結果とturn実行有無"
  // observation_boundary = "public-boundary"
  // scope = "auxiliary-send-revision"
  // lifecycle = "permanent"
  // distinction = "非同期revision変更は型やstatic checkで検出できない"
  // @end-test-value
  it("queue 待機中に revision が変わった場合は送信しない", async () => {
    const mutationRevision = { current: 0 };
    const draftSaveQueue = {
      current: Promise.resolve().then(() => {
        mutationRevision.current += 1;
      }),
    };
    let didRun = false;

    const result = await runAuxiliarySessionSendOperation({
      activeSession: makeAuxiliarySession(),
      executionOptions: captureSessionExecutionOptions(makeAuxiliarySession()),
      messageText: "hello",
      parentMessageCount: 1,
      updatedAt: "running",
      draftSaveQueue,
      mutationRevision,
      getCurrentSession: () => makeAuxiliarySession(),
      applyRunningSession: () => {
        didRun = true;
      },
      applySavedSession: () => {
        didRun = true;
      },
      restoreSessionAfterError: () => {
        didRun = true;
      },
      clearPendingLiveRun: () => {
        didRun = true;
      },
      runAuxiliarySessionTurn: async () => {
        didRun = true;
        return makeAuxiliarySession();
      },
    });

    assert.deepEqual(result, { status: "stale" });
    assert.equal(didRun, false);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "draft queue待機中に終了凍結した送信は本文をconsumeせず、凍結解除後の明示送信で同じ本文を送れる"
  // oracle = { type = "contract", ref = "docs/design/auxiliary-session.md: Composer の更新・保存境界" }
  // fault = "draft queue前だけ送信可否を確認して凍結後にdraftをclear/consumeする"
  // observable = "凍結時のstale結果と本文保持、解凍後のcompleted結果と送信本文"
  // observation_boundary = "public-boundary"
  // scope = "auxiliary-send-queue-freeze"
  // lifecycle = "permanent"
  // impact = "終了待ちに後発送信が入り、保存済み下書きがconsumeされるデータ消失を防ぐ"
  // distinction = "Appのdraft保存前処理より後のdraft queue境界を検証する。型検査では非同期の凍結順序を保証できない"
  // @end-test-value
  it("保存queue待機中の終了凍結は本文を保持し、解凍後に送信できる", async () => {
    let frozen = false;
    let draft = "kept draft";
    const sent: string[] = [];
    const input = {
      activeSession: makeAuxiliarySession(), executionOptions: captureSessionExecutionOptions(makeAuxiliarySession()), messageText: draft, parentMessageCount: 1, updatedAt: "running",
      draftSaveQueue: { current: Promise.resolve().then(() => { frozen = true; }) },
      mutationRevision: { current: 0 },
      getCurrentSession: () => makeAuxiliarySession(),
      canStartRun: () => !frozen,
      beforeRunningSessionApplied: () => { draft = ""; },
      applyRunningSession: () => {}, applySavedSession: () => {},
      restoreSessionAfterError: () => {}, clearPendingLiveRun: () => {},
      runAuxiliarySessionTurn: async (_id: string, request: { userMessage: string }) => {
        sent.push(request.userMessage);
        return makeAuxiliarySession();
      },
    };
    assert.deepEqual(await runAuxiliarySessionSendOperation(input), { status: "stale" });
    assert.equal(draft, "kept draft");
    assert.deepEqual(sent, []);
    frozen = false;
    assert.equal((await runAuxiliarySessionSendOperation(input)).status, "completed");
    assert.equal(draft, "");
    assert.deepEqual(sent, ["kept draft"]);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "保存待機後に実行中となったAuxiliaryへ重複turnを開始しない"
  // oracle = { type = "contract", ref = "docs/design/auxiliary-session.md: 実行中状態" }
  // fault = "先行runが始まった同じ会話へ別turnを重ねる"
  // observable = "target-blocked結果とturn未実行"
  // observation_boundary = "public-boundary"
  // scope = "auxiliary-send-running-guard"
  // lifecycle = "permanent"
  // distinction = "操作時点の状態だけでなく保存待機後の再確認を検証する"
  // @end-test-value
  it("保存後の current session が running の場合は target-blocked を返す", async () => {
    const { draftSaveQueue } = createQueueRefs();
    const mutationRevision = { current: 0 };
    let didRun = false;

    const result = await runAuxiliarySessionSendOperation({
      activeSession: makeAuxiliarySession(),
      executionOptions: captureSessionExecutionOptions(makeAuxiliarySession()),
      messageText: "hello",
      parentMessageCount: 1,
      updatedAt: "running",
      draftSaveQueue,
      mutationRevision,
      getCurrentSession: () => makeAuxiliarySession({ runState: "running" }),
      applyRunningSession: () => {
        didRun = true;
      },
      applySavedSession: () => {
        didRun = true;
      },
      restoreSessionAfterError: () => {
        didRun = true;
      },
      clearPendingLiveRun: () => {
        didRun = true;
      },
      runAuxiliarySessionTurn: async () => {
        didRun = true;
        return makeAuxiliarySession();
      },
    });

    assert.equal(result.status, "target-blocked");
    assert.equal(result.status === "target-blocked" ? result.target.blockedReason : null, "running");
    assert.equal(mutationRevision.current, 0);
    assert.equal(didRun, false);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "Auxiliary turn失敗時はpending live runを消し会話を復旧する"
  // oracle = { type = "contract", ref = "docs/design/auxiliary-session.md: 実行失敗とdraft復旧" }
  // fault = "失敗後もrunning表示や楽観本文が残る"
  // observable = "clear対象と復旧session"
  // observation_boundary = "public-boundary"
  // scope = "auxiliary-send-error-recovery"
  // lifecycle = "permanent"
  // distinction = "成功時だけのtestでは失敗後の表示復旧を検出できない"
  // @end-test-value
  it("turn 実行失敗時は live run を clear して送信前 session へ戻す", async () => {
    const { draftSaveQueue } = createQueueRefs();
    const mutationRevision = { current: 0 };
    const error = new Error("run failed");
    const beforeSession = makeAuxiliarySession({
      displayAfterMessageIndex: 1,
      messages: [{ role: "user", text: "previous" }],
    });
    let currentSession = beforeSession;
    const clearedSessionIds: string[] = [];
    const restoredSessions: AuxiliarySession[] = [];

    const result = await runAuxiliarySessionSendOperation({
      activeSession: beforeSession,
      executionOptions: captureSessionExecutionOptions(beforeSession),
      messageText: "hello",
      parentMessageCount: 3,
      updatedAt: "running",
      draftSaveQueue,
      mutationRevision,
      getCurrentSession: () => currentSession,
      applyRunningSession: (session) => {
        currentSession = session;
      },
      applySavedSession: (session) => {
        currentSession = session;
      },
      restoreSessionAfterError: (session) => {
        currentSession = session;
        restoredSessions.push(session);
      },
      clearPendingLiveRun: (sessionId) => {
        clearedSessionIds.push(sessionId);
      },
      runAuxiliarySessionTurn: async () => {
        throw error;
      },
    });

    assert.deepEqual(result, {
      status: "error",
      error,
    });
    assert.deepEqual(clearedSessionIds, ["aux-1"]);
    assert.deepEqual(restoredSessions, [beforeSession]);
    assert.equal(currentSession, beforeSession);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "Auxiliary送信Aの遅い失敗はA→B→A切替後も送信元Aの未変更draftを復元し、Aに後続入力があれば上書きしない"
  // oracle = { type = "contract", ref = "Issue #737 SessionWindow asynchronous operation lifecycle" }
  // fault = "会話mutationのstale判定で送信元draftの復元を省く、またはowner revisionを無視して後続入力を上書きする"
  // observable = "stale結果、A/B owner別draft、会話復旧callbackの呼出回数"
  // observation_boundary = "public-boundary"
  // scope = "auxiliary-send-late-error"
  // lifecycle = "permanent"
  // impact = "送信元Aの下書きが失われるか、後から入力した本文を古い送信で破壊する"
  // distinction = "通常の失敗復旧testとComposerRegistry単体testでは会話mutation失効後の送信元owner復元を検出できない"
  // @end-test-value
  it("A→B→A後の失敗は送信元draftだけ復元し、後続入力を保護する", async () => {
    for (const laterEdit of [false, true]) {
      const registry = new ComposerControllerRegistry();
      const ownerA = { kind: "auxiliary" as const, id: "aux-1" };
      const ownerB = { kind: "auxiliary" as const, id: "aux-2" };
      registry.setDraft(ownerA, "hello");
      registry.setDraft(ownerB, "B draft");
      const sendRevision = registry.capture(ownerA).revision;
      let clearedRevision: number | null = null;
      const beforeSession = makeAuxiliarySession();
      const mutationRevision = { current: 0 };
      let currentSession = beforeSession;
      let sessionRecoveryCount = 0;
      let rejectRun!: (error: Error) => void;
      let signalRunStarted!: () => void;
      const runStarted = new Promise<void>((resolve) => { signalRunStarted = resolve; });
      const runResult = new Promise<AuxiliarySession>((_resolve, reject) => { rejectRun = reject; });
      const operation = runAuxiliarySessionSendOperation({
        activeSession: beforeSession,
        executionOptions: captureSessionExecutionOptions(beforeSession),
        messageText: "hello",
        parentMessageCount: 1,
        updatedAt: "running",
        draftSaveQueue: { current: Promise.resolve() },
        mutationRevision,
        getCurrentSession: () => currentSession,
        beforeRunningSessionApplied: () => { clearedRevision = registry.clearIfRevision(ownerA, sendRevision); },
        applyRunningSession: (session) => { currentSession = session; },
        onRunError: () => {
          if (clearedRevision !== null) registry.restoreIfRevision(ownerA, clearedRevision, () => "hello");
        },
        applySavedSession: () => { sessionRecoveryCount += 1; },
        restoreSessionAfterError: () => { sessionRecoveryCount += 1; },
        clearPendingLiveRun: () => { sessionRecoveryCount += 1; },
        runAuxiliarySessionTurn: () => { signalRunStarted(); return runResult; },
      });
      await runStarted;
      currentSession = makeAuxiliarySession({ id: "aux-2" });
      mutationRevision.current += 1;
      currentSession = beforeSession;
      if (laterEdit) registry.setDraft(ownerA, "new A draft");
      rejectRun(new Error("late failure"));
      assert.deepEqual(await operation, { status: "stale" });
      assert.equal(registry.capture(ownerA).draft, laterEdit ? "new A draft" : "hello");
      assert.equal(registry.capture(ownerB).draft, "B draft");
      assert.equal(sessionRecoveryCount, 0);
    }
  });
});
