import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";
import { AFFECT_SCHEMA_VERSION, type AffectEventInput } from "../../src-shared/character-affect/affect-contract.js";
import { CharacterAffectStorage, type AffectSessionSource } from "../../src-electron/character/character-affect-storage.js";
import { AuxiliarySessionStorage } from "../../src-electron/auxiliary/auxiliary-session-storage.js";
import { SessionStorageV6 } from "../../src-electron/session/session-storage-v6.js";
import { MemoryV6WorkerClient } from "../../src-electron/memory/memory-v6-worker-client.js";
import { readConversationQuerySnapshot } from "../../src-electron/storage/conversation-query.js";
import { ensureV6Schema, isValidV6Database } from "../../src-electron/storage/database-schema-v6.js";

const now = "2026-08-09T01:00:00.000Z";
const scope = { characterId: "character-a", userId: "local-user", sessionId: "same-id" };
const affectTables = ["character_affect_events_v6", "character_affect_resets_v6", "character_affect_idempotency_v6",
  "character_affect_mutations_v6", "character_affect_observations_v6"] as const;

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "withmate-affect-auxiliary-"));
  const dbPath = join(directory, "withmate-v6.db");
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  ensureV6Schema(db);
  for (const id of ["character-a", "character-parent"]) {
    db.prepare("INSERT INTO characters (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)").run(id, id, now, now);
  }
  for (const [id, character] of [["same-id", "character-a"], ["parent", "character-parent"], ["other", "character-a"]]) {
    db.prepare(`
      INSERT INTO sessions_v6 (id, incarnation_id, title, state, provider_id, catalog_revision, model_id, approval_mode,
        character_id, character_snapshot_json, created_at, updated_at, last_active_at)
      VALUES (?, ?, ?, 'active', 'codex', 1, 'gpt-5', 'on-request', ?, '{}', ?, ?, ?)
    `).run(id, `inc:${id}`, id, character, now, now, now);
  }
  db.prepare(`INSERT INTO auxiliary_sessions
    (id, parent_session_id, status, created_at, updated_at, character_id, character_snapshot_json)
    VALUES ('same-id', 'parent', 'active', ?, ?, 'character-a', '{}')`).run(now, now);
  const auxiliary = new AuxiliarySessionStorage(dbPath);
  auxiliary.close();
  db.prepare(`INSERT INTO auxiliary_session_drafts (auxiliary_session_id, parent_session_id, incarnation, updated_at)
    VALUES ('same-id', 'parent', 'draft-incarnation', ?)`).run(now);
  const snapshot = readConversationQuerySnapshot(db, "auxiliary_session_messages", "same-id")!;
  const source: AffectSessionSource = {
    kind: "auxiliary", sessionId: "same-id", incarnationId: snapshot.incarnationId,
    ownerIdentity: snapshot.ownerIdentity, parent: { sessionId: "parent", incarnationId: "inc:parent" },
  };
  return { directory, dbPath, db, source };
}

function event(key: string, overrides: Partial<AffectEventInput> = {}): AffectEventInput {
  return { schemaVersion: AFFECT_SCHEMA_VERSION, ...scope, layer: "session", targetType: "bug", targetId: key,
    family: "frustration", value: { label: key, valence: -0.5 }, intensity: 0.5,
    reason: "A concrete failure occurred.", evidence: "The check failed.", occurredAt: now, idempotencyKey: key, ...overrides };
}

