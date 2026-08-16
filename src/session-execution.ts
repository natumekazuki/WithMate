export const SESSION_EXECUTION_QUEUE_LIMIT = 10;

export type SessionExecutionOperation = "turn.run" | "turn.enqueue";
export type SessionExecutionMutationOperation = SessionExecutionOperation | "turn.cancel";

export type TurnInitiator =
  | { kind: "user" }
  | {
      kind: "session";
      sessionId: string;
      character: {
        characterId: string;
        name: string;
        iconFilePath: string;
      };
    };

export type SessionExecutionState =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "canceled"
  | "interrupted";

export type SessionExecution = {
  id: string;
  sessionId: string;
  operation: SessionExecutionOperation;
  state: SessionExecutionState;
  result: unknown | null;
  errorCode: string;
  reason: string;
  createdAt: string;
  admittedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
};

export type SessionExecutionStorageRecord = SessionExecution & {
  sequence: number;
  request: unknown;
};

export type SessionExecutionTurnResult = {
  assistantText: string;
};
