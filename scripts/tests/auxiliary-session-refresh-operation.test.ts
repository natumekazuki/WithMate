import assert from "node:assert/strict";
import test from "node:test";

import {
  applyActiveAuxiliarySessionLoadResult,
  applyActiveAuxiliarySessionRefreshResult,
  applyClosedAuxiliarySessionsLoadResult,
  clearAuxiliarySessionsLoadState,
  runActiveAuxiliarySessionLoadOperation,
  runActiveAuxiliarySessionRefreshOperation,
  runClosedAuxiliarySessionsLoadOperation,
} from "../../src/auxiliary-session-refresh-operation.js";
import type { AuxiliarySession } from "../../src/auxiliary-session-state.js";

function createAuxiliarySession(overrides: Partial<AuxiliarySession> = {}): AuxiliarySession {
  return {
    id: "aux-1",
    parentSessionId: "session-1",
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
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    closedAt: "",
    ...overrides,
  };
}

test("runActiveAuxiliarySessionRefreshOperation は active id が違う場合 load しない", async () => {
  const loadedSessionIds: string[] = [];

  const result = await runActiveAuxiliarySessionRefreshOperation({
    sessionId: "aux-1",
    activeSessionId: "aux-other",
    loadAuxiliarySession: async (sessionId) => {
      loadedSessionIds.push(sessionId);
      return createAuxiliarySession({ id: sessionId });
    },
    isActive: () => true,
  });

  assert.deepEqual(result, { status: "skipped" });
  assert.deepEqual(loadedSessionIds, []);
});

test("runActiveAuxiliarySessionRefreshOperation は load 後に inactive なら stale にする", async () => {
  const savedSession = createAuxiliarySession({ title: "saved" });
  let active = true;

  const result = await runActiveAuxiliarySessionRefreshOperation({
    sessionId: savedSession.id,
    activeSessionId: savedSession.id,
    loadAuxiliarySession: async () => {
      active = false;
      return savedSession;
    },
    isActive: () => active,
  });

  assert.deepEqual(result, { status: "stale" });
});

test("runActiveAuxiliarySessionRefreshOperation は active のままなら saved session を返す", async () => {
  const savedSession = createAuxiliarySession({ title: "saved" });

  const result = await runActiveAuxiliarySessionRefreshOperation({
    sessionId: savedSession.id,
    activeSessionId: savedSession.id,
    loadAuxiliarySession: async () => savedSession,
    isActive: () => true,
  });

  assert.deepEqual(result, {
    status: "loaded",
    savedSession,
  });
});

test("runActiveAuxiliarySessionRefreshOperation は active のままなら null 保存結果も返す", async () => {
  const result = await runActiveAuxiliarySessionRefreshOperation({
    sessionId: "aux-1",
    activeSessionId: "aux-1",
    loadAuxiliarySession: async () => null,
    isActive: () => true,
  });

  assert.deepEqual(result, {
    status: "loaded",
    savedSession: null,
  });
});

test("applyActiveAuxiliarySessionRefreshResult は反映時に active ref を同期する", () => {
  const currentSession = createAuxiliarySession({ id: "aux-1", title: "current" });
  const savedSession = createAuxiliarySession({ id: "aux-1", title: "saved" });
  const activeSessionRef = { current: currentSession as AuxiliarySession | null };

  assert.equal(
    applyActiveAuxiliarySessionRefreshResult({
      currentSession,
      savedSession,
      sessionId: "aux-1",
      activeSessionRef,
    }),
    savedSession,
  );
  assert.equal(activeSessionRef.current, savedSession);
});

test("applyActiveAuxiliarySessionRefreshResult は反映しない場合 active ref を維持する", () => {
  const currentSession = createAuxiliarySession({ id: "aux-1", title: "current" });
  const savedSession = createAuxiliarySession({ id: "aux-other", title: "saved" });
  const activeSessionRef = { current: currentSession as AuxiliarySession | null };

  assert.equal(
    applyActiveAuxiliarySessionRefreshResult({
      currentSession,
      savedSession,
      sessionId: "aux-other",
      activeSessionRef,
    }),
    currentSession,
  );
  assert.equal(activeSessionRef.current, currentSession);
});

