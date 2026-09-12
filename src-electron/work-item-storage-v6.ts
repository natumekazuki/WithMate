import { workItemDecisionRevisionMatchesSql } from "./work-item-decision-revision-sql.js";
import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  WORK_ITEM_CONTRACT_REVISION,
  WORK_ITEM_AGGREGATION_CONTRACT_REVISION,
  WORK_ITEM_MAX_RESULT_BYTES,
  WORK_ITEM_MAX_TEXT_LENGTH,
  WORK_ITEM_IDEMPOTENCY_RETENTION_MS,
  assertValidWorkItemBinding,
  assertWorkItemEventPayloadWithinLimit,
  canTransitionWorkItem,
  isWorkItemActive,
  isWorkItemResultState,
  isRootWorkItem,
  type WorkItem,
  type WorkItemBinding,
  type DelegatedWorkItemBinding,
  type WorkItemAggregationDecision,
  type WorkItemAggregationDecisionType,
  type WorkItemAggregationCorrection,
  type WorkItemAggregationListItem,
  type WorkItemAggregationSummary,
  type WorkItemContractProjection,
  type WorkItemEvent,
  type WorkItemEventType,
  type WorkItemProgressEventPayload,
  type WorkItemResult,
  type RootWorkItemBinding,
  type WorkItemState,
} from "../src/work-item.js";
import type { MutationAuthorityProof } from "../src/session-authority.js";
import { ensureV6Schema } from "./database-schema-v6.js";
import { openAppDatabase } from "./sqlite-connection.js";
import { appendWorkItemAggregationEvent, appendWorkItemEventHeader, claimSessionContainerRevision } from "./resource-history-schema.js";
import { ResourceBudgetStorage } from "./resource-budget-storage.js";
import { assertGrantProofCurrent } from "./session-authority-storage.js";

export type WorkItemMutationOperation =
  | "work.create"
  | "work.reassign" | "work.move" | "work.clone" | "work.reopen" | "work.archive" | "work.delete"
  | "work.restore"
  | "work.revise"
  | "work.history.append"
  | "work.transition"
  | "work.result"
  | "work.result.correct"
  | "work.cancel";
export type WorkItemAggregationMutationOperation = "work.aggregation.decide" | "work.aggregation.retry" | "work.aggregation.correct";

export type WorkItemLifecycleMutationInput = {
  workItemId: string;
  expectedRevision: number;
  principalSessionId: string;
  idempotencyKey: string;
  requestFingerprint: string;
  updatedAt: string;
  expiresAt: string;
  proof: MutationAuthorityProof;
  additionalProofs?: readonly MutationAuthorityProof[];
};
type LifecycleContract = WorkItemContractProjection & { sourceIdentity: WorkItem["sourceIdentity"] };

export type RootWorkItemRestorePurpose = Readonly<{
  operation?: "work.restore" | "work.reopen";
  predecessorWorkItemId: string;
  goal: string;
  scope: string;
  completionCriteria: string;
  authority: string;
  sourceIdentity: WorkItem["sourceIdentity"];
  idempotencyKey: string;
  requestFingerprint: string;
}>;

export type RootWorkItemRestoreSession = Readonly<{
  id: string;
}>;

