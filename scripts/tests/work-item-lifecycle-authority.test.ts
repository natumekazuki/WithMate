import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";

import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import { SESSION_AUTHORITY_MAPPING_REVISION, SESSION_AUTHORITY_OPERATION_DEFINITIONS, SessionAuthorityError, type MutationAuthorityProof } from "../../src/session-authority.js";
import { buildChildSessionRoleBinding } from "../../src/session-role-binding.js";
import { buildNewSession, type Session } from "../../src/session-state.js";
import type { ResolvedAgentRuntimeBinding } from "../../src-electron/agent-runtime-binding.js";
import { createOrVerifyV6FreshDatabase } from "../../src-electron/app-database-v6-bootstrap.js";
import { SessionAuthorityService } from "../../src-electron/session-authority-service.js";
import { issueTrustedWorkItemLifecycleCapability, backfillBaselineSessionAuthority, revokeSessionAuthorityGrant } from "../../src-electron/session-authority-storage.js";
import { SessionStorageV6 } from "../../src-electron/session-storage-v6.js";
import { WorkItemStorageV6 } from "../../src-electron/work-item-storage-v6.js";
import { WorkItemService } from "../../src-electron/work-item-service.js";

const NOW = "2026-09-13T12:00:00.000Z";
const SOURCE = { workspace: "C:/workspace", repository: "WithMate", branch: "main", base: "base", head: "head" };

