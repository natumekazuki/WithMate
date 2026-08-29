import type { DatabaseSync } from "node:sqlite";

import {
  WORK_ITEM_CONTRACT_REVISION,
  WORK_ITEM_AGGREGATION_CONTRACT_REVISION,
  WORK_ITEM_MAX_RESULT_BYTES,
  WORK_ITEM_MAX_TEXT_LENGTH,
  assertValidWorkItemBinding,
  canTransitionWorkItem,
  isWorkItemActive,
  isWorkItemResultState,
  isRootWorkItem,
  type WorkItem,
  type WorkItemBinding,
  type DelegatedWorkItemBinding,
  type WorkItemAggregationDecision,
  type WorkItemAggregationDecisionType,
  type WorkItemAggregationListItem,
  type WorkItemAggregationSummary,
  type WorkItemContractProjection,
  type WorkItemEvent,
  type WorkItemEventType,
  type WorkItemProgressEventPayload,
  type WorkItemResult,
  type WorkItemState,
} from "../src/work-item.js";
import { ensureV6Schema } from "./database-schema-v6.js";
import { openAppDatabase } from "./sqlite-connection.js";

export type WorkItemMutationOperation =
  | "work.create"
  | "work.revise"
  | "work.history.append"
  | "work.transition"
  | "work.result"
  | "work.cancel";
export type WorkItemAggregationMutationOperation = "work.aggregation.decide" | "work.aggregation.retry";

type WorkItemRow = {
  sequence: number;
  id: string;
  contract_revision: number;
  kind: "root" | "delegated";
  root_session_id: string;
  creator_session_id: string;
  target_session_id: string;
  parent_work_item_id: string | null;
  goal: string;
  scope: string;
  completion_criteria: string;
  authority: string;
  source_identity_json: string;
  state: WorkItemState;
  revision: number;
  result_json: string | null;
  progress_summary: string;
  blockers_json: string;
  next_action: string;
  created_at: string;
  updated_at: string;
};

type WorkItemEventRow = {
  sequence: number;
  work_item_id: string;
  revision: number;
  event_type: WorkItemEventType;
  actor_session_id: string | null;
  payload_json: string;
  created_at: string;
};

type WorkItemAggregationDecisionRow = {
  parent_work_item_id: string;
  child_work_item_id: string;
  decision_revision: number;
  child_revision: number;
  actor_session_id: string;
  decision_type: WorkItemAggregationDecisionType;
  reason: string | null;
  replacement_work_item_id: string | null;
  decided_at: string;
};

type WorkItemAggregationIdempotencyInput = {
  actorSessionId: string;
  idempotencyKey: string;
  requestFingerprint: string;
  decidedAt: string;
  expiresAt: string;
};

export class WorkItemNotFoundError extends Error {
  readonly code = "WORK_ITEM_NOT_FOUND";
  constructor(readonly workItemId: string) {
    super(`Work Item was not found: ${workItemId}`);
    this.name = "WorkItemNotFoundError";
  }
}

export class WorkItemIdempotencyConflictError extends Error {
  readonly code = "IDEMPOTENCY_CONFLICT";
  constructor(readonly operation: WorkItemMutationOperation | WorkItemAggregationMutationOperation, readonly idempotencyKey: string) {
    super(`Work Item idempotency key was reused with a different request: ${operation}`);
    this.name = "WorkItemIdempotencyConflictError";
  }
}

export class WorkItemRevisionConflictError extends Error {
  readonly code = "WORK_ITEM_REVISION_CONFLICT";
  constructor(readonly workItemId: string, readonly expectedRevision: number, readonly actualRevision: number) {
    super(`Work Item revision is stale: ${workItemId}`);
    this.name = "WorkItemRevisionConflictError";
  }
}

export class WorkItemStateConflictError extends Error {
  readonly code = "WORK_ITEM_STATE_CONFLICT";
  constructor(readonly workItemId: string, readonly from: WorkItemState, readonly to: WorkItemState) {
    super(`Work Item state does not allow this transition: ${workItemId} (${from} -> ${to})`);
    this.name = "WorkItemStateConflictError";
  }
}

export class WorkItemResultTooLargeError extends Error {
  readonly code = "CONTENT_TOO_LARGE";
  constructor(readonly actualBytes: number) {
    super("Work Item result exceeds the byte limit.");
    this.name = "WorkItemResultTooLargeError";
  }
}

export class WorkItemAggregationConflictError extends Error {
  readonly code: string;
  constructor(code: string, message: string, readonly details: Record<string, string | number | boolean> = {}) {
    super(message);
    this.name = "WorkItemAggregationConflictError";
    this.code = code;
  }
}

