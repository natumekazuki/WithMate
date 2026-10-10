import type { DatabaseSync } from "node:sqlite";
import type {
  SessionTurnInput,
  SessionTurnRecord,
} from "../../src-shared/session/session-turn-state.js";
import { ensureV6Schema } from "../storage/database-schema-v6.js";
import { openAppDatabase } from "../storage/sqlite-connection.js";
import type {
  CompletedTurnTimingRow,
  ConversationTimingStorageSnapshot,
} from "./conversation-timing.js";

type TurnRow = {
  id: number;
  session_id: string | null;
  auxiliary_session_id: string | null;
  phase: SessionTurnRecord["phase"];
  provider_id: string;
  model_id: string;
  reasoning_effort: SessionTurnRecord["reasoningEffort"];
  approval_mode: SessionTurnRecord["approvalMode"];
  sandbox_mode: string;
  user_message_seq: number | null;
  assistant_message_seq: number | null;
  thread_id: string;
  error_summary: string;
  started_at: string;
  completed_at: string | null;
  updated_at: string;
};

export function deleteSessionTurnsForTargets(
  db: DatabaseSync,
  input: {
    sessionIds?: readonly string[];
    auxiliarySessionIds?: readonly string[];
    allSessionTargets?: boolean;
  },
): void {
  if (input.allSessionTargets) {
    db.prepare("DELETE FROM session_turns_v6").run();
    return;
  }
  const conditions: string[] = [];
  const params: string[] = [];
  for (const [column, ids] of [
    ["session_id", input.sessionIds],
    ["auxiliary_session_id", input.auxiliarySessionIds],
  ] as const) {
    const targets = [
      ...new Set((ids ?? []).map((id) => id.trim()).filter(Boolean)),
    ];
    if (targets.length) {
      conditions.push(`${column} IN (${targets.map(() => "?").join(", ")})`);
      params.push(...targets);
    }
  }
  if (conditions.length)
    db.prepare(
      `DELETE FROM session_turns_v6 WHERE ${conditions.join(" OR ")}`,
    ).run(...params);
}

export class SessionTurnStorageV6 {
  private readonly db;
  constructor(dbPath: string) {
    this.db = openAppDatabase(dbPath);
    ensureV6Schema(this.db);
  }

