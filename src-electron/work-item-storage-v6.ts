import type { DatabaseSync } from "node:sqlite";

import {
  WORK_ITEM_CONTRACT_REVISION,
  WORK_ITEM_MAX_RESULT_BYTES,
  canTransitionWorkItem,
  isWorkItemResultState,
  type WorkItem,
  type WorkItemBinding,
  type WorkItemResult,
  type WorkItemState,
} from "../src/work-item.js";
import { ensureV6Schema } from "./database-schema-v6.js";
import { openAppDatabase } from "./sqlite-connection.js";

export type WorkItemMutationOperation = "work.create" | "work.transition" | "work.result" | "work.cancel";

type WorkItemRow = {
  sequence: number;
  id: string;
  contract_revision: number;
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
  created_at: string;
  updated_at: string;
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
  constructor(readonly operation: WorkItemMutationOperation, readonly idempotencyKey: string) {
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
      SELECT request_fingerprint, work_item_id
      FROM work_item_idempotency_v6
      WHERE operation = ? AND principal_session_id = ? AND idempotency_key = ?
    `).get(operation, principalSessionId, idempotencyKey) as
      | { request_fingerprint: string; work_item_id: string }
      | undefined;
    if (!row) return null;
    if (row.request_fingerprint !== requestFingerprint) {
      throw new WorkItemIdempotencyConflictError(operation, idempotencyKey);
    }
    return this.getRequired(row.work_item_id);
  }

  create(input: {
    id: string;
    binding: WorkItemBinding;
    principalSessionId: string;
    idempotencyKey: string;
    requestFingerprint: string;
    createdAt: string;
    expiresAt: string;
  }): WorkItem {
    return this.transaction(() => {
      const replay = this.resolveIdempotency(
        "work.create",
        input.principalSessionId,
        input.idempotencyKey,
        input.requestFingerprint,
        input.createdAt,
      );
      if (replay) return replay;
      this.db.prepare(`
        INSERT INTO work_items_v6 (
          id, contract_revision, root_session_id, creator_session_id, target_session_id,
          parent_work_item_id, goal, scope, completion_criteria, authority,
          source_identity_json, state, revision, created_at, updated_at
        ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 1, ?, ?)
      `).run(
        input.id,
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
      this.insertIdempotency(
        "work.create",
        input.principalSessionId,
        input.idempotencyKey,
        input.requestFingerprint,
        input.id,
        input.createdAt,
        input.expiresAt,
      );
      return this.getRequired(input.id);
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
      this.insertIdempotency(
        input.operation,
        input.principalSessionId,
        input.idempotencyKey,
        input.requestFingerprint,
        input.workItemId,
        input.updatedAt,
        input.expiresAt,
      );
      return this.getRequired(input.workItemId);
    });
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

  cleanupExpiredIdempotency(expiredBeforeOrAt: string): number {
    const result = this.db.prepare(`
      DELETE FROM work_item_idempotency_v6
      WHERE expires_at <= ?
    `).run(expiredBeforeOrAt);
    return Number(result.changes);
  }

  close(): void {
    this.db.close();
  }

  private getRequired(workItemId: string): WorkItem {
    const item = this.get(workItemId);
    if (!item) throw new WorkItemNotFoundError(workItemId);
    return item;
  }

  private insertIdempotency(
    operation: WorkItemMutationOperation,
    principalSessionId: string,
    idempotencyKey: string,
    requestFingerprint: string,
    workItemId: string,
    createdAt: string,
    expiresAt: string,
  ): void {
    this.db.prepare(`
      INSERT INTO work_item_idempotency_v6 (
        operation, principal_session_id, idempotency_key, request_fingerprint,
        work_item_id, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(operation, principalSessionId, idempotencyKey, requestFingerprint, workItemId, createdAt, expiresAt);
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
  return {
    id: row.id,
    sequence: row.sequence,
    contractRevision: WORK_ITEM_CONTRACT_REVISION,
    rootSessionId: row.root_session_id,
    creatorSessionId: row.creator_session_id,
    targetSessionId: row.target_session_id,
    parentWorkItemId: row.parent_work_item_id,
    goal: row.goal,
    scope: row.scope,
    completionCriteria: row.completion_criteria,
    authority: row.authority,
    sourceIdentity: JSON.parse(row.source_identity_json) as WorkItem["sourceIdentity"],
    state: row.state,
    revision: row.revision,
    result,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  } as WorkItem;
}

function serializeJson(value: unknown, label: string): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError(`${label} must be JSON serializable.`);
  return serialized;
}
