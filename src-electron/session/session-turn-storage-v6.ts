import type { DatabaseSync } from "node:sqlite";
import type {
  SessionTurnInput,
  SessionTurnRecord,
} from "../../src-shared/session/session-turn-state.js";
import { ensureV6Schema } from "../storage/database-schema-v6.js";
import { openAppDatabase } from "../storage/sqlite-connection.js";

/** V6 の Turn 行。Main と Auxiliary は別の所有列を使い、開始・終了と入出力の位置を保持する。 */
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

/** 指定された Main／Auxiliary の直接の Turn だけを削除する。全対象フラグが明示された場合は全行を削除する。 */
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

/** V6 行を共通の Turn レコードへ変換し、未設定のメッセージ位置・終了時刻などは省く。 */
function turnRowToRecord(row: TurnRow): SessionTurnRecord {
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

/** 指定の所有列に Turn を挿入し、採番された行を返す。実行中の Turn は終了時刻を空にして保存する。 */
export function insertSessionTurn(
  db: DatabaseSync,
  target: { sessionId: string | null; auxiliarySessionId: string | null },
  input: SessionTurnInput,
): SessionTurnRecord {
  const result = db
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
      input.phase === "running" ? null : (input.completedAt ?? input.createdAt),
      input.updatedAt ?? input.createdAt,
    );
  const row = db
    .prepare("SELECT * FROM session_turns_v6 WHERE id = ?")
    .get(Number(result.lastInsertRowid)) as TurnRow;
  return turnRowToRecord(row);
}

/** V6 の SQLite 接続を使い、直接の所有者ごとに Turn レコードの作成・更新・確認を行う。 */
export class SessionTurnStorageV6 {
  private readonly db;
  /** 指定のデータベースに接続し、V6 のスキーマを使用できる状態にする。 */
  constructor(dbPath: string) {
    this.db = openAppDatabase(dbPath);
    ensureV6Schema(this.db);
  }

  /** 入力の Session ID から直接所有者を解決して Turn を保存する。 */
  createSessionTurn(input: SessionTurnInput): SessionTurnRecord {
    const target = this.resolveTarget(input.sessionId);
    return insertSessionTurn(this.db, target, input);
  }

  /** 同じ直接所有者の実行中 Turn だけを更新する。入力位置の省略は既存値を維持し、対象が一致しなければ拒否する。 */
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

  /** 指定された直接所有者の最も新しい Turn を、レコード ID の降順で取得する。 */
  getLatestSessionTurn(sessionId: string): SessionTurnRecord | null {
    const row = this.db
      .prepare(
        "SELECT * FROM session_turns_v6 WHERE session_id = ? OR auxiliary_session_id = ? ORDER BY id DESC LIMIT 1",
      )
      .get(sessionId, sessionId) as TurnRow | undefined;
    return row ? turnRowToRecord(row) : null;
  }

  /** このストアが開いた SQLite 接続を閉じる。 */
  close(): void {
    this.db.close();
  }

  /** Turn ID と直接所有者の組で保存済みの Turn を取得する。対象が一致しなければ null。 */
  private readTurn(id: number, sessionId: string): SessionTurnRecord | null {
    const row = this.db
      .prepare(
        "SELECT * FROM session_turns_v6 WHERE id = ? AND (session_id = ? OR auxiliary_session_id = ?)",
      )
      .get(id, sessionId, sessionId) as TurnRow | undefined;
    return row ? turnRowToRecord(row) : null;
  }

  /** Main を先に照会し、存在しなければ Auxiliary から直接の所有列を決める。どちらにもなければ例外を返す。 */
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
