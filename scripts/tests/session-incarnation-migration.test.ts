import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { buildNewSession } from "../../src-shared/session/session-state.js";
import { SessionStorageV6 } from "../../src-electron/session-storage-v6.js";
import { CharacterAffectTurnSettlementStorage, hasSettlementSessionOwner } from "../../src-electron/character-affect-turn-settlement-storage.js";

// @test-value v2
// kind = "invariant"
// claim = "incarnation列のない既存V6 SessionとAffect pendingは同じlegacy ownerとして移行され、既存correlation再送を維持するが、同じIDの再作成後は旧pendingを新ownerと認めない"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md#character-affect-の完了後評価" }
// fault = "migrationが既存本文やpendingを失う、既存fingerprintとの互換性を壊す、または再作成行が旧pendingのownerになる"
// observable = "再open後のSession本文・incarnationとpending owner一致、既存correlationのcreated=false、新owner不一致とcorrelation再利用拒否"
// observation_boundary = "public-boundary"
// scope = "V6 schemaとCharacter Affect settlementの既存DB migration"
// lifecycle = "permanent"
// impact = "既存データ更新時にpending評価を失うか別会話へ誤適用する"
// distinction = "新規DBの競合testと異なり旧列構成を実SQLiteで再現し、再openと再作成を同じ永続データ上で検証する"
// @end-test-value
test("既存V6 Sessionとpendingのincarnation移行は本文と既存correlationを維持する", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "withmate-incarnation-migration-"));
  const dbPath = path.join(directory, "app.db");
  let sessions = new SessionStorageV6(dbPath);
  let settlements = new CharacterAffectTurnSettlementStorage(dbPath);
  try {
    const initial = sessions.insertSession({
      ...buildNewSession({ id: "legacy-session", taskTitle: "Legacy", workspaceLabel: "workspace",
        workspacePath: "C:/workspace", branch: "main", characterId: "character-a", character: "A",
        characterIconPath: "", characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" }, approvalMode: "on-request" }),
      messages: [{ role: "user", text: "user" }, { role: "assistant", text: "assistant" }],
    });
    const pendingInput = { correlationId: "legacy-correlation", sessionId: initial.id, characterId: initial.characterId,
      userMessage: "user", assistantMessage: "assistant", assistantMessageIndex: 1, occurredAt: initial.updatedAt };
    settlements.enqueue(pendingInput);
    settlements.markReady(pendingInput.correlationId);
    settlements.close();
    sessions.close();
    const db = new DatabaseSync(dbPath);
    try {
      db.exec("ALTER TABLE sessions_v6 DROP COLUMN incarnation_id");
      db.exec("ALTER TABLE character_affect_turn_settlements DROP COLUMN session_incarnation_id");
    } finally { db.close(); }
    sessions = new SessionStorageV6(dbPath);
    settlements = new CharacterAffectTurnSettlementStorage(dbPath);
    const migrated = sessions.getSession(initial.id);
    const pending = settlements.getPending(pendingInput.correlationId);
    assert.ok(migrated);
    assert.ok(pending);
    assert.equal(migrated.incarnationId, `legacy:${initial.id}`);
    assert.deepEqual(migrated.messages, initial.messages);
    assert.equal(hasSettlementSessionOwner(migrated, pending), true);
    assert.deepEqual(settlements.enqueue({ ...pendingInput, sessionIncarnationId: migrated.incarnationId }), { created: false });
    assert.equal(sessions.updateSession({ ...migrated, taskTitle: "Updated legacy" }).taskTitle, "Updated legacy");
    sessions.deleteSession(initial.id);
    const replacement = sessions.insertSession(initial);
    assert.notEqual(replacement.incarnationId, migrated.incarnationId);
    assert.equal(hasSettlementSessionOwner(replacement, pending), false);
    assert.throws(() => settlements.enqueue({ ...pendingInput, sessionIncarnationId: replacement.incarnationId }), /different Session incarnation/);
  } finally {
    settlements.close();
    sessions.close();
    await rm(directory, { recursive: true, force: true });
  }
});
