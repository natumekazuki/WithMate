import type { DatabaseSync } from "node:sqlite";

import type { MutationAuthorityProof } from "../src/session-authority.js";
import { assertGrantProofCurrent, transferSessionAuthority } from "./session-authority-storage.js";
import { ResourceBudgetStorage } from "./resource-budget-storage.js";
import { appendSessionResourceEvent, getSessionResourceRevision } from "./resource-history-schema.js";
import { SessionCrudError } from "./session-crud-service.js";
import { requireChildSessionRoleAllowed, requireSessionRoleBinding, SessionRoleBindingError } from "../src/session-role-binding.js";

export type SessionMoveManifestEntry = Readonly<{ sessionId: string; revision: number }>;

export type SessionMoveInput = Readonly<{
  sessionId: string;
  expectedRevision: number;
  kind: "same_root" | "cross_root";
  destinationRootSessionId?: string;
  destinationParentSessionId: string | null;
  destinationExpectedRevision: number;
  transferManifestRevision?: number;
  transferPolicy?: "full";
  descendants?: readonly SessionMoveManifestEntry[];
  destinationProof?: MutationAuthorityProof;
}>;

export type SessionMoveResult = Readonly<{
  sessionId: string;
  sourceRootSessionId: string;
  destinationRootSessionId: string;
  affectedSessionIds: readonly string[];
  revisions: Readonly<Record<string, number>>;
}>;

type BindingRow = {
  session_id: string;
  session_role: "standalone" | "overall-coordinator" | "task-coordinator" | "executor";
  root_session_id: string;
  parent_session_id: string | null;
  delegation_depth: number;
};

function fail(message: string): never {
  throw new SessionCrudError("SESSION_STATE_CONFLICT", message);
}

function assertRevision(db: DatabaseSync, sessionId: string, expected: number): number {
  const revision = getSessionResourceRevision(db, sessionId);
  if (revision === null) fail(`Session was not found: ${sessionId}`);
  if (revision !== expected) fail(`The Session resource revision is stale: ${sessionId}.`);
  return revision;
}

function binding(db: DatabaseSync, sessionId: string): BindingRow {
  const row = db.prepare(`SELECT session_id, session_role, root_session_id, parent_session_id, delegation_depth
    FROM session_role_bindings_v6 WHERE session_id = ?`).get(sessionId) as BindingRow | undefined;
  if (!row) fail(`Session role binding was not found: ${sessionId}`);
  requireSessionRoleBinding(sessionId, {
    sessionRole: row.session_role,
    roleContractRevision: 1,
    rootSessionId: row.root_session_id,
    parentSessionId: row.parent_session_id,
    delegationDepth: row.delegation_depth,
  });
  return row;
}

function assertManifest(db: DatabaseSync, input: SessionMoveInput, sourceRoot: string): BindingRow[] {
  const descendants = input.descendants ?? [];
  const ids = [input.sessionId, ...descendants.map((item) => item.sessionId)];
  if (new Set(ids).size !== ids.length) fail("The move manifest contains duplicate Sessions.");
  const rows = ids.map((id, index) => {
    const row = binding(db, id);
    if (row.root_session_id !== sourceRoot) fail("The move manifest contains a Session outside the source root.");
    assertRevision(db, id, index === 0 ? input.expectedRevision : descendants[index - 1].revision);
    return row;
  });
  const actualChildren = (db.prepare(`SELECT session_id FROM session_role_bindings_v6
    WHERE root_session_id = ? ORDER BY session_id`).all(sourceRoot) as Array<{ session_id: string }>).map((row) => row.session_id);
  if (input.kind === "cross_root" && descendants.length > 0) {
    for (const id of actualChildren) {
      if (id !== input.sessionId && !ids.includes(id)) {
        const child = binding(db, id);
        if (ids.includes(child.parent_session_id ?? "")) fail("The move manifest omits a descendant Session.");
      }
    }
  }
  return rows;
}

