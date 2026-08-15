import type { DatabaseSync } from "node:sqlite";

export type SessionTurnTerminalCommit = {
  auditLogId: number;
  sessionId: string;
  phase: "completed" | "failed" | "canceled";
  assistantMessageSeq: number;
  threadId: string;
  errorMessage: string;
  completedAt: string;
};

export function writeSessionTurnTerminalCommit(
  db: DatabaseSync,
  commit: SessionTurnTerminalCommit,
): void {
  const result = db.prepare(`
    UPDATE session_turns_v6
    SET phase = ?,
        assistant_message_seq = ?,
        thread_id = ?,
        summary = ?,
        error_summary = ?,
        completed_at = ?,
        updated_at = ?
    WHERE id = ?
      AND session_id = ?
      AND auxiliary_session_id IS NULL
      AND phase = 'running'
  `).run(
    commit.phase,
    commit.assistantMessageSeq,
    commit.threadId,
    commit.phase,
    commit.errorMessage,
    commit.completedAt,
    commit.completedAt,
    commit.auditLogId,
    commit.sessionId,
  );
  if (result.changes !== 1) {
    throw new Error(`session turn terminal commit target mismatch: ${commit.auditLogId}`);
  }
}
