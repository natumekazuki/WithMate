import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { normalizeSessionTurnClientRequestId } from "../../src-shared/session/runtime-state.js";
import type { SessionTurnQueueCapturedInput, SessionTurnQueueOwner, SessionTurnQueueReceipt, SessionTurnQueueReceiptPage, SessionTurnQueueState, SessionTurnQueueReorderResult } from "../../src-shared/session/session-turn-queue.js";
import { ensureV6Schema } from "../storage/database-schema-v6.js";
import { openAppDatabase } from "../storage/sqlite-connection.js";
import { consumeAuxiliaryDraftInTransaction, hasWritableAuxiliaryParent } from "../auxiliary/auxiliary-session-storage.js";
import { assertSessionLifecycleReady } from "./session-lifecycle-operation.js";
import { coordinationDispatchJson } from "../coordination/coordination-dispatch.js";

type QueueRow = {
  id: string; session_id: string; auxiliary_session_id: string | null; incarnation_id: string; request_id: string; sequence: number;
  state: SessionTurnQueueState; captured_json: string; turn_id: string | null; user_message_seq: number | null;
  reason: string | null; released_at: string | null; created_at: string; updated_at: string;
  input_turn_id: string | null; queue_position: number;
  accepted_json: string | null; dispatched_json: string | null;
};

// The exact source Turn and current incarnation, never the sender's latest Turn.
const sourceTurnPhaseSql = `(SELECT CASE WHEN t.phase = 'running' THEN
    CASE WHEN json_extract(s.runtime_policy_json, '$.runState') = 'running' THEN 'running' ELSE 'unknown' END
  WHEN t.completed_at IS NOT NULL THEN t.phase ELSE 'unknown' END
  FROM session_turns_v6 t JOIN sessions_v6 s ON s.id = t.session_id
  WHERE t.id = json_extract(q.accepted_json, '$.origin.actorTurnId')
    AND t.session_id = json_extract(q.accepted_json, '$.origin.actorSessionId') AND t.auxiliary_session_id IS NULL
    AND s.incarnation_id = json_extract(q.accepted_json, '$.origin.actorIncarnationId')
    AND json_extract(q.accepted_json, '$.origin.kind') = 'session'
    AND json_extract(q.accepted_json, '$.origin.actorKind') = 'main')`;
const eligibleDeliverySql = `(COALESCE(json_extract(q.accepted_json, '$.origin.deliveryTiming'), 'immediate') = 'immediate'
  OR ${sourceTurnPhaseSql} IN ('completed', 'failed', 'canceled'))`;

