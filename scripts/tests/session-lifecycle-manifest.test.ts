import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { buildSessionLifecycleManifest } from "../../src-electron/session-lifecycle-manifest.js";
import { ensureV6Schema } from "../../src-electron/database-schema-v6.js";
import { SESSION_RUNTIME_RESULT_SCHEMA_VERSION } from "../../src/session-external-runtime-contract.js";
import { parseSessionRuntimeResultEnvelope } from "../../src/session-external-runtime-schema.js";

function createDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensureV6Schema(db);
  return db;
}

// @test-value v2
// kind = "invariant"
// claim = "manifestは対象Session subtreeの実在resourceを列挙し、manifestRevisionはDB全体の既存append-only event counterを参照する"
// oracle = { type = "contract", ref = "src/session-external-runtime-contract.ts#SessionRuntimeSessionMoveManifestResult" }
// fault = "fake revisionやroot全体のresourceがmanifestに混入する"
// observable = "subtree、workItems、executions、grants、reservations、artifacts、open counts"
// observation_boundary = "implementation"
// scope = "session-lifecycle-manifest"
// lifecycle = "permanent"
// @end-test-value
test("Session lifecycle manifestは空closureを実在DBから返す", () => {
  const db = createDb();
  db.prepare(`INSERT INTO sessions_v6 (id, title, state, provider_id, catalog_revision, model_id, approval_mode, created_at, updated_at, last_active_at, resource_revision)
    VALUES (?, 'Root', 'active', 'codex', 1, 'model', 'never', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?)`)
    .run("root", 3);
  db.prepare("INSERT INTO session_role_bindings_v6 (session_id, session_role, role_contract_revision, root_session_id, parent_session_id, delegation_depth) VALUES (?, 'standalone', 1, ?, ?, 0)").run("root", "root", null);
  const manifest = buildSessionLifecycleManifest(db, "root");
  assert.equal(manifest.sessionId, "root");
  assert.equal(manifest.destinationRootSessionId, null);
  assert.equal(manifest.manifestRevision, 0);
  assert.deepEqual(manifest.descendants, []);
  assert.deepEqual(manifest.workItems, []);
  assert.deepEqual(manifest.executions, { running: 0, queued: 0 });
  assert.equal(manifest.openInteractions, 0);
  assert.equal(manifest.openCoordinationEvents, 0);
  assert.deepEqual(manifest.artifacts, []);
  assert.deepEqual(manifest.budgetReservations, []);
  assert.deepEqual(manifest.grants, []);
  assert.deepEqual(manifest.blockers, []);
  assert.equal("deletable" in manifest && manifest.deletable, true);
  db.close();
});

