import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applyAuxiliarySessionStartError,
  applyAuxiliarySessionStartResult,
  beginAuxiliarySessionStartOperation,
  createActiveAuxiliarySessionStartResultApplier,
  createAuxiliarySessionStartResultApplier,
  finishAuxiliarySessionStartClosedLoad,
  finishAuxiliarySessionStartClosedLoadWithApi,
  runAuxiliarySessionStartOperation,
} from "../../src/auxiliary-session-start-operation.js";
import type {
  AuxiliarySession,
  CreateAuxiliarySessionInput,
} from "../../src/auxiliary-session-state.js";

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

describe("runAuxiliarySessionStartOperation", () => {
  it("create request を組み立て、作成済み session を active へ反映する", async () => {
    const requests: CreateAuxiliarySessionInput[] = [];
    const session = makeAuxiliarySession({
      parentSessionId: "parent-1",
      provider: "codex",
      model: "gpt-5.4-mini",
      reasoningEffort: "high",
      customAgentName: "reviewer",
    });
    const applied: AuxiliarySession[] = [];

    assert.equal(
      await runAuxiliarySessionStartOperation({
        parentSessionId: "parent-1",
        provider: "codex",
        defaults: {
          model: "gpt-5.4-mini",
          reasoningEffort: "high",
          customAgentName: "reviewer",
        },
        createAuxiliarySession: async (request) => {
          requests.push(request);
          return session;
        },
        applyStartedSession: (createdSession) => {
          applied.push(createdSession);
        },
      }),
      session,
    );
    assert.deepEqual(requests, [{
      parentSessionId: "parent-1",
      provider: "codex",
      model: "gpt-5.4-mini",
      reasoningEffort: "high",
      customAgentName: "reviewer",
    }]);
    assert.deepEqual(applied, [session]);
  });

  it("defaults が null の場合は provider と parentSessionId だけで作成する", async () => {
    const requests: CreateAuxiliarySessionInput[] = [];
    const session = makeAuxiliarySession();

    await runAuxiliarySessionStartOperation({
      parentSessionId: "parent-1",
      provider: "copilot",
      defaults: null,
      createAuxiliarySession: async (request) => {
        requests.push(request);
        return session;
      },
      applyStartedSession: () => undefined,
    });

    assert.deepEqual(requests, [{
      parentSessionId: "parent-1",
      provider: "copilot",
      model: undefined,
      reasoningEffort: undefined,
      customAgentName: undefined,
    }]);
  });

  it("作成に失敗した場合は active 反映せず例外を伝播する", async () => {
    const error = new Error("create failed");
    let applied = false;

    await assert.rejects(
      runAuxiliarySessionStartOperation({
        parentSessionId: "parent-1",
        provider: "codex",
        createAuxiliarySession: async () => {
          throw error;
        },
        applyStartedSession: () => {
          applied = true;
        },
      }),
      error,
    );
    assert.equal(applied, false);
  });
});

describe("beginAuxiliarySessionStartOperation", () => {
  it("feedback reset、load revision increment、pending true の順に反映して revision を返す", () => {
    const loadRevision = { current: 4 };
    const events: string[] = [];

    assert.equal(
      beginAuxiliarySessionStartOperation({
        loadRevision,
        resetLaunchFeedback: () => {
          events.push("reset");
        },
        setActionPending: (pending) => {
          events.push(`pending:${pending}`);
        },
      }),
      5,
    );
    assert.equal(loadRevision.current, 5);
    assert.deepEqual(events, ["reset", "pending:true"]);
  });
});

describe("applyAuxiliarySessionStartError", () => {
  it("start error を launch error state に反映する", () => {
    const error = new Error("start failed");
    const errors: unknown[] = [];

    applyAuxiliarySessionStartError({
      error,
      setLaunchStartError: (nextError) => {
        errors.push(nextError);
      },
    });

    assert.deepEqual(errors, [error]);
  });
});

describe("applyAuxiliarySessionStartResult", () => {
  it("mutation revision、active session、dock、feedback、dialog close の順に反映する", () => {
    const session = makeAuxiliarySession({ id: "aux-started" });
    const events: string[] = [];

    applyAuxiliarySessionStartResult({
      session,
      incrementMutationRevision: () => {
        events.push("revision");
      },
      applyActiveSession: (startedSession) => {
        events.push(`active:${startedSession.id}`);
      },
      setActionDockPinnedExpanded: (expanded) => {
        events.push(`dock:${expanded}`);
      },
      setForceComposerBlockedFeedback: (forced) => {
        events.push(`feedback:${forced}`);
      },
      closeLaunchDialog: () => {
        events.push("close");
      },
    });

    assert.deepEqual(events, [
      "revision",
      "active:aux-started",
      "dock:true",
      "feedback:false",
      "close",
    ]);
  });
});

