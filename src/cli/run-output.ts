import { exitCodeForCliApplicationResponse, projectCliReadApplicationResponse } from "./application-response.js";
import {
  CLI_EXIT_CODES,
  CLI_RUN_LIMITS,
  CLI_SCHEMA_VERSION,
  CLI_SESSION_LIMITS,
  type CliExitCode,
  type CliRunEventsValue,
  type CliRunFollowValue,
  type CliRunOperation,
  type CliRunOperationOutput,
  type CliRunStatusValue,
  type CliRuntimeFailureOutput,
  type CliValidatedRunCommand,
} from "./contract.js";

export type CliRunOperationProjectionResult =
  | Readonly<{ ok: true; output: CliRunOperationOutput; exitCode: CliExitCode }>
  | Readonly<{ ok: false; output: CliRuntimeFailureOutput; exitCode: typeof CLI_EXIT_CODES.runtimeFailure }>;

export function projectCliRunOperationOutput(
  command: CliValidatedRunCommand,
  applicationResponse: unknown,
): CliRunOperationProjectionResult {
  try {
    const projected = projectCliReadApplicationResponse(
      applicationResponse,
      (value) => projectRunValue(command, value),
      CLI_RUN_LIMITS.eventsMaxItems,
    );
    validateRunResponse(command, projected);
    const output = {
      schemaVersion: CLI_SCHEMA_VERSION,
      kind: "operation",
      command: command.identity,
      applicationResponse: projected,
    } as CliRunOperationOutput;
    return { ok: true, output, exitCode: exitCodeForCliApplicationResponse(projected) };
  } catch {
    return {
      ok: false,
      output: {
        schemaVersion: CLI_SCHEMA_VERSION,
        kind: "runtime_failure",
        command: command.identity,
        error: {
          kind: "runtime",
          code: "malformed_application_response",
          stage: "operation",
          message: "Application operation returned an invalid response.",
        },
      },
      exitCode: CLI_EXIT_CODES.runtimeFailure,
    };
  }
}

function projectRunValue(command: CliValidatedRunCommand, value: unknown): unknown {
  if (isCommandFor(command, "status")) return projectStatus(value, command.sessionId, command.runId);
  if (isCommandFor(command, "events")) return projectEvents(value, command.sessionId, command.runId, command.limit);
  if (isCommandFor(command, "follow")) return projectFollow(value, command.sessionId, command.runId, command.limit);
  malformed();
}

function projectStatus(value: unknown, expectedSessionId: string, expectedRunId: string): CliRunStatusValue {
  const status = record(value);
  const sessionId = boundedString(status.sessionId);
  const runId = boundedString(status.runId);
  if (sessionId !== expectedSessionId || runId !== expectedRunId) malformed();
  const phase = enumValue(status.phase, [
    "queued",
    "starting",
    "active",
    "canceling",
    "finalizing",
    "completed",
    "failed",
    "canceled",
    "interrupted",
  ] as const);
  const base = {
    sessionId,
    runId,
    ...(status.retryOfRunId === undefined ? {} : { retryOfRunId: boundedString(status.retryOfRunId) }),
    createdAt: nonNegativeInteger(status.createdAt),
    ...(status.startedAt === undefined ? {} : { startedAt: nonNegativeInteger(status.startedAt) }),
    updatedAt: nonNegativeInteger(status.updatedAt),
  };
  switch (phase) {
    case "queued":
    case "starting":
    case "finalizing":
      requireNullLiveOnly(status);
      return { ...base, phase, liveActivity: null };
    case "active": {
      const liveActivity =
        status.liveActivity === null
          ? null
          : enumValue(status.liveActivity, ["running", "waiting_approval", "waiting_input", "waiting_child"] as const);
      requireAbsent(status, ["failure", "cancellation", "terminalAt"]);
      return { ...base, phase, liveActivity };
    }
    case "canceling":
      if (status.liveActivity !== null) malformed();
      requireAbsent(status, ["failure", "terminalAt"]);
      return {
        ...base,
        phase,
        liveActivity: null,
        ...(status.cancellation === undefined ? {} : { cancellation: projectCancellation(status.cancellation) }),
      };
    case "completed":
      if (status.liveActivity !== null) malformed();
      requireAbsent(status, ["failure", "cancellation"]);
      return { ...base, phase, liveActivity: null, terminalAt: nonNegativeInteger(status.terminalAt) };
    case "failed":
    case "interrupted":
      if (status.liveActivity !== null) malformed();
      return {
        ...base,
        phase,
        liveActivity: null,
        terminalAt: nonNegativeInteger(status.terminalAt),
        failure: projectFailure(status.failure),
        ...(status.cancellation === undefined ? {} : { cancellation: projectCancellation(status.cancellation) }),
      };
    case "canceled":
      if (status.liveActivity !== null) malformed();
      requireAbsent(status, ["failure"]);
      return {
        ...base,
        phase,
        liveActivity: null,
        terminalAt: nonNegativeInteger(status.terminalAt),
        ...(status.cancellation === undefined ? {} : { cancellation: projectCancellation(status.cancellation) }),
      };
  }
}

function projectFailure(value: unknown) {
  const failure = record(value);
  return {
    origin: enumValue(failure.origin, [
      "provider",
      "transport",
      "process",
      "application",
      "persistence",
      "unknown",
    ] as const),
    ...(failure.summary === undefined
      ? {}
      : { summary: boundedString(failure.summary, CLI_RUN_LIMITS.maxSummaryLength) }),
  };
}

function projectCancellation(value: unknown) {
  const cancellation = record(value);
  return {
    requestedAt: nonNegativeInteger(cancellation.requestedAt),
    ...(cancellation.acknowledgedAt === undefined
      ? {}
      : { acknowledgedAt: nonNegativeInteger(cancellation.acknowledgedAt) }),
  };
}