// @test-value v2
// kind = "contract"
// claim = "同じliteral IDのMainとAuxiliaryでもsession状態・version・inspection・訂正・resetを分離し、親と異なるAuxiliary Characterのrelationshipだけを同Characterへ共有する"
// oracle = { type = "contract", ref = "Issue #910 accepted conversation-owner policy; docs/adr/018-character-affect-event-persistence.md" }
// fault = "Auxiliaryを同名Mainまたは親Mainへ保存・投影するか、Auxiliary resetがMain状態を消す"
// observable = "実Workerのevent owner列、context値、version、inspection、訂正結果、reset後のMain/Auxiliaryとrelationship状態"
// observation_boundary = "public-boundary"
// scope = "Affect Worker commandからSQLite保存とprojectionまで"
// lifecycle = "permanent"
// impact = "別会話の一時感情の混入や誤訂正・誤resetを防ぎ、同Characterの関係状態を維持する"
// distinction = "既存Main単独testと型検査では異kind同IDのWorker option転送と実DB owner分離を確認できない"
// @end-test-value
it("Auxiliary Affectを同名Mainと分離し、Worker経由の訂正・reset・relationshipを適用する", async () => {
  const f = fixture();
  const client = new MemoryV6WorkerClient({ dbPath: f.dbPath,
    workerUrl: new URL("../../src-electron/storage/storage-worker-entry.ts", import.meta.url), now: () => new Date(now) });
  const storage = client.affectStorage;
  const auxScope = { ...scope, sessionSource: f.source };
  try {
    const mainInitial = await storage.getStateVersion(scope);
    const auxInitial = await storage.getStateVersion(auxScope);
    const main = await storage.recordEvent(event("main"));
    assert.equal((await storage.getStateVersion(auxScope)).version, auxInitial.version);
    const aux = await storage.recordEvent(event("aux"), { sessionSource: f.source, expectedVersion: auxInitial.version });
    assert.equal(aux.event.sessionId, null);
    assert.equal(aux.event.sourceSessionId, null);
    assert.equal(aux.event.auxiliarySessionId, "same-id");
    assert.equal(aux.event.sourceAuxiliarySessionId, "same-id");
    const mainVersion = await storage.getStateVersion(scope);
    assert.notEqual(mainVersion.version, mainInitial.version);
    assert.deepEqual((await storage.inspect(scope)).events.map((e) => e.id), [main.event.id]);
    assert.deepEqual((await storage.inspect(auxScope)).events.map((e) => e.id), [aux.event.id]);
    assert.equal((await storage.getContextState(auxScope)).state.components[0]?.label, "aux");
    assert.equal((await storage.getEffectiveState(scope)).components[0]?.label, "main");

    await assert.rejects(async () => storage.correctEvent({ eventId: main.event.id, replacement: event("wrong"), reason: "Wrong owner" },
      { sessionSource: f.source }), /original session scope/);
    const corrected = await storage.correctEvent({
      eventId: aux.event.id, replacement: event("replacement"), reason: "The response changed.",
    }, { sessionSource: f.source, expectedVersion: (await storage.getStateVersion(auxScope)).version });
    assert.equal(corrected.event.correctionOfEventId, aux.event.id);
    assert.equal((await storage.getStateVersion(scope)).version, mainVersion.version);
    assert.equal((await storage.getContextState(auxScope)).state.components[0]?.label, "replacement");

    const relationship = await storage.recordEvent(event("relationship", { layer: "relationship", targetType: "relationship" }),
      { sessionSource: f.source });
    assert.equal(relationship.event.sessionId, null);
    assert.equal(relationship.event.auxiliarySessionId, null);
    assert.equal(relationship.event.sourceAuxiliarySessionId, "same-id");
    assert.ok((await storage.getContextState(scope)).state.components.some((c) => c.label === "relationship"));
    await storage.reset({ ...scope, layer: "session", reason: "The issue is settled.", resetAt: now, idempotencyKey: "aux-reset" },
      { sessionSource: f.source, expectedVersion: (await storage.getStateVersion(auxScope)).version });
    assert.deepEqual((await storage.getContextState(auxScope)).state.components.map((c) => c.label), ["relationship"]);
    assert.deepEqual(new Set((await storage.getContextState(scope)).state.components.map((c) => c.label)), new Set(["main", "relationship"]));
    const resetInspection = await storage.inspect(auxScope);
    assert.equal(resetInspection.resets[0]?.auxiliarySessionId, "same-id");
    assert.equal(resetInspection.resets[0]?.sessionId, null);
    assert.ok(resetInspection.mutations.some((m) => m.operation === "correct" && m.auxiliarySessionId === "same-id"));
    await storage.reset({ characterId: scope.characterId, userId: scope.userId, layer: "relationship",
      reason: "Clear relationship state.", resetAt: now, idempotencyKey: "relationship-reset" },
    { sessionSource: f.source, versionSessionId: "same-id", expectedVersion: (await storage.getStateVersion(auxScope)).version });
    assert.deepEqual((await storage.getContextState(auxScope)).state.components, []);
    assert.deepEqual((await storage.getContextState(scope)).state.components.map((c) => c.label), ["main"]);
  } finally {
    await client.close();
    f.db.close();
    rmSync(f.directory, { recursive: true, force: true });
  }
});

