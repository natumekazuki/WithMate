import { workItemDecisionRevisionMatchesSql } from "./work-item-decision-revision-sql.js";
import type { DatabaseSync } from "node:sqlite";

import type {
  SessionRuntimeDeleteManifestResult,
  SessionRuntimeSessionMoveManifestResult,
} from "../src/session-external-runtime-contract.js";

type SessionIdRow = { session_id: string };
type WorkItemRow = { id: string; state: string; revision: number; kind: string; parent_work_item_id: string | null; result_json: string | null };
type ArtifactRow = { id: number; owner_session_id: string };
type ReservationRow = { reservation_id: string; state: string };
type GrantRow = { grant_id: string; revision: number; issuer_grant_id: string | null; issuer_grant_revision: number | null; grantee_session_id: string; revoked_at: string | null; expires_at: string | null };
type ResourceHistoryRow = { resource_kind: string; resource_id: string; event_count: number; latest_revision: number | null };

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
    WHERE root_session_id IN (${marks}) OR target_session_id IN (${marks}) OR creator_session_id IN (${marks})
    ORDER BY id
  `).all(...ids, ...ids, ...ids) as WorkItemRow[];
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
        OR EXISTS (SELECT 1 FROM work_item_aggregations_v6 AS pending_result WHERE pending_result.parent_work_item_id = item.id AND pending_result.stale = 1)
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
                AND NOT EXISTS (SELECT 1 FROM work_item_aggregations_v6 AS root_aggregate WHERE root_aggregate.parent_work_item_id = root_item.id AND root_aggregate.stale = 1)
            )
          )
        )
        OR (
          item.kind = 'delegated'
          AND item.parent_work_item_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM work_item_aggregation_decisions_v6 AS decision
            WHERE decision.child_work_item_id = item.id
              AND ${workItemDecisionRevisionMatchesSql("item")}
              AND (decision.decision_type <> 'accepted' OR NOT EXISTS (
                SELECT 1 FROM work_item_aggregations_v6 AS parent_aggregate
                WHERE parent_aggregate.parent_work_item_id = decision.parent_work_item_id
                  AND parent_aggregate.stale = 1
              ))
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
    SELECT grant_id, revision, issuer_grant_id, issuer_grant_revision FROM session_authority_grants_v6
    WHERE grantee_session_id IN (${marks})
      AND effective_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      AND (expires_at IS NULL OR expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      AND revoked_at IS NULL
    ORDER BY grant_id
  `).all(...ids) as GrantRow[];
  const grantChains = destinationRootSessionId === undefined ? [] : db.prepare(`
    WITH RECURSIVE affected_grants(grant_id) AS (
      SELECT grant_id FROM session_authority_grants_v6
      WHERE grantee_session_id IN (${marks}) OR (issuer_kind = 'agent' AND issuer_id IN (${marks}))
      UNION
      SELECT grant.grant_id FROM session_authority_grants_v6 AS grant
      INNER JOIN affected_grants AS issuer ON issuer.grant_id = grant.issuer_grant_id
    ), grant_chain(grant_id) AS (
      SELECT grant_id FROM affected_grants
      UNION
      SELECT grant.issuer_grant_id
      FROM session_authority_grants_v6 AS grant
      INNER JOIN grant_chain AS child ON child.grant_id = grant.grant_id
      WHERE grant.issuer_grant_id IS NOT NULL
    )
    SELECT grant.grant_id, grant.revision, grant.issuer_grant_id, grant.issuer_grant_revision,
      grant.grantee_session_id, grant.revoked_at, grant.expires_at
    FROM session_authority_grants_v6 AS grant
    INNER JOIN grant_chain AS chain ON chain.grant_id = grant.grant_id
    ORDER BY grant.grant_id
  `).all(...ids, ...ids) as GrantRow[];
  const reservations = db.prepare(`
    SELECT reservation.reservation_id, reservation.state
    FROM resource_budget_reservations_v6 AS reservation
    INNER JOIN resource_budget_accounts_v6 AS account ON account.account_id = reservation.account_id
    WHERE (account.owner_session_id IN (${marks}) OR reservation.execution_id IN (${executionIds.length ? executionIds.map(() => "?").join(", ") : "NULL"})
      OR (account.root_session_id = ? AND account.account_kind = 'root' AND reservation.dimension = 'storageBytes'))
      AND reservation.state IN ('reserved', 'reconciliation_required')
    ORDER BY reservation.reservation_id
  `).all(...ids, ...executionIds, root.root_session_id) as ReservationRow[];
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
  const blockers: string[] = [];
  if (executionCounts.running > 0) blockers.push("running_executions");
  if (executionCounts.queued > 0) blockers.push("queued_executions");
  if (openInteractions.count > 0) blockers.push("open_interactions");
  if (openCoordinationEvents.count > 0) blockers.push("open_coordination_events");
  if (ids.length > 1) blockers.push("descendants_present");
  if (blockingWorkItem) blockers.push("work_items_present");
  if (reservations.length > 0) blockers.push("budget_reservations_present");
  const base = {
    sessionId: target,
    manifestRevision: manifestRevision(db),
    destinationRootSessionId: destinationRootSessionId ?? null,
    descendants: ids.filter((id) => id !== target).map((id) => ({ sessionId: id, revision: (db.prepare("SELECT resource_revision FROM sessions_v6 WHERE id = ?").get(id) as { resource_revision: number }).resource_revision })),
    workItems: workItems.map((row) => ({ workItemId: row.id, state: row.state, revision: row.revision, parentWorkItemId: row.parent_work_item_id })),
    artifacts: artifacts.map((row) => ({ id: String(row.id), ownerSessionId: row.owner_session_id })),
    budgetReservations: reservations.map((row) => ({ id: row.reservation_id, state: row.state })),
    executions: executionCounts,
    grants: grants.map((row) => ({ id: row.grant_id, revision: row.revision, state: "active" })),
    openInteractions: openInteractions.count,
    openCoordinationEvents: openCoordinationEvents.count,
    blockers,
  };
  if (destinationRootSessionId === undefined) {
    return { ...base, destinationRootSessionId: null, deletable: blockers.length === 0 };
  }
  const coordinationEventIds = (db.prepare(`SELECT id FROM coordination_events_v6 WHERE actor_session_id IN (${marks}) OR target_session_id IN (${marks}) OR parent_session_id IN (${marks}) ORDER BY id`).all(...ids, ...ids, ...ids) as Array<{ id: string }>).map((row) => row.id);
  const interactionIds = executionIds.length === 0 ? [] : (db.prepare(`SELECT id FROM session_interactions_v6 WHERE execution_id IN (${executionIds.map(() => "?").join(", ")}) ORDER BY id`).all(...executionIds) as Array<{ id: string }>).map((row) => row.id);
  const workItemIds = workItems.map((row) => row.id);
  const budgetAccounts = db.prepare(`SELECT account_id, owner_session_id, root_session_id, revision FROM resource_budget_accounts_v6 WHERE root_session_id IN (${marks}) OR owner_session_id IN (${marks}) OR (root_session_id = ? AND account_kind = 'root') ORDER BY account_id`).all(...ids, ...ids, root.root_session_id) as Array<{ account_id: string; owner_session_id: string; root_session_id: string; revision: number }>;
  const budgetAccountIds = budgetAccounts.map((row) => row.account_id);
  const budgetUsage = budgetAccountIds.length === 0 ? [] : db.prepare(`SELECT usage.usage_id, usage.account_id, usage.execution_id, usage.amount, usage.usage_unit, usage.confidence
    FROM resource_budget_metered_usage_v6 AS usage
    INNER JOIN resource_budget_accounts_v6 AS account ON account.account_id = usage.account_id
    WHERE usage.account_id IN (${budgetAccountIds.map(() => "?").join(", ")})
      AND (account.owner_session_id IN (${marks}) OR (account.account_kind = 'root' AND usage.execution_id IN (${executionIds.length ? executionIds.map(() => "?").join(", ") : "NULL"})))
    ORDER BY usage.usage_id`).all(...budgetAccountIds, ...ids, ...executionIds) as Array<{ usage_id: string; account_id: string; execution_id: string | null; amount: number; usage_unit: string; confidence: string }>;
  const delegationRows = db.prepare(`SELECT id, actor_session_id, revision, state FROM delegations_v6 WHERE actor_session_id IN (${marks}) ORDER BY id`).all(...ids) as Array<{ id: string; actor_session_id: string; revision: number; state: string }>;
  const historyKeys = new Map<string, { resourceKind: string; resourceId: string }>();
  const addHistoryKey = (resourceKind: string, resourceId: string): void => { historyKeys.set(`${resourceKind}:${resourceId}`, { resourceKind, resourceId }); };
  ids.forEach((id) => addHistoryKey("session", id));
  workItemIds.forEach((id) => addHistoryKey("work_item", id));
  executionIds.forEach((id) => addHistoryKey("execution", id));
  interactionIds.forEach((id) => addHistoryKey("interaction", id));
  coordinationEventIds.forEach((id) => addHistoryKey("coordination_event", id));
  budgetAccounts.forEach((row) => addHistoryKey("budget", row.account_id));
  const fileHistory = db.prepare(`SELECT DISTINCT resource_kind, resource_id FROM resource_event_headers_v6
    WHERE resource_kind IN ('session_files', 'transcript') AND owner_kind = 'session'
      AND owner_id IN (${marks})`).all(...ids) as Array<{ resource_kind: string; resource_id: string }>;
  fileHistory.forEach((row) => addHistoryKey(row.resource_kind, row.resource_id));
  const resourceHistory = db.prepare(`
    SELECT header.resource_kind, header.resource_id, COUNT(*) AS event_count, MAX(header.resource_revision) AS latest_revision
    FROM json_each(?) AS requested
    INNER JOIN resource_event_headers_v6 AS header
      ON header.resource_kind = json_extract(requested.value, '$.resourceKind')
      AND header.resource_id = json_extract(requested.value, '$.resourceId')
    GROUP BY header.resource_kind, header.resource_id
    ORDER BY header.resource_kind, header.resource_id
  `).all(JSON.stringify([...historyKeys.values()])) as ResourceHistoryRow[];
  const result: SessionRuntimeSessionMoveManifestResult = {
    ...base,
    budgetAccounts: budgetAccounts.map((row) => ({ id: row.account_id, ownerSessionId: row.owner_session_id, rootSessionId: row.root_session_id, revision: row.revision })),
    budgetUsage: budgetUsage.map((row) => ({ id: row.usage_id, accountId: row.account_id, executionId: row.execution_id, amount: row.amount, unit: row.usage_unit, confidence: row.confidence })),
    rootWorkItems: workItems.filter((row) => row.kind === "root").map((row) => ({ id: row.id, state: row.state, revision: row.revision })),
    delegationRows: delegationRows.map((row) => ({ id: row.id, actorSessionId: row.actor_session_id, revision: row.revision, state: row.state })),
    grantChains: grantChains.map((row) => ({ id: row.grant_id, issuerGrantId: row.issuer_grant_id, issuerGrantRevision: row.issuer_grant_revision, granteeSessionId: row.grantee_session_id, revision: row.revision, revokedAt: row.revoked_at, expiresAt: row.expires_at })),
    resourceHistory: resourceHistory.map((row) => ({ resourceKind: row.resource_kind, resourceId: row.resource_id, eventCount: row.event_count, latestRevision: row.latest_revision })),
    coordinationEventIds,
    interactionIds,
  };
  return result;
}
