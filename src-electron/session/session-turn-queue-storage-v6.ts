import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { normalizeSessionTurnClientRequestId } from "../../src-shared/session/runtime-state.js";
import type { SessionTurnQueueCapturedInput, SessionTurnQueueOwner, SessionTurnQueueReceipt, SessionTurnQueueReceiptPage, SessionTurnQueueState } from "../../src-shared/session/session-turn-queue.js";
import { ensureV6Schema } from "../storage/database-schema-v6.js";
import { openAppDatabase } from "../storage/sqlite-connection.js";
import { consumeAuxiliaryDraftInTransaction, hasWritableAuxiliaryParent } from "../auxiliary/auxiliary-session-storage.js";

type QueueRow = {
  id: string; session_id: string; auxiliary_session_id: string | null; incarnation_id: string; request_id: string; sequence: number;
  state: SessionTurnQueueState; captured_json: string; turn_id: string | null; user_message_seq: number | null;
  reason: string | null; released_at: string | null; created_at: string; updated_at: string;
  input_turn_id: string | null;
};

function toReceipt(row: QueueRow): SessionTurnQueueReceipt {
  return {
    id: row.id, sessionId: row.auxiliary_session_id ?? row.session_id, incarnationId: row.incarnation_id, requestId: row.request_id,
    sequence: row.sequence, state: row.state, captured: JSON.parse(row.captured_json) as SessionTurnQueueCapturedInput,
    turnId: row.turn_id, userMessageSeq: row.user_message_seq, reason: row.reason, releasedAt: row.released_at,
    inputTurnId: row.input_turn_id,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function capturedJson(captured: SessionTurnQueueCapturedInput): string {
  const normalized: unknown = JSON.parse(JSON.stringify(captured));
  const sort = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sort);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, sort(entry)]));
    }
    return value;
  };
  return JSON.stringify(sort(normalized));
}

