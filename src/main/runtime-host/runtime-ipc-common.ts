import { RUNTIME_IPC_SHARED_LIMITS } from "../../shared/application-run-interaction-limits.js";

export const RUNTIME_IPC_PROTOCOL_VERSION = "withmate-runtime-ipc-v1" as const;
export const RUNTIME_IPC_PROTOCOL_FAMILY = "withmate-runtime-ipc" as const;

export const RUNTIME_IPC_LIMITS = Object.freeze({
  maxLineBytes: RUNTIME_IPC_SHARED_LIMITS.maxLineBytes,
  maxBufferedBytes: 1024 * 1024,
  maxBinaryBytes: 256 * 1024,
  maxStringBytes: 384 * 1024,
  maxValueDepth: 64,
  maxArrayItems: 4_096,
  maxObjectEntries: 1_024,
  maxFailureMessageBytes: 512,
  maxConnections: 32,
  maxRequestsPerConnection: 10_000,
  maxInFlightPerConnection: 32,
  maxInFlightHost: 128,
  maxQueuedResponsesPerConnection: 64,
  maxQueuedResponsesHost: 256,
  maxQueuedResponseBytesPerConnection: 2 * 1024 * 1024,
  maxQueuedResponseBytesHost: 16 * 1024 * 1024,
  handshakeTimeoutMs: 10_000,
  partialLineTimeoutMs: 10_000,
});

export type RuntimeIpcProtocolErrorCode =
  | "binary_too_large"
  | "buffer_too_large"
  | "duplicate_field"
  | "empty_line"
  | "invalid_binary"
  | "invalid_envelope"
  | "invalid_json"
  | "invalid_utf8"
  | "invalid_value"
  | "line_too_large"
  | "partial_line"
  | "version_mismatch";

export class RuntimeIpcProtocolError extends Error {
  constructor(readonly code: RuntimeIpcProtocolErrorCode) {
    super(runtimeProtocolErrorMessage(code));
    this.name = "RuntimeIpcProtocolError";
  }
}

export function runtimeProtocolFailure(code: RuntimeIpcProtocolErrorCode): RuntimeIpcProtocolError {
  return new RuntimeIpcProtocolError(code);
}

function runtimeProtocolErrorMessage(code: RuntimeIpcProtocolErrorCode): string {
  switch (code) {
    case "binary_too_large":
      return "Runtime IPC binary value exceeds its limit.";
    case "buffer_too_large":
      return "Runtime IPC buffered input exceeds its limit.";
    case "duplicate_field":
      return "Runtime IPC JSON contains a duplicate object field.";
    case "empty_line":
      return "Runtime IPC received an empty protocol line.";
    case "invalid_binary":
      return "Runtime IPC binary value is invalid.";
    case "invalid_envelope":
      return "Runtime IPC envelope is invalid.";
    case "invalid_json":
      return "Runtime IPC JSON is invalid.";
    case "invalid_utf8":
      return "Runtime IPC input is not valid UTF-8.";
    case "invalid_value":
      return "Runtime IPC value is invalid.";
    case "line_too_large":
      return "Runtime IPC line exceeds its limit.";
    case "partial_line":
      return "Runtime IPC input ended with a partial line.";
    case "version_mismatch":
      return "Runtime IPC protocol version is unsupported.";
  }
}
