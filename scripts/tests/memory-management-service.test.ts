import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildNewSession } from "../../src/app-state.js";
import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import { MemoryManagementService } from "../../src-electron/memory-management-service.js";

function createSession(id: string, overrides?: Partial<ReturnType<typeof buildNewSession>>) {
  return {
    ...buildNewSession({
      taskTitle: `Session ${id}`,
      workspaceLabel: `workspace-${id}`,
      workspacePath: `C:/workspace/${id}`,
      branch: "main",
      characterId: `char-${id}`,
      character: `Character ${id}`,
      characterIconPath: "",
      characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
      approvalMode: DEFAULT_APPROVAL_MODE,
      provider: "codex",
    }),
    id,
    ...overrides,
  };
}

describe("MemoryManagementService", () => {
  it("session / project / character memory を snapshot に集約する", () => {
    const deleted: string[] = [];
    const service = new MemoryManagementService({
      listSessions: () => [createSession("session-1")],
      listSessionMemories: () => [{
        sessionId: "session-1",
        workspacePath: "C:/workspace/session-1",
        threadId: "thread-1",
        schemaVersion: 1,
        goal: "goal",
        decisions: ["decision"],
        openQuestions: [],
        nextActions: ["next"],
        notes: [],
        updatedAt: "2026-04-02T10:00:00.000Z",
      }],
      deleteSessionMemory: (sessionId) => {
        deleted.push(`session:${sessionId}`);
      },
      listProjectScopes: () => [{
        id: "project-scope-1",
        projectType: "directory",
        projectKey: "directory:C:/workspace/session-1",
        workspacePath: "C:/workspace/session-1",
        gitRoot: null,
        gitRemoteUrl: null,
        displayName: "workspace",
        createdAt: "2026-04-02T09:00:00.000Z",
        updatedAt: "2026-04-02T10:00:00.000Z",
      }],
      listProjectMemoryEntries: () => [{
        id: "project-entry-1",
        projectScopeId: "project-scope-1",
        sourceSessionId: "session-1",
        category: "decision",
        title: "方針",
        detail: "detail",
        keywords: ["keyword"],
        evidence: ["docs/design/memory-architecture.md"],
        createdAt: "2026-04-02T09:00:00.000Z",
        updatedAt: "2026-04-02T10:00:00.000Z",
        lastUsedAt: null,
      }],
      deleteProjectMemoryEntry: (entryId) => {
        deleted.push(`project:${entryId}`);
      },
      listCharacterScopes: () => [{
        id: "character-scope-1",
        characterId: "char-session-1",
        displayName: "Character session-1",
        createdAt: "2026-04-02T09:00:00.000Z",
        updatedAt: "2026-04-02T10:00:00.000Z",
      }],
      listCharacterMemoryEntries: () => [{
        id: "character-entry-1",
        characterScopeId: "character-scope-1",
        sourceSessionId: "session-1",
        category: "tone",
        title: "話し方",
        detail: "detail",
        keywords: ["tone"],
        evidence: [],
        createdAt: "2026-04-02T09:00:00.000Z",
        updatedAt: "2026-04-02T10:00:00.000Z",
        lastUsedAt: null,
      }],
      deleteCharacterMemoryEntry: (entryId) => {
        deleted.push(`character:${entryId}`);
      },
    });

    const snapshot = service.getSnapshot();

    assert.equal(snapshot.sessionMemories[0]?.taskTitle, "Session session-1");
    assert.equal(snapshot.projectMemories[0]?.entries.length, 1);
    assert.equal(snapshot.characterMemories[0]?.entries.length, 1);

    service.deleteSessionMemory("session-1");
    service.deleteProjectMemoryEntry("project-entry-1");
    service.deleteCharacterMemoryEntry("character-entry-1");

    assert.deepEqual(deleted, [
      "session:session-1",
      "project:project-entry-1",
      "character:character-entry-1",
    ]);
  });
});