test("runActiveAuxiliarySessionLoadOperation は parent session id がない場合 load しない", async () => {
  const loadedParentSessionIds: string[] = [];

  const result = await runActiveAuxiliarySessionLoadOperation({
    parentSessionId: null,
    getActiveAuxiliarySession: async (parentSessionId) => {
      loadedParentSessionIds.push(parentSessionId);
      return createAuxiliarySession({ parentSessionId });
    },
    isActive: () => true,
  });

  assert.deepEqual(result, { status: "skipped" });
  assert.deepEqual(loadedParentSessionIds, []);
});

test("runActiveAuxiliarySessionLoadOperation は active session を読み込む", async () => {
  const activeSession = createAuxiliarySession({ parentSessionId: "parent-1" });

  const result = await runActiveAuxiliarySessionLoadOperation({
    parentSessionId: "parent-1",
    getActiveAuxiliarySession: async () => activeSession,
    isActive: () => true,
  });

  assert.deepEqual(result, {
    status: "loaded",
    session: activeSession,
  });
});

test("runActiveAuxiliarySessionLoadOperation は load failure を null loaded result にする", async () => {
  const result = await runActiveAuxiliarySessionLoadOperation({
    parentSessionId: "parent-1",
    getActiveAuxiliarySession: async () => {
      throw new Error("load failed");
    },
    isActive: () => true,
  });

  assert.deepEqual(result, {
    status: "loaded",
    session: null,
  });
});

test("runActiveAuxiliarySessionLoadOperation は load 後に inactive なら stale にする", async () => {
  let active = true;

  const result = await runActiveAuxiliarySessionLoadOperation({
    parentSessionId: "parent-1",
    getActiveAuxiliarySession: async () => {
      active = false;
      return createAuxiliarySession({ parentSessionId: "parent-1" });
    },
    isActive: () => active,
  });

  assert.deepEqual(result, { status: "stale" });
});

test("applyActiveAuxiliarySessionLoadResult は loaded result だけ active session に反映する", () => {
  const activeSession = createAuxiliarySession({ id: "aux-loaded" });
  const appliedSessions: Array<AuxiliarySession | null> = [];

  assert.equal(
    applyActiveAuxiliarySessionLoadResult({
      result: {
        status: "loaded",
        session: activeSession,
      },
      setActiveSession: (session) => {
        appliedSessions.push(session);
      },
    }),
    true,
  );

  assert.deepEqual(appliedSessions, [activeSession]);
});

test("applyActiveAuxiliarySessionLoadResult は loaded null result を active session clear として反映する", () => {
  const appliedSessions: Array<AuxiliarySession | null> = [];

  assert.equal(
    applyActiveAuxiliarySessionLoadResult({
      result: {
        status: "loaded",
        session: null,
      },
      setActiveSession: (session) => {
        appliedSessions.push(session);
      },
    }),
    true,
  );

  assert.deepEqual(appliedSessions, [null]);
});

test("applyActiveAuxiliarySessionLoadResult は stale / skipped result では active session を変更しない", () => {
  const appliedSessions: Array<AuxiliarySession | null> = [];

  assert.equal(
    applyActiveAuxiliarySessionLoadResult({
      result: { status: "stale" },
      setActiveSession: (session) => {
        appliedSessions.push(session);
      },
    }),
    false,
  );
  assert.equal(
    applyActiveAuxiliarySessionLoadResult({
      result: { status: "skipped" },
      setActiveSession: (session) => {
        appliedSessions.push(session);
      },
    }),
    false,
  );

  assert.deepEqual(appliedSessions, []);
});

test("runClosedAuxiliarySessionsLoadOperation は parent session id がない場合 load しない", async () => {
  const listedSessionIds: string[] = [];

  const result = await runClosedAuxiliarySessionsLoadOperation({
    parentSessionId: null,
    listAuxiliarySessions: async (parentSessionId) => {
      listedSessionIds.push(parentSessionId);
      return [];
    },
    getAuxiliarySession: async () => null,
    isActive: () => true,
  });

  assert.deepEqual(result, { status: "skipped" });
  assert.deepEqual(listedSessionIds, []);
});

