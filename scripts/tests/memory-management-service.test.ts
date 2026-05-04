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
      listSessionSummaries: () => [createSession("session-1")],
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
      listMateProfileItems: () => [],
      forgetMateProfileItem: () => {},
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

  it("memory management page を domain / cursor / limit 単位で返す", () => {
    const service = new MemoryManagementService({
      listSessionSummaries: () => [
        createSession("session-1"),
        createSession("session-2"),
      ],
      listSessionMemories: () => [
        {
          sessionId: "session-1",
          workspacePath: "C:/workspace/session-1",
          threadId: "thread-1",
          schemaVersion: 1,
          goal: "goal-1",
          decisions: [],
          openQuestions: [],
          nextActions: [],
          notes: [],
          updatedAt: "2026-04-02T11:00:00.000Z",
        },
        {
          sessionId: "session-2",
          workspacePath: "C:/workspace/session-2",
          threadId: "thread-2",
          schemaVersion: 1,
          goal: "goal-2",
          decisions: [],
          openQuestions: [],
          nextActions: [],
          notes: [],
          updatedAt: "2026-04-02T10:00:00.000Z",
        },
      ],
      deleteSessionMemory: () => {},
      listProjectScopes: () => [],
      listProjectMemoryEntries: () => [],
      deleteProjectMemoryEntry: () => {},
      listCharacterScopes: () => [],
      listCharacterMemoryEntries: () => [],
      deleteCharacterMemoryEntry: () => {},
    });

    const firstPage = service.getPage({ domain: "session", limit: 1 });
    const secondPage = service.getPage({ domain: "session", cursor: firstPage.pages.session.nextCursor ?? 0, limit: 1 });

    assert.deepEqual(firstPage.snapshot.sessionMemories.map((item) => item.sessionId), ["session-1"]);
    assert.equal(firstPage.snapshot.projectMemories.length, 0);
    assert.equal(firstPage.pages.session.hasMore, true);
    assert.equal(firstPage.pages.session.total, 2);
    assert.deepEqual(secondPage.snapshot.sessionMemories.map((item) => item.sessionId), ["session-2"]);
    assert.equal(secondPage.pages.session.hasMore, false);
  });

  it("project / character page は filter 後に entry updatedAt 順で返す", () => {
    const service = new MemoryManagementService({
      listSessionSummaries: () => [],
      listSessionMemories: () => [],
      deleteSessionMemory: () => {},
      listProjectScopes: () => [
        {
          id: "project-scope-old",
          projectType: "directory",
          projectKey: "directory:C:/old",
          workspacePath: "C:/old",
          gitRoot: null,
          gitRemoteUrl: null,
          displayName: "old scope",
          createdAt: "2026-04-02T09:00:00.000Z",
          updatedAt: "2026-04-02T09:00:00.000Z",
        },
        {
          id: "project-scope-new",
          projectType: "directory",
          projectKey: "directory:C:/new",
          workspacePath: "C:/new",
          gitRoot: null,
          gitRemoteUrl: null,
          displayName: "new scope",
          createdAt: "2026-04-02T09:00:00.000Z",
          updatedAt: "2026-04-01T09:00:00.000Z",
        },
      ],
      listProjectMemoryEntries: (scopeId) => scopeId === "project-scope-old"
        ? [{
            id: "project-entry-old",
            projectScopeId: scopeId,
            sourceSessionId: null,
            category: "decision",
            title: "old decision",
            detail: "target",
            keywords: [],
            evidence: [],
            createdAt: "2026-04-02T09:00:00.000Z",
            updatedAt: "2026-04-01T10:00:00.000Z",
            lastUsedAt: null,
          }]
        : [{
            id: "project-entry-new",
            projectScopeId: scopeId,
            sourceSessionId: null,
            category: "decision",
            title: "new decision",
            detail: "target",
            keywords: [],
            evidence: [],
            createdAt: "2026-04-02T09:00:00.000Z",
            updatedAt: "2026-04-03T10:00:00.000Z",
            lastUsedAt: null,
          }],
      deleteProjectMemoryEntry: () => {},
      listCharacterScopes: () => [{
        id: "character-scope-1",
        characterId: "char-1",
        displayName: "Character",
        createdAt: "2026-04-02T09:00:00.000Z",
        updatedAt: "2026-04-02T09:00:00.000Z",
      }],
      listCharacterMemoryEntries: () => [
        {
          id: "character-entry-old",
          characterScopeId: "character-scope-1",
          sourceSessionId: null,
          category: "tone",
          title: "old tone",
          detail: "target",
          keywords: [],
          evidence: [],
          createdAt: "2026-04-02T09:00:00.000Z",
          updatedAt: "2026-04-01T10:00:00.000Z",
          lastUsedAt: null,
        },
        {
          id: "character-entry-new",
          characterScopeId: "character-scope-1",
          sourceSessionId: null,
          category: "tone",
          title: "new tone",
          detail: "target",
          keywords: [],
          evidence: [],
          createdAt: "2026-04-02T09:00:00.000Z",
          updatedAt: "2026-04-03T10:00:00.000Z",
          lastUsedAt: null,
        },
      ],
      deleteCharacterMemoryEntry: () => {},
    });

    const projectPage = service.getPage({ domain: "project", limit: 1, projectCategory: "decision", searchText: "target" });
    const characterPage = service.getPage({ domain: "character", limit: 1, characterCategory: "tone", searchText: "target" });

    assert.deepEqual(projectPage.snapshot.projectMemories.flatMap((group) => group.entries.map((entry) => entry.id)), [
      "project-entry-new",
    ]);
    assert.deepEqual(characterPage.snapshot.characterMemories.flatMap((group) => group.entries.map((entry) => entry.id)), [
      "character-entry-new",
    ]);
  });

  it("mate profile page を domain 指定で取得する", () => {
    const service = new MemoryManagementService({
      listSessionSummaries: () => [],
      listSessionMemories: () => [],
      deleteSessionMemory: () => {},
      listProjectScopes: () => [],
      listProjectMemoryEntries: () => [],
      deleteProjectMemoryEntry: () => {},
      listCharacterScopes: () => [],
      listCharacterMemoryEntries: () => [],
      deleteCharacterMemoryEntry: () => {},
      listMateProfileItems: () => [
        {
          id: "mate-profile-item-1",
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
          tags: ["tag:friend"],
          updatedAt: "2026-04-02T10:00:00.000Z",
        },
        {
          id: "mate-profile-item-2",
          sectionKey: "core",
          projectDigestId: null,
          category: "persona",
          claimKey: "nickname",
          claimValue: "A",
          renderedText: "A",
          normalizedClaim: "a",
          confidence: 70,
          salienceScore: 80,
          state: "active",
          tags: ["tag:short"],
          updatedAt: "2026-04-01T10:00:00.000Z",
        },
      ],
    });

    const page = service.getPage({ domain: "mate_profile", limit: 1 });

    assert.deepEqual(page.snapshot.mateProfileItems?.map((item) => item.id), ["mate-profile-item-1"]);
    assert.equal(page.pages.mate_profile?.hasMore, true);
    assert.equal(page.pages.mate_profile?.total, 2);
  });

  it("forgetMateProfileItem は deps の忘却を呼ぶ", () => {
    const deleted: string[] = [];
    const service = new MemoryManagementService({
      listSessionSummaries: () => [],
      listSessionMemories: () => [],
      deleteSessionMemory: () => {},
      listProjectScopes: () => [],
      listProjectMemoryEntries: () => [],
      deleteProjectMemoryEntry: () => {},
      listCharacterScopes: () => [],
      listCharacterMemoryEntries: () => [],
      deleteCharacterMemoryEntry: () => {},
      listMateProfileItems: () => [],
      forgetMateProfileItem: (itemId) => {
        deleted.push(itemId);
      },
    });

    service.forgetMateProfileItem("mate-profile-item-1");

    assert.deepEqual(deleted, ["mate-profile-item-1"]);
  });
});
