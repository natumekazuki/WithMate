import type { DatabaseSync } from "node:sqlite";

import type {
  SessionRuntimeDeleteManifestResult,
  SessionRuntimeSessionMoveManifestResult,
} from "../src/session-external-runtime-contract.js";

type SessionIdRow = { session_id: string };
type WorkItemRow = { id: string; state: string; revision: number; kind: string; parent_work_item_id: string | null; result_json: string | null };
type ArtifactRow = { id: number; owner_session_id: string };
type ReservationRow = { reservation_id: string; state: string };
type GrantRow = { grant_id: string; revision: number };

function requireSessionId(sessionId: string): string {
  const normalized = sessionId.trim();
  if (!normalized) throw new TypeError("Session lifecycle manifest sessionId must not be empty.");
  return normalized;
}

function subtreeSql(): string {
  return `
    WITH RECURSIVE subtree(session_id) AS (
      SELECT binding.session_id
      FROM session_role_bindings_v6 AS binding
      INNER JOIN sessions_v6 AS session ON session.id = binding.session_id AND session.deleted_at IS NULL
      WHERE binding.session_id = ?
      UNION ALL
      SELECT child.session_id
      FROM session_role_bindings_v6 AS child
      INNER JOIN sessions_v6 AS child_session ON child_session.id = child.session_id AND child_session.deleted_at IS NULL
      INNER JOIN subtree AS parent ON parent.session_id = child.parent_session_id
    )
  `;
}

function addRevisionPart(total: number, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || total > Number.MAX_SAFE_INTEGER - value) {
    throw new RangeError("Session lifecycle manifest revision exceeds the safe integer range.");
  }
  return total + value;
}

function manifestRevision(db: DatabaseSync): number {
  const maxHeader = db.prepare(`
    SELECT COALESCE(MAX(sequence), 0) AS revision
    FROM resource_event_headers_v6
  `).get() as { revision: number };
  const grants = db.prepare(`
    SELECT COALESCE(MAX(sequence), 0) AS revision
    FROM session_authority_grant_events_v6
  `).get() as { revision: number };
  const budgets = db.prepare(`
    SELECT COALESCE(MAX(sequence), 0) AS revision
    FROM resource_budget_events_v6
  `).get() as { revision: number };
  let revision = 0;
  revision = addRevisionPart(revision, maxHeader.revision);
  revision = addRevisionPart(revision, grants.revision);
  revision = addRevisionPart(revision, budgets.revision);
  return revision;
}

