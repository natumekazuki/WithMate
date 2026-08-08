import type { CliRunCancellationSummary } from "./contract.js";

export function snapshotCliRunRequestCancellation(
  value: unknown,
  terminalAt?: number,
): Readonly<{ requestedAt: number; acknowledgedAt?: never }> {
  const cancellation = snapshotCancellation(value);
  if (
    cancellation.acknowledgedAt !== undefined ||
    (terminalAt !== undefined && cancellation.requestedAt > terminalAt)
  ) {
    malformed();
  }
  return { requestedAt: cancellation.requestedAt };
}

export function snapshotCliRunAcknowledgedCancellation(
  value: unknown,
  terminalAt: number,
): Readonly<{ requestedAt: number; acknowledgedAt: number }> {
  const cancellation = snapshotCancellation(value);
  if (
    cancellation.acknowledgedAt === undefined ||
    cancellation.acknowledgedAt < cancellation.requestedAt ||
    cancellation.acknowledgedAt > terminalAt
  ) {
    malformed();
  }
  return { requestedAt: cancellation.requestedAt, acknowledgedAt: cancellation.acknowledgedAt };
}

function snapshotCancellation(value: unknown): CliRunCancellationSummary {
  const cancellation = exactRecord(value, ["requestedAt", "acknowledgedAt"]);
  return {
    requestedAt: nonNegativeInteger(cancellation.requestedAt),
    ...(cancellation.acknowledgedAt === undefined
      ? {}
      : { acknowledgedAt: nonNegativeInteger(cancellation.acknowledgedAt) }),
  };
}

function exactRecord(value: unknown, allowedKeys: readonly string[]): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) malformed();
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) malformed();
  const entries: [string, unknown][] = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowedKeys.includes(key)) malformed();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) malformed();
    entries.push([key, descriptor.value]);
  }
  return Object.fromEntries(entries);
}

function nonNegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) malformed();
  return value as number;
}

function malformed(): never {
  throw new TypeError("Run cancellation projection is invalid.");
}
