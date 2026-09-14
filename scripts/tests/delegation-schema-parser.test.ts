import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { parseSessionRuntimeOperationInput } from "../../src/session-external-runtime-contract.js";
import { buildNewSession } from "../../src/session-state.js";
import { createOrVerifyV6FreshDatabase } from "../../src-electron/app-database-v6-bootstrap.js";
import { ensureV6Schema, isValidV6Database } from "../../src-electron/database-schema-v6.js";
import { SessionStorageV6 } from "../../src-electron/session-storage-v6.js";

const NOW = "2026-09-14T00:00:00.000Z";

// @test-value v2
// kind = "invariant"
// claim = "Delegation schemaは既存DB検証後もactor FKとactor/idempotency unique制約を実効化し、parserは未知delegation operationを受理しない"
// oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/04-delegation-transaction.md#公開操作" }
// fault = "DDL文字列だけが制約を示して実DBでは重複または孤児actorを保存する、またはprefix判定が未知delegation operationを内部parserへ通す"
// observable = "既存row保持、重複insertとFKなしinsertの拒否、未知operationのUnsupported Session runtime operation拒否"
// observation_boundary = "component-behavior"
// scope = "delegation schema constraints and runtime operation parser"
// lifecycle = "permanent"
// @end-test-value
test("delegation schema constraints survive existing DB verification and parser rejects unknown operations", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "delegation-schema-parser-"));
  const { dbPath } = await createOrVerifyV6FreshDatabase(directory);
  const sessions = new SessionStorageV6(dbPath);
  sessions.insertSession({
    ...buildNewSession({
      id: "actor",
      taskTitle: "actor",
      workspaceLabel: "workspace",
      workspacePath: directory,
      branch: "main",
      characterId: "character",
      character: "Character",
      characterIconPath: "",
      characterThemeColors: { main: "#fff", sub: "#000" },
      approvalMode: "never",
      rootSessionRole: "overall-coordinator",
    }),
    updatedAt: NOW,
  });
  sessions.close();

  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA foreign_keys = ON");
    const row = {
      id: "delegation-1",
      revision: 1,
      actorSessionId: "actor",
      idempotencyKey: "same-key",
      state: "prepared",
      requestJson: JSON.stringify({ idempotencyKey: "same-key", dispatch: "prepare", items: [] }),
      itemsJson: "[]",
      recoveryActionsJson: "[\"retry\"]",
      lastMutationJson: "null",
    };
    const insert = db.prepare(`
      INSERT INTO delegations_v6
        (id, revision, actor_session_id, idempotency_key, state, request_json, items_json, pending_json,
         recovery_actions_json, last_mutation_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
    `);
    insert.run(row.id, row.revision, row.actorSessionId, row.idempotencyKey, row.state, row.requestJson, row.itemsJson, row.recoveryActionsJson, row.lastMutationJson, NOW, NOW);
    ensureV6Schema(db);
    assert.equal((db.prepare("SELECT id FROM delegations_v6 WHERE id = ?").get(row.id) as { id: string }).id, row.id);
    assert.throws(() => insert.run("delegation-2", 1, "actor", "same-key", row.state, row.requestJson, row.itemsJson, row.recoveryActionsJson, row.lastMutationJson, NOW, NOW), /UNIQUE/i);
    assert.throws(() => insert.run("delegation-orphan", 1, "missing-actor", "orphan-key", row.state, row.requestJson, row.itemsJson, row.recoveryActionsJson, row.lastMutationJson, NOW, NOW), /FOREIGN KEY/i);
  } finally {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }

  assert.deepEqual(parseSessionRuntimeOperationInput("delegation.get", { delegationId: "delegation-1" }), { delegationId: "delegation-1" });
  assert.throws(() => parseSessionRuntimeOperationInput("delegation.unknown" as never, {}), /Unsupported Session runtime operation/i);
});

// @test-value v2
// kind = "security"
// claim = "既存DBのdelegation制約が弱められている場合、起動時検証はDBを有効なV6 schemaとして受理しない"
// oracle = { type = "contract", ref = "src-electron/database-schema-v6.ts#isValidV6Database" }
// fault = "同名の非unique indexまたはactor_session_id FK欠落を検出できず、壊れた既存DBを通常DBとして利用する"
// observable = "正常DBはvalid、制約を弱めたDBはisValidV6Database=falseかつcreateOrVerifyがfoundation schema error"
// observation_boundary = "component-behavior"
// scope = "delegations_v6 existing schema validation"
// lifecycle = "permanent"
// @end-test-value
test("existing delegation schema with weakened unique index or actor FK is rejected", async () => {
  for (const malformed of ["unique", "foreign-key"] as const) {
    const directory = await mkdtemp(path.join(tmpdir(), `delegation-malformed-${malformed}-`));
    try {
      const { dbPath } = await createOrVerifyV6FreshDatabase(directory);
      assert.equal(isValidV6Database(dbPath), true, malformed);
      const db = new DatabaseSync(dbPath);
      try {
        db.exec("PRAGMA foreign_keys = OFF");
        if (malformed === "unique") {
          db.exec("DROP INDEX idx_v6_delegations_actor_idempotency; CREATE INDEX idx_v6_delegations_actor_idempotency ON delegations_v6(actor_session_id, idempotency_key)");
        } else {
          db.exec(`
            ALTER TABLE delegations_v6 RENAME TO delegations_v6_legacy;
            CREATE TABLE delegations_v6 (
              id TEXT PRIMARY KEY, revision INTEGER NOT NULL, actor_session_id TEXT NOT NULL,
              idempotency_key TEXT NOT NULL, state TEXT NOT NULL, request_json TEXT NOT NULL,
              items_json TEXT NOT NULL, pending_json TEXT, recovery_actions_json TEXT NOT NULL,
              last_mutation_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
            );
            INSERT INTO delegations_v6 SELECT * FROM delegations_v6_legacy;
            DROP TABLE delegations_v6_legacy;
            CREATE UNIQUE INDEX idx_v6_delegations_actor_idempotency ON delegations_v6(actor_session_id, idempotency_key);
          `);
        }
      } finally {
        db.close();
      }
      assert.equal(isValidV6Database(dbPath), false, malformed);
      await assert.rejects(() => createOrVerifyV6FreshDatabase(directory), /foundation schema/i);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});