describe("createAuxiliarySessionStartResultApplier", () => {
  it("session を受け取る start result applier を作る", () => {
    const session = makeAuxiliarySession({ id: "aux-started" });
    const events: string[] = [];
    const applyStartedSession = createAuxiliarySessionStartResultApplier({
      incrementMutationRevision: () => {
        events.push("revision");
      },
      applyActiveSession: (startedSession) => {
        events.push(`active:${startedSession.id}`);
      },
      setActionDockPinnedExpanded: (expanded) => {
        events.push(`dock:${expanded}`);
      },
      setForceComposerBlockedFeedback: (forced) => {
        events.push(`feedback:${forced}`);
      },
      closeLaunchDialog: () => {
        events.push("close");
      },
    });

    applyStartedSession(session);

    assert.deepEqual(events, [
      "revision",
      "active:aux-started",
      "dock:true",
      "feedback:false",
      "close",
    ]);
  });
});

describe("createActiveAuxiliarySessionStartResultApplier", () => {
  it("mutation revision と active session 反映を含む start result applier を作る", () => {
    const previousSession = makeAuxiliarySession({ id: "aux-previous" });
    const session = makeAuxiliarySession({ id: "aux-started" });
    const mutationRevision = { current: 4 };
    const activeSessionRef = { current: previousSession as AuxiliarySession | null };
    const appliedSessions: AuxiliarySession[] = [];
    const events: string[] = [];
    const applyStartedSession = createActiveAuxiliarySessionStartResultApplier({
      mutationRevision,
      activeSessionRef,
      setActiveSession: (startedSession) => {
        events.push(`revision:${mutationRevision.current}`);
        appliedSessions.push(startedSession);
        events.push(`active:${startedSession.id}`);
      },
      setActionDockPinnedExpanded: (expanded) => {
        events.push(`dock:${expanded}`);
      },
      setForceComposerBlockedFeedback: (forced) => {
        events.push(`feedback:${forced}`);
      },
      closeLaunchDialog: () => {
        events.push("close");
      },
    });

    applyStartedSession(session);

    assert.equal(mutationRevision.current, 5);
    assert.equal(activeSessionRef.current, session);
    assert.deepEqual(appliedSessions, [session]);
    assert.deepEqual(events, [
      "revision:5",
      "active:aux-started",
      "dock:true",
      "feedback:false",
      "close",
    ]);
  });
});

describe("finishAuxiliarySessionStartClosedLoad", () => {
  it("closed sessions reload を起動して pending を false に戻す", async () => {
    const closedSession = makeAuxiliarySession({ id: "closed-1", status: "closed" });
    const events: string[] = [];
    const appliedClosedSessions: AuxiliarySession[][] = [];

    finishAuxiliarySessionStartClosedLoad({
      parentSessionId: "parent-1",
      listAuxiliarySessions: async (parentSessionId) => {
        events.push(`list:${parentSessionId}`);
        return [closedSession];
      },
      getAuxiliarySession: async (sessionId) => {
        events.push(`get:${sessionId}`);
        return closedSession;
      },
      isActive: () => true,
      setClosedSessions: (sessions) => {
        events.push("closed");
        appliedClosedSessions.push(sessions);
      },
      setActionPending: (pending) => {
        events.push(`pending:${pending}`);
      },
    });

    assert.deepEqual(events.slice(0, 2), ["list:parent-1", "pending:false"]);

    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(events, [
      "list:parent-1",
      "pending:false",
      "get:closed-1",
      "closed",
    ]);
    assert.deepEqual(appliedClosedSessions, [[closedSession]]);
  });
});

describe("finishAuxiliarySessionStartClosedLoadWithApi", () => {
  it("api adapter 経由で closed sessions reload と pending clear を実行する", async () => {
    const closedSession = makeAuxiliarySession({ id: "closed-1", status: "closed" });
    const events: string[] = [];
    const appliedClosedSessions: AuxiliarySession[][] = [];

    finishAuxiliarySessionStartClosedLoadWithApi({
      parentSessionId: "parent-1",
      api: {
        listAuxiliarySessions: async (parentSessionId) => {
          events.push(`list:${parentSessionId}`);
          return [closedSession];
        },
        getAuxiliarySession: async (sessionId) => {
          events.push(`get:${sessionId}`);
          return closedSession;
        },
      },
      isActive: () => true,
      setClosedSessions: (sessions) => {
        events.push("closed");
        appliedClosedSessions.push(sessions);
      },
      setActionPending: (pending) => {
        events.push(`pending:${pending}`);
      },
    });

    assert.deepEqual(events.slice(0, 2), ["list:parent-1", "pending:false"]);

    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(events, [
      "list:parent-1",
      "pending:false",
      "get:closed-1",
      "closed",
    ]);
    assert.deepEqual(appliedClosedSessions, [[closedSession]]);
  });
});
