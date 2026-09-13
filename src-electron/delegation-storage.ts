import type { DatabaseSync } from "node:sqlite";

import type {
  Delegation,
  DelegationItem,
  DelegationState,
} from "../src/delegation.js";
import { ensureV6Schema } from "./database-schema-v6.js";
import { openAppDatabase } from "./sqlite-connection.js";
import type { MutationAuthorityProof } from "../src/session-authority.js";
import { SessionRuntimeValidationError, type SessionRuntimeOperation } from "../src/session-external-runtime-contract.js";
import { assertGrantProofCurrent } from "./session-authority-storage.js";
import { ResourceBudgetStorage } from "./resource-budget-storage.js";

export type DelegationPending = { itemIndex: number; operation: SessionRuntimeOperation; input: unknown; startedAt: string };
export type DelegationLastMutation = { operation: string; input: unknown; result: Delegation | null };

type DelegationRow = {
  id: string;
  revision: number;
  actor_session_id: string;
  idempotency_key: string;
  state: DelegationState;
  request_json: string;
  items_json: string;
  recovery_actions_json: string;
  created_at: string;
  updated_at: string;
  last_mutation_json: string;
  pending_json: string | null;
};

export class DelegationNotFoundError extends Error {
  readonly code = "DELEGATION_NOT_FOUND";
  constructor(readonly delegationId: string) {
    super(`Delegation was not found: ${delegationId}`);
  }
}

export class DelegationOwnerError extends Error {
  readonly code = "DELEGATION_OWNER_MISMATCH";
  constructor(readonly delegationId: string) {
    super(`Delegation is not owned by the actor Session: ${delegationId}`);
  }
}

export class DelegationRevisionError extends Error {
  readonly code = "DELEGATION_REVISION_CONFLICT";
  constructor(readonly delegationId: string, readonly expectedRevision: number, readonly actualRevision: number) {
    super(`Delegation revision is stale: ${delegationId}`);
  }
}

export class DelegationStorage {
  readonly #db: DatabaseSync;
  readonly #ownsConnection: boolean;