// @test-value v2
// kind = "contract"
// claim = "保存済みAuxiliaryのCharacter・kind・ID・incarnation・parent・Worker ownerIdentityを照合し、再作成されたsourceからのread/write/replayを拒否する"
// oracle = { type = "contract", ref = "Issue #910 accepted actual owner policy; src-shared/session/session-history-read-scope.ts" }
// fault = "同名Mainへのfallbackまたは古いAuxiliary snapshotで現在の会話にAffectを適用する"
// observable = "実SQLite上のread/write/replay拒否と、拒否前後のevent/監査行数"
// observation_boundary = "component-behavior"
// scope = "CharacterAffectStorageのcaptured source境界"
// lifecycle = "permanent"
// impact = "別会話または再作成済み会話への誤記録と誤読を防ぐ"
// distinction = "通常のMain owner testではAuxiliary drafts incarnationを含むownerIdentityの失効を検出できない"
// @end-test-value
it("Auxiliaryのsource identityと独自Characterを検証し、stale read・write・replayを拒否する", () => {
  const f = fixture();
  const storage = new CharacterAffectStorage(f.dbPath, { now: () => new Date(now) });
  const auxScope = { ...scope, sessionSource: f.source };
  try {
    const input = event("aux");
    storage.recordEvent(input, { sessionSource: f.source });
    assert.throws(() => storage.getContextState({ ...auxScope, characterId: "character-parent" }), /does not belong/);
    assert.throws(() => storage.getContextState({ ...auxScope, sessionId: "other" }), /does not match/);
    assert.throws(() => storage.getContextState({ ...auxScope, sessionSource: { ...f.source, incarnationId: "stale" } }), /replaced/);
    assert.throws(() => storage.getContextState({ ...auxScope, sessionSource: { ...f.source, ownerIdentity: "stale" } }), /replaced/);
    assert.throws(() => storage.getContextState({ ...auxScope, sessionSource: {
      ...f.source, kind: "auxiliary", parent: { sessionId: "other", incarnationId: "inc:other" },
    } }), /parent Session was replaced/);
    assert.throws(() => storage.getContextState({ ...auxScope, sessionSource: {
      ...f.source, kind: "auxiliary", parent: { sessionId: "parent", incarnationId: "stale-parent" },
    } }), /parent Session was replaced/);
    const before = affectTables.map((table) => f.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get());
    f.db.prepare("UPDATE auxiliary_session_drafts SET incarnation = 'recreated' WHERE auxiliary_session_id = 'same-id'").run();
    assert.throws(() => storage.getStateVersion(auxScope), /replaced/);
    assert.throws(() => storage.getEffectiveState(auxScope), /replaced/);
    assert.throws(() => storage.inspect(auxScope), /replaced/);
    assert.throws(() => storage.recordEvent(input, { sessionSource: f.source }), /replaced/);
    assert.throws(() => storage.correctEvent({ eventId: "unused", replacement: event("new"), reason: "Correction" },
      { sessionSource: f.source }), /replaced/);
    assert.throws(() => storage.reset({ ...scope, layer: "session", resetAt: now, idempotencyKey: "reset", reason: "Reset" },
      { sessionSource: f.source }), /replaced/);
    assert.deepEqual(affectTables.map((table) => f.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()), before);
  } finally {
    storage.close();
    f.db.close();
    rmSync(f.directory, { recursive: true, force: true });
  }
});

