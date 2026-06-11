import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applyAuxiliarySessionReturnToMainUiState,
  createAuxiliarySessionReturnBeforeCloseHandler,
  createAuxiliarySessionReturnToMainUiStateApplier,
  applyReturnedAuxiliaryClosedSession,
  createReturnedAuxiliaryClosedSessionApplier,
  finishAuxiliarySessionReturnToMainOperation,
  resolveAuxiliarySessionReturnToMainErrorMessage,
  runAuxiliarySessionReturnToMainOperation,
} from "../../src/auxiliary-session-return-operation.js";
import type { AuxiliarySession } from "../../src/auxiliary-session-state.js";

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
    composerDraft: "",
    messages: [],
    displayAfterMessageIndex: null,
    createdAt: "",
    updatedAt: "",
    closedAt: "",
    ...overrides,
  };
}

describe("runAuxiliarySessionReturnToMainOperation", () => {
  it("return-to-main UI state は active session を閉じて main caret を draft 長に丸める", () => {
    const active = makeAuxiliarySession({ id: "aux-active" });
    const mutationRevision = { current: 2 };
    const activeSessionRef = { current: active as AuxiliarySession | null };
    const events: string[] = [];
    let activeSession: AuxiliarySession | null = active;
    let composerCaret = 0;
    let actionDockExpanded = true;
    let forceBlockedFeedback = true;

    applyAuxiliarySessionReturnToMainUiState({
      mutationRevision,
      activeSessionRef,
      setActiveSession: (session) => {
        activeSession = session;
        events.push("active");
      },
      mainDraft: "hello",
      mainCaret: 99,
      setComposerCaret: (caret) => {
        composerCaret = caret;
        events.push(`caret:${caret}`);
      },
      setActionDockPinnedExpanded: (expanded) => {
        actionDockExpanded = expanded;
        events.push(`dock:${expanded}`);
      },
      setForceComposerBlockedFeedback: (forced) => {
        forceBlockedFeedback = forced;
        events.push(`feedback:${forced}`);
      },
    });

    assert.equal(mutationRevision.current, 3);
    assert.equal(activeSessionRef.current, null);
    assert.equal(activeSession, null);
    assert.equal(composerCaret, 5);
    assert.equal(actionDockExpanded, false);
    assert.equal(forceBlockedFeedback, false);
    assert.deepEqual(events, ["active", "caret:5", "dock:false", "feedback:false"]);
  });

  it("return-to-main UI state applier は callback として main UI state を反映する", () => {
    const active = makeAuxiliarySession({ id: "aux-active" });
    const mutationRevision = { current: 4 };
    const activeSessionRef = { current: active as AuxiliarySession | null };
    const events: string[] = [];
    const applyReturnedMainSession = createAuxiliarySessionReturnToMainUiStateApplier({
      mutationRevision,
      activeSessionRef,
      setActiveSession: () => {
        events.push("active");
      },
      mainDraft: "hello",
      mainCaret: 10,
      setComposerCaret: (caret) => {
        events.push(`caret:${caret}`);
      },
      setActionDockPinnedExpanded: (expanded) => {
        events.push(`dock:${expanded}`);
      },
      setForceComposerBlockedFeedback: (forced) => {
        events.push(`feedback:${forced}`);
      },
    });

    applyReturnedMainSession();

    assert.equal(mutationRevision.current, 5);
    assert.equal(activeSessionRef.current, null);
    assert.deepEqual(events, ["active", "caret:5", "dock:false", "feedback:false"]);
  });

  it("return-to-main beforeClose handler は load revision を進める", () => {
    const loadRevision = { current: 3 };
    const beforeClose = createAuxiliarySessionReturnBeforeCloseHandler({
      loadRevision,
    });

    beforeClose();

    assert.equal(loadRevision.current, 4);
  });

  it("return-to-main cleanup は pending を false に戻す", () => {
    const pendingValues: boolean[] = [];

    finishAuxiliarySessionReturnToMainOperation({
      setActionPending: (pending) => {
        pendingValues.push(pending);
      },
    });

    assert.deepEqual(pendingValues, [false]);
  });

  it("closed session 反映は重複を避けて末尾に置く", () => {
    const existing = makeAuxiliarySession({ id: "closed-1", status: "closed" });
    const closed = makeAuxiliarySession({ id: "closed-2", status: "closed" });

    assert.deepEqual(
      applyReturnedAuxiliaryClosedSession([existing], closed),
      [existing, closed],
    );
    assert.deepEqual(
      applyReturnedAuxiliaryClosedSession([existing], existing),
      [existing],
    );
  });

  it("closed session applier は setter callback 経由で closed list を更新する", () => {
    const existing = makeAuxiliarySession({ id: "closed-1", status: "closed" });
    const closed = makeAuxiliarySession({ id: "closed-2", status: "closed" });
    const appliedSessions: AuxiliarySession[][] = [];
    const applyClosedSession = createReturnedAuxiliaryClosedSessionApplier({
      setClosedSessions: (updater) => {
        appliedSessions.push(updater([existing]));
      },
    });

    applyClosedSession(closed);

    assert.deepEqual(appliedSessions, [[existing, closed]]);
  });

  it("active session がない場合は close せず null を返す", async () => {
    let closed = false;

    assert.equal(
      await runAuxiliarySessionReturnToMainOperation({
        activeSession: null,
        closeAuxiliarySession: async (sessionId) => {
          closed = true;
          return makeAuxiliarySession({ id: sessionId });
        },
        applyClosedSession: () => undefined,
        applyReturnedMainSession: () => undefined,
      }),
      null,
    );
    assert.equal(closed, false);
  });

  it("beforeClose、close、closed反映、main反映の順に実行する", async () => {
    const active = makeAuxiliarySession({ id: "aux-1" });
    const closed = makeAuxiliarySession({ id: "aux-1", status: "closed" });
    const events: string[] = [];

    assert.equal(
      await runAuxiliarySessionReturnToMainOperation({
        activeSession: active,
        beforeClose: () => {
          events.push("before");
        },
        closeAuxiliarySession: async (sessionId) => {
          events.push(`close:${sessionId}`);
          return closed;
        },
        applyClosedSession: (session) => {
          events.push(`closed:${session.status}`);
        },
        applyReturnedMainSession: () => {
          events.push("main");
        },
      }),
      closed,
    );
    assert.deepEqual(events, ["before", "close:aux-1", "closed:closed", "main"]);
  });

  it("close が失敗した場合は closed/main 反映を実行せず例外を伝播する", async () => {
    const error = new Error("close failed");
    const events: string[] = [];

    await assert.rejects(
      runAuxiliarySessionReturnToMainOperation({
        activeSession: makeAuxiliarySession(),
        beforeClose: () => {
          events.push("before");
        },
        closeAuxiliarySession: async () => {
          events.push("close");
          throw error;
        },
        applyClosedSession: () => {
          events.push("closed");
        },
        applyReturnedMainSession: () => {
          events.push("main");
        },
      }),
      error,
    );
    assert.deepEqual(events, ["before", "close"]);
  });

  it("return-to-main failure message は Error message を優先し、非 Error は fallback を返す", () => {
    assert.equal(resolveAuxiliarySessionReturnToMainErrorMessage(new Error("close failed")), "close failed");
    assert.equal(
      resolveAuxiliarySessionReturnToMainErrorMessage("close failed"),
      "Auxiliary Session の終了に失敗したよ。",
    );
  });
});