  createSessionTurn(input: SessionTurnInput): SessionTurnRecord {
    const target = this.resolveTarget(input.sessionId);
    const result = this.db
      .prepare(
        `
      INSERT INTO session_turns_v6 (session_id, auxiliary_session_id, phase, provider_id, model_id,
        reasoning_effort, approval_mode, sandbox_mode, user_message_seq, assistant_message_seq,
        thread_id, error_summary, started_at, completed_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        target.sessionId,
        target.auxiliarySessionId,
        input.phase,
        input.provider,
        input.model,
        input.reasoningEffort,
        input.approvalMode,
        input.sandboxMode ?? "",
        input.userMessageSeq ?? null,
        input.assistantMessageSeq ?? null,
        input.threadId,
        input.errorMessage,
        input.createdAt,
        input.phase === "running"
          ? null
          : (input.completedAt ?? input.createdAt),
        input.updatedAt ?? input.createdAt,
      );
    return this.readTurn(Number(result.lastInsertRowid), input.sessionId)!;
  }

  updateSessionTurn(id: number, input: SessionTurnInput): SessionTurnRecord {
    const target = this.resolveTarget(input.sessionId);
    const result = this.db
      .prepare(
        `
      UPDATE session_turns_v6 SET phase = ?, provider_id = ?, model_id = ?, reasoning_effort = ?,
        approval_mode = ?, sandbox_mode = ?, user_message_seq = COALESCE(?, user_message_seq),
        assistant_message_seq = ?, thread_id = ?, error_summary = ?, completed_at = ?, updated_at = ?
      WHERE id = ? AND session_id IS ? AND auxiliary_session_id IS ? AND phase = 'running'
    `,
      )
      .run(
        input.phase,
        input.provider,
        input.model,
        input.reasoningEffort,
        input.approvalMode,
        input.sandboxMode ?? "",
        input.userMessageSeq ?? null,
        input.assistantMessageSeq ?? null,
        input.threadId,
        input.errorMessage,
        input.phase === "running"
          ? null
          : (input.completedAt ?? input.createdAt),
        input.updatedAt ?? input.createdAt,
        id,
        target.sessionId,
        target.auxiliarySessionId,
      );
    if (result.changes !== 1)
      throw new Error(`Session turn not found or owner mismatch: ${id}`);
    return this.readTurn(id, input.sessionId)!;
  }

  getLatestSessionTurn(sessionId: string): SessionTurnRecord | null {
    const row = this.db
      .prepare(
        "SELECT * FROM session_turns_v6 WHERE session_id = ? OR auxiliary_session_id = ? ORDER BY id DESC LIMIT 1",
      )
      .get(sessionId, sessionId) as TurnRow | undefined;
    return row ? this.toRecord(row) : null;
  }

  getConversationTimingSnapshot(
    sessionId: string,
    observedAt: string,
  ): ConversationTimingStorageSnapshot {
    const currentSessionRow = this.db
      .prepare(
        `
      SELECT character_id, session_kind
      FROM sessions_v6
      WHERE id = ?
    `,
      )
      .get(sessionId) as
      { character_id: string | null; session_kind: string } | undefined;
    const currentSessionCompleted = this.db
      .prepare(
        `
      SELECT completed_at
      FROM session_turns_v6
      WHERE session_id = ?
        AND phase = 'completed'
        AND assistant_message_seq IS NOT NULL
        AND completed_at IS NOT NULL
        AND julianday(completed_at) <= julianday(?)
      ORDER BY completed_at DESC, id DESC
      LIMIT 1
    `,
      )
      .get(sessionId, observedAt) as { completed_at: string } | undefined;

    const characterId =
      currentSessionRow?.session_kind === "default"
        ? currentSessionRow.character_id?.trim() || null
        : null;
    if (!characterId) {
      return {
        currentSessionLastCompletedAt:
          currentSessionCompleted?.completed_at ?? null,
        sameCharacterOtherSessionLastCompletedAt: null,
        sameCharacterCompletedTurns: null,
      };
    }

    const otherSessionCompleted = this.db
      .prepare(
        `
      SELECT turns.completed_at
      FROM session_turns_v6 AS turns
      INNER JOIN sessions_v6 AS sessions ON sessions.id = turns.session_id
      WHERE sessions.character_id = ?
        AND sessions.session_kind = 'default'
        AND sessions.id <> ?
        AND turns.phase = 'completed'
        AND turns.assistant_message_seq IS NOT NULL
        AND turns.completed_at IS NOT NULL
        AND julianday(turns.completed_at) <= julianday(?)
      ORDER BY turns.completed_at DESC, turns.id DESC
      LIMIT 1
    `,
      )
      .get(characterId, sessionId, observedAt) as
      { completed_at: string } | undefined;
    const completedTurns = this.db
      .prepare(
        `
      SELECT turns.started_at, turns.completed_at
      FROM session_turns_v6 AS turns
      INNER JOIN sessions_v6 AS sessions ON sessions.id = turns.session_id
      WHERE sessions.character_id = ?
        AND sessions.session_kind = 'default'
        AND turns.phase = 'completed'
        AND turns.assistant_message_seq IS NOT NULL
        AND turns.completed_at IS NOT NULL
      ORDER BY turns.id ASC
    `,
      )
      .all(characterId) as Array<{ started_at: string; completed_at: string }>;

    return {
      currentSessionLastCompletedAt:
        currentSessionCompleted?.completed_at ?? null,
      sameCharacterOtherSessionLastCompletedAt:
        otherSessionCompleted?.completed_at ?? null,
      sameCharacterCompletedTurns: completedTurns.map(
        (turn): CompletedTurnTimingRow => ({
          startedAt: turn.started_at,
          completedAt: turn.completed_at,
        }),
      ),
    };
  }

  close(): void {
    this.db.close();
  }

  private readTurn(id: number, sessionId: string): SessionTurnRecord | null {
    const row = this.db
      .prepare(
        "SELECT * FROM session_turns_v6 WHERE id = ? AND (session_id = ? OR auxiliary_session_id = ?)",
      )
      .get(id, sessionId, sessionId) as TurnRow | undefined;
    return row ? this.toRecord(row) : null;
  }

  private toRecord(row: TurnRow): SessionTurnRecord {
    return {
      id: row.id,
      sessionId: row.session_id ?? row.auxiliary_session_id!,
      phase: row.phase,
      provider: row.provider_id,
      model: row.model_id,
      reasoningEffort: row.reasoning_effort,
      approvalMode: row.approval_mode,
      ...(row.sandbox_mode
        ? { sandboxMode: row.sandbox_mode as SessionTurnRecord["sandboxMode"] }
        : {}),
      ...(row.user_message_seq !== null
        ? { userMessageSeq: row.user_message_seq }
        : {}),
      ...(row.assistant_message_seq !== null
        ? { assistantMessageSeq: row.assistant_message_seq }
        : {}),
      threadId: row.thread_id,
      errorMessage: row.error_summary,
      createdAt: row.started_at,
      ...(row.completed_at !== null ? { completedAt: row.completed_at } : {}),
      updatedAt: row.updated_at,
    };
  }

  private resolveTarget(sessionId: string): {
    sessionId: string | null;
    auxiliarySessionId: string | null;
  } {
    if (
      this.db.prepare("SELECT id FROM sessions_v6 WHERE id = ?").get(sessionId)
    )
      return { sessionId, auxiliarySessionId: null };
    if (
      this.db
        .prepare("SELECT id FROM auxiliary_sessions WHERE id = ?")
        .get(sessionId)
    )
      return { sessionId: null, auxiliarySessionId: sessionId };
    throw new Error(`Session turn owner not found: ${sessionId}`);
  }
}
