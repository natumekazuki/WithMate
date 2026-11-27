import type { DatabaseSync } from "node:sqlite";

export type SessionTurnTerminalCommit = {
  turnId: number;
  sessionId: string;
  phase: "completed" | "failed" | "canceled";
  assistantMessageSeq: number;
  threadId: string;
  errorMessage: string;
  completedAt: string;
};

/** Finalize the exact Turn and its unresolved direct inputs inside the caller's transaction. */
export function writeSessionTurnTerminalCommit(
  db: DatabaseSync,
  commit: SessionTurnTerminalCommit,
  ownerKind: "main" | "auxiliary" = "main",
): void {
  const ownerColumn = ownerKind === "auxiliary" ? "auxiliary_session_id" : "session_id";
  const otherOwnerColumn = ownerKind === "auxiliary" ? "session_id" : "auxiliary_session_id";
  const result = db.prepare(`
    UPDATE session_turns_v6
    SET phase = ?,
        assistant_message_seq = ?,
        thread_id = ?,
        error_summary = ?,
        completed_at = ?,
        updated_at = ?
    WHERE id = ?
      AND ${ownerColumn} = ?
      AND ${otherOwnerColumn} IS NULL
      AND phase = 'running'
  `).run(
    commit.phase,
    commit.assistantMessageSeq,
    commit.threadId,
    commit.errorMessage,
    commit.completedAt,
    commit.completedAt,
    commit.turnId,
    commit.sessionId,
  );
  if (result.changes !== 1) {
    throw new Error(`session turn terminal commit target mismatch: ${commit.turnId}`);
  }
  const messageTable = ownerKind === "auxiliary" ? "auxiliary_session_messages" : "session_messages_v6";
  // The provider may have received a persisted pending input. Once its Turn
  // ends, only the delivery outcome is unknown; do not rewrite its evidence.
  db.prepare(`
    UPDATE ${messageTable}
    SET body = json_set(body, '$.turnInput.state', 'unknown')
    WHERE ${ownerColumn} = ? AND role = 'user'
      AND seq > (SELECT user_message_seq FROM session_turns_v6 WHERE id = ?)
      AND seq < ?
      AND CASE WHEN json_valid(body) THEN
        json_extract(body, '$.turnInput.turnId') = ?
        AND json_extract(body, '$.turnInput.state') = 'pending'
        AND json_extract(body, '$.turnInput.queueId') IS NULL
      ELSE 0 END
  `).run(commit.sessionId, commit.turnId, commit.assistantMessageSeq, String(commit.turnId));
}