/** Builds a lifecycle closure rooted at one Session and its descendants. */
export function buildSessionLifecycleManifest(
  db: DatabaseSync,
  sessionId: string,
  destinationRootSessionId?: string,
): SessionRuntimeDeleteManifestResult | SessionRuntimeSessionMoveManifestResult {
  const target = requireSessionId(sessionId);
  const root = db.prepare("SELECT root_session_id FROM session_role_bindings_v6 WHERE session_id = ?").get(target) as { root_session_id: string } | undefined;
  if (!root) throw new Error(`Session binding was not found: ${target}`);
  const ids = (db.prepare(`${subtreeSql()} SELECT session_id FROM subtree ORDER BY session_id`).all(target) as SessionIdRow[]).map((row) => row.session_id);
  if (ids.length === 0) throw new Error(`Session binding was not found: ${target}`);
  const marks = ids.map(() => "?").join(", ");
  const workItems = db.prepare(`
    SELECT id, state, revision, kind, parent_work_item_id, result_json FROM work_items_v6
    WHERE target_session_id IN (${marks}) OR creator_session_id IN (${marks})
    ORDER BY id
  `).all(...ids, ...ids) as WorkItemRow[];
  const blockingWorkItem = db.prepare(`
    SELECT item.id
    FROM work_items_v6 AS item
    WHERE (
      item.root_session_id IN (${marks})
      OR item.creator_session_id IN (${marks})
      OR item.target_session_id IN (${marks})
    )
      AND (
        item.state IN ('pending', 'in_progress', 'waiting')
        OR (
          item.kind = 'delegated'
          AND item.parent_work_item_id IS NULL
          AND item.state <> 'canceled'
          AND (
            item.result_json IS NULL
            OR NOT EXISTS (
              SELECT 1 FROM work_items_v6 AS root_item
              WHERE root_item.kind = 'root'
                AND root_item.root_session_id = item.root_session_id
                AND root_item.state IN ('completed', 'partially_completed', 'failed', 'canceled')
            )
          )
        )
        OR (
          item.kind = 'delegated'
          AND item.parent_work_item_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM work_item_aggregation_decisions_v6 AS decision
            WHERE decision.child_work_item_id = item.id
              AND decision.child_revision = item.revision
          )
        )
      )
    LIMIT 1
  `).get(...ids, ...ids, ...ids) as { id: string } | undefined;
  const executions = db.prepare(`
    SELECT state, COUNT(*) AS count FROM session_executions_v6
    WHERE session_id IN (${marks}) AND state IN ('running', 'queued', 'cancel_requested') GROUP BY state
  `).all(...ids) as Array<{ state: "running" | "queued"; count: number }>;
  const executionCounts = { running: 0, queued: 0 };
  for (const row of executions) {
    if (row.state === "running" || row.state === "queued") executionCounts[row.state] = row.count;
    else executionCounts.running += row.count;
  }
  const executionIds = (db.prepare(`SELECT id FROM session_executions_v6 WHERE session_id IN (${marks}) ORDER BY id`).all(...ids) as Array<{ id: string }>).map((row) => row.id);
  const grants = db.prepare(`
    SELECT grant_id, revision FROM session_authority_grants_v6
    WHERE grantee_session_id IN (${marks})
      AND effective_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      AND (expires_at IS NULL OR expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      AND revoked_at IS NULL
    ORDER BY grant_id
  `).all(...ids) as GrantRow[];
  const reservations = db.prepare(`
    SELECT reservation.reservation_id, reservation.state
    FROM resource_budget_reservations_v6 AS reservation
    INNER JOIN resource_budget_accounts_v6 AS account ON account.account_id = reservation.account_id
    WHERE (account.owner_session_id IN (${marks}) OR reservation.execution_id IN (${executionIds.length ? executionIds.map(() => "?").join(", ") : "NULL"}))
      AND reservation.state IN ('reserved', 'reconciliation_required')
    ORDER BY reservation.reservation_id
  `).all(...ids, ...executionIds) as ReservationRow[];
  const artifacts = db.prepare(`
    SELECT id, session_id AS owner_session_id FROM session_messages_v6
    WHERE session_id IN (${marks}) AND artifact_body IS NOT NULL AND length(artifact_body) > 0
    ORDER BY id
  `).all(...ids) as ArtifactRow[];
  const openInteractions = db.prepare(`
    SELECT COUNT(*) AS count FROM session_interactions_v6 AS interaction
    INNER JOIN session_executions_v6 AS execution ON execution.id = interaction.execution_id
    WHERE execution.session_id IN (${marks}) AND interaction.state = 'pending'
  `).get(...ids) as { count: number };
  const openCoordinationEvents = db.prepare(`
    SELECT COUNT(*) AS count FROM coordination_events_v6 AS event
    WHERE (event.actor_session_id IN (${marks}) OR event.target_session_id IN (${marks}) OR event.parent_session_id IN (${marks}))
      AND event.kind IN ('escalation', 'user_decision_required', 'blocker')
      AND NOT EXISTS (
        SELECT 1 FROM coordination_event_actions_v6 AS action
        WHERE action.event_id = event.id AND action.action_type IN ('resolved', 'cancelled', 'superseded')
      )
  `).get(...ids, ...ids, ...ids) as { count: number };
  const coordinationEventIds = (db.prepare(`SELECT id FROM coordination_events_v6 WHERE actor_session_id IN (${marks}) OR target_session_id IN (${marks}) OR parent_session_id IN (${marks}) ORDER BY id`).all(...ids, ...ids, ...ids) as Array<{ id: string }>).map((row) => row.id);
  const workItemIds = workItems.map((row) => row.id);
  const result: SessionRuntimeSessionMoveManifestResult = {
    sessionId: target,
    manifestRevision: manifestRevision(db),
    destinationRootSessionId: destinationRootSessionId ?? null,
    descendants: ids.filter((id) => id !== target).map((id) => ({ sessionId: id, revision: (db.prepare("SELECT resource_revision FROM sessions_v6 WHERE id = ?").get(id) as { resource_revision: number }).resource_revision })),
    workItems: workItems.map((row) => ({ workItemId: row.id, state: row.state, revision: row.revision })),
    artifacts: artifacts.map((row) => ({ id: String(row.id), ownerSessionId: row.owner_session_id })),
    budgetReservations: reservations.map((row) => ({ id: row.reservation_id, state: row.state })),
    executions: executionCounts,
    grants: grants.map((row) => ({ id: row.grant_id, revision: row.revision, state: "active" })),
    openInteractions: openInteractions.count,
    openCoordinationEvents: openCoordinationEvents.count,
    blockers: [],
  };
  if (executionCounts.running > 0) result.blockers.push("running_executions");
  if (executionCounts.queued > 0) result.blockers.push("queued_executions");
  if (openInteractions.count > 0) result.blockers.push("open_interactions");
  if (openCoordinationEvents.count > 0) result.blockers.push("open_coordination_events");
  if (result.descendants.length > 0) result.blockers.push("descendants_present");
  if (blockingWorkItem) result.blockers.push("work_items_present");
  if (result.budgetReservations.length > 0) result.blockers.push("budget_reservations_present");
  return destinationRootSessionId === undefined ? { ...result, deletable: result.blockers.length === 0 } : result;
}
