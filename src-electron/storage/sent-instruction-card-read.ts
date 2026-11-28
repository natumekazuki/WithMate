import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import {
  coordinationNotificationText,
  readCoordinationNotification,
} from "../../src-shared/coordination/coordination-delivery.js";
import { conversationPeerKey } from "../../src-shared/session/conversation-threads.js";
import {
  SENT_INSTRUCTION_CARD_PAGE_SIZE,
  type SentInstructionBodyRequest,
  type SentInstructionCardRequest,
} from "../../src-shared/session/session-execution-read.js";
import { normalizeMessage } from "../../src-shared/session/session-state.js";
import type { SessionTarget } from "../../src-shared/session/session-target.js";
import type {
  SessionSteerOrigin,
  SessionTurnQueueCapturedInput,
  SessionTurnQueueOrigin,
} from "../../src-shared/session/session-turn-queue.js";

/** カードの送信元を特定する保存 Turn。表示に結び付けられる入出力の seq と現在のフェーズを持つ。 */
export type SentSourceTurn = {
  id: number;
  phase: string;
  user_message_seq: number | null;
  assistant_message_seq: number | null;
};
/** 最後に読んだ送信元 Turn と、その Turn 内の位置を組にした継続カーソル。 */
type Cursor = NonNullable<
  NonNullable<SentInstructionCardRequest["cursors"]>["receipts"]
>;
/** 送信者を照合済みの受領記録から読む、カードの配送先と保存された表示位置。 */
type ReceiptRow = {
  receipt_id: string;
  sequence: number;
  state: string;
  session_id: string;
  auxiliary_session_id: string | null;
  incarnation_id: string;
  main_incarnation_id: string;
  source_display_position: number | null;
  source_display_verified: number;
};
/** 直接 Steer を識別する受信メッセージの主キー、履歴 seq と受信 Main の識別。 */
type SteerRow = {
  sequence: number;
  seq: number;
  session_id: string;
  incarnation_id: string;
};
/** カードの一覧と詳細で共通に使う、送信元 Turn と索引上の行位置。 */
type IndexedRow = { sequence: number; source_turn_id: string };

/** 値を直接埋め込まず可変長の SQL 引数を束縛するため、必要な個数のプレースホルダーを作る。 */
const marks = (values: readonly unknown[]) => values.map(() => "?").join(",");
const receiptTurn = "json_extract(q.accepted_json, '$.origin.actorTurnId')";
const steerTurn = "json_extract(m.body, '$.turnInput.origin.actorTurnId')";
const receiptRead = {
  turn: receiptTurn,
  seq: "q.sequence",
  columns:
    "q.id AS receipt_id, q.sequence, q.state, q.session_id, q.auxiliary_session_id, q.incarnation_id, parent.incarnation_id AS main_incarnation_id, q.source_display_position, q.source_display_verified",
  from: `session_turn_queue_v6 q
    JOIN sessions_v6 parent ON parent.id=q.session_id
    LEFT JOIN auxiliary_sessions auxiliary ON auxiliary.id=q.auxiliary_session_id AND auxiliary.parent_session_id=parent.id`,
  where: `json_extract(q.accepted_json, '$.origin.actorKind')=?
      AND json_extract(q.accepted_json, '$.origin.actorSessionId')=?
      AND json_extract(q.accepted_json, '$.origin.actorIncarnationId')=?
      AND json_extract(q.accepted_json, '$.origin.kind')='session'
      AND ((q.auxiliary_session_id IS NULL AND parent.incarnation_id=q.incarnation_id) OR auxiliary.created_at=q.incarnation_id)`,
};
const steerRead = {
  turn: steerTurn,
  seq: "m.id",
  columns: "m.id AS sequence, m.seq, m.session_id, recipient.incarnation_id",
  from: "session_messages_v6 m JOIN sessions_v6 recipient ON recipient.id=m.session_id",
  where: `json_extract(m.body, '$.turnInput.origin.actorKind')=?
      AND json_extract(m.body, '$.turnInput.origin.actorSessionId')=?
      AND json_extract(m.body, '$.turnInput.origin.actorIncarnationId')=?
      AND json_extract(m.body, '$.turnInput.origin.kind')='session'
      AND json_extract(m.body, '$.turnInput.origin.operation')='steer'
      AND json_extract(m.body, '$.turnInput.origin.targetSessionId')=m.session_id
      AND json_extract(m.body, '$.turnInput.origin.targetIncarnationId')=recipient.incarnation_id
      AND json_extract(m.body, '$.turnInput.queueId') IS NULL AND m.role='user'`,
};
/** 受領記録から受信 Session の識別を復元し、Auxiliary では親 Main の識別も含める。 */
const receiptTarget = (row: ReceiptRow): SessionTarget =>
  row.auxiliary_session_id
    ? {
        kind: "auxiliary",
        sessionId: row.auxiliary_session_id,
        incarnationId: row.incarnation_id,
        mainSessionId: row.session_id,
        mainIncarnationId: row.main_incarnation_id,
      }
    : {
        kind: "main",
        sessionId: row.session_id,
        incarnationId: row.incarnation_id,
      };
