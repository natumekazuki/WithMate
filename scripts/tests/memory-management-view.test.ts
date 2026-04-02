import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildFilteredMemoryManagementSnapshot,
  DEFAULT_MEMORY_MANAGEMENT_VIEW_FILTERS,
} from "../../src/memory-management-view.js";
import type { MemoryManagementSnapshot } from "../../src/memory-management-state.js";

function createSnapshot(): MemoryManagementSnapshot {
  return {
    sessionMemories: [
      {
        sessionId: "session-1",
        taskTitle: "Copilot retry",
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
          goal: "stale session を直す",
          decisions: ["retry を維持する"],
          openQuestions: [],
          nextActions: [],
          notes: [],
          updatedAt: "2026-04-02T10:00:00.000Z",
        },
      },
      {
        sessionId: "session-2",
        taskTitle: "Theme polish",
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
          goal: "contrast を調整する",
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
            title: "retry 方針",
            detail: "SessionNotFound は internal retry する",
            keywords: ["retry", "session"],
            evidence: ["docs/design/provider-adapter.md"],
            createdAt: "2026-04-01T09:00:00.000Z",
            updatedAt: "2026-04-02T10:00:00.000Z",
            lastUsedAt: null,
          },
          {
            id: "project-entry-2",
            projectScopeId: "project-scope-1",
            sourceSessionId: "session-1",
            category: "context",
            title: "layout",
            detail: "right pane を維持する",
            keywords: ["layout"],
            evidence: [],
            createdAt: "2026-04-01T09:00:00.000Z",
            updatedAt: "2026-04-01T10:00:00.000Z",
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
            title: "話し方",
            detail: "落ち着いた調子",
            keywords: ["tone"],
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

describe("memory-management-view", () => {
  it("domain filter で対象の memory だけ残す", () => {
    const filtered = buildFilteredMemoryManagementSnapshot(createSnapshot(), {
      ...DEFAULT_MEMORY_MANAGEMENT_VIEW_FILTERS,
      domain: "project",
    });

    assert.equal(filtered?.sessionMemories.length, 0);
    assert.equal(filtered?.projectMemories.length, 1);
    assert.equal(filtered?.characterMemories.length, 0);
  });

  it("searchText で横断検索できる", () => {
    const filtered = buildFilteredMemoryManagementSnapshot(createSnapshot(), {
      ...DEFAULT_MEMORY_MANAGEMENT_VIEW_FILTERS,
      searchText: "SessionNotFound",
    });

    assert.equal(filtered?.sessionMemories.length, 0);
    assert.equal(filtered?.projectMemories[0]?.entries.length, 1);
    assert.equal(filtered?.projectMemories[0]?.entries[0]?.id, "project-entry-1");
  });

  it("session status と category filter を併用できる", () => {
    const filtered = buildFilteredMemoryManagementSnapshot(createSnapshot(), {
      ...DEFAULT_MEMORY_MANAGEMENT_VIEW_FILTERS,
      sessionStatus: "running",
      projectCategory: "decision",
      characterCategory: "tone",
    });

    assert.equal(filtered?.sessionMemories.length, 1);
    assert.equal(filtered?.sessionMemories[0]?.sessionId, "session-1");
    assert.equal(filtered?.projectMemories[0]?.entries.length, 1);
    assert.equal(filtered?.characterMemories[0]?.entries.length, 1);
  });

  it("updated-asc で古い順に並べ替える", () => {
    const filtered = buildFilteredMemoryManagementSnapshot(createSnapshot(), {
      ...DEFAULT_MEMORY_MANAGEMENT_VIEW_FILTERS,
      sort: "updated-asc",
    });

    assert.equal(filtered?.sessionMemories[0]?.sessionId, "session-2");
    assert.equal(filtered?.projectMemories[0]?.entries[0]?.id, "project-entry-2");
  });
});
