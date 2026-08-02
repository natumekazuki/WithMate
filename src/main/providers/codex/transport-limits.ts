import { APPLICATION_RUN_PAYLOAD_LIMITS } from "../../../shared/application-run-payload-limits.js";

export type CodexTransportLimits = Readonly<{
  maxLineBytes: number;
  maxPendingRequests: number;
  maxRetiredUnsentRequestIds: number;
  maxOutstandingServerRequestIdBytes: number;
  maxQueuedEvents: number;
  maxQueuedEventBytes: number;
  maxQueuedWriteBytes: number;
  maxStderrBytes: number;
}>;

export const CODEX_TRANSPORT_LIMITS: CodexTransportLimits = Object.freeze({
  maxLineBytes: APPLICATION_RUN_PAYLOAD_LIMITS.codexWireMaxLineBytes,
  maxPendingRequests: 128,
  maxRetiredUnsentRequestIds: 4096,
  maxOutstandingServerRequestIdBytes: 256 * 1024,
  maxQueuedEvents: 128,
  maxQueuedEventBytes: APPLICATION_RUN_PAYLOAD_LIMITS.codexWireMaxLineBytes * 2,
  maxQueuedWriteBytes: APPLICATION_RUN_PAYLOAD_LIMITS.codexWireMaxLineBytes * 2,
  maxStderrBytes: 64 * 1024,
});

export function validateCodexTransportLimits(limits: CodexTransportLimits): CodexTransportLimits {
  const names = [
    "maxLineBytes",
    "maxPendingRequests",
    "maxRetiredUnsentRequestIds",
    "maxOutstandingServerRequestIdBytes",
    "maxQueuedEvents",
    "maxQueuedEventBytes",
    "maxQueuedWriteBytes",
    "maxStderrBytes",
  ] as const satisfies readonly (keyof CodexTransportLimits)[];
  if (
    typeof limits !== "object" ||
    limits === null ||
    Array.isArray(limits) ||
    Object.keys(limits).length !== names.length ||
    !Object.keys(limits).every((name) => names.includes(name as (typeof names)[number]))
  ) {
    throw new RangeError("Codex transport limits must contain exactly the supported limit fields.");
  }
  for (const name of names) {
    const value = limits[name];
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError(`${name} must be a positive safe integer.`);
    }
  }
  return Object.freeze({ ...limits });
}
