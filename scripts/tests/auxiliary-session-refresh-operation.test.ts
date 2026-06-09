import assert from "node:assert/strict";
import test from "node:test";

import {
  runActiveAuxiliarySessionRefreshOperation,
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
