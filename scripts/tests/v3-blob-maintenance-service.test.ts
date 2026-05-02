import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import { buildNewSession, type MessageArtifact, type Session } from "../../src/session-state.js";
import { CREATE_V3_SCHEMA_SQL } from "../../src-electron/database-schema-v3.js";
import { SessionStorageV3 } from "../../src-electron/session-storage-v3.js";
import { TextBlobStore } from "../../src-electron/text-blob-store.js";
import { repairV3Blobs } from "../../src-electron/v3-blob-maintenance-service.js";

async function withTempV3Database<T>(fn: (input: { dbPath: string; blobRootPath: string }) => T | Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "withmate-v3-blob-maintenance-"));
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

function createSession(id: string): Session {
  const session = buildNewSession({
    taskTitle: "blob maintenance",
    workspaceLabel: "workspace",
    workspacePath: "/workspace",
    branch: "main",
    characterId: "char-v3",
    character: "V3",
    characterIconPath: "",
    characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
    approvalMode: DEFAULT_APPROVAL_MODE,
  });

  return {
    ...session,
    id,
    threadId: `thread-${id}`,
    messages: [
      {
        role: "user",
        text: "hello",
      },
      {
        role: "assistant",
        text: "done",
        artifact: createArtifact(),
      },
    ],
  };
}

function createArtifact(): MessageArtifact {
  return {
    title: "artifact",
    activitySummary: ["updated"],
    changedFiles: [],
    runChecks: [],
  };
}

function readBlobObjectIds(dbPath: string): string[] {
  const db = new DatabaseSync(dbPath);
  try {
    return (db.prepare("SELECT blob_id FROM blob_objects ORDER BY blob_id").all() as Array<{ blob_id: string }>)
      .map((row) => row.blob_id);
  } finally {
    db.close();
  }
}

describe("repairV3Blobs", () => {
  it("DB 参照を live set として orphan file と orphan blob_objects row を cleanup する", async () => {
    await withTempV3Database(async ({ dbPath, blobRootPath }) => {
      const sessionStorage = new SessionStorageV3(dbPath, blobRootPath);
      const blobStore = new TextBlobStore(blobRootPath);
      try {
        await sessionStorage.upsertSession(createSession("session-live"));
        const orphanRef = await blobStore.putText({ contentType: "text/plain", text: "orphan" });
        const db = new DatabaseSync(dbPath);
        try {
          db.prepare(`
            INSERT INTO blob_objects (
              blob_id,
              codec,
              content_type,
              original_bytes,
              stored_bytes,
              raw_sha256,
              stored_sha256,
              state,
              created_at,
              last_verified_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', ?, '')
          `).run(
            orphanRef.blobId,
            orphanRef.codec,
            orphanRef.contentType,
            orphanRef.originalBytes,
            orphanRef.storedBytes,
            orphanRef.rawSha256,
            orphanRef.storedSha256,
            "2026-05-03T00:00:00.000Z",
          );
        } finally {
          db.close();
        }

        const dryRun = await repairV3Blobs({ dbPath, blobRootPath, dryRun: true });
        assert.equal(dryRun.dryRun, true);
        assert.deepEqual(dryRun.orphanBlobObjectIds, [orphanRef.blobId]);
        assert.deepEqual(dryRun.garbage.orphanBlobIds, [orphanRef.blobId]);
        assert.equal(await blobStore.getText(orphanRef.blobId), "orphan");
        assert.ok(readBlobObjectIds(dbPath).includes(orphanRef.blobId));

        const cleanup = await repairV3Blobs({ dbPath, blobRootPath, dryRun: false });
        assert.equal(cleanup.dryRun, false);
        assert.deepEqual(cleanup.orphanBlobObjectIds, [orphanRef.blobId]);
        assert.deepEqual(cleanup.garbage.deletedBlobIds, [orphanRef.blobId]);
        assert.equal(await blobStore.stat(orphanRef.blobId), null);
        assert.equal(readBlobObjectIds(dbPath).includes(orphanRef.blobId), false);
      } finally {
        sessionStorage.close();
      }
    });
  });

  it("参照中 blob の file 欠損を report し、cleanup では削除対象にしない", async () => {
    await withTempV3Database(async ({ dbPath, blobRootPath }) => {
      const db = new DatabaseSync(dbPath);
      const missingBlobId = "a".repeat(64);
      try {
        db.prepare(`
          INSERT INTO blob_objects (
            blob_id,
            codec,
            content_type,
            original_bytes,
            stored_bytes,
            raw_sha256,
            stored_sha256,
            state,
            created_at,
            last_verified_at
          ) VALUES (?, 'br', 'text/plain', 1, 1, ?, ?, 'ready', ?, '')
        `).run(missingBlobId, "b".repeat(64), "c".repeat(64), "2026-05-03T00:00:00.000Z");
        db.prepare(`
          INSERT INTO sessions (
            id,
            task_title,
            task_summary,
            status,
            updated_at,
            provider,
            catalog_revision,
            workspace_label,
            workspace_path,
            branch,
            session_kind,
            character_id,
            character_name,
            character_icon_path,
            character_theme_main,
            character_theme_sub,
            run_state,
            approval_mode,
            codex_sandbox_mode,
            model,
            reasoning_effort,
            custom_agent_name,
            allowed_additional_directories_json,
            thread_id,
            message_count,
            audit_log_count,
            last_active_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          "session-missing",
          "missing",
          "missing",
          "idle",
          "2026-05-03T00:00:00.000Z",
          "codex",
          1,
          "workspace",
          "/workspace",
          "main",
          "default",
          "char",
          "Char",
          "",
          "#6f8cff",
          "#6fb8c7",
          "idle",
          DEFAULT_APPROVAL_MODE,
          "workspace-write",
          "gpt-5.4-mini",
          "medium",
          "",
          "[]",
          "thread",
          1,
          0,
          1,
        );
        db.prepare(`
          INSERT INTO session_messages (
            session_id,
            seq,
            role,
            text_preview,
            text_blob_id,
            text_original_bytes,
            text_stored_bytes,
            accent,
            artifact_available,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run("session-missing", 0, "user", "", missingBlobId, 1, 1, 0, 0, "2026-05-03T00:00:00.000Z");
      } finally {
        db.close();
      }
      const missingDirectory = path.join(blobRootPath, "aa", "aa");
      await mkdir(missingDirectory, { recursive: true });
      await writeFile(path.join(missingDirectory, `${missingBlobId}.json`), Buffer.from("{}"));

      const report = await repairV3Blobs({ dbPath, blobRootPath, dryRun: false });
      assert.deepEqual(report.missingReferencedBlobIds, [missingBlobId]);
      assert.deepEqual(report.orphanBlobObjectIds, []);
      assert.deepEqual(report.garbage.deletedBlobIds, []);
      assert.ok(readBlobObjectIds(dbPath).includes(missingBlobId));
    });
  });
});