function projectEvents(
  value: unknown,
  expectedSessionId: string,
  expectedRunId: string,
  limit: number,
): CliRunEventsValue {
  const page = record(value);
  const sessionId = boundedString(page.sessionId);
  const runId = boundedString(page.runId);
  if (sessionId !== expectedSessionId || runId !== expectedRunId) malformed();
  let previousOrdinal = 0;
  const items = snapshotDenseArray(page.items, limit).map((value) => {
    const event = record(value);
    const ordinal = positiveInteger(event.ordinal);
    if (ordinal <= previousOrdinal) malformed();
    previousOrdinal = ordinal;
    const summary = optionalPublicSummary(event.summary, CLI_RUN_LIMITS.maxSummaryLength);
    return {
      ordinal,
      kind: enumValue(event.kind, ["run_terminal", "child_result_collected", "unknown"] as const),
      ...(summary === undefined ? {} : { summary }),
      createdAt: nonNegativeInteger(event.createdAt),
    };
  });
  return {
    sessionId,
    runId,
    items,
    nextCursor: boundedString(page.nextCursor, CLI_SESSION_LIMITS.maxCursorLength),
  };
}

function projectFollow(
  value: unknown,
  expectedSessionId: string,
  expectedRunId: string,
  limit: number,
): CliRunFollowValue {
  const follow = record(value);
  const reason = enumValue(follow.reason, ["events", "terminal", "deadline"] as const);
  const status = projectStatus(follow.status, expectedSessionId, expectedRunId);
  const events = projectEvents(follow.events, expectedSessionId, expectedRunId, limit);
  if (reason === "terminal" && !["completed", "failed", "canceled", "interrupted"].includes(status.phase)) {
    malformed();
  }
  if (reason === "deadline" && ["completed", "failed", "canceled", "interrupted"].includes(status.phase)) {
    malformed();
  }
  if (reason === "deadline" && events.items.length !== 0) malformed();
  const containsTerminalEvent = events.items.some((event) => event.kind === "run_terminal");
  if (containsTerminalEvent && reason !== "terminal") malformed();
  return { reason, status, events } as CliRunFollowValue;
}

function validateRunResponse(
  command: CliValidatedRunCommand,
  response: Readonly<{ overallStatus: string; value?: unknown; issues?: readonly unknown[] }>,
): void {
  if (response.overallStatus === "failure") return;
  if (isCommandFor(command, "status")) {
    if (response.overallStatus === "partial_success") malformed();
    return;
  }
  const value = record(response.value);
  if (isCommandFor(command, "events")) {
    const items = snapshotDenseArray(value.items, command.limit);
    const consumedCount = items.length + (response.issues?.length ?? 0);
    if (consumedCount > command.limit) malformed();
    validateCursorProgress(
      command.cursor,
      boundedString(value.nextCursor, CLI_SESSION_LIMITS.maxCursorLength),
      consumedCount,
    );
    return;
  }
  if (!isCommandFor(command, "follow")) malformed();
  const page = record(value.events);
  const items = snapshotDenseArray(page.items, command.limit);
  const consumedCount = items.length + (response.issues?.length ?? 0);
  if (consumedCount > command.limit) malformed();
  validateCursorProgress(
    command.cursor,
    boundedString(page.nextCursor, CLI_SESSION_LIMITS.maxCursorLength),
    consumedCount,
  );
  if (value.reason === "deadline" && response.overallStatus === "partial_success") malformed();
  if (value.reason === "events" && items.length === 0 && response.overallStatus !== "partial_success") malformed();
}

function validateCursorProgress(inputCursor: string | undefined, nextCursor: string, consumedCount: number): void {
  if (consumedCount > 0 && nextCursor === inputCursor) malformed();
  if (consumedCount === 0 && inputCursor !== undefined && nextCursor !== inputCursor) malformed();
}

function requireNullLiveOnly(status: Readonly<Record<string, unknown>>): void {
  if (status.liveActivity !== null) malformed();
  requireAbsent(status, ["failure", "cancellation", "terminalAt"]);
}

function requireAbsent(value: Readonly<Record<string, unknown>>, keys: readonly string[]): void {
  if (keys.some((key) => value[key] !== undefined)) malformed();
}

function snapshotDenseArray(value: unknown, maxLength: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maxLength) malformed();
  const length = value.length;
  const snapshot: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    if (value.length !== length || !Object.hasOwn(value, index)) malformed();
    const item = value[index];
    if (value.length !== length) malformed();
    snapshot.push(item);
  }
  return snapshot;
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) malformed();
  return value as Readonly<Record<string, unknown>>;
}

function boundedString(value: unknown, maxLength: number = CLI_SESSION_LIMITS.maxIdentifierLength): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || value.includes("\0")) malformed();
  return value;
}

function optionalPublicSummary(value: unknown, maxLength: number): string | undefined {
  return value === undefined || value === "" ? undefined : boundedString(value, maxLength);
}

function nonNegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) malformed();
  return value as number;
}

function positiveInteger(value: unknown): number {
  const parsed = nonNegativeInteger(value);
  if (parsed === 0) malformed();
  return parsed;
}

function enumValue<TValue extends string>(value: unknown, allowed: readonly TValue[]): TValue {
  if (typeof value !== "string" || !allowed.includes(value as TValue)) malformed();
  return value as TValue;
}

function isCommandFor<TOperation extends CliRunOperation>(
  command: CliValidatedRunCommand,
  operation: TOperation,
): command is Extract<
  CliValidatedRunCommand,
  Readonly<{ identity: Readonly<{ namespace: "run"; operation: TOperation }> }>
> {
  return command.identity.operation === operation;
}

function malformed(): never {
  throw new TypeError("Application response is invalid.");
}