export class SessionTurnQueueStorageV6 {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = openAppDatabase(dbPath);
    ensureV6Schema(this.db);
  }

  close(): void { this.db.close(); }

  enqueue(owner: SessionTurnQueueOwner, captured: SessionTurnQueueCapturedInput): SessionTurnQueueReceipt {
    const requestId = normalizeSessionTurnClientRequestId(captured.request.clientRequestId);
    if (!requestId || requestId !== captured.request.clientRequestId) throw new Error("Queue request ID is invalid.");
    const json = capturedJson(captured);
    return this.withOwner(owner, () => {
      const existing = this.db.prepare("SELECT * FROM session_turn_queue_v6 WHERE COALESCE(auxiliary_session_id, session_id) = ? AND incarnation_id = ? AND request_id = ?")
        .get(owner.sessionId, owner.incarnationId, requestId) as QueueRow | undefined;
      if (existing) {
        if (existing.captured_json !== json) throw new Error("Queue request ID was reused with a different payload.");
        return toReceipt(existing);
      }
      const id = randomUUID();
      const now = new Date().toISOString();
      const auxiliary = this.db.prepare("SELECT parent_session_id FROM auxiliary_sessions WHERE id = ? AND created_at = ?")
        .get(owner.sessionId, owner.incarnationId) as { parent_session_id: string } | undefined;
      if (auxiliary) {
        const request = captured.request;
        if (!request.auxiliaryDraftIncarnation || request.auxiliaryDraftDurableRevision === undefined) throw new Error("Auxiliary queue draft identity is required.");
        const consumed = consumeAuxiliaryDraftInTransaction(this.db, {
          auxiliarySessionId: owner.sessionId, parentSessionId: auxiliary.parent_session_id,
          incarnation: request.auxiliaryDraftIncarnation, expectedDurableRevision: request.auxiliaryDraftDurableRevision,
          expectedText: request.userMessage, allowRunningInput: true,
        });
        if (consumed.outcome !== "consumed") throw new Error("Auxiliary queue draft is stale or unavailable.");
        if (request.displayAnchorParentMessageCount !== undefined) {
          const count = request.displayAnchorParentMessageCount;
          if (!Number.isSafeInteger(count) || count < 0) throw new Error("Auxiliary display anchor is invalid.");
          this.db.prepare("UPDATE auxiliary_sessions SET display_after_message_index = COALESCE(display_after_message_index, ?) WHERE id = ?")
            .run(count === 0 ? null : count - 1, owner.sessionId);
        }
      }
      this.db.prepare(`INSERT INTO session_turn_queue_v6
        (id, session_id, auxiliary_session_id, incarnation_id, request_id, state, captured_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?)`).run(id, auxiliary?.parent_session_id ?? owner.sessionId,
          auxiliary ? owner.sessionId : null, owner.incarnationId, requestId, json, now, now);
      return this.required(owner, id);
    });
  }

  getReceipt(owner: SessionTurnQueueOwner, requestId: string): SessionTurnQueueReceipt | null {
    return this.withOwner(owner, () => {
      const row = this.db.prepare("SELECT * FROM session_turn_queue_v6 WHERE COALESCE(auxiliary_session_id, session_id) = ? AND incarnation_id = ? AND request_id = ?")
        .get(owner.sessionId, owner.incarnationId, requestId) as QueueRow | undefined;
      return row ? toReceipt(row) : null;
    });
  }

  listActive(owner: SessionTurnQueueOwner): SessionTurnQueueReceipt[] {
    return this.withOwner(owner, () => (this.db.prepare(`SELECT * FROM session_turn_queue_v6
      WHERE COALESCE(auxiliary_session_id, session_id) = ? AND incarnation_id = ? AND state IN ('queued', 'starting', 'running', 'failed', 'interrupted') ORDER BY sequence`)
      .all(owner.sessionId, owner.incarnationId) as QueueRow[]).map(toReceipt));
  }

  listReceipts(owner: SessionTurnQueueOwner, options: { cursor?: number; limit?: number } = {}): SessionTurnQueueReceiptPage {
    const cursor = options.cursor ?? 0;
    const limit = options.limit ?? 60;
    if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw new Error("Queue receipt page is invalid.");
    }
    return this.withOwner(owner, () => {
      const rows = this.db.prepare(`SELECT * FROM session_turn_queue_v6
        WHERE COALESCE(auxiliary_session_id, session_id) = ? AND incarnation_id = ? AND sequence > ? ORDER BY sequence LIMIT ?`)
        .all(owner.sessionId, owner.incarnationId, cursor, limit + 1) as QueueRow[];
      return { receipts: rows.slice(0, limit).map(toReceipt), nextCursor: rows.length > limit ? rows[limit - 1]!.sequence : null };
    });
  }

  listPendingOwners(): SessionTurnQueueOwner[] {
    return this.transaction(() => (this.db.prepare(`SELECT DISTINCT COALESCE(q.auxiliary_session_id, q.session_id) AS session_id, q.incarnation_id FROM session_turn_queue_v6 q
      JOIN sessions_v6 s ON s.id = q.session_id
      LEFT JOIN auxiliary_sessions a ON a.id = q.auxiliary_session_id AND a.parent_session_id = s.id
      WHERE ((q.auxiliary_session_id IS NULL AND s.incarnation_id = q.incarnation_id)
        OR (a.created_at = q.incarnation_id))
      AND (q.state IN ('queued', 'starting', 'running') OR (q.state = 'interrupted'
        AND (q.released_at IS NULL OR (q.input_turn_id IS NULL AND
          CASE WHEN q.auxiliary_session_id IS NULL THEN json_extract(s.runtime_policy_json, '$.runState') ELSE a.run_state END = 'running'))))`)
      .all() as Array<{ session_id: string; incarnation_id: string }>).map((row) => ({ sessionId: row.session_id, incarnationId: row.incarnation_id })));
  }

  claimNext(owner: SessionTurnQueueOwner): SessionTurnQueueReceipt | null {
    return this.withOwner(owner, () => {
      if (this.db.prepare(`SELECT 1 FROM session_turn_queue_v6 WHERE COALESCE(auxiliary_session_id, session_id) = ? AND incarnation_id = ?
        AND (state IN ('starting', 'running') OR (state = 'interrupted' AND released_at IS NULL)) LIMIT 1`).get(owner.sessionId, owner.incarnationId)) return null;
      const row = this.db.prepare(`SELECT * FROM session_turn_queue_v6 WHERE COALESCE(auxiliary_session_id, session_id) = ? AND incarnation_id = ?
        AND state = 'queued' ORDER BY sequence LIMIT 1`).get(owner.sessionId, owner.incarnationId) as QueueRow | undefined;
      if (!row) return null;
      this.db.prepare("UPDATE session_turn_queue_v6 SET state = 'starting', updated_at = ? WHERE id = ?")
        .run(new Date().toISOString(), row.id);
      return this.required(owner, row.id);
    });
  }

  markStarted(owner: SessionTurnQueueOwner, id: string, input: { turnId: string; userMessageSeq: number }): SessionTurnQueueReceipt {
    if (!input.turnId || !Number.isSafeInteger(input.userMessageSeq) || input.userMessageSeq < 0) throw new Error("Queue turn identity is invalid.");
    return this.withOwner(owner, () => {
      const receipt = this.required(owner, id);
      if (receipt.state === "running" && receipt.turnId === input.turnId && receipt.userMessageSeq === input.userMessageSeq) return receipt;
      if (receipt.state !== "starting" || receipt.inputTurnId) throw new Error("Queue receipt is not starting a normal turn.");
      this.db.prepare("UPDATE session_turn_queue_v6 SET state = 'running', turn_id = ?, user_message_seq = ?, updated_at = ? WHERE id = ?")
        .run(input.turnId, input.userMessageSeq, new Date().toISOString(), id);
      return this.required(owner, id);
    });
  }

  claimForInput(owner: SessionTurnQueueOwner, id: string, expectedTurnId: string): SessionTurnQueueReceipt {
    if (!expectedTurnId.trim()) throw new Error("Input turn identity is invalid.");
    return this.withOwner(owner, () => {
      const receipt = this.required(owner, id);
      if (receipt.state === "completed" && receipt.inputTurnId === expectedTurnId) return receipt;
      if (receipt.state !== "queued") throw new Error("Only a queued receipt can be sent as input.");
      const turn = this.db.prepare(`SELECT 1 FROM session_turns_v6 t WHERE t.phase = 'running'
        AND ((t.session_id = ? AND t.auxiliary_session_id IS NULL AND EXISTS
          (SELECT 1 FROM sessions_v6 s WHERE s.id = t.session_id AND s.incarnation_id = ?
            AND json_extract(s.runtime_policy_json, '$.runState') = 'running')
          AND t.id = (SELECT MAX(id) FROM session_turns_v6 WHERE session_id = t.session_id))
        OR (t.auxiliary_session_id = ? AND t.session_id IS NULL AND EXISTS
          (SELECT 1 FROM auxiliary_sessions a WHERE a.id = t.auxiliary_session_id AND a.created_at = ? AND a.run_state = 'running')
          AND t.id = (SELECT MAX(id) FROM session_turns_v6 WHERE auxiliary_session_id = t.auxiliary_session_id)))`)
        .get(owner.sessionId, owner.incarnationId, owner.sessionId, owner.incarnationId);
      if (!turn) throw new Error("The current running turn no longer matches.");
      const result = this.db.prepare(`UPDATE session_turn_queue_v6 SET state = 'starting', input_turn_id = ?, updated_at = ?
        WHERE id = ? AND state = 'queued'`).run(expectedTurnId, new Date().toISOString(), id);
      if (Number(result.changes) !== 1) throw new Error("The queued input could not be claimed.");
      return this.required(owner, id);
    });
  }

  restoreQueuedInput(owner: SessionTurnQueueOwner, id: string, expectedTurnId: string): SessionTurnQueueReceipt {
    return this.withOwner(owner, () => {
      const receipt = this.required(owner, id);
      if (receipt.state !== "starting" || receipt.inputTurnId !== expectedTurnId
        || receipt.userMessageSeq !== null || receipt.turnId !== null) throw new Error("The queued input cannot be restored.");
      this.db.prepare(`UPDATE session_turn_queue_v6 SET state = 'queued', input_turn_id = NULL, updated_at = ? WHERE id = ?`)
        .run(new Date().toISOString(), id);
      return this.required(owner, id);
    });
  }

  settle(owner: SessionTurnQueueOwner, id: string, state: Extract<SessionTurnQueueState, "completed" | "failed" | "canceled" | "interrupted">, reason?: string): SessionTurnQueueReceipt {
    if (!["completed", "failed", "canceled", "interrupted"].includes(state)) throw new Error("Queue settlement state is invalid.");
    return this.withOwner(owner, () => {
      const receipt = this.required(owner, id);
      if (["completed", "failed", "canceled"].includes(receipt.state) && (receipt.state === state || state === "interrupted")) return receipt;
      if (receipt.state !== "starting" && receipt.state !== "running") throw new Error("Queue receipt is not executing.");
      this.db.prepare("UPDATE session_turn_queue_v6 SET state = ?, reason = ?, updated_at = ? WHERE id = ?")
        .run(state, reason ?? null, new Date().toISOString(), id);
      return this.required(owner, id);
    });
  }

  cancelQueued(owner: SessionTurnQueueOwner, id: string): SessionTurnQueueReceipt {
    return this.withOwner(owner, () => {
      if (this.required(owner, id).state !== "queued") throw new Error("Only a queued receipt can be canceled.");
      this.db.prepare("UPDATE session_turn_queue_v6 SET state = 'canceled', updated_at = ? WHERE id = ?").run(new Date().toISOString(), id);
      return this.required(owner, id);
    });
  }

  recoverInterrupted(): number {
    return this.transaction(() => Number(this.db.prepare(`UPDATE session_turn_queue_v6
      SET state = 'interrupted', reason = 'Execution outcome is unknown after interruption.', updated_at = ?
      WHERE state IN ('starting', 'running') AND EXISTS (
        SELECT 1 FROM sessions_v6 s LEFT JOIN auxiliary_sessions a ON a.id = session_turn_queue_v6.auxiliary_session_id
        WHERE s.id = session_turn_queue_v6.session_id AND
          ((session_turn_queue_v6.auxiliary_session_id IS NULL AND s.incarnation_id = session_turn_queue_v6.incarnation_id)
          OR (a.parent_session_id = s.id AND a.created_at = session_turn_queue_v6.incarnation_id))
      )`).run(new Date().toISOString()).changes));
  }

  releaseInterrupted(owner: SessionTurnQueueOwner, id: string, options?: { runReleased: boolean }): SessionTurnQueueReceipt {
    return this.withOwner(owner, () => {
      const receipt = this.required(owner, id);
      if (["completed", "failed", "canceled"].includes(receipt.state)) return receipt;
      if (receipt.state !== "interrupted") throw new Error("Queue receipt is not interrupted.");
      const now = new Date().toISOString();
      if (receipt.releasedAt === null) {
        this.db.prepare("UPDATE session_turn_queue_v6 SET released_at = ?, updated_at = ? WHERE id = ?").run(now, now, id);
      }
      if (options?.runReleased === true && !receipt.inputTurnId && receipt.turnId !== null && receipt.userMessageSeq !== null) {
        this.db.prepare(`UPDATE sessions_v6
          SET runtime_policy_json = json_set(runtime_policy_json, '$.appStatus', 'idle', '$.runState', 'interrupted')
          WHERE id = ? AND incarnation_id = ?
            AND json_extract(runtime_policy_json, '$.appStatus') = 'running'
            AND json_extract(runtime_policy_json, '$.runState') = 'running'
            AND EXISTS (SELECT 1 FROM session_turns_v6 t WHERE CAST(t.id AS TEXT) = ?
              AND t.session_id = sessions_v6.id AND t.auxiliary_session_id IS NULL
              AND t.phase = 'running' AND t.user_message_seq = ?
              AND t.id = (SELECT MAX(id) FROM session_turns_v6 WHERE session_id = sessions_v6.id))`)
          .run(owner.sessionId, owner.incarnationId, receipt.turnId, receipt.userMessageSeq);
        this.db.prepare(`UPDATE auxiliary_sessions SET run_state = 'error'
          WHERE id = ? AND created_at = ? AND run_state = 'running'
          AND EXISTS (SELECT 1 FROM session_turns_v6 t WHERE CAST(t.id AS TEXT) = ?
            AND t.auxiliary_session_id = auxiliary_sessions.id AND t.session_id IS NULL
            AND t.phase = 'running' AND t.user_message_seq = ?
            AND t.id = (SELECT MAX(id) FROM session_turns_v6 WHERE auxiliary_session_id = auxiliary_sessions.id))`)
          .run(owner.sessionId, owner.incarnationId, receipt.turnId, receipt.userMessageSeq);
      }
      return this.required(owner, id);
    });
  }

  private required(owner: SessionTurnQueueOwner, id: string): SessionTurnQueueReceipt {
    const row = this.db.prepare("SELECT * FROM session_turn_queue_v6 WHERE id = ? AND COALESCE(auxiliary_session_id, session_id) = ? AND incarnation_id = ?")
      .get(id, owner.sessionId, owner.incarnationId) as QueueRow | undefined;
    if (!row) throw new Error("Queue receipt not found or owner mismatch.");
    return toReceipt(row);
  }

  private withOwner<T>(owner: SessionTurnQueueOwner, run: () => T): T {
    return this.transaction(() => {
      const main = this.db.prepare("SELECT 1 FROM sessions_v6 WHERE id = ? AND incarnation_id = ?").get(owner.sessionId, owner.incarnationId);
      const auxiliary = this.db.prepare("SELECT parent_session_id FROM auxiliary_sessions WHERE id = ? AND created_at = ?")
        .get(owner.sessionId, owner.incarnationId) as { parent_session_id: string } | undefined;
      if (!owner.sessionId || !owner.incarnationId || (!main && !auxiliary)
        || !hasWritableAuxiliaryParent(this.db, auxiliary?.parent_session_id ?? owner.sessionId)) throw new Error("Queue session not found or incarnation mismatch.");
      return run();
    });
  }

  private transaction<T>(run: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
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
