import type {
  CoordinationActor,
  CoordinationAnswer,
  CoordinationRecord,
} from "./coordination-contract.js";
import type { SessionTurnQueueCapturedInput } from "../session/session-turn-queue.js";

/** 相談の配送に保存する表示用情報。回答通知では回答の版と本文を持つ。 */
export type CoordinationNotification = {
  coordinationId: string;
  kind: CoordinationRecord["kind"];
  consultation: string;
  actor: CoordinationActor;
  operation: string;
  answer: CoordinationAnswer | null;
  state: CoordinationRecord["state"];
  withdrawalReason: string | null;
};

/** 通知を識別するのは保存済みの Coordination メタデータだけ。通常の JSON は作成者が書いた本文として扱う。 */
export function readCoordinationNotification(
  input: SessionTurnQueueCapturedInput,
): CoordinationNotification | null {
  const delivery = input.coordination;
  if (!delivery) return null;
  if (delivery.notification) return delivery.notification;
  try {
    const value = JSON.parse(
      input.request.userMessage,
    ) as CoordinationNotification | null;
    if (
      !value ||
      value.coordinationId !== delivery.id ||
      value.operation !== delivery.operation ||
      typeof value.consultation !== "string" ||
      (value.operation === "answer" &&
        (!value.answer ||
          typeof value.answer.body !== "string" ||
          value.answer.id !== delivery.answerId ||
          value.answer.revision !== delivery.answerRevision))
    )
      return null;
    return value;
  } catch {
    return null;
  }
}

/** 回答の通知には回答本文を使い、それ以外の通知では相談本文を使う。 */
export function coordinationNotificationText(
  notification: CoordinationNotification,
): string {
  return notification.operation === "answer"
    ? notification.answer!.body
    : notification.consultation;
}

/** 相談通知を復元できない場合は、加工せず元のメッセージ本文を返す。 */
export function coordinationDeliveryText(
  input: SessionTurnQueueCapturedInput,
): string {
  const notification = readCoordinationNotification(input);
  return notification
    ? coordinationNotificationText(notification)
    : input.request.userMessage;
}
