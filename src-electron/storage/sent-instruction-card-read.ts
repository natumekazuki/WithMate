import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { coordinationNotificationText, readCoordinationNotification } from "../../src-shared/coordination/coordination-delivery.js";
import { conversationPeerKey } from "../../src-shared/session/conversation-threads.js";
import { SENT_INSTRUCTION_CARD_PAGE_SIZE, type SentInstructionBodyRequest, type SentInstructionCardRequest } from "../../src-shared/session/session-execution-read.js";
import { normalizeMessage } from "../../src-shared/session/session-state.js";
import type { SessionTarget } from "../../src-shared/session/session-target.js";
import type { SessionSteerOrigin, SessionTurnQueueCapturedInput, SessionTurnQueueOrigin } from "../../src-shared/session/session-turn-queue.js";

export type SentSourceTurn = { id: number; phase: string; user_message_seq: number | null; assistant_message_seq: number | null };
type Cursor = NonNullable<NonNullable<SentInstructionCardRequest["cursors"]>["receipts"]>;
type ReceiptRow = { receipt_id: string; sequence: number; state: string; session_id: string; auxiliary_session_id: string | null; incarnation_id: string;
  main_incarnation_id: string; source_display_position: number | null; source_display_verified: number };
type SteerRow = { sequence: number; seq: number; session_id: string; incarnation_id: string };
type IndexedRow = { sequence: number; source_turn_id: string };

