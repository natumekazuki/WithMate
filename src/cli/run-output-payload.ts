import {
  exitCodeForCliApplicationResponse,
  exitCodeForCliRunOutputExportResponse,
  projectCliRunOutputExportApplicationResponse,
  projectCliRunOutputReadApplicationResponse,
} from "./application-response.js";
import {
  CLI_EXIT_CODES,
  CLI_RUN_LIMITS,
  CLI_RUN_OUTPUT_CATEGORIES,
  CLI_SCHEMA_VERSION,
  CLI_SESSION_LIMITS,
  type CliExitCode,
  type CliApplicationResponse,
  type CliRunOperationOutput,
  type CliRunOutputAvailability,
  type CliRunOutputCategory,
  type CliRunOutputChunkValue,
  type CliRunOutputCountsValue,
  type CliRunOutputExportValue,
  type CliRunOutputItem,
  type CliRunOutputPreviewValue,
  type CliRunOutputsValue,
  type CliRuntimeFailureOutput,
  type CliValidatedRunCommand,
} from "./contract.js";

type RunOutputCommand = Extract<
  CliValidatedRunCommand,
  Readonly<{
    identity: Readonly<{
      operation: "output-counts" | "outputs" | "output-preview" | "output-chunk" | "output-export";
    }>;
  }>
>;
type RunOutputOperation = RunOutputCommand["identity"]["operation"];
type RunOutputCommandFor<TOperation extends RunOutputOperation> = Extract<
  RunOutputCommand,
  Readonly<{ identity: Readonly<{ operation: TOperation }> }>
>;
type RunOutputReadCommand = Exclude<RunOutputCommand, RunOutputCommandFor<"output-export">>;

export type CliRunOutputProjectionResult =
  | Readonly<{ ok: true; output: CliRunOperationOutput; exitCode: CliExitCode }>
  | Readonly<{ ok: false; output: CliRuntimeFailureOutput; exitCode: typeof CLI_EXIT_CODES.runtimeFailure }>;

const INDEX_DOMAIN_CODES = ["request_invalid", "cursor_invalid", "not_found"] as const;
const PAYLOAD_DOMAIN_CODES = ["request_invalid", "not_found", "payload_unavailable"] as const;
const CHUNK_DOMAIN_CODES = [...PAYLOAD_DOMAIN_CODES, "payload_format_unsupported"] as const;

export function isRunOutputCommand(command: CliValidatedRunCommand): command is RunOutputCommand {
  return ["output-counts", "outputs", "output-preview", "output-chunk", "output-export"].includes(
    command.identity.operation,
  );
}