/** 直接 Steer の受信行から宛先 Main の識別を組み立てる。 */
const steerTarget = (row: SteerRow): SessionTarget => ({
  kind: "main",
  sessionId: row.session_id,
  incarnationId: row.incarnation_id,
});
/** 元の Session の種類・ID・incarnation を送信元の照合順に並べる。 */
const sourceArgs = (source: SessionTarget) => [
  source.kind,
  source.sessionId,
  source.incarnationId,
];

/** 送信元 Turn とシーケンス順にカードを読む。継続時は現在の Turn の未読行から進み、上限より一件多く読んで次ページの有無を判定する。 */
function indexPage<T extends IndexedRow>(
  db: DatabaseSync,
  read: typeof receiptRead,
  fields: string,
  source: SessionTarget,
  turns: string[],
  cursor: Cursor | null | undefined,
) {
  const rows: T[] = [];
  if (cursor === null || !turns.length) return { rows, next: null };
  const first = `SELECT ${read.columns}, ${read.turn} AS source_turn_id, ${fields} FROM ${read.from} WHERE ${read.where}`;
  const args = sourceArgs(source);
  const limit = SENT_INSTRUCTION_CARD_PAGE_SIZE + 1;
  // 非常に大きな一つの Turn の先行カードを再走査しないよう、まずシーケンス番号で現在の Turn を走査する。
  // 後続の Turn は既存の送信者インデックス順に読む。
  if (cursor && turns.includes(cursor.sourceTurnId)) {
    rows.push(
      ...(db
        .prepare(
          `${first} AND ${read.turn}=? AND ${read.seq}>? ORDER BY ${read.seq} LIMIT ?`,
        )
        .all(...args, cursor.sourceTurnId, cursor.sequence, limit) as T[]),
    );
  }
  const later = cursor
    ? turns.filter((turn) => turn > cursor.sourceTurnId)
    : turns;
  if (rows.length < limit && later.length) {
    rows.push(
      ...(db
        .prepare(
          `${first} AND ${read.turn} IN (${marks(later)}) ORDER BY ${read.turn}, ${read.seq} LIMIT ?`,
        )
        .all(...args, ...later, limit - rows.length) as T[]),
    );
  }
  if (rows.length < limit) return { rows, next: null };
  rows.pop();
  const last = rows.at(-1)!;
  return {
    rows,
    next: { sourceTurnId: last.source_turn_id, sequence: last.sequence },
  };
}

/** GUI 用の一覧。位置決めと認可には、保存済みの送信元 Turn と受信者の識別情報を使う。 */
export function listSentInstructionCards(
  db: DatabaseSync,
  source: SessionTarget,
  scope: SentInstructionCardRequest,
  sourceTurns: SentSourceTurn[],
) {
  const byTurn = new Map(sourceTurns.map((turn) => [String(turn.id), turn]));
  const turns = [...byTurn.keys()];
  const messages = new Set(scope.messageSeqs);
  /** 表示対象に含まれる場合は応答の seq を優先し、なければ開始入力の seq を使う。 */
  const sourceMessage = (turn: SentSourceTurn) =>
    turn.assistant_message_seq !== null &&
    messages.has(turn.assistant_message_seq)
      ? turn.assistant_message_seq
      : turn.user_message_seq !== null && messages.has(turn.user_message_seq)
        ? turn.user_message_seq
        : null;
  const receipts = indexPage<
    ReceiptRow &
      IndexedRow & {
        origin: string;
        reply_to: string | null;
        coordination_id: string | null;
      }
  >(
    db,
    receiptRead,
    `json_extract(q.accepted_json, '$.origin') AS origin, json_extract(q.accepted_json, '$.request.replyTo') AS reply_to,
    json_extract(q.accepted_json, '$.coordination.id') AS coordination_id`,
    source,
    turns,
    scope.cursors?.receipts,
  );
  const steers = indexPage<
    SteerRow & IndexedRow & { origin: string; state: string }
  >(
    db,
    steerRead,
    `json_extract(m.body, '$.turnInput.origin') AS origin, json_extract(m.body, '$.turnInput.state') AS state`,
    source,
    turns,
    scope.cursors?.steers,
  );
  return {
    ok: true as const,
    cursors: { receipts: receipts.next, steers: steers.next },
    items: [
      ...receipts.rows.map((row) => {
        const turn = byTurn.get(row.source_turn_id)!;
        return {
          receiptId: row.receipt_id,
          sequence: row.sequence,
          sourceTurnId: row.source_turn_id,
          sourceMessageSeq: sourceMessage(turn),
          sourceDisplayPosition:
            row.source_display_verified === 1 ||
            (turn.phase === "running" &&
              scope.liveTurnIds?.includes(row.source_turn_id))
              ? row.source_display_position
              : null,
          target: receiptTarget(row),
          state: row.state,
          origin: JSON.parse(row.origin) as SessionTurnQueueOrigin,
          ...(row.reply_to ? { replyTo: JSON.parse(row.reply_to) } : {}),
          ...(row.coordination_id
            ? { coordination: { id: row.coordination_id } }
            : {}),
        };
      }),
      ...steers.rows.map((row) => ({
        sequence: row.sequence,
        sourceTurnId: row.source_turn_id,
        sourceMessageSeq: sourceMessage(byTurn.get(row.source_turn_id)!),
        target: steerTarget(row),
        messageSeq: row.seq,
        state: row.state,
        origin: JSON.parse(row.origin) as SessionSteerOrigin,
      })),
    ],
  };
}