function assertInactiveResources(db: DatabaseSync, sourceRoot: string, sessionIds: readonly string[]): void {
  const placeholders = sessionIds.map(() => "?").join(", ");
  const activeWork = db.prepare(`SELECT id FROM work_items_v6
    WHERE root_session_id = ? AND kind = 'delegated' AND state IN ('pending', 'in_progress', 'waiting')
      AND (creator_session_id IN (${placeholders}) OR target_session_id IN (${placeholders})) LIMIT 1`)
    .get(sourceRoot, ...sessionIds, ...sessionIds) as { id: string } | undefined;
  if (activeWork) fail(`An active Work Item prevents moving the Session subtree: ${activeWork.id}.`);
  const runningTurn = db.prepare(`SELECT 1 FROM session_turns_v6
    WHERE session_id IN (${placeholders}) AND phase IN ('queued', 'running') LIMIT 1`).get(...sessionIds);
  if (runningTurn) fail("A queued or running Session turn prevents moving the Session subtree.");
  const execution = db.prepare(`SELECT id FROM session_executions_v6
    WHERE session_id IN (${placeholders}) AND state IN ('running', 'queued') LIMIT 1`)
    .get(...sessionIds) as { id: string } | undefined;
  if (execution) fail(`An active Session execution prevents moving the Session subtree: ${execution.id}.`);
  const openCoordination = db.prepare(`SELECT event.id FROM coordination_events_v6 AS event
    WHERE (event.actor_session_id IN (${placeholders}) OR event.target_session_id IN (${placeholders}) OR event.parent_session_id IN (${placeholders}))
      AND event.kind IN ('escalation', 'user_decision_required', 'blocker')
      AND NOT EXISTS (
      SELECT 1 FROM coordination_event_actions_v6 AS action
      WHERE action.event_id = event.id AND action.action_type IN ('resolved', 'cancelled', 'superseded')
    ) LIMIT 1`).get(...sessionIds, ...sessionIds, ...sessionIds) as { id: string } | undefined;
  if (openCoordination) fail(`An open coordination event prevents moving the Session subtree: ${openCoordination.id}.`);
}

/**
 * Applies the relational part of a Session move inside the caller's transaction.
 * It intentionally does not BEGIN or COMMIT; lifecycle storage owns atomicity.
 */