function toReceipt(row: QueueRow): SessionTurnQueueReceipt {
  return {
    id: row.id, sessionId: row.auxiliary_session_id ?? row.session_id, incarnationId: row.incarnation_id, requestId: row.request_id,
    sequence: row.sequence, queuePosition: row.queue_position, state: row.state, captured: JSON.parse(row.captured_json) as SessionTurnQueueCapturedInput,
    accepted: row.accepted_json ? JSON.parse(row.accepted_json) as SessionTurnQueueCapturedInput : null,
    dispatched: row.dispatched_json ? JSON.parse(row.dispatched_json) as SessionTurnQueueCapturedInput : null,
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

  constructor(dbPath: string | DatabaseSync) {
    this.db = typeof dbPath === "string" ? openAppDatabase(dbPath) : dbPath;
    if (typeof dbPath === "string") ensureV6Schema(this.db);
  }

  close(): void { this.db.close(); }

  enqueue(owner: SessionTurnQueueOwner, captured: SessionTurnQueueCapturedInput): SessionTurnQueueReceipt {
    const requestId = normalizeSessionTurnClientRequestId(captured.request.clientRequestId);
    if (!requestId || requestId !== captured.request.clientRequestId) throw new Error("Queue request ID is invalid.");
    const json = capturedJson(captured);
    return this.withOwner(owner, () => {
      const target = this.db.prepare("SELECT parent_session_id FROM auxiliary_sessions WHERE id = ? AND created_at = ?")
        .get(owner.sessionId, owner.incarnationId) as { parent_session_id: string } | undefined;
      assertSessionLifecycleReady(this.db, target?.parent_session_id ?? owner.sessionId);
      const existing = this.db.prepare("SELECT * FROM session_turn_queue_v6 WHERE COALESCE(auxiliary_session_id, session_id) = ? AND incarnation_id = ? AND request_id = ?")
        .get(owner.sessionId, owner.incarnationId, requestId) as QueueRow | undefined;
      if (existing) {
        if (existing.accepted_json === null) throw new Error("The original queue acceptance input is unavailable; query its receipt instead.");
        if (existing.accepted_json !== json) throw new Error("Queue request ID was reused with a different payload.");
        return this.toReceipt(existing);
      }
      const id = randomUUID();
      const now = new Date().toISOString();
      const auxiliary = target;
      if (auxiliary) {
        const request = captured.request;
        if (request.submitSource !== "retry") {
          if (!request.auxiliaryDraftIncarnation || request.auxiliaryDraftDurableRevision === undefined) throw new Error("Auxiliary queue draft identity is required.");
          const consumed = consumeAuxiliaryDraftInTransaction(this.db, {
            auxiliarySessionId: owner.sessionId, parentSessionId: auxiliary.parent_session_id,
            incarnation: request.auxiliaryDraftIncarnation, expectedDurableRevision: request.auxiliaryDraftDurableRevision,
            expectedText: request.userMessage, allowRunningInput: true,
          });
          if (consumed.outcome !== "consumed") throw new Error("Auxiliary queue draft is stale or unavailable.");
        }
        if (request.displayAnchorParentMessageCount !== undefined) {
          const count = request.displayAnchorParentMessageCount;
          if (!Number.isSafeInteger(count) || count < 0) throw new Error("Auxiliary display anchor is invalid.");
          this.db.prepare("UPDATE auxiliary_sessions SET display_after_message_index = COALESCE(display_after_message_index, ?) WHERE id = ?")
            .run(count === 0 ? null : count - 1, owner.sessionId);
        }
      }
      this.db.prepare(`INSERT INTO session_turn_queue_v6
        (id, session_id, auxiliary_session_id, incarnation_id, request_id, state, captured_json, accepted_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`).run(id, auxiliary?.parent_session_id ?? owner.sessionId,
          auxiliary ? owner.sessionId : null, owner.incarnationId, requestId, json, json, now, now);
      this.db.prepare("UPDATE session_turn_queue_v6 SET queue_position = sequence WHERE id = ?").run(id);
      return this.required(owner, id);
    });
  }

  getReceipt(owner: SessionTurnQueueOwner, requestId: string): SessionTurnQueueReceipt | null {
    return this.withOwner(owner, () => {
      const row = this.db.prepare("SELECT * FROM session_turn_queue_v6 WHERE COALESCE(auxiliary_session_id, session_id) = ? AND incarnation_id = ? AND request_id = ?")
        .get(owner.sessionId, owner.incarnationId, requestId) as QueueRow | undefined;
      return row ? this.toReceipt(row) : null;
    });
  }

  listActive(owner: SessionTurnQueueOwner): SessionTurnQueueReceipt[] {
    return this.withOwner(owner, () => (this.db.prepare(`SELECT * FROM session_turn_queue_v6
      WHERE COALESCE(auxiliary_session_id, session_id) = ? AND incarnation_id = ? AND state IN ('queued', 'starting', 'running', 'failed', 'interrupted') ORDER BY queue_position, sequence`)
      .all(owner.sessionId, owner.incarnationId) as QueueRow[]).map((row) => this.toReceipt(row)));
  }

  getReceiptById(owner: SessionTurnQueueOwner, id: string): SessionTurnQueueReceipt | null {
    return this.withOwner(owner, () => {
      const row = this.db.prepare("SELECT * FROM session_turn_queue_v6 WHERE id = ? AND COALESCE(auxiliary_session_id, session_id) = ? AND incarnation_id = ?")
        .get(id, owner.sessionId, owner.incarnationId) as QueueRow | undefined;
      return row ? this.toReceipt(row) : null;
    });
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
      return { receipts: rows.slice(0, limit).map((row) => this.toReceipt(row)), nextCursor: rows.length > limit ? rows[limit - 1]!.sequence : null };
    });
  }

  listPendingOwners(sourceSessionId?: string): SessionTurnQueueOwner[] {
    return this.transaction(() => (this.db.prepare(`SELECT DISTINCT COALESCE(q.auxiliary_session_id, q.session_id) AS session_id, q.incarnation_id FROM session_turn_queue_v6 q
      JOIN sessions_v6 s ON s.id = q.session_id
      LEFT JOIN auxiliary_sessions a ON a.id = q.auxiliary_session_id AND a.parent_session_id = s.id
      WHERE ((q.auxiliary_session_id IS NULL AND s.incarnation_id = q.incarnation_id)
        OR (a.created_at = q.incarnation_id))
      AND (q.state IN ('queued', 'starting', 'running') OR (q.state = 'interrupted'
        AND (q.released_at IS NULL OR (q.input_turn_id IS NULL AND
          CASE WHEN q.auxiliary_session_id IS NULL THEN json_extract(s.runtime_policy_json, '$.runState') ELSE a.run_state END = 'running'))))
      ${sourceSessionId === undefined ? "" : `AND q.state = 'queued'
        AND json_extract(q.accepted_json, '$.origin.deliveryTiming') = 'after_source_turn'
        AND json_extract(q.accepted_json, '$.origin.actorKind') = 'main'
        AND json_extract(q.accepted_json, '$.origin.actorSessionId') = ?`}`)
      .all(...(sourceSessionId === undefined ? [] : [sourceSessionId])) as Array<{ session_id: string; incarnation_id: string }>).map((row) => ({ sessionId: row.session_id, incarnationId: row.incarnation_id })));
  }

  claimNext(owner: SessionTurnQueueOwner, unreleasedSourceTurnIds: readonly string[] = []): SessionTurnQueueReceipt | null {
    return this.withOwner(owner, () => {
      if (this.db.prepare(`SELECT 1 FROM session_turn_queue_v6 WHERE COALESCE(auxiliary_session_id, session_id) = ? AND incarnation_id = ?
        AND (state IN ('starting', 'running') OR (state = 'interrupted' AND released_at IS NULL)) LIMIT 1`).get(owner.sessionId, owner.incarnationId)) return null;
      const row = this.db.prepare(`SELECT q.* FROM session_turn_queue_v6 q WHERE COALESCE(q.auxiliary_session_id, q.session_id) = ? AND q.incarnation_id = ?
        AND q.state = 'queued' AND ${eligibleDeliverySql}
        ${unreleasedSourceTurnIds.length ? `AND (COALESCE(json_extract(q.accepted_json, '$.origin.deliveryTiming'), 'immediate') = 'immediate'
          OR json_extract(q.accepted_json, '$.origin.actorTurnId') NOT IN (${unreleasedSourceTurnIds.map(() => "?").join(",")}))` : ""}
        ORDER BY q.queue_position, q.sequence LIMIT 1`).get(owner.sessionId, owner.incarnationId, ...unreleasedSourceTurnIds) as QueueRow | undefined;
      if (!row) return null;
      const captured = JSON.parse(coordinationDispatchJson(this.db, row.captured_json)) as SessionTurnQueueCapturedInput;
      const sourceTurnPhase = this.toReceipt(row).sourceTurnPhase;
      if (captured.origin?.deliveryTiming === "after_source_turn" && sourceTurnPhase && sourceTurnPhase !== "running" && sourceTurnPhase !== "unknown") {
        captured.origin = { ...captured.origin, sourceTurnPhase };
      }
      this.db.prepare("UPDATE session_turn_queue_v6 SET state = 'starting', dispatched_json = ?, updated_at = ? WHERE id = ?")
        .run(capturedJson(captured), new Date().toISOString(), row.id);
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

  claimForInput(owner: SessionTurnQueueOwner, id: string, expectedTurnId: string, unreleasedSourceTurnIds: readonly string[] = []): SessionTurnQueueReceipt {
    if (!expectedTurnId.trim()) throw new Error("Input turn identity is invalid.");
    return this.withOwner(owner, () => {
      const receipt = this.required(owner, id);
      if (receipt.state === "completed" && receipt.inputTurnId === expectedTurnId) return receipt;
      if (receipt.state !== "queued") throw new Error("Only a queued receipt can be sent as input.");
      if (receipt.sourceTurnPhase === "running" || receipt.sourceTurnPhase === "unknown") throw new Error("The sender Turn has not confirmed its saved terminal state.");
      if (receipt.accepted?.origin?.deliveryTiming === "after_source_turn" && unreleasedSourceTurnIds.includes(receipt.accepted.origin.actorTurnId!)) {
        throw new Error("The sender Turn is still releasing its execution.");
      }
      const turn = this.db.prepare(`SELECT t.id FROM session_turns_v6 t WHERE t.phase = 'running'
        AND ((t.session_id = ? AND t.auxiliary_session_id IS NULL AND EXISTS
          (SELECT 1 FROM sessions_v6 s WHERE s.id = t.session_id AND s.incarnation_id = ?
            AND json_extract(s.runtime_policy_json, '$.runState') = 'running')
          AND t.id = (SELECT MAX(id) FROM session_turns_v6 WHERE session_id = t.session_id))
        OR (t.auxiliary_session_id = ? AND t.session_id IS NULL AND EXISTS
          (SELECT 1 FROM auxiliary_sessions a WHERE a.id = t.auxiliary_session_id AND a.created_at = ? AND a.run_state = 'running')
          AND t.id = (SELECT MAX(id) FROM session_turns_v6 WHERE auxiliary_session_id = t.auxiliary_session_id)))`)
        .get(owner.sessionId, owner.incarnationId, owner.sessionId, owner.incarnationId) as { id: number } | undefined;
      if (!turn) throw new Error("The current running turn no longer matches.");
      if (receipt.captured.coordination) throw new Error("Coordination delivery requires a new normal Turn.");
      const captured = receipt.captured.origin?.deliveryTiming === "after_source_turn" && receipt.sourceTurnPhase
        ? { ...receipt.captured, origin: { ...receipt.captured.origin, sourceTurnPhase: receipt.sourceTurnPhase as "completed" | "failed" | "canceled" } } : receipt.captured;
      const result = this.db.prepare(`UPDATE session_turn_queue_v6 SET state = 'starting', dispatched_json = ?, turn_id = ?, input_turn_id = ?, updated_at = ?
        WHERE id = ? AND state = 'queued'`).run(capturedJson(captured), String(turn.id), expectedTurnId, new Date().toISOString(), id);
      if (Number(result.changes) !== 1) throw new Error("The queued input could not be claimed.");
      return this.required(owner, id);
    });
  }

  restoreQueuedInput(owner: SessionTurnQueueOwner, id: string, expectedTurnId: string): SessionTurnQueueReceipt {
    return this.withOwner(owner, () => {
      const receipt = this.required(owner, id);
      if (receipt.state !== "starting" || receipt.inputTurnId !== expectedTurnId
        || receipt.userMessageSeq !== null) throw new Error("The queued input cannot be restored.");
      this.db.prepare(`UPDATE session_turn_queue_v6 SET state = 'queued', turn_id = NULL, input_turn_id = NULL, dispatched_json = NULL, updated_at = ? WHERE id = ?`)
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
      const receipt = this.required(owner, id);
      // A cancellation names this receipt only; a dispatch race never becomes a Turn stop.
      if (receipt.state !== "queued") return receipt;
      this.db.prepare("UPDATE session_turn_queue_v6 SET state = 'canceled', updated_at = ? WHERE id = ?").run(new Date().toISOString(), id);
      return this.required(owner, id);
    });
  }

  updateQueued(owner: SessionTurnQueueOwner, id: string, input: { userMessage: string; attachments: SessionTurnQueueCapturedInput["attachments"] }): SessionTurnQueueReceipt {
    if (typeof input.userMessage !== "string" || !input.userMessage.trim()) throw new Error("A queued message is required.");
    return this.withOwner(owner, () => {
      const receipt = this.required(owner, id);
      if (receipt.state !== "queued") throw new Error("Only a queued receipt can be edited.");
      if (receipt.captured.coordination) throw new Error("Edit the Coordination answer with a new revision, not its accepted delivery.");
      const captured = { ...receipt.captured, request: { ...receipt.captured.request, userMessage: input.userMessage }, attachments: input.attachments };
      const previousTime = Date.parse(receipt.updatedAt);
      const updatedAt = new Date(Math.max(Date.now(), Number.isFinite(previousTime) ? previousTime + 1 : 0)).toISOString();
      this.db.prepare("UPDATE session_turn_queue_v6 SET captured_json = ?, updated_at = ? WHERE id = ? AND state = 'queued'")
        .run(capturedJson(captured), updatedAt, id);
      return this.required(owner, id);
    });
  }

  reorderQueued(owner: SessionTurnQueueOwner, expectedQueuedIds: string[], queuedIds: string[]): SessionTurnQueueReorderResult {
    if (!Array.isArray(expectedQueuedIds) || !Array.isArray(queuedIds)
      || expectedQueuedIds.some((id) => typeof id !== "string" || !id.trim())
      || queuedIds.some((id) => typeof id !== "string" || !id.trim())
      || new Set(expectedQueuedIds).size !== expectedQueuedIds.length
      || new Set(queuedIds).size !== queuedIds.length || expectedQueuedIds.length !== queuedIds.length
      || queuedIds.some((id) => !expectedQueuedIds.includes(id))) throw new Error("The queued order must contain the same unique identities.");
    return this.withOwner(owner, () => {
      const read = () => (this.db.prepare(`SELECT * FROM session_turn_queue_v6
        WHERE COALESCE(auxiliary_session_id, session_id) = ? AND incarnation_id = ?
          AND state IN ('queued', 'starting', 'running', 'failed', 'interrupted') ORDER BY queue_position, sequence`)
        .all(owner.sessionId, owner.incarnationId) as QueueRow[]).map((row) => this.toReceipt(row));
      const receipts = read();
      const queued = receipts.filter((receipt) => receipt.state === "queued");
      if (queued.length !== expectedQueuedIds.length || queued.some((receipt, index) => receipt.id !== expectedQueuedIds[index])) {
        return { outcome: "conflict", receipts };
      }
      const update = this.db.prepare("UPDATE session_turn_queue_v6 SET queue_position = ?, updated_at = ? WHERE id = ?");
      const now = new Date().toISOString();
      queuedIds.forEach((id, index) => update.run(queued[index]!.queuePosition, now, id));
      return { outcome: "reordered", receipts: read() };
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
    return this.toReceipt(row);
  }

  private toReceipt(row: QueueRow): SessionTurnQueueReceipt {
    const receipt = toReceipt(row);
    if (receipt.accepted?.origin?.deliveryTiming === "after_source_turn") {
      const source = this.db.prepare(`SELECT ${sourceTurnPhaseSql} AS phase FROM session_turn_queue_v6 q WHERE q.id = ?`)
        .get(row.id) as { phase: SessionTurnQueueReceipt["sourceTurnPhase"] | null };
      receipt.sourceTurnPhase = source.phase ?? "unknown";
    }
    return receipt;
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
    this.db.exec("SAVEPOINT session_queue_operation");
    try {
      const result = run();
      this.db.exec("RELEASE session_queue_operation");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK TO session_queue_operation; RELEASE session_queue_operation");
      throw error;
    }
  }
}
