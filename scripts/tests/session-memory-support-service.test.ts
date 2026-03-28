import assert from "node:assert/strict";
import test from "node:test";

import type {
  CharacterMemoryEntry,
  ProjectMemoryEntry,
  Session,
  SessionMemory,
  SessionMemoryDelta,
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
    approvalMode: "provider-controlled",
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

function createProjectMemoryEntry(overrides?: Partial<ProjectMemoryEntry>): ProjectMemoryEntry {
  return {
    id: "project-entry-1",
    projectScopeId: "project-scope-1",
    sourceSessionId: "session-1",
    category: "decision",
    title: "Memory は段階的に入れる",
    detail: "Memory は段階的に入れる",
    keywords: ["memory", "段階的"],
    evidence: [],
    createdAt: "2026-03-28T00:00:00.000Z",
    updatedAt: "2026-03-28T00:00:00.000Z",
    lastUsedAt: null,
    ...overrides,
  };
}

function createCharacterMemoryEntry(overrides?: Partial<CharacterMemoryEntry>): CharacterMemoryEntry {
  return {
    id: "character-entry-1",
    characterScopeId: "character-scope-1",
    sourceSessionId: "session-1",
    category: "preference",
    title: "説明は短めが好み",
    detail: "説明は短めが好み",
    keywords: ["短め", "説明"],
    evidence: [],
    createdAt: "2026-03-28T00:00:00.000Z",
    updatedAt: "2026-03-28T00:00:00.000Z",
    lastUsedAt: null,
    ...overrides,
  };
}

test("SessionMemorySupportService は session 依存の memory/scope を同期する", () => {
  const calls: string[] = [];
  const service = new SessionMemorySupportService({
    ensureSessionMemory() {
      calls.push("ensureSessionMemory");
      return createSessionMemory();
    },
    upsertSessionMemory(memory) {
      calls.push(`upsertSessionMemory:${memory.goal}`);
    },
    ensureProjectScope(scope) {
      calls.push(`ensureProjectScope:${scope.projectKey}`);
      return { id: "project-scope-1" };
    },
    listProjectMemoryEntries() {
      return [];
    },
    upsertProjectMemoryEntry(entry) {
      return createProjectMemoryEntry(entry);
    },
    markProjectMemoryEntriesUsed() {},
    ensureCharacterScope(input) {
      calls.push(`ensureCharacterScope:${input.characterId}`);
      return { id: "character-scope-1" };
    },
    listCharacterMemoryEntries() {
      return [];
    },
    upsertCharacterMemoryEntry(entry) {
      return createCharacterMemoryEntry(entry);
    },
    markCharacterMemoryEntriesUsed() {},
    upsertSession(session) {
      return session;
    },
  });

  service.syncSessionDependencies(createSession());

  assert.deepEqual(calls, [
    "ensureSessionMemory",
    "upsertSessionMemory:Memory 設計を進める",
    "ensureProjectScope:directory:C:/workspace",
    "ensureCharacterScope:char-1",
  ]);
});

test("SessionMemorySupportService は project promotion と monologue append を扱う", () => {
  const promoted: Array<string> = [];
  const marked: string[][] = [];
  let updatedSession: Session | null = null;
  const service = new SessionMemorySupportService({
    ensureSessionMemory() {
      return createSessionMemory();
    },
    upsertSessionMemory() {},
    ensureProjectScope() {
      return { id: "project-scope-1" };
    },
    listProjectMemoryEntries() {
      return [createProjectMemoryEntry()];
    },
    upsertProjectMemoryEntry(entry) {
      promoted.push(`${entry.category}:${entry.detail}`);
      return createProjectMemoryEntry(entry);
    },
    markProjectMemoryEntriesUsed(entryIds) {
      marked.push(entryIds);
    },
    ensureCharacterScope() {
      return { id: "character-scope-1" };
    },
    listCharacterMemoryEntries() {
      return [createCharacterMemoryEntry()];
    },
    upsertCharacterMemoryEntry(entry) {
      return createCharacterMemoryEntry(entry);
    },
    markCharacterMemoryEntriesUsed() {},
    upsertSession(session) {
      updatedSession = session;
      return session;
    },
  });

  const delta: SessionMemoryDelta = {
    decisions: ["Memory は段階的に入れる"],
    notes: ["制約: Character Memory は coding prompt に入れない"],
  };
  const promotedCount = service.promoteSessionMemoryDeltaToProjectMemory(createSession(), delta);

  const resolved = service.resolveProjectMemoryEntriesForPrompt(
    createSession(),
    "Memory は段階的に入れる方針を確認したい",
    createSessionMemory({ goal: "Memory 設計を整理する" }),
  );
  const appended = service.appendMonologueToSession(createSession(), {
    mood: "calm",
    text: "今日は少し整理が進んだ。",
  });

  assert.deepEqual(promoted, [
    "decision:Memory は段階的に入れる",
    "constraint:Character Memory は coding prompt に入れない",
  ]);
  assert.equal(promotedCount, 2);
  assert.deepEqual(resolved.map((entry) => entry.id), ["project-entry-1"]);
  assert.deepEqual(marked, [["project-entry-1"]]);
  assert.equal(updatedSession?.stream.length, 1);
  assert.equal(appended.stream[0]?.text, "今日は少し整理が進んだ。");
});