export class WorkItemStorageV6 {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = openAppDatabase(dbPath);
    ensureV6Schema(this.db);
  }

  resolveIdempotency(
    operation: WorkItemMutationOperation,
    principalSessionId: string,
    idempotencyKey: string,
    requestFingerprint: string,
    observedAt: string,
  ): WorkItem | null {
    this.cleanupExpiredIdempotency(observedAt);
    const row = this.db.prepare(`
      SELECT request_fingerprint, work_item_id, response_json
      FROM work_item_idempotency_v6
      WHERE operation = ? AND principal_session_id = ? AND idempotency_key = ?
    `).get(operation, principalSessionId, idempotencyKey) as
      | { request_fingerprint: string; work_item_id: string; response_json: string | null }
      | undefined;
    if (!row) return null;
    if (row.request_fingerprint !== requestFingerprint) {
      throw new WorkItemIdempotencyConflictError(operation, idempotencyKey);
    }
    return row.response_json === null
      ? this.getRequired(row.work_item_id)
      : parseStoredWorkItemResponse(row.response_json);
  }

  create(input: {
    id: string;
    binding: DelegatedWorkItemBinding;
    principalSessionId: string;
    idempotencyKey: string;
    requestFingerprint: string;
    createdAt: string;
    expiresAt: string;
  }): WorkItem {
    assertValidWorkItemBinding(input.binding);
    return this.transaction(() => {
      const replay = this.resolveIdempotency(
        "work.create",
        input.principalSessionId,
        input.idempotencyKey,
        input.requestFingerprint,
        input.createdAt,
      );
      if (replay) return replay;
      if (input.binding.parentWorkItemId !== null) {
        const parent = this.getRequired(input.binding.parentWorkItemId);
        if (parent.state === "completed" || parent.state === "partially_completed" || parent.state === "failed" || parent.state === "canceled") {
          throw new WorkItemAggregationConflictError("WORK_ITEM_AGGREGATION_PARENT_TERMINAL", "A terminal parent cannot receive a child Work Item.");
        }
      }
      this.db.prepare(`
        INSERT INTO work_items_v6 (
          id, contract_revision, kind, root_session_id, creator_session_id, target_session_id,
          parent_work_item_id, goal, scope, completion_criteria, authority,
          source_identity_json, state, revision, progress_summary, blockers_json, next_action,
          created_at, updated_at
        ) VALUES (?, ?, 'delegated', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 1, '', '[]', '', ?, ?)
      `).run(
        input.id,
        WORK_ITEM_CONTRACT_REVISION,
        input.binding.rootSessionId,
        input.binding.creatorSessionId,
        input.binding.targetSessionId,
        input.binding.parentWorkItemId,
        input.binding.goal,
        input.binding.scope,
        input.binding.completionCriteria,
        input.binding.authority,
        serializeJson(input.binding.sourceIdentity, "Work Item source identity"),
        input.createdAt,
        input.createdAt,
      );
      this.insertEvent({
        workItemId: input.id,
        revision: 1,
        type: "created",
        actorSessionId: input.principalSessionId,
        payload: createdEventPayload({
          id: input.id,
          ...input.binding,
          sequence: 0,
          contractRevision: WORK_ITEM_CONTRACT_REVISION,
          revision: 1,
          state: "pending",
          result: null,
          createdAt: input.createdAt,
          updatedAt: input.createdAt,
        }),
        createdAt: input.createdAt,
      });
      if (input.binding.parentWorkItemId !== null) {
        this.incrementAggregateRevision(input.binding.parentWorkItemId, input.createdAt);
      }
      const created = this.getRequired(input.id);
      this.insertIdempotency(
        "work.create",
        input.principalSessionId,
        input.idempotencyKey,
        input.requestFingerprint,
        input.id,
        input.createdAt,
        input.expiresAt,
        created,
      );
      return created;
    });
  }

  mutate(input: {
    operation: Exclude<WorkItemMutationOperation, "work.create">;
    workItemId: string;
    principalSessionId: string;
    idempotencyKey: string;
    requestFingerprint: string;
    expectedRevision: number;
    state: WorkItemState;
    result: WorkItemResult | null;
    updatedAt: string;
    expiresAt: string;
    expectedAggregateRevision?: number;
  }): WorkItem {
    if (
      (input.operation === "work.result" && (!isWorkItemResultState(input.state) || input.result?.outcome !== input.state))
      || (input.operation === "work.cancel" && (input.state !== "canceled" || input.result !== null))
      || (input.operation === "work.transition" && (
        (input.state !== "in_progress" && input.state !== "waiting") || input.result !== null
      ))
    ) {
      throw new TypeError("Work Item mutation operation, state, and result are inconsistent.");
    }
    const resultJson = input.result === null ? null : serializeJson(input.result, "Work Item result");
    if (resultJson && Buffer.byteLength(resultJson, "utf8") > WORK_ITEM_MAX_RESULT_BYTES) {
      throw new WorkItemResultTooLargeError(Buffer.byteLength(resultJson, "utf8"));
    }
    return this.transaction(() => {
      const replay = this.resolveIdempotency(
        input.operation,
        input.principalSessionId,
        input.idempotencyKey,
        input.requestFingerprint,
        input.updatedAt,
      );
      if (replay) return replay;
      const current = this.getRequired(input.workItemId);
      if (current.revision !== input.expectedRevision) {
        throw new WorkItemRevisionConflictError(input.workItemId, input.expectedRevision, current.revision);
      }
      if (!canTransitionWorkItem(current.state, input.state)) {
        throw new WorkItemStateConflictError(input.workItemId, current.state, input.state);
      }
      if (input.operation === "work.result") {
        if (isRootWorkItem(current)) {
          this.requireRootFinalizable(current, input.expectedAggregateRevision);
        } else {
          this.requireAggregationFinalizable(input.workItemId, input.expectedAggregateRevision);
        }
      }
      const changed = this.db.prepare(`
        UPDATE work_items_v6
        SET state = ?, revision = revision + 1, result_json = ?, updated_at = ?
        WHERE id = ? AND revision = ? AND state = ?
      `).run(
        input.state,
        resultJson,
        input.updatedAt,
        input.workItemId,
        input.expectedRevision,
        current.state,
      );
      if (changed.changes !== 1) {
        const actual = this.getRequired(input.workItemId);
        throw new WorkItemRevisionConflictError(input.workItemId, input.expectedRevision, actual.revision);
      }
      const updated = this.getRequired(input.workItemId);
      this.insertEvent({
        workItemId: input.workItemId,
        revision: updated.revision,
        type: input.operation === "work.result" ? "result_reported" : "state_transitioned",
        actorSessionId: input.principalSessionId,
        payload: input.result !== null
          ? { from: current.state, to: input.result.outcome, result: input.result }
          : { from: current.state, to: input.state },
        createdAt: input.updatedAt,
      });
      this.insertIdempotency(
        input.operation,
        input.principalSessionId,
        input.idempotencyKey,
        input.requestFingerprint,
        input.workItemId,
        input.updatedAt,
        input.expiresAt,
        updated,
      );
      return updated;
    });
  }

  reviseRoot(input: {
    workItemId: string;
    principalSessionId: string;
    idempotencyKey: string;
    requestFingerprint: string;
    expectedRevision: number;
    goal: string;
    scope: string;
    completionCriteria: string;
    authority: string;
    updatedAt: string;
    expiresAt: string;
  }): WorkItem {
    return this.transaction(() => {
      const replay = this.resolveIdempotency(
        "work.revise",
        input.principalSessionId,
        input.idempotencyKey,
        input.requestFingerprint,
        input.updatedAt,
      );
      if (replay) return replay;
      const current = this.getRequired(input.workItemId);
      this.requireRootOwner(current, input.principalSessionId);
      this.requireExpectedRevision(current, input.expectedRevision);
      if (!isWorkItemActive(current.state)) {
        throw new WorkItemStateConflictError(current.id, current.state, current.state);
      }
      const before = contractProjection(current);
      const after: WorkItemContractProjection = {
        goal: input.goal,
        scope: input.scope,
        completionCriteria: input.completionCriteria,
        authority: input.authority,
      };
      const changed = this.db.prepare(`
        UPDATE work_items_v6
        SET goal = ?, scope = ?, completion_criteria = ?, authority = ?,
          revision = revision + 1, updated_at = ?
        WHERE id = ? AND kind = 'root' AND revision = ?
      `).run(
        after.goal,
        after.scope,
        after.completionCriteria,
        after.authority,
        input.updatedAt,
        input.workItemId,
        input.expectedRevision,
      );
      if (changed.changes !== 1) {
        const actual = this.getRequired(input.workItemId);
        throw new WorkItemRevisionConflictError(input.workItemId, input.expectedRevision, actual.revision);
      }
      const updated = this.getRequired(input.workItemId);
      this.insertEvent({
        workItemId: input.workItemId,
        revision: updated.revision,
        type: "contract_revised",
        actorSessionId: input.principalSessionId,
        payload: { before, after },
        createdAt: input.updatedAt,
      });
      this.insertIdempotency(
        "work.revise",
        input.principalSessionId,
        input.idempotencyKey,
        input.requestFingerprint,
        input.workItemId,
        input.updatedAt,
        input.expiresAt,
        updated,
      );
      return updated;
    });
  }

  appendRootHistory(input: {
    workItemId: string;
    principalSessionId: string;
    idempotencyKey: string;
    requestFingerprint: string;
    expectedRevision: number;
    eventType: "progress" | "handoff";
    summary: string;
    blockers: readonly string[];
    nextAction: string;
    createdAt: string;
    expiresAt: string;
  }): WorkItem {
    return this.transaction(() => {
      const replay = this.resolveIdempotency(
        "work.history.append",
        input.principalSessionId,
        input.idempotencyKey,
        input.requestFingerprint,
        input.createdAt,
      );
      if (replay) return replay;
      const current = this.getRequired(input.workItemId);
      this.requireRootOwner(current, input.principalSessionId);
      this.requireExpectedRevision(current, input.expectedRevision);
      if (!isWorkItemActive(current.state)) {
        throw new WorkItemStateConflictError(current.id, current.state, current.state);
      }
      const payload: WorkItemProgressEventPayload = {
        progressSummary: input.summary,
        blockers: [...input.blockers],
        nextAction: input.nextAction,
      };
      const changed = this.db.prepare(`
        UPDATE work_items_v6
        SET progress_summary = ?, blockers_json = ?, next_action = ?,
          revision = revision + 1, updated_at = ?
        WHERE id = ? AND kind = 'root' AND revision = ?
      `).run(
        payload.progressSummary,
        serializeJson(payload.blockers, "Work Item blockers"),
        payload.nextAction,
        input.createdAt,
        input.workItemId,
        input.expectedRevision,
      );
      if (changed.changes !== 1) {
        const actual = this.getRequired(input.workItemId);
        throw new WorkItemRevisionConflictError(input.workItemId, input.expectedRevision, actual.revision);
      }
      const updated = this.getRequired(input.workItemId);
      this.insertEvent({
        workItemId: input.workItemId,
        revision: updated.revision,
        type: input.eventType,
        actorSessionId: input.principalSessionId,
        payload,
        createdAt: input.createdAt,
      });
      this.insertIdempotency(
        "work.history.append",
        input.principalSessionId,
        input.idempotencyKey,
        input.requestFingerprint,
        input.workItemId,
        input.createdAt,
        input.expiresAt,
        updated,
      );
      return updated;
    });
  }

  listHistory(input: {
    workItemId: string;
    afterSequence: number | null;
    limit: number;
  }): WorkItemEvent[] {
    this.getRequired(input.workItemId);
    const rows = this.db.prepare(`
      SELECT sequence, work_item_id, revision, event_type, actor_session_id, payload_json, created_at
      FROM work_item_events_v6
      WHERE work_item_id = ? AND sequence > ?
      ORDER BY sequence ASC
      LIMIT ?
    `).all(input.workItemId, input.afterSequence ?? 0, input.limit) as WorkItemEventRow[];
    return rows.map(parseWorkItemEvent);
  }

  get(workItemId: string): WorkItem | null {
    const row = this.db.prepare("SELECT * FROM work_items_v6 WHERE id = ?").get(workItemId) as WorkItemRow | undefined;
    return row ? parseWorkItem(row) : null;
  }

  listPage(input: {
    rootSessionId: string;
    visibleSessionId: string;
    canSeeRoot: boolean;
    creatorSessionId?: string;
    targetSessionId?: string;
    state?: WorkItemState;
    afterSequence: number | null;
    limit: number;
  }): WorkItem[] {
    return Array.from(this.iteratePage(input));
  }

  *iteratePage(input: {
    rootSessionId: string;
    visibleSessionId: string;
    canSeeRoot: boolean;
    creatorSessionId?: string;
    targetSessionId?: string;
    state?: WorkItemState;
    afterSequence: number | null;
    limit: number;
  }): IterableIterator<WorkItem> {
    const clauses = ["root_session_id = ?", "sequence > ?"];
    const parameters: Array<string | number> = [input.rootSessionId, input.afterSequence ?? 0];
    if (!input.canSeeRoot) {
      clauses.push("(creator_session_id = ? OR target_session_id = ?)");
      parameters.push(input.visibleSessionId, input.visibleSessionId);
    }
    if (input.creatorSessionId !== undefined) {
      clauses.push("creator_session_id = ?");
      parameters.push(input.creatorSessionId);
    }
    if (input.targetSessionId !== undefined) {
      clauses.push("target_session_id = ?");
      parameters.push(input.targetSessionId);
    }
    if (input.state !== undefined) {
      clauses.push("state = ?");
      parameters.push(input.state);
    }
    parameters.push(input.limit);
    const rows = this.db.prepare(`
      SELECT * FROM work_items_v6
      WHERE ${clauses.join(" AND ")}
      ORDER BY sequence ASC
      LIMIT ?
    `).iterate(...parameters) as IterableIterator<WorkItemRow>;
    for (const row of rows) {
      yield parseWorkItem(row);
    }
  }

  getExecutionWorkItemId(executionId: string): string | null {
    const row = this.db.prepare(`
      SELECT work_item_id FROM work_item_execution_associations_v6 WHERE execution_id = ?
    `).get(executionId) as { work_item_id: string } | undefined;
    return row?.work_item_id ?? null;
  }

  getAggregationSummary(parentWorkItemId: string): WorkItemAggregationSummary {
    this.getRequired(parentWorkItemId);
    const row = this.db.prepare(`
      SELECT
        COUNT(child.id) AS direct_child_count,
        COALESCE(SUM(CASE WHEN child.state IN ('pending', 'in_progress', 'waiting') THEN 1 ELSE 0 END), 0) AS active_count,
        COALESCE(SUM(CASE WHEN child.state IN ('completed', 'partially_completed', 'failed', 'canceled') AND decision.child_work_item_id IS NULL THEN 1 ELSE 0 END), 0) AS undecided_terminal_count,
        COALESCE(SUM(CASE WHEN decision.decision_type = 'accepted' THEN 1 ELSE 0 END), 0) AS accepted_count,
        COALESCE(SUM(CASE WHEN decision.decision_type = 'excluded' THEN 1 ELSE 0 END), 0) AS excluded_count,
        COALESCE(SUM(CASE WHEN decision.decision_type = 'retry_requested' THEN 1 ELSE 0 END), 0) AS retry_requested_count
      FROM work_items_v6 AS child
      LEFT JOIN work_item_aggregation_decisions_v6 AS decision ON decision.child_work_item_id = child.id
      WHERE child.parent_work_item_id = ?
    `).get(parentWorkItemId) as Record<string, number>;
    const revision = this.db.prepare(`
      SELECT aggregate_revision FROM work_item_aggregations_v6 WHERE parent_work_item_id = ?
    `).get(parentWorkItemId) as { aggregate_revision: number } | undefined;
    return {
      contractRevision: WORK_ITEM_AGGREGATION_CONTRACT_REVISION,
      parentWorkItemId,
      aggregateRevision: revision?.aggregate_revision ?? 0,
      directChildCount: Number(row.direct_child_count),
      activeCount: Number(row.active_count),
      undecidedTerminalCount: Number(row.undecided_terminal_count),
      acceptedCount: Number(row.accepted_count),
      excludedCount: Number(row.excluded_count),
      retryRequestedCount: Number(row.retry_requested_count),
    };
  }

  listAggregationItems(input: {
    parentWorkItemId: string;
    afterSequence: number | null;
    limit: number;
    decision?: WorkItemAggregationDecisionType;
  }): WorkItemAggregationListItem[] {
    const parameters: Array<string | number> = [input.parentWorkItemId, input.afterSequence ?? 0];
    const decisionClause = input.decision === undefined ? "" : "AND decision.decision_type = ?";
    if (input.decision !== undefined) parameters.push(input.decision);
    parameters.push(input.limit);
    const rows = this.db.prepare(`
      SELECT child.id, child.sequence, child.creator_session_id, child.target_session_id,
        child.parent_work_item_id, child.state, child.revision, child.created_at, child.updated_at,
        child.result_json IS NOT NULL AS has_result,
        CASE WHEN child.result_json IS NULL THEN NULL ELSE json_extract(child.result_json, '$.summary') END AS result_summary,
        decision.decision_revision, decision.child_revision, decision.actor_session_id,
        decision.decision_type, decision.reason AS decision_reason,
        decision.replacement_work_item_id, decision.decided_at
      FROM work_items_v6 AS child
      LEFT JOIN work_item_aggregation_decisions_v6 AS decision ON decision.child_work_item_id = child.id
      WHERE child.parent_work_item_id = ? AND child.sequence > ? ${decisionClause}
      ORDER BY child.sequence ASC LIMIT ?
    `).all(...parameters) as Array<{
      id: string; sequence: number; creator_session_id: string; target_session_id: string;
      parent_work_item_id: string | null; state: WorkItemState; revision: number;
      created_at: string; updated_at: string; has_result: number; result_summary: string | null;
      decision_revision: number | null; child_revision: number | null; actor_session_id: string | null;
      decision_type: WorkItemAggregationDecisionType | null; decision_reason: string | null;
      replacement_work_item_id: string | null; decided_at: string | null;
    }>;
    return rows.map((row) => {
      return {
        child: {
          id: row.id, sequence: row.sequence, creatorSessionId: row.creator_session_id,
          targetSessionId: row.target_session_id, parentWorkItemId: row.parent_work_item_id,
          state: row.state, revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at,
        },
        hasResult: row.has_result === 1,
        resultSummary: row.result_summary,
        decision: row.decision_type === null ? null : {
          parentWorkItemId: input.parentWorkItemId,
          childWorkItemId: row.id,
          revision: row.decision_revision!, childRevision: row.child_revision!, actorSessionId: row.actor_session_id!,
          decision: row.decision_type, reason: row.decision_reason,
          replacementWorkItemId: row.replacement_work_item_id, decidedAt: row.decided_at!,
        },
      };
    });
  }

  decideAggregation(input: {
    parentWorkItemId: string; childWorkItemId: string; actorSessionId: string;
    decision: Exclude<WorkItemAggregationDecisionType, "retry_requested">; reason: string | null;
    expectedAggregateRevision: number; idempotencyKey: string; requestFingerprint: string;
    decidedAt: string; expiresAt: string;
  }): WorkItemAggregationDecision {
    return this.transaction(() => {
      const replay = this.resolveAggregationIdempotency("work.aggregation.decide", input.actorSessionId, input.idempotencyKey, input.requestFingerprint, input.decidedAt);
      if (replay) return replay;
      const parent = this.getRequired(input.parentWorkItemId);
      const child = this.requireAggregationMutation(parent, input.childWorkItemId, input.actorSessionId, input.expectedAggregateRevision);
      this.validateDecision(child, input.decision, input.reason);
      this.insertDecision({ ...input, child, replacementWorkItemId: null });
      this.incrementAggregateRevision(parent.id, input.decidedAt);
      this.insertAggregationIdempotency("work.aggregation.decide", input, child.id, null);
      return this.getDecision(child.id)!;
    });
  }

  retryAggregation(input: {
    parentWorkItemId: string; childWorkItemId: string; actorSessionId: string;
    expectedAggregateRevision: number; idempotencyKey: string; requestFingerprint: string;
    replacementId: string; replacementBinding: DelegatedWorkItemBinding; decidedAt: string; expiresAt: string; reason: string | null;
  }): { decision: WorkItemAggregationDecision; replacement: WorkItem } {
    assertValidWorkItemBinding(input.replacementBinding);
    return this.transaction(() => {
      const replay = this.resolveAggregationIdempotency("work.aggregation.retry", input.actorSessionId, input.idempotencyKey, input.requestFingerprint, input.decidedAt);
      if (replay) return { decision: replay, replacement: this.getRequired(replay.replacementWorkItemId!) };
      const parent = this.getRequired(input.parentWorkItemId);
      const child = this.requireAggregationMutation(parent, input.childWorkItemId, input.actorSessionId, input.expectedAggregateRevision);
      this.validateDecision(child, "retry_requested", input.reason);
      this.db.prepare(`INSERT INTO work_items_v6 (
        id, contract_revision, kind, root_session_id, creator_session_id, target_session_id, parent_work_item_id,
        goal, scope, completion_criteria, authority, source_identity_json, state, revision,
        progress_summary, blockers_json, next_action, created_at, updated_at
      ) VALUES (?, ?, 'delegated', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 1, '', '[]', '', ?, ?)`)
        .run(input.replacementId, WORK_ITEM_CONTRACT_REVISION, input.replacementBinding.rootSessionId, input.replacementBinding.creatorSessionId,
          input.replacementBinding.targetSessionId, input.replacementBinding.parentWorkItemId,
          input.replacementBinding.goal, input.replacementBinding.scope, input.replacementBinding.completionCriteria,
          input.replacementBinding.authority, serializeJson(input.replacementBinding.sourceIdentity, "Work Item source identity"),
          input.decidedAt, input.decidedAt);
      const replacement = this.getRequired(input.replacementId);
      this.insertEvent({
        workItemId: replacement.id,
        revision: replacement.revision,
        type: "created",
        actorSessionId: input.actorSessionId,
        payload: createdEventPayload(replacement),
        createdAt: input.decidedAt,
      });
      this.insertDecision({ ...input, child, decision: "retry_requested", replacementWorkItemId: input.replacementId });
      this.incrementAggregateRevision(parent.id, input.decidedAt, 2);
      this.insertAggregationIdempotency("work.aggregation.retry", input, child.id, input.replacementId);
      return { decision: this.getDecision(child.id)!, replacement };
    });
  }

  cleanupExpiredIdempotency(expiredBeforeOrAt: string): number {
    const workItemResult = this.db.prepare(`
      DELETE FROM work_item_idempotency_v6
      WHERE expires_at <= ?
    `).run(expiredBeforeOrAt);
    const aggregationResult = this.db.prepare(`
      DELETE FROM work_item_aggregation_idempotency_v6
      WHERE expires_at <= ?
    `).run(expiredBeforeOrAt);
    return Number(workItemResult.changes) + Number(aggregationResult.changes);
  }

  close(): void {
    this.db.close();
  }

  private getRequired(workItemId: string): WorkItem {
    const item = this.get(workItemId);
    if (!item) throw new WorkItemNotFoundError(workItemId);
    return item;
  }

  private requireAggregationMutation(parent: WorkItem, childWorkItemId: string, actorSessionId: string, expectedRevision: number): WorkItem {
    if (parent.targetSessionId !== actorSessionId) throw new WorkItemAggregationConflictError("WORK_ITEM_AGGREGATION_FORBIDDEN", "Only the parent target Session can mutate its aggregation.");
    if (!isWorkItemResultState(parent.state) && parent.state !== "canceled") {
      const revision = this.getAggregationSummary(parent.id).aggregateRevision;
      if (revision !== expectedRevision) throw new WorkItemAggregationConflictError("WORK_ITEM_AGGREGATION_REVISION_CONFLICT", "The aggregate revision is stale.", { expectedRevision, actualRevision: revision });
      const child = this.getRequired(childWorkItemId);
      if (child.parentWorkItemId !== parent.id || child.rootSessionId !== parent.rootSessionId) throw new WorkItemAggregationConflictError("WORK_ITEM_AGGREGATION_CHILD_INVALID", "The Work Item is not a direct child of the parent.");
      if (isWorkItemActive(child.state)) throw new WorkItemAggregationConflictError("WORK_ITEM_AGGREGATION_CHILD_ACTIVE", "An active child cannot be decided.");
      if (this.getDecision(child.id)) throw new WorkItemAggregationConflictError("WORK_ITEM_AGGREGATION_DECISION_IMMUTABLE", "The child already has an immutable decision.");
      return child;
    }
    throw new WorkItemAggregationConflictError("WORK_ITEM_AGGREGATION_PARENT_TERMINAL", "A terminal parent aggregation is immutable.");
  }

  private validateDecision(child: WorkItem, decision: WorkItemAggregationDecisionType, reason: string | null): void {
    if (decision === "accepted" && child.state === "canceled") throw new WorkItemAggregationConflictError("WORK_ITEM_AGGREGATION_DECISION_INVALID", "A canceled child cannot be accepted.");
    if (decision === "excluded" && (!reason || reason.trim().length === 0)) throw new WorkItemAggregationConflictError("WORK_ITEM_AGGREGATION_REASON_REQUIRED", "An excluded decision requires a reason.");
    if (reason !== null && reason.length > WORK_ITEM_MAX_TEXT_LENGTH) throw new WorkItemAggregationConflictError("WORK_ITEM_AGGREGATION_DECISION_INVALID", "The decision reason exceeds the text limit.");
  }

  private requireAggregationFinalizable(parentWorkItemId: string, expectedAggregateRevision: number | undefined): void {
    const summary = this.getAggregationSummary(parentWorkItemId);
    if (summary.directChildCount === 0) return;
    if (expectedAggregateRevision === undefined) throw new WorkItemAggregationConflictError("WORK_ITEM_AGGREGATION_REVISION_REQUIRED", "A parent with direct children requires expectedAggregateRevision.");
    if (summary.aggregateRevision !== expectedAggregateRevision) throw new WorkItemAggregationConflictError("WORK_ITEM_AGGREGATION_REVISION_CONFLICT", "The aggregate revision is stale.", { expectedRevision: expectedAggregateRevision, actualRevision: summary.aggregateRevision });
    if (summary.activeCount !== 0 || summary.undecidedTerminalCount !== 0) throw new WorkItemAggregationConflictError("WORK_ITEM_AGGREGATION_INCOMPLETE", "All direct children must be terminal and decided before reporting the parent result.");
    const staleDecision = this.db.prepare(`
      SELECT 1 FROM work_items_v6 AS child
      INNER JOIN work_item_aggregation_decisions_v6 AS decision ON decision.child_work_item_id = child.id
      WHERE child.parent_work_item_id = ? AND decision.child_revision <> child.revision LIMIT 1
    `).get(parentWorkItemId);
    if (staleDecision) throw new WorkItemAggregationConflictError("WORK_ITEM_AGGREGATION_REVISION_CONFLICT", "A decided child revision changed after the aggregate snapshot.");
  }

  private requireRootFinalizable(root: WorkItem, expectedAggregateRevision: number | undefined): void {
    this.requireAggregationFinalizable(root.id, expectedAggregateRevision);
    const incomplete = this.db.prepare(`
      SELECT child.id, child.parent_work_item_id, child.state, child.result_json,
        child.revision, decision.child_revision
      FROM work_items_v6 AS child
      LEFT JOIN work_item_aggregation_decisions_v6 AS decision
        ON decision.child_work_item_id = child.id
      WHERE child.root_session_id = ? AND child.id <> ? AND (
        child.state IN ('pending', 'in_progress', 'waiting')
        OR (child.parent_work_item_id IS NULL AND child.result_json IS NULL)
        OR (child.parent_work_item_id IS NOT NULL AND decision.child_work_item_id IS NULL)
        OR (decision.child_revision IS NOT NULL AND decision.child_revision <> child.revision)
      )
      ORDER BY child.sequence ASC
      LIMIT 1
    `).get(root.rootSessionId, root.id) as {
      id: string;
      parent_work_item_id: string | null;
      state: WorkItemState;
      result_json: string | null;
      revision: number;
      child_revision: number | null;
    } | undefined;
    if (!incomplete) return;
    if (incomplete.child_revision !== null && incomplete.child_revision !== incomplete.revision) {
      throw new WorkItemAggregationConflictError(
        "WORK_ITEM_AGGREGATION_REVISION_CONFLICT",
        "A nested aggregation decision does not match the descendant revision.",
        { workItemId: incomplete.id },
      );
    }
    throw new WorkItemAggregationConflictError(
      "WORK_ITEM_AGGREGATION_INCOMPLETE",
      "Every same-root descendant must be terminal with a finalized nested aggregation decision before reporting the root result.",
      { workItemId: incomplete.id },
    );
  }

  private requireRootOwner(item: WorkItem, principalSessionId: string): void {
    if (!isRootWorkItem(item) || item.targetSessionId !== principalSessionId) {
      throw new WorkItemAggregationConflictError(
        "WORK_ITEM_ROOT_OWNER_REQUIRED",
        "Only the self-owning root Session can mutate the Root Work Item.",
        { workItemId: item.id },
      );
    }
  }

  private requireExpectedRevision(item: WorkItem, expectedRevision: number): void {
    if (item.revision !== expectedRevision) {
      throw new WorkItemRevisionConflictError(item.id, expectedRevision, item.revision);
    }
  }

  private insertEvent(input: {
    workItemId: string;
    revision: number;
    type: WorkItemEventType;
    actorSessionId: string | null;
    payload: WorkItemEvent["payload"];
    createdAt: string;
  }): void {
    this.db.prepare(`
      INSERT INTO work_item_events_v6 (
        work_item_id, revision, event_type, actor_session_id, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      input.workItemId,
      input.revision,
      input.type,
      input.actorSessionId,
      serializeJson(input.payload, "Work Item event payload"),
      input.createdAt,
    );
  }

  private incrementAggregateRevision(parentWorkItemId: string, updatedAt: string, amount = 1): void {
    this.db.prepare(`INSERT INTO work_item_aggregations_v6 (parent_work_item_id, aggregate_revision, updated_at)
      VALUES (?, ?, ?) ON CONFLICT(parent_work_item_id) DO UPDATE SET
      aggregate_revision = aggregate_revision + excluded.aggregate_revision, updated_at = excluded.updated_at`)
      .run(parentWorkItemId, amount, updatedAt);
  }

  private getDecision(childWorkItemId: string): WorkItemAggregationDecision | null {
    const row = this.db.prepare(`SELECT * FROM work_item_aggregation_decisions_v6 WHERE child_work_item_id = ?`)
      .get(childWorkItemId) as WorkItemAggregationDecisionRow | undefined;
    return row ? { parentWorkItemId: row.parent_work_item_id, childWorkItemId: row.child_work_item_id,
      revision: row.decision_revision, childRevision: row.child_revision, actorSessionId: row.actor_session_id,
      decision: row.decision_type, reason: row.reason, replacementWorkItemId: row.replacement_work_item_id,
      decidedAt: row.decided_at } : null;
  }

  private insertDecision(input: {
    parentWorkItemId: string;
    actorSessionId: string;
    decision: WorkItemAggregationDecisionType;
    reason: string | null;
    expectedAggregateRevision: number;
    decidedAt: string;
    child: WorkItem;
    replacementWorkItemId: string | null;
  }): void {
    this.db.prepare(`INSERT INTO work_item_aggregation_decisions_v6 (
      parent_work_item_id, child_work_item_id, decision_revision, child_revision, actor_session_id,
      decision_type, reason, replacement_work_item_id, decided_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(input.parentWorkItemId, input.child.id, input.expectedAggregateRevision + 1, input.child.revision,
        input.actorSessionId, input.decision, input.reason, input.replacementWorkItemId, input.decidedAt);
  }

  resolveAggregationIdempotency(
    operation: WorkItemAggregationMutationOperation,
    actorSessionId: string,
    key: string,
    fingerprint: string,
    observedAt: string,
  ): WorkItemAggregationDecision | null {
    this.cleanupExpiredIdempotency(observedAt);
    const row = this.db.prepare(`SELECT request_fingerprint, child_work_item_id FROM work_item_aggregation_idempotency_v6
      WHERE operation = ? AND principal_session_id = ? AND idempotency_key = ?`).get(operation, actorSessionId, key) as
      | { request_fingerprint: string; child_work_item_id: string }
      | undefined;
    if (!row) return null;
    if (row.request_fingerprint !== fingerprint) throw new WorkItemIdempotencyConflictError(operation, key);
    return this.getDecision(row.child_work_item_id);
  }

  private insertAggregationIdempotency(
    operation: WorkItemAggregationMutationOperation,
    input: WorkItemAggregationIdempotencyInput,
    childId: string,
    replacementId: string | null,
  ): void {
    this.db.prepare(`INSERT INTO work_item_aggregation_idempotency_v6 (
      operation, principal_session_id, idempotency_key, request_fingerprint, child_work_item_id,
      replacement_work_item_id, created_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(operation, input.actorSessionId, input.idempotencyKey, input.requestFingerprint, childId,
        replacementId, input.decidedAt, input.expiresAt);
  }

  private insertIdempotency(
    operation: WorkItemMutationOperation,
    principalSessionId: string,
    idempotencyKey: string,
    requestFingerprint: string,
    workItemId: string,
    createdAt: string,
    expiresAt: string,
    response: WorkItem,
  ): void {
    this.db.prepare(`
      INSERT INTO work_item_idempotency_v6 (
        operation, principal_session_id, idempotency_key, request_fingerprint,
        work_item_id, response_json, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      operation,
      principalSessionId,
      idempotencyKey,
      requestFingerprint,
      workItemId,
      serializeJson(response, "Work Item idempotency response"),
      createdAt,
      expiresAt,
    );
  }

  private transaction<T>(run: () => T): T {
    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      const result = run();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

function parseWorkItem(row: WorkItemRow): WorkItem {
  if (row.contract_revision !== WORK_ITEM_CONTRACT_REVISION) {
    throw new TypeError(`Unsupported Work Item contract revision: ${row.contract_revision}`);
  }
  const result = row.result_json === null ? null : JSON.parse(row.result_json) as WorkItemResult;
  if (
    (row.state === "completed" || row.state === "partially_completed" || row.state === "failed")
      ? result?.outcome !== row.state
      : result !== null
  ) {
    throw new TypeError(`Invalid Work Item state/result tuple: ${row.id}`);
  }
  const binding = {
    kind: row.kind,
    rootSessionId: row.root_session_id,
    creatorSessionId: row.creator_session_id,
    targetSessionId: row.target_session_id,
    parentWorkItemId: row.parent_work_item_id,
    goal: row.goal,
    scope: row.scope,
    completionCriteria: row.completion_criteria,
    authority: row.authority,
    sourceIdentity: JSON.parse(row.source_identity_json) as WorkItem["sourceIdentity"],
  } satisfies WorkItemBinding;
  assertValidWorkItemBinding(binding);
  const common = {
    id: row.id,
    sequence: row.sequence,
    contractRevision: WORK_ITEM_CONTRACT_REVISION,
    ...binding,
    state: row.state,
    revision: row.revision,
    result,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (binding.kind === "delegated") return common as WorkItem;
  const blockers = JSON.parse(row.blockers_json) as unknown;
  if (!Array.isArray(blockers) || !blockers.every((blocker) => typeof blocker === "string")) {
    throw new TypeError(`Invalid Root Work Item blockers: ${row.id}`);
  }
  return {
    ...common,
    kind: "root",
    progressSummary: row.progress_summary,
    blockers,
    nextAction: row.next_action,
  } as WorkItem;
}

function parseWorkItemEvent(row: WorkItemEventRow): WorkItemEvent {
  return {
    sequence: row.sequence,
    workItemId: row.work_item_id,
    revision: row.revision,
    type: row.event_type,
    actorSessionId: row.actor_session_id,
    payload: JSON.parse(row.payload_json) as WorkItemEvent["payload"],
    createdAt: row.created_at,
  } as WorkItemEvent;
}

function parseStoredWorkItemResponse(serialized: string): WorkItem {
  const value = JSON.parse(serialized) as WorkItem;
  if (value.contractRevision !== WORK_ITEM_CONTRACT_REVISION) {
    throw new TypeError(`Unsupported Work Item idempotency response revision: ${value.contractRevision}`);
  }
  assertValidWorkItemBinding(value);
  return value;
}

function contractProjection(item: WorkItem): WorkItemContractProjection {
  return {
    goal: item.goal,
    scope: item.scope,
    completionCriteria: item.completionCriteria,
    authority: item.authority,
  };
}

function createdEventPayload(item: WorkItem): Extract<WorkItemEvent, { type: "created" }>["payload"] {
  return {
    kind: item.kind,
    rootSessionId: item.rootSessionId,
    creatorSessionId: item.creatorSessionId,
    targetSessionId: item.targetSessionId,
    parentWorkItemId: item.parentWorkItemId,
    sourceIdentity: { ...item.sourceIdentity },
    contract: contractProjection(item),
    progress: item.kind === "root"
      ? {
          progressSummary: item.progressSummary,
          blockers: [...item.blockers],
          nextAction: item.nextAction,
        }
      : { progressSummary: "", blockers: [], nextAction: "" },
    state: item.state,
    result: item.result,
  };
}

function serializeJson(value: unknown, label: string): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError(`${label} must be JSON serializable.`);
  return serialized;
}