test("runClosedAuxiliarySessionsLoadOperation は closed session details を読み込む", async () => {
  const closedSession = createAuxiliarySession({ id: "closed-1", status: "closed" });
  const listedParentSessionIds: string[] = [];
  const requestedSessionIds: string[] = [];

  const result = await runClosedAuxiliarySessionsLoadOperation({
    parentSessionId: "parent-1",
    listAuxiliarySessions: async (parentSessionId) => {
      listedParentSessionIds.push(parentSessionId);
      return [
        createAuxiliarySession({ id: "active-1", status: "active" }),
        createAuxiliarySession({ id: "closed-1", status: "closed" }),
        createAuxiliarySession({ id: "closed-missing", status: "closed" }),
      ];
    },
    getAuxiliarySession: async (sessionId) => {
      requestedSessionIds.push(sessionId);
      if (sessionId === closedSession.id) {
        return closedSession;
      }
      return null;
    },
    isActive: () => true,
  });

  assert.deepEqual(result, {
    status: "loaded",
    sessions: [closedSession],
  });
  assert.deepEqual(listedParentSessionIds, ["parent-1"]);
  assert.deepEqual(requestedSessionIds, ["closed-missing", "closed-1"]);
});

test("runClosedAuxiliarySessionsLoadOperation は load failure を empty loaded result にする", async () => {
  const result = await runClosedAuxiliarySessionsLoadOperation({
    parentSessionId: "parent-1",
    listAuxiliarySessions: async () => {
      throw new Error("load failed");
    },
    getAuxiliarySession: async () => null,
    isActive: () => true,
  });

  assert.deepEqual(result, {
    status: "loaded",
    sessions: [],
  });
});

test("runClosedAuxiliarySessionsLoadOperation は load 後に inactive なら stale にする", async () => {
  let active = true;

  const result = await runClosedAuxiliarySessionsLoadOperation({
    parentSessionId: "parent-1",
    listAuxiliarySessions: async () => {
      active = false;
      return [];
    },
    getAuxiliarySession: async () => null,
    isActive: () => active,
  });

  assert.deepEqual(result, { status: "stale" });
});

test("applyClosedAuxiliarySessionsLoadResult は loaded result だけ closed sessions に反映する", () => {
  const closedSession = createAuxiliarySession({ id: "closed-1", status: "closed" });
  const appliedSessions: AuxiliarySession[][] = [];

  assert.equal(
    applyClosedAuxiliarySessionsLoadResult({
      result: {
        status: "loaded",
        sessions: [closedSession],
      },
      setClosedSessions: (sessions) => {
        appliedSessions.push(sessions);
      },
    }),
    true,
  );

  assert.deepEqual(appliedSessions, [[closedSession]]);
});

test("applyClosedAuxiliarySessionsLoadResult は empty loaded result を closed sessions clear として反映する", () => {
  const appliedSessions: AuxiliarySession[][] = [];

  assert.equal(
    applyClosedAuxiliarySessionsLoadResult({
      result: {
        status: "loaded",
        sessions: [],
      },
      setClosedSessions: (sessions) => {
        appliedSessions.push(sessions);
      },
    }),
    true,
  );

  assert.deepEqual(appliedSessions, [[]]);
});

test("applyClosedAuxiliarySessionsLoadResult は stale / skipped result では closed sessions を変更しない", () => {
  const appliedSessions: AuxiliarySession[][] = [];

  assert.equal(
    applyClosedAuxiliarySessionsLoadResult({
      result: { status: "stale" },
      setClosedSessions: (sessions) => {
        appliedSessions.push(sessions);
      },
    }),
    false,
  );
  assert.equal(
    applyClosedAuxiliarySessionsLoadResult({
      result: { status: "skipped" },
      setClosedSessions: (sessions) => {
        appliedSessions.push(sessions);
      },
    }),
    false,
  );

  assert.deepEqual(appliedSessions, []);
});

test("clearAuxiliarySessionsLoadState は active session と closed sessions を初期化する", () => {
  const activeSessions: Array<AuxiliarySession | null> = [];
  const closedSessions: AuxiliarySession[][] = [];

  clearAuxiliarySessionsLoadState({
    setActiveSession: (session) => {
      activeSessions.push(session);
    },
    setClosedSessions: (sessions) => {
      closedSessions.push(sessions);
    },
  });

  assert.deepEqual(activeSessions, [null]);
  assert.deepEqual(closedSessions, [[]]);
});
