import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { createOrVerifyV6FreshDatabase } from "../../src-electron/storage/app-database-v6-bootstrap.js";
import { SessionTurnStorageV6, deleteSessionTurnsForTargets } from "../../src-electron/session/session-turn-storage-v6.js";
import type { SessionTurnInput } from "../../src-shared/session/session-turn-state.js";

// @test-value v2
// kind = "contract"
// claim = "最新turnは直接ownerだけに属しrunningを含めて返り、一度確定した結果を再分類できない"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md" }
// fault = "親readでAuxiliary turnを返す、runningを飛ばして古いterminalを返す、owner違いで更新する、またはterminal結果を上書きする"
// observable = "最新turnのid/phase、更新拒否、対象削除後の各ownerのturn"
// observation_boundary = "public-boundary"
// scope = "SessionTurnStorageV6 direct-owner and terminal contract"
// lifecycle = "permanent"
// impact = "Latest Commandと取消表示の混線や既確定結果の再分類を防ぐ"
// distinction = "type/schema checkではowner queryの選択と確定更新guard、削除境界を検証できない"
// @end-test-value
test("最小turnは直接owner・最新running・一度だけのterminal確定を維持する", async () => {
  const directory = await mkdtemp(join(tmpdir(), "withmate-turn-storage-"));
  try {
    const { dbPath } = await createOrVerifyV6FreshDatabase(directory);
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(`INSERT INTO sessions_v6 (id, title, state, provider_id, catalog_revision, model_id,
        reasoning_effort, approval_mode, character_snapshot_json, created_at, updated_at, last_active_at)
        VALUES ('main', 'Main', 'active', 'codex', 1, 'model', 'medium', 'untrusted', '{}', '2026-10-01', '2026-10-01', '2026-10-01');
        INSERT INTO auxiliary_sessions (id, parent_session_id, status, created_at, updated_at)
        VALUES ('aux', 'main', 'active', '2026-10-01', '2026-10-01');`);
    } finally { db.close(); }
    const storage = new SessionTurnStorageV6(dbPath);
    const input: SessionTurnInput = {
      sessionId: "main", createdAt: "2026-10-01T00:00:00.000Z", phase: "running",
      provider: "codex", model: "model", reasoningEffort: "medium", approvalMode: "untrusted",
      threadId: "thread", errorMessage: "", userMessageSeq: 0,
    };
    try {
      for (const phase of ["completed", "failed", "canceled"] as const) {
        const turn = storage.createSessionTurn(input);
        const terminal = { ...input, phase, assistantMessageSeq: 1, completedAt: "2026-10-01T00:01:00.000Z" };
        assert.equal(storage.updateSessionTurn(turn.id, terminal).phase, phase);
        assert.throws(() => storage.updateSessionTurn(turn.id, { ...input, phase: "failed" }), /owner mismatch/);
        assert.equal(storage.getLatestSessionTurn("main")?.phase, phase);
      }
      const running = storage.createSessionTurn(input);
      const auxiliary = storage.createSessionTurn({ ...input, sessionId: "aux" });
      assert.equal(storage.getLatestSessionTurn("main")?.id, running.id);
      assert.equal(storage.getLatestSessionTurn("main")?.phase, "running");
      assert.equal(storage.getLatestSessionTurn("aux")?.id, auxiliary.id);
      assert.throws(() => storage.updateSessionTurn(running.id, { ...input, sessionId: "aux" }), /owner mismatch/);
      assert.equal(storage.getLatestSessionTurn("missing"), null);
      const cleanupDb = new DatabaseSync(dbPath);
      try { deleteSessionTurnsForTargets(cleanupDb, { auxiliarySessionIds: ["aux"] }); }
      finally { cleanupDb.close(); }
      assert.equal(storage.getLatestSessionTurn("aux"), null);
      assert.equal(storage.getLatestSessionTurn("main")?.id, running.id);
    } finally { storage.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
