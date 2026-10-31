import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { DEFAULT_APPROVAL_MODE } from "../../src-shared/settings/approval-mode.js";
import { buildNewSession, type MessageArtifact, type Session } from "../../src-shared/session/session-state.js";
import { CREATE_V3_SCHEMA_SQL } from "../../src-electron/storage/database-schema-v3.js";
import { SessionStorageV3 } from "../../src-electron/session/session-storage-v3.js";
import { TextBlobStore } from "../../src-electron/storage/text-blob-store.js";
import { repairV3Blobs } from "../../src-electron/storage/v3-blob-maintenance-service.js";

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
  // @test-value v2
  // kind = "invariant"
  // claim = "Audit tableがないV3 DBでも通常message・artifact参照を保持し、未参照blobだけをdry-runで報告してwriteで削除する"
  // oracle = { type = "contract", ref = "docs/design/database-schema.md#起動時の移行とデータ保護" }
  // fault = "存在しないAudit tableを必須としてGCを拒否するか、通常会話のblobを未参照扱いして削除する"
  // observable = "dry-runとwriteのorphan/deleted ID、通常会話の復元結果、orphan fileとblob_objects行の存否"
  // observation_boundary = "public-boundary"
  // scope = "V3 blob maintenance without Audit tables"
  // lifecycle = "permanent"
  // impact = "現行legacy移行先の会話とartifactを失うかblob maintenanceが停止する"
  // distinction = "SQLite schema・file store・GCの実経路を検証し、型検査で検出できない削除対象の誤分類を検出する"
  // @end-test-value
  it("DB 参照を live set として orphan file と orphan blob_objects row を cleanup する", async () => {
    await withTempV3Database(async ({ dbPath, blobRootPath }) => {
      const sessionStorage = new SessionStorageV3(dbPath, blobRootPath);
      const blobStore = new TextBlobStore(blobRootPath);
      try {
        await sessionStorage.upsertSession(createSession("session-live"));
        const storedMessages = (await sessionStorage.getSession("session-live"))?.messages;
        assert.ok(storedMessages);
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
        assert.deepEqual((await sessionStorage.getSession("session-live"))?.messages, storedMessages);
      } finally {
        sessionStorage.close();
      }
    });
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "保存済み旧V3 Audit tableの全6種blob参照とfile欠損message参照をGC live setとして保護する"
  // oracle = { type = "contract", ref = "docs/design/database-schema.md#起動時の移行とデータ保護" }
  // fault = "旧Audit tableのblob参照を見落として保存済みfileを削除するか、file欠損message参照のblob_objects行を削除する"
  // observable = "referenced/missing/orphan/deleted ID集合、Audit blob本文、欠損messageのblob_objects行"
  // observation_boundary = "public-boundary"
  // scope = "V3 blob maintenance with released Audit tables"
  // lifecycle = "permanent"
  // impact = "cleanup対象外の旧DBに保持されたblob本文を誤って破棄する"
  // distinction = "file欠損と各Audit列の別blobを同時に用い、同じblobの重複参照では隠れる列の読み落としを検出する"
  // risk_tags = ["irreversible-data-loss"]
  // @end-test-value
  it("旧Audit blob参照と参照中 blob の file 欠損を保護する", async () => {
    await withTempV3Database(async ({ dbPath, blobRootPath }) => {
      const db = new DatabaseSync(dbPath);
      const missingBlobId = "a".repeat(64);
      const blobStore = new TextBlobStore(blobRootPath);
      const auditRefs = await Promise.all(Array.from({ length: 6 }, (_, index) =>
        blobStore.putText({ contentType: "text/plain", text: `retained audit ${index}` }),
      ));
      try {
        db.exec(`
          CREATE TABLE audit_log_details (
            logical_prompt_blob_id TEXT, transport_payload_blob_id TEXT, assistant_text_blob_id TEXT,
            raw_items_blob_id TEXT, usage_blob_id TEXT
          );
          CREATE TABLE audit_log_operations (details_blob_id TEXT);
        `);
        db.prepare("INSERT INTO audit_log_details VALUES (?, ?, ?, ?, ?)").run(...auditRefs.slice(0, 5).map((ref) => ref.blobId));
        db.prepare("INSERT INTO audit_log_operations VALUES (?)").run(auditRefs[5].blobId);
        for (const ref of auditRefs) {
          db.prepare(`INSERT INTO blob_objects
            (blob_id, codec, content_type, original_bytes, stored_bytes, raw_sha256, stored_sha256, state, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', 'now')`).run(
            ref.blobId, ref.codec, ref.contentType, ref.originalBytes, ref.storedBytes, ref.rawSha256, ref.storedSha256,
          );
        }
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
            last_active_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          "session-missing",
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
      assert.deepEqual(report.referencedBlobIds, [missingBlobId, ...auditRefs.map((ref) => ref.blobId)].sort());
      assert.deepEqual(report.missingReferencedBlobIds, [missingBlobId]);
      assert.deepEqual(report.orphanBlobObjectIds, []);
      assert.deepEqual(report.garbage.deletedBlobIds, []);
      assert.ok(readBlobObjectIds(dbPath).includes(missingBlobId));
      for (let index = 0; index < auditRefs.length; index += 1) {
        assert.equal(await blobStore.getText(auditRefs[index].blobId), `retained audit ${index}`);
        assert.ok(readBlobObjectIds(dbPath).includes(auditRefs[index].blobId));
      }
    });
  });
});
