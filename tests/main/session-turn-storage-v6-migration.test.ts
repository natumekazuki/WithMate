import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { createOrVerifyV6FreshDatabase } from "../../src-electron/storage/app-database-v6-bootstrap.js";
import { ensureV6Schema } from "../../src-electron/storage/database-schema-v6.js";
import { SessionTurnStorageV6 } from "../../src-electron/session/session-turn-storage-v6.js";

function insertSession(db: DatabaseSync): void {
  db.exec(`INSERT INTO sessions_v6 (id, title, state, provider_id, catalog_revision, model_id,
    reasoning_effort, approval_mode, character_snapshot_json, created_at, updated_at, last_active_at)
    VALUES ('main', 'Main', 'active', 'codex', 1, 'model', 'medium', 'untrusted', '{}', '2026-10-01', '2026-10-01', '2026-10-01')`);
}

function createLegacyTable(db: DatabaseSync): void {
  db.exec(`CREATE TABLE audit_events_v6 (id INTEGER PRIMARY KEY, session_id TEXT, auxiliary_session_id TEXT,
    event_type TEXT NOT NULL, provider_id TEXT NOT NULL, metadata_json TEXT NOT NULL, created_at TEXT NOT NULL)`);
}

// @test-value v2
// kind = "contract"
// claim = "旧V6の最小turn owner・結果・本文位置・時刻は再起動後も通常会話を変更せず利用できる"
// oracle = { type = "contract", ref = "docs/design/database-schema.md#起動時の移行とデータ保護" }
// fault = "移行でturn linkageや結果を破棄する、または通常artifactを旧Audit詳細で置換する"
// observable = "再open後のturn fieldsと通常message/artifactの保存値"
// observation_boundary = "public-boundary"
// scope = "V6 legacy turn migration"
// lifecycle = "permanent"
// impact = "turn結果、通常会話、Timingとownerの継続性を保護する"
// distinction = "schema/type checkだけでは既存行を持つDBの移行結果とtransaction rollbackを検証できない"
// @end-test-value
test("既存V6を最小turnへ移行し通常履歴とturn ownerを保持する", async () => {
  const directory = await mkdtemp(join(tmpdir(), "withmate-turn-migration-"));
  try {
    const { dbPath } = await createOrVerifyV6FreshDatabase(directory);
    const db = new DatabaseSync(dbPath);
    try {
      insertSession(db);
      db.exec(`INSERT INTO auxiliary_sessions (id, parent_session_id, status, created_at, updated_at)
        VALUES ('aux', 'main', 'active', '2026-10-01', '2026-10-01')`);
      db.exec(`INSERT INTO session_messages_v6 (session_id, seq, role, body, created_at)
        VALUES ('main', 0, 'user', 'question', '2026-10-01'), ('main', 1, 'assistant', 'normal result', '2026-10-01')`);
      const artifactBody = JSON.stringify({ operationTimeline: [{ type: "shell", summary: "normal", details: "saved output" }] });
      db.prepare("UPDATE session_messages_v6 SET artifact_body = ? WHERE session_id = 'main' AND seq = 1").run(artifactBody);
      db.exec("ALTER TABLE session_turns_v6 ADD COLUMN summary TEXT NOT NULL DEFAULT ''");
      createLegacyTable(db);
      const insert = db.prepare("INSERT INTO audit_events_v6 VALUES (?, ?, ?, 'session_turn', 'codex', ?, '2026-10-01T01:00:00.000Z')");
      insert.run(4, "main", null, JSON.stringify({ phase: "completed", model: "model", reasoningEffort: "medium",
        approvalMode: "untrusted", assistantText: "normal result", userMessageSeq: 0, threadId: "thread", rawItemsJson: "ignored detail" }));
      insert.run(5, null, "aux", JSON.stringify({ phase: "canceled", model: "model", reasoningEffort: "medium",
        approvalMode: "untrusted", errorMessage: "cancel", threadId: "aux-thread" }));
      ensureV6Schema(db);
      ensureV6Schema(db);
      assert.equal((db.prepare("SELECT body FROM session_messages_v6 WHERE session_id = 'main' AND seq = 1").get() as { body: string }).body, "normal result");
      assert.equal((db.prepare("SELECT artifact_body FROM session_messages_v6 WHERE session_id = 'main' AND seq = 1").get() as { artifact_body: string }).artifact_body, artifactBody);
      assert.deepEqual(db.prepare("SELECT session_id, auxiliary_session_id, phase FROM session_turns_v6 ORDER BY id").all().map((row) => ({ ...row })), [
        { session_id: "main", auxiliary_session_id: null, phase: "completed" },
        { session_id: null, auxiliary_session_id: "aux", phase: "canceled" },
      ]);
      assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
    } finally { db.close(); }
    const turns = new SessionTurnStorageV6(dbPath);
    try {
      const main = turns.getLatestSessionTurn("main");
      assert.equal(main?.assistantMessageSeq, 1);
      assert.equal(main?.userMessageSeq, 0);
      assert.equal(main?.threadId, "thread");
      assert.equal(main?.completedAt, "2026-10-01T01:00:00.000Z");
      assert.equal(turns.getLatestSessionTurn("aux")?.errorMessage, "cancel");
      assert.equal(turns.getConversationTimingSnapshot("main", "2026-10-02").currentSessionLastCompletedAt, main?.completedAt);
    } finally { turns.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

// @test-value v2
// kind = "contract"
// claim = "最小turn移行でmetadata破損を検出した場合は既存DBを変更せず失敗を伝える"
// oracle = { type = "contract", ref = "docs/design/database-schema.md#起動時の移行とデータ保護" }
// fault = "破損を成功扱いして過去turnや通常会話を失う"
// observable = "ensureV6Schemaの例外と失敗後のturn数・元metadata・本文"
// observation_boundary = "public-boundary"
// scope = "V6 migration rollback"
// lifecycle = "permanent"
// impact = "turn結果、通常会話、Timingとownerの継続性を保護する"
// distinction = "schema/type checkだけでは既存行を持つDBの移行結果とtransaction rollbackを検証できない"
// @end-test-value
test("破損したturn metadataは移行全体をrollbackする", async () => {
  const directory = await mkdtemp(join(tmpdir(), "withmate-turn-rollback-"));
  try {
    const { dbPath } = await createOrVerifyV6FreshDatabase(directory);
    const db = new DatabaseSync(dbPath);
    try {
      insertSession(db);
      createLegacyTable(db);
      db.exec(`INSERT INTO audit_events_v6 VALUES (1, 'main', NULL, 'session_turn', 'codex', '{"phase":"completed"}', '2026-10-01'),
        (2, 'main', NULL, 'session_turn', 'codex', 'broken', '2026-10-01')`);
      assert.throws(() => ensureV6Schema(db), /malformed JSON/);
      assert.equal((db.prepare("SELECT COUNT(*) AS count FROM session_turns_v6").get() as { count: number }).count, 0);
      assert.equal((db.prepare("SELECT metadata_json FROM audit_events_v6 WHERE id = 2").get() as { metadata_json: string }).metadata_json, "broken");
      assert.equal((db.prepare("SELECT title FROM sessions_v6 WHERE id = 'main'").get() as { title: string }).title, "Main");
    } finally { db.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
