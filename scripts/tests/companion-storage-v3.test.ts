import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import type { CompanionGroup, CompanionMergeRun, CompanionSession } from "../../src/companion-state.js";
import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import { DEFAULT_CODEX_SANDBOX_MODE } from "../../src/codex-sandbox-mode.js";
import { DEFAULT_CATALOG_REVISION, DEFAULT_MODEL_ID, DEFAULT_REASONING_EFFORT } from "../../src/model-catalog.js";
import { CompanionStorageV3 } from "../../src-electron/companion-storage-v3.js";
import { CREATE_V3_SCHEMA_SQL } from "../../src-electron/database-schema-v3.js";
import { openAppDatabase } from "../../src-electron/sqlite-connection.js";
import { TextBlobStore } from "../../src-electron/text-blob-store.js";

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

function createV3Database(dbPath: string): void {
  const db = openAppDatabase(dbPath);
  try {
    for (const statement of CREATE_V3_SCHEMA_SQL) {
      db.exec(statement);
    }
  } finally {
    db.close();
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
    allowedAdditionalDirectories: [],
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

function createMergeRun(groupId: string, overrides: Partial<CompanionMergeRun> = {}): CompanionMergeRun {
  return {
    id: "merge-run-1",
    sessionId: "session-1",
    groupId,
    operation: "merge",
    selectedPaths: ["README.md"],
    changedFiles: [{ path: "README.md", kind: "edit" }],
    diffSnapshot: [
      {
        kind: "edit",
        path: "README.md",
        summary: "README.md を更新",
        diffRows: [{ kind: "add", rightNumber: 1, rightText: "merged" }],
      },
    ],
    siblingWarnings: [],
    createdAt: "2026-04-26 10:04",
    ...overrides,
  };
}

function readAllCompanionDbText(dbPath: string): string {
  const db = openAppDatabase(dbPath);
  try {
    const rows = db.prepare(`
      SELECT group_concat(value, char(10)) AS text
      FROM (
        SELECT character_role_preview AS value FROM companion_sessions
        UNION ALL SELECT selected_paths_json FROM companion_sessions
        UNION ALL SELECT changed_files_summary_json FROM companion_sessions
        UNION ALL SELECT sibling_warnings_summary_json FROM companion_sessions
        UNION ALL SELECT text_preview FROM companion_messages
        UNION ALL SELECT artifact_summary_json FROM companion_message_artifacts
        UNION ALL SELECT changed_files_summary_json FROM companion_merge_runs
        UNION ALL SELECT sibling_warnings_summary_json FROM companion_merge_runs
      )
    `).get() as { text: string | null } | undefined;
    return rows?.text ?? "";
  } finally {
    db.close();
  }
}

function countBlobObjects(dbPath: string): number {
  const db = openAppDatabase(dbPath);
  try {
    const row = db.prepare("SELECT COUNT(*) AS count FROM blob_objects").get() as { count: number };
    return row.count;
  } finally {
    db.close();
  }
}

describe("CompanionStorageV3", () => {
  it("session と merge run を blob-backed payload で roundtrip する", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-companion-storage-v3-"));
    const dbPath = path.join(tempDirectory, "withmate-v3.db");
    const blobPath = path.join(tempDirectory, "blobs");
    let storage: CompanionStorageV3 | null = null;

    try {
      createV3Database(dbPath);
      storage = new CompanionStorageV3(dbPath, blobPath);
      const group = await storage.ensureGroup(createGroup());
      const session = await storage.createSession(createSession(group.id, {
        messages: [
          { role: "user", text: "Companion user text" },
          {
            role: "assistant",
            text: "Companion assistant text",
            artifact: {
              title: "artifact",
              activitySummary: ["done"],
              changedFiles: [
                {
                  kind: "edit",
                  path: "README.md",
                  summary: "README.md",
                  diffRows: [{ kind: "add", rightNumber: 1, rightText: "hello" }],
                },
              ],
              runChecks: [{ label: "test", value: "pass" }],
            },
          },
        ],
      }));
      const mergeRun = await storage.createMergeRun(createMergeRun(group.id));

      assert.equal(session.groupId, group.id);
      assert.equal((await storage.getSession(session.id))?.messages[1]?.artifact?.changedFiles[0]?.diffRows.length, 0);
      assert.equal((await storage.getMessageArtifact(session.id, 1))?.changedFiles[0]?.diffRows[0]?.rightText, "hello");
      assert.deepEqual(await storage.listMergeRunsForSession(session.id), [mergeRun]);
      assert.deepEqual(await storage.listMergeRunSummariesForSession(session.id), [{
        id: mergeRun.id,
        sessionId: mergeRun.sessionId,
        groupId: mergeRun.groupId,
        operation: mergeRun.operation,
        selectedPaths: mergeRun.selectedPaths,
        changedFiles: mergeRun.changedFiles,
        siblingWarnings: mergeRun.siblingWarnings,
        diffSnapshotAvailable: true,
        createdAt: mergeRun.createdAt,
      }]);
      assert.equal((await storage.listSessionSummaries())[0]?.latestMergeRun?.id, mergeRun.id);
      assert.equal("diffSnapshot" in ((await storage.listSessionSummaries())[0]?.latestMergeRun ?? {}), false);
      assert.equal((await storage.listActiveSessionSummaries())[0]?.characterRoleMarkdown, "落ち着いて伴走する。");
    } finally {
      storage?.close();
      await removeDirectoryWithRetry(tempDirectory);
    }
  });

  it("raw message / artifact / diff / character role の tail を sqlite text column に残さない", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-companion-storage-v3-"));
    const dbPath = path.join(tempDirectory, "withmate-v3.db");
    const blobPath = path.join(tempDirectory, "blobs");
    let storage: CompanionStorageV3 | null = null;

    const characterRole = `${"role ".repeat(160)}CHARACTER_ROLE_TAIL_RAW`;
    const messageText = `${"message ".repeat(160)}MESSAGE_TAIL_RAW`;
    const artifactText = `${"artifact ".repeat(160)}ARTIFACT_TAIL_RAW`;
    const diffText = `${"diff ".repeat(160)}DIFF_TAIL_RAW`;

    try {
      createV3Database(dbPath);
      storage = new CompanionStorageV3(dbPath, blobPath);
      const group = await storage.ensureGroup(createGroup());
      const session = await storage.createSession(createSession(group.id, {
        characterRoleMarkdown: characterRole,
        messages: [
          {
            role: "assistant",
            text: messageText,
            artifact: {
              title: "artifact",
              activitySummary: [artifactText],
              changedFiles: [],
              runChecks: [],
            },
          },
        ],
      }));
      await storage.createMergeRun(createMergeRun(group.id, {
        diffSnapshot: [
          {
            kind: "edit",
            path: "README.md",
            summary: "README.md",
            diffRows: [{ kind: "add", rightNumber: 1, rightText: diffText }],
          },
        ],
      }));

      const dbText = readAllCompanionDbText(dbPath);
      assert.equal(dbText.includes("CHARACTER_ROLE_TAIL_RAW"), false);
      assert.equal(dbText.includes("MESSAGE_TAIL_RAW"), false);
      assert.equal(dbText.includes("ARTIFACT_TAIL_RAW"), false);
      assert.equal(dbText.includes("DIFF_TAIL_RAW"), false);

      assert.equal((await storage.getSession(session.id))?.characterRoleMarkdown.endsWith("CHARACTER_ROLE_TAIL_RAW"), true);
      assert.equal((await storage.getSession(session.id))?.messages[0]?.text.endsWith("MESSAGE_TAIL_RAW"), true);
      assert.equal((await storage.getMessageArtifact(session.id, 0))?.activitySummary[0]?.endsWith("ARTIFACT_TAIL_RAW"), true);
      assert.equal("diffSnapshot" in ((await storage.listMergeRunSummariesForSession(session.id))[0] ?? {}), false);
      assert.equal((await storage.listMergeRunsForSession(session.id))[0]?.diffSnapshot[0]?.diffRows[0]?.rightText?.endsWith("DIFF_TAIL_RAW"), true);
    } finally {
      storage?.close();
      await removeDirectoryWithRetry(tempDirectory);
    }
  });

  it("update / delete で未参照になった companion blob を cleanup する", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-companion-storage-v3-"));
    const dbPath = path.join(tempDirectory, "withmate-v3.db");
    const blobPath = path.join(tempDirectory, "blobs");
    let storage: CompanionStorageV3 | null = null;

    try {
      createV3Database(dbPath);
      storage = new CompanionStorageV3(dbPath, blobPath);
      const group = await storage.ensureGroup(createGroup());
      const session = await storage.createSession(createSession(group.id, {
        messages: [{ role: "user", text: "before message" }],
      }));
      const initialBlobCount = countBlobObjects(dbPath);
      assert.ok(initialBlobCount > 0);

      await storage.updateSession({
        ...session,
        characterRoleMarkdown: "after role",
        messages: [{ role: "user", text: "after message" }],
        updatedAt: "2026-04-26 10:02",
      });
      const updatedBlobCount = countBlobObjects(dbPath);
      assert.ok(updatedBlobCount > 0);
      assert.ok(updatedBlobCount <= initialBlobCount + 2);

      await storage.deleteSession(session.id);
      assert.equal(await storage.getSession(session.id), null);
      assert.equal(countBlobObjects(dbPath), 0);
    } finally {
      storage?.close();
      await removeDirectoryWithRetry(tempDirectory);
    }
  });

  it("DB transaction が失敗した場合は永続化されなかった companion blob file を cleanup する", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-companion-storage-v3-"));
    const dbPath = path.join(tempDirectory, "withmate-v3.db");
    const blobPath = path.join(tempDirectory, "blobs");
    let storage: CompanionStorageV3 | null = null;

    try {
      createV3Database(dbPath);
      storage = new CompanionStorageV3(dbPath, blobPath);

      await assert.rejects(() => storage!.createSession(createSession("missing-group", {
        messages: [{ role: "assistant", text: "message before FK failure" }],
      })));

      const report = await new TextBlobStore(blobPath).collectGarbage({ referencedBlobIds: [], dryRun: true });
      assert.deepEqual(report.orphanBlobIds, []);
      assert.equal(countBlobObjects(dbPath), 0);
    } finally {
      storage?.close();
      await removeDirectoryWithRetry(tempDirectory);
    }
  });
});
