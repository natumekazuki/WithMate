import {
  exitCodeForCliApplicationResponse,
  projectCliReadApplicationResponse,
  projectCliWriteApplicationResponse,
} from "./application-response.js";
import {
  CLI_EXIT_CODES,
  CLI_RUN_LIMITS,
  CLI_SCHEMA_VERSION,
  CLI_SESSION_LIMITS,
  type CliExitCode,
  type CliRunAdmissionValue,
  type CliRunEventsValue,
  type CliRunFollowValue,
  type CliRunInputValue,
  type CliRunOperation,
  type CliRunOperationOutput,
  type CliRunStatusValue,
  type CliRuntimeFailureOutput,
  type CliValidatedRunCommand,
} from "./contract.js";
import { isApplicationRunSendInputDomainErrorCode } from "../shared/application-run-model.js";
import { isRunOutputCommand, projectCliRunOutputOperationOutput } from "./run-output-payload.js";

export type CliRunOperationProjectionResult =
  | Readonly<{ ok: true; output: CliRunOperationOutput; exitCode: CliExitCode }>
  | Readonly<{ ok: false; output: CliRuntimeFailureOutput; exitCode: typeof CLI_EXIT_CODES.runtimeFailure }>;

export function projectCliRunOperationOutput(
  command: CliValidatedRunCommand,
  applicationResponse: unknown,
): CliRunOperationProjectionResult {
  if (isRunOutputCommand(command)) return projectCliRunOutputOperationOutput(command, applicationResponse);
  try {
    const projected =
      isCommandFor(command, "start") || isCommandFor(command, "retry") || isCommandFor(command, "send-input")
        ? projectCliWriteApplicationResponse(applicationResponse, (value) => projectRunValue(command, value))
        : projectCliReadApplicationResponse(
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
  if (isCommandFor(command, "start") || isCommandFor(command, "retry")) {
    return projectAdmission(value, command);
  }
  if (isCommandFor(command, "send-input")) return projectInput(value, command.sessionId, command.runId);
  if (isCommandFor(command, "status")) return projectStatus(value, command.sessionId, command.runId);
  if (isCommandFor(command, "events")) return projectEvents(value, command.sessionId, command.runId, command.limit);
  if (isCommandFor(command, "follow")) return projectFollow(value, command.sessionId, command.runId, command.limit);
  malformed();
}

function projectInput(value: unknown, expectedSessionId: string, expectedRunId: string): CliRunInputValue {
  let input = record(value);
  const deliveryState = enumValue(input.deliveryState, [
    "pending",
    "accepted",
    "rejected",
    "ambiguous",
    "aborted",
  ] as const);
  input = exactRecord(
    input,
    deliveryState === "pending" || deliveryState === "accepted"
      ? ["sessionId", "runId", "messageId", "deliveryState"]
      : ["sessionId", "runId", "messageId", "deliveryState", "resolutionCode"],
  );
  const sessionId = boundedString(input.sessionId);
  const runId = boundedString(input.runId);
  const messageId = boundedString(input.messageId);
  if (sessionId !== expectedSessionId || runId !== expectedRunId) malformed();
  if (deliveryState === "pending" || deliveryState === "accepted") {
    return { sessionId, runId, messageId, deliveryState };
  }
  if (deliveryState === "rejected") {
    return {
      sessionId,
      runId,
      messageId,
      deliveryState,
      resolutionCode: enumValue(input.resolutionCode, ["provider_rejected", "delivery_not_sent"] as const),
    };
  }
  if (deliveryState === "ambiguous") {
    return {
      sessionId,
      runId,
      messageId,
      deliveryState,
      resolutionCode: enumValue(input.resolutionCode, ["transport_unknown", "process_unknown"] as const),
    };
  }
  if (input.resolutionCode !== "run_terminal_not_sent") malformed();
  return { sessionId, runId, messageId, deliveryState, resolutionCode: "run_terminal_not_sent" };
}

function projectAdmission(value: unknown, command: CliValidatedRunCommand): CliRunAdmissionValue {
  const admission = exactRecord(
    value,
    isCommandFor(command, "retry") ? ["sessionId", "runId", "retryOfRunId", "phase"] : ["sessionId", "runId", "phase"],
  );
  const sessionId = boundedString(admission.sessionId);
  const runId = boundedString(admission.runId);
  const phase = enumValue(admission.phase, [
    "queued",
    "starting",
    "active",
    "canceling",
    "finalizing",
    "completed",
    "failed",
    "canceled",
    "interrupted",
  ]);
  if (sessionId !== command.sessionId) malformed();
  if (isCommandFor(command, "retry")) {
    const retryOfRunId = boundedString(admission.retryOfRunId);
    if (retryOfRunId !== command.retryOfRunId) malformed();
    return { sessionId, runId, retryOfRunId, phase };
  }
  return { sessionId, runId, phase };
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
  response: Readonly<{
    overallStatus: string;
    value?: unknown;
    issues?: readonly unknown[];
    error?: unknown;
    persistence: unknown;
  }>,
): void {
  if (response.overallStatus === "failure") {
    if (
      isCommandFor(command, "send-input") &&
      record(response.error).kind === "domain" &&
      !isApplicationRunSendInputDomainErrorCode(record(response.error).code)
    ) {
      malformed();
    }
    validateRunCapacityError(command, response.error);
    return;
  }
  if (isCommandFor(command, "start") || isCommandFor(command, "retry")) {
    const persistence = record(response.persistence);
    if (persistence.replayed === false && record(response.value).phase !== "queued") malformed();
    return;
  }
  if (isCommandFor(command, "send-input")) {
    if (response.overallStatus === "partial_success") malformed();
    return;
  }
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

function validateRunCapacityError(command: CliValidatedRunCommand, value: unknown): void {
  const error = record(value);
  if (error.kind !== "domain" || error.code !== "capacity_exceeded") return;
  const details = record(error.details);
  if (isCommandFor(command, "start") || isCommandFor(command, "retry")) {
    if (details.scope !== "application" && details.scope !== "provider") malformed();
    return;
  }
  if (isCommandFor(command, "send-input")) {
    if (details.scope === "application") return;
    if (details.scope === "run" && details.runId === command.runId) return;
  }
  malformed();
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

function exactRecord(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  const candidate = record(value);
  const ownKeys = Reflect.ownKeys(candidate);
  if (
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== "string" || !keys.includes(key)) ||
    keys.some((key) => !Object.hasOwn(candidate, key))
  ) {
    malformed();
  }
  return candidate;
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
