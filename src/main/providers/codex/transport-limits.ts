export type CodexTransportLimits = Readonly<{
  maxLineBytes: number;
  maxPendingRequests: number;
  maxRetiredUnsentRequestIds: number;
  maxOutstandingServerRequestIdBytes: number;
  maxQueuedEvents: number;
  maxQueuedWriteBytes: number;
  maxStderrBytes: number;
}>;

export const CODEX_TRANSPORT_LIMITS: CodexTransportLimits = Object.freeze({
  maxLineBytes: 1024 * 1024,
  maxPendingRequests: 128,
  maxRetiredUnsentRequestIds: 4096,
  maxOutstandingServerRequestIdBytes: 256 * 1024,
  maxQueuedEvents: 128,
  maxQueuedWriteBytes: 2 * 1024 * 1024,
  maxStderrBytes: 64 * 1024,
});

export function validateCodexTransportLimits(limits: CodexTransportLimits): CodexTransportLimits {
  const names = [
    "maxLineBytes",
    "maxPendingRequests",
    "maxRetiredUnsentRequestIds",
    "maxOutstandingServerRequestIdBytes",
    "maxQueuedEvents",
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
