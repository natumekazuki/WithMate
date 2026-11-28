import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { normalizeSessionTurnClientRequestId } from "../../src-shared/session/runtime-state.js";
import type {
  SessionTurnQueueAdmission,
  SessionTurnQueueCapturedInput,
  SessionTurnQueueOwner,
  SessionTurnQueueReceipt,
  SessionTurnQueueReceiptPage,
  SessionTurnQueueState,
  SessionTurnQueueReorderResult,
} from "../../src-shared/session/session-turn-queue.js";
import { ensureV6Schema } from "../storage/database-schema-v6.js";
import { openAppDatabase } from "../storage/sqlite-connection.js";
import {
  consumeAuxiliaryDraftInTransaction,
  hasWritableAuxiliaryParent,
} from "../auxiliary/auxiliary-session-storage.js";
import { assertSessionLifecycleReady } from "./session-lifecycle-operation.js";
import {
  recoverReleasedSessionTurn,
  recoverSessionTurnsAfterRestart,
} from "./session-turn-restart-recovery.js";
import type { ConversationMutationSink } from "../storage/conversation-query.js";
import {
  assertCoordinationInputTurn,
  coordinationDispatchJson,
} from "../coordination/coordination-dispatch.js";
import type { ConversationThreads } from "../../src-shared/session/conversation-threads.js";
import {
  readConversationCoordinationOrigin,
  readConversationThreads,
  readMainCoordinationFrame,
  readMainRetryFrame,
} from "../storage/conversation-threads.js";

/** キュー受付の DB 行。元の受付、編集後の入力、送出時の内容と、実行状態・メッセージ位置を別々に持つ。 */
type QueueRow = {
  id: string;
  session_id: string;
  auxiliary_session_id: string | null;
  incarnation_id: string;
  request_id: string;
  sequence: number;
  state: SessionTurnQueueState;
  captured_json: string;
  turn_id: string | null;
  user_message_seq: number | null;
  reason: string | null;
  released_at: string | null;
  created_at: string;
  updated_at: string;
  input_turn_id: string | null;
  queue_position: number;
  accepted_json: string | null;
  dispatched_json: string | null;
};

// 現在の incarnation に属する、起点となった特定の Turn を参照する。送信元の最新 Turn ではない。
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

/** 保存行から受付を復元し、Auxiliary のときは所属 Main ではなく実際の宛先 ID を返す。 */
function toReceipt(row: QueueRow): SessionTurnQueueReceipt {
  return {
    id: row.id,
    sessionId: row.auxiliary_session_id ?? row.session_id,
    incarnationId: row.incarnation_id,
    requestId: row.request_id,
    sequence: row.sequence,
    queuePosition: row.queue_position,
    state: row.state,
    captured: JSON.parse(row.captured_json) as SessionTurnQueueCapturedInput,
    accepted: row.accepted_json
      ? (JSON.parse(row.accepted_json) as SessionTurnQueueCapturedInput)
      : null,
    dispatched: row.dispatched_json
      ? (JSON.parse(row.dispatched_json) as SessionTurnQueueCapturedInput)
      : null,
    turnId: row.turn_id,
    userMessageSeq: row.user_message_seq,
    reason: row.reason,
    releasedAt: row.released_at,
    inputTurnId: row.input_turn_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 保存・再送照合に使う入力を、プロパティ順に依存しない JSON に変換する。 */
function capturedJson(captured: SessionTurnQueueCapturedInput): string {
  const normalized: unknown = JSON.parse(JSON.stringify(captured));
  /** 配列の順序を保持し、オブジェクトのキーだけを再帰的に並べ替える。 */
  const sort = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sort);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, entry]) => [key, sort(entry)]),
      );
    }
    return value;
  };
  return JSON.stringify(sort(normalized));
}

/** 指定所有者の受付・取得・送出権・回復を SQLite のトランザクションで管理する。 */
export class SessionTurnQueueStorageV6 {
  private readonly db: DatabaseSync;

  /** 既存接続を使うか指定パスを開く。新しく接続する場合は必要な V6 スキーマを準備する。 */
  constructor(
    dbPath: string | DatabaseSync,
    private readonly onConversationChanged?: ConversationMutationSink,
  ) {
    this.db = typeof dbPath === "string" ? openAppDatabase(dbPath) : dbPath;
    if (typeof dbPath === "string") ensureV6Schema(this.db);
  }

  /** キューの読み書きで使用していた SQLite 接続を閉じる。 */
  close(): void {
    this.db.close();
  }