function root(id: string): Session {
  return { ...buildNewSession({ id, taskTitle: id, workspaceLabel: "workspace", workspacePath: "C:/workspace", branch: "main", characterId: "character-a", character: "A", characterIconPath: "", characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" }, approvalMode: DEFAULT_APPROVAL_MODE, rootSessionRole: "overall-coordinator" }), updatedAt: NOW };
}

function child(id: string, parent: Session, role: "task-coordinator" | "executor"): Session {
  return { ...buildNewSession({ id, taskTitle: id, workspaceLabel: "workspace", workspacePath: "C:/workspace", branch: "main", characterId: "character-a", character: "A", characterIconPath: "", characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" }, approvalMode: DEFAULT_APPROVAL_MODE, roleBinding: buildChildSessionRoleBinding(id, parent.id, parent.roleBinding!, role) }), updatedAt: NOW };
}

function trustedProof(operation: keyof typeof SESSION_AUTHORITY_OPERATION_DEFINITIONS, rootSessionId = "root"): MutationAuthorityProof {
  const definition = SESSION_AUTHORITY_OPERATION_DEFINITIONS[operation];
  return { principal: { kind: "system", service: "work-item-lifecycle-authority-test" }, providerId: null, operation, mappingRevision: SESSION_AUTHORITY_MAPPING_REVISION, action: definition.action, resolvedScope: { resourceKind: definition.resourceKind, resourceId: rootSessionId, rootSessionId, ownerKind: "session", ownerId: rootSessionId, relation: "self" }, effectClass: definition.effectClass, grantId: null, grantRevision: null, evaluatedAt: NOW };
}

function agentBinding(sessionId: string): ResolvedAgentRuntimeBinding {
  return { bindingId: `binding-${sessionId}`, bindingIdHash: `binding-hash-${sessionId}`, actorSessionId: sessionId, providerId: "codex", executionGeneration: "generation-1", authoritySnapshot: {}, operationGrants: ["session.runtime.invoke"], createdAt: NOW, expiresAt: null };
}

describe("Work Item lifecycle authority capability", () => {
  let directory: string | undefined;
  let storage: WorkItemStorageV6 | undefined;
  let authority: SessionAuthorityService | undefined;
  let service: WorkItemService | undefined;

  afterEach(async () => {
    authority?.close();
    service = undefined;
    storage?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
    authority = undefined;
    storage = undefined;
    directory = undefined;
  });

  async function fixture() {
    directory = await mkdtemp(path.join(os.tmpdir(), "withmate-work-item-authority-"));
    const { dbPath } = await createOrVerifyV6FreshDatabase(directory);
    const sessions = new SessionStorageV6(dbPath);
    const rootSession = root("root");
    const task = child("task", rootSession, "task-coordinator");
    const executor = child("executor", task, "executor");
    sessions.insertSession(rootSession);
    sessions.insertSession(task);
    sessions.insertSession(executor);
    sessions.close();
    const db = new DatabaseSync(dbPath);
    backfillBaselineSessionAuthority(db, NOW);
    db.close();
    storage = new WorkItemStorageV6(dbPath);
    const create = (id: string, creatorSessionId: string, targetSessionId: string) => {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      let expectedContainerRevision: number;
      try { expectedContainerRevision = Number((db.prepare("SELECT resource_revision FROM sessions_v6 WHERE id = ?").get(targetSessionId) as { resource_revision: number }).resource_revision); } finally { db.close(); }
      return storage!.create({ id, binding: { kind: "delegated", rootSessionId: "root", creatorSessionId, targetSessionId, parentWorkItemId: null, goal: id, scope: "scope", completionCriteria: "done", authority: "authority", sourceIdentity: SOURCE }, principalSessionId: "root", idempotencyKey: `create-${id}`, requestFingerprint: `create-${id}-fp`, expectedContainerRevision, createdAt: NOW, expiresAt: "2026-09-14T12:00:00.000Z", proof: trustedProof("work.create") });
    };
    const source = create("source", "task", "executor");
    const destination = create("destination", "root", "task");
    service = new WorkItemService({
      storage,
      getTurnAuthoritySession(sessionId) {
        const db = new DatabaseSync(dbPath, { readOnly: true });
        try {
          const row = db.prepare("SELECT session.id AS session_id, session.title, role.* FROM sessions_v6 AS session INNER JOIN session_role_bindings_v6 AS role ON role.session_id = session.id WHERE session.id = ?").get(sessionId) as Record<string, unknown> | undefined;
          return row ? { sessionId: row.session_id, title: row.title, sessionRole: row.session_role, roleContractRevision: row.role_contract_revision, rootSessionId: row.root_session_id, parentSessionId: row.parent_session_id, delegationDepth: row.delegation_depth } as never : null;
        } finally { db.close(); }
      },
      createWorkItemId: () => `service-${Date.now()}`,
      currentTimestamp: () => NOW,
    });
    authority = new SessionAuthorityService({ databasePath: dbPath, getExecutionGeneration: () => "generation-1", now: () => new Date(NOW) });
    return { dbPath, source, destination, create };
  }

  function issue(dbPath: string, relationSelector: "created" | "assigned", roles: readonly ("task-coordinator" | "executor")[], operation: keyof typeof SESSION_AUTHORITY_OPERATION_DEFINITIONS = "work.move") {
    const db = new DatabaseSync(dbPath);
    try {
      return issueTrustedWorkItemLifecycleCapability(db, { rootSessionId: "root", granteeSessionId: "task", actions: [operation], relationSelector, targetSessionRoles: roles, principal: { kind: "system", service: "work-item-lifecycle-authority-test" }, proof: trustedProof(operation), expiresAt: null, issuedAt: NOW })[0]!;
    } finally { db.close(); }
  }

  // @test-value v2
  // kind = "security"
  // claim = "Work Item move authorization requires independent source and destination grants, and a revoked destination grant is rejected"
  // fault = "one lifecycle grant is reused for both sides of a move, or a revoked destination grant remains usable"
  // observable = "SessionAuthorityService authorization result and SessionAuthorityError"
  // observation_boundary = "public-boundary"
  // oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/02-work-item-lifecycle.md" }
  // scope = "trusted Work Item lifecycle capability and move admission"
  // lifecycle = "permanent"
  // distinction = "source creator scope and destination assigned scope are separate persisted grants"
  // @end-test-value
  it("source/destination grantsを独立に要求し、revoke後も拒否する", async () => {
    const { dbPath, source, destination, create } = await fixture();
    const sourceInput = { workItemId: source.id };
    const destinationInput = { workItemId: destination.id };
    assert.throws(() => authority!.authorize(agentBinding("task"), "work.move", sourceInput), SessionAuthorityError);
    issue(dbPath, "created", ["executor"]);
    assert.doesNotThrow(() => authority!.authorize(agentBinding("task"), "work.move", sourceInput));
    assert.throws(() => authority!.authorize(agentBinding("task"), "work.move", destinationInput), SessionAuthorityError);
    issue(dbPath, "assigned", ["task-coordinator"]);
    const destinationProof = authority!.authorize(agentBinding("task"), "work.move", destinationInput).proof;
    assert.notEqual(destinationProof.grantId, null);
    const moved = service!.move({ workItemId: source.id, destinationParentWorkItemId: destination.id, expectedRevision: source.revision, expectedAggregateRevision: 0, expectedDestinationAggregateRevision: 0, idempotencyKey: "service-move" }, agentBinding("task"), authority!.authorize(agentBinding("task"), "work.move", sourceInput).proof, [destinationProof]);
    assert.equal(moved.parentWorkItemId, destination.id);
    issue(dbPath, "created", ["executor"], "work.revise");
    issue(dbPath, "created", ["executor"], "work.history.list");
    const revised = service!.revise({ workItemId: moved.id, goal: "revised", scope: moved.scope, completionCriteria: moved.completionCriteria, authority: moved.authority, expectedRevision: moved.revision, idempotencyKey: "service-revise" }, agentBinding("task"), authority!.authorize(agentBinding("task"), "work.revise", sourceInput).proof);
    assert.equal(revised.goal, "revised");
    assert.ok(service!.listHistory({ workItemId: moved.id, limit: 20, afterSequence: null }, agentBinding("task"), authority!.authorize(agentBinding("task"), "work.history.list", sourceInput).proof).length >= 3);
    const secondSource = create("source-after-move", "task", "executor");
    const secondSourceBefore = storage!.get(secondSource.id)!;
    const secondSourceEventsBefore = storage!.listHistory({ workItemId: secondSource.id, limit: 20, afterSequence: null });
    const db = new DatabaseSync(dbPath);
    try {
      const row = db.prepare("SELECT revision FROM session_authority_grants_v6 WHERE grant_id = ?").get(destinationProof.grantId) as { revision: number };
      revokeSessionAuthorityGrant(db, { grantId: destinationProof.grantId, expectedRevision: row.revision, principal: { kind: "system", service: "work-item-lifecycle-authority-test" }, revokedAt: NOW });
    } finally { db.close(); }
    assert.throws(() => service!.move({ workItemId: secondSource.id, destinationParentWorkItemId: destination.id, expectedRevision: secondSource.revision, expectedAggregateRevision: 0, expectedDestinationAggregateRevision: 1, idempotencyKey: "revoked-move" }, agentBinding("task"), authority!.authorize(agentBinding("task"), "work.move", { workItemId: secondSource.id }).proof, [destinationProof]), SessionAuthorityError);
    assert.deepEqual(storage!.get(secondSource.id), secondSourceBefore);
    assert.deepEqual(storage!.listHistory({ workItemId: secondSource.id, limit: 20, afterSequence: null }), secondSourceEventsBefore);
    authority!.close();
    authority = new SessionAuthorityService({ databasePath: dbPath, getExecutionGeneration: () => "generation-1", now: () => new Date(NOW) });
    assert.throws(() => authority.authorize(agentBinding("task"), "work.move", destinationInput), SessionAuthorityError);
  });

  // @test-value v2
  // kind = "security"
  // claim = "Persisted lifecycle grants and their grant history survive authority service restart without baseline grant changes"
  // fault = "startup reissues lifecycle capability or loses its provenance/history, making a previously issued source and destination pair inconsistent"
  // observable = "grant rows, grant event rows, and post-restart authorization"
  // observation_boundary = "public-boundary"
  // oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/02-work-item-lifecycle.md" }
  // scope = "trusted Work Item lifecycle capability restart persistence"
  // lifecycle = "permanent"
  // distinction = "grant provenance is read after reopening the real authority service"
  // @end-test-value
  it("両側grantと履歴を再起動後も保持する", async () => {
    const { dbPath, source, destination } = await fixture();
    const sourceGrant = issue(dbPath, "created", ["executor"]);
    const destinationGrant = issue(dbPath, "assigned", ["task-coordinator"]);
    const before = (() => { const db = new DatabaseSync(dbPath); try { return { grants: db.prepare("SELECT grant_id, revision, provenance_json FROM session_authority_grants_v6 WHERE grant_id IN (?, ?) ORDER BY grant_id").all(sourceGrant.grantId, destinationGrant.grantId), events: db.prepare("SELECT grant_id, event_kind, grant_revision FROM session_authority_grant_events_v6 WHERE grant_id IN (?, ?) ORDER BY grant_id, grant_revision").all(sourceGrant.grantId, destinationGrant.grantId) }; } finally { db.close(); } })();
    authority!.close();
    authority = new SessionAuthorityService({ databasePath: dbPath, getExecutionGeneration: () => "generation-1", now: () => new Date(NOW) });
    assert.doesNotThrow(() => authority!.authorize(agentBinding("task"), "work.move", { workItemId: source.id }));
    assert.doesNotThrow(() => authority!.authorize(agentBinding("task"), "work.move", { workItemId: destination.id }));
    const after = (() => { const db = new DatabaseSync(dbPath); try { return { grants: db.prepare("SELECT grant_id, revision, provenance_json FROM session_authority_grants_v6 WHERE grant_id IN (?, ?) ORDER BY grant_id").all(sourceGrant.grantId, destinationGrant.grantId), events: db.prepare("SELECT grant_id, event_kind, grant_revision FROM session_authority_grant_events_v6 WHERE grant_id IN (?, ?) ORDER BY grant_id, grant_revision").all(sourceGrant.grantId, destinationGrant.grantId) }; } finally { db.close(); } })();
    assert.deepEqual(after, before);
  });
});
