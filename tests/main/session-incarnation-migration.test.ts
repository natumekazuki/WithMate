import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { buildNewSession } from "../../src-shared/session/session-state.js";
import { SessionStorageV6 } from "../../src-electron/session/session-storage-v6.js";

// @test-value v2
// kind = "invariant"
// claim = "incarnation列のない既存V6 Sessionは本文を維持してlegacy ownerへ移行し、同じIDでの再作成は新ownerになる"
// oracle = { type = "contract", ref = "src-electron/session/session-storage-v6.ts" }
// fault = "migrationが既存本文を失うか、同じIDの再作成Sessionが旧incarnationを再利用する"
// observable = "再open後のSession本文・incarnation、更新結果と再作成後のincarnation不一致"
// observation_boundary = "public-boundary"
// scope = "V6 Sessionの既存DB migration"
// lifecycle = "permanent"
// impact = "既存データ更新時に会話本文を失うか、再作成会話へ旧ownerの操作を誤適用する"
// distinction = "新規DBの競合testと異なり旧列構成を実SQLiteで再現し、再openと再作成を同じ永続データ上で検証する"
// @end-test-value
test("既存V6 Sessionのincarnation移行は本文を維持し再作成ownerを区別する", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "withmate-incarnation-migration-"));
  const dbPath = path.join(directory, "app.db");
  let sessions = new SessionStorageV6(dbPath);
  try {
    const initial = sessions.insertSession({
      ...buildNewSession({ id: "legacy-session", taskTitle: "Legacy", workspaceLabel: "workspace",
        workspacePath: "C:/workspace", branch: "main", characterId: "character-a", character: "A",
        characterIconPath: "", characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" }, approvalMode: "on-request" }),
      messages: [{ role: "user", text: "user" }, { role: "assistant", text: "assistant" }],
    });
    sessions.close();
    const db = new DatabaseSync(dbPath);
    try {
      db.exec("ALTER TABLE sessions_v6 DROP COLUMN incarnation_id");
    } finally { db.close(); }
    sessions = new SessionStorageV6(dbPath);
    const migrated = sessions.getSession(initial.id);
    assert.ok(migrated);
    assert.equal(migrated.incarnationId, `legacy:${initial.id}`);
    assert.deepEqual(migrated.messages, initial.messages);
    assert.equal(sessions.updateSession({ ...migrated, taskTitle: "Updated legacy" }).taskTitle, "Updated legacy");
    sessions.deleteSession(initial.id);
    const replacement = sessions.insertSession(initial);
    assert.notEqual(replacement.incarnationId, migrated.incarnationId);
  } finally {
    sessions.close();
    await rm(directory, { recursive: true, force: true });
  }
});
