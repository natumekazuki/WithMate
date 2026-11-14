import type { CoordinationActor, CoordinationAnswer, CoordinationRecord } from "./coordination-contract.js";
import type { SessionTurnQueueCapturedInput } from "../session/session-turn-queue.js";

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

/** Only saved Coordination metadata identifies a notification; ordinary JSON is authored text. */
export function readCoordinationNotification(input: SessionTurnQueueCapturedInput): CoordinationNotification | null {
  const delivery = input.coordination;
  if (!delivery) return null;
  if (delivery.notification) return delivery.notification;
  try {
    const value = JSON.parse(input.request.userMessage) as CoordinationNotification | null;
    if (!value || value.coordinationId !== delivery.id || value.operation !== delivery.operation
      || typeof value.consultation !== "string" || (value.operation === "answer"
        && (!value.answer || typeof value.answer.body !== "string"
          || value.answer.id !== delivery.answerId || value.answer.revision !== delivery.answerRevision))) return null;
    return value;
  } catch { return null; }
}

export function coordinationNotificationText(notification: CoordinationNotification): string {
  return notification.operation === "answer" ? notification.answer!.body : notification.consultation;
}

export function coordinationDeliveryText(input: SessionTurnQueueCapturedInput): string {
  const notification = readCoordinationNotification(input);
  return notification ? coordinationNotificationText(notification) : input.request.userMessage;
}
