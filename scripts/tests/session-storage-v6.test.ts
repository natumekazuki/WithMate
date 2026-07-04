import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import { buildNewSession, type MessageArtifact } from "../../src/session-state.js";
import { SessionStorageV6 } from "../../src-electron/session-storage-v6.js";

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

function createArtifact(): MessageArtifact {
  return {
    title: "Run result",
    activitySummary: ["edited file"],
    operationTimeline: [
      {
        type: "tool",
        summary: "apply patch",
        details: "large operation details",
      },
    ],
    changedFiles: [
      {
        kind: "edit",
        path: "src/example.ts",
        summary: "updated example",
        diffRows: [
          {
            kind: "add",
            rightNumber: 1,
            rightText: "const value = true;",
          },
        ],
      },
    ],
    runChecks: [{ label: "npm test", value: "pass" }],
  };
}

function insertAuxiliarySessionRows(dbPath: string, rows: Array<{ id: string; parentSessionId: string }>): void {
  const db = new DatabaseSync(dbPath);
  try {
    const statement = db.prepare(`
      INSERT INTO auxiliary_sessions (
        id,
        parent_session_id,
        status,
        created_at,
        updated_at,
        payload_json
      ) VALUES (?, ?, 'active', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', '{}')
    `);
    for (const row of rows) {
      statement.run(row.id, row.parentSessionId);
    }
  } finally {
    db.close();
  }
}

