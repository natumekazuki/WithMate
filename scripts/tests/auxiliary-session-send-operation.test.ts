import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createAuxiliarySessionPendingLiveRunClearer,
  createAuxiliarySessionRunningApplier,
  createAuxiliarySessionSendResultAppliers,
  handleAuxiliarySessionSendOperationResult,
  runAuxiliarySessionSendOperation,
  runAuxiliarySessionSendOperationWithApi,
} from "../../src/auxiliary-session-send-operation.js";
import type { AuxiliarySession } from "../../src/auxiliary-session-state.js";
import type { OwnedLiveSessionRunState } from "../../src/session-live-run-state.js";

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
  sessionSaveQueue: { current: Promise<void> };
} {
  return {
    draftSaveQueue: { current: Promise.resolve() },
    sessionSaveQueue: { current: Promise.resolve() },
  };
}

describe("runAuxiliarySessionSendOperation", () => {
  it("send result appliers は saved と error restore で同じ active session 更新を使う", () => {
    const activeSessionRef = {
      current: makeAuxiliarySession({ id: "before" }) as AuxiliarySession | null,
    };
    const appliedSessions: AuxiliarySession[] = [];
    const { applySavedSession, restoreSessionAfterError } = createAuxiliarySessionSendResultAppliers({
      activeSessionRef,
      setActiveSession: (session) => {
        appliedSessions.push(session);
      },
    });
    const saved = makeAuxiliarySession({ id: "saved" });
    const restored = makeAuxiliarySession({ id: "restored" });

    applySavedSession(saved);
    restoreSessionAfterError(restored);

    assert.equal(activeSessionRef.current, restored);
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

  it("send operation result handler は blocked / running target / error だけ callback に渡す", () => {
    const error = new Error("failed");
    const events: string[] = [];

    handleAuxiliarySessionSendOperationResult({
      result: {
        status: "blocked",
        preflight: { blockedReason: "empty", blockedMessage: "empty", userMessage: "" },
      },
      onBlocked: (preflight) => {
        events.push(`blocked:${preflight.blockedMessage}`);
      },
    });
    handleAuxiliarySessionSendOperationResult({
      result: {
        status: "target-blocked",
        target: { session: null, blockedReason: "running" },
      },
      onRunningTargetBlocked: (target) => {
        events.push(`target:${target.blockedReason}`);
      },
    });
    handleAuxiliarySessionSendOperationResult({
      result: { status: "error", error },
      onError: (nextError) => {
        events.push(nextError === error ? "error" : "other");
      },
    });
    handleAuxiliarySessionSendOperationResult({
      result: { status: "completed", saved: makeAuxiliarySession() },
      onError: () => {
        events.push("unexpected");
      },
    });

    assert.deepEqual(events, ["blocked:empty", "target:running", "error"]);
  });

  it("running applier は active session と pending live run を同じ running session から反映する", () => {
    const runningSession = makeAuxiliarySession({
      runState: "running",
      threadId: "thread-running",
      updatedAt: "running",
    });
    const activeSessionRef = {
      current: makeAuxiliarySession({ updatedAt: "before" }) as AuxiliarySession | null,
    };
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
      activeSessionRef,
      setActiveSession: (session) => {
        appliedSessions.push(session);
      },
      updateLiveRunState: (updater) => {
        currentLiveRunState = updater(currentLiveRunState);
        liveRunStates.push(currentLiveRunState);
      },
      buildRuntimeSession: (session) => ({
        id: `runtime:${session.id}`,
        threadId: `runtime:${session.threadId}`,
      }),
    });

    applyRunningSession(runningSession);

    assert.equal(activeSessionRef.current, runningSession);
    assert.deepEqual(appliedSessions, [runningSession]);
    assert.deepEqual(liveRunStates, [{
      ownerSessionId: "runtime:aux-1",
      state: {
        sessionId: "runtime:aux-1",
        threadId: "runtime:thread-running",
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

  it("running transition を反映して turn 実行結果を active session へ反映する", async () => {
    const { draftSaveQueue, sessionSaveQueue } = createQueueRefs();
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
    const pendingUpdates: AuxiliarySession[] = [];
    const runningSessions: AuxiliarySession[] = [];
    const appliedSavedSessions: AuxiliarySession[] = [];
    const runRequests: Array<{ sessionId: string; userMessage: string }> = [];

    const result = await runAuxiliarySessionSendOperation({
      activeSession: currentSession,
      messageText: "  hello  ",
      parentMessageCount: 3,
      updatedAt: "running",
      draftSaveQueue,
      sessionSaveQueue,
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
      updateAuxiliarySession: async (session) => {
        pendingUpdates.push(session);
        return session;
      },
      runAuxiliarySessionTurn: async (sessionId, request) => {
        runRequests.push({ sessionId, userMessage: request.userMessage });
        return savedSession;
      },
    });

    assert.deepEqual(result, {
      status: "completed",
      saved: savedSession,
    });
    assert.equal(mutationRevision.current, 1);
    assert.deepEqual(pendingUpdates, [{
      ...makeAuxiliarySession(),
      displayAfterMessageIndex: 2,
    }]);
    assert.deepEqual(runningSessions, [{
      ...makeAuxiliarySession(),
      runState: "running",
      composerDraft: "",
      messages: [{ role: "user", text: "hello" }],
      displayAfterMessageIndex: 2,
      updatedAt: "running",
    }]);
    assert.deepEqual(runRequests, [{ sessionId: "aux-1", userMessage: "hello" }]);
    assert.deepEqual(appliedSavedSessions, [savedSession]);
    assert.equal(currentSession, savedSession);
  });

  it("API adapter 経由でも update と turn 実行を呼び出す", async () => {
    const { draftSaveQueue, sessionSaveQueue } = createQueueRefs();
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
    const apiUpdates: AuxiliarySession[] = [];
    const apiRuns: Array<{ sessionId: string; userMessage: string }> = [];

    const result = await runAuxiliarySessionSendOperationWithApi({
      activeSession: currentSession,
      messageText: "hello",
      parentMessageCount: 3,
      updatedAt: "running",
      draftSaveQueue,
      sessionSaveQueue,
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
        updateAuxiliarySession: async (session) => {
          apiUpdates.push(session);
          return session;
        },
        runAuxiliarySessionTurn: async (sessionId, request) => {
          apiRuns.push({ sessionId, userMessage: request.userMessage });
          return savedSession;
        },
      },
    });

    assert.deepEqual(result, {
      status: "completed",
      saved: savedSession,
    });
    assert.deepEqual(apiUpdates, [{
      ...makeAuxiliarySession(),
      displayAfterMessageIndex: 2,
    }]);
    assert.deepEqual(apiRuns, [{ sessionId: "aux-1", userMessage: "hello" }]);
    assert.equal(currentSession, savedSession);
  });

  it("preflight で block された場合は副作用なしで返す", async () => {
    const { draftSaveQueue, sessionSaveQueue } = createQueueRefs();
    const mutationRevision = { current: 0 };
    let sideEffectCount = 0;

    const result = await runAuxiliarySessionSendOperation({
      activeSession: makeAuxiliarySession(),
      composerBlockedReason: "blocked",
      messageText: "hello",
      parentMessageCount: 1,
      updatedAt: "running",
      draftSaveQueue,
      sessionSaveQueue,
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
      updateAuxiliarySession: async (session) => session,
      runAuxiliarySessionTurn: async () => makeAuxiliarySession(),
    });

    assert.equal(result.status, "blocked");
    assert.equal(result.status === "blocked" ? result.preflight.blockedReason : null, "composer-blocked");
    assert.equal(mutationRevision.current, 0);
    assert.equal(sideEffectCount, 0);
  });

  it("queue 待機中に revision が変わった場合は送信しない", async () => {
    const mutationRevision = { current: 0 };
    const draftSaveQueue = {
      current: Promise.resolve().then(() => {
        mutationRevision.current += 1;
      }),
    };
    const sessionSaveQueue = { current: Promise.resolve() };
    let didRun = false;

    const result = await runAuxiliarySessionSendOperation({
      activeSession: makeAuxiliarySession(),
      messageText: "hello",
      parentMessageCount: 1,
      updatedAt: "running",
      draftSaveQueue,
      sessionSaveQueue,
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
      updateAuxiliarySession: async (session) => session,
      runAuxiliarySessionTurn: async () => {
        didRun = true;
        return makeAuxiliarySession();
      },
    });

    assert.deepEqual(result, { status: "stale" });
    assert.equal(didRun, false);
  });

  it("保存後の current session が running の場合は target-blocked を返す", async () => {
    const { draftSaveQueue, sessionSaveQueue } = createQueueRefs();
    const mutationRevision = { current: 0 };
    let didRun = false;

    const result = await runAuxiliarySessionSendOperation({
      activeSession: makeAuxiliarySession(),
      messageText: "hello",
      parentMessageCount: 1,
      updatedAt: "running",
      draftSaveQueue,
      sessionSaveQueue,
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
      updateAuxiliarySession: async (session) => session,
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

  it("turn 実行失敗時は live run を clear して送信前 session へ戻す", async () => {
    const { draftSaveQueue, sessionSaveQueue } = createQueueRefs();
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
      messageText: "hello",
      parentMessageCount: 3,
      updatedAt: "running",
      draftSaveQueue,
      sessionSaveQueue,
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
      updateAuxiliarySession: async (session) => session,
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
});
