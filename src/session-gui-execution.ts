type SessionGuiTurnExecutionBase = {
  executionId: string;
  sessionId: string;
  clientRequestId: string | null;
  userMessage: string;
  createdAt: string;
  updatedAt: string;
};

export type SessionRunningTurn = SessionGuiTurnExecutionBase & {
  state: "running";
  queuePosition: null;
  canCancel: false;
};

export type SessionQueuedTurn = SessionGuiTurnExecutionBase & {
  state: "queued";
  queuePosition: number;
  canCancel: true;
};

export type SessionGuiTurnExecution = SessionRunningTurn | SessionQueuedTurn;

export type SessionExecutionChangedEvent =
  | {
      kind: "state-changed";
      sessionId: string;
      executionId: string;
      state: SessionExecutionState;
    }
  | {
      kind: "user-message-persisted";
      sessionId: string;
      executionId: string;
      state: "running";
    };

export type SessionRunningProjectionBarrier = {
  sessionId: string;
  executionId: string;
};

export function createSessionRunningProjectionBarrier(
  event: SessionExecutionChangedEvent,
): SessionRunningProjectionBarrier | null {
  if (event.kind !== "state-changed" || event.state !== "running") return null;
  return {
    sessionId: event.sessionId,
    executionId: event.executionId,
  };
}

export function applySessionExecutionChangedEvent(
  current: readonly SessionGuiTurnExecution[],
  event: SessionExecutionChangedEvent,
): SessionGuiTurnExecution[] {
  if (event.kind === "user-message-persisted") return [...current];
  return current.flatMap((execution) => {
    if (execution.sessionId !== event.sessionId || execution.executionId !== event.executionId) {
      return [execution];
    }
    if (event.state === "running") {
      return [{
        ...execution,
        state: "running" as const,
        queuePosition: null,
        canCancel: false as const,
      }];
    }
    return event.state === "queued" ? [execution] : [];
  });
}

export function applySessionExecutionChangedEventWithBarrier(
  current: readonly SessionGuiTurnExecution[],
  event: SessionExecutionChangedEvent,
  barrier: SessionRunningProjectionBarrier | null,
): SessionGuiTurnExecution[] {
  if (
    event.kind === "state-changed" &&
    event.state !== "running" &&
    barrier?.executionId === event.executionId
  ) {
    return [...current];
  }
  return applySessionExecutionChangedEvent(current, event);
}

export function mergeGuiTurnExecutionRefreshWithBarrier(
  current: readonly SessionGuiTurnExecution[],
  refreshed: readonly SessionGuiTurnExecution[],
  barrier: SessionRunningProjectionBarrier | null,
): SessionGuiTurnExecution[] {
  if (!barrier || refreshed.some((execution) => execution.executionId === barrier.executionId)) {
    return [...refreshed];
  }
  const retained = current.find((execution) => (
    execution.executionId === barrier.executionId && execution.state === "running"
  ));
  return retained ? [...refreshed, retained] : [...refreshed];
}

export type SessionTurnAdmissionError = {
  code: string;
  message: string;
  retryable: boolean;
};

export type EnqueueSessionTurnResult =
  | { ok: true; execution: SessionGuiTurnExecution | null }
  | { ok: false; error: SessionTurnAdmissionError };

export type CancelSessionExecutionRequest = {
  executionId: string;
  clientRequestId: string;
};

export type CancelSessionExecutionResult =
  | { ok: true }
  | { ok: false; error: SessionTurnAdmissionError };
import type { SessionExecutionState } from "./session-execution.js";
