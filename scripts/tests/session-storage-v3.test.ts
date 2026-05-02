import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, it } from "node:test";

import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import { buildNewSession, type MessageArtifact, type Session } from "../../src/app-state.js";
import {
  CREATE_V3_SCHEMA_SQL,
  V3_TEXT_PREVIEW_MAX_LENGTH,
} from "../../src-electron/database-schema-v3.js";
import { SessionStorageV3 } from "../../src-electron/session-storage-v3.js";
import { TextBlobStore } from "../../src-electron/text-blob-store.js";

async function withTempV3Database<T>(fn: (input: { dbPath: string; blobRootPath: string }) => T | Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "withmate-session-v3-"));
  const dbPath = path.join(dir, "withmate-v3.db");
  const blobRootPath = path.join(dir, "blobs");
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA foreign_keys = ON;");
    for (const statement of CREATE_V3_SCHEMA_SQL) {
      db.exec(statement);
    }
  } finally {
    db.close();
  }

  try {
    return await fn({ dbPath, blobRootPath });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function createSession(input: { id: string; taskTitle: string; workspaceLabel: string }): Session {
  const session = buildNewSession({
    taskTitle: input.taskTitle,
    workspaceLabel: input.workspaceLabel,
    workspacePath: `/${input.workspaceLabel}`,
    branch: "main",
    characterId: "char-v3",
    character: "V3",
    characterIconPath: "",
    characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
    approvalMode: DEFAULT_APPROVAL_MODE,
  });

  return {
    ...session,
    id: input.id,
    threadId: `thread-${input.id}`,
  };
}

function createArtifact(sentinel: string): MessageArtifact {
  return {
    title: "V3 artifact",
    activitySummary: ["implemented"],
    operationTimeline: [
      {
        type: "edit",
        summary: "updated storage",
        details: `${sentinel}:operation-details`,
      },
    ],
    changedFiles: [
      {
        kind: "edit",
        path: "src-electron/session-storage-v3.ts",
        summary: "blob-backed messages",
        diffRows: [
          {
            kind: "add",
            rightNumber: 10,
            rightText: `${sentinel}:diff-row`,
          },
        ],
      },
    ],
    runChecks: [
      {
        label: "test",
        value: "pass",
      },
    ],
  };
}

function readRequiredRow<T>(db: DatabaseSync, sql: string, ...params: SQLInputValue[]): T {
  const row = db.prepare(sql).get(...params) as T | undefined;
  assert.ok(row);
  return row;
}

function readCount(db: DatabaseSync, sql: string, ...params: SQLInputValue[]): number {
  const row = readRequiredRow<{ count: number }>(db, sql, ...params);
  return Number(row.count);
}

function tableNames(db: DatabaseSync): string[] {
  return (db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>)
    .map((row) => row.name)
    .filter((name) => !name.startsWith("sqlite_"));
}

function textColumnNames(db: DatabaseSync, tableName: string): string[] {
  return (db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string; type: string }>)
    .filter((row) => row.type.toUpperCase().includes("TEXT"))
    .map((row) => row.name);
}

function readAllTextValues(db: DatabaseSync): string[] {
  const values: string[] = [];
  for (const tableName of tableNames(db)) {
    for (const columnName of textColumnNames(db, tableName)) {
      const rows = db.prepare(`SELECT ${columnName} AS value FROM ${tableName}`).all() as Array<{ value: string | null }>;
      for (const row of rows) {
        if (typeof row.value === "string") {
          values.push(row.value);
        }
      }
    }
  }
  return values;
}

function readSessionBlobIds(db: DatabaseSync, sessionId: string): string[] {
  const messageRows = db.prepare(`
    SELECT text_blob_id AS blob_id
    FROM session_messages
    WHERE session_id = ?
      AND text_blob_id IS NOT NULL
  `).all(sessionId) as Array<{ blob_id: string }>;
  const artifactRows = db.prepare(`
    SELECT a.artifact_blob_id AS blob_id
    FROM session_message_artifacts AS a
    INNER JOIN session_messages AS m
      ON m.id = a.message_id
    WHERE m.session_id = ?
      AND a.artifact_blob_id IS NOT NULL
  `).all(sessionId) as Array<{ blob_id: string }>;

  return [...new Set([...messageRows, ...artifactRows].map((row) => row.blob_id))];
}

