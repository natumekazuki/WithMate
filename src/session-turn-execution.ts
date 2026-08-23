type SessionTurnExecutionProjectionBase = {
  executionId: string;
  sessionId: string;
  clientRequestId: string | null;
  userMessage: string;
  initiator: import("./session-execution.js").TurnInitiator | null;
  createdAt: string;
  updatedAt: string;
  terminalFailureNotification?: import("./session-external-runtime-contract.js").SessionRuntimeTerminalFailureNotificationProjection | null;
};

export type SessionRunningTurn = SessionTurnExecutionProjectionBase & {
  state: "running";
  queuePosition: null;
  canCancel: false;
};

export type SessionQueuedTurn = SessionTurnExecutionProjectionBase & {
  state: "queued";
  queuePosition: number;
  canCancel: boolean;
};

export type SessionTerminalTurn = SessionTurnExecutionProjectionBase & {
  state: "completed" | "failed" | "canceled" | "interrupted";
  queuePosition: null;
  canCancel: false;
};

export type SessionOutboundTurn = SessionTurnExecutionProjectionBase & {
  state: "accepted";
  queuePosition: null;
  canCancel: false;
  acceptanceSequence: number;
  sourceMessageSequence: number;
  relatedSession: {
    direction: "outbound";
    sessionId: string;
    titleSnapshot: string;
    roleSnapshot: import("./session-role-binding.js").SessionRole;
  };
};

export type SessionTurnExecutionProjection =
  | SessionRunningTurn
  | SessionQueuedTurn
  | SessionTerminalTurn
  | SessionOutboundTurn;

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
  current: readonly SessionTurnExecutionProjection[],
  event: SessionExecutionChangedEvent,
): SessionTurnExecutionProjection[] {
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
  current: readonly SessionTurnExecutionProjection[],
  event: SessionExecutionChangedEvent,
  barrier: SessionRunningProjectionBarrier | null,
): SessionTurnExecutionProjection[] {
  if (
    event.kind === "state-changed" &&
    event.state !== "running" &&
    barrier?.executionId === event.executionId
  ) {
    return [...current];
  }
  return applySessionExecutionChangedEvent(current, event);
}

export function mergeTurnExecutionRefreshWithBarrier(
  current: readonly SessionTurnExecutionProjection[],
  refreshed: readonly SessionTurnExecutionProjection[],
  barrier: SessionRunningProjectionBarrier | null,
): SessionTurnExecutionProjection[] {
  if (!barrier || refreshed.some((execution) => execution.executionId === barrier.executionId)) {
    return [...refreshed];
  }
  const retained = current.find((execution) => (
    execution.executionId === barrier.executionId && execution.state === "running"
  ));
  if (!retained) return [...refreshed];

  const refreshedById = new Map(refreshed.map((execution) => [execution.executionId, execution]));
  const merged: SessionTurnExecutionProjection[] = [];
  for (const execution of current) {
    if (execution.executionId === retained.executionId) {
      merged.push(retained);
      continue;
    }
    const refreshedExecution = refreshedById.get(execution.executionId);
    if (!refreshedExecution) continue;
    merged.push(refreshedExecution);
    refreshedById.delete(execution.executionId);
  }
  for (const execution of refreshed) {
    if (refreshedById.delete(execution.executionId)) merged.push(execution);
  }
  return merged;
}

export type SessionTurnAdmissionError = {
  code: string;
  message: string;
  retryable: boolean;
};

export type EnqueueSessionTurnResult =
  | { ok: true; execution: SessionTurnExecutionProjection | null }
  | { ok: false; error: SessionTurnAdmissionError };

export type CancelSessionExecutionRequest = {
  executionId: string;
  clientRequestId: string;
};

export type CancelSessionExecutionResult =
  | { ok: true }
  | { ok: false; error: SessionTurnAdmissionError };
import type { SessionExecutionState } from "./session-execution.js";
