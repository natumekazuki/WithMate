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
});