const marks = (values: readonly unknown[]) => values.map(() => "?").join(",");
const receiptTurn = "json_extract(q.accepted_json, '$.origin.actorTurnId')";
const steerTurn = "json_extract(m.body, '$.turnInput.origin.actorTurnId')";
const receiptRead = {
  turn: receiptTurn, seq: "q.sequence",
  columns: "q.id AS receipt_id, q.sequence, q.state, q.session_id, q.auxiliary_session_id, q.incarnation_id, parent.incarnation_id AS main_incarnation_id, q.source_display_position, q.source_display_verified",
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
  turn: steerTurn, seq: "m.id",
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
const receiptTarget = (row: ReceiptRow): SessionTarget => row.auxiliary_session_id
  ? { kind: "auxiliary", sessionId: row.auxiliary_session_id, incarnationId: row.incarnation_id, mainSessionId: row.session_id, mainIncarnationId: row.main_incarnation_id }
  : { kind: "main", sessionId: row.session_id, incarnationId: row.incarnation_id };
const steerTarget = (row: SteerRow): SessionTarget => ({ kind: "main", sessionId: row.session_id, incarnationId: row.incarnation_id });
const sourceArgs = (source: SessionTarget) => [source.kind, source.sessionId, source.incarnationId];

function indexPage<T extends IndexedRow>(db: DatabaseSync, read: typeof receiptRead, fields: string, source: SessionTarget, turns: string[], cursor: Cursor | null | undefined) {
  const rows: T[] = [];
  if (cursor === null || !turns.length) return { rows, next: null };
  const first = `SELECT ${read.columns}, ${read.turn} AS source_turn_id, ${fields} FROM ${read.from} WHERE ${read.where}`;
  const args = sourceArgs(source);
  const limit = SENT_INSTRUCTION_CARD_PAGE_SIZE + 1;
  // Seek the current Turn by sequence first so a single very large Turn does not
  // rescan its earlier cards. For later Turns, order by the existing sender index.
  if (cursor && turns.includes(cursor.sourceTurnId)) {
    rows.push(...db.prepare(`${first} AND ${read.turn}=? AND ${read.seq}>? ORDER BY ${read.seq} LIMIT ?`)
      .all(...args, cursor.sourceTurnId, cursor.sequence, limit) as T[]);
  }
  const later = cursor ? turns.filter((turn) => turn > cursor.sourceTurnId) : turns;
  if (rows.length < limit && later.length) {
    rows.push(...db.prepare(`${first} AND ${read.turn} IN (${marks(later)}) ORDER BY ${read.turn}, ${read.seq} LIMIT ?`)
      .all(...args, ...later, limit - rows.length) as T[]);
  }
  if (rows.length < limit) return { rows, next: null };
  rows.pop();
  const last = rows.at(-1)!;
  return { rows, next: { sourceTurnId: last.source_turn_id, sequence: last.sequence } };
}

/** GUI catalogue; the positioning and authorization inputs are the saved source Turn and recipient identity. */
export function listSentInstructionCards(db: DatabaseSync, source: SessionTarget, scope: SentInstructionCardRequest, sourceTurns: SentSourceTurn[]) {
  const byTurn = new Map(sourceTurns.map((turn) => [String(turn.id), turn]));
  const turns = [...byTurn.keys()];
  const messages = new Set(scope.messageSeqs);
  const sourceMessage = (turn: SentSourceTurn) =>
    turn.assistant_message_seq !== null && messages.has(turn.assistant_message_seq) ? turn.assistant_message_seq
      : turn.user_message_seq !== null && messages.has(turn.user_message_seq) ? turn.user_message_seq : null;
  const receipts = indexPage<ReceiptRow & IndexedRow & { origin: string; reply_to: string | null; coordination_id: string | null }>(
    db, receiptRead, `json_extract(q.accepted_json, '$.origin') AS origin, json_extract(q.accepted_json, '$.request.replyTo') AS reply_to,
    json_extract(q.accepted_json, '$.coordination.id') AS coordination_id`, source, turns, scope.cursors?.receipts);
  const steers = indexPage<SteerRow & IndexedRow & { origin: string; state: string }>(
    db, steerRead, `json_extract(m.body, '$.turnInput.origin') AS origin, json_extract(m.body, '$.turnInput.state') AS state`, source, turns, scope.cursors?.steers);
  return { ok: true as const, cursors: { receipts: receipts.next, steers: steers.next }, items: [
    ...receipts.rows.map((row) => {
      const turn = byTurn.get(row.source_turn_id)!;
      return { receiptId: row.receipt_id, sequence: row.sequence, sourceTurnId: row.source_turn_id, sourceMessageSeq: sourceMessage(turn),
        sourceDisplayPosition: row.source_display_verified === 1 || (turn.phase === "running" && scope.liveTurnIds?.includes(row.source_turn_id))
          ? row.source_display_position : null,
        target: receiptTarget(row), state: row.state, origin: JSON.parse(row.origin) as SessionTurnQueueOrigin,
        ...(row.reply_to ? { replyTo: JSON.parse(row.reply_to) } : {}),
        ...(row.coordination_id ? { coordination: { id: row.coordination_id } } : {}) };
    }),
    ...steers.rows.map((row) => ({
      sequence: row.sequence, sourceTurnId: row.source_turn_id, sourceMessageSeq: sourceMessage(byTurn.get(row.source_turn_id)!),
      target: steerTarget(row), messageSeq: row.seq, state: row.state, origin: JSON.parse(row.origin) as SessionSteerOrigin,
    })),
  ] };
}

/** Return full saved display text only for exact requested cards still in the authorized source range. */
export function readSentInstructionBodies(db: DatabaseSync, source: SessionTarget, scope: SentInstructionBodyRequest, sourceTurns: SentSourceTurn[]) {
  const turns = new Set(sourceTurns.map((turn) => String(turn.id)));
  const inScope = scope.cards.filter((key) => turns.has(key.sourceTurnId));
  const receiptKeys = inScope.filter((key) => "receiptId" in key);
  const steerKeys = inScope.filter((key) => "messageSeq" in key);
  const args: SQLInputValue[] = sourceArgs(source);
  const exactRows = <T,>(read: typeof receiptRead, fields: string, keys: typeof inScope): T[] => {
    if (!keys.length) return [];
    const sequences = [...new Set(keys.map((key) => key.sequence))];
    // Use the requested primary keys as the outer scan, not the sender index
    // for the whole source range. Each lookup is still checked against origin.
    return db.prepare(`WITH wanted(sequence) AS (VALUES ${sequences.map(() => "(?)").join(",")})
      SELECT ${read.columns}, ${read.turn} AS source_turn_id, ${fields}
      FROM wanted CROSS JOIN ${read.from} WHERE ${read.seq}=wanted.sequence AND ${read.where}`).all(...sequences, ...args) as T[];
  };
  const receipts = exactRows<ReceiptRow & IndexedRow & { accepted_json: string }>(receiptRead, "q.accepted_json", receiptKeys);
  const steers = exactRows<SteerRow & IndexedRow & { body: string }>(steerRead, "m.body", steerKeys);
  return { ok: true as const, items: [
    ...receipts.flatMap((row) => {
      const target = conversationPeerKey(receiptTarget(row));
      if (!receiptKeys.some((key) => key.sequence === row.sequence && key.sourceTurnId === row.source_turn_id
        && key.receiptId === row.receipt_id && conversationPeerKey(key.recipient) === target)) return [];
      const input = JSON.parse(row.accepted_json) as SessionTurnQueueCapturedInput;
      const notification = readCoordinationNotification(input);
      return [{ kind: "receipt" as const, sequence: row.sequence,
        text: notification ? coordinationNotificationText(notification) : input.request.userMessage, consultation: notification?.consultation }];
    }),
    ...steers.flatMap((row) => {
      const target = conversationPeerKey(steerTarget(row));
      if (!steerKeys.some((key) => key.sequence === row.sequence && key.sourceTurnId === row.source_turn_id
        && key.messageSeq === row.seq && conversationPeerKey(key.recipient) === target)) return [];
      const message = normalizeMessage({ ...JSON.parse(row.body), role: "user" });
      if (!message?.turnInput?.origin) throw new Error("Invalid saved outgoing Steer input.");
      return [{ kind: "steer" as const, sequence: row.sequence, text: message.text }];
    }),
  ] };
}
