export type CodexRequestNotSentCode =
  | "not_ready"
  | "closing"
  | "timeout"
  | "aborted"
  | "pending_limit"
  | "invalid_request"
  | "write_rejected"
  | "server_request_settled"
  | "event_waiter_exists";

export type CodexResponseUnknownCode = "timeout" | "aborted" | "connection_lost" | "write_failed";

export type CodexConnectionFailureCode =
  | "handshake_invalid"
  | "handshake_write_failed"
  | "event_queue_overflow"
  | "server_request_limit"
  | "duplicate_server_request"
  | "spawn_failed"
  | "process_exited"
  | "stdin_failed"
  | "stdout_failed"
  | "stderr_failed"
  | "protocol_failed"
  | "close_failed";

export type CodexTransportFailure =
  | Readonly<{ kind: "request_not_sent"; code: CodexRequestNotSentCode }>
  | Readonly<{ kind: "response_unknown"; code: CodexResponseUnknownCode }>
  | Readonly<{ kind: "remote_error"; code: number }>
  | Readonly<{ kind: "connection_failure"; code: CodexConnectionFailureCode }>;

export class CodexTransportError extends Error {
  constructor(readonly failure: CodexTransportFailure) {
    super(failureMessage(failure));
    this.name = "CodexTransportError";
  }
}

export type CodexWireWriteFailure = Readonly<{
  outcome: "not_sent" | "unknown";
  code: "queue_full" | "invalid_message" | "stream_unavailable";
}>;

export class CodexWireWriteError extends Error {
  constructor(readonly failure: CodexWireWriteFailure) {
    super("Codex App Server wire write failed.");
    this.name = "CodexWireWriteError";
  }
}

export function requestNotSent(code: CodexRequestNotSentCode): CodexTransportError {
  return new CodexTransportError({ kind: "request_not_sent", code });
}

export function responseUnknown(code: CodexResponseUnknownCode): CodexTransportError {
  return new CodexTransportError({ kind: "response_unknown", code });
}

export function connectionFailure(code: CodexConnectionFailureCode): CodexTransportError {
  return new CodexTransportError({ kind: "connection_failure", code });
}

function failureMessage(failure: CodexTransportFailure): string {
  switch (failure.kind) {
    case "request_not_sent":
      return "Codex App Server request was not sent.";
    case "response_unknown":
      return "Codex App Server response is unknown.";
    case "remote_error":
      return "Codex App Server rejected the request.";
    case "connection_failure":
      return "Codex App Server connection failed.";
  }
}
