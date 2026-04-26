import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import type { CompanionGroup, CompanionSession } from "../../src/companion-state.js";
import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import { DEFAULT_CODEX_SANDBOX_MODE } from "../../src/codex-sandbox-mode.js";
import { DEFAULT_CATALOG_REVISION, DEFAULT_MODEL_ID, DEFAULT_REASONING_EFFORT } from "../../src/model-catalog.js";
import { CompanionStorage } from "../../src-electron/companion-storage.js";

async function removeDirectoryWithRetry(targetPath: string, attempts = 5): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    try {
      await rm(targetPath, { recursive: true, force: true });
      return;
    } catch (error) {
      const isBusyError = typeof error === "object" && error !== null && "code" in error && error.code === "EBUSY";
      if (!isBusyError || index === attempts - 1) {
        throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, 50 * (index + 1)));
    }
  }
}

function createGroup(): CompanionGroup {
  return {
    id: "group-1",
    repoRoot: "F:/work/demo",
    displayName: "demo",
    createdAt: "2026-04-26 10:00",
    updatedAt: "2026-04-26 10:00",
  };
}

function createSession(groupId: string, overrides: Partial<CompanionSession> = {}): CompanionSession {
  return {
    id: "session-1",
    groupId,
    taskTitle: "Companion task",
    status: "active",
    repoRoot: "F:/work/demo",
    focusPath: "src",
    targetBranch: "main",
    baseSnapshotRef: "refs/withmate/companion/session-1/base",
    baseSnapshotCommit: "abc123",
    companionBranch: "withmate/companion/session-1",
    worktreePath: "F:/app/companion-worktrees/group-1/session-1",
    selectedPaths: [],
    changedFiles: [],
    siblingWarnings: [],
    runState: "idle",
    threadId: "",
    provider: "codex",
    catalogRevision: DEFAULT_CATALOG_REVISION,
    model: DEFAULT_MODEL_ID,
    reasoningEffort: DEFAULT_REASONING_EFFORT,
    customAgentName: "",
    approvalMode: DEFAULT_APPROVAL_MODE,
    codexSandboxMode: DEFAULT_CODEX_SANDBOX_MODE,
    characterId: "char-1",
    character: "Mia",
    characterRoleMarkdown: "落ち着いて伴走する。",
    characterIconPath: "icon.png",
    characterThemeColors: {
      main: "#6f8cff",
      sub: "#6fb8c7",
    },
    createdAt: "2026-04-26 10:01",
    updatedAt: "2026-04-26 10:01",
    messages: [],
    ...overrides,
  };
}

describe("CompanionStorage", () => {
  it("group と active session を保存して summary と detail を読み戻せる", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-companion-storage-"));
    const dbPath = path.join(tempDirectory, "withmate.db");
    let storage: CompanionStorage | null = null;

    try {
      storage = new CompanionStorage(dbPath);
      const group = storage.ensureGroup(createGroup());
      const session = storage.createSession(createSession(group.id));

      assert.equal(session.groupId, group.id);
      assert.deepEqual(storage.listActiveSessionSummaries(), [
        {
          id: "session-1",
          groupId: group.id,
          taskTitle: "Companion task",
          status: "active",
          repoRoot: "F:/work/demo",
          focusPath: "src",
          targetBranch: "main",
          baseSnapshotRef: "refs/withmate/companion/session-1/base",
          baseSnapshotCommit: "abc123",
          selectedPaths: [],
          changedFiles: [],
          siblingWarnings: [],
          runState: "idle",
          threadId: "",
          provider: "codex",
          model: DEFAULT_MODEL_ID,
          reasoningEffort: DEFAULT_REASONING_EFFORT,
          approvalMode: DEFAULT_APPROVAL_MODE,
          codexSandboxMode: DEFAULT_CODEX_SANDBOX_MODE,
          character: "Mia",
          characterRoleMarkdown: "落ち着いて伴走する。",
          characterIconPath: "icon.png",
          characterThemeColors: {
            main: "#6f8cff",
            sub: "#6fb8c7",
          },
          updatedAt: "2026-04-26 10:01",
        },
      ]);
      assert.equal(storage.getSession("session-1")?.companionBranch, "withmate/companion/session-1");
    } finally {
      storage?.close();
      await removeDirectoryWithRetry(tempDirectory);
    }
  });

  it("merged / discarded session は全 summary に残し active summary からは除外する", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-companion-storage-"));
    const dbPath = path.join(tempDirectory, "withmate.db");
    let storage: CompanionStorage | null = null;

    try {
      storage = new CompanionStorage(dbPath);
      const group = storage.ensureGroup(createGroup());
      storage.createSession(createSession(group.id, {
        id: "session-merged",
        status: "merged",
        taskTitle: "Merged task",
        selectedPaths: ["README.md", "src/app.ts"],
        changedFiles: [
          { path: "README.md", kind: "edit" },
          { path: "src/app.ts", kind: "add" },
        ],
        siblingWarnings: [
          {
            sessionId: "session-sibling",
            taskTitle: "Sibling task",
            paths: ["README.md"],
            message: "Sibling task と 1 file が重なっているよ。",
          },
        ],
        updatedAt: "2026-04-26 10:03",
      }));
      storage.createSession(createSession(group.id, {
        id: "session-discarded",
        status: "discarded",
        taskTitle: "Discarded task",
        updatedAt: "2026-04-26 10:02",
      }));

      assert.deepEqual(storage.listActiveSessionSummaries(), []);
      assert.deepEqual(storage.listSessionSummaries().map((session) => [session.id, session.status]), [
        ["session-merged", "merged"],
        ["session-discarded", "discarded"],
      ]);
      assert.deepEqual(storage.getSession("session-merged")?.selectedPaths, ["README.md", "src/app.ts"]);
      assert.deepEqual(storage.listSessionSummaries()[0]?.selectedPaths, ["README.md", "src/app.ts"]);
      assert.deepEqual(storage.getSession("session-merged")?.changedFiles, [
        { path: "README.md", kind: "edit" },
        { path: "src/app.ts", kind: "add" },
      ]);
      assert.deepEqual(storage.listSessionSummaries()[0]?.changedFiles, [
        { path: "README.md", kind: "edit" },
        { path: "src/app.ts", kind: "add" },
      ]);
      assert.deepEqual(storage.getSession("session-merged")?.siblingWarnings, [
        {
          sessionId: "session-sibling",
          taskTitle: "Sibling task",
          paths: ["README.md"],
          message: "Sibling task と 1 file が重なっているよ。",
        },
      ]);
      assert.deepEqual(storage.listSessionSummaries()[0]?.siblingWarnings, [
        {
          sessionId: "session-sibling",
          taskTitle: "Sibling task",
          paths: ["README.md"],
          message: "Sibling task と 1 file が重なっているよ。",
        },
      ]);
    } finally {
      storage?.close();
      await removeDirectoryWithRetry(tempDirectory);
    }
  });
});