// @test-value v2
// kind = "invariant"
// claim = "move manifestは対象subtreeの移管用resource詳細を列挙し、delete manifestは削除可否に必要な既存列挙だけを返し、event追加をstale検知する"
// oracle = { type = "contract", ref = "src/session-external-runtime-contract.ts#SessionRuntimeDeleteManifestResult,SessionRuntimeSessionMoveManifestResult" }
// fault = "対象subtreeのresourceが欠落する、同root siblingのeventでrevision変化を見落とす、またはdelete manifestへ移管専用詳細が混入する"
// observable = "execution/work/grant/reservation/usage/artifact/interaction/coordinationの件数とstate、grant chain、resource history、event identity、delete projectionのfield集合"
// observation_boundary = "implementation"
// scope = "session-lifecycle-manifest"
// lifecycle = "permanent"
// @end-test-value
test("Session lifecycle manifestはrunning/queuedと保護resourceを列挙する", () => {
  const db = createDb();
  db.exec(`INSERT INTO sessions_v6 (id, title, state, provider_id, catalog_revision, model_id, approval_mode, created_at, updated_at, last_active_at, resource_revision)
    VALUES ('root', 'Root', 'active', 'codex', 1, 'model', 'never', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 2),
      ('child', 'Child', 'active', 'codex', 1, 'model', 'never', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 4),
      ('sibling', 'Sibling', 'active', 'codex', 1, 'model', 'never', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 8)`);
  db.exec("INSERT INTO session_role_bindings_v6 (session_id, session_role, role_contract_revision, root_session_id, parent_session_id, delegation_depth) VALUES ('root', 'standalone', 1, 'root', NULL, 0), ('child', 'executor', 1, 'root', 'root', 1), ('sibling', 'executor', 1, 'root', 'root', 1)");
  db.exec(`INSERT INTO work_items_v6 (id, kind, contract_revision, root_session_id, creator_session_id, target_session_id, goal, scope, completion_criteria, authority, source_identity_json, state, revision, created_at, updated_at)
    VALUES ('work-child', 'delegated', 2, 'root', 'root', 'child', 'goal', 'scope', 'done', 'authority', '{}', 'in_progress', 7, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
      ('work-sibling', 'delegated', 2, 'root', 'root', 'sibling', 'goal', 'scope', 'done', 'authority', '{}', 'pending', 2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`);
  db.exec(`INSERT INTO session_executions_v6 (id, session_id, operation, state, request_json, created_at, updated_at)
    VALUES ('run', 'child', 'turn.run', 'running', '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
      ('queue', 'child', 'turn.enqueue', 'queued', '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
      ('sibling-run', 'sibling', 'turn.run', 'running', '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`);
  db.exec(`INSERT INTO session_authority_grants_v6 (grant_id, root_session_id, issuer_kind, issuer_id, issuer_grant_id, issuer_grant_revision, grantee_session_id, actions_json, resource_kind, relation_selector, target_session_roles_json, effect_class, delegable, child_ceiling_json, issued_at, effective_at, expires_at, revoked_at, revision, mapping_revision, provenance_json)
    VALUES ('grant-parent', 'root', 'system', 'root', NULL, NULL, 'root', '[]', 'session', 'self', '[]', 'read', 1, '[]', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL, NULL, 4, 1, '{}'),
      ('grant-child', 'root', 'system', 'root', 'grant-parent', 4, 'child', '[]', 'session', 'self', '[]', 'read', 0, '[]', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL, NULL, 5, 1, '{}'),
      ('grant-revoked-descendant', 'root', 'system', 'root', 'grant-child', 5, 'child', '[]', 'session', 'self', '[]', 'read', 0, '[]', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL, CURRENT_TIMESTAMP, 6, 1, '{}'),
      ('grant-sibling', 'root', 'system', 'root', 'grant-parent', 4, 'sibling', '[]', 'session', 'self', '[]', 'read', 0, '[]', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL, NULL, 1, 1, '{}')`);
  db.exec("INSERT INTO session_authority_grant_events_v6 (event_id, grant_id, event_kind, grant_revision, principal_kind, payload_json, occurred_at) VALUES ('grant-event', 'grant-child', 'baseline_issued', 5, 'system', '{}', CURRENT_TIMESTAMP), ('grant-revoked-event', 'grant-revoked-descendant', 'revoked', 6, 'system', '{}', CURRENT_TIMESTAMP)");
  db.exec(`INSERT INTO resource_budget_accounts_v6 (account_id, account_kind, root_session_id, owner_session_id, parent_account_id, deadline_at, retry_per_execution_limit, revision, created_at, updated_at)
    VALUES ('account-root', 'root', 'root', 'root', NULL, CURRENT_TIMESTAMP, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
      ('account-child', 'session', 'root', 'child', 'account-root', CURRENT_TIMESTAMP, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`);
  db.exec("INSERT INTO resource_budget_dimensions_v6 (account_id, dimension, hard_limit, committed, reserved) VALUES ('account-child', 'queuedTurns', 10, 0, 1), ('account-root', 'storageBytes', 10, 0, 1)");
  db.exec("INSERT INTO resource_budget_reservations_v6 (reservation_id, account_id, dimension, amount, state, reservation_kind, execution_id, idempotency_key, created_at, updated_at) VALUES ('reservation-child', 'account-child', 'queuedTurns', 1, 'reserved', 'queued_turn', 'queue', 'key', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)");
  db.exec("INSERT INTO resource_budget_reservations_v6 (reservation_id, account_id, dimension, amount, state, reservation_kind, idempotency_key, created_at, updated_at) VALUES ('reservation-root-storage', 'account-root', 'storageBytes', 1, 'reconciliation_required', 'storage', 'storage-key', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)");
  db.exec("INSERT INTO resource_budget_events_v6 (event_id, account_id, account_revision, event_kind, principal_kind, operation_id, payload_json, projection_json, occurred_at) VALUES ('budget-event', 'account-child', 1, 'reserved', 'system', 'op', '{}', '{}', CURRENT_TIMESTAMP)");
  db.exec("INSERT INTO resource_budget_metered_usage_v6 (usage_id, account_id, execution_id, usage_unit, amount, confidence, idempotency_key, observed_at) VALUES ('usage-child-sibling', 'account-child', 'sibling-run', 'tokens', 12, 'reported', 'usage-sibling', CURRENT_TIMESTAMP)");
  db.exec("INSERT INTO resource_budget_metered_usage_v6 (usage_id, account_id, execution_id, usage_unit, amount, confidence, idempotency_key, observed_at) VALUES ('usage-root-sibling', 'account-root', 'sibling-run', 'tokens', 99, 'reported', 'usage-root-sibling', CURRENT_TIMESTAMP)");
  db.exec("INSERT INTO session_messages_v6 (session_id, seq, role, body, artifact_body, created_at) VALUES ('child', 0, 'assistant', 'body', '{\"title\":\"artifact\"}', CURRENT_TIMESTAMP)");
  db.exec("INSERT INTO session_interactions_v6 (id, execution_id, kind, state, public_payload_json, created_at, updated_at) VALUES ('interaction-child', 'run', 'approval', 'pending', '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)");
  db.exec("INSERT INTO coordination_events_v6 (id, actor_session_id, creation_principal_kind, session_role, role_contract_revision, root_session_id, parent_session_id, delegation_depth, kind, summary, payload_json, options_json, created_at) VALUES ('event-child', 'child', 'system', 'executor', 1, 'root', 'root', 1, 'blocker', 'blocked', '{}', '[]', CURRENT_TIMESTAMP), ('event-sibling', 'sibling', 'system', 'executor', 1, 'root', 'root', 1, 'blocker', 'blocked', '{}', '[]', CURRENT_TIMESTAMP)");
  db.exec("INSERT INTO resource_event_headers_v6 (event_id, resource_kind, resource_id, root_id, owner_kind, owner_id, event_kind, principal_kind, operation_id, occurred_at, committed_at, payload_schema_revision, effect) VALUES ('header', 'execution', 'run', 'root', 'session', 'child', 'started', 'system', 'op', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1, 'committed')");
  db.exec("INSERT INTO resource_event_headers_v6 (event_id, resource_kind, resource_id, root_id, owner_kind, owner_id, event_kind, resource_revision, principal_kind, operation_id, occurred_at, committed_at, payload_schema_revision, effect) VALUES ('header-work', 'work_item', 'work-child', 'root', 'session', 'child', 'created', 7, 'system', 'op-work', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1, 'committed'), ('header-sibling-work', 'work_item', 'work-sibling', 'root', 'session', 'sibling', 'created', 2, 'system', 'op-sibling-work', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1, 'committed'), ('header-2', 'execution', 'run', 'root', 'session', 'child', 'updated', 2, 'system', 'op-2', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1, 'committed')");
  db.exec(`INSERT INTO resource_event_headers_v6 (event_id, resource_kind, resource_id, root_id, owner_kind, owner_id, event_kind, resource_revision, principal_kind, operation_id, occurred_at, committed_at, payload_schema_revision, effect) VALUES
    ('budget-event', 'budget', 'account-child', 'root', 'session', 'child', 'reserved', 1, 'system', 'op', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1, 'committed'),
    ('file-header', 'session_files', 'file-operation', 'root', 'session', 'child', 'applied', 2, 'system', 'file-operation', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1, 'committed'),
    ('transcript-header', 'transcript', 'export-operation', 'root', 'session', 'child', 'applied', 2, 'system', 'export-operation', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1, 'committed')`);
  const manifest = buildSessionLifecycleManifest(db, "child", "root");
  assert.equal(manifest.destinationRootSessionId, "root");
  assert.equal(manifest.sessionId, "child");
  assert.deepEqual(manifest.descendants, []);
  assert.deepEqual(manifest.workItems, [{ workItemId: "work-child", state: "in_progress", revision: 7, parentWorkItemId: null }]);
  assert.deepEqual(manifest.executions, { running: 1, queued: 1 });
  assert.deepEqual(manifest.grants, [{ id: "grant-child", revision: 5, state: "active" }]);
  assert.equal(manifest.grantChains.length, 3);
  assert.deepEqual(manifest.grantChains.map(({ id }) => id), ["grant-child", "grant-parent", "grant-revoked-descendant"]);
  assert.equal(manifest.grantChains.find(({ id }) => id === "grant-parent")?.issuerGrantId, null);
  assert.equal(manifest.grantChains.find(({ id }) => id === "grant-revoked-descendant")?.revokedAt !== null, true);
  assert.deepEqual(manifest.budgetReservations, [{ id: "reservation-child", state: "reserved" }, { id: "reservation-root-storage", state: "reconciliation_required" }]);
  assert.deepEqual(manifest.budgetAccounts.map((account) => account.id), ["account-child", "account-root"]);
  assert.deepEqual(manifest.budgetUsage, [{ id: "usage-child-sibling", accountId: "account-child", executionId: "sibling-run", amount: 12, unit: "tokens", confidence: "reported" }]);
  assert.deepEqual(manifest.artifacts, [{ id: "1", ownerSessionId: "child" }]);
  assert.equal(manifest.openInteractions, 1);
  assert.equal(manifest.openCoordinationEvents, 1);
  assert.deepEqual(manifest.interactionIds, ["interaction-child"]);
  assert.deepEqual(manifest.coordinationEventIds, ["event-child"]);
  assert.deepEqual(manifest.resourceHistory, [
    { resourceKind: "budget", resourceId: "account-child", eventCount: 1, latestRevision: 1 },
    { resourceKind: "execution", resourceId: "run", eventCount: 2, latestRevision: 2 },
    { resourceKind: "session_files", resourceId: "file-operation", eventCount: 1, latestRevision: 2 },
    { resourceKind: "transcript", resourceId: "export-operation", eventCount: 1, latestRevision: 2 },
    { resourceKind: "work_item", resourceId: "work-child", eventCount: 1, latestRevision: 7 },
  ]);
  assert.deepEqual([...manifest.blockers].sort(), [
    "budget_reservations_present",
    "open_coordination_events",
    "open_interactions",
    "queued_executions",
    "running_executions",
    "work_items_present",
  ]);
  const deletion = buildSessionLifecycleManifest(db, "child");
  parseSessionRuntimeResultEnvelope("session.move.manifest", {
    schemaVersion: SESSION_RUNTIME_RESULT_SCHEMA_VERSION, operation: "session.move.manifest", result: manifest,
  });
  parseSessionRuntimeResultEnvelope("session.delete.manifest", {
    schemaVersion: SESSION_RUNTIME_RESULT_SCHEMA_VERSION, operation: "session.delete.manifest", result: deletion,
  });
  assert.equal("deletable" in deletion && deletion.deletable, false);
  assert.ok(deletion.blockers.includes("work_items_present"));
  assert.ok(deletion.blockers.includes("budget_reservations_present"));
  db.exec("INSERT INTO resource_event_headers_v6 (event_id, resource_kind, resource_id, root_id, owner_kind, owner_id, event_kind, resource_revision, principal_kind, operation_id, occurred_at, committed_at, payload_schema_revision, effect) VALUES ('header-3', 'execution', 'run', 'root', 'session', 'child', 'updated', 3, 'system', 'op-3', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1, 'committed')");
  const changedReference = buildSessionLifecycleManifest(db, "child", "root");
  assert.ok(changedReference.manifestRevision > manifest.manifestRevision);
  db.prepare("UPDATE resource_budget_reservations_v6 SET state = 'consumed' WHERE reservation_id = 'reservation-child'").run();
  db.exec("INSERT INTO resource_budget_events_v6 (event_id, account_id, account_revision, event_kind, principal_kind, operation_id, payload_json, projection_json, occurred_at) VALUES ('budget-event-2', 'account-child', 2, 'consumed', 'system', 'op-2', '{}', '{}', CURRENT_TIMESTAMP)");
  const changedReservation = buildSessionLifecycleManifest(db, "child", "root");
  assert.ok(changedReservation.manifestRevision > changedReference.manifestRevision);
  db.exec("INSERT INTO resource_event_headers_v6 (event_id, resource_kind, resource_id, root_id, owner_kind, owner_id, event_kind, principal_kind, operation_id, occurred_at, committed_at, payload_schema_revision, effect) VALUES ('header-sibling', 'execution', 'sibling-run', 'root', 'session', 'sibling', 'updated', 'system', 'op-sibling', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1, 'committed')");
  const changedSibling = buildSessionLifecycleManifest(db, "child", "root");
  assert.ok(changedSibling.manifestRevision > changedReservation.manifestRevision);
  db.close();
});