  /** 入力を保存して受付を返す。通常 Turn の送出権取得はここでは要求しない。 */
  enqueue(
    owner: SessionTurnQueueOwner,
    captured: SessionTurnQueueCapturedInput,
  ): SessionTurnQueueReceipt {
    // Coordination は、関連 Turn への入力を試みる前に、自身の記録とキューの受付レコードを一緒にコミットする。
    return this.admit(owner, captured).receipt;
  }

  /** 受付を正規化し、同じ要求キーの再送は内容一致時だけ再利用する。新規受付と必要なドラフト消費・送出権取得をまとめて行う。 */
  admit(
    owner: SessionTurnQueueOwner,
    captured: SessionTurnQueueCapturedInput,
    claim?: { unreleasedSourceTurnIds: readonly string[] },
  ): SessionTurnQueueAdmission {
    const requestId = normalizeSessionTurnClientRequestId(
      captured.request.clientRequestId,
    );
    if (!requestId || requestId !== captured.request.clientRequestId)
      throw new Error("Queue request ID is invalid.");
    const {
      sourceDisplayPosition,
      sourceDisplayText: _sourceDisplayText,
      ...acceptance
    } = captured;
    const displayPosition =
      typeof sourceDisplayPosition === "number" &&
      Number.isSafeInteger(sourceDisplayPosition) &&
      sourceDisplayPosition >= 0
        ? sourceDisplayPosition
        : null;
    return this.withOwner(owner, () => {
      const target = this.db
        .prepare(
          "SELECT parent_session_id FROM auxiliary_sessions WHERE id = ? AND created_at = ?",
        )
        .get(owner.sessionId, owner.incarnationId) as
        { parent_session_id: string } | undefined;
      assertSessionLifecycleReady(
        this.db,
        target?.parent_session_id ?? owner.sessionId,
      );
      const existing = this.db
        .prepare(
          "SELECT * FROM session_turn_queue_v6 WHERE COALESCE(auxiliary_session_id, session_id) = ? AND incarnation_id = ? AND request_id = ?",
        )
        .get(owner.sessionId, owner.incarnationId, requestId) as
        QueueRow | undefined;
      if (existing) {
        if (existing.accepted_json === null)
          throw new Error(
            "The original queue acceptance input is unavailable; query its receipt instead.",
          );
        let original = existing.accepted_json;
        // 再試行で使うフレームは呼び出し元から受け取らず、ここで導出する。
        // 同一の再送かを判定するときは、その導出フィールドを除いた元の入力と比較する。
        if (
          acceptance.retrySource &&
          acceptance.request.mainConversationFrame === undefined
        ) {
          const accepted = JSON.parse(
            original,
          ) as SessionTurnQueueCapturedInput;
          if (accepted.retrySource) {
            delete accepted.request.mainConversationFrame;
            original = capturedJson(accepted);
          }
        }
        if (original !== capturedJson(acceptance))
          throw new Error(
            "Queue request ID was reused with a different payload.",
          );
        return { receipt: this.toReceipt(existing), claimed: null };
      }
      const id = randomUUID();
      const now = new Date().toISOString();
      const auxiliary = target;
      const json = capturedJson(
        !auxiliary && acceptance.retrySource
          ? this.withInheritedFrame(owner, acceptance)
          : acceptance,
      );
      if (auxiliary) {
        const request = captured.request;
        if (request.submitSource !== "retry") {
          if (
            !request.auxiliaryDraftIncarnation ||
            request.auxiliaryDraftDurableRevision === undefined
          )
            throw new Error("Auxiliary queue draft identity is required.");
          const consumed = consumeAuxiliaryDraftInTransaction(this.db, {
            auxiliarySessionId: owner.sessionId,
            parentSessionId: auxiliary.parent_session_id,
            incarnation: request.auxiliaryDraftIncarnation,
            expectedDurableRevision: request.auxiliaryDraftDurableRevision,
            expectedText: request.userMessage,
            allowRunningInput: true,
          });
          if (consumed.outcome !== "consumed")
            throw new Error("Auxiliary queue draft is stale or unavailable.");
        }
        if (request.displayAnchorParentMessageCount !== undefined) {
          const count = request.displayAnchorParentMessageCount;
          if (!Number.isSafeInteger(count) || count < 0)
            throw new Error("Auxiliary display anchor is invalid.");
          this.db
            .prepare(
              "UPDATE auxiliary_sessions SET display_after_message_index = COALESCE(display_after_message_index, ?) WHERE id = ?",
            )
            .run(count === 0 ? null : count - 1, owner.sessionId);
        }
      }
      this.db
        .prepare(
          `INSERT INTO session_turn_queue_v6
        (id, session_id, auxiliary_session_id, incarnation_id, request_id, state, captured_json, accepted_json, source_display_position, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          auxiliary?.parent_session_id ?? owner.sessionId,
          auxiliary ? owner.sessionId : null,
          owner.incarnationId,
          requestId,
          json,
          json,
          displayPosition,
          now,
          now,
        );
      this.db
        .prepare(
          "UPDATE session_turn_queue_v6 SET queue_position = sequence WHERE id = ?",
        )
        .run(id);
      const claimed = claim
        ? this.claimNextInTransaction(owner, claim.unreleasedSourceTurnIds)
        : null;
      const receipt = claimed?.id === id ? claimed : this.required(owner, id);
      return {
        receipt:
          displayPosition === null
            ? receipt
            : { ...receipt, sourceDisplayInserted: true },
        claimed,
      };
    });
  }

  /** 起点の Session・世代・Turn と受付が一致する場合だけ、表示位置の検証結果を更新する。 */
  verifySourceDisplayPosition(
    id: string,
    actorSessionId: string,
    actorIncarnationId: string,
    actorTurnId: string,
    valid: boolean,
  ): void {
    this.db
      .prepare(
        `UPDATE session_turn_queue_v6 SET source_display_verified = ?, source_display_position = CASE WHEN ? THEN source_display_position ELSE NULL END
      WHERE id = ? AND json_extract(accepted_json, '$.origin.actorSessionId') = ?
        AND json_extract(accepted_json, '$.origin.actorIncarnationId') = ? AND json_extract(accepted_json, '$.origin.actorTurnId') = ?`,
      )
      .run(
        valid ? 1 : 0,
        valid ? 1 : 0,
        id,
        actorSessionId,
        actorIncarnationId,
        actorTurnId,
      );
  }

  /** 同じ宛先・世代と送信キーで元の受付を取得する。一致しなければ null。 */
  getReceipt(
    owner: SessionTurnQueueOwner,
    requestId: string,
  ): SessionTurnQueueReceipt | null {
    return this.withOwner(owner, () => {
      const row = this.db
        .prepare(
          "SELECT * FROM session_turn_queue_v6 WHERE COALESCE(auxiliary_session_id, session_id) = ? AND incarnation_id = ? AND request_id = ?",
        )
        .get(owner.sessionId, owner.incarnationId, requestId) as
        QueueRow | undefined;
      return row ? this.toReceipt(row) : null;
    });
  }

  /** 進行中・再確認対象の受付をキュー順で返し、Main の必要な項目には元の会話フレームを補う。 */
  listActive(owner: SessionTurnQueueOwner): SessionTurnQueueReceipt[] {
    let threads: ConversationThreads | undefined;
    /** 会話スレッドが必要になった最初の一回だけ読み取り、同じ一覧投影内で再利用する。 */
    const readThreads = () =>
      (threads ??= readConversationThreads(this.db, {
        ...owner,
        kind: "main",
      }));
    return this.withOwner(owner, () =>
      (
        this.db
          .prepare(
            `SELECT * FROM session_turn_queue_v6
      WHERE COALESCE(auxiliary_session_id, session_id) = ? AND incarnation_id = ? AND state IN ('queued', 'starting', 'running', 'failed', 'interrupted') ORDER BY queue_position, sequence`,
          )
          .all(owner.sessionId, owner.incarnationId) as QueueRow[]
      ).map((row) => {
        const receipt = this.toReceipt(row);
        return row.auxiliary_session_id === null
          ? {
              ...receipt,
              captured: this.withInheritedFrame(
                owner,
                receipt.captured,
                readThreads,
              ),
            }
          : receipt;
      }),
    );
  }

  /** 宛先が一致する GUI 入力でフレームが未指定の場合だけ、回答や再試行の元フレームを復元する。 */
  private withInheritedFrame(
    owner: SessionTurnQueueOwner,
    input: SessionTurnQueueCapturedInput,
    readThreads?: () => ConversationThreads,
  ): SessionTurnQueueCapturedInput {
    const { coordination, origin, request, retrySource } = input;
    if (
      request.mainConversationFrame !== undefined ||
      origin?.kind !== "gui" ||
      origin.targetSessionId !== owner.sessionId ||
      origin.targetIncarnationId !== owner.incarnationId
    )
      return input;
    const source = { ...owner, kind: "main" as const };
    if (
      coordination?.targetKind === "main" &&
      coordination.operation === "answer" &&
      coordination.actor.kind === "user"
    ) {
      const record = readConversationCoordinationOrigin(
        this.db,
        coordination.id,
      );
      return {
        ...input,
        request: {
          ...request,
          mainConversationFrame: readMainCoordinationFrame(
            this.db,
            source,
            record,
            readThreads,
          ),
        },
      };
    }
    return retrySource
      ? {
          ...input,
          request: {
            ...request,
            mainConversationFrame: readMainRetryFrame(
              this.db,
              source,
              retrySource,
              readThreads,
            ),
          },
        }
      : input;
  }

  /** 宛先世代を照合して受付 ID で一件読む。存在しない場合は null。 */
  getReceiptById(
    owner: SessionTurnQueueOwner,
    id: string,
  ): SessionTurnQueueReceipt | null {
    return this.withOwner(owner, () => {
      const row = this.db
        .prepare(
          "SELECT * FROM session_turn_queue_v6 WHERE id = ? AND COALESCE(auxiliary_session_id, session_id) = ? AND incarnation_id = ?",
        )
        .get(id, owner.sessionId, owner.incarnationId) as QueueRow | undefined;
      return row ? this.toReceipt(row) : null;
    });
  }

  /** 指定世代の受付履歴を保存順にページ化し、さらにある場合だけ次の位置を返す。 */
  listReceipts(
    owner: SessionTurnQueueOwner,
    options: { cursor?: number; limit?: number } = {},
  ): SessionTurnQueueReceiptPage {
    const cursor = options.cursor ?? 0;
    const limit = options.limit ?? 60;
    if (
      !Number.isSafeInteger(cursor) ||
      cursor < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 200
    ) {
      throw new Error("Queue receipt page is invalid.");
    }
    return this.withOwner(owner, () => {
      const rows = this.db
        .prepare(
          `SELECT * FROM session_turn_queue_v6
        WHERE COALESCE(auxiliary_session_id, session_id) = ? AND incarnation_id = ? AND sequence > ? ORDER BY sequence LIMIT ?`,
        )
        .all(
          owner.sessionId,
          owner.incarnationId,
          cursor,
          limit + 1,
        ) as QueueRow[];
      return {
        receipts: rows.slice(0, limit).map((row) => this.toReceipt(row)),
        nextCursor: rows.length > limit ? rows[limit - 1]!.sequence : null,
      };
    });
  }

  /** 現在の世代に待機中の受付がある所有者を取得する。指定時は該当送信者の Turn 終了待ちだけに絞る。 */
  listPendingOwners(sourceSessionId?: string): SessionTurnQueueOwner[] {
    return this.transaction(() =>
      (
        this.db
          .prepare(
            `SELECT DISTINCT COALESCE(q.auxiliary_session_id, q.session_id) AS session_id, q.incarnation_id FROM session_turn_queue_v6 q
      JOIN sessions_v6 s ON s.id = q.session_id
      LEFT JOIN auxiliary_sessions a ON a.id = q.auxiliary_session_id AND a.parent_session_id = s.id
      WHERE ((q.auxiliary_session_id IS NULL AND s.incarnation_id = q.incarnation_id)
        OR (a.created_at = q.incarnation_id))
      AND q.state = 'queued'
      ${
        sourceSessionId === undefined
          ? ""
          : `AND json_extract(q.accepted_json, '$.origin.deliveryTiming') = 'after_source_turn'
        AND json_extract(q.accepted_json, '$.origin.actorKind') = 'main'
        AND json_extract(q.accepted_json, '$.origin.actorSessionId') = ?`
      }`,
          )
          .all(
            ...(sourceSessionId === undefined ? [] : [sourceSessionId]),
          ) as Array<{ session_id: string; incarnation_id: string }>
      ).map((row) => ({
        sessionId: row.session_id,
        incarnationId: row.incarnation_id,
      })),
    );
  }

  /** 所有者を照合するトランザクション内で、次に送出可能な通常入力の実行枠を取る。 */
  claimNext(
    owner: SessionTurnQueueOwner,
    unreleasedSourceTurnIds: readonly string[] = [],
  ): SessionTurnQueueReceipt | null {
    return this.withOwner(owner, () =>
      this.claimNextInTransaction(owner, unreleasedSourceTurnIds),
    );
  }

  /** 通常実行の既存枠と起点 Turn の解放を確認し、送出できる最初の受付を送出内容とともに開始中にする。 */
  private claimNextInTransaction(
    owner: SessionTurnQueueOwner,
    unreleasedSourceTurnIds: readonly string[],
  ): SessionTurnQueueReceipt | null {
    if (
      this.db
        .prepare(
          `SELECT 1 FROM session_turn_queue_v6 WHERE COALESCE(auxiliary_session_id, session_id) = ? AND incarnation_id = ?
      AND state IN ('starting', 'running') LIMIT 1`,
        )
        .get(owner.sessionId, owner.incarnationId)
    )
      return null;
    const row = this.db
      .prepare(
        `SELECT q.* FROM session_turn_queue_v6 q WHERE COALESCE(q.auxiliary_session_id, q.session_id) = ? AND q.incarnation_id = ?
      AND q.state = 'queued' AND ${eligibleDeliverySql}
      ${
        unreleasedSourceTurnIds.length
          ? `AND (COALESCE(json_extract(q.accepted_json, '$.origin.deliveryTiming'), 'immediate') = 'immediate'
        OR json_extract(q.accepted_json, '$.origin.actorTurnId') NOT IN (${unreleasedSourceTurnIds.map(() => "?").join(",")}))`
          : ""
      }
      ORDER BY q.queue_position, q.sequence LIMIT 1`,
      )
      .get(owner.sessionId, owner.incarnationId, ...unreleasedSourceTurnIds) as
      QueueRow | undefined;
    if (!row) return null;
    const prepared = JSON.parse(
      coordinationDispatchJson(this.db, row.captured_json),
    ) as SessionTurnQueueCapturedInput;
    const captured =
      row.auxiliary_session_id === null
        ? this.withInheritedFrame(owner, prepared)
        : prepared;
    const sourceTurnPhase = this.toReceipt(row).sourceTurnPhase;
    if (
      captured.origin?.deliveryTiming === "after_source_turn" &&
      sourceTurnPhase &&
      sourceTurnPhase !== "running" &&
      sourceTurnPhase !== "unknown"
    ) {
      captured.origin = { ...captured.origin, sourceTurnPhase };
    }
    this.db
      .prepare(
        "UPDATE session_turn_queue_v6 SET state = 'starting', dispatched_json = ?, updated_at = ? WHERE id = ?",
      )
      .run(capturedJson(captured), new Date().toISOString(), row.id);
    return this.required(owner, row.id);
  }

  /** 通常開始の受付に実際の Turn とユーザーメッセージ位置を記録する。同じ組の再照会は上書きしない。 */
  markStarted(
    owner: SessionTurnQueueOwner,
    id: string,
    input: { turnId: string; userMessageSeq: number },
  ): SessionTurnQueueReceipt {
    if (
      !input.turnId ||
      !Number.isSafeInteger(input.userMessageSeq) ||
      input.userMessageSeq < 0
    )
      throw new Error("Queue turn identity is invalid.");
    return this.withOwner(owner, () => {
      const receipt = this.required(owner, id);
      if (
        receipt.state === "running" &&
        receipt.turnId === input.turnId &&
        receipt.userMessageSeq === input.userMessageSeq
      )
        return receipt;
      if (receipt.state !== "starting" || receipt.inputTurnId)
        throw new Error("Queue receipt is not starting a normal turn.");
      this.db
        .prepare(
          "UPDATE session_turn_queue_v6 SET state = 'running', turn_id = ?, user_message_seq = ?, updated_at = ? WHERE id = ?",
        )
        .run(input.turnId, input.userMessageSeq, new Date().toISOString(), id);
      return this.required(owner, id);
    });
  }

  /** 待機中の受付を実行中の指定 Turn への入力に確保する。起点の未終了や未解放は送出しない。 */
  claimForInput(
    owner: SessionTurnQueueOwner,
    id: string,
    expectedTurnId: string,
    unreleasedSourceTurnIds: readonly string[] = [],
  ): SessionTurnQueueReceipt {
    if (!expectedTurnId.trim())
      throw new Error("Input turn identity is invalid.");
    return this.withOwner(owner, () => {
      const receipt = this.required(owner, id);
      if (
        receipt.state === "completed" &&
        receipt.inputTurnId === expectedTurnId
      )
        return receipt;
      if (receipt.state !== "queued")
        throw new Error("Only a queued receipt can be sent as input.");
      if (
        receipt.sourceTurnPhase === "running" ||
        receipt.sourceTurnPhase === "unknown"
      )
        throw new Error(
          "The sender Turn has not confirmed its saved terminal state.",
        );
      if (
        receipt.accepted?.origin?.deliveryTiming === "after_source_turn" &&
        unreleasedSourceTurnIds.includes(receipt.accepted.origin.actorTurnId!)
      ) {
        throw new Error("The sender Turn is still releasing its execution.");
      }
      const targetKind = receipt.captured.coordination?.targetKind;
      const turn = this.db
        .prepare(
          `SELECT t.id, t.auxiliary_session_id FROM session_turns_v6 t WHERE t.phase = 'running'
        ${targetKind === "main" ? "AND t.auxiliary_session_id IS NULL" : targetKind === "auxiliary" ? "AND t.session_id IS NULL" : ""}
        AND ((t.session_id = ? AND t.auxiliary_session_id IS NULL AND EXISTS
          (SELECT 1 FROM sessions_v6 s WHERE s.id = t.session_id AND s.incarnation_id = ?
            AND json_extract(s.runtime_policy_json, '$.runState') = 'running')
          AND t.id = (SELECT MAX(id) FROM session_turns_v6 WHERE session_id = t.session_id))
        OR (t.auxiliary_session_id = ? AND t.session_id IS NULL AND EXISTS
          (SELECT 1 FROM auxiliary_sessions a WHERE a.id = t.auxiliary_session_id AND a.created_at = ? AND a.run_state = 'running')
          AND t.id = (SELECT MAX(id) FROM session_turns_v6 WHERE auxiliary_session_id = t.auxiliary_session_id)))`,
        )
        .get(
          owner.sessionId,
          owner.incarnationId,
          owner.sessionId,
          owner.incarnationId,
        ) as { id: number; auxiliary_session_id: string | null } | undefined;
      if (!turn) throw new Error("The current running turn no longer matches.");
      if (receipt.captured.coordination)
        assertCoordinationInputTurn(
          this.db,
          receipt.captured,
          {
            ...owner,
            kind: turn.auxiliary_session_id === null ? "main" : "auxiliary",
          },
          String(turn.id),
        );
      const prepared = receipt.captured.coordination
        ? (JSON.parse(
            coordinationDispatchJson(this.db, JSON.stringify(receipt.captured)),
          ) as SessionTurnQueueCapturedInput)
        : receipt.captured;
      const dispatch =
        turn.auxiliary_session_id === null
          ? this.withInheritedFrame(owner, prepared)
          : prepared;
      const captured =
        dispatch.origin?.deliveryTiming === "after_source_turn" &&
        receipt.sourceTurnPhase
          ? {
              ...dispatch,
              origin: {
                ...dispatch.origin,
                sourceTurnPhase: receipt.sourceTurnPhase as
                  "completed" | "failed" | "canceled",
              },
            }
          : dispatch;
      const result = this.db
        .prepare(
          `UPDATE session_turn_queue_v6 SET state = 'starting', dispatched_json = ?, turn_id = ?, input_turn_id = ?, updated_at = ?
        WHERE id = ? AND state = 'queued'`,
        )
        .run(
          capturedJson(captured),
          String(turn.id),
          expectedTurnId,
          new Date().toISOString(),
          id,
        );
      if (Number(result.changes) !== 1)
        throw new Error("The queued input could not be claimed.");
      return this.required(owner, id);
    });
  }

  /** 同じ Turn に割り当てられ、メッセージ未保存の開始中入力だけを待機状態に戻す。 */
  restoreQueuedInput(
    owner: SessionTurnQueueOwner,
    id: string,
    expectedTurnId: string,
  ): SessionTurnQueueReceipt {
    return this.withOwner(owner, () => {
      const receipt = this.required(owner, id);
      if (
        receipt.state !== "starting" ||
        receipt.inputTurnId !== expectedTurnId ||
        receipt.userMessageSeq !== null
      )
        throw new Error("The queued input cannot be restored.");
      this.db
        .prepare(
          `UPDATE session_turn_queue_v6 SET state = 'queued', turn_id = NULL, input_turn_id = NULL, dispatched_json = NULL, updated_at = ? WHERE id = ?`,
        )
        .run(new Date().toISOString(), id);
      return this.required(owner, id);
    });
  }

  /** 開始中または実行中の受付を終了状態へ移す。確定済みの結果を不明状態で上書きしない。 */
  settle(
    owner: SessionTurnQueueOwner,
    id: string,
    state: Extract<
      SessionTurnQueueState,
      "completed" | "failed" | "canceled" | "interrupted"
    >,
    reason?: string,
  ): SessionTurnQueueReceipt {
    if (!["completed", "failed", "canceled", "interrupted"].includes(state))
      throw new Error("Queue settlement state is invalid.");
    return this.withOwner(owner, () => {
      const receipt = this.required(owner, id);
      if (
        ["completed", "failed", "canceled"].includes(receipt.state) &&
        (receipt.state === state || state === "interrupted")
      )
        return receipt;
      if (receipt.state !== "starting" && receipt.state !== "running")
        throw new Error("Queue receipt is not executing.");
      this.db
        .prepare(
          "UPDATE session_turn_queue_v6 SET state = ?, reason = ?, updated_at = ? WHERE id = ?",
        )
        .run(state, reason ?? null, new Date().toISOString(), id);
      return this.required(owner, id);
    });
  }

  /** 指定受付がまだ待機中の場合だけ取り消し、送出が始まっていれば保存状態を返す。 */
  cancelQueued(
    owner: SessionTurnQueueOwner,
    id: string,
  ): SessionTurnQueueReceipt {
    return this.withOwner(owner, () => {
      const receipt = this.required(owner, id);
      // キャンセルの対象はこの受付レコードだけ。送出と競合しても、Turn の停止には切り替えない。
      if (receipt.state !== "queued") return receipt;
      this.db
        .prepare(
          "UPDATE session_turn_queue_v6 SET state = 'canceled', updated_at = ? WHERE id = ?",
        )
        .run(new Date().toISOString(), id);
      return this.required(owner, id);
    });
  }

  /** 編集可能な待機入力の本文と添付を更新する。受付時の原文や Coordination の回答は書き換えない。 */
  updateQueued(
    owner: SessionTurnQueueOwner,
    id: string,
    input: {
      userMessage: string;
      attachments: SessionTurnQueueCapturedInput["attachments"];
    },
  ): SessionTurnQueueReceipt {
    if (typeof input.userMessage !== "string" || !input.userMessage.trim())
      throw new Error("A queued message is required.");
    return this.withOwner(owner, () => {
      const receipt = this.required(owner, id);
      if (receipt.state !== "queued")
        throw new Error("Only a queued receipt can be edited.");
      if (receipt.captured.coordination)
        throw new Error(
          "Edit the Coordination answer with a new revision, not its accepted delivery.",
        );
      const captured = {
        ...receipt.captured,
        request: {
          ...receipt.captured.request,
          userMessage: input.userMessage,
        },
        attachments: input.attachments,
      };
      const previousTime = Date.parse(receipt.updatedAt);
      const updatedAt = new Date(
        Math.max(
          Date.now(),
          Number.isFinite(previousTime) ? previousTime + 1 : 0,
        ),
      ).toISOString();
      this.db
        .prepare(
          "UPDATE session_turn_queue_v6 SET captured_json = ?, updated_at = ? WHERE id = ? AND state = 'queued'",
        )
        .run(capturedJson(captured), updatedAt, id);
      return this.required(owner, id);
    });
  }

  /** 読み取った待機順が現在と一致する場合にだけ、同じ ID 集合を並べ替える。競合は現在の受付を返す。 */
  reorderQueued(
    owner: SessionTurnQueueOwner,
    expectedQueuedIds: string[],
    queuedIds: string[],
  ): SessionTurnQueueReorderResult {
    if (
      !Array.isArray(expectedQueuedIds) ||
      !Array.isArray(queuedIds) ||
      expectedQueuedIds.some((id) => typeof id !== "string" || !id.trim()) ||
      queuedIds.some((id) => typeof id !== "string" || !id.trim()) ||
      new Set(expectedQueuedIds).size !== expectedQueuedIds.length ||
      new Set(queuedIds).size !== queuedIds.length ||
      expectedQueuedIds.length !== queuedIds.length ||
      queuedIds.some((id) => !expectedQueuedIds.includes(id))
    )
      throw new Error(
        "The queued order must contain the same unique identities.",
      );
    return this.withOwner(owner, () => {
      /** 保存操作の前後に現行の表示順を取得し、競合または操作結果として返せるようにする。 */
      const read = () =>
        (
          this.db
            .prepare(
              `SELECT * FROM session_turn_queue_v6
        WHERE COALESCE(auxiliary_session_id, session_id) = ? AND incarnation_id = ?
          AND state IN ('queued', 'starting', 'running', 'failed', 'interrupted') ORDER BY queue_position, sequence`,
            )
            .all(owner.sessionId, owner.incarnationId) as QueueRow[]
        ).map((row) => this.toReceipt(row));
      const receipts = read();
      const queued = receipts.filter((receipt) => receipt.state === "queued");
      if (
        queued.length !== expectedQueuedIds.length ||
        queued.some((receipt, index) => receipt.id !== expectedQueuedIds[index])
      ) {
        return { outcome: "conflict", receipts };
      }
      const update = this.db.prepare(
        "UPDATE session_turn_queue_v6 SET queue_position = ?, updated_at = ? WHERE id = ?",
      );
      const now = new Date().toISOString();
      queuedIds.forEach((id, index) =>
        update.run(queued[index]!.queuePosition, now, id),
      );
      return { outcome: "reordered", receipts: read() };
    });
  }

  /** 全体の再起動回復、または指定された解放済み受付だけの整合を取り、保存変更があれば履歴の変化を通知する。 */
  recoverInterrupted(
    target?: SessionTurnQueueOwner & { receiptId: string },
  ): number {
    const now = new Date().toISOString();
    if (!target)
      return this.transaction(() =>
        recoverSessionTurnsAfterRestart(this.db, now),
      );
    const result = this.withOwner(target, () =>
      recoverReleasedSessionTurn(this.db, target, target.receiptId, now),
    );
    if (result.changed)
      this.onConversationChanged?.(
        result.auxiliary ? "auxiliary_session_messages" : "session_messages_v6",
        target.sessionId,
      );
    return Number(result.changed);
  }

  /** 受付 ID・直接所有者・世代が全て一致する一件を取得し、見つからなければ例外にする。 */
  private required(
    owner: SessionTurnQueueOwner,
    id: string,
  ): SessionTurnQueueReceipt {
    const row = this.db
      .prepare(
        "SELECT * FROM session_turn_queue_v6 WHERE id = ? AND COALESCE(auxiliary_session_id, session_id) = ? AND incarnation_id = ?",
      )
      .get(id, owner.sessionId, owner.incarnationId) as QueueRow | undefined;
    if (!row) throw new Error("Queue receipt not found or owner mismatch.");
    return this.toReceipt(row);
  }

  /** 行の受付を復元し、起点 Turn の完了待ちの場合は該当する起点の保存状態を追加する。 */
  private toReceipt(row: QueueRow): SessionTurnQueueReceipt {
    const receipt = toReceipt(row);
    if (receipt.accepted?.origin?.deliveryTiming === "after_source_turn") {
      const source = this.db
        .prepare(
          `SELECT ${sourceTurnPhaseSql} AS phase FROM session_turn_queue_v6 q WHERE q.id = ?`,
        )
        .get(row.id) as {
        phase: SessionTurnQueueReceipt["sourceTurnPhase"] | null;
      };
      receipt.sourceTurnPhase = source.phase ?? "unknown";
    }
    return receipt;
  }

  /** 同じ世代の Main または Auxiliary と書き込み可能な所属を確認し、同じトランザクションで処理する。 */
  private withOwner<T>(owner: SessionTurnQueueOwner, run: () => T): T {
    return this.transaction(() => {
      const main = this.db
        .prepare(
          "SELECT 1 FROM sessions_v6 WHERE id = ? AND incarnation_id = ?",
        )
        .get(owner.sessionId, owner.incarnationId);
      const auxiliary = this.db
        .prepare(
          "SELECT parent_session_id FROM auxiliary_sessions WHERE id = ? AND created_at = ?",
        )
        .get(owner.sessionId, owner.incarnationId) as
        { parent_session_id: string } | undefined;
      if (
        !owner.sessionId ||
        !owner.incarnationId ||
        (!main && !auxiliary) ||
        !hasWritableAuxiliaryParent(
          this.db,
          auxiliary?.parent_session_id ?? owner.sessionId,
        )
      )
        throw new Error("Queue session not found or incarnation mismatch.");
      return run();
    });
  }

  /** キュー操作の変更をセーブポイントでまとめ、例外時はここで行った変更だけを戻す。 */
  private transaction<T>(run: () => T): T {
    this.db.exec("SAVEPOINT session_queue_operation");
    try {
      const result = run();
      this.db.exec("RELEASE session_queue_operation");
      return result;
    } catch (error) {
      this.db.exec(
        "ROLLBACK TO session_queue_operation; RELEASE session_queue_operation",
      );
      throw error;
    }
  }
}
