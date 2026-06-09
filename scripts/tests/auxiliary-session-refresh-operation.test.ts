import assert from "node:assert/strict";
import test from "node:test";

import {
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
