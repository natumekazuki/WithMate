import type { DatabaseSync } from "node:sqlite";
import type { SessionTurnQueueOwner } from "../../src-shared/session/session-turn-queue.js";
import { hasWritableAuxiliaryParent } from "../auxiliary/auxiliary-session-storage.js";
import { writeSessionTurnTerminalCommit } from "./session-turn-terminal-commit.js";

type RecoveryOwner = {
  sessionId: string;
  auxiliaryId: string | null;
  incarnationId: string;
  wasRunning: number;
  wasInterrupted: number;
};
type SavedTurn = {
  id: number;
  phase: "running" | "completed" | "failed" | "canceled";
  userMessageSeq: number | null;
  assistantMessageSeq: number | null;
  threadId: string;
  reason: string;
  completedAt: string | null;
};
type RecoveryReceipt = {
  id: string;
  state: "starting" | "running" | "interrupted";
  turnId: string | null;
  inputTurnId: string | null;
  userMessageSeq: number | null;
  coordination: string | null;
};

const failureReason = "The app stopped before this Turn finished.";
const releasedFailureReason = "The Turn stopped before its outcome could be confirmed.";
const inputUnknownReason = "The input outcome could not be confirmed.";
const mainWasRunning = `CASE WHEN json_valid(s.runtime_policy_json)
  THEN COALESCE(json_extract(s.runtime_policy_json, '$.runState') = 'running'
    OR json_extract(s.runtime_policy_json, '$.appStatus') = 'running', 0) ELSE 0 END`;
const mainWasInterrupted = `CASE WHEN json_valid(s.runtime_policy_json)
  THEN COALESCE(json_extract(s.runtime_policy_json, '$.runState') = 'interrupted', 0) ELSE 0 END`;

/** Called in the storage worker's startup transaction, before the queue can claim work. */
export function recoverSessionTurnsAfterRestart(db: DatabaseSync, now: string): number {
  const owners = db.prepare(`
    SELECT s.id AS sessionId, NULL AS auxiliaryId, s.incarnation_id AS incarnationId,
      ${mainWasRunning} AS wasRunning, ${mainWasInterrupted} AS wasInterrupted
    FROM sessions_v6 s
    WHERE wasRunning OR wasInterrupted
      OR EXISTS (SELECT 1 FROM session_turn_queue_v6 q WHERE q.session_id = s.id AND q.auxiliary_session_id IS NULL
        AND q.incarnation_id = s.incarnation_id AND q.state IN ('starting', 'running', 'interrupted'))
    UNION ALL
    SELECT a.parent_session_id, a.id, a.created_at, a.run_state = 'running', 0
    FROM auxiliary_sessions a JOIN sessions_v6 s ON s.id = a.parent_session_id
    WHERE a.run_state = 'running'
      OR EXISTS (SELECT 1 FROM session_turn_queue_v6 q WHERE q.session_id = a.parent_session_id AND q.auxiliary_session_id = a.id
        AND q.incarnation_id = a.created_at AND q.state IN ('starting', 'running', 'interrupted'))
  `).all() as RecoveryOwner[];
  let changed = 0;
  for (const owner of owners) {
    if (hasWritableAuxiliaryParent(db, owner.sessionId)) changed += recoverOwner(db, owner, now);
  }
  return changed;
}

/** Only after the live runtime guard was released. Never reconcile another receipt or Turn. */
export function recoverReleasedSessionTurn(db: DatabaseSync, owner: SessionTurnQueueOwner, receiptId: string, now: string) {
  const row = db.prepare(`
    SELECT s.id AS sessionId, a.id AS auxiliaryId, q.incarnation_id AS incarnationId,
      CASE WHEN a.id IS NULL THEN ${mainWasRunning} ELSE a.run_state = 'running' END AS wasRunning, 0 AS wasInterrupted
    FROM session_turn_queue_v6 q JOIN sessions_v6 s ON s.id = q.session_id
    LEFT JOIN auxiliary_sessions a ON a.id = q.auxiliary_session_id AND a.parent_session_id = s.id
    WHERE q.id = ? AND q.state = 'interrupted' AND q.input_turn_id IS NULL AND q.incarnation_id = ?
      AND ((q.auxiliary_session_id IS NULL AND s.incarnation_id = q.incarnation_id AND s.id = ?)
        OR (a.created_at = q.incarnation_id AND a.id = ?))
  `).get(receiptId, owner.incarnationId, owner.sessionId, owner.sessionId) as RecoveryOwner | undefined;
  const changed = row ? recoverOwner(db, row, now, receiptId) : 0;
  return { changed, auxiliary: row?.auxiliaryId != null };
}