/** 認可された送信元の範囲に引き続き含まれ、指定と完全一致するカードについてだけ、保存済みの表示本文全体を返す。 */
export function readSentInstructionBodies(
  db: DatabaseSync,
  source: SessionTarget,
  scope: SentInstructionBodyRequest,
  sourceTurns: SentSourceTurn[],
) {
  const turns = new Set(sourceTurns.map((turn) => String(turn.id)));
  const inScope = scope.cards.filter((key) => turns.has(key.sourceTurnId));
  const receiptKeys = inScope.filter((key) => "receiptId" in key);
  const steerKeys = inScope.filter((key) => "messageSeq" in key);
  const args: SQLInputValue[] = sourceArgs(source);
  /** 要求されたシーケンスを主キーで引き、送信元を照合できた行だけを取得する。 */
  const exactRows = <T>(
    read: typeof receiptRead,
    fields: string,
    keys: typeof inScope,
  ): T[] => {
    if (!keys.length) return [];
    const sequences = [...new Set(keys.map((key) => key.sequence))];
    // 送信元の範囲全体を送信者インデックスで走査せず、要求された主キーを外側の走査に使う。
    // 各読み取り結果については引き続き出所を照合する。
    return db
      .prepare(
        `WITH wanted(sequence) AS (VALUES ${sequences.map(() => "(?)").join(",")})
      SELECT ${read.columns}, ${read.turn} AS source_turn_id, ${fields}
      FROM wanted CROSS JOIN ${read.from} WHERE ${read.seq}=wanted.sequence AND ${read.where}`,
      )
      .all(...sequences, ...args) as T[];
  };
  const receipts = exactRows<
    ReceiptRow & IndexedRow & { accepted_json: string }
  >(receiptRead, "q.accepted_json", receiptKeys);
  const steers = exactRows<SteerRow & IndexedRow & { body: string }>(
    steerRead,
    "m.body",
    steerKeys,
  );
  return {
    ok: true as const,
    items: [
      ...receipts.flatMap((row) => {
        const target = conversationPeerKey(receiptTarget(row));
        if (
          !receiptKeys.some(
            (key) =>
              key.sequence === row.sequence &&
              key.sourceTurnId === row.source_turn_id &&
              key.receiptId === row.receipt_id &&
              conversationPeerKey(key.recipient) === target,
          )
        )
          return [];
        const input = JSON.parse(
          row.accepted_json,
        ) as SessionTurnQueueCapturedInput;
        const notification = readCoordinationNotification(input);
        return [
          {
            kind: "receipt" as const,
            sequence: row.sequence,
            text: notification
              ? coordinationNotificationText(notification)
              : input.request.userMessage,
            consultation: notification?.consultation,
          },
        ];
      }),
      ...steers.flatMap((row) => {
        const target = conversationPeerKey(steerTarget(row));
        if (
          !steerKeys.some(
            (key) =>
              key.sequence === row.sequence &&
              key.sourceTurnId === row.source_turn_id &&
              key.messageSeq === row.seq &&
              conversationPeerKey(key.recipient) === target,
          )
        )
          return [];
        const message = normalizeMessage({
          ...JSON.parse(row.body),
          role: "user",
        });
        if (!message?.turnInput?.origin)
          throw new Error("Invalid saved outgoing Steer input.");
        return [
          {
            kind: "steer" as const,
            sequence: row.sequence,
            text: message.text,
          },
        ];
      }),
    ],
  };
}