function insertCompanionSessionRows(dbPath: string, rows: Array<{ id: string; status: string }>): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS companion_sessions (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL
      )
    `);
    const statement = db.prepare("INSERT INTO companion_sessions (id, status) VALUES (?, ?)");
    for (const row of rows) {
      statement.run(row.id, row.status);
    }
  } finally {
    db.close();
  }
}

function listAuxiliarySessionParentIds(dbPath: string): string[] {
  const db = new DatabaseSync(dbPath);
  try {
    const rows = db.prepare(`
      SELECT parent_session_id AS parentSessionId
      FROM auxiliary_sessions
      ORDER BY parent_session_id ASC
    `).all() as Array<{ parentSessionId: string }>;
    return rows.map((row) => row.parentSessionId);
  } finally {
    db.close();
  }
}

describe("SessionStorageV6", () => {
  it("既存の artifact_body なし schema は constructor で補完する", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-session-storage-v6-"));
    const dbPath = path.join(tempDirectory, "withmate-v6.db");
    let storage: SessionStorageV6 | null = null;

    try {
      const db = new DatabaseSync(dbPath);
      db.exec(`
        CREATE TABLE session_messages_v6 (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool', 'system')),
          body TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE (session_id, seq),
          UNIQUE (id, session_id)
        );
      `);
      db.close();

      storage = new SessionStorageV6(dbPath);
      storage.close();
      storage = null;

      const reopenedDb = new DatabaseSync(dbPath);
      const columns = (reopenedDb.prepare("PRAGMA table_info(session_messages_v6)").all() as Array<{ name: string }>)
        .map((column) => column.name);
      reopenedDb.close();
      assert.equal(columns.includes("artifact_body"), true);
    } finally {
      storage?.close();
      await removeDirectoryWithRetry(tempDirectory);
    }
  });

  it("getSession は artifact summary を返し、detail は getSessionMessageArtifact で遅延取得する", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-session-storage-v6-"));
    const dbPath = path.join(tempDirectory, "withmate-v6.db");
    let storage: SessionStorageV6 | null = null;

    try {
      storage = new SessionStorageV6(dbPath);
      const artifact = createArtifact();
      const session = storage.upsertSession({
        ...buildNewSession({
          taskTitle: "artifact detail",
          workspaceLabel: "workspace",
          workspacePath: "C:/workspace",
          branch: "main",
          characterId: "char-a",
          character: "A",
          characterIconPath: "",
          characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
          approvalMode: DEFAULT_APPROVAL_MODE,
        }),
        messages: [
          {
            role: "assistant",
            text: "done",
            artifact,
          },
        ],
      });

      const loaded = storage.getSession(session.id);
      const loadedArtifact = loaded?.messages[0]?.artifact;
      assert.ok(loadedArtifact);
      assert.equal(loadedArtifact.detailAvailable, true);
      assert.equal(loadedArtifact.operationTimeline?.[0]?.details, undefined);
      assert.deepEqual(loadedArtifact.changedFiles[0]?.diffRows, []);
      assert.deepEqual(loadedArtifact.runChecks, artifact.runChecks);

      const fullArtifact = storage.getSessionMessageArtifact(session.id, 0);
      assert.equal(fullArtifact?.operationTimeline?.[0]?.details, "large operation details");
      assert.equal(fullArtifact?.changedFiles[0]?.diffRows[0]?.rightText, "const value = true;");
      assert.deepEqual(fullArtifact?.runChecks, artifact.runChecks);
    } finally {
      storage?.close();
      await removeDirectoryWithRetry(tempDirectory);
    }
  });

  it("last_active_at が cutoff より前の session id を列挙し、複数削除できる", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-session-storage-v6-"));
    const dbPath = path.join(tempDirectory, "withmate-v6.db");
    let storage: SessionStorageV6 | null = null;

    try {
      storage = new SessionStorageV6(dbPath);
      const baseInput = {
        workspaceLabel: "workspace",
        workspacePath: "C:/workspace",
        branch: "main",
        characterId: "char-a",
        character: "A",
        characterIconPath: "",
        characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
        approvalMode: DEFAULT_APPROVAL_MODE,
      };
      const oldSession = storage.upsertSession({
        ...buildNewSession({ ...baseInput, taskTitle: "old" }),
        id: "old",
        updatedAt: "2026-06-01T00:00:00.000Z",
      });
      const cutoffSession = storage.upsertSession({
        ...buildNewSession({ ...baseInput, taskTitle: "cutoff" }),
        id: "cutoff",
        updatedAt: "2026-07-01T00:00:00.000Z",
      });
      const recentSession = storage.upsertSession({
        ...buildNewSession({ ...baseInput, taskTitle: "recent" }),
        id: "recent",
        updatedAt: "2026-07-02T00:00:00.000Z",
      });

      assert.deepEqual(
        storage.listSessionIdsLastActiveBefore({
          cutoffDate: "2026-07-01",
          cutoffTimestampMs: Date.parse("2026-07-01T00:00:00.000Z"),
          cutoffIso: "2026-07-01T00:00:00.000Z",
        }),
        [oldSession.id],
      );

      storage.deleteSessions([oldSession.id, recentSession.id]);

      assert.deepEqual(storage.listSessions().map((session) => session.id), [cutoffSession.id]);
    } finally {
      storage?.close();
      await removeDirectoryWithRetry(tempDirectory);
    }
  });

  it("親 Session の削除経路で auxiliary_sessions を cleanup する", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-session-storage-v6-"));
    const dbPath = path.join(tempDirectory, "withmate-v6.db");
    let storage: SessionStorageV6 | null = null;

    try {
      storage = new SessionStorageV6(dbPath);
      const baseInput = {
        workspaceLabel: "workspace",
        workspacePath: "C:/workspace",
        branch: "main",
        characterId: "char-a",
        character: "A",
        characterIconPath: "",
        characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
        approvalMode: DEFAULT_APPROVAL_MODE,
      };
      const deletedParent = storage.upsertSession({
        ...buildNewSession({ ...baseInput, taskTitle: "deleted parent" }),
        id: "deleted-parent",
      });
      const retainedParent = storage.upsertSession({
        ...buildNewSession({ ...baseInput, taskTitle: "retained parent" }),
        id: "retained-parent",
      });
      const replacedParent = storage.upsertSession({
        ...buildNewSession({ ...baseInput, taskTitle: "replaced parent" }),
        id: "replaced-parent",
      });

      insertAuxiliarySessionRows(dbPath, [
        { id: "aux-deleted", parentSessionId: deletedParent.id },
        { id: "aux-retained", parentSessionId: retainedParent.id },
        { id: "aux-replaced", parentSessionId: replacedParent.id },
      ]);

      storage.deleteSession(deletedParent.id);
      assert.deepEqual(listAuxiliarySessionParentIds(dbPath), [replacedParent.id, retainedParent.id]);

      insertCompanionSessionRows(dbPath, [
        { id: "companion-active-parent", status: "active" },
        { id: "companion-recovery-parent", status: "recovery-required" },
        { id: "companion-merged-parent", status: "merged" },
        { id: "companion-discarded-parent", status: "discarded" },
      ]);
      insertAuxiliarySessionRows(dbPath, [
        { id: "aux-companion-active", parentSessionId: "companion-active-parent" },
        { id: "aux-companion-recovery", parentSessionId: "companion-recovery-parent" },
        { id: "aux-companion-merged", parentSessionId: "companion-merged-parent" },
        { id: "aux-companion-discarded", parentSessionId: "companion-discarded-parent" },
      ]);

      storage.replaceSessions([{ ...retainedParent, taskTitle: "retained after replace" }]);
      assert.deepEqual(listAuxiliarySessionParentIds(dbPath), [
        "companion-active-parent",
        "companion-recovery-parent",
        retainedParent.id,
      ]);

      storage.clearSessions();
      assert.deepEqual(listAuxiliarySessionParentIds(dbPath), []);
    } finally {
      storage?.close();
      await removeDirectoryWithRetry(tempDirectory);
    }
  });

  it("artifact_body がない既存 row でも getSessionMessageArtifact は body から復元する", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-session-storage-v6-"));
    const dbPath = path.join(tempDirectory, "withmate-v6.db");
    let storage: SessionStorageV6 | null = null;
    let reopened: SessionStorageV6 | null = null;

    try {
      const artifact = createArtifact();
      storage = new SessionStorageV6(dbPath);
      const session = storage.upsertSession({
        ...buildNewSession({
          taskTitle: "legacy artifact detail",
          workspaceLabel: "workspace",
          workspacePath: "C:/workspace",
          branch: "main",
          characterId: "char-a",
          character: "A",
          characterIconPath: "",
          characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
          approvalMode: DEFAULT_APPROVAL_MODE,
        }),
        messages: [{ role: "assistant", text: "done", artifact }],
      });
      storage.close();
      storage = null;

      const db = new DatabaseSync(dbPath);
      db.prepare("UPDATE session_messages_v6 SET body = ?, artifact_body = NULL WHERE session_id = ? AND seq = 0")
        .run(JSON.stringify({ role: "assistant", text: "done", artifact }), session.id);
      db.close();

      reopened = new SessionStorageV6(dbPath);
      const loadedArtifact = reopened.getSessionMessageArtifact(session.id, 0);
      assert.equal(loadedArtifact?.operationTimeline?.[0]?.details, "large operation details");
      assert.equal(loadedArtifact?.changedFiles[0]?.diffRows[0]?.rightText, "const value = true;");
    } finally {
      storage?.close();
      reopened?.close();
      await removeDirectoryWithRetry(tempDirectory);
    }
  });

  it("summary artifact を再保存しても既存 artifact_body の detail を保持する", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-session-storage-v6-"));
    const dbPath = path.join(tempDirectory, "withmate-v6.db");
    let storage: SessionStorageV6 | null = null;

    try {
      storage = new SessionStorageV6(dbPath);
      const artifact = createArtifact();
      const session = storage.upsertSession({
        ...buildNewSession({
          taskTitle: "preserve artifact detail",
          workspaceLabel: "workspace",
          workspacePath: "C:/workspace",
          branch: "main",
          characterId: "char-a",
          character: "A",
          characterIconPath: "",
          characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
          approvalMode: DEFAULT_APPROVAL_MODE,
        }),
        messages: [{ role: "assistant", text: "done", artifact }],
      });

      const loaded = storage.getSession(session.id);
      assert.ok(loaded);
      assert.equal(loaded.messages[0]?.artifact?.detailAvailable, true);

      storage.upsertSession({
        ...loaded,
        taskTitle: "metadata only update",
        updatedAt: "2026-07-02T15:30:00.000Z",
      });

      const preservedArtifact = storage.getSessionMessageArtifact(session.id, 0);
      assert.equal(preservedArtifact?.operationTimeline?.[0]?.details, "large operation details");
      assert.equal(preservedArtifact?.changedFiles[0]?.diffRows[0]?.rightText, "const value = true;");
      assert.deepEqual(preservedArtifact?.runChecks, artifact.runChecks);
    } finally {
      storage?.close();
      await removeDirectoryWithRetry(tempDirectory);
    }
  });

  it("summary が同じ full artifact 更新は既存 artifact_body で上書きしない", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-session-storage-v6-"));
    const dbPath = path.join(tempDirectory, "withmate-v6.db");
    let storage: SessionStorageV6 | null = null;

    try {
      storage = new SessionStorageV6(dbPath);
      const artifact = createArtifact();
      const session = storage.upsertSession({
        ...buildNewSession({
          taskTitle: "replace artifact detail",
          workspaceLabel: "workspace",
          workspacePath: "C:/workspace",
          branch: "main",
          characterId: "char-a",
          character: "A",
          characterIconPath: "",
          characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
          approvalMode: DEFAULT_APPROVAL_MODE,
        }),
        messages: [{ role: "assistant", text: "done", artifact }],
      });
      const updatedArtifact: MessageArtifact = {
        ...artifact,
        detailAvailable: true,
        operationTimeline: artifact.operationTimeline?.map((operation) => ({
          ...operation,
          details: "updated operation details",
        })),
        changedFiles: artifact.changedFiles.map((file) => ({
          ...file,
          diffRows: file.diffRows.map((row) => ({
            ...row,
            rightText: "const value = false;",
          })),
        })),
      };

      storage.upsertSession({
        ...session,
        updatedAt: "2026-07-02T15:31:00.000Z",
        messages: [{ role: "assistant", text: "done", artifact: updatedArtifact }],
      });

      const replacedArtifact = storage.getSessionMessageArtifact(session.id, 0);
      assert.equal(replacedArtifact?.operationTimeline?.[0]?.details, "updated operation details");
      assert.equal(replacedArtifact?.changedFiles[0]?.diffRows[0]?.rightText, "const value = false;");
    } finally {
      storage?.close();
      await removeDirectoryWithRetry(tempDirectory);
    }
  });
});
