import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  cloneMemoryManagementSnapshot,
  removeCharacterMemoryEntryFromSnapshot,
  removeProjectMemoryEntryFromSnapshot,
  removeSessionMemoryFromSnapshot,
  type MemoryManagementSnapshot,
} from "../../src/memory-management-state.js";

function createSnapshot(): MemoryManagementSnapshot {
  return {
    sessionMemories: [
      {
        sessionId: "session-1",
        taskTitle: "Task A",
        character: "A",
        provider: "copilot",
        workspaceLabel: "repo-a",
        workspacePath: "C:/repo-a",
        status: "running",
        runState: "running",
        updatedAt: "2026-04-02T10:00:00.000Z",
        memory: {
          sessionId: "session-1",
          workspacePath: "C:/repo-a",
          threadId: "thread-1",
          schemaVersion: 1,
          goal: "goal-a",
          decisions: [],
          openQuestions: [],
          nextActions: [],
          notes: [],
          updatedAt: "2026-04-02T10:00:00.000Z",
        },
      },
      {
        sessionId: "session-2",
        taskTitle: "Task B",
        character: "B",
        provider: "codex",
        workspaceLabel: "repo-b",
        workspacePath: "C:/repo-b",
        status: "saved",
        runState: "idle",
        updatedAt: "2026-04-01T10:00:00.000Z",
        memory: {
          sessionId: "session-2",
          workspacePath: "C:/repo-b",
          threadId: "thread-2",
          schemaVersion: 1,
          goal: "goal-b",
          decisions: [],
          openQuestions: [],
          nextActions: [],
          notes: [],
          updatedAt: "2026-04-01T10:00:00.000Z",
        },
      },
    ],
    projectMemories: [
      {
        scope: {
          id: "project-scope-1",
          projectType: "directory",
          projectKey: "directory:C:/repo-a",
          workspacePath: "C:/repo-a",
          gitRoot: null,
          gitRemoteUrl: null,
          displayName: "repo-a",
          createdAt: "2026-04-01T09:00:00.000Z",
          updatedAt: "2026-04-02T10:00:00.000Z",
        },
        entries: [
          {
            id: "project-entry-1",
            projectScopeId: "project-scope-1",
            sourceSessionId: "session-1",
            category: "decision",
            title: "entry-1",
            detail: "detail-1",
            keywords: [],
            evidence: [],
            createdAt: "2026-04-01T09:00:00.000Z",
            updatedAt: "2026-04-02T10:00:00.000Z",
            lastUsedAt: null,
          },
        ],
      },
      {
        scope: {
          id: "project-scope-2",
          projectType: "directory",
          projectKey: "directory:C:/repo-b",
          workspacePath: "C:/repo-b",
          gitRoot: null,
          gitRemoteUrl: null,
          displayName: "repo-b",
          createdAt: "2026-04-01T09:00:00.000Z",
          updatedAt: "2026-04-02T10:00:00.000Z",
        },
        entries: [
          {
            id: "project-entry-2",
            projectScopeId: "project-scope-2",
            sourceSessionId: "session-2",
            category: "context",
            title: "entry-2",
            detail: "detail-2",
            keywords: [],
            evidence: [],
            createdAt: "2026-04-01T09:00:00.000Z",
            updatedAt: "2026-04-01T10:00:00.000Z",
            lastUsedAt: null,
          },
          {
            id: "project-entry-3",
            projectScopeId: "project-scope-2",
            sourceSessionId: "session-2",
            category: "deferred",
            title: "entry-3",
            detail: "detail-3",
            keywords: [],
            evidence: [],
            createdAt: "2026-04-01T09:00:00.000Z",
            updatedAt: "2026-04-01T11:00:00.000Z",
            lastUsedAt: null,
          },
        ],
      },
    ],
    characterMemories: [
      {
        scope: {
          id: "character-scope-1",
          characterId: "char-a",
          displayName: "A",
          createdAt: "2026-04-01T09:00:00.000Z",
          updatedAt: "2026-04-02T10:00:00.000Z",
        },
        entries: [
          {
            id: "character-entry-1",
            characterScopeId: "character-scope-1",
            sourceSessionId: "session-1",
            category: "tone",
            title: "tone",
            detail: "detail",
            keywords: [],
            evidence: [],
            createdAt: "2026-04-01T09:00:00.000Z",
            updatedAt: "2026-04-02T10:00:00.000Z",
            lastUsedAt: null,
          },
        ],
      },
    ],
  };
}

describe("memory-management-state", () => {
  it("session memory を local snapshot から削除する", () => {
    const snapshot = createSnapshot();
    const original = cloneMemoryManagementSnapshot(snapshot);

    const nextSnapshot = removeSessionMemoryFromSnapshot(snapshot, "session-1");

    assert.equal(nextSnapshot.sessionMemories.length, 1);
    assert.equal(nextSnapshot.sessionMemories[0]?.sessionId, "session-2");
    assert.deepEqual(snapshot, original);
  });

  it("project entry を削除した結果 empty になった group を落とす", () => {
    const snapshot = createSnapshot();

    const nextSnapshot = removeProjectMemoryEntryFromSnapshot(snapshot, "project-entry-1");

    assert.equal(nextSnapshot.projectMemories.length, 1);
    assert.equal(nextSnapshot.projectMemories[0]?.scope.id, "project-scope-2");
  });

  it("project entry 削除時は group 内の残り entry を維持する", () => {
    const snapshot = createSnapshot();

    const nextSnapshot = removeProjectMemoryEntryFromSnapshot(snapshot, "project-entry-2");

    assert.equal(nextSnapshot.projectMemories.length, 2);
    assert.deepEqual(
      nextSnapshot.projectMemories.find((group) => group.scope.id === "project-scope-2")?.entries.map((entry) => entry.id),
      ["project-entry-3"],
    );
  });

  it("character entry を削除した結果 empty になった group を落とす", () => {
    const snapshot = createSnapshot();

    const nextSnapshot = removeCharacterMemoryEntryFromSnapshot(snapshot, "character-entry-1");

    assert.equal(nextSnapshot.characterMemories.length, 0);
  });

  it("存在しない character entry を削除する時は snapshot をそのまま返す", () => {
    const snapshot = createSnapshot();

    const nextSnapshot = removeCharacterMemoryEntryFromSnapshot(snapshot, "missing-entry");

    assert.equal(nextSnapshot, snapshot);
  });
});