export function applySessionMove(
  db: DatabaseSync,
  input: SessionMoveInput,
  proof: MutationAuthorityProof,
  now: string,
  operationId: string,
): SessionMoveResult {
  const source = binding(db, input.sessionId);
  const destinationRoot = input.kind === "cross_root"
    ? input.destinationRootSessionId ?? fail("Cross-root move requires a destination root.")
    : source.root_session_id;
  if (input.kind === "cross_root" && destinationRoot === source.root_session_id) fail("Cross-root move destination equals the source root.");
  if (input.kind === "cross_root" && input.transferPolicy !== "full") fail("Cross-root move requires the full transfer policy.");
  assertGrantProofCurrent(db, proof, new Date(now));
  if (input.destinationProof) assertGrantProofCurrent(db, input.destinationProof, new Date(now));
  const destinationRootBinding = binding(db, destinationRoot);
  if (destinationRootBinding.root_session_id !== destinationRoot || destinationRootBinding.parent_session_id !== null) {
    fail("The destination root must be an actual root Session.");
  }
  const rows = assertManifest(db, input, source.root_session_id);
  const ids = rows.map((row) => row.session_id);
  assertInactiveResources(db, source.root_session_id, ids);

  const parent = input.destinationParentSessionId === null ? null : binding(db, input.destinationParentSessionId);
  if (parent) {
    if (parent.session_id === input.sessionId || ids.includes(parent.session_id)) fail("The destination parent is inside the moved subtree.");
    if (parent.root_session_id !== destinationRoot) fail("The destination parent belongs to another root.");
    assertRevision(db, parent.session_id, input.destinationExpectedRevision);
    const active = db.prepare("SELECT 1 FROM sessions_v6 WHERE id = ? AND deleted_at IS NULL AND state <> 'archived'").get(parent.session_id);
    if (!active) fail("The destination parent Session is not active.");
  } else if (input.destinationExpectedRevision !== assertRevision(db, destinationRoot, input.destinationExpectedRevision)) {
    fail("The destination root revision is stale.");
  }
  if (!parent && (source.session_role === "task-coordinator" || source.session_role === "executor")) fail("A child Session cannot become an orphan.");
  if (source.session_role === "standalone" && (parent || destinationRoot !== input.sessionId)) fail("A standalone Session cannot become a child.");
  if (parent) {
    try {
      requireChildSessionRoleAllowed({
        sessionRole: parent.session_role,
        roleContractRevision: 1,
        rootSessionId: parent.root_session_id,
        parentSessionId: parent.parent_session_id,
        delegationDepth: parent.delegation_depth,
      }, source.session_role as "task-coordinator" | "executor");
    } catch (error) {
      if (error instanceof SessionRoleBindingError) fail(error.message);
      throw error;
    }
  }

  if (input.kind === "cross_root") {
    if (!input.destinationProof) fail("Cross-root move requires a destination authority proof.");
    if (proof.principal.kind !== "agent" || input.destinationProof.principal.kind !== "agent"
      || input.destinationProof.principal.actorSessionId !== proof.principal.actorSessionId) {
      fail("Source and destination authority proofs must belong to the same actor.");
    }
    if (input.destinationProof.grantId === null || input.destinationProof.grantRevision === null) {
      fail("Cross-root move requires a destination grant proof.");
    }
    if (input.destinationProof.grantId === proof.grantId && proof.principal.kind === "agent") fail("Cross-root move requires distinct source and destination grants.");
    const rootWork = input.sessionId === source.root_session_id ? db.prepare(`SELECT id FROM work_items_v6
      WHERE root_session_id = ? AND kind = 'root' AND state IN ('pending', 'in_progress', 'waiting') LIMIT 1`)
      .get(source.root_session_id) as { id: string } | undefined : undefined;
    if (rootWork) fail(`The source root Work Item prevents a cross-root move: ${rootWork.id}.`);
  }

  const revisions: Record<string, number> = {};
  const nextDepth = parent ? parent.delegation_depth + 1 : 0;
  for (const row of rows) {
    const depth = row.session_id === input.sessionId ? nextDepth : nextDepth + row.delegation_depth - source.delegation_depth;
    if (depth < 0 || depth > 2) fail("The moved Session subtree exceeds the delegation depth limit.");
    const nextRoot = destinationRoot;
    const nextParent = row.session_id === input.sessionId ? input.destinationParentSessionId : row.parent_session_id;
    const changed = db.prepare(`UPDATE session_role_bindings_v6
      SET root_session_id = ?, parent_session_id = ?, delegation_depth = ? WHERE session_id = ?`).run(nextRoot, nextParent, depth, row.session_id);
    if (changed.changes !== 1) fail(`Session role binding update failed: ${row.session_id}.`);
    const current = assertRevision(db, row.session_id, row.session_id === input.sessionId ? input.expectedRevision : (input.descendants ?? []).find((item) => item.sessionId === row.session_id)!.revision);
    const next = current + 1;
    db.prepare("UPDATE sessions_v6 SET resource_revision = ?, updated_at = ?, last_active_at = ? WHERE id = ? AND resource_revision = ?")
      .run(next, now, now, row.session_id, current);
    appendSessionResourceEvent(db, { sessionId: row.session_id, revision: next, eventKind: "move", proof, operationId, idempotencyKey: null, occurredAt: now,
      payload: { sourceRootSessionId: source.root_session_id, destinationRootSessionId: destinationRoot, destinationParentSessionId: input.destinationParentSessionId } });
    revisions[row.session_id] = next;
  }
  if (parent) {
    const current = assertRevision(db, parent.session_id, input.destinationExpectedRevision);
    const next = current + 1;
    db.prepare("UPDATE sessions_v6 SET resource_revision = ?, updated_at = ?, last_active_at = ? WHERE id = ? AND resource_revision = ?")
      .run(next, now, now, parent.session_id, current);
    appendSessionResourceEvent(db, { sessionId: parent.session_id, revision: next, eventKind: "move", proof,
      operationId, idempotencyKey: null, occurredAt: now,
      payload: { affectedSessionId: input.sessionId, destinationRootSessionId: destinationRoot, destinationParentSessionId: parent.session_id } });
    revisions[parent.session_id] = next;
  }

  if (input.kind === "cross_root") {
    const destinationGrantId = input.destinationProof!.grantId as string;
    const destinationGrantRevision = input.destinationProof!.grantRevision as number;
    for (const id of ids) {
      transferSessionAuthority(db, { sessionId: id, sourceRootSessionId: source.root_session_id, destinationRootSessionId: destinationRoot,
        destinationIssuerGrantId: destinationGrantId, destinationIssuerGrantRevision: destinationGrantRevision, operationId, transferredAt: now });
    }
  }
  const budget = new ResourceBudgetStorage(db);
  for (const row of rows) {
    const targetParent = row.session_id === input.sessionId ? input.destinationParentSessionId : row.parent_session_id;
    if (!targetParent) continue;
    if (row.root_session_id !== destinationRoot || row.session_id === input.sessionId) {
      const destinationBinding = binding(db, targetParent);
      const destinationGrant = input.destinationProof ?? proof;
      const hasAllocation = db.prepare("SELECT 1 FROM resource_budget_accounts_v6 WHERE owner_session_id = ? AND account_kind = 'session'")
        .get(row.session_id);
      if (!hasAllocation) {
        void destinationBinding;
        continue;
      }
      budget.transferSessionAllocation({ sessionId: row.session_id, destinationRootSessionId: destinationRoot,
        destinationParentAccountId: targetParent, destinationAuthorityGrantId: destinationGrant.grantId,
        destinationAuthorityGrantRevision: destinationGrant.grantRevision, proof, destinationProof: input.destinationProof,
        operationId, transferredAt: now });
      void destinationBinding;
    }
  }
  return { sessionId: input.sessionId, sourceRootSessionId: source.root_session_id, destinationRootSessionId: destinationRoot,
    affectedSessionIds: Object.freeze(Object.keys(revisions)), revisions: Object.freeze(revisions) };
}
