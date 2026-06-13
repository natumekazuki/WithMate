import assert from "node:assert/strict";
import test from "node:test";

import type {
  Session,
  SessionMemory,
} from "../../src/app-state.js";
import { SessionMemorySupportService } from "../../src-electron/session-memory-support-service.js";

function createSession(overrides?: Partial<Session>): Session {
  return {
    id: "session-1",
    provider: "codex",
    catalogRevision: 1,
    model: "gpt-5.4",
    reasoningEffort: "high",
    taskTitle: "Memory 設計を進める",
    workspaceLabel: "WithMate",
    workspacePath: "C:/workspace",
    branch: "main",
    characterId: "char-1",
    character: "Muse",
    characterIconPath: "",
    characterThemeColors: { main: "#111111", sub: "#222222" },
    approvalMode: "on-request",
    status: "idle",
    runState: "idle",
    threadId: "thread-1",
    updatedAt: "2026-03-28T00:00:00.000Z",
    messages: [
      { id: "m1", role: "user", text: "メモリー設計を整理したい", createdAt: "2026-03-28T00:00:00.000Z" },
    ],
    stream: [],
    allowedAdditionalDirectories: [],
    ...overrides,
  };
}

function createSessionMemory(overrides?: Partial<SessionMemory>): SessionMemory {
  return {
    sessionId: "session-1",
    workspacePath: "C:/workspace",
    threadId: "thread-1",
    schemaVersion: 1,
    goal: "",
    decisions: [],
    openQuestions: [],
    nextActions: [],
    notes: [],
    updatedAt: "2026-03-28T00:00:00.000Z",
    ...overrides,
  };
}

test("SessionMemorySupportService は session 依存の memory/scope を同期する", () => {
  const calls: string[] = [];
  const service = new SessionMemorySupportService({
    getSessionMemory(sessionId) {
      calls.push(`getSessionMemory:${sessionId}`);
      return createSessionMemory();
    },
    upsertSessionMemory(memory) {
      calls.push(`upsertSessionMemory:${memory.goal}`);
    },
    ensureProjectScope(scope) {
      calls.push(`ensureProjectScope:${scope.projectKey}`);
      return { id: "project-scope-1" };
    },
  });

  service.syncSessionDependencies(createSession());

  assert.deepEqual(calls, [
    "getSessionMemory:session-1",
    "upsertSessionMemory:Memory 設計を進める",
    "ensureProjectScope:directory:C:/workspace",
  ]);
});

test("SessionMemorySupportService は削除済み session memory を起動同期で再作成しない", () => {
  const calls: string[] = [];
  const service = new SessionMemorySupportService({
    getSessionMemory(sessionId) {
      calls.push(`getSessionMemory:${sessionId}`);
      return null;
    },
    upsertSessionMemory() {
      calls.push("upsertSessionMemory");
    },
    ensureProjectScope(scope) {
      calls.push(`ensureProjectScope:${scope.projectKey}`);
      return { id: "project-scope-1" };
    },
  });

  service.syncSessionDependencies(createSession());

  assert.deepEqual(calls, [
    "getSessionMemory:session-1",
    "ensureProjectScope:directory:C:/workspace",
  ]);
});

