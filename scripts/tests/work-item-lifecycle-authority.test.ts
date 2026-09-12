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

  function issue(dbPath: string, relationSelector: "created" | "assigned", roles: readonly ("task-coordinator" | "executor")[], operation: keyof typeof SESSION_AUTHORITY_OPERATION_DEFINITIONS = "work.move", granteeSessionId = "task") {
    const db = new DatabaseSync(dbPath);
    try {
      return issueTrustedWorkItemLifecycleCapability(db, { rootSessionId: "root", granteeSessionId, actions: [operation], relationSelector, targetSessionRoles: roles, principal: { kind: "system", service: "work-item-lifecycle-authority-test" }, proof: trustedProof(operation), expiresAt: null, issuedAt: NOW })[0]!;
    } finally { db.close(); }
  }

  // @test-value v2
  // kind = "security"
  // claim = "Work Item move authorization requires independent source and destination grants, and a revoked destination grant is rejected"
  // fault = "one lifecycle grant is reused for both sides of a move, or a revoked destination grant remains usable"
  // observable = "SessionAuthorityService authorization result and SessionAuthorityError、WorkItemService move admission/errorと拒否前後のprojection/history"
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
    const sourceProof = authority!.authorize(agentBinding("task"), "work.move", sourceInput).proof;
    assert.throws(() => authority!.authorize(agentBinding("task"), "work.move", destinationInput), SessionAuthorityError);
    issue(dbPath, "assigned", ["task-coordinator"]);
    const destinationProof = authority!.authorize(agentBinding("task"), "work.move", destinationInput).proof;
    assert.notEqual(destinationProof.grantId, null);
    assert.notEqual(sourceProof.grantId, destinationProof.grantId);
    const moved = service!.move({ workItemId: source.id, destinationParentWorkItemId: destination.id, expectedRevision: source.revision, expectedAggregateRevision: 0, expectedDestinationAggregateRevision: 0, idempotencyKey: "service-move" }, agentBinding("task"), sourceProof, [destinationProof]);
    assert.equal(moved.parentWorkItemId, destination.id);
    issue(dbPath, "created", ["executor"], "work.revise");
    issue(dbPath, "created", ["executor"], "work.history.list");
    const revised = service!.revise({ workItemId: moved.id, goal: "revised", scope: moved.scope, completionCriteria: moved.completionCriteria, authority: moved.authority, expectedRevision: moved.revision, idempotencyKey: "service-revise" }, agentBinding("task"), authority!.authorize(agentBinding("task"), "work.revise", sourceInput).proof);
    assert.equal(revised.goal, "revised");
    assert.ok(service!.listHistory({ workItemId: moved.id, limit: 20, afterSequence: null }, agentBinding("task"), authority!.authorize(agentBinding("task"), "work.history.list", sourceInput).proof).length >= 3);
    const secondSource = create("source-after-move", "task", "executor");
    const secondSourceBefore = storage!.get(secondSource.id)!;
    const secondSourceEventsBefore = storage!.listHistory({ workItemId: secondSource.id, limit: 20, afterSequence: null });
    assert.throws(() => service!.move({ workItemId: secondSource.id, destinationParentWorkItemId: destination.id, expectedRevision: secondSource.revision, expectedAggregateRevision: 0, expectedDestinationAggregateRevision: 1, idempotencyKey: "wrong-destination-proof" }, agentBinding("task"), authority!.authorize(agentBinding("task"), "work.move", { workItemId: secondSource.id }).proof, [sourceProof]), Error);
    assert.deepEqual(storage!.get(secondSource.id), secondSourceBefore);
    assert.deepEqual(storage!.listHistory({ workItemId: secondSource.id, limit: 20, afterSequence: null }), secondSourceEventsBefore);
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
    issue(dbPath, "created", ["executor"]);
    issue(dbPath, "assigned", ["task-coordinator"]);
    const before = (() => { const db = new DatabaseSync(dbPath); try { return { grants: db.prepare("SELECT * FROM session_authority_grants_v6 ORDER BY grant_id").all(), events: db.prepare("SELECT * FROM session_authority_grant_events_v6 ORDER BY grant_id, grant_revision, event_id").all() }; } finally { db.close(); } })();
    authority!.close();
    authority = new SessionAuthorityService({ databasePath: dbPath, getExecutionGeneration: () => "generation-1", now: () => new Date(NOW) });
    assert.doesNotThrow(() => authority!.authorize(agentBinding("task"), "work.move", { workItemId: source.id }));
    assert.doesNotThrow(() => authority!.authorize(agentBinding("task"), "work.move", { workItemId: destination.id }));
    const after = (() => { const db = new DatabaseSync(dbPath); try { return { grants: db.prepare("SELECT * FROM session_authority_grants_v6 ORDER BY grant_id").all(), events: db.prepare("SELECT * FROM session_authority_grant_events_v6 ORDER BY grant_id, grant_revision, event_id").all() }; } finally { db.close(); } })();
    assert.deepEqual(after, before);
  });

  // @test-value v2
  // kind = "security"
  // claim = "trusted lifecycle capabilityだけが明示的にresult/aggregation correctionを付与し、revoke後は実serviceで拒否される"
  // fault = "correction operationをbaselineへ暗黙追加する、trusted issuanceから欠落する、またはrevoke済みgrantを使える"
  // observable = "SessionAuthorityService authorizeとWorkItemService correctionの成功/拒否"
  // observation_boundary = "public-boundary"
  // oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/05-grants-routing-and-transfer.md" }
  // scope = "trusted correction capability issuance and revocation"
  // lifecycle = "permanent"
  // distinction = "baseline permission set remains unchanged while explicit trusted grants gate both correction services"
  // @end-test-value
  it("trusted correction capabilityを明示発行しrevoke後はserviceを拒否する", async () => {
    const { dbPath, source, destination } = await fixture();
    const result = {
      outcome: "completed" as const,
      summary: "original",
      changes: [], verificationResults: [], findings: [], unverifiedItems: [], remainingWork: [],
      reportingSessionId: "executor", reportedAt: NOW,
    };
    const running = storage!.mutate({ operation: "work.transition", workItemId: source.id, principalSessionId: "executor", idempotencyKey: "correction-start", requestFingerprint: "correction-start-fp", expectedRevision: source.revision, state: "in_progress", result: null, updatedAt: NOW, expiresAt: "2026-09-14T12:00:00.000Z", proof: trustedProof("work.transition") });
    const terminal = storage!.mutate({ operation: "work.result", workItemId: source.id, principalSessionId: "executor", idempotencyKey: "correction-result", requestFingerprint: "correction-result-fp", expectedRevision: running.revision, expectedAggregateRevision: storage!.getAggregationSummary(source.id).aggregateRevision, state: "completed", result, updatedAt: NOW, expiresAt: "2026-09-14T12:00:00.000Z", proof: trustedProof("work.result") });
    const correctionInput = { workItemId: source.id, expectedRevision: terminal.revision, expectedResultRevision: 1, correctionReason: "verified", result: { ...result, summary: "corrected" }, idempotencyKey: "service-correction" };
    assert.throws(() => authority!.authorize(agentBinding("executor"), "work.result.correct", correctionInput), SessionAuthorityError);
    issue(dbPath, "assigned", ["executor"], "work.result.correct", "executor");
    const resultProof = authority!.authorize(agentBinding("executor"), "work.result.correct", correctionInput).proof;
    const corrected = service!.correctResult(correctionInput, agentBinding("executor"), resultProof);
    assert.equal(corrected.resultRevision, 2);
    assert.equal(corrected.supersededResultRevision, 1);
    assert.equal(corrected.workItem.result?.summary, "corrected");
    const db = new DatabaseSync(dbPath);
    let grantId: string;
    try {
      const row = db.prepare("SELECT grant_id, revision FROM session_authority_grants_v6 WHERE grantee_session_id = 'executor' AND json_extract(actions_json, '$[0]') = 'work.result.correct'").get() as { grant_id: string; revision: number };
      grantId = row.grant_id;
      revokeSessionAuthorityGrant(db, { grantId, expectedRevision: row.revision, principal: { kind: "system", service: "work-item-lifecycle-authority-test" }, revokedAt: NOW });
    } finally { db.close(); }
    assert.throws(() => authority!.authorize(agentBinding("executor"), "work.result.correct", { ...correctionInput, idempotencyKey: "service-correction-after-revoke" }), SessionAuthorityError);
    assert.throws(() => service!.correctResult({ ...correctionInput, expectedRevision: corrected.workItem.revision, expectedResultRevision: corrected.resultRevision, correctionReason: "revoked proof", idempotencyKey: "service-correction-after-revoke" }, agentBinding("executor"), resultProof), SessionAuthorityError);

    const dbForChild = new DatabaseSync(dbPath);
    let expectedContainerRevision: number;
    try { expectedContainerRevision = Number((dbForChild.prepare("SELECT resource_revision FROM sessions_v6 WHERE id = 'executor'").get() as { resource_revision: number }).resource_revision); } finally { dbForChild.close(); }
    const child = storage!.create({ id: "correction-child", binding: { kind: "delegated", rootSessionId: "root", creatorSessionId: "task", targetSessionId: "executor", parentWorkItemId: destination.id, goal: "child", scope: "scope", completionCriteria: "done", authority: "authority", sourceIdentity: SOURCE }, principalSessionId: "root", idempotencyKey: "create-correction-child", requestFingerprint: "create-correction-child-fp", expectedContainerRevision, createdAt: NOW, expiresAt: "2026-09-14T12:00:00.000Z", proof: trustedProof("work.create") });
    const childRunning = storage!.mutate({ operation: "work.transition", workItemId: child.id, principalSessionId: "executor", idempotencyKey: "child-start", requestFingerprint: "child-start-fp", expectedRevision: child.revision, state: "in_progress", result: null, updatedAt: NOW, expiresAt: "2026-09-14T12:00:00.000Z", proof: trustedProof("work.transition") });
    storage!.mutate({ operation: "work.result", workItemId: child.id, principalSessionId: "executor", idempotencyKey: "child-result", requestFingerprint: "child-result-fp", expectedRevision: childRunning.revision, state: "completed", result, updatedAt: NOW, expiresAt: "2026-09-14T12:00:00.000Z", proof: trustedProof("work.result") });
    const aggregateRevision = storage!.getAggregationSummary(destination.id).aggregateRevision;
    storage!.decideAggregation({ parentWorkItemId: destination.id, childWorkItemId: child.id, actorSessionId: "task", decision: "accepted", reason: null, expectedAggregateRevision: aggregateRevision, idempotencyKey: "child-decision", requestFingerprint: "child-decision-fp", decidedAt: NOW, expiresAt: "2026-09-14T12:00:00.000Z", proof: trustedProof("work.aggregation.decide") });
    const aggregationInput = { parentWorkItemId: destination.id, childWorkItemId: child.id, expectedAggregateRevision: aggregateRevision + 1, expectedChildResultRevision: 1, correction: { kind: "revise" as const, decision: "accepted" as const, reason: "reconfirmed" }, idempotencyKey: "service-aggregation-correction" };
    assert.throws(() => authority!.authorize(agentBinding("task"), "work.aggregation.correct", aggregationInput), SessionAuthorityError);
    issue(dbPath, "assigned", ["task-coordinator"], "work.aggregation.correct", "task");
    const aggregationProof = authority!.authorize(agentBinding("task"), "work.aggregation.correct", aggregationInput).proof;
    const aggregationCorrection = service!.correctAggregation(aggregationInput, agentBinding("task"), aggregationProof);
    assert.equal(aggregationCorrection.aggregateRevision, storage!.getAggregationSummary(destination.id).aggregateRevision);
    assert.equal(aggregationCorrection.decision?.decision, "accepted");
    assert.equal(aggregationCorrection.decision?.reason, "reconfirmed");
    assert.equal(aggregationCorrection.supersededDecisionRevision, 2);
  });
});