describe("SessionStorageV3", () => {
  it("upsert -> list summaries -> get で message text と artifact を blob から復元する", async () => {
    await withTempV3Database(async ({ dbPath, blobRootPath }) => {
      const storage = new SessionStorageV3(dbPath, blobRootPath);
      const sentinel = "SENTINEL_SESSION_V3_ROUNDTRIP";
      const longText = `${"x".repeat(V3_TEXT_PREVIEW_MAX_LENGTH + 20)}${sentinel}:message-text`;
      const session = createSession({
        id: "session-v3-roundtrip",
        taskTitle: "V3 roundtrip",
        workspaceLabel: "workspace-v3",
      });

      try {
        const saved = await storage.upsertSession({
          ...session,
          messages: [
            {
              role: "user",
              text: longText,
              accent: true,
              artifact: createArtifact(sentinel),
            },
            {
              role: "assistant",
              text: "short assistant reply",
            },
          ],
        });

        assert.equal(saved.messages[0]?.text, longText);
        assert.equal((await storage.listSessions())[0]?.messages.length, 0);

        const summaries = await storage.listSessionSummaries();
        assert.equal(summaries.length, 1);
        assert.equal(summaries[0]?.id, "session-v3-roundtrip");
        assert.equal(summaries[0]?.taskTitle, "V3 roundtrip");

        const loaded = await storage.getSession("session-v3-roundtrip");
        assert.ok(loaded);
        assert.deepEqual(loaded.stream, []);
        assert.deepEqual(loaded.messages.map((message) => message.text), [longText, "short assistant reply"]);
        assert.equal(loaded.messages[0]?.accent, true);
        assert.equal(loaded.messages[0]?.artifact?.detailAvailable, true);
        assert.equal(loaded.messages[0]?.artifact?.changedFiles[0]?.diffRows.length, 0);
        assert.deepEqual(await storage.getSessionMessageArtifact("session-v3-roundtrip", 0), createArtifact(sentinel));
      } finally {
        storage.close();
      }
    });
  });

  it("raw message text / artifact detail は sqlite text columns に残さず blob からだけ復元する", async () => {
    await withTempV3Database(async ({ dbPath, blobRootPath }) => {
      const storage = new SessionStorageV3(dbPath, blobRootPath);
      const sentinel = "SENTINEL_RAW_SESSION_V3_ONLY_IN_BLOB";
      const rawText = `${"m".repeat(V3_TEXT_PREVIEW_MAX_LENGTH + 10)}${sentinel}:message`;
      const session = createSession({
        id: "session-v3-raw",
        taskTitle: "V3 raw isolation",
        workspaceLabel: "workspace-raw",
      });

      try {
        await storage.upsertSession({
          ...session,
          messages: [
            {
              role: "assistant",
              text: rawText,
              artifact: createArtifact(sentinel),
            },
          ],
        });

        const loaded = await storage.getSession(session.id);
        assert.ok(loaded);
        assert.equal(loaded.messages[0]?.text, rawText);
        assert.equal(loaded.messages[0]?.artifact?.changedFiles[0]?.diffRows.length, 0);
        assert.equal(
          (await storage.getSessionMessageArtifact(session.id, 0))?.changedFiles[0]?.diffRows[0]?.rightText,
          `${sentinel}:diff-row`,
        );
      } finally {
        storage.close();
      }

      const db = new DatabaseSync(dbPath);
      try {
        const textValues = readAllTextValues(db);
        assert.equal(
          textValues.some((value) => value.includes(sentinel)),
          false,
          "sentinel raw message/artifact payload must not be stored in sqlite text columns",
        );

        const messageRow = readRequiredRow<{
          text_preview: string;
          text_blob_id: string;
          text_original_bytes: number;
          text_stored_bytes: number;
        }>(
          db,
          `SELECT text_preview, text_blob_id, text_original_bytes, text_stored_bytes
           FROM session_messages
           WHERE session_id = ?`,
          session.id,
        );
        assert.equal(messageRow.text_preview.length, V3_TEXT_PREVIEW_MAX_LENGTH);
        assert.match(messageRow.text_blob_id, /^[a-f0-9]{64}$/);
        assert.equal(messageRow.text_original_bytes > 0, true);
        assert.equal(messageRow.text_stored_bytes > 0, true);

        const artifactRow = readRequiredRow<{
          artifact_summary_json: string;
          artifact_blob_id: string;
          artifact_original_bytes: number;
          artifact_stored_bytes: number;
        }>(
          db,
          `SELECT artifact_summary_json, artifact_blob_id, artifact_original_bytes, artifact_stored_bytes
           FROM session_message_artifacts`,
        );
        assert.deepEqual(JSON.parse(artifactRow.artifact_summary_json), {
          title: "V3 artifact",
          activitySummary: ["implemented"],
          operationTimeline: [{ type: "edit", summary: "updated storage" }],
          changedFiles: [
            {
              kind: "edit",
              path: "src-electron/session-storage-v3.ts",
              summary: "blob-backed messages",
              diffRows: [],
            },
          ],
          runChecks: [{ label: "test", value: "pass" }],
          detailAvailable: true,
        });
        assert.match(artifactRow.artifact_blob_id, /^[a-f0-9]{64}$/);
        assert.equal(artifactRow.artifact_original_bytes > 0, true);
        assert.equal(artifactRow.artifact_stored_bytes > 0, true);
        assert.equal(readCount(db, "SELECT COUNT(*) AS count FROM blob_objects"), 2);
      } finally {
        db.close();
      }
    });
  });

  it("deleteSession / clearSessions は未参照になった blob file と blob_objects row を消す", async () => {
    await withTempV3Database(async ({ dbPath, blobRootPath }) => {
      const storage = new SessionStorageV3(dbPath, blobRootPath);
      const blobStore = new TextBlobStore(blobRootPath);
      const targetSession = createSession({
        id: "session-v3-delete-target",
        taskTitle: "V3 delete target",
        workspaceLabel: "workspace-delete-target",
      });
      const keepSession = createSession({
        id: "session-v3-delete-keep",
        taskTitle: "V3 delete keep",
        workspaceLabel: "workspace-delete-keep",
      });
      const sharedText = "shared text uses the same content-addressed blob";

      try {
        await storage.upsertSession({
          ...targetSession,
          messages: [
            {
              role: "user",
              text: sharedText,
            },
            {
              role: "assistant",
              text: "target unique message",
              artifact: createArtifact("TARGET_DELETE_BLOB_SENTINEL"),
            },
          ],
        });
        await storage.upsertSession({
          ...keepSession,
          messages: [
            {
              role: "user",
              text: sharedText,
            },
          ],
        });

        const { targetBlobIds, keepBlobIds } = (() => {
          const db = new DatabaseSync(dbPath);
          try {
            return {
              targetBlobIds: readSessionBlobIds(db, targetSession.id),
              keepBlobIds: readSessionBlobIds(db, keepSession.id),
            };
          } finally {
            db.close();
          }
        })();
        const sharedBlobIds = targetBlobIds.filter((blobId) => keepBlobIds.includes(blobId));
        const targetOnlyBlobIds = targetBlobIds.filter((blobId) => !keepBlobIds.includes(blobId));
        assert.equal(sharedBlobIds.length, 1);
        assert.equal(targetOnlyBlobIds.length, 2);

        await storage.deleteSession(targetSession.id);

        for (const blobId of targetOnlyBlobIds) {
          assert.equal(await blobStore.stat(blobId), null);
        }
        for (const blobId of sharedBlobIds) {
          assert.ok(await blobStore.stat(blobId));
        }

        const dbAfterDelete = new DatabaseSync(dbPath);
        try {
          for (const blobId of targetOnlyBlobIds) {
            assert.equal(readCount(dbAfterDelete, "SELECT COUNT(*) AS count FROM blob_objects WHERE blob_id = ?", blobId), 0);
          }
          for (const blobId of sharedBlobIds) {
            assert.equal(readCount(dbAfterDelete, "SELECT COUNT(*) AS count FROM blob_objects WHERE blob_id = ?", blobId), 1);
          }
        } finally {
          dbAfterDelete.close();
        }

        await storage.clearSessions();

        for (const blobId of sharedBlobIds) {
          assert.equal(await blobStore.stat(blobId), null);
        }

        const dbAfterClear = new DatabaseSync(dbPath);
        try {
          assert.equal(readCount(dbAfterClear, "SELECT COUNT(*) AS count FROM sessions"), 0);
          assert.equal(readCount(dbAfterClear, "SELECT COUNT(*) AS count FROM session_messages"), 0);
          assert.equal(readCount(dbAfterClear, "SELECT COUNT(*) AS count FROM session_message_artifacts"), 0);
          assert.equal(readCount(dbAfterClear, "SELECT COUNT(*) AS count FROM blob_objects"), 0);
        } finally {
          dbAfterClear.close();
        }
      } finally {
        storage.close();
      }
    });
  });
});
