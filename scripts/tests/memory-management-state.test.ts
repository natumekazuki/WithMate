import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildMemoryManagementPageRequest,
  cloneMemoryManagementSnapshot,
  mergeMemoryManagementSnapshots,
  removeCharacterMemoryEntryFromSnapshot,
  removeMateProfileItemFromSnapshot,
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
    mateProfileItems: [
      {
        id: "profile-item-1",
        sectionKey: "core",
        projectDigestId: null,
        category: "persona",
        claimKey: "name",
        claimValue: "Alice",
        renderedText: "Alice",
        normalizedClaim: "alice",
        confidence: 80,
        salienceScore: 90,
        state: "active",
        tags: ["note:friend"],
        updatedAt: "2026-04-02T10:00:00.000Z",
      },
      {
        id: "profile-item-2",
        sectionKey: "core",
        projectDigestId: null,
        category: "persona",
        claimKey: "nickname",
        claimValue: "A",
        renderedText: "nickname",
        normalizedClaim: "nickname",
        confidence: 70,
        salienceScore: 80,
        state: "active",
        tags: ["note:tag"],
        updatedAt: "2026-04-01T10:00:00.000Z",
      },
    ],
  };
}

describe("memory-management-state", () => {
  it("page request は現在の domain filter と明示 limit を保持する", () => {
    const request = buildMemoryManagementPageRequest({
      domain: "project",
      searchText: "target",
      sort: "updated-desc",
      sessionStatus: "all",
      projectCategory: "decision",
      characterCategory: "all",
    }, {
      limit: 50,
    });

    assert.equal(request.domain, "project");
    assert.equal(request.limit, 50);
    assert.equal(request.cursor, 0);
  });

  it("page request は追加読み込み時の domain override と cursor を優先する", () => {
    const request = buildMemoryManagementPageRequest({
      domain: "all",
      searchText: "",
      sort: "updated-desc",
      sessionStatus: "all",
      projectCategory: "all",
      characterCategory: "all",
    }, {
      domain: "session",
      cursor: 50,
      limit: 25,
    });

    assert.equal(request.domain, "session");
    assert.equal(request.cursor, 50);
    assert.equal(request.limit, 25);
  });

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

  it("mate profile item を削除する", () => {
    const snapshot = createSnapshot();

    const nextSnapshot = removeMateProfileItemFromSnapshot(snapshot, "profile-item-1");

    assert.equal(nextSnapshot.mateProfileItems?.length, 1);
    assert.equal(nextSnapshot.mateProfileItems?.[0]?.id, "profile-item-2");
  });

  it("session page merge は sessionId で重複を落とす", () => {
    const snapshot = createSnapshot();

    const nextSnapshot = mergeMemoryManagementSnapshots(snapshot, {
      sessionMemories: [
        snapshot.sessionMemories[1],
        {
          ...snapshot.sessionMemories[1],
          sessionId: "session-3",
          taskTitle: "Task C",
        },
      ],
      projectMemories: [],
      characterMemories: [],
    }, "session");

    assert.deepEqual(nextSnapshot.sessionMemories.map((item) => item.sessionId), ["session-1", "session-2", "session-3"]);
  });

  it("project / character page merge は entry id で重複を落とす", () => {
    const snapshot = createSnapshot();

    const nextProjectSnapshot = mergeMemoryManagementSnapshots(snapshot, {
      sessionMemories: [],
      projectMemories: [{
        scope: snapshot.projectMemories[0].scope,
        entries: [
          snapshot.projectMemories[0].entries[0],
          {
            ...snapshot.projectMemories[0].entries[0],
            id: "project-entry-4",
            title: "entry-4",
          },
        ],
      }],
      characterMemories: [],
    }, "project");
    const nextCharacterSnapshot = mergeMemoryManagementSnapshots(snapshot, {
      sessionMemories: [],
      projectMemories: [],
      characterMemories: [{
        scope: snapshot.characterMemories[0].scope,
        entries: [
          snapshot.characterMemories[0].entries[0],
          {
            ...snapshot.characterMemories[0].entries[0],
            id: "character-entry-2",
            title: "tone-2",
          },
        ],
      }],
      mateProfileItems: [],
    }, "character");

    const nextProfileItemSnapshot = mergeMemoryManagementSnapshots(snapshot, {
      sessionMemories: [],
      projectMemories: [],
      characterMemories: [],
      mateProfileItems: [
        {
          ...snapshot.mateProfileItems?.[1],
          id: "profile-item-1",
        },
        {
          ...snapshot.mateProfileItems?.[1],
          id: "profile-item-3",
        },
      ],
    }, "mate_profile");

    assert.deepEqual(nextProjectSnapshot.projectMemories[0]?.entries.map((entry) => entry.id), [
      "project-entry-1",
      "project-entry-4",
    ]);
    assert.deepEqual(nextCharacterSnapshot.characterMemories[0]?.entries.map((entry) => entry.id), [
      "character-entry-1",
      "character-entry-2",
    ]);
    assert.deepEqual(nextProfileItemSnapshot.mateProfileItems?.map((item) => item.id), [
      "profile-item-1",
      "profile-item-2",
      "profile-item-3",
    ]);
  });
});
