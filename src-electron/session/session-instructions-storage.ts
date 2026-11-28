import type { DatabaseSync } from "node:sqlite";
import {
  sessionInstructionsByteLength,
  validateSessionInstructions,
  type SessionInstructionsTarget,
} from "../../src-shared/session/session-instructions.js";
import { assertRuntimeTurnAdmission } from "../platform/agent-runtime/runtime-turn-admission.js";
import { openAppDatabase } from "../storage/sqlite-connection.js";

/**
 * 保存先の所有者を厳密に特定する。Auxiliary の条件には所属 Main の incarnation も含め、
 * 再作成された Main が以前の行へのアクセスを引き継がないようにする。
 */
function ownerRow(target: SessionInstructionsTarget): {
  table: string;
  where: string;
  params: string[];
} {
  // Main と Auxiliary は、同じ Session Window を共有していても別のテーブルを使う。
  if (target.kind === "main") {
    return {
      table: "sessions_v6",
      where: "id = ? AND incarnation_id = ?",
      params: [target.sessionId, target.incarnationId],
    };
  }
  return {
    table: "auxiliary_sessions",
    where:
      "id = ? AND created_at = ? AND parent_session_id = ? AND EXISTS (SELECT 1 FROM sessions_v6 WHERE id = auxiliary_sessions.parent_session_id AND incarnation_id = ?)",
    params: [
      target.sessionId,
      target.incarnationId,
      target.mainSessionId,
      target.mainIncarnationId,
    ],
  };
}

/** 指示の列だけにアクセスし、通常の Session や履歴の表示用データとは独立して扱う。 */
export class SessionInstructionsStorage {
  private readonly db: DatabaseSync;

  /** 指定のデータベースに専用接続を開く。指示の読み書きに使い、利用後は close で解放する。 */
  constructor(dbPath: string) {
    this.db = openAppDatabase(dbPath);
  }

  /** Worker が所有する SQLite 接続を閉じる。 */
  close(): void {
    this.db.close();
  }

  /** 保存済みの本文を返す。指定された所有者が存在しなくなっていれば null を返す。 */
  get(target: SessionInstructionsTarget): string | null {
    const owner = ownerRow(target);
    assertRuntimeTurnAdmission();
    const row = this.db
      .prepare(
        `SELECT instructions_json FROM ${owner.table} WHERE ${owner.where}`,
      )
      .get(...owner.params);
    return row
      ? validateSessionInstructions(JSON.parse(String(row.instructions_json)))
      : null;
  }

  /** 本文全体を検証し、1 回の書き込みで置き換える。所有者が存在しなければ何も変更しない。 */
  set(
    target: SessionInstructionsTarget,
    input: unknown,
  ): { byteLength: number } | null {
    // JS と SQLite の境界では JSON を使い、エスケープされるコードユニットも含めて入力をそのまま保持する。
    const body = validateSessionInstructions(input);
    const byteLength = sessionInstructionsByteLength(body);
    const owner = ownerRow(target);
    const encoded = JSON.stringify(body);
    // 書き込みロックの取得後に実行許可を確認する。SQLite の待機中に許可が失効することがある。
    this.db.exec("BEGIN IMMEDIATE");
    try {
      assertRuntimeTurnAdmission();
      const changes = this.db
        .prepare(
          `UPDATE ${owner.table} SET instructions_json = ? WHERE ${owner.where}`,
        )
        .run(encoded, ...owner.params).changes;
      assertRuntimeTurnAdmission();
      this.db.exec("COMMIT");
      return Number(changes) === 1 ? { byteLength } : null;
    } catch (error) {
      // 適用されなかった変更やロールバックした変更は拒否し、以前の本文は置き換えない。
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
