export const PERSISTENCE_PROTOCOL_VERSION = 1 as const;

export type PersistenceProtocolVersion = typeof PERSISTENCE_PROTOCOL_VERSION;

export type PersistenceRequestClass = "read" | "write" | "maintenance";

export type PersistenceFailureEffect = "none" | "unknown";

export type PersistenceErrorCode =
  | "protocol_invalid"
  | "protocol_version_unsupported"
  | "worker_not_ready"
  | "worker_closing"
  | "worker_crashed"
  | "worker_start_failed"
  | "worker_shutdown_forced"
  | "request_canceled"
  | "request_timeout"
  | "request_id_duplicate"
  | "queue_full"
  | "request_invalid"
  | "cursor_invalid"
  | "not_found"
  | "operation_not_supported"
  | "database_busy"
  | "database_unavailable"
  | "response_too_large"
  | "payload_chunk_invalid"
  | "payload_chunk_too_large"
  | "operation_failed"
  | "internal_error";

export type PersistenceError = Readonly<{
  code: PersistenceErrorCode;
  message: string;
  retryable: boolean;
  effect: PersistenceFailureEffect;
}>;

type PersistenceMessageBase = Readonly<{
  protocolVersion: PersistenceProtocolVersion;
  generationId: string;
}>;

export type PersistenceRequestMessage<TOperation extends string = string, TPayload = unknown> = PersistenceMessageBase &
  Readonly<{
    kind: "request";
    requestId: string;
    requestSequence: number;
    operation: TOperation;
    requestClass: PersistenceRequestClass;
    payload: TPayload;
  }>;

export type PersistenceCancelMessage = PersistenceMessageBase &
  Readonly<{
    kind: "cancel";
    requestId: string;
  }>;

export type PersistenceShutdownMessage = PersistenceMessageBase &
  Readonly<{
    kind: "shutdown";
    requestId: string;
  }>;

export type MainToWorkerMessage<TOperation extends string = string, TPayload = unknown> =
  PersistenceRequestMessage<TOperation, TPayload> | PersistenceCancelMessage | PersistenceShutdownMessage;

export type PersistenceReadyMessage = PersistenceMessageBase &
  Readonly<{
    kind: "ready";
  }>;

export type PersistenceStartupFailedMessage = PersistenceMessageBase &
  Readonly<{
    kind: "startupFailed";
    error: PersistenceError;
  }>;

export type PersistenceSuccessResponse<TResult = unknown> = PersistenceMessageBase &
  Readonly<{
    kind: "response";
    requestId: string;
    ok: true;
    result: TResult;
  }>;

export type PersistenceFailureResponse = PersistenceMessageBase &
  Readonly<{
    kind: "response";
    requestId: string;
    ok: false;
    error: PersistenceError;
  }>;

export type PersistenceResponseMessage<TResult = unknown> =
  PersistenceSuccessResponse<TResult> | PersistenceFailureResponse;

export type PersistenceClosedMessage = PersistenceMessageBase &
  Readonly<{
    kind: "closed";
    requestId: string;
    checkpoint: "completed" | "failed";
  }>;

export type WorkerToMainMessage<TResult = unknown> =
  | PersistenceReadyMessage
  | PersistenceStartupFailedMessage
  | PersistenceResponseMessage<TResult>
  | PersistenceClosedMessage;

// S2で公開したenvelope型は後続sliceとの互換のため維持する。
export type PersistenceRequestEnvelope<TType extends string, TPayload> = Readonly<{
  protocolVersion: PersistenceProtocolVersion;
  requestId: string;
  type: TType;
  payload: TPayload;
}>;

export type PersistenceSuccessEnvelope<TResult> = Readonly<{
  protocolVersion: PersistenceProtocolVersion;
  requestId: string;
  ok: true;
  result: TResult;
}>;

export type PersistenceFailureEnvelope = Readonly<{
  protocolVersion: PersistenceProtocolVersion;
  requestId: string;
  ok: false;
  error: Readonly<{
    code: string;
    message: string;
    retryable: boolean;
  }>;
}>;

export type PersistenceResponseEnvelope<TResult> = PersistenceSuccessEnvelope<TResult> | PersistenceFailureEnvelope;