// @test-value v2
// kind = "invariant"
// claim = "Auxiliaryまたは実Main削除経路による親削除でAuxiliaryのsession event/resetだけをcascadeし、同名Mainとrelationship event・訂正監査は保持して発生元をNULL化する"
// oracle = { type = "contract", ref = "Issue #910 accepted deletion policy; docs/adr/018-character-affect-event-persistence.md" }
// fault = "親またはAuxiliaryの削除が同名Mainを消すかrelationship状態を消す、またはAuxiliary session状態を残す"
// observable = "SessionStorageV6.deleteSession後およびAuxiliary DELETE後のinspection、Main event、relationship provenance、FK check"
// observation_boundary = "component-behavior"
// scope = "実SQLiteのAuxiliary外部keyと通常Main削除transaction"
// lifecycle = "permanent"
// impact = "会話削除時の取り残しと共有relationshipの喪失を防ぐ"
// distinction = "schema宣言やMainのみの削除testでは親削除の明示的Auxiliary cleanupと異kind同IDの保持を検証できない"
// @end-test-value
it("Auxiliary削除と実親Session削除でscopeを消し、relationshipと同名Mainを保持する", () => {
  for (const deleteParent of [false, true]) {
    const f = fixture();
    const storage = new CharacterAffectStorage(f.dbPath, { now: () => new Date(now) });
    let sessions: SessionStorageV6 | undefined;
    try {
      const main = storage.recordEvent(event("main")).event;
      const original = storage.recordEvent(event("aux"), { sessionSource: f.source }).event;
      const relationship = storage.correctEvent({ eventId: original.id,
        replacement: event("relationship", { layer: "relationship", targetType: "relationship" }),
        reason: "This is a relationship response." }, { sessionSource: f.source }).event;
      storage.reset({ ...scope, layer: "session", reason: "Clear", resetAt: now, idempotencyKey: "reset" },
        { sessionSource: f.source });
      if (deleteParent) {
        sessions = new SessionStorageV6(f.dbPath);
        sessions.deleteSession("parent");
      } else {
        f.db.prepare("DELETE FROM auxiliary_sessions WHERE id = 'same-id'").run();
      }
      assert.equal(f.db.prepare("SELECT 1 FROM auxiliary_sessions WHERE id = 'same-id'").get(), undefined);
      assert.ok(f.db.prepare("SELECT 1 FROM sessions_v6 WHERE id = 'same-id'").get());
      assert.throws(() => storage.getContextState({ ...scope, sessionSource: f.source }), /does not belong/);
      const inspection = storage.inspect(scope);
      assert.deepEqual(new Set(inspection.events.map((e) => e.id)), new Set([main.id, relationship.id]));
      const retained = inspection.events.find((e) => e.id === relationship.id)!;
      assert.equal(retained.sourceAuxiliarySessionId, null);
      assert.equal(retained.correctionOfEventId, null);
      assert.equal(inspection.resets.length, 0);
      assert.ok(inspection.mutations.some((m) => m.operation === "correct" && m.eventId === relationship.id
        && m.sourceAuxiliarySessionId === null && m.reason === "This is a relationship response."));
      assert.deepEqual(f.db.prepare("PRAGMA foreign_key_check").all(), []);
    } finally {
      sessions?.close();
      storage.close();
      f.db.close();
      rmSync(f.directory, { recursive: true, force: true });
    }
  }
});


