import type { SessionExecution } from "./session-execution.js";
import type { SessionRuntimeTerminalFailureNotificationProjection } from "./session-external-runtime-contract.js";

export const TERMINAL_FAILURE_NOTIFICATION_DELIVERY_STATES = [
  "pending",
  "enqueued",
  "failed",
] as const;

export type TerminalFailureNotificationDeliveryState =
  (typeof TERMINAL_FAILURE_NOTIFICATION_DELIVERY_STATES)[number];

export type TerminalFailureNotificationDeliveryObservation = {
  state: TerminalFailureNotificationDeliveryState;
  notificationExecutionId: string | null;
  errorCode: string | null;
  updatedAt: string;
};

export function projectTerminalFailureNotification(input: {
  execution: SessionExecution;
  targetSessionId: string | null;
  delivery: TerminalFailureNotificationDeliveryObservation | null;
}): SessionRuntimeTerminalFailureNotificationProjection | null {
  if (!input.targetSessionId) return null;
  if (input.delivery) {
    return {
      targetSessionId: input.targetSessionId,
      state: input.delivery.state,
      notificationExecutionId: input.delivery.notificationExecutionId,
      errorCode: input.delivery.errorCode,
      updatedAt: input.delivery.updatedAt,
    };
  }
  if (input.execution.state === "completed" || input.execution.state === "canceled") {
    return {
      targetSessionId: input.targetSessionId,
      state: "not_triggered",
      notificationExecutionId: null,
      errorCode: null,
      updatedAt: input.execution.updatedAt,
    };
  }
  return {
    targetSessionId: input.targetSessionId,
    state: input.execution.state === "failed" || input.execution.state === "interrupted"
      ? "pending"
      : "armed",
    notificationExecutionId: null,
    errorCode: null,
    updatedAt: input.execution.updatedAt,
  };
}