type WorkItemRow = {
  sequence: number;
  id: string;
  contract_revision: number;
  kind: "root" | "delegated";
  root_session_id: string;
  creator_session_id: string;
  target_session_id: string;
  parent_work_item_id: string | null;
  predecessor_work_item_id?: string | null;
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
  archived_at?: string | null;
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
  proof: MutationAuthorityProof;
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

export class WorkItemIdempotencyResponseUnavailableError extends Error {
  readonly code = "IDEMPOTENCY_RESPONSE_UNAVAILABLE";
  readonly effect = "applied" as const;

  constructor(
    readonly operation: WorkItemMutationOperation | WorkItemAggregationMutationOperation,
    readonly idempotencyKey: string,
    readonly workItemId: string,
  ) {
    super(`The original Work Item response is unavailable after migration: ${operation}`);
    this.name = "WorkItemIdempotencyResponseUnavailableError";
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

/**
 * Adds a Root WorkItem successor to an already-open caller transaction.
 * This helper deliberately does not begin, commit, or rollback a transaction.
 */
export function restoreRootWorkItemWithinTransaction(
  db: DatabaseSync,
  session: Pick<RootWorkItemRestoreSession, "id">,
  purpose: RootWorkItemRestorePurpose,
  proof: MutationAuthorityProof,
  operationId: string,
  now: string,
): WorkItem {
  const operation = purpose.operation ?? "work.restore";
  const principalSessionId = proof.principal.kind === "agent"
    ? proof.principal.actorSessionId
    : session.id;
  const principalKey = workItemPrincipalKey(proof);
  const existingIdempotency = db.prepare(`
    SELECT request_fingerprint, work_item_id, response_json
    FROM work_item_idempotency_v6
    WHERE operation = ? AND principal_session_id = ? AND idempotency_key = ?
  `).get(operation, principalKey, purpose.idempotencyKey) as {
    request_fingerprint: string;
    work_item_id: string;
    response_json: string | null;
  } | undefined;
  if (existingIdempotency) {
    if (existingIdempotency.request_fingerprint !== purpose.requestFingerprint) {
      throw new WorkItemIdempotencyConflictError(operation, purpose.idempotencyKey);
    }
    if (existingIdempotency.response_json === null) {
      throw new WorkItemIdempotencyResponseUnavailableError(
        operation,
        purpose.idempotencyKey,
        existingIdempotency.work_item_id,
      );
    }
    return parseStoredWorkItemResponse(existingIdempotency.response_json);
  }
  assertGrantProofCurrent(db, proof, new Date(now));
  const predecessorRow = db.prepare(`
    SELECT * FROM work_items_v6 WHERE id = ?
  `).get(purpose.predecessorWorkItemId) as WorkItemRow | undefined;
  if (!predecessorRow) throw new WorkItemNotFoundError(purpose.predecessorWorkItemId);
  const predecessor = parseWorkItem(predecessorRow);
  if (
    !isRootWorkItem(predecessor)
    || predecessor.rootSessionId !== session.id
    || isWorkItemActive(predecessor.state)
  ) {
    throw new WorkItemAggregationConflictError(
      "WORK_ITEM_ROOT_SUCCESSOR_INVALID",
      "A Root Work Item successor requires a terminal predecessor in the same root Session.",
      { predecessorWorkItemId: purpose.predecessorWorkItemId },
    );
  }
  const active = db.prepare(`
    SELECT id FROM work_items_v6
    WHERE kind = 'root' AND root_session_id = ?
      AND state IN ('pending', 'in_progress', 'waiting')
    LIMIT 1
  `).get(session.id) as { id: string } | undefined;
  if (active) {
    throw new WorkItemAggregationConflictError(
      "WORK_ITEM_ROOT_SUCCESSOR_ACTIVE",
      "The root Session already has an active Root Work Item.",
      { workItemId: active.id },
    );
  }
  const id = `root-work-item:${session.id}:successor:${randomUUID()}`;
  const sourceIdentity = { ...purpose.sourceIdentity };
  const payload: Extract<WorkItemEvent, { type: "created" }>["payload"] = {
    kind: "root",
    rootSessionId: session.id,
    creatorSessionId: session.id,
    targetSessionId: session.id,
    parentWorkItemId: null,
    predecessorWorkItemId: predecessor.id,
    sourceIdentity,
    contract: {
      goal: purpose.goal,
      scope: purpose.scope,
      completionCriteria: purpose.completionCriteria,
      authority: purpose.authority,
    },
    progress: { progressSummary: "", blockers: [], nextAction: "" },
    state: "pending",
    result: null,
  };
  assertWorkItemEventPayloadWithinLimit("created", payload);
  db.prepare(`
    INSERT INTO work_items_v6 (
      id, kind, contract_revision, root_session_id, creator_session_id,
      target_session_id, parent_work_item_id, predecessor_work_item_id,
      goal, scope, completion_criteria, authority, source_identity_json,
      state, revision, progress_summary, blockers_json, next_action,
      result_json, created_at, updated_at
    ) VALUES (?, 'root', ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, 'pending', 1, '', '[]', '', NULL, ?, ?)
  `).run(
    id,
    WORK_ITEM_CONTRACT_REVISION,
    session.id,
    session.id,
    session.id,
    predecessor.id,
    purpose.goal,
    purpose.scope,
    purpose.completionCriteria,
    purpose.authority,
    serializeJson(sourceIdentity, "Work Item source identity"),
    now,
    now,
  );
  db.prepare(`
    INSERT INTO work_item_events_v6 (
      work_item_id, revision, event_type, actor_session_id, principal_kind, payload_json, created_at
    ) VALUES (?, 1, 'created', ?, ?, ?, ?)
  `).run(id, principalSessionId, proof.principal.kind, serializeJson(payload, "Work Item event payload"), now);
  appendWorkItemEventHeader(db, {
    workItemId: id,
    revision: 1,
    eventKind: "created",
    proof,
    operationId,
    idempotencyKey: purpose.idempotencyKey,
    occurredAt: now,
  });
  const created = parseWorkItem(db.prepare("SELECT * FROM work_items_v6 WHERE id = ?").get(id) as WorkItemRow);
  db.prepare(`
    INSERT INTO work_item_idempotency_v6 (
      operation, principal_session_id, idempotency_key, request_fingerprint,
      work_item_id, response_json, created_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    operation,
    principalKey,
    purpose.idempotencyKey,
    purpose.requestFingerprint,
    created.id,
    serializeJson(created, "Work Item idempotency response"),
    now,
    new Date(Date.parse(now) + WORK_ITEM_IDEMPOTENCY_RETENTION_MS).toISOString(),
  );
  return created;
}

export class WorkItemStorageV6 {
  private readonly db: DatabaseSync;
  private readonly resourceBudgetStorage: ResourceBudgetStorage;

  constructor(dbPath: string) {
    this.db = openAppDatabase(dbPath);
    ensureV6Schema(this.db);
    this.resourceBudgetStorage = new ResourceBudgetStorage(this.db);
  }

  resolveIdempotency(
    operation: WorkItemMutationOperation,
    proof: MutationAuthorityProof,
    idempotencyKey: string,
    requestFingerprint: string,
    observedAt: string,
  ): WorkItem | null {
    this.cleanupExpiredIdempotency(observedAt);
    const principalKey = workItemPrincipalKey(proof);
    const row = this.db
      .prepare(
        `
      SELECT request_fingerprint, work_item_id, response_json
      FROM work_item_idempotency_v6
      WHERE operation = ? AND principal_session_id = ? AND idempotency_key = ?
    `,
      )
      .get(operation, principalKey, idempotencyKey) as
      { request_fingerprint: string; work_item_id: string; response_json: string | null } | undefined;
    if (!row) {
      const legacy = this.db
        .prepare(
          `
        SELECT work_item_id
        FROM work_item_idempotency_v6
        WHERE operation = ? AND principal_session_id LIKE 'legacy_unknown:%' AND idempotency_key = ?
        LIMIT 1
      `,
        )
        .get(operation, idempotencyKey) as { work_item_id: string } | undefined;
      if (legacy) {
        throw new WorkItemIdempotencyResponseUnavailableError(operation, idempotencyKey, legacy.work_item_id);
      }
      return null;
    }
    if (row.request_fingerprint !== requestFingerprint) {
      throw new WorkItemIdempotencyConflictError(operation, idempotencyKey);
    }
    if (row.response_json === null) {
      throw new WorkItemIdempotencyResponseUnavailableError(operation, idempotencyKey, row.work_item_id);
    }
    return parseStoredWorkItemResponse(row.response_json);
  }

  create(input: {
    id: string;
    binding: DelegatedWorkItemBinding | RootWorkItemBinding;
    principalSessionId: string;
    idempotencyKey: string;
    requestFingerprint: string;
    expectedContainerRevision: number;
    createdAt: string;
    expiresAt: string;
    proof: MutationAuthorityProof;
    predecessorWorkItemId?: string;
    sourceWorkItemId?: string;
  }): WorkItem {
    return this.transaction(() => this.createWithinTransaction(input));
  }

  private createWithinTransaction(
    input: Parameters<WorkItemStorageV6["create"]>[0],
    operation: WorkItemMutationOperation = "work.create",
  ): WorkItem {
    assertValidWorkItemBinding(input.binding);
    const replay = this.resolveIdempotency(
      operation,
      input.proof,
      input.idempotencyKey,
      input.requestFingerprint,
      input.createdAt,
    );
    if (replay) return replay;
    assertGrantProofCurrent(this.db, input.proof, new Date(input.createdAt));
    if (input.binding.parentWorkItemId !== null) {
      const parent = this.getRequired(input.binding.parentWorkItemId);
      if (
        parent.kind !== "delegated" ||
        parent.rootSessionId !== input.binding.rootSessionId ||
        parent.targetSessionId !== input.binding.creatorSessionId ||
        ((operation !== "work.reopen") && !isWorkItemActive(parent.state)) || parent.state === "canceled" || parent.archivedAt || parent.deletedAt
      ) {
        throw new WorkItemAggregationConflictError(
          "WORK_ITEM_PARENT_INVALID",
          "The parent Work Item is not an active delegated assignment of the creator Session in the same root.",
          { parentWorkItemId: parent.id },
        );
      }
    }
    this.resourceBudgetStorage.consumeCount({
      sessionId: input.principalSessionId,
      dimension: "workItems",
      idempotencyKey: `work.create:${input.id}`,
      consumedAt: input.createdAt,
    });
    this.db
      .prepare(
        `
      INSERT INTO work_items_v6 (
          id, contract_revision, kind, root_session_id, creator_session_id, target_session_id,
        parent_work_item_id, predecessor_work_item_id, goal, scope, completion_criteria, authority,
          source_identity_json, state, revision, progress_summary, blockers_json, next_action,
          created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 1, '', '[]', '', ?, ?)
    `,
      )
      .run(
        input.id,
        WORK_ITEM_CONTRACT_REVISION,
        input.binding.kind,
        input.binding.rootSessionId,
        input.binding.creatorSessionId,
        input.binding.targetSessionId,
        input.binding.parentWorkItemId,
        input.predecessorWorkItemId ?? null,
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
      payload: {
        ...createdEventPayload({
          id: input.id,
          ...input.binding,
          sequence: 0,
          contractRevision: WORK_ITEM_CONTRACT_REVISION,
          revision: 1,
          state: "pending",
          result: null,
          progressSummary: "",
          blockers: [],
          nextAction: "",
          createdAt: input.createdAt,
          updatedAt: input.createdAt,
        } as WorkItem),
        ...(input.predecessorWorkItemId ? { predecessorWorkItemId: input.predecessorWorkItemId } : {}),
        ...(input.sourceWorkItemId ? { sourceWorkItemId: input.sourceWorkItemId } : {}),
      },
      createdAt: input.createdAt,
      proof: input.proof,
      operationId: workItemOperationId(operation, input.proof, input.requestFingerprint),
      idempotencyKey: input.idempotencyKey,
    });
    claimSessionContainerRevision(this.db, {
      sessionId: input.binding.targetSessionId,
      expectedRevision: input.expectedContainerRevision,
      eventKind: "work_item_created",
      proof: input.proof,
      operationId: workItemOperationId(operation, input.proof, input.requestFingerprint),
      idempotencyKey: input.idempotencyKey,
      occurredAt: input.createdAt,
      payload: { workItemId: input.id },
    });
    if (input.binding.parentWorkItemId !== null) {
      this.incrementAggregateRevision(input.binding.parentWorkItemId, input.createdAt);
      const aggregateRevision = this.getAggregationSummary(input.binding.parentWorkItemId).aggregateRevision;
      appendWorkItemAggregationEvent(this.db, {
        parentWorkItemId: input.binding.parentWorkItemId,
        childWorkItemId: input.id,
        aggregateRevision,
        eventKind: "child_added",
        proof: input.proof,
        operationId: workItemOperationId(operation, input.proof, input.requestFingerprint),
        idempotencyKey: input.idempotencyKey,
        occurredAt: input.createdAt,
        payload: { childWorkItemId: input.id, childRevision: 1 },
      });
    }
    if (operation === "work.reopen" && input.sourceWorkItemId) {
      const affected = new Set(this.getFinalizedAncestorAggregationIds(input.sourceWorkItemId, true));
      if (input.binding.parentWorkItemId) {
        for (const id of this.getFinalizedAncestorAggregationIds(input.binding.parentWorkItemId)) affected.add(id);
      }
      for (const id of affected) {
        this.markAggregationStaleWithEvent(id, input.sourceWorkItemId, "work.reopen", input.proof, input.requestFingerprint, input.idempotencyKey, input.createdAt, operation);
      }
    }
    const created = this.getRequired(input.id);
    this.insertIdempotency(
      operation,
      input.proof,
      input.idempotencyKey,
      input.requestFingerprint,
      input.id,
      input.createdAt,
      input.expiresAt,
      created,
    );
    return created;
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
    expectedResultRevision?: number;
    proof: MutationAuthorityProof;
  }): WorkItem {
    if (
      (input.operation === "work.result" &&
        (!isWorkItemResultState(input.state) || input.result?.outcome !== input.state)) ||
      (input.operation === "work.cancel" && (input.state !== "canceled" || input.result !== null)) ||
      (input.operation === "work.transition" &&
        ((input.state !== "in_progress" && input.state !== "waiting") || input.result !== null))
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
        input.proof,
        input.idempotencyKey,
        input.requestFingerprint,
        input.updatedAt,
      );
      if (replay) return replay;
      assertGrantProofCurrent(this.db, input.proof, new Date(input.updatedAt));
      const current = this.getRequired(input.workItemId);
      if (current.archivedAt || current.deletedAt)
        throw new WorkItemAggregationConflictError("WORK_ITEM_ARCHIVED", "Restore the Work Item before mutation.");
      if (current.revision !== input.expectedRevision) {
        throw new WorkItemRevisionConflictError(input.workItemId, input.expectedRevision, current.revision);
      }
      const repeatTerminalResult = input.operation === "work.result"
        && isWorkItemResultState(current.state)
        && current.state === input.state
        && input.expectedResultRevision !== undefined;
      if (!canTransitionWorkItem(current.state, input.state) && !repeatTerminalResult) {
        throw new WorkItemStateConflictError(input.workItemId, current.state, input.state);
      }
      if (input.operation === "work.result") {
        if (isRootWorkItem(current)) {
          this.requireRootFinalizable(current, input.expectedAggregateRevision);
        } else {
          this.requireAggregationFinalizable(input.workItemId, input.expectedAggregateRevision);
        }
        if (input.expectedResultRevision !== undefined) {
          const currentResultRevision = this.currentResultRevision(input.workItemId);
          if (currentResultRevision !== input.expectedResultRevision) {
            throw new WorkItemAggregationConflictError("WORK_ITEM_RESULT_REVISION_CONFLICT", "The result revision is stale.", { expectedRevision: input.expectedResultRevision, actualRevision: currentResultRevision });
          }
          if (repeatTerminalResult) {
            const aggregate = this.getInternalAggregationState(current.id);
            const latestResult = this.db.prepare("SELECT result_json, correction_reason FROM work_item_result_revisions_v6 WHERE work_item_id = ? AND result_revision = ?")
              .get(input.workItemId, input.expectedResultRevision) as { result_json: string; correction_reason: string | null } | undefined;
            if (aggregate.aggregateRevision === 0 || !latestResult || latestResult.correction_reason === null
              || !isDeepStrictEqual(JSON.parse(latestResult.result_json), input.result)
              || (aggregate.finalizedResultRevision ?? 0) >= input.expectedResultRevision) {
              throw new WorkItemAggregationConflictError("WORK_ITEM_RESULT_REVISION_CONFLICT", "Re-finalization must use the current corrected result payload.");
            }
          }
        }
      }
      const changed = this.db
        .prepare(
          `
        UPDATE work_items_v6
        SET state = ?, revision = revision + 1, result_json = ?, updated_at = ?
        WHERE id = ? AND revision = ? AND state = ?
      `,
        )
        .run(input.state, resultJson, input.updatedAt, input.workItemId, input.expectedRevision, current.state);
      if (changed.changes !== 1) {
        const actual = this.getRequired(input.workItemId);
        throw new WorkItemRevisionConflictError(input.workItemId, input.expectedRevision, actual.revision);
      }
      let updated = this.getRequired(input.workItemId);
      let resultRevision: number | undefined;
      let executionRevision: number | null = null;
      let sourceRevision: number | undefined;
      if (input.operation === "work.result" && input.result !== null) {
        resultRevision = current.result === null ? 1 : this.currentResultRevision(updated.id);
        sourceRevision = current.revision;
        const execution = this.db.prepare(`
          SELECT execution.revision, association.work_item_revision FROM work_item_execution_associations_v6 AS association
          LEFT JOIN session_executions_v6 AS execution ON execution.id = association.execution_id
          WHERE association.work_item_id = ? ORDER BY association.created_at DESC LIMIT 1
        `).get(updated.id) as { revision: number | null; work_item_revision: number | null } | undefined;
        sourceRevision = execution?.work_item_revision ?? sourceRevision;
        executionRevision = execution?.revision ?? null;
        const existingResult = this.db.prepare("SELECT source_revision, execution_revision FROM work_item_result_revisions_v6 WHERE work_item_id = ? AND result_revision = ?").get(updated.id, resultRevision) as { source_revision: number; execution_revision: number | null } | undefined;
        if (existingResult) {
          sourceRevision = existingResult.source_revision;
          executionRevision = existingResult.execution_revision;
        } else {
          this.db.prepare(`INSERT INTO work_item_result_revisions_v6 (
            result_revision_id, work_item_id, result_revision, superseded_result_revision, result_json,
            correction_reason, reporting_session_id, source_revision, execution_revision, created_at
          ) VALUES (?, ?, ?, NULL, ?, NULL, ?, ?, ?, ?)`)
            .run(`${updated.id}:result:${resultRevision}`, updated.id, resultRevision, resultJson, input.result.reportingSessionId, sourceRevision, executionRevision, input.updatedAt);
        }
      }
      if (input.operation === "work.result") {
        this.finalizeAggregation(updated, resultRevision ?? 1, input);
        updated = this.getRequired(input.workItemId);
      }
      this.insertEvent({
        workItemId: input.workItemId,
        revision: updated.revision,
        type: input.operation === "work.result" ? "result_reported" : "state_transitioned",
        actorSessionId: input.principalSessionId,
        payload:
          input.result !== null
          ? {
              from: current.state,
              to: input.result.outcome,
              result: input.result,
              ...(resultRevision === undefined ? {} : { resultRevision, sourceRevision, executionRevision }),
            }
          : { from: current.state, to: input.state },
        createdAt: input.updatedAt,
        proof: input.proof,
        operationId: workItemOperationId(input.operation, input.proof, input.requestFingerprint),
        idempotencyKey: input.idempotencyKey,
      });
      this.insertIdempotency(
        input.operation,
        input.proof,
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

  correctResult(input: {
    workItemId: string;
    expectedRevision: number;
    expectedResultRevision: number;
    correctionReason: string;
    result: WorkItemResult;
    principalSessionId: string;
    idempotencyKey: string;
    requestFingerprint: string;
    updatedAt: string;
    expiresAt: string;
    proof: MutationAuthorityProof;
  }): { workItem: WorkItem; resultRevision: number; supersededResultRevision: number; stale: boolean; staleParentWorkItemIds: string[] } {
    if (!isWorkItemResultState(input.result.outcome)) throw new TypeError("A corrected result must be terminal.");
    if (input.correctionReason.trim().length === 0 || input.correctionReason.length > WORK_ITEM_MAX_TEXT_LENGTH) {
      throw new TypeError("A result correction reason is required and must be within the text limit.");
    }
    const resultJson = serializeJson(input.result, "Work Item result");
    if (Buffer.byteLength(resultJson, "utf8") > WORK_ITEM_MAX_RESULT_BYTES) {
      throw new WorkItemResultTooLargeError(Buffer.byteLength(resultJson, "utf8"));
    }
    return this.transaction(() => {
      this.cleanupExpiredIdempotency(input.updatedAt);
      const principalKey = workItemPrincipalKey(input.proof);
      const replayRow = this.db.prepare(`SELECT request_fingerprint, response_json, work_item_id FROM work_item_idempotency_v6
        WHERE operation = ? AND principal_session_id = ? AND idempotency_key = ?`)
        .get("work.result.correct", principalKey, input.idempotencyKey) as { request_fingerprint: string; response_json: string | null; work_item_id: string } | undefined;
      if (replayRow) {
        if (replayRow.request_fingerprint !== input.requestFingerprint) throw new WorkItemIdempotencyConflictError("work.result.correct", input.idempotencyKey);
        if (replayRow.response_json === null) throw new WorkItemIdempotencyResponseUnavailableError("work.result.correct", input.idempotencyKey, replayRow.work_item_id);
        const stored = JSON.parse(replayRow.response_json) as { workItem?: WorkItem; resultRevision?: number; supersededResultRevision?: number; stale?: boolean; staleParentWorkItemIds?: string[] };
        if (!stored.workItem || stored.resultRevision === undefined || stored.supersededResultRevision === undefined) {
          throw new WorkItemIdempotencyResponseUnavailableError("work.result.correct", input.idempotencyKey, replayRow.work_item_id);
        }
        return stored as { workItem: WorkItem; resultRevision: number; supersededResultRevision: number; stale: boolean; staleParentWorkItemIds: string[] };
      }
      assertGrantProofCurrent(this.db, input.proof, new Date(input.updatedAt));
      const current = this.getRequired(input.workItemId);
      if (current.archivedAt || current.deletedAt) throw new WorkItemAggregationConflictError("WORK_ITEM_ARCHIVED", "Restore the Work Item before correction.");
      if (current.revision !== input.expectedRevision) throw new WorkItemRevisionConflictError(current.id, input.expectedRevision, current.revision);
      if (!isWorkItemResultState(current.state) || current.result === null) {
        throw new WorkItemAggregationConflictError("WORK_ITEM_RESULT_CORRECTION_INVALID", "Only an existing terminal result can be corrected.");
      }
      const latest = this.db.prepare(`SELECT MAX(result_revision) AS revision FROM work_item_result_revisions_v6 WHERE work_item_id = ?`).get(current.id) as { revision: number | null };
      if (latest.revision === null) throw new Error(`Work Item result revision is missing: ${current.id}`);
      const supersededResultRevision = latest.revision;
      if (input.expectedResultRevision !== supersededResultRevision) {
        throw new WorkItemAggregationConflictError("WORK_ITEM_RESULT_REVISION_CONFLICT", "The result revision is stale.", { expectedRevision: input.expectedResultRevision, actualRevision: supersededResultRevision });
      }
      const resultRevision = supersededResultRevision + 1;
      const supersededEvent = this.db.prepare(`SELECT revision FROM work_item_events_v6
        WHERE work_item_id=? AND event_type IN ('result_reported','migration_baseline')
          AND json_type(payload_json,'$.result')='object'
          AND COALESCE(json_extract(payload_json,'$.resultRevision'),1)=?
        ORDER BY revision LIMIT 1`).get(current.id, supersededResultRevision) as { revision: number } | undefined;
      if (!supersededEvent) throw new Error(`Superseded result event is missing: ${current.id}`);
      const association = this.db.prepare(`
        SELECT association.work_item_revision,
          execution.revision AS execution_revision
        FROM work_item_execution_associations_v6 AS association
        LEFT JOIN session_executions_v6 AS execution ON execution.id = association.execution_id
        WHERE association.work_item_id = ? ORDER BY association.created_at DESC LIMIT 1
      `).get(current.id) as { work_item_revision: number | null; execution_revision: number | null } | undefined;
      const sourceRevision = association?.work_item_revision ?? current.revision;
      this.db.prepare(`INSERT INTO work_item_result_revisions_v6 (
        result_revision_id, work_item_id, result_revision, superseded_result_revision, result_json,
        correction_reason, reporting_session_id, source_revision, execution_revision, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(`${current.id}:result:${resultRevision}`, current.id, resultRevision, supersededResultRevision, resultJson,
          input.correctionReason, input.result.reportingSessionId, sourceRevision, association?.execution_revision ?? null, input.updatedAt);
      const changed = this.db.prepare(`UPDATE work_items_v6 SET state = ?, revision = revision + 1, result_json = ?, updated_at = ? WHERE id = ? AND revision = ?`)
        .run(input.result.outcome, resultJson, input.updatedAt, current.id, input.expectedRevision);
      if (Number(changed.changes) !== 1) throw new WorkItemRevisionConflictError(current.id, input.expectedRevision, this.getRequired(current.id).revision);
      const updated = this.getRequired(current.id);
      this.insertEvent({
        workItemId: current.id,
        revision: updated.revision,
        type: "result_reported",
        actorSessionId: input.principalSessionId,
        payload: {
          from: current.state,
          to: input.result.outcome,
          result: input.result,
          resultRevision,
          supersededResultRevision,
          correctionReason: input.correctionReason,
          sourceRevision,
          executionRevision: association?.execution_revision ?? null,
        },
        supersedesEventId: `work-item:${current.id}:revision:${supersededEvent.revision}`,
        createdAt: input.updatedAt,
        proof: input.proof,
        operationId: workItemOperationId("work.result.correct", input.proof, input.requestFingerprint),
        idempotencyKey: input.idempotencyKey,
      });
      const staleParentWorkItemIds = this.markResultConsumersStale(current.id, input.correctionReason, input.proof, input.requestFingerprint, input.idempotencyKey, input.updatedAt, "work.result.correct");
      const response = { workItem: this.getRequired(current.id), resultRevision, supersededResultRevision, stale: staleParentWorkItemIds.length > 0, staleParentWorkItemIds };
      this.insertIdempotency("work.result.correct", input.proof, input.idempotencyKey, input.requestFingerprint, current.id, input.updatedAt, input.expiresAt, response);
      return response;
    });
  }

  reassign(
    input: WorkItemLifecycleMutationInput & {
      targetSessionId: string;
      transferPolicy: "handoff" | "successor";
      expectedContainerRevision?: number;
    },
  ): WorkItem {
    return this.lifecycleTransaction("work.reassign", input, (current) => {
      if (current.kind === "root" || !isWorkItemActive(current.state)) {
        throw new WorkItemStateConflictError(current.id, current.state, current.state);
      }
      this.requireLifecycleTarget(current.rootSessionId, current.creatorSessionId, input.targetSessionId);
      if (input.transferPolicy === "successor") {
        if (input.expectedContainerRevision === undefined) {
          throw new WorkItemAggregationConflictError(
            "WORK_ITEM_CONTAINER_REVISION_REQUIRED",
            "A successor requires the target container revision.",
          );
        }
        return this.copyContractWithinTransaction(
          "work.reassign",
          input,
          current,
          {
            ...contractProjection(current),
            sourceIdentity: current.sourceIdentity,
            targetSessionId: input.targetSessionId,
            parentWorkItemId: current.parentWorkItemId,
            expectedContainerRevision: input.expectedContainerRevision,
          },
          true,
        );
      }
      this.requireLifecycleIdle(current, true);
      if (this.db.prepare("SELECT 1 FROM work_items_v6 WHERE parent_work_item_id = ? LIMIT 1").get(current.id)) {
        throw new WorkItemAggregationConflictError(
          "WORK_ITEM_HANDOFF_CHILDREN",
          "Reassign children explicitly before handing off their coordinator.",
        );
      }
      this.db
        .prepare("UPDATE work_items_v6 SET target_session_id = ?, revision = revision + 1, updated_at = ? WHERE id = ?")
        .run(input.targetSessionId, input.updatedAt, current.id);
      return this.finishLifecycleEvent("work.reassign", input, current, "assignment_changed", {
        beforeTargetSessionId: current.targetSessionId,
        afterTargetSessionId: input.targetSessionId,
      });
    });
  }

  move(
    input: WorkItemLifecycleMutationInput & {
      destinationParentWorkItemId: string | null;
      expectedAggregateRevision?: number;
      expectedDestinationAggregateRevision?: number;
    },
  ): WorkItem {
    return this.lifecycleTransaction("work.move", input, (current) => {
      if (current.kind === "root")
        throw new WorkItemAggregationConflictError(
          "WORK_ITEM_ROOT_MOVE_INVALID",
          "A Root Work Item remains self-owned.",
        );
      this.requireLifecycleIdle(current, true);
      const parentId = input.destinationParentWorkItemId;
      if (parentId === current.parentWorkItemId)
        throw new WorkItemAggregationConflictError(
          "WORK_ITEM_MOVE_UNCHANGED",
          "The destination is the current parent.",
        );
      const subtree = this.db
        .prepare(
          `WITH RECURSIVE subtree(id) AS (
        SELECT id FROM work_items_v6 WHERE id = ? UNION SELECT child.id FROM work_items_v6 child JOIN subtree ON child.parent_work_item_id = subtree.id
      ) SELECT id FROM subtree`,
        )
        .all(current.id) as Array<{ id: string }>;
      if (subtree.some((item) => item.id === parentId))
        throw new WorkItemAggregationConflictError(
          "WORK_ITEM_CYCLE",
          "A Work Item cannot move below itself or its descendants.",
        );
      for (const child of subtree) this.requireLifecycleIdle(this.getRequired(child.id), true);
      const oldParent = current.parentWorkItemId ? this.getRequired(current.parentWorkItemId) : null;
      const newParent = parentId ? this.getRequired(parentId) : null;
      if (newParent && (newParent.kind !== "delegated" || newParent.rootSessionId !== current.rootSessionId || newParent.archivedAt || newParent.deletedAt || newParent.state === "canceled")) {
        throw new WorkItemAggregationConflictError(
          "WORK_ITEM_PARENT_INVALID",
          "The destination must be a delegated parent in the same root. Cross-root Work Item transfer is not connected.",
        );
      }
      if (oldParent) this.requireAggregateRevision(oldParent.id, input.expectedAggregateRevision);
      if (newParent) this.requireAggregateRevision(newParent.id, input.expectedDestinationAggregateRevision);
      const creatorSessionId = newParent?.targetSessionId ?? current.rootSessionId;
      this.requireLifecycleTarget(current.rootSessionId, creatorSessionId, current.targetSessionId);
      const decision = this.getDecision(current.id);
      if (
        decision?.replacementWorkItemId ||
        this.db
          .prepare("SELECT 1 FROM work_item_aggregation_decisions_v6 WHERE replacement_work_item_id=?")
          .get(current.id)
      ) {
        throw new WorkItemAggregationConflictError(
          "WORK_ITEM_REPLACEMENT_MOVE_CONFLICT",
          "A retry replacement chain must retain its original aggregation branch.",
        );
      }
      if (oldParent) {
        if (decision) {
          this.appendLifecycleAggregation(input, oldParent.id, current, "decision_superseded", {
            childRevision: decision.childRevision,
            decision: decision.decision,
            reason: decision.reason,
            replacementWorkItemId: decision.replacementWorkItemId,
          });
          this.db.prepare("DELETE FROM work_item_aggregation_decisions_v6 WHERE child_work_item_id=?").run(current.id);
        }
        this.appendLifecycleAggregation(input, oldParent.id, current, "child_removed", {
          childWorkItemId: current.id,
          childRevision: current.revision,
        });
      }
      this.db
        .prepare(
          "UPDATE work_items_v6 SET parent_work_item_id=?, creator_session_id=?, revision=revision+1, updated_at=? WHERE id=?",
        )
        .run(parentId, creatorSessionId, input.updatedAt, current.id);
      if (newParent)
        this.appendLifecycleAggregation(input, newParent.id, this.getRequired(current.id), "child_adopted", {
          childWorkItemId: current.id,
          childRevision: current.revision + 1,
        });
      const affected = new Set<string>();
      for (const parent of [oldParent, newParent]) {
        if (parent) {
          for (const id of this.getFinalizedAncestorAggregationIds(parent.id)) affected.add(id);
        }
      }
      for (const id of this.getFinalizedAncestorAggregationIds(current.id, true)) affected.add(id);
      for (const id of affected) {
        this.markAggregationStaleWithEvent(id, current.id, "work.move", input.proof, input.requestFingerprint, input.idempotencyKey, input.updatedAt, "work.move");
      }
      return this.finishLifecycleEvent("work.move", input, current, "parent_changed", {
        beforeParentWorkItemId: current.parentWorkItemId,
        afterParentWorkItemId: parentId,
        beforeCreatorSessionId: current.creatorSessionId,
        afterCreatorSessionId: creatorSessionId,
        supersededDecision: decision !== null,
      });
    });
  }

  clone(
    input: WorkItemLifecycleMutationInput &
      LifecycleContract & {
        targetSessionId: string;
        parentWorkItemId?: string | null;
        expectedContainerRevision: number;
      },
  ): WorkItem {
    return this.lifecycleTransaction("work.clone", input, (current) =>
      this.copyContractWithinTransaction("work.clone", input, current, input, false),
    );
  }

  reopen(
    input: WorkItemLifecycleMutationInput &
      LifecycleContract & {
        destinationParentWorkItemId?: string | null;
        expectedContainerRevision?: number;
      },
  ): WorkItem {
    return this.lifecycleTransaction("work.reopen", input, (current) => {
      if (isWorkItemActive(current.state)) throw new WorkItemStateConflictError(current.id, current.state, "pending");
      if (current.kind === "root") {
        this.resourceBudgetStorage.consumeCount({
          sessionId: current.targetSessionId,
          dimension: "workItems",
          idempotencyKey: workItemOperationId("work.reopen", input.proof, input.requestFingerprint),
          consumedAt: input.updatedAt,
        });
        return restoreRootWorkItemWithinTransaction(
          this.db,
          {
            id: current.rootSessionId,
          },
          { ...input, predecessorWorkItemId: current.id, operation: "work.reopen" },
          input.proof,
          workItemOperationId("work.reopen", input.proof, input.requestFingerprint),
          input.updatedAt,
        );
      }
      if (input.expectedContainerRevision === undefined)
        throw new WorkItemAggregationConflictError(
          "WORK_ITEM_CONTAINER_REVISION_REQUIRED",
          "A successor requires the target container revision.",
        );
      return this.copyContractWithinTransaction(
        "work.reopen",
        input,
        current,
        {
          ...input,
          targetSessionId: current.targetSessionId,
          parentWorkItemId:
            input.destinationParentWorkItemId === undefined
              ? current.parentWorkItemId
              : input.destinationParentWorkItemId,
          expectedContainerRevision: input.expectedContainerRevision,
        },
        true,
      );
    });
  }

  archive(input: WorkItemLifecycleMutationInput & { reason: string }): WorkItem {
    return this.lifecycleTransaction("work.archive", input, (current) => {
      this.requireLifecycleIdle(current, true);
      if (current.archivedAt)
        throw new WorkItemAggregationConflictError("WORK_ITEM_ARCHIVED", "The Work Item is already archived.");
      if (
        this.db
          .prepare(
            `WITH RECURSIVE descendants(id,state) AS (
        SELECT id,state FROM work_items_v6 WHERE parent_work_item_id=? UNION SELECT child.id,child.state FROM work_items_v6 child JOIN descendants ON child.parent_work_item_id=descendants.id
      ) SELECT 1 FROM descendants WHERE state IN ('pending','in_progress','waiting') LIMIT 1`,
          )
          .get(current.id)
      ) {
        throw new WorkItemAggregationConflictError(
          "WORK_ITEM_ACTIVE_DESCENDANT",
          "Active descendants must settle before archive.",
        );
      }
      this.db
        .prepare("UPDATE work_items_v6 SET archived_at=?,revision=revision+1,updated_at=? WHERE id=?")
        .run(input.updatedAt, input.updatedAt, current.id);
      return this.finishLifecycleEvent("work.archive", input, current, "archived", {
        archivedAt: input.updatedAt,
        reason: input.reason,
      });
    });
  }

  restore(input: WorkItemLifecycleMutationInput): WorkItem {
    return this.lifecycleTransaction(
      "work.restore",
      input,
      (current) => {
        if (!current.archivedAt)
          throw new WorkItemAggregationConflictError("WORK_ITEM_NOT_ARCHIVED", "The Work Item is not archived.");
        this.db
          .prepare("UPDATE work_items_v6 SET archived_at=NULL,revision=revision+1,updated_at=? WHERE id=?")
          .run(input.updatedAt, current.id);
        return this.finishLifecycleEvent("work.restore", input, current, "restored", { restoredAt: input.updatedAt });
      },
      true,
    );
  }

  delete(input: WorkItemLifecycleMutationInput): WorkItem {
    return this.lifecycleTransaction(
      "work.delete",
      input,
      (current) => {
        this.requireLifecycleIdle(current, true);
        if (!current.archivedAt || isWorkItemActive(current.state))
          throw new WorkItemAggregationConflictError(
            "WORK_ITEM_DELETE_NOT_READY",
            "Cancel or settle and archive the Work Item before deletion.",
          );
        if (
          current.parentWorkItemId !== null ||
          this.db
            .prepare(
              `SELECT 1 FROM work_items_v6 WHERE parent_work_item_id=? OR predecessor_work_item_id=?
        UNION ALL SELECT 1 FROM work_item_aggregation_decisions_v6 WHERE child_work_item_id=? OR parent_work_item_id=? OR replacement_work_item_id=?
        UNION ALL SELECT 1 FROM work_item_execution_associations_v6 WHERE work_item_id=?
        UNION ALL SELECT 1 FROM work_item_aggregations_v6 WHERE parent_work_item_id=?
        UNION ALL SELECT 1 FROM work_item_aggregation_idempotency_v6 WHERE child_work_item_id=? OR replacement_work_item_id=? LIMIT 1`,
            )
            .get(
              current.id,
              current.id,
              current.id,
              current.id,
              current.id,
              current.id,
              current.id,
              current.id,
              current.id,
            )
        ) {
          throw new WorkItemAggregationConflictError(
            "WORK_ITEM_DELETE_REFERENCED",
            "Retained execution, result or membership consumers require this Work Item; keep it archived.",
          );
        }
        this.db
          .prepare("UPDATE work_items_v6 SET revision=revision+1,updated_at=? WHERE id=?")
          .run(input.updatedAt, current.id);
        const deleted = this.finishLifecycleEvent("work.delete", input, current, "deleted", {
          deletedAt: input.updatedAt,
        });
        const snapshot = this.db.prepare("SELECT * FROM work_items_v6 WHERE id=?").get(current.id);
        this.db
          .prepare("INSERT INTO work_item_tombstones_v6(work_item_id,snapshot_json,deleted_at) VALUES(?,?,?)")
          .run(
            current.id,
            serializeJson({ ...snapshot, deleted_at: input.updatedAt }, "Deleted Work Item snapshot"),
            input.updatedAt,
          );
        this.db.prepare("DELETE FROM work_items_v6 WHERE id=?").run(current.id);
        return { ...deleted, deletedAt: input.updatedAt };
      },
      true,
    );
  }

  private lifecycleTransaction(
    operation: WorkItemMutationOperation,
    input: WorkItemLifecycleMutationInput,
    apply: (current: WorkItem) => WorkItem,
    allowArchived = false,
  ): WorkItem {
    return this.transaction(() => {
      const replay = this.resolveIdempotency(
        operation,
        input.proof,
        input.idempotencyKey,
        input.requestFingerprint,
        input.updatedAt,
      );
      if (replay) return replay;
      assertGrantProofCurrent(this.db, input.proof, new Date(input.updatedAt));
      for (const proof of input.additionalProofs ?? [])
        assertGrantProofCurrent(this.db, proof, new Date(input.updatedAt));
      const current = this.getRequired(input.workItemId);
      this.requireExpectedRevision(current, input.expectedRevision);
      if (current.deletedAt)
        throw new WorkItemAggregationConflictError("WORK_ITEM_DELETED", "The Work Item has been deleted.");
      if (current.archivedAt && !allowArchived)
        throw new WorkItemAggregationConflictError("WORK_ITEM_ARCHIVED", "Restore the Work Item before mutation.");
      const result = apply(current);
      // Creation helpers already store the canonical creation result in this transaction.
      const stored = this.resolveIdempotency(
        operation,
        input.proof,
        input.idempotencyKey,
        input.requestFingerprint,
        input.updatedAt,
      );
      if (!stored)
        this.insertIdempotency(
          operation,
          input.proof,
          input.idempotencyKey,
          input.requestFingerprint,
          result.id,
          input.updatedAt,
          input.expiresAt,
          result,
        );
      return result;
    });
  }

  private finishLifecycleEvent(
    operation: WorkItemMutationOperation,
    input: WorkItemLifecycleMutationInput,
    current: WorkItem,
    type: WorkItemEventType,
    payload: WorkItemEvent["payload"],
  ): WorkItem {
    this.insertEvent({
      workItemId: current.id,
      revision: current.revision + 1,
      type,
      actorSessionId: input.principalSessionId,
      payload,
      createdAt: input.updatedAt,
      proof: input.proof,
      operationId: workItemOperationId(operation, input.proof, input.requestFingerprint),
      idempotencyKey: input.idempotencyKey,
    });
    return this.getRequired(current.id);
  }

  private copyContractWithinTransaction(
    operation: WorkItemMutationOperation,
    input: WorkItemLifecycleMutationInput,
    current: WorkItem,
    contract: LifecycleContract & {
      targetSessionId: string;
      parentWorkItemId?: string | null;
      expectedContainerRevision: number;
    },
    successor: boolean,
  ): WorkItem {
    const parentId = contract.parentWorkItemId === undefined ? current.parentWorkItemId : contract.parentWorkItemId;
    const parent = parentId ? this.getRequired(parentId) : null;
    if (parent && (parent.archivedAt || parent.deletedAt))
      throw new WorkItemAggregationConflictError(
        "WORK_ITEM_PARENT_CORRECTION_REQUIRED",
        "A successor cannot use an archived or deleted parent branch.",
      );
    const creatorSessionId = parent?.targetSessionId ?? input.principalSessionId;
    this.requireLifecycleTarget(current.rootSessionId, creatorSessionId, contract.targetSessionId);
    return this.createWithinTransaction(
      {
        id: `work-item:${randomUUID()}`,
        binding: {
          kind: "delegated",
          rootSessionId: current.rootSessionId,
          creatorSessionId,
          targetSessionId: contract.targetSessionId,
          parentWorkItemId: parentId,
          goal: contract.goal,
          scope: contract.scope,
          completionCriteria: contract.completionCriteria,
          authority: contract.authority,
          sourceIdentity: { ...contract.sourceIdentity },
        },
        principalSessionId: input.principalSessionId,
        proof: input.proof,
        expectedContainerRevision: contract.expectedContainerRevision,
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: input.requestFingerprint,
        createdAt: input.updatedAt,
        expiresAt: input.expiresAt,
        sourceWorkItemId: current.id,
        ...(successor ? { predecessorWorkItemId: current.id } : {}),
      },
      operation,
    );
  }

  private requireLifecycleTarget(rootSessionId: string, creatorSessionId: string, targetSessionId: string): void {
    const target = this.db
      .prepare(
        `SELECT binding.root_session_id FROM session_role_bindings_v6 binding JOIN sessions_v6 session ON session.id=binding.session_id WHERE binding.session_id=? AND session.deleted_at IS NULL AND session.state <> 'archived'`,
      )
      .get(targetSessionId) as { root_session_id: string } | undefined;
    if (!target || target.root_session_id !== rootSessionId || creatorSessionId === targetSessionId)
      throw new WorkItemAggregationConflictError(
        "WORK_ITEM_TARGET_INVALID",
        "A delegated target must be a different live Session in the same root.",
      );
  }

  private requireLifecycleIdle(current: WorkItem, includeQueued: boolean): void {
    const execution = this.db
      .prepare(
        `SELECT execution.id FROM session_executions_v6 execution JOIN work_item_execution_associations_v6 association ON association.execution_id=execution.id
      WHERE association.work_item_id=? AND (execution.state='running' OR (?=1 AND execution.state='queued')) LIMIT 1`,
      )
      .get(current.id, includeQueued ? 1 : 0);
    const interaction = this.db
      .prepare(
        `SELECT interaction.id FROM session_interactions_v6 interaction JOIN work_item_execution_associations_v6 association ON association.execution_id=interaction.execution_id
      WHERE association.work_item_id=? AND interaction.state='pending' LIMIT 1`,
      )
      .get(current.id);
    const coordination = this.db
      .prepare(
        `SELECT event.id FROM coordination_events_v6 event WHERE (event.actor_session_id=? OR event.target_session_id=?)
      AND event.kind IN ('escalation','user_decision_required','blocker') AND NOT EXISTS (SELECT 1 FROM coordination_event_actions_v6 action WHERE action.event_id=event.id AND action.action_type IN ('resolved','cancelled','superseded')) LIMIT 1`,
      )
      .get(current.targetSessionId, current.targetSessionId);
    if (execution || interaction || coordination)
      throw new WorkItemAggregationConflictError(
        "WORK_ITEM_HANDOFF_REQUIRED",
        "Settle executions and pending interactions before handoff, or create a separate successor.",
      );
  }

  private requireAggregateRevision(parentWorkItemId: string, expectedRevision: number | undefined): void {
    const actualRevision = this.getAggregationSummary(parentWorkItemId).aggregateRevision;
    if (expectedRevision === undefined || expectedRevision !== actualRevision)
      throw new WorkItemAggregationConflictError(
        "WORK_ITEM_AGGREGATION_REVISION_CONFLICT",
        "Read both parent aggregations before moving the child.",
        { parentWorkItemId, actualRevision },
      );
  }

  private appendLifecycleAggregation(
    input: WorkItemLifecycleMutationInput,
    parentWorkItemId: string,
    current: WorkItem,
    eventKind: "decision_superseded" | "child_removed" | "child_adopted",
    payload: Readonly<Record<string, unknown>>,
  ): void {
    this.incrementAggregateRevision(parentWorkItemId, input.updatedAt);
    appendWorkItemAggregationEvent(this.db, {
      parentWorkItemId,
      childWorkItemId: current.id,
      aggregateRevision: this.getAggregationSummary(parentWorkItemId).aggregateRevision,
      eventKind,
      payload,
      proof: input.proof,
      operationId: workItemOperationId("work.move", input.proof, input.requestFingerprint),
      idempotencyKey: input.idempotencyKey,
      occurredAt: input.updatedAt,
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
    sourceIdentity?: WorkItem["sourceIdentity"];
    updatedAt: string;
    expiresAt: string;
    proof: MutationAuthorityProof;
  }): WorkItem {
    return this.transaction(() => {
      const replay = this.resolveIdempotency(
        "work.revise",
        input.proof,
        input.idempotencyKey,
        input.requestFingerprint,
        input.updatedAt,
      );
      if (replay) return replay;
      assertGrantProofCurrent(this.db, input.proof, new Date(input.updatedAt));
      const current = this.getRequired(input.workItemId);
      if (current.archivedAt || current.deletedAt)
        throw new WorkItemAggregationConflictError("WORK_ITEM_ARCHIVED", "Restore the Work Item before mutation.");
      if (current.kind === "root") this.requireRootOwner(current, input.principalSessionId);
      this.requireExpectedRevision(current, input.expectedRevision);
      if (!isWorkItemActive(current.state)) {
        throw new WorkItemStateConflictError(current.id, current.state, current.state);
      }
      this.requireLifecycleIdle(current, false);
      const before = contractProjection(current);
      const after: WorkItemContractProjection = {
        goal: input.goal,
        scope: input.scope,
        completionCriteria: input.completionCriteria,
        authority: input.authority,
      };
      const changed = this.db
        .prepare(
          `
        UPDATE work_items_v6
        SET goal = ?, scope = ?, completion_criteria = ?, authority = ?,
          source_identity_json = ?, revision = revision + 1, updated_at = ?
        WHERE id = ? AND revision = ?
      `,
        )
        .run(
        after.goal,
        after.scope,
        after.completionCriteria,
        after.authority,
          serializeJson(input.sourceIdentity ?? current.sourceIdentity, "Planned Work Item source identity"),
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
        payload: {
          before,
          after,
          ...(input.sourceIdentity
            ? { beforeSourceIdentity: current.sourceIdentity, afterSourceIdentity: input.sourceIdentity }
            : {}),
        },
        createdAt: input.updatedAt,
        proof: input.proof,
        operationId: workItemOperationId("work.revise", input.proof, input.requestFingerprint),
        idempotencyKey: input.idempotencyKey,
      });
      this.insertIdempotency(
        "work.revise",
        input.proof,
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
    proof: MutationAuthorityProof;
  }): WorkItem {
    return this.transaction(() => {
      const replay = this.resolveIdempotency(
        "work.history.append",
        input.proof,
        input.idempotencyKey,
        input.requestFingerprint,
        input.createdAt,
      );
      if (replay) return replay;
      assertGrantProofCurrent(this.db, input.proof, new Date(input.createdAt));
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
      const changed = this.db
        .prepare(
          `
        UPDATE work_items_v6
        SET progress_summary = ?, blockers_json = ?, next_action = ?,
          revision = revision + 1, updated_at = ?
        WHERE id = ? AND kind = 'root' AND revision = ?
      `,
        )
        .run(
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
        proof: input.proof,
        operationId: workItemOperationId("work.history.append", input.proof, input.requestFingerprint),
        idempotencyKey: input.idempotencyKey,
      });
      this.insertIdempotency(
        "work.history.append",
        input.proof,
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

  listHistory(input: { workItemId: string; afterSequence: number | null; limit: number }): WorkItemEvent[] {
    return Array.from(this.iterateHistory(input));
  }

  *iterateHistory(input: {
    workItemId: string;
    afterSequence: number | null;
    limit: number;
  }): IterableIterator<WorkItemEvent> {
    this.getRequired(input.workItemId);
    const rows = this.db
      .prepare(
        `
      SELECT sequence, work_item_id, revision, event_type, actor_session_id, payload_json, created_at
      FROM work_item_events_v6
      WHERE work_item_id = ? AND sequence > ?
      ORDER BY sequence ASC
      LIMIT ?
    `,
      )
      .iterate(input.workItemId, input.afterSequence ?? 0, input.limit) as IterableIterator<WorkItemEventRow>;
    for (const row of rows) yield parseWorkItemEvent(row);
  }

  listRecentHistory(input: { workItemId: string; limit: number }): WorkItemEvent[] {
    return Array.from(this.iterateRecentHistory(input)).reverse();
  }

  *iterateRecentHistory(input: { workItemId: string; limit: number }): IterableIterator<WorkItemEvent> {
    this.getRequired(input.workItemId);
    const rows = this.db
      .prepare(
        `
      SELECT sequence, work_item_id, revision, event_type, actor_session_id, payload_json, created_at
      FROM work_item_events_v6
      WHERE work_item_id = ?
      ORDER BY sequence DESC
      LIMIT ?
    `,
      )
      .iterate(input.workItemId, input.limit) as IterableIterator<WorkItemEventRow>;
    for (const row of rows) yield parseWorkItemEvent(row);
  }

  get(workItemId: string): WorkItem | null {
    const row = this.db.prepare("SELECT * FROM work_items_v6 WHERE id = ?").get(workItemId) as WorkItemRow | undefined;
    if (row) return this.withResultProjection(parseWorkItem(row));
    const tombstone = this.db
      .prepare("SELECT snapshot_json,deleted_at FROM work_item_tombstones_v6 WHERE work_item_id=?")
      .get(workItemId) as { snapshot_json: string; deleted_at: string } | undefined;
    return tombstone
      ? { ...this.withResultProjection(parseWorkItem(JSON.parse(tombstone.snapshot_json) as WorkItemRow)), deletedAt: tombstone.deleted_at }
      : null;
  }

  listPage(input: {
    rootSessionId: string;
    visibleSessionId: string;
    canSeeRoot: boolean;
    creatorSessionId?: string;
    targetSessionId?: string;
    state?: WorkItemState;
    includeArchived?: boolean;
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
    includeArchived?: boolean;
    afterSequence: number | null;
    limit: number;
  }): IterableIterator<WorkItem> {
    const clauses = ["root_session_id = ?", "sequence > ?"];
    const parameters: Array<string | number> = [input.rootSessionId, input.afterSequence ?? 0];
    if (!input.includeArchived) clauses.push("archived_at IS NULL");
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
    const rows = this.db
      .prepare(
        `
      SELECT * FROM work_items_v6
      WHERE ${clauses.join(" AND ")}
      ORDER BY sequence ASC
      LIMIT ?
    `,
      )
      .iterate(...parameters) as IterableIterator<WorkItemRow>;
    for (const row of rows) {
      yield this.withResultProjection(parseWorkItem(row));
    }
  }

  private withResultProjection(item: WorkItem): WorkItem {
    const row = this.db.prepare("SELECT MAX(result_revision) AS revision FROM work_item_result_revisions_v6 WHERE work_item_id = ?")
      .get(item.id) as { revision: number | null };
    const stale = this.db.prepare("SELECT 1 FROM work_item_aggregations_v6 WHERE parent_work_item_id = ? AND stale = 1").get(item.id) !== undefined;
    return { ...item, resultRevision: row.revision ?? 0, resultCurrent: item.result !== null && !stale, stale };
  }

  getExecutionWorkItemId(executionId: string): string | null {
    const row = this.db
      .prepare(
        `
      SELECT work_item_id FROM work_item_execution_associations_v6 WHERE execution_id = ?
    `,
      )
      .get(executionId) as { work_item_id: string } | undefined;
    return row?.work_item_id ?? null;
  }

  getAggregationSummary(parentWorkItemId: string): WorkItemAggregationSummary {
    this.requireDelegatedAggregationParent(parentWorkItemId);
    const row = this.db
      .prepare(
        `
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
    `,
      )
      .get(parentWorkItemId) as Record<string, number>;
    const revision = this.db
      .prepare(
        `
      SELECT aggregate_revision, stale, stale_reasons_json, finalized_revision, finalized_result_revision FROM work_item_aggregations_v6 WHERE parent_work_item_id = ?
    `,
      )
      .get(parentWorkItemId) as { aggregate_revision: number; stale?: number; stale_reasons_json?: string; finalized_revision?: number | null; finalized_result_revision?: number | null } | undefined;
    const staleReasons = revision?.stale_reasons_json ? JSON.parse(revision.stale_reasons_json) as unknown : [];
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
      stale: revision?.stale === 1,
      staleReasons: Array.isArray(staleReasons) ? staleReasons.filter((reason): reason is string => typeof reason === "string") : [],
      finalizedRevision: revision?.finalized_revision ?? null,
      finalizedResultRevision: revision?.finalized_result_revision ?? null,
    };
  }

  listAggregationItems(input: {
    parentWorkItemId: string;
    afterSequence: number | null;
    limit: number;
    decision?: WorkItemAggregationDecisionType;
    state?: WorkItemState;
    depth?: number;
    fields?: readonly ("summary" | "decision" | "provenance")[];
  }): WorkItemAggregationListItem[] {
    this.requireDelegatedAggregationParent(input.parentWorkItemId);
    const depth = Math.max(1, Math.min(input.depth ?? 1, 8));
    const parameters: Array<string | number> = [input.parentWorkItemId, depth, input.afterSequence ?? 0];
    const decisionClause = input.decision === undefined ? "" : "AND decision.decision_type = ?";
    const stateClause = input.state === undefined ? "" : "AND child.state = ?";
    if (input.decision !== undefined) parameters.push(input.decision);
    if (input.state !== undefined) parameters.push(input.state);
    parameters.push(input.limit);
    const rows = this.db
      .prepare(
        `
      WITH RECURSIVE descendants(id, depth) AS (
        SELECT id, 1 FROM work_items_v6 WHERE parent_work_item_id = ?
        UNION ALL
        SELECT child.id, descendants.depth + 1 FROM work_items_v6 AS child
        INNER JOIN descendants ON child.parent_work_item_id = descendants.id
        WHERE descendants.depth < ?
      )
      SELECT child.id, child.sequence, child.creator_session_id, child.target_session_id,
        child.parent_work_item_id, child.state, child.revision, child.created_at, child.updated_at,
        descendants.depth,
        child.result_json IS NOT NULL AS has_result,
        CASE WHEN child.result_json IS NULL THEN NULL ELSE json_extract(child.result_json, '$.summary') END AS result_summary,
        COALESCE((SELECT MAX(result_revision) FROM work_item_result_revisions_v6 AS result_revision WHERE result_revision.work_item_id = child.id), 0) AS result_revision,
        EXISTS (SELECT 1 FROM work_item_aggregations_v6 AS stale_aggregation WHERE stale_aggregation.parent_work_item_id = child.id AND stale_aggregation.stale = 1) AS stale,
        decision.decision_revision, decision.child_revision, decision.actor_session_id,
        decision.decision_type, decision.reason AS decision_reason,
        decision.replacement_work_item_id, decision.decided_at
      FROM descendants INNER JOIN work_items_v6 AS child ON child.id = descendants.id
      LEFT JOIN work_item_aggregation_decisions_v6 AS decision ON decision.child_work_item_id = child.id
      WHERE child.sequence > ? ${decisionClause} ${stateClause}
      ORDER BY child.sequence ASC LIMIT ?
    `,
      )
      .all(...parameters) as Array<{
      id: string;
      sequence: number;
      creator_session_id: string;
      target_session_id: string;
      parent_work_item_id: string | null;
      state: WorkItemState;
      revision: number;
      created_at: string;
      updated_at: string;
      depth: number;
      has_result: number;
      result_summary: string | null;
      result_revision: number;
      stale: number;
      decision_revision: number | null;
      child_revision: number | null;
      actor_session_id: string | null;
      decision_type: WorkItemAggregationDecisionType | null;
      decision_reason: string | null;
      replacement_work_item_id: string | null;
      decided_at: string | null;
    }>;
    return rows.map((row) => {
      const includeSummary = input.fields === undefined || input.fields.includes("summary");
      const includeDecision = input.fields === undefined || input.fields.includes("decision");
      const includeProvenance = input.fields?.includes("provenance") === true;
      return {
        child: {
          id: row.id,
          sequence: row.sequence,
          creatorSessionId: row.creator_session_id,
          targetSessionId: row.target_session_id,
          parentWorkItemId: row.parent_work_item_id,
          state: row.state,
          revision: row.revision,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        },
        depth: row.depth,
        resultRevision: row.result_revision,
        resultCurrent: row.result_revision > 0 && row.stale === 0,
        stale: row.stale === 1,
        ...(includeProvenance ? { provenance: { creatorSessionId: row.creator_session_id, targetSessionId: row.target_session_id, parentWorkItemId: row.parent_work_item_id } } : {}),
        hasResult: includeSummary && row.has_result === 1,
        resultSummary: includeSummary ? row.result_summary : null,
        decision:
          !includeDecision || row.decision_type === null
            ? null
            : {
          parentWorkItemId: row.parent_work_item_id ?? input.parentWorkItemId,
          childWorkItemId: row.id,
                revision: row.decision_revision!,
                childRevision: row.child_revision!,
                actorSessionId: row.actor_session_id!,
                decision: row.decision_type,
                reason: row.decision_reason,
                replacementWorkItemId: row.replacement_work_item_id,
                decidedAt: row.decided_at!,
        },
      };
    });
  }

  decideAggregation(input: {
    parentWorkItemId: string;
    childWorkItemId: string;
    actorSessionId: string;
    decision: Exclude<WorkItemAggregationDecisionType, "retry_requested">;
    reason: string | null;
    expectedAggregateRevision: number;
    idempotencyKey: string;
    requestFingerprint: string;
    decidedAt: string;
    expiresAt: string;
    proof: MutationAuthorityProof;
  }): WorkItemAggregationDecision {
    return this.transaction(() => {
      const replay = this.resolveAggregationIdempotency(
        "work.aggregation.decide",
        input.proof,
        input.idempotencyKey,
        input.requestFingerprint,
        input.decidedAt,
      );
      if (replay) return replay;
      assertGrantProofCurrent(this.db, input.proof, new Date(input.decidedAt));
      const parent = this.getRequired(input.parentWorkItemId);
      const child = this.requireAggregationMutation(
        parent,
        input.childWorkItemId,
        input.actorSessionId,
        input.expectedAggregateRevision,
      );
      this.validateDecision(child, input.decision, input.reason);
      this.insertDecision({ ...input, child, replacementWorkItemId: null });
      this.incrementAggregateRevision(parent.id, input.decidedAt);
      appendWorkItemAggregationEvent(this.db, {
        parentWorkItemId: parent.id,
        childWorkItemId: child.id,
        aggregateRevision: input.expectedAggregateRevision + 1,
        eventKind: "decided",
        proof: input.proof,
        operationId: workItemOperationId("work.aggregation.decide", input.proof, input.requestFingerprint),
        idempotencyKey: input.idempotencyKey,
        occurredAt: input.decidedAt,
        payload: {
          childRevision: child.revision,
          decision: input.decision,
          reason: input.reason,
          replacementWorkItemId: null,
        },
      });
      this.insertAggregationIdempotency("work.aggregation.decide", input, child.id, null);
      return this.getDecision(child.id)!;
    });
  }

  retryAggregation(input: {
    parentWorkItemId: string;
    childWorkItemId: string;
    actorSessionId: string;
    expectedAggregateRevision: number;
    idempotencyKey: string;
    requestFingerprint: string;
    replacementId: string;
    replacementBinding: DelegatedWorkItemBinding;
    decidedAt: string;
    expiresAt: string;
    reason: string | null;
    proof: MutationAuthorityProof;
  }): { decision: WorkItemAggregationDecision; replacement: WorkItem } {
    assertValidWorkItemBinding(input.replacementBinding);
    return this.transaction(() => {
      const replay = this.resolveAggregationIdempotency(
        "work.aggregation.retry",
        input.proof,
        input.idempotencyKey,
        input.requestFingerprint,
        input.decidedAt,
      );
      if (replay) return { decision: replay, replacement: this.getRequired(replay.replacementWorkItemId!) };
      assertGrantProofCurrent(this.db, input.proof, new Date(input.decidedAt));
      const parent = this.getRequired(input.parentWorkItemId);
      const child = this.requireAggregationMutation(
        parent,
        input.childWorkItemId,
        input.actorSessionId,
        input.expectedAggregateRevision,
      );
      this.validateDecision(child, "retry_requested", input.reason);
      if (
        input.replacementBinding.parentWorkItemId !== parent.id ||
        input.replacementBinding.rootSessionId !== parent.rootSessionId ||
        input.replacementBinding.creatorSessionId !== parent.targetSessionId
      ) {
        throw new WorkItemAggregationConflictError(
          "WORK_ITEM_PARENT_INVALID",
          "The replacement Work Item binding does not match the delegated aggregation parent.",
          { parentWorkItemId: parent.id },
        );
      }
      this.resourceBudgetStorage.consumeCount({
        sessionId: input.actorSessionId,
        dimension: "workItems",
        idempotencyKey: `work.aggregation.retry:${input.replacementId}`,
        consumedAt: input.decidedAt,
      });
      this.db
        .prepare(
          `INSERT INTO work_items_v6 (
        id, contract_revision, kind, root_session_id, creator_session_id, target_session_id, parent_work_item_id,
        goal, scope, completion_criteria, authority, source_identity_json, state, revision,
        progress_summary, blockers_json, next_action, created_at, updated_at
      ) VALUES (?, ?, 'delegated', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 1, '', '[]', '', ?, ?)`,
        )
        .run(
          input.replacementId,
          WORK_ITEM_CONTRACT_REVISION,
          input.replacementBinding.rootSessionId,
          input.replacementBinding.creatorSessionId,
          input.replacementBinding.targetSessionId,
          input.replacementBinding.parentWorkItemId,
          input.replacementBinding.goal,
          input.replacementBinding.scope,
          input.replacementBinding.completionCriteria,
          input.replacementBinding.authority,
          serializeJson(input.replacementBinding.sourceIdentity, "Work Item source identity"),
          input.decidedAt,
          input.decidedAt,
        );
      const replacement = this.getRequired(input.replacementId);
      this.insertEvent({
        workItemId: replacement.id,
        revision: replacement.revision,
        type: "created",
        actorSessionId: input.actorSessionId,
        payload: createdEventPayload(replacement),
        createdAt: input.decidedAt,
        proof: input.proof,
        operationId: workItemOperationId("work.aggregation.retry", input.proof, input.requestFingerprint),
        idempotencyKey: input.idempotencyKey,
      });
      this.insertDecision({ ...input, child, decision: "retry_requested", replacementWorkItemId: input.replacementId });
      this.incrementAggregateRevision(parent.id, input.decidedAt, 2);
      appendWorkItemAggregationEvent(this.db, {
        parentWorkItemId: parent.id,
        childWorkItemId: replacement.id,
        aggregateRevision: input.expectedAggregateRevision + 1,
        eventKind: "child_added",
        proof: input.proof,
        operationId: workItemOperationId("work.aggregation.retry", input.proof, input.requestFingerprint),
        idempotencyKey: input.idempotencyKey,
        occurredAt: input.decidedAt,
        payload: { childWorkItemId: replacement.id, childRevision: replacement.revision },
      });
      appendWorkItemAggregationEvent(this.db, {
        parentWorkItemId: parent.id,
        childWorkItemId: child.id,
        aggregateRevision: input.expectedAggregateRevision + 2,
        eventKind: "retry_requested",
        proof: input.proof,
        operationId: workItemOperationId("work.aggregation.retry", input.proof, input.requestFingerprint),
        idempotencyKey: input.idempotencyKey,
        occurredAt: input.decidedAt,
        payload: {
          childRevision: child.revision,
          decision: "retry_requested",
          reason: input.reason,
          replacementWorkItemId: replacement.id,
        },
      });
      this.insertAggregationIdempotency("work.aggregation.retry", input, child.id, input.replacementId);
      return { decision: this.getDecision(child.id)!, replacement };
    });
  }

  cleanupExpiredIdempotency(expiredBeforeOrAt: string): number {
    const workItemResult = this.db
      .prepare(
        `
      DELETE FROM work_item_idempotency_v6
      WHERE expires_at <= ?
    `,
      )
      .run(expiredBeforeOrAt);
    const aggregationResult = this.db
      .prepare(
        `
      DELETE FROM work_item_aggregation_idempotency_v6
      WHERE expires_at <= ?
    `,
      )
      .run(expiredBeforeOrAt);
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

  correctAggregation(input: {
    parentWorkItemId: string;
    childWorkItemId: string;
    expectedAggregateRevision: number;
    expectedChildResultRevision: number;
    correction: {
      kind: WorkItemAggregationCorrection;
      decision?: WorkItemAggregationDecisionType;
      reason?: string | null;
      replacementWorkItemId?: string | null;
    };
    actorSessionId: string;
    idempotencyKey: string;
    requestFingerprint: string;
    decidedAt: string;
    expiresAt: string;
    proof: MutationAuthorityProof;
  }): { decision: WorkItemAggregationDecision | null; supersededDecisionRevision: number; aggregateRevision: number; stale: boolean; staleParentWorkItemIds: string[] } {
    return this.transaction(() => {
      this.cleanupExpiredIdempotency(input.decidedAt);
      const principalKey = workItemPrincipalKey(input.proof);
      const replayRow = this.db.prepare(`SELECT request_fingerprint, response_json, child_work_item_id FROM work_item_aggregation_idempotency_v6
        WHERE operation = ? AND principal_session_id = ? AND idempotency_key = ?`)
        .get("work.aggregation.correct", principalKey, input.idempotencyKey) as { request_fingerprint: string; response_json: string | null; child_work_item_id: string } | undefined;
      if (replayRow) {
        if (replayRow.request_fingerprint !== input.requestFingerprint) throw new WorkItemIdempotencyConflictError("work.aggregation.correct", input.idempotencyKey);
        if (replayRow.response_json === null) throw new WorkItemIdempotencyResponseUnavailableError("work.aggregation.correct", input.idempotencyKey, replayRow.child_work_item_id);
        return JSON.parse(replayRow.response_json) as { decision: WorkItemAggregationDecision | null; supersededDecisionRevision: number; aggregateRevision: number; stale: boolean; staleParentWorkItemIds: string[] };
      }
      assertGrantProofCurrent(this.db, input.proof, new Date(input.decidedAt));
      const parent = this.requireDelegatedAggregationParent(input.parentWorkItemId);
      if (parent.archivedAt || parent.deletedAt || parent.state === "canceled") throw new WorkItemAggregationConflictError("WORK_ITEM_AGGREGATION_PARENT_INVALID", "The aggregation parent must be live.");
      if (parent.targetSessionId !== input.actorSessionId) throw new WorkItemAggregationConflictError("WORK_ITEM_AGGREGATION_FORBIDDEN", "Only the parent target Session can correct its aggregation.");
      const current = this.getRequired(input.childWorkItemId);
      const decision = this.getDecision(current.id);
      if (!decision || decision.parentWorkItemId !== parent.id || current.parentWorkItemId !== parent.id || current.rootSessionId !== parent.rootSessionId) throw new WorkItemAggregationConflictError("WORK_ITEM_AGGREGATION_DECISION_NOT_FOUND", "The child has no active aggregation decision.");
      const currentResultRevision = this.currentResultRevision(current.id);
      if (currentResultRevision !== input.expectedChildResultRevision) throw new WorkItemAggregationConflictError("WORK_ITEM_AGGREGATION_CHILD_REVISION_CONFLICT", "The child result revision is stale.", { expectedRevision: input.expectedChildResultRevision, actualRevision: currentResultRevision });
      const summary = this.getAggregationSummary(parent.id);
      if (summary.aggregateRevision !== input.expectedAggregateRevision) throw new WorkItemAggregationConflictError("WORK_ITEM_AGGREGATION_REVISION_CONFLICT", "The aggregate revision is stale.", { expectedRevision: input.expectedAggregateRevision, actualRevision: summary.aggregateRevision });
      const reason = input.correction.reason ?? null;
      if (!reason?.trim() || reason.length > WORK_ITEM_MAX_TEXT_LENGTH) throw new WorkItemAggregationConflictError("WORK_ITEM_AGGREGATION_DECISION_INVALID", "A correction reason within the text limit is required.");
      let result: WorkItemAggregationDecision | null;
      if (input.correction.kind === "withdraw") {
        this.db.prepare("DELETE FROM work_item_aggregation_decisions_v6 WHERE child_work_item_id = ?").run(current.id);
        result = null;
      } else {
        const nextDecision = input.correction.kind === "replace" ? "retry_requested" : (input.correction.decision ?? decision.decision);
        const replacementWorkItemId = input.correction.kind === "replace" ? (input.correction.replacementWorkItemId ?? null) : nextDecision === "retry_requested" ? decision.replacementWorkItemId : null;
        if (nextDecision === "retry_requested" && replacementWorkItemId === null) throw new WorkItemAggregationConflictError("WORK_ITEM_REPLACEMENT_INVALID", "A replacement Work Item is required.");
        if (replacementWorkItemId !== null) {
          const replacement = this.getRequired(replacementWorkItemId);
          const cycle = this.db.prepare(`WITH RECURSIVE chain(id) AS (
            SELECT ? UNION SELECT decision.replacement_work_item_id FROM work_item_aggregation_decisions_v6 decision JOIN chain ON decision.child_work_item_id = chain.id WHERE decision.replacement_work_item_id IS NOT NULL
          ) SELECT 1 FROM chain WHERE id = ?`).get(replacementWorkItemId, current.id);
          const used = this.db.prepare("SELECT 1 FROM work_item_aggregation_decisions_v6 WHERE replacement_work_item_id=? AND child_work_item_id<>?").get(replacementWorkItemId, current.id);
          if (replacement.parentWorkItemId !== parent.id || replacement.rootSessionId !== parent.rootSessionId || replacement.archivedAt || replacement.deletedAt || cycle || used) throw new WorkItemAggregationConflictError("WORK_ITEM_REPLACEMENT_INVALID", "The replacement must be an unused live same-parent Work Item without a replacement cycle.");
        }
        this.validateDecision(current, nextDecision, reason ?? decision.reason);
        this.db.prepare(`UPDATE work_item_aggregation_decisions_v6 SET decision_revision = ?, child_revision = ?, decision_type = ?, reason = ?, replacement_work_item_id = ?, decided_at = ? WHERE child_work_item_id = ?`)
          .run(input.expectedAggregateRevision + 1, current.revision, nextDecision, reason ?? decision.reason, replacementWorkItemId, input.decidedAt, current.id);
        result = this.getDecision(current.id);
      }
      this.incrementAggregateRevision(parent.id, input.decidedAt);
      appendWorkItemAggregationEvent(this.db, {
        parentWorkItemId: parent.id,
        childWorkItemId: current.id,
        aggregateRevision: input.expectedAggregateRevision + 1,
        eventKind: "decision_corrected",
        supersedesEventId: `work-item-aggregation:${parent.id}:revision:${decision.revision}`,
        proof: input.proof,
        operationId: workItemOperationId("work.aggregation.correct", input.proof, input.requestFingerprint),
        idempotencyKey: input.idempotencyKey,
        occurredAt: input.decidedAt,
        payload: { correction: input.correction.kind, supersededDecisionRevision: decision.revision, childRevision: current.revision, decision: result?.decision ?? null, reason, replacementWorkItemId: result?.replacementWorkItemId ?? null },
      });
      const staleParentWorkItemIds = this.markResultConsumersStale(parent.id, `aggregation:${input.correction.kind}`, input.proof, input.requestFingerprint, input.idempotencyKey, input.decidedAt, "work.aggregation.correct");
      const { aggregateRevision, stale } = this.getAggregationSummary(parent.id);
      this.insertAggregationCorrectionIdempotency(input, current.id, result?.replacementWorkItemId ?? null, {
        decision: result,
        supersededDecisionRevision: decision.revision,
        aggregateRevision,
        stale,
        staleParentWorkItemIds,
      });
      return { decision: result, supersededDecisionRevision: decision.revision, aggregateRevision, stale, staleParentWorkItemIds };
    });
  }

  private currentResultRevision(workItemId: string): number {
    const row = this.db.prepare("SELECT result_json FROM work_items_v6 WHERE id = ?").get(workItemId) as { result_json: string | null } | undefined;
    if (!row || row.result_json === null) return 0;
    const revision = this.db.prepare("SELECT MAX(result_revision) AS revision FROM work_item_result_revisions_v6 WHERE work_item_id = ?")
      .get(workItemId) as { revision: number | null };
    if (revision.revision === null) throw new Error(`Work Item result revision is missing: ${workItemId}`);
    return revision.revision;
  }

  private getInternalAggregationState(parentWorkItemId: string): {
    aggregateRevision: number;
    directChildCount: number;
    activeCount: number;
    undecidedTerminalCount: number;
    stale: boolean;
    staleReasons: string[];
    finalizedRevision: number | null;
    finalizedResultRevision: number | null;
  } {
    const row = this.db.prepare(`SELECT aggregate_revision, stale, stale_reasons_json, finalized_revision, finalized_result_revision,
      (SELECT COUNT(*) FROM work_items_v6 WHERE parent_work_item_id = ?) AS direct_child_count,
      (SELECT COUNT(*) FROM work_items_v6 WHERE parent_work_item_id = ? AND state IN ('pending', 'in_progress', 'waiting')) AS active_count,
      (SELECT COUNT(*) FROM work_items_v6 AS child WHERE child.parent_work_item_id = ? AND child.state IN ('completed', 'partially_completed', 'failed', 'canceled') AND NOT EXISTS (SELECT 1 FROM work_item_aggregation_decisions_v6 AS decision WHERE decision.child_work_item_id = child.id)) AS undecided_terminal_count
      FROM work_item_aggregations_v6 WHERE parent_work_item_id = ?`).get(parentWorkItemId, parentWorkItemId, parentWorkItemId, parentWorkItemId) as {
      aggregate_revision: number; stale: number; stale_reasons_json: string; finalized_revision: number | null; finalized_result_revision: number | null;
      direct_child_count: number; active_count: number; undecided_terminal_count: number;
    } | undefined;
    if (!row) return { aggregateRevision: 0, directChildCount: 0, activeCount: 0, undecidedTerminalCount: 0, stale: false, staleReasons: [], finalizedRevision: null, finalizedResultRevision: null };
    const reasons = JSON.parse(row.stale_reasons_json) as unknown;
    if (!Array.isArray(reasons) || reasons.some(reason => typeof reason !== "string")) throw new Error(`Invalid aggregation stale reasons: ${parentWorkItemId}`);
    return { aggregateRevision: row.aggregate_revision, directChildCount: row.direct_child_count, activeCount: row.active_count, undecidedTerminalCount: row.undecided_terminal_count, stale: row.stale === 1, staleReasons: reasons, finalizedRevision: row.finalized_revision, finalizedResultRevision: row.finalized_result_revision };
  }

  private insertAggregationCorrectionIdempotency(
    input: { proof: MutationAuthorityProof; idempotencyKey: string; requestFingerprint: string; decidedAt: string; expiresAt: string },
    childId: string,
    replacementId: string | null,
    response: unknown,
  ): void {
    this.db.prepare(`INSERT INTO work_item_aggregation_idempotency_v6 (
      operation, principal_session_id, idempotency_key, request_fingerprint, child_work_item_id,
      replacement_work_item_id, response_json, created_at, expires_at
    ) VALUES ('work.aggregation.correct', ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(workItemPrincipalKey(input.proof), input.idempotencyKey, input.requestFingerprint, childId, replacementId,
        serializeJson(response, "Aggregation correction response"), input.decidedAt, input.expiresAt);
  }

  private requireAggregationMutation(
    parent: WorkItem,
    childWorkItemId: string,
    actorSessionId: string,
    expectedRevision: number,
  ): WorkItem {
    this.requireDelegatedAggregationParent(parent.id, parent);
    if (parent.targetSessionId !== actorSessionId)
      throw new WorkItemAggregationConflictError(
        "WORK_ITEM_AGGREGATION_FORBIDDEN",
        "Only the parent target Session can mutate its aggregation.",
      );
    if ((!isWorkItemResultState(parent.state) || this.getInternalAggregationState(parent.id).stale) && parent.state !== "canceled" && !parent.archivedAt && !parent.deletedAt) {
      const revision = this.getAggregationSummary(parent.id).aggregateRevision;
      if (revision !== expectedRevision)
        throw new WorkItemAggregationConflictError(
          "WORK_ITEM_AGGREGATION_REVISION_CONFLICT",
          "The aggregate revision is stale.",
          { expectedRevision, actualRevision: revision },
        );
      const child = this.getRequired(childWorkItemId);
      if (child.parentWorkItemId !== parent.id || child.rootSessionId !== parent.rootSessionId)
        throw new WorkItemAggregationConflictError(
          "WORK_ITEM_AGGREGATION_CHILD_INVALID",
          "The Work Item is not a direct child of the parent.",
        );
      if (isWorkItemActive(child.state))
        throw new WorkItemAggregationConflictError(
          "WORK_ITEM_AGGREGATION_CHILD_ACTIVE",
          "An active child cannot be decided.",
        );
      if (this.getDecision(child.id))
        throw new WorkItemAggregationConflictError(
          "WORK_ITEM_AGGREGATION_DECISION_IMMUTABLE",
          "The child already has an immutable decision.",
        );
      return child;
    }
    throw new WorkItemAggregationConflictError(
      "WORK_ITEM_AGGREGATION_PARENT_TERMINAL",
      "A terminal parent aggregation is immutable.",
    );
  }

  private validateDecision(child: WorkItem, decision: WorkItemAggregationDecisionType, reason: string | null): void {
    if (decision === "accepted" && child.state === "canceled")
      throw new WorkItemAggregationConflictError(
        "WORK_ITEM_AGGREGATION_DECISION_INVALID",
        "A canceled child cannot be accepted.",
      );
    if (decision === "accepted" && child.kind === "delegated") {
      const staleAggregate = this.db.prepare("SELECT 1 FROM work_item_aggregations_v6 WHERE parent_work_item_id = ? AND stale = 1 LIMIT 1").get(child.id);
      if (staleAggregate) {
        throw new WorkItemAggregationConflictError("WORK_ITEM_AGGREGATION_CHILD_REVISION_CONFLICT", "A child with a stale nested aggregation cannot be accepted.");
      }
    }
    if (decision === "excluded" && (!reason || reason.trim().length === 0))
      throw new WorkItemAggregationConflictError(
        "WORK_ITEM_AGGREGATION_REASON_REQUIRED",
        "An excluded decision requires a reason.",
      );
    if (reason !== null && reason.length > WORK_ITEM_MAX_TEXT_LENGTH)
      throw new WorkItemAggregationConflictError(
        "WORK_ITEM_AGGREGATION_DECISION_INVALID",
        "The decision reason exceeds the text limit.",
      );
  }

  private requireAggregationFinalizable(parentWorkItemId: string, expectedAggregateRevision: number | undefined): void {
    const summary = this.getInternalAggregationState(parentWorkItemId);
    if (summary.aggregateRevision === 0) return;
    if (expectedAggregateRevision === undefined)
      throw new WorkItemAggregationConflictError(
        "WORK_ITEM_AGGREGATION_REVISION_REQUIRED",
        "A parent with direct children requires expectedAggregateRevision.",
      );
    if (summary.aggregateRevision !== expectedAggregateRevision)
      throw new WorkItemAggregationConflictError(
        "WORK_ITEM_AGGREGATION_REVISION_CONFLICT",
        "The aggregate revision is stale.",
        { expectedRevision: expectedAggregateRevision, actualRevision: summary.aggregateRevision },
      );
    if (summary.activeCount !== 0 || summary.undecidedTerminalCount !== 0)
      throw new WorkItemAggregationConflictError(
        "WORK_ITEM_AGGREGATION_INCOMPLETE",
        "All direct children must be terminal and decided before reporting the parent result.",
      );
    const staleDecision = this.db
      .prepare(
        `
      SELECT 1 FROM work_items_v6 AS child
      INNER JOIN work_item_aggregation_decisions_v6 AS decision ON decision.child_work_item_id = child.id
      WHERE child.parent_work_item_id = ? AND decision.decision_type = 'accepted' AND (NOT ${workItemDecisionRevisionMatchesSql("child")}
        OR EXISTS (SELECT 1 FROM work_item_aggregations_v6 nested WHERE nested.parent_work_item_id = child.id AND nested.stale = 1)) LIMIT 1
    `,
      )
      .get(parentWorkItemId);
    if (staleDecision)
      throw new WorkItemAggregationConflictError(
        "WORK_ITEM_AGGREGATION_REVISION_CONFLICT",
        "A decided child revision changed after the aggregate snapshot.",
      );
  }

  private markResultConsumersStale(workItemId: string, reason: string, proof: MutationAuthorityProof, requestFingerprint: string, idempotencyKey: string, occurredAt: string, operation: "work.result.correct" | "work.aggregation.correct"): string[] {
    const affected: string[] = [];
    const mark = (id: string) => {
      if (this.getRequired(id).result === null) return;
      this.markAggregationStaleWithEvent(id, workItemId, reason, proof, requestFingerprint, idempotencyKey, occurredAt, operation);
      affected.push(id);
    };
    let item = this.getRequired(workItemId);
    if (item.kind === "root" || this.db.prepare("SELECT 1 FROM work_item_aggregations_v6 WHERE parent_work_item_id=?").get(item.id)) mark(item.id);
    while (item.parentWorkItemId !== null) {
      if (this.getDecision(item.id)?.decision !== "accepted") return affected;
      item = this.getRequired(item.parentWorkItemId);
      mark(item.id);
    }
    if (item.kind === "root") return affected;
    const roots = this.db.prepare(`SELECT DISTINCT root.id FROM work_items_v6 root
      JOIN work_item_events_v6 result ON result.work_item_id=root.id AND result.event_type='result_reported'
      WHERE root.kind='root' AND root.root_session_id=? AND EXISTS (
        SELECT 1 FROM work_item_events_v6 created WHERE created.work_item_id=? AND created.revision=1 AND created.sequence<result.sequence
      )`).all(item.rootSessionId, item.id) as Array<{ id: string }>;
    for (const root of roots) mark(root.id);
    return affected;
  }

  private finalizeAggregation(item: WorkItem, resultRevision: number, input: {
    proof: MutationAuthorityProof;
    requestFingerprint: string;
    idempotencyKey: string;
    updatedAt: string;
  }): void {
    if (item.kind === "delegated" && !this.db.prepare("SELECT 1 FROM work_item_aggregations_v6 WHERE parent_work_item_id = ?").get(item.id)) return;
    this.incrementAggregateRevision(item.id, input.updatedAt);
    const { aggregateRevision } = this.getInternalAggregationState(item.id);
    appendWorkItemAggregationEvent(this.db, {
      parentWorkItemId: item.id,
      childWorkItemId: item.id,
      aggregateRevision,
      eventKind: "finalized",
      proof: input.proof,
      operationId: workItemOperationId("work.result", input.proof, input.requestFingerprint),
      idempotencyKey: input.idempotencyKey,
      occurredAt: input.updatedAt,
      payload: { aggregateState: { stale: false, staleReasons: [], finalizedRevision: aggregateRevision, finalizedResultRevision: resultRevision } },
    });
    this.db.prepare(`UPDATE work_item_aggregations_v6
      SET stale=0, stale_reasons_json='[]', finalized_revision=aggregate_revision, finalized_result_revision=?
      WHERE parent_work_item_id=?`).run(resultRevision, item.id);
  }

  private getFinalizedAncestorAggregationIds(workItemId: string, rootsOnly = false): string[] {
    const ancestors = this.db.prepare(`
      WITH RECURSIVE ancestors(id) AS (
        SELECT id FROM work_items_v6 WHERE id = ?
        UNION
        SELECT item.parent_work_item_id FROM work_items_v6 AS item
        INNER JOIN ancestors ON item.id = ancestors.id
        WHERE item.parent_work_item_id IS NOT NULL
      ) SELECT id FROM ancestors WHERE id <> ? OR EXISTS (SELECT 1 FROM work_item_aggregations_v6 WHERE parent_work_item_id = ancestors.id)
      UNION SELECT root.id FROM work_items_v6 root
        JOIN work_item_events_v6 result ON result.work_item_id = root.id AND result.event_type = 'result_reported'
        JOIN work_items_v6 descendant ON descendant.root_session_id = root.root_session_id
        WHERE descendant.id = ? AND root.kind = 'root' AND (root.id = ? OR EXISTS (
          SELECT 1 FROM work_item_events_v6 created WHERE created.work_item_id = descendant.id AND created.revision = 1 AND created.sequence < result.sequence
        ))
    `).all(workItemId, workItemId, workItemId, workItemId) as Array<{ id: string }>;
    const affected = ancestors.filter(ancestor => {
      const item = this.getRequired(ancestor.id);
      return item.result !== null && (!rootsOnly || item.kind === "root");
    });
    return affected.map((ancestor) => ancestor.id);
  }

  private markAggregationStaleWithEvent(
    parentWorkItemId: string,
    childWorkItemId: string,
    reason: string,
    proof: MutationAuthorityProof,
    requestFingerprint: string,
    idempotencyKey: string,
    occurredAt: string,
    operation: WorkItemMutationOperation | WorkItemAggregationMutationOperation,
  ): void {
    this.incrementAggregateRevision(parentWorkItemId, occurredAt);
    this.db.prepare("UPDATE work_item_aggregations_v6 SET stale = 1, stale_reasons_json = json_insert(stale_reasons_json, '$[#]', ?) WHERE parent_work_item_id = ?")
      .run(reason, parentWorkItemId);
    const summary = this.getInternalAggregationState(parentWorkItemId);
    appendWorkItemAggregationEvent(this.db, {
      parentWorkItemId,
      childWorkItemId,
      aggregateRevision: summary.aggregateRevision,
      eventKind: "stale",
      proof,
      operationId: workItemOperationId(operation, proof, requestFingerprint),
      idempotencyKey,
      occurredAt,
      payload: {
        reason,
        aggregateState: {
          stale: summary.stale,
          staleReasons: summary.staleReasons,
          finalizedRevision: summary.finalizedRevision,
          finalizedResultRevision: summary.finalizedResultRevision ?? null,
        },
      },
    });
  }

  private requireRootFinalizable(root: WorkItem, expectedAggregateRevision: number | undefined): void {
    if (expectedAggregateRevision !== undefined) {
      throw new WorkItemAggregationConflictError(
        "WORK_ITEM_AGGREGATION_PARENT_INVALID",
        "A Root Work Item does not own an aggregation.",
        { parentWorkItemId: root.id },
      );
    }
    const consumedDescendants = `WITH RECURSIVE consumed(id) AS (
      SELECT id FROM work_items_v6 WHERE root_session_id=? AND kind='delegated' AND parent_work_item_id IS NULL
      UNION SELECT decision.child_work_item_id FROM work_item_aggregation_decisions_v6 decision
        JOIN consumed ON decision.parent_work_item_id=consumed.id WHERE decision.decision_type='accepted'
    ) SELECT id FROM consumed`;
    const staleAggregate = this.db.prepare(`
      SELECT parent_work_item_id FROM work_item_aggregations_v6
      WHERE stale = 1 AND parent_work_item_id IN (${consumedDescendants}) LIMIT 1
    `).get(root.rootSessionId) as { parent_work_item_id: string } | undefined;
    if (staleAggregate) throw new WorkItemAggregationConflictError("WORK_ITEM_AGGREGATION_STALE", "A descendant aggregation requires re-finalization.", { parentWorkItemId: staleAggregate.parent_work_item_id });
    const incomplete = this.db
      .prepare(
        `
      SELECT child.id, child.parent_work_item_id, child.state, child.result_json,
        child.revision, decision.child_revision
      FROM work_items_v6 AS child
      LEFT JOIN work_item_aggregation_decisions_v6 AS decision
        ON decision.child_work_item_id = child.id
      WHERE child.root_session_id = ? AND child.id <> ? AND child.kind = 'delegated' AND (
        child.state IN ('pending', 'in_progress', 'waiting')
        OR (
          child.parent_work_item_id IS NULL
          AND child.state <> 'canceled'
          AND child.result_json IS NULL
        )
        OR (child.parent_work_item_id IS NOT NULL AND decision.child_work_item_id IS NULL)
        OR (decision.child_revision IS NOT NULL AND decision.decision_type='accepted'
          AND child.id IN (${consumedDescendants}) AND NOT ${workItemDecisionRevisionMatchesSql("child")})
      )
      ORDER BY child.sequence ASC
      LIMIT 1
    `,
      )
      .get(root.rootSessionId, root.id, root.rootSessionId) as
      | {
      id: string;
      parent_work_item_id: string | null;
      state: WorkItemState;
      result_json: string | null;
      revision: number;
      child_revision: number | null;
        }
      | undefined;
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

  private requireDelegatedAggregationParent(parentWorkItemId: string, loaded?: WorkItem): WorkItem {
    const parent = loaded ?? this.getRequired(parentWorkItemId);
    if (parent.kind !== "delegated") {
      throw new WorkItemAggregationConflictError(
        "WORK_ITEM_AGGREGATION_PARENT_INVALID",
        "Only a delegated Work Item can own an aggregation.",
        { parentWorkItemId },
      );
    }
    return parent;
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
    proof: MutationAuthorityProof;
    operationId: string;
    idempotencyKey: string | null;
    supersedesEventId?: string;
  }): void {
    assertWorkItemEventPayloadWithinLimit(input.type, input.payload);
    const payloadJson = serializeJson(input.payload, "Work Item event payload");
    this.db
      .prepare(
        `
      INSERT INTO work_item_events_v6 (
        work_item_id, revision, event_type, actor_session_id, principal_kind, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
      input.workItemId,
      input.revision,
      input.type,
      input.actorSessionId,
      input.proof.principal.kind,
      payloadJson,
      input.createdAt,
    );
    appendWorkItemEventHeader(this.db, {
      workItemId: input.workItemId,
      revision: input.revision,
      eventKind: input.type,
      proof: input.proof,
      operationId: input.operationId,
      idempotencyKey: input.idempotencyKey,
      occurredAt: input.createdAt,
      supersedesEventId: input.supersedesEventId,
    });
  }

  private incrementAggregateRevision(parentWorkItemId: string, updatedAt: string, amount = 1): void {
    this.db
      .prepare(
        `INSERT INTO work_item_aggregations_v6 (parent_work_item_id, aggregate_revision, updated_at)
      VALUES (?, ?, ?) ON CONFLICT(parent_work_item_id) DO UPDATE SET
      aggregate_revision = aggregate_revision + excluded.aggregate_revision, updated_at = excluded.updated_at`,
      )
      .run(parentWorkItemId, amount, updatedAt);
  }

  private getDecision(childWorkItemId: string): WorkItemAggregationDecision | null {
    const row = this.db
      .prepare(`SELECT * FROM work_item_aggregation_decisions_v6 WHERE child_work_item_id = ?`)
      .get(childWorkItemId) as WorkItemAggregationDecisionRow | undefined;
    return row
      ? {
          parentWorkItemId: row.parent_work_item_id,
          childWorkItemId: row.child_work_item_id,
          revision: row.decision_revision,
          childRevision: row.child_revision,
          actorSessionId: row.actor_session_id,
          decision: row.decision_type,
          reason: row.reason,
          replacementWorkItemId: row.replacement_work_item_id,
          decidedAt: row.decided_at,
        }
      : null;
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
    this.db
      .prepare(
        `INSERT INTO work_item_aggregation_decisions_v6 (
      parent_work_item_id, child_work_item_id, decision_revision, child_revision, actor_session_id,
      decision_type, reason, replacement_work_item_id, decided_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.parentWorkItemId,
        input.child.id,
        input.expectedAggregateRevision + 1,
        input.child.revision,
        input.actorSessionId,
        input.decision,
        input.reason,
        input.replacementWorkItemId,
        input.decidedAt,
      );
  }

  resolveAggregationIdempotency(
    operation: WorkItemAggregationMutationOperation,
    proof: MutationAuthorityProof,
    key: string,
    fingerprint: string,
    observedAt: string,
  ): WorkItemAggregationDecision | null {
    this.cleanupExpiredIdempotency(observedAt);
    const principalKey = workItemPrincipalKey(proof);
    const row = this.db
      .prepare(
        `SELECT request_fingerprint, child_work_item_id, response_json FROM work_item_aggregation_idempotency_v6
      WHERE operation = ? AND principal_session_id = ? AND idempotency_key = ?`,
      )
      .get(operation, principalKey, key) as
      { request_fingerprint: string; child_work_item_id: string; response_json: string | null } | undefined;
    if (!row) {
      const legacy = this.db
        .prepare(
          `SELECT child_work_item_id FROM work_item_aggregation_idempotency_v6
        WHERE operation = ? AND principal_session_id LIKE 'legacy_unknown:%' AND idempotency_key = ? LIMIT 1`,
        )
        .get(operation, key) as { child_work_item_id: string } | undefined;
      if (legacy) {
        throw new WorkItemIdempotencyResponseUnavailableError(operation, key, legacy.child_work_item_id);
      }
      return null;
    }
    if (row.request_fingerprint !== fingerprint) throw new WorkItemIdempotencyConflictError(operation, key);
    if (row.response_json === null)
      throw new WorkItemIdempotencyResponseUnavailableError(operation, key, row.child_work_item_id);
    return JSON.parse(row.response_json) as WorkItemAggregationDecision;
  }

  private insertAggregationIdempotency(
    operation: WorkItemAggregationMutationOperation,
    input: WorkItemAggregationIdempotencyInput,
    childId: string,
    replacementId: string | null,
  ): void {
    this.db
      .prepare(
        `INSERT INTO work_item_aggregation_idempotency_v6 (
      operation, principal_session_id, idempotency_key, request_fingerprint, child_work_item_id,
      replacement_work_item_id, created_at, expires_at, response_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        operation,
        workItemPrincipalKey(input.proof),
        input.idempotencyKey,
        input.requestFingerprint,
        childId,
        replacementId,
        input.decidedAt,
        input.expiresAt,
        serializeJson(this.getDecision(childId), "Aggregation idempotency response"),
      );
  }

  private insertIdempotency(
    operation: WorkItemMutationOperation,
    proof: MutationAuthorityProof,
    idempotencyKey: string,
    requestFingerprint: string,
    workItemId: string,
    createdAt: string,
    expiresAt: string,
    response: unknown,
  ): void {
    this.db
      .prepare(
        `
      INSERT INTO work_item_idempotency_v6 (
        operation, principal_session_id, idempotency_key, request_fingerprint,
        work_item_id, response_json, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
      operation,
      workItemPrincipalKey(proof),
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
    ...(row.kind === "root" || row.predecessor_work_item_id ? { predecessorWorkItemId: row.predecessor_work_item_id ?? null } : {}),
    state: row.state,
    revision: row.revision,
    result,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.archived_at ? { archivedAt: row.archived_at } : {}),
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
    ...(item.kind === "root" && item.predecessorWorkItemId !== undefined
      ? { predecessorWorkItemId: item.predecessorWorkItemId }
      : {}),
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

function workItemOperationId(
  operation: WorkItemMutationOperation | WorkItemAggregationMutationOperation,
  proof: MutationAuthorityProof,
  requestFingerprint: string,
): string {
  return `work-item-operation:${operation}:${workItemPrincipalKey(proof)}:${requestFingerprint}`;
}

function workItemPrincipalKey(proof: MutationAuthorityProof): string {
  if (proof.principal.kind === "agent") return `agent:${proof.principal.actorSessionId}`;
  if (proof.principal.kind === "user") return "user:local-user";
  return `system:${proof.principal.service}`;
}