// @test-value v2
// kind = "invariant"
// claim = "既存Main-only DBのMemory出典列追加とAffect再構成を同時に繰り返し適用・再openしてもevent/reset/冪等性/監査IDとMemory link・本文・同じstate versionを保持し、Auxiliary ownerを新たに保存できる"
// oracle = { type = "contract", ref = "docs/releases/README.md#保存と参照; docs/design/database-schema.md; Issue #888 accepted Memory/Affect coexistence policy" }
// fault = "Memory出典列追加とAffect table再構成の併用で既存rowをcascade消失・ID採番し直し・Memory参照NULL化するか、ensure再実行でデータを変える"
// observable = "Main-only SQL fixture移行前後の全既存列snapshot、context/version、linked Memory・訂正chain、Memory新出典列とFK整合性、新Auxiliary書込み"
// observation_boundary = "component-behavior"
// scope = "ensureV6Schemaの既存Main Memory出典列追加とAffect table再構成の共存および再起動"
// lifecycle = "permanent"
// impact = "公開済みMain会話の感情履歴、確定監査、関連Memoryの喪失・重複を防ぐ"
// distinction = "fresh DBやschema宣言のtestでは既存rowと連結FKを含むDDL再構成の実挙動を検出できない"
// @end-test-value
it("実Main-only schemaのAffect・Memory・linkとversionを再構成と再起動で保持する", () => {
  const f = fixture();
  let storage = new CharacterAffectStorage(f.dbPath, { now: () => new Date(now) });
  try {
    const main = storage.recordEvent(event("main")).event;
    const body = "An actual Character experience.";
    f.db.prepare(`INSERT INTO memory_entries_v6
      (id, owner_type, owner_id, scope_type, scope_id, kind, title, body, body_sha256, preview,
        state, source_type, source_session_id, created_at, updated_at)
      VALUES ('episode', 'character', 'character-a', 'character', 'character-a', 'note', ?, ?, ?, ?,
        'active', 'agent', 'same-id', ?, ?)`).run(body, body, createHash("sha256").update(body).digest("hex"), body, now, now);
    storage.linkMemoryEpisode(main.id, "episode");
    const corrected = storage.correctEvent({ eventId: main.id, replacement: event("replacement",
      { layer: "relationship", targetType: "relationship" }), reason: "The feeling is relational." }).event;
    storage.linkMemoryEpisode(corrected.id, "episode");
    storage.recordEvent(event("main")); // Retain replay observation as well as mutation audit.
    storage.reset({ ...scope, layer: "session", resetAt: "2026-08-09T00:30:00.000Z",
      idempotencyKey: "reset", reason: "A new phase." });
    const context = storage.getContextState(scope);
    storage.close();

    // Build the persisted Main-only schema, not a fresh current schema with columns hidden.
    const legacySql = affectTables.reduce((sql, table) => sql.replaceAll(table, `${table}_legacy`),
      LEGACY_MAIN_AFFECT_SQL.replace(/CREATE INDEX[^;]+;/g, ""));
    f.db.exec(legacySql);
    const columns = new Map(affectTables.map((table) => [table,
      (f.db.prepare(`PRAGMA table_info(${table}_legacy)`).all() as Array<{ name: string }>).map((c) => c.name).join(", ")]));
    for (const table of affectTables) {
      f.db.exec(`INSERT INTO ${table}_legacy (${columns.get(table)}) SELECT ${columns.get(table)} FROM ${table}`);
    }
    for (const table of [...affectTables].reverse()) f.db.exec(`DROP TABLE ${table}`);
    for (const table of affectTables) f.db.exec(`ALTER TABLE ${table}_legacy RENAME TO ${table}`);
    f.db.exec("ALTER TABLE memory_entries_v6 DROP COLUMN source_auxiliary_session_id");
    const memoryColumns = (f.db.prepare("PRAGMA table_info(memory_entries_v6)").all() as Array<{ name: string }>)
      .map((column) => `"${column.name}"`).join(", ");
    const snapshot = () => [
      ...affectTables.map((table) => f.db.prepare(`SELECT ${columns.get(table)} FROM ${table} ORDER BY rowid`).all()),
      f.db.prepare(`SELECT ${memoryColumns} FROM memory_entries_v6 ORDER BY id`).all(),
    ];
    const before = snapshot();
    assert.equal((f.db.prepare("PRAGMA table_info(character_affect_events_v6)").all() as Array<{ name: string }>)
      .some((c) => c.name === "auxiliary_session_id"), false);
    assert.equal(isValidV6Database(f.dbPath), false);
    for (let reopen = 0; reopen < 2; reopen += 1) {
      ensureV6Schema(f.db);
      ensureV6Schema(f.db);
      assert.deepEqual(snapshot(), before);
      assert.equal(f.db.prepare("SELECT source_auxiliary_session_id FROM memory_entries_v6 WHERE id = 'episode'").get()?.source_auxiliary_session_id, null);
      assert.ok(f.db.prepare("PRAGMA foreign_key_list(memory_entries_v6)").all().some((key) =>
        key.from === "source_auxiliary_session_id" && key.table === "auxiliary_sessions" && key.on_delete === "SET NULL"));
      assert.deepEqual(f.db.prepare("PRAGMA foreign_key_check").all(), []);
      assert.equal(isValidV6Database(f.dbPath), true);
      storage = new CharacterAffectStorage(f.dbPath, { now: () => new Date(now) });
      assert.deepEqual(storage.getContextState(scope), context);
      const inspection = storage.inspect(scope);
      assert.equal(inspection.events.find((e) => e.id === main.id)?.memoryEntryId, "episode");
      const replacement = inspection.events.find((e) => e.id === corrected.id)!;
      assert.equal(replacement.correctionOfEventId, main.id);
      assert.equal(replacement.supersedesMemoryEntryId, "episode");
      storage.close();
    }
    storage = new CharacterAffectStorage(f.dbPath, { now: () => new Date(now) });
    assert.equal(storage.recordEvent(event("main")).created, false);
    const aux = storage.recordEvent(event("aux-after-migration"), { sessionSource: f.source });
    assert.equal(aux.event.auxiliarySessionId, "same-id");
  } finally {
    storage.close();
    f.db.close();
    rmSync(f.directory, { recursive: true, force: true });
  }
});


