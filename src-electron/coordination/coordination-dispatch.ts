import type { DatabaseSync } from "node:sqlite";
import {
  coordinationNotificationText,
  readCoordinationNotification,
} from "../../src-shared/coordination/coordination-delivery.js";
import type {
  CoordinationIdentity,
  CoordinationRecord,
} from "../../src-shared/coordination/coordination-contract.js";
import type { SessionTurnQueueCapturedInput } from "../../src-shared/session/session-turn-queue.js";

/** 相談は開始時の受領記録に対応付け、無関係な追加入力には結び付けない。 */
export function assertCoordinationInputTurn(
  db: DatabaseSync,
  captured: SessionTurnQueueCapturedInput,
  owner: CoordinationIdentity,
  turnId: string,
): void {
  const delivery = captured.coordination;
  const row =
    delivery &&
    (db
      .prepare("SELECT payload_json FROM coordination_records_v7 WHERE id=?")
      .get(delivery.id) as { payload_json: string } | undefined);
  const record = row
    ? (JSON.parse(row.payload_json) as CoordinationRecord)
    : null;
  /** 種別、Session ID、incarnation がすべて実行中の Turn の所有者と等しい場合だけ一致とする。 */
  const sameOwner = (identity: CoordinationIdentity | null) =>
    identity?.kind === owner.kind &&
    identity.sessionId === owner.sessionId &&
    identity.incarnationId === owner.incarnationId;
  let related = false;
  if (record && delivery?.targetKind === owner.kind) {
    if (delivery.operation === "answer")
      related =
        sameOwner(record.initiator) && record.initiatorTurnId === turnId;
    else if (
      (delivery.operation === "create" || delivery.operation === "deliver") &&
      sameOwner(record.caller) &&
      record.originReceiptId
    ) {
      const start = db
        .prepare(
          `SELECT accepted_json FROM session_turn_queue_v6 WHERE id=? AND incarnation_id=?
        AND ${record.initiator.kind === "main" ? "session_id=? AND auxiliary_session_id IS NULL" : "auxiliary_session_id=?"}
        AND turn_id=? AND input_turn_id IS NULL
        AND user_message_seq=(SELECT user_message_seq FROM session_turns_v6 WHERE id=?)`,
        )
        .get(
          record.originReceiptId,
          record.initiator.incarnationId,
          record.initiator.sessionId,
          record.initiatorTurnId,
          record.initiatorTurnId,
        ) as { accepted_json: string | null } | undefined;
      const origin = start?.accepted_json
        ? (JSON.parse(start.accepted_json) as SessionTurnQueueCapturedInput)
            .origin
        : null;
      related =
        origin?.kind === "session" &&
        origin.actorKind === owner.kind &&
        origin.actorSessionId === owner.sessionId &&
        origin.actorIncarnationId === owner.incarnationId &&
        origin.actorTurnId === turnId;
    }
  }
  if (!related)
    throw new Error("Coordination does not belong to this running Turn.");
}

/** 受理済みの回答本文を維持しつつ、配送時点の相談状態を反映する。 */
export function coordinationDispatchJson(
  db: DatabaseSync,
  json: string,
): string {
  const captured = JSON.parse(json) as SessionTurnQueueCapturedInput;
  if (!captured.coordination) return json;
  const row = db
    .prepare("SELECT payload_json FROM coordination_records_v7 WHERE id=?")
    .get(captured.coordination.id) as { payload_json: string } | undefined;
  if (!row)
    throw new Error("Coordination delivery no longer has its saved record.");
  const record = JSON.parse(row.payload_json) as CoordinationRecord;
  const accepted = readCoordinationNotification(captured);
  if (!accepted)
    throw new Error("Coordination delivery has no saved notification.");
  captured.coordination.notification = {
    ...accepted,
    state: record.state,
    withdrawalReason: record.withdrawalReason ?? null,
  };
  captured.request.userMessage = coordinationNotificationText(accepted);
  return JSON.stringify(captured);
}

/** 受信側のキュー済み Turn 入力を保存するトランザクション内で呼び出す。 */
export function acquireCoordinationAnswer(
  db: DatabaseSync,
  captured: SessionTurnQueueCapturedInput,
  owner: CoordinationIdentity,
): void {
  const delivery = captured.coordination;
  if (!delivery || delivery.operation !== "answer") return;
  const row = db
    .prepare("SELECT payload_json FROM coordination_records_v7 WHERE id=?")
    .get(delivery.id) as { payload_json: string } | undefined;
  if (!row)
    throw new Error("Coordination delivery no longer has its saved record.");
  const record = JSON.parse(row.payload_json) as CoordinationRecord;
  const answer = record.answers.at(-1);
  if (
    record.initiator.kind !== owner.kind ||
    record.initiator.sessionId !== owner.sessionId ||
    record.initiator.incarnationId !== owner.incarnationId ||
    !answer ||
    answer.id !== delivery.answerId ||
    answer.revision !== delivery.answerRevision
  ) {
    throw new Error(
      "The Coordination answer or recipient changed before delivery.",
    );
  }
  if (answer.acquiredAt) return;
  answer.acquiredAt = new Date().toISOString();
  record.updatedAt = answer.acquiredAt;
  db.prepare(
    "UPDATE coordination_records_v7 SET payload_json=? WHERE id=?",
  ).run(JSON.stringify(record), record.id);
}