export function projectCliRunOutputOperationOutput(
  command: RunOutputCommand,
  applicationResponse: unknown,
): CliRunOutputProjectionResult {
  try {
    if (isOutputCommandFor(command, "output-export")) {
      const response = projectCliRunOutputExportApplicationResponse(applicationResponse, (value) =>
        projectExport(value, command.sessionId, command.runId, command.outputItemId),
      );
      const output = {
        schemaVersion: CLI_SCHEMA_VERSION,
        kind: "operation",
        command: command.identity,
        applicationResponse: response,
      } as CliRunOperationOutput;
      return { ok: true, output, exitCode: exitCodeForCliRunOutputExportResponse(response) };
    }
    const response = projectCliRunOutputReadApplicationResponse(
      applicationResponse,
      (value) => projectValue(command, value),
      isOutputCommandFor(command, "outputs") ? command.limit : 0,
      isOutputCommandFor(command, "output-chunk")
        ? CHUNK_DOMAIN_CODES
        : isOutputCommandFor(command, "output-preview")
          ? PAYLOAD_DOMAIN_CODES
          : INDEX_DOMAIN_CODES,
    );
    validateReadResponse(command, response);
    const output = {
      schemaVersion: CLI_SCHEMA_VERSION,
      kind: "operation",
      command: command.identity,
      applicationResponse: response,
    } as CliRunOperationOutput;
    return { ok: true, output, exitCode: exitCodeForCliApplicationResponse(response) };
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

function projectValue(command: RunOutputReadCommand, value: unknown) {
  if (isOutputCommandFor(command, "output-counts")) return projectCounts(value, command.sessionId, command.runId);
  if (isOutputCommandFor(command, "outputs")) return projectOutputs(value, command);
  if (isOutputCommandFor(command, "output-preview")) {
    return projectPreview(value, command.sessionId, command.runId, command.outputItemId, command.maxBytes);
  }
  if (isOutputCommandFor(command, "output-chunk")) {
    return projectChunk(
      value,
      command.sessionId,
      command.runId,
      command.outputItemId,
      command.offset,
      command.maxBytes,
    );
  }
  malformed();
}

function projectCounts(value: unknown, expectedSessionId: string, expectedRunId: string): CliRunOutputCountsValue {
  const counts = record(value);
  const sessionId = boundedString(counts.sessionId);
  const runId = boundedString(counts.runId);
  if (sessionId !== expectedSessionId || runId !== expectedRunId) malformed();
  const totalCount = nonNegativeInteger(counts.totalCount);
  const partialCount = nonNegativeInteger(counts.partialCount);
  const rawCategories = record(counts.byCategory);
  if (Object.keys(rawCategories).some((key) => !CLI_RUN_OUTPUT_CATEGORIES.includes(key as CliRunOutputCategory))) {
    malformed();
  }
  const byCategory = Object.fromEntries(
    CLI_RUN_OUTPUT_CATEGORIES.map((category) => [category, nonNegativeInteger(rawCategories[category])]),
  ) as Record<CliRunOutputCategory, number>;
  if (partialCount > totalCount || Object.values(byCategory).reduce((sum, count) => sum + count, 0) !== totalCount) {
    malformed();
  }
  return { sessionId, runId, totalCount, partialCount, byCategory };
}

function projectOutputs(
  value: unknown,
  command: Extract<RunOutputCommand, { identity: { operation: "outputs" } }>,
): CliRunOutputsValue {
  const page = record(value);
  const sessionId = boundedString(page.sessionId);
  const runId = boundedString(page.runId);
  if (sessionId !== command.sessionId || runId !== command.runId) malformed();
  let previousOrdinal = 0;
  const items = denseArray(page.items, command.limit).map((value) => {
    const item = projectItem(value);
    if (item.ordinal <= previousOrdinal || (command.category !== undefined && item.category !== command.category)) {
      malformed();
    }
    previousOrdinal = item.ordinal;
    return item;
  });
  const nextCursor = optionalBoundedString(page.nextCursor, CLI_SESSION_LIMITS.maxCursorLength);
  if (items.length === 0 && nextCursor !== undefined) malformed();
  if (nextCursor !== undefined && nextCursor === command.cursor) malformed();
  return { sessionId, runId, items, ...(nextCursor === undefined ? {} : { nextCursor }) };
}

function projectItem(value: unknown): CliRunOutputItem {
  const item = record(value);
  return {
    id: boundedString(item.id),
    ordinal: positiveInteger(item.ordinal),
    category: enumValue(item.category, CLI_RUN_OUTPUT_CATEGORIES),
    kind: boundedString(item.kind, 64),
    summary: boundedUtf8String(item.summary, 4_096),
    completionState: enumValue(item.completionState, ["complete", "partial"] as const),
    availability: projectAvailability(item.availability),
    createdAt: nonNegativeInteger(item.createdAt),
  };
}

function projectAvailability(value: unknown): CliRunOutputAvailability {
  const availability = record(value);
  const kind = enumValue(availability.kind, ["none", "pending", "stored", "omitted"] as const);
  const redaction = enumValue(availability.redaction, ["not_required", "applied", "undetermined"] as const);
  if (kind === "none") {
    if (
      redaction !== "not_required" ||
      availability.originalByteLength !== undefined ||
      availability.reason !== undefined
    ) {
      malformed();
    }
    return { kind, redaction };
  }
  const originalByteLength = nonNegativeInteger(availability.originalByteLength);
  if (kind === "pending" || kind === "stored") {
    if (redaction === "undetermined" || availability.reason !== undefined) malformed();
    return { kind, originalByteLength, redaction };
  }
  const reason = enumValue(availability.reason, ["size_limit", "redaction", "persistence_failure"] as const);
  if ((reason === "redaction") !== (redaction === "undetermined")) malformed();
  return { kind: "omitted", reason, originalByteLength, redaction } as CliRunOutputAvailability;
}

function projectPreview(
  value: unknown,
  expectedSessionId: string,
  expectedRunId: string,
  expectedOutputItemId: string,
  maxBytes: number,
): CliRunOutputPreviewValue {
  const preview = record(value);
  const metadata = projectStoredMetadata(preview, expectedSessionId, expectedRunId, expectedOutputItemId);
  const format = enumValue(preview.format, ["text", "json", "binary"] as const);
  if (format === "binary") {
    if (preview.preview !== undefined || preview.previewByteLength !== undefined || preview.truncated !== undefined) {
      malformed();
    }
    return { ...metadata, format };
  }
  const source = boundedUtf8String(preview.preview, maxBytes);
  const previewByteLength = nonNegativeInteger(preview.previewByteLength);
  if (
    previewByteLength !== Buffer.byteLength(source, "utf8") ||
    previewByteLength > maxBytes ||
    typeof preview.truncated !== "boolean" ||
    preview.truncated !== previewByteLength < metadata.storedByteLength
  ) {
    malformed();
  }
  return { ...metadata, format, preview: source, previewByteLength, truncated: preview.truncated };
}

function projectChunk(
  value: unknown,
  expectedSessionId: string,
  expectedRunId: string,
  expectedOutputItemId: string,
  expectedOffset: number,
  maxBytes: number,
): CliRunOutputChunkValue {
  const chunk = record(value);
  const sessionId = boundedString(chunk.sessionId);
  const runId = boundedString(chunk.runId);
  const outputItemId = boundedString(chunk.outputItemId);
  const format = enumValue(chunk.format, ["text", "json"] as const);
  const offset = nonNegativeInteger(chunk.offset);
  const totalBytes = nonNegativeInteger(chunk.totalBytes);
  const byteLength = nonNegativeInteger(chunk.byteLength);
  if (
    sessionId !== expectedSessionId ||
    runId !== expectedRunId ||
    outputItemId !== expectedOutputItemId ||
    offset !== expectedOffset ||
    !(chunk.bytes instanceof ArrayBuffer) ||
    byteLength !== chunk.bytes.byteLength ||
    byteLength > maxBytes ||
    typeof chunk.eof !== "boolean"
  ) {
    malformed();
  }
  const end = offset + byteLength;
  if (
    !Number.isSafeInteger(end) ||
    (offset < totalBytes
      ? byteLength === 0 || end > totalBytes || chunk.eof !== (end === totalBytes)
      : byteLength !== 0 || !chunk.eof)
  ) {
    malformed();
  }
  const base = {
    sessionId,
    runId,
    outputItemId,
    format,
    offset,
    totalBytes,
    chunk: { encoding: "base64" as const, byteLength, data: Buffer.from(chunk.bytes).toString("base64") },
  };
  if (chunk.eof) {
    if (chunk.nextOffset !== undefined) malformed();
    return { ...base, eof: true };
  }
  const nextOffset = nonNegativeInteger(chunk.nextOffset);
  if (nextOffset !== end) malformed();
  return { ...base, eof: false, nextOffset };
}

function projectExport(
  value: unknown,
  expectedSessionId: string,
  expectedRunId: string,
  expectedOutputItemId: string,
): CliRunOutputExportValue {
  const exported = record(value);
  const metadata = projectStoredMetadata(exported, expectedSessionId, expectedRunId, expectedOutputItemId);
  return {
    sessionId: metadata.sessionId,
    runId: metadata.runId,
    outputItemId: metadata.outputItemId,
    format: enumValue(exported.format, ["text", "json", "binary"] as const),
    storedByteLength: metadata.storedByteLength,
    contentSha256: metadata.contentSha256,
  };
}

function projectStoredMetadata(
  value: Readonly<Record<string, unknown>>,
  expectedSessionId: string,
  expectedRunId: string,
  expectedOutputItemId: string,
) {
  const sessionId = boundedString(value.sessionId);
  const runId = boundedString(value.runId);
  const outputItemId = boundedString(value.outputItemId);
  if (sessionId !== expectedSessionId || runId !== expectedRunId || outputItemId !== expectedOutputItemId) malformed();
  const mediaType = optionalBoundedString(value.mediaType, 1_024);
  const contentSha256 = boundedString(value.contentSha256, 64);
  if (!/^[0-9a-f]{64}$/u.test(contentSha256)) malformed();
  return {
    sessionId,
    runId,
    outputItemId,
    ...(mediaType === undefined ? {} : { mediaType }),
    storedByteLength: nonNegativeInteger(value.storedByteLength),
    contentSha256,
  };
}

function validateReadResponse(command: RunOutputReadCommand, response: CliApplicationResponse<unknown, "read">): void {
  if (response.overallStatus === "failure") return;
  if (isOutputCommandFor(command, "outputs")) {
    const items = denseArray(record(response.value).items, command.limit);
    if ((response.overallStatus === "partial_success" ? response.issues.length : 0) + items.length > command.limit) {
      malformed();
    }
    return;
  }
  if (response.overallStatus !== "success") malformed();
}

function isOutputCommandFor<TOperation extends RunOutputOperation>(
  command: RunOutputCommand,
  operation: TOperation,
): command is RunOutputCommandFor<TOperation> {
  return command.identity.operation === operation;
}

function denseArray(value: unknown, maxLength: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maxLength) malformed();
  const length = value.length;
  return Array.from({ length }, (_unused, index) => {
    if (value.length !== length || !Object.hasOwn(value, index)) malformed();
    return value[index];
  });
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) malformed();
  return value as Readonly<Record<string, unknown>>;
}

function boundedString(value: unknown, maxLength: number = CLI_SESSION_LIMITS.maxIdentifierLength): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || value.includes("\0")) malformed();
  return value;
}

function boundedUtf8String(value: unknown, maxBytes: number): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > maxBytes) malformed();
  return value;
}

function optionalBoundedString(value: unknown, maxLength: number): string | undefined {
  return value === undefined ? undefined : boundedString(value, maxLength);
}

function nonNegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) malformed();
  return value as number;
}

function positiveInteger(value: unknown): number {
  const integer = nonNegativeInteger(value);
  if (integer === 0) malformed();
  return integer;
}

function enumValue<TValue extends string>(value: unknown, allowed: readonly TValue[]): TValue {
  if (typeof value !== "string" || !allowed.includes(value as TValue)) malformed();
  return value as TValue;
}

function malformed(): never {
  throw new TypeError("Run output Application response is invalid.");
}