// @test-value v2
// kind = "contract"
// claim = "同じliteral IDのMain/Auxiliaryを別afterglow sourceとして扱い、current versionを変えず既存の0.5係数・current優先・source reset規則を適用する"
// oracle = { type = "contract", ref = "docs/adr/018-character-affect-event-persistence.md#decision; Issue #910 accepted unchanged afterglow policy" }
// fault = "source選択がliteral IDだけで別kind会話を除外するか、片側のresetを同名会話へ適用する"
// observable = "Main/Auxiliary contextのcomponent強度とlabel、別source書込み前後のcurrent version、source reset後のcomponent"
// observation_boundary = "component-behavior"
// scope = "同CharacterのMain/Auxiliary read-time afterglow projection"
// lifecycle = "permanent"
// impact = "同名IDの別会話でも従来の余韻を維持し、一時感情をcurrent状態やversionへ誤昇格させない"
// distinction = "既存Main-only afterglow testではkindを含むsource選択とreset照合を検知できない"
// @end-test-value
it("同名Main/Auxiliary間のafterglowをcurrent優先とsource別resetで投影する", () => {
  const f = fixture();
  const storage = new CharacterAffectStorage(f.dbPath, { now: () => new Date(now) });
  const auxScope = { ...scope, sessionSource: f.source };
  try {
    storage.recordEvent(event("main-user", { targetType: "user", targetId: "user", family: "joy" }));
    const auxVersion = storage.getStateVersion(auxScope);
    assert.equal(storage.getContextState(auxScope).state.components[0]?.intensity, 0.25);
    assert.equal(storage.getContextState(auxScope).state.components[0]?.label, "main-user");
    assert.deepEqual(storage.getStateVersion(auxScope), auxVersion);
    storage.recordEvent(event("aux-user", { targetType: "user", targetId: "user", family: "joy" }), { sessionSource: f.source });
    assert.equal(storage.getContextState(auxScope).state.components[0]?.intensity, 0.5);
    assert.equal(storage.getContextState(auxScope).state.components[0]?.label, "aux-user");
    assert.equal(storage.getContextState(scope).state.components[0]?.label, "main-user");
    storage.reset({ ...scope, layer: "session", resetAt: now, reason: "Main settled.", idempotencyKey: "main-reset" });
    assert.equal(storage.getContextState(scope).state.components[0]?.label, "aux-user");
    assert.equal(storage.getContextState(scope).state.components[0]?.intensity, 0.25);
    assert.equal(storage.getContextState(auxScope).state.components[0]?.intensity, 0.5);
    storage.reset({ ...scope, layer: "session", resetAt: now, reason: "Auxiliary settled.", idempotencyKey: "aux-reset" },
      { sessionSource: f.source });
    assert.deepEqual(storage.getContextState(scope).state.components, []);
    assert.deepEqual(storage.getContextState(auxScope).state.components, []);
  } finally {
    storage.close();
    f.db.close();
    rmSync(f.directory, { recursive: true, force: true });
  }
});


