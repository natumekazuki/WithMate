import {
  APPLICATION_RUN_LIMITS,
  type ApplicationRunCancellationSummary,
  type ApplicationRunFailureSummary,
  type ApplicationRunPhase,
} from "../shared/application-run-model.js";

type PersistedRunBase = Readonly<{
  retryOfRunId?: string;
  createdAt: number;
  startedAt?: number;
  updatedAt: number;
}>;

export type PersistedRunProjection =
  | (PersistedRunBase &
      Readonly<{
        phase: "queued" | "starting" | "active" | "finalizing";
        terminalAt?: never;
        failure?: never;
        cancellation?: never;
      }>)
  | (PersistedRunBase &
      Readonly<{
        phase: "canceling";
        terminalAt?: never;
        failure?: never;
        cancellation?: ApplicationRunCancellationSummary;
      }>)
  | (PersistedRunBase &
      Readonly<{
        phase: "completed";
        terminalAt: number;
        failure?: never;
        cancellation?: never;
      }>)
  | (PersistedRunBase &
      Readonly<{
        phase: "failed" | "interrupted";
        terminalAt: number;
        failure: ApplicationRunFailureSummary;
        cancellation?: ApplicationRunCancellationSummary;
      }>)
  | (PersistedRunBase &
      Readonly<{
        phase: "canceled";
        terminalAt: number;
        failure?: never;
        cancellation?: ApplicationRunCancellationSummary;
      }>);

export const PERSISTED_RUN_PROJECTION_KEYS = [
  "retryOfRunId",
  "phase",
  "failureOrigin",
  "errorSummary",
  "cancelRequestedAt",
  "cancelAcknowledgedAt",
  "createdAt",
  "startedAt",
  "terminalAt",
  "updatedAt",
] as const;

export function projectPersistedRun(value: unknown): PersistedRunProjection {
  const run = projectionRecord(value, PERSISTED_RUN_PROJECTION_KEYS);
  const phase = runPhase(run.phase);
  const retryOfRunId = optionalBoundedString(run.retryOfRunId, APPLICATION_RUN_LIMITS.maxIdentifierLength);
  const createdAt = nonNegativeInteger(run.createdAt);
  const startedAt = optionalNonNegativeInteger(run.startedAt);
  const updatedAt = nonNegativeInteger(run.updatedAt);
  const terminalAt = optionalNonNegativeInteger(run.terminalAt);
  const failureOrigin = optionalFailureOrigin(run.failureOrigin);
  const errorSummary = optionalBoundedString(run.errorSummary, APPLICATION_RUN_LIMITS.maxSummaryLength);
  const requestedAt = optionalNonNegativeInteger(run.cancelRequestedAt);
  const acknowledgedAt = optionalNonNegativeInteger(run.cancelAcknowledgedAt);
  if (acknowledgedAt !== undefined && requestedAt === undefined) {
    throw new TypeError("Cancel acknowledgment has no request.");
  }
  const cancellation =
    requestedAt === undefined
      ? undefined
      : { requestedAt, ...(acknowledgedAt === undefined ? {} : { acknowledgedAt }) };
  const base = {
    ...(retryOfRunId === undefined ? {} : { retryOfRunId }),
    createdAt,
    ...(startedAt === undefined ? {} : { startedAt }),
    updatedAt,
  } as const;

  if (isTerminalPhase(phase) !== (terminalAt !== undefined)) {
    throw new TypeError(
      isTerminalPhase(phase) ? "Terminal Run has no terminal time." : "Non-terminal Run has terminal time.",
    );
  }
  if (phase !== "failed" && phase !== "interrupted" && (failureOrigin !== undefined || errorSummary !== undefined)) {
    throw new TypeError("Non-failure Run has failure details.");
  }
  if ((phase === "failed" || phase === "interrupted") && failureOrigin === undefined) {
    throw new TypeError("Failure Run has no origin.");
  }
  if (!["canceling", "failed", "interrupted", "canceled"].includes(phase) && cancellation !== undefined) {
    throw new TypeError("Run phase has cancellation details.");
  }

  switch (phase) {
    case "queued":
    case "starting":
    case "active":
    case "finalizing":
      return { ...base, phase };
    case "canceling":
      return { ...base, phase, ...(cancellation === undefined ? {} : { cancellation }) };
    case "completed":
      return { ...base, phase, terminalAt: terminalAt as number };
    case "failed":
    case "interrupted":
      return {
        ...base,
        phase,
        terminalAt: terminalAt as number,
        failure: {
          origin: failureOrigin as ApplicationRunFailureSummary["origin"],
          ...(errorSummary === undefined ? {} : { summary: errorSummary }),
        },
        ...(cancellation === undefined ? {} : { cancellation }),
      };
    case "canceled":
      return {
        ...base,
        phase,
        terminalAt: terminalAt as number,
        ...(cancellation === undefined ? {} : { cancellation }),
      };
  }
}

function isTerminalPhase(phase: ApplicationRunPhase): boolean {
  return phase === "completed" || phase === "failed" || phase === "canceled" || phase === "interrupted";
}

function projectionRecord(value: unknown, allowedKeys: readonly string[]): Readonly<Record<string, unknown>> {
  if (!isPlainObject(value)) throw new TypeError("Projection object is invalid.");
  return Object.fromEntries(allowedKeys.map((key) => [key, value[key]]));
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function boundedString(value: unknown, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new TypeError("String is invalid.");
  }
  return value;
}

function optionalBoundedString(value: unknown, maxLength: number): string | undefined {
  return value === undefined ? undefined : boundedString(value, maxLength);
}

function nonNegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError("Integer is invalid.");
  return value as number;
}

function optionalNonNegativeInteger(value: unknown): number | undefined {
  return value === undefined ? undefined : nonNegativeInteger(value);
}

function runPhase(value: unknown): ApplicationRunPhase {
  if (
    value !== "queued" &&
    value !== "starting" &&
    value !== "active" &&
    value !== "canceling" &&
    value !== "finalizing" &&
    value !== "completed" &&
    value !== "failed" &&
    value !== "canceled" &&
    value !== "interrupted"
  ) {
    throw new TypeError("Run phase is invalid.");
  }
  return value;
}

function optionalFailureOrigin(value: unknown): ApplicationRunFailureSummary["origin"] | undefined {
  if (value === undefined) return undefined;
  if (
    value !== "provider" &&
    value !== "transport" &&
    value !== "process" &&
    value !== "application" &&
    value !== "persistence" &&
    value !== "unknown"
  ) {
    throw new TypeError("Failure origin is invalid.");
  }
  return value;
}
