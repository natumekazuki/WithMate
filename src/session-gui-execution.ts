export type SessionQueuedTurn = {
  executionId: string;
  sessionId: string;
  clientRequestId: string | null;
  userMessage: string;
  queuePosition: number;
  canCancel: boolean;
  createdAt: string;
  updatedAt: string;
};

export type SessionTurnAdmissionError = {
  code: string;
  message: string;
  retryable: boolean;
};

export type EnqueueSessionTurnResult =
  | { ok: true; execution: SessionQueuedTurn | null }
  | { ok: false; error: SessionTurnAdmissionError };

export type CancelSessionExecutionRequest = {
  executionId: string;
  clientRequestId: string;
};

export type CancelSessionExecutionResult =
  | { ok: true }
  | { ok: false; error: SessionTurnAdmissionError };