  constructor(dbPath: string, db?: DatabaseSync) {
    this.#db = db ?? openAppDatabase(dbPath);
    this.#ownsConnection = !db;
    try { ensureV6Schema(this.#db); } catch (error) { if (this.#ownsConnection) this.#db.close(); throw error; }
  }

  close(): void {
    if (this.#ownsConnection) this.#db.close();
  }

  create(input: {
    id: string;
    actorSessionId: string;
    state: DelegationState;
    idempotencyKey: string;
    request: unknown;
    items: DelegationItem[];
    recoveryActions: Delegation["recoveryActions"];
    createdAt: string;
    proof: MutationAuthorityProof;
    pending?: DelegationPending | null;
  }): Delegation {
    this.#db.exec("BEGIN IMMEDIATE TRANSACTION;");
    try {
      assertGrantProofCurrent(this.#db, input.proof, new Date(input.createdAt));
      new ResourceBudgetStorage(this.#db).consumeCount({ sessionId: input.actorSessionId, dimension: "delegations", idempotencyKey: `delegation:${input.id}`, consumedAt: input.createdAt });
    const row = {
      id: input.id,
      revision: 1,
      actor_session_id: input.actorSessionId,
      idempotency_key: input.idempotencyKey,
      state: input.state,
      request_json: JSON.stringify(input.request),
      items_json: JSON.stringify(input.items),
      recovery_actions_json: JSON.stringify(input.recoveryActions),
      created_at: input.createdAt,
      updated_at: input.createdAt,
      last_mutation_json: "null",
      pending_json: input.pending ? JSON.stringify(input.pending) : null,
    };
    this.#db.prepare(`
      INSERT INTO delegations_v6
        (id, revision, actor_session_id, idempotency_key, state, request_json, items_json, pending_json, recovery_actions_json, last_mutation_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(row.id, row.revision, row.actor_session_id, row.idempotency_key, row.state, row.request_json, row.items_json, row.pending_json, row.recovery_actions_json, row.last_mutation_json, row.created_at, row.updated_at);
    this.#db.exec("COMMIT;");
    return this.toPublic(row);
    } catch (error) { try { this.#db.exec("ROLLBACK;"); } catch {} throw error; }
  }

  get(id: string, actorSessionId: string): Delegation {
    const row = this.#db.prepare("SELECT * FROM delegations_v6 WHERE id = ?").get(id) as DelegationRow | undefined;
    if (!row) throw new DelegationNotFoundError(id);
    if (row.actor_session_id !== actorSessionId) throw new DelegationOwnerError(id);
    return this.toPublic(row);
  }

  getInternal(id: string, actorSessionId: string): { delegation: Delegation; pending: DelegationPending | null; lastMutation: DelegationLastMutation | null } {
    const row = this.#db.prepare("SELECT * FROM delegations_v6 WHERE id = ?").get(id) as DelegationRow | undefined;
    if (!row) throw new DelegationNotFoundError(id);
    if (row.actor_session_id !== actorSessionId) throw new DelegationOwnerError(id);
    return { delegation: this.toPublic(row), pending: row.pending_json ? JSON.parse(row.pending_json) as DelegationPending : null, lastMutation: JSON.parse(row.last_mutation_json) as DelegationLastMutation };
  }

  getRequestJson(id: string, actorSessionId: string): string {
    const row = this.#db.prepare("SELECT actor_session_id, request_json FROM delegations_v6 WHERE id = ?").get(id) as { actor_session_id: string; request_json: string } | undefined;
    if (!row) throw new DelegationNotFoundError(id);
    if (row.actor_session_id !== actorSessionId) throw new DelegationOwnerError(id);
    return row.request_json;
  }

  findByIdempotencyKey(actorSessionId: string, idempotencyKey: string): Delegation | null {
    const row = this.#db.prepare("SELECT * FROM delegations_v6 WHERE actor_session_id = ? AND idempotency_key = ?").get(actorSessionId, idempotencyKey) as DelegationRow | undefined;
    return row ? this.toPublic(row) : null;
  }

  list(actorSessionId: string, limit: number, cursor?: string): { items: Delegation[]; nextCursor?: string } {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new SessionRuntimeValidationError("Invalid delegation list limit.", { field: "limit" });
    const safeLimit = limit;
    if (cursor !== undefined && (cursor.split("\u0000").length !== 2 || !cursor.split("\u0000")[1] || !Number.isFinite(Date.parse(cursor.split("\u0000")[0])))) throw new SessionRuntimeValidationError("Invalid delegation cursor.", { field: "cursor" });
    const [cursorTime, cursorId] = cursor ? cursor.split("\u0000", 2) : [null, null];
    const rows = this.#db.prepare(`
      SELECT * FROM delegations_v6
      WHERE actor_session_id = ? AND (? IS NULL OR (updated_at < ? OR (updated_at = ? AND id < ?)))
      ORDER BY updated_at DESC, id DESC LIMIT ?
    `).all(actorSessionId, cursorTime, cursorTime, cursorTime, cursorId, safeLimit + 1) as unknown as DelegationRow[];
    const items = rows.slice(0, safeLimit).map((row) => this.toPublic(row));
    const last = rows[safeLimit - 1];
    return rows.length > safeLimit && last ? { items, nextCursor: `${last.updated_at}\u0000${last.id}` } : { items };
  }

  update(input: {
    id: string;
    actorSessionId: string;
    expectedRevision: number;
    state?: DelegationState;
    items?: DelegationItem[];
    recoveryActions?: Delegation["recoveryActions"];
    updatedAt: string;
    pending?: DelegationPending | null;
    lastMutation?: DelegationLastMutation | null;
    proof?: MutationAuthorityProof;
  }): Delegation {
    this.#db.exec("BEGIN IMMEDIATE TRANSACTION;");
    try {
      const current = this.#db.prepare("SELECT * FROM delegations_v6 WHERE id = ?").get(input.id) as DelegationRow | undefined;
      if (!current) throw new DelegationNotFoundError(input.id);
      if (current.actor_session_id !== input.actorSessionId) throw new DelegationOwnerError(input.id);
      if (current.revision !== input.expectedRevision) throw new DelegationRevisionError(input.id, input.expectedRevision, current.revision);
      if (input.proof) assertGrantProofCurrent(this.#db, input.proof, new Date(input.updatedAt));
      const nextRevision = current.revision + 1;
      const result = this.#db.prepare(`
        UPDATE delegations_v6
        SET revision = ?, state = ?, items_json = ?, pending_json = ?, recovery_actions_json = ?, last_mutation_json = ?, updated_at = ?
        WHERE id = ? AND actor_session_id = ? AND revision = ?
      `).run(
        nextRevision,
        input.state ?? current.state,
        JSON.stringify(input.items ?? JSON.parse(current.items_json)),
        input.pending === undefined ? current.pending_json : input.pending === null ? null : JSON.stringify(input.pending),
        JSON.stringify(input.recoveryActions ?? JSON.parse(current.recovery_actions_json)),
        input.lastMutation === undefined ? current.last_mutation_json : JSON.stringify(input.lastMutation),
        input.updatedAt,
        input.id,
        input.actorSessionId,
        input.expectedRevision,
      );
      if (Number((result as { changes?: number }).changes ?? 0) !== 1) throw new DelegationRevisionError(input.id, input.expectedRevision, current.revision);
      const updated = this.get(input.id, input.actorSessionId);
      this.#db.exec("COMMIT;");
      return updated;
    } catch (error) { try { this.#db.exec("ROLLBACK;"); } catch {} throw error; }
  }

  hasOtherConsumer(delegationId: string, sessionId: string | null, workItemId: string | null): boolean {
    const row = this.#db.prepare(`
      SELECT 1 FROM delegations_v6 AS d, json_each(d.request_json, '$.items') AS item
      WHERE d.id <> ?
        AND (? IS NOT NULL AND json_extract(item.value, '$.target.sessionId') = ?
          OR ? IS NOT NULL AND json_extract(item.value, '$.work.workItemId') = ?)
      LIMIT 1
    `).get(delegationId, sessionId, sessionId, workItemId, workItemId);
    return row !== undefined;
  }

  private toPublic(row: DelegationRow): Delegation {
    return {
      id: row.id,
      revision: row.revision,
      state: row.state,
      items: JSON.parse(row.items_json) as DelegationItem[],
      recoveryActions: JSON.parse(row.recovery_actions_json) as Delegation["recoveryActions"],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