function recoverOwner(db: DatabaseSync, owner: RecoveryOwner, now: string, receiptId?: string): number {
  const { sessionId, auxiliaryId, incarnationId, wasRunning, wasInterrupted } = owner;
  const auxiliary = auxiliaryId !== null;
  const id = auxiliaryId ?? sessionId;
  const messageTable = auxiliary ? "auxiliary_session_messages" : "session_messages_v6";
  const ownerColumn = auxiliary ? "auxiliary_session_id" : "session_id";
  const otherOwnerColumn = auxiliary ? "session_id" : "auxiliary_session_id";
  const turnSelect = `SELECT id, phase, user_message_seq AS userMessageSeq, assistant_message_seq AS assistantMessageSeq,
      thread_id AS threadId, error_summary AS reason, completed_at AS completedAt FROM session_turns_v6
    WHERE ${ownerColumn} = ? AND ${otherOwnerColumn} IS NULL`;
  const messageExists = db.prepare(`SELECT 1 FROM ${messageTable} WHERE ${ownerColumn} = ? AND seq = ? AND role = ?`);
  const isSavedResponse = (turn: SavedTurn): boolean => turn.assistantMessageSeq !== null && turn.userMessageSeq !== null
    && turn.assistantMessageSeq > turn.userMessageSeq && Boolean(messageExists.get(id, turn.assistantMessageSeq, "assistant"));
  const latest = db.prepare(`${turnSelect} ORDER BY id DESC LIMIT 1`).get(id) as SavedTurn | undefined;
  const receipts = db.prepare(`SELECT id, state, turn_id AS turnId, input_turn_id AS inputTurnId, user_message_seq AS userMessageSeq,
      json_extract(COALESCE(dispatched_json, captured_json), '$.coordination.id') AS coordination
    FROM session_turn_queue_v6 WHERE session_id = ? AND auxiliary_session_id IS ? AND incarnation_id = ?
      AND state IN ('starting', 'running', 'interrupted')${receiptId ? " AND id = ?" : ""}`)
    .all(sessionId, auxiliaryId, incarnationId, ...(receiptId ? [receiptId] : [])) as RecoveryReceipt[];
  const reasonForAbandonedTurn = receiptId ? releasedFailureReason : failureReason;

  const latestOwnsInput = latest && messageExists.get(id, latest.userMessageSeq, "user")
    && !db.prepare(`SELECT 1 FROM ${messageTable} WHERE ${ownerColumn} = ? AND seq > ? AND role = 'user'
      AND CASE WHEN json_valid(body) THEN json_extract(body, '$.turnInput.turnId') END IS NOT ? LIMIT 1`)
      .get(id, latest.userMessageSeq, String(latest.id));
  const referencingStarts = latest ? receipts.filter((receipt) =>
    receipt.inputTurnId === null && receipt.turnId === String(latest.id)) : [];
  const exactStart = latest && (referencingStarts.length
    ? referencingStarts.length === 1 && referencingStarts[0]!.userMessageSeq === latest.userMessageSeq
    : !receiptId && (wasRunning || wasInterrupted));
  let failedLatest = false;
  if (latest?.phase === "running" && latestOwnsInput && exactStart) {
    // A linked assistant message may contain saved partial text and Details. Never replace it.
    // When none exists, the ordinary Failed representation has an empty answer body and a separate failure reason.
    let seq = latest.assistantMessageSeq;
    if (seq === null || !isSavedResponse(latest)) {
      const next = db.prepare(`SELECT COALESCE(MAX(seq) + 1, 0) AS seq FROM ${messageTable} WHERE ${ownerColumn} = ?`)
        .get(id) as { seq: number };
      seq = next.seq;
      db.prepare(`INSERT INTO ${messageTable} (${ownerColumn}, seq, role, body, created_at)
        VALUES (?, ?, 'assistant', ?, ?)`).run(id, seq, JSON.stringify({ role: "assistant", text: "", runFailure: reasonForAbandonedTurn, accent: true }), now);
    } else {
      // An explicit structured reason also bypasses the legacy inline-notice parser:
      // an answer ending in the same words is still the provider's answer.
      db.prepare(`UPDATE ${messageTable} SET body = json_set(body, '$.runFailure', ?)
        WHERE ${ownerColumn} = ? AND seq = ? AND role = 'assistant'
          AND CASE WHEN json_valid(body) THEN json_type(body, '$.runFailure') IS NOT 'text' ELSE 0 END`)
        .run(reasonForAbandonedTurn, id, seq);
    }
    writeSessionTurnTerminalCommit(db, {
      turnId: latest.id, sessionId: id, phase: "failed", assistantMessageSeq: seq,
      threadId: latest.threadId, errorMessage: reasonForAbandonedTurn, completedAt: now,
    }, auxiliary ? "auxiliary" : "main");
    failedLatest = true;
  }

  if (failedLatest || (!receiptId && (wasRunning || wasInterrupted))) {
    const hasSavedTerminal = latestOwnsInput && latest && latest.completedAt !== null && latest.phase !== "running"
      && isSavedResponse(latest);
    const runState = hasSavedTerminal && latest.phase !== "failed" ? "idle" : "error";
    if (auxiliary) {
      db.prepare("UPDATE auxiliary_sessions SET run_state = ? WHERE id = ? AND created_at = ?")
        .run(runState, id, incarnationId);
    } else {
      db.prepare(`UPDATE sessions_v6 SET state = 'completed',
        runtime_policy_json = json_set(runtime_policy_json, '$.appStatus', 'idle', '$.runState', ?)
        WHERE id = ? AND incarnation_id = ?`).run(runState, id, incarnationId);
    }
  }

  const resolveTurn = db.prepare(`${turnSelect} AND id = ? AND user_message_seq = ?`);
  const updateReceipt = db.prepare(`UPDATE session_turn_queue_v6
    SET state = ?, reason = ?, released_at = CASE WHEN ? = 'interrupted' THEN released_at ELSE NULL END, updated_at = ? WHERE id = ?`);
  let changed = 0;
  for (const receipt of receipts) {
    let state: SavedTurn["phase"] | "interrupted" = "interrupted";
    let reason: string | null = null;
    if (receipt.inputTurnId !== null) {
      // A queued input's append and completed receipt are atomic. A lone input claim is not proof of delivery or non-delivery.
      reason = inputUnknownReason;
    } else if (receipt.turnId !== null && receipt.userMessageSeq !== null) {
      const turn = resolveTurn.get(id, receipt.turnId, receipt.userMessageSeq) as SavedTurn | undefined;
      if (turn && String(turn.id) === receipt.turnId && turn.phase !== "running" && turn.completedAt !== null
        && messageExists.get(id, turn.userMessageSeq, "user") && isSavedResponse(turn)) {
        state = turn.phase;
        reason = turn.reason || null;
      }
    } else if (receipt.turnId === null && receipt.userMessageSeq === null && !receipt.coordination) {
      // Without the atomic start record there is no started Turn to settle or source Turn to release.
      state = "failed";
      reason = reasonForAbandonedTurn;
    }
    if (state === "interrupted" && receipt.state === "interrupted") continue;
    changed += Number(updateReceipt.run(state, reason ?? (state === "interrupted" ? reasonForAbandonedTurn : null), state, now, receipt.id).changes);
  }
  return changed;
}
