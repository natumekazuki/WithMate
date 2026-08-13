import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { createOrVerifyV6FreshDatabase } from "../../src-electron/app-database-v6-bootstrap.js";
import { SessionExecutionPublicProgressStorageV6, SESSION_EXECUTION_PUBLIC_PROGRESS_MAX_BYTES } from "../../src-electron/session-execution-public-progress-storage-v6.js";

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "withmate-public-progress-"));
  const { dbPath } = await createOrVerifyV6FreshDatabase(directory);
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare(`
      INSERT INTO sessions_v6 (id, title, state, provider_id, catalog_revision, model_id, approval_mode, created_at, updated_at, last_active_at)
      VALUES ('session-1', 'Session', 'active', 'codex', 1, 'gpt-5', 'on-request', ?, ?, ?)
    `).run("2026-08-13T00:00:00.000Z", "2026-08-13T00:00:00.000Z", "2026-08-13T00:00:00.000Z");
    db.prepare(`
      INSERT INTO session_executions_v6 (id, session_id, operation, state, request_json, created_at, updated_at)
      VALUES ('execution-1', 'session-1', 'turn.run', 'running', '{}', ?, ?)
    `).run("2026-08-13T00:00:00.000Z", "2026-08-13T00:00:00.000Z");
  } finally {
    db.close();
  }
  return { directory, dbPath, storage: new SessionExecutionPublicProgressStorageV6(dbPath) };
}

describe("SessionExecutionPublicProgressStorageV6", () => {
  it("upsert/readはassistant textだけをUTF-8 1MiB以内で保持し、code point境界で切る", async () => {
    const f = await fixture();
    try {
      const text = "a".repeat(SESSION_EXECUTION_PUBLIC_PROGRESS_MAX_BYTES - 1) + "😀";
      const saved = f.storage.upsert({ executionId: "execution-1", assistantText: text, updatedAt: "2026-08-13T00:01:00.000Z" });
      assert.equal(saved.truncated, true);
      assert.equal(Buffer.byteLength(saved.assistantText, "utf8"), SESSION_EXECUTION_PUBLIC_PROGRESS_MAX_BYTES - 1);
      assert.equal(saved.assistantText.endsWith("\uFFFD"), false);
      assert.deepEqual(f.storage.read("execution-1"), saved);
    } finally {
      f.storage.close();
      await rm(f.directory, { recursive: true, force: true });
    }
  });

  it("同じexecutionをupsertし、deleteは存在時だけtrueを返す", async () => {
    const f = await fixture();
    try {
      f.storage.upsert({ executionId: "execution-1", assistantText: "first", updatedAt: "2026-08-13T00:01:00.000Z" });
      const updated = f.storage.upsert({ executionId: "execution-1", assistantText: "second", updatedAt: "2026-08-13T00:02:00.000Z" });
      assert.deepEqual(f.storage.get("execution-1"), updated);
      assert.equal(f.storage.delete("execution-1"), true);
      assert.equal(f.storage.delete("execution-1"), false);
      assert.equal(f.storage.get("execution-1"), null);
    } finally {
      f.storage.close();
      await rm(f.directory, { recursive: true, force: true });
    }
  });

  it("execution削除時にpublic progressもcascade削除する", async () => {
    const f = await fixture();
    try {
      f.storage.upsert({ executionId: "execution-1", assistantText: "partial", updatedAt: "2026-08-13T00:01:00.000Z" });
      const db = new DatabaseSync(f.dbPath);
      try {
        db.exec("PRAGMA foreign_keys = ON;");
        db.prepare("DELETE FROM session_executions_v6 WHERE id = 'execution-1'").run();
      } finally {
        db.close();
      }
      assert.equal(f.storage.get("execution-1"), null);
    } finally {
      f.storage.close();
      await rm(f.directory, { recursive: true, force: true });
    }
  });
});
