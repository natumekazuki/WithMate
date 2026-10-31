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
}