const LEGACY_MAIN_AFFECT_SQL = `CREATE TABLE IF NOT EXISTS character_affect_events_v6 (
    id TEXT PRIMARY KEY,
    character_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    session_id TEXT,
    source_session_id TEXT,
    layer TEXT NOT NULL CHECK (layer IN ('relationship', 'session')),
    target_type TEXT NOT NULL CHECK (target_type IN ('user', 'relationship', 'task', 'bug', 'artifact', 'self')),
    target_id TEXT NOT NULL,
    family TEXT CHECK (family IS NULL OR family IN ('joy', 'relief', 'interest', 'anticipation', 'affinity', 'gratitude', 'concern', 'frustration', 'disappointment', 'regret', 'determination', 'other')),
    value_json TEXT NOT NULL CHECK (json_valid(value_json)),
    intensity REAL NOT NULL CHECK (intensity >= 0 AND intensity <= 1),
    reason TEXT NOT NULL,
    evidence TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL,
    correction_of_event_id TEXT,
    state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'corrected')),
    memory_entry_id TEXT,
    supersedes_memory_entry_id TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE,
    FOREIGN KEY (session_id) REFERENCES sessions_v6(id) ON DELETE CASCADE,
    FOREIGN KEY (source_session_id) REFERENCES sessions_v6(id) ON DELETE SET NULL,
    FOREIGN KEY (correction_of_event_id) REFERENCES character_affect_events_v6(id) ON DELETE SET NULL,
    FOREIGN KEY (memory_entry_id) REFERENCES memory_entries_v6(id) ON DELETE SET NULL,
    FOREIGN KEY (supersedes_memory_entry_id) REFERENCES memory_entries_v6(id) ON DELETE SET NULL,
    UNIQUE (character_id, user_id, idempotency_key),
    CHECK (user_id <> ''),
    CHECK (target_id <> ''),
    CHECK (layer <> 'relationship' OR target_type IN ('user', 'relationship')),
    CHECK (
      (layer = 'session' AND session_id IS NOT NULL AND source_session_id = session_id)
      OR (layer = 'relationship' AND session_id IS NULL)
    )
  );

  CREATE INDEX IF NOT EXISTS idx_v6_character_affect_events_effective
    ON character_affect_events_v6(character_id, user_id, layer, session_id, state, occurred_at, id);

  CREATE INDEX IF NOT EXISTS idx_v6_character_affect_events_afterglow
    ON character_affect_events_v6(character_id, user_id, layer, state, occurred_at DESC, id ASC, session_id);

  CREATE INDEX IF NOT EXISTS idx_v6_character_affect_events_target
    ON character_affect_events_v6(character_id, user_id, target_type, target_id, occurred_at, id);

  CREATE TABLE IF NOT EXISTS character_affect_resets_v6 (
    id TEXT PRIMARY KEY,
    character_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    session_id TEXT,
    layer TEXT NOT NULL CHECK (layer IN ('relationship', 'session')),
    reason TEXT NOT NULL,
    reset_at TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE,
    FOREIGN KEY (session_id) REFERENCES sessions_v6(id) ON DELETE CASCADE,
    UNIQUE (character_id, user_id, idempotency_key),
    CHECK ((layer = 'session' AND session_id IS NOT NULL) OR (layer = 'relationship' AND session_id IS NULL))
  );

  CREATE INDEX IF NOT EXISTS idx_v6_character_affect_resets_scope
    ON character_affect_resets_v6(character_id, user_id, layer, session_id, reset_at DESC, id DESC);

  CREATE TABLE IF NOT EXISTS character_affect_idempotency_v6 (
    character_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    operation TEXT NOT NULL CHECK (operation IN ('record', 'correct', 'reset')),
    request_fingerprint TEXT NOT NULL,
    event_id TEXT,
    reset_id TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (character_id, user_id, idempotency_key),
    FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE,
    FOREIGN KEY (event_id) REFERENCES character_affect_events_v6(id) ON DELETE CASCADE,
    FOREIGN KEY (reset_id) REFERENCES character_affect_resets_v6(id) ON DELETE CASCADE,
    CHECK (
      (operation IN ('record', 'correct') AND event_id IS NOT NULL AND reset_id IS NULL)
      OR (operation = 'reset' AND event_id IS NULL AND reset_id IS NOT NULL)
    )
  );

  CREATE TABLE IF NOT EXISTS character_affect_mutations_v6 (
    id TEXT PRIMARY KEY,
    operation TEXT NOT NULL CHECK (operation IN ('record', 'reject', 'correct', 'reset', 'episode_candidate', 'link_episode')),
    character_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    session_id TEXT,
    source_session_id TEXT,
    event_id TEXT,
    reset_id TEXT,
    reason TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE,
    FOREIGN KEY (session_id) REFERENCES sessions_v6(id) ON DELETE SET NULL,
    FOREIGN KEY (source_session_id) REFERENCES sessions_v6(id) ON DELETE SET NULL,
    FOREIGN KEY (event_id) REFERENCES character_affect_events_v6(id) ON DELETE SET NULL,
    FOREIGN KEY (reset_id) REFERENCES character_affect_resets_v6(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_v6_character_affect_mutations_scope
    ON character_affect_mutations_v6(character_id, user_id, created_at DESC, id DESC);

  CREATE TABLE IF NOT EXISTS character_affect_observations_v6 (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('idempotency', 'concurrency')),
    outcome TEXT NOT NULL CHECK (outcome IN ('replayed', 'rejected', 'resolved')),
    character_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    session_id TEXT,
    event_id TEXT,
    reset_id TEXT,
    reason TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE,
    FOREIGN KEY (session_id) REFERENCES sessions_v6(id) ON DELETE SET NULL,
    FOREIGN KEY (event_id) REFERENCES character_affect_events_v6(id) ON DELETE SET NULL,
    FOREIGN KEY (reset_id) REFERENCES character_affect_resets_v6(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_v6_character_affect_observations_scope
    ON character_affect_observations_v6(character_id, user_id, created_at DESC, id DESC);`;
