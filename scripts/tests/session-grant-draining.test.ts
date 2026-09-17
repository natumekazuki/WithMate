import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createOrVerifyV6FreshDatabase } from "../../src-electron/app-database-v6-bootstrap.js";
import { SessionAuthorityService } from "../../src-electron/session-authority-service.js";
import { ensureBaselineSessionAuthority } from "../../src-electron/session-authority-storage.js";
import { SessionLifecycleStorage } from "../../src-electron/session-lifecycle-storage.js";
import { SessionAuthorityError } from "../../src/session-authority.js";
import { insertStandaloneRoleBindingsForSessions } from "./session-role-binding-fixture.js";

const NOW = "2026-09-14T00:00:00.000Z";

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "withmate-session-grant-draining-"));
  const { dbPath } = await createOrVerifyV6FreshDatabase(directory);
  const db = new DatabaseSync(dbPath);
  try {
    const insert = db.prepare(`INSERT INTO sessions_v6
      (id, title, state, provider_id, catalog_revision, model_id, approval_mode, created_at, updated_at, last_active_at)
      VALUES (?, ?, 'active', 'codex', 1, 'gpt-5', 'on-request', ?, ?, ?)`);
    for (const id of ["source", "destination", "unrelated"]) insert.run(id, id, NOW, NOW, NOW);
    insertStandaloneRoleBindingsForSessions(db);
    db.prepare("UPDATE session_role_bindings_v6 SET session_role = 'overall-coordinator' WHERE session_id IN ('source', 'destination')").run();
    for (const id of ["source", "destination", "unrelated"]) ensureBaselineSessionAuthority(db, id, NOW);
  } finally { db.close(); }
  const authority = new SessionAuthorityService({ databasePath: dbPath, getExecutionGeneration: () => "internal", now: () => new Date(NOW) });
  const lifecycle = new SessionLifecycleStorage(dbPath);
  return { dbPath, authority, lifecycle, async close() { authority.close(); lifecycle.close(); await rm(directory, { recursive: true, force: true }); } };
}

function assertDenied(authority: SessionAuthorityService, actor: string): void {
  assert.throws(
    () => authority.authorizeSessionAct(actor, "session.rename", { sessionId: actor, title: "renamed" }),
    (error) => error instanceof SessionAuthorityError && error.code === "AUTHORITY_FORBIDDEN",
  );
}

// @test-value v2
// kind = "invariant"
// claim = "進行中のcross-root session.moveはsourceとdestination rootのsession.rename authorityをdraining中拒否する"
// oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/05-grants-routing-and-transfer.md#L70" }
// fault = "pending moveの片側rootだけを検査し、他方のrootでsession.renameを許可する"
// observable = "実SQLite authority判定のsession.rename拒否結果と非関係rootの許可結果"
// observation_boundary = "component-behavior"
// scope = "session authority draining admission"
// lifecycle = "permanent"
// distinction = "lifecycle ownerのprepareで保存したpending operationをauthority storageが再読する"
// @end-test-value
test("pending cross-root move drains both roots while leaving unrelated roots available", async () => {
  const f = await fixture();
  try {
    const pending = f.lifecycle.prepare({ operation: "session.move", principalKind: "system", principalId: "lifecycle-owner", idempotencyKey: "move-drain", requestFingerprint: "move-drain-fingerprint", targetSessionId: "source", sourceRootSessionId: "source", destinationRootSessionId: "destination", manifest: { sessionId: "source", destinationRootSessionId: "destination" }, createdAt: NOW });
    assertDenied(f.authority, "source");
    assertDenied(f.authority, "destination");
    assert.doesNotThrow(() => f.authority.authorizeSessionAct("unrelated", "session.rename", { sessionId: "unrelated", title: "renamed" }));
    const reopened = new SessionLifecycleStorage(f.dbPath);
    try {
      assert.equal(reopened.get(pending.operationId)?.state, "prepared");
      assertDenied(f.authority, "source");
      assertDenied(f.authority, "destination");
      const recovery = reopened.markRecoveryRequired(pending.operationId, pending.revision, { code: "MOVE_UNCERTAIN" }, NOW);
      assertDenied(f.authority, "source");
      assertDenied(f.authority, "destination");
      reopened.reject(pending.operationId, recovery.revision, { code: "MOVE_ABORTED" }, NOW);
    } finally { reopened.close(); }
    assert.doesNotThrow(() => f.authority.authorizeSessionAct("source", "session.rename", { sessionId: "source", title: "renamed" }));
    assert.doesNotThrow(() => f.authority.authorizeSessionAct("destination", "session.rename", { sessionId: "destination", title: "renamed" }));
  } finally { await f.close(); }
});

// @test-value v2
// kind = "invariant"
// claim = "session.moveの完了はdrainingを解除し、sourceとdestination rootのsession.renameを再開できる"
// oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/05-grants-routing-and-transfer.md#L70" }
// fault = "completed moveをpendingとして扱い続け、正当なsession.renameを恒久拒否する"
// observable = "lifecycle complete後の両root session.rename authority判定"
// observation_boundary = "component-behavior"
// scope = "session authority draining completion"
// lifecycle = "permanent"
// distinction = "preparedからrunningを経た既存lifecycle operationをcompleteし、両rootを再判定する"
// @end-test-value
test("completed cross-root move releases both root drains", async () => {
  const f = await fixture();
  try {
    const pending = f.lifecycle.prepare({ operation: "session.move", principalKind: "system", principalId: "lifecycle-owner", idempotencyKey: "move-complete", requestFingerprint: "move-complete-fingerprint", targetSessionId: "source", sourceRootSessionId: "source", destinationRootSessionId: "destination", manifest: { sessionId: "source", destinationRootSessionId: "destination" }, createdAt: NOW });
    const running = f.lifecycle.recordStep({ operationId: pending.operationId, expectedRevision: pending.revision, step: "filesystem", effect: "committed", state: "running", occurredAt: NOW });
    f.lifecycle.complete(pending.operationId, running.revision, { moved: true }, NOW);
    assert.doesNotThrow(() => f.authority.authorizeSessionAct("source", "session.rename", { sessionId: "source", title: "renamed" }));
    assert.doesNotThrow(() => f.authority.authorizeSessionAct("destination", "session.rename", { sessionId: "destination", title: "renamed" }));
  } finally { await f.close(); }
});
