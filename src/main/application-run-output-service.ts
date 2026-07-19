import path from "node:path";

import {
  APPLICATION_RUN_OUTPUT_CATEGORIES,
  APPLICATION_RUN_OUTPUT_LIMITS,
  type ApplicationRunOutputAccessValidationInput,
  type ApplicationRunOutputAccessValidator,
  type ApplicationRunOutputAvailability,
  type ApplicationRunOutputCategory,
  type ApplicationRunOutputChunk,
  type ApplicationRunOutputChunkRequest,
  type ApplicationRunOutputCounts,
  type ApplicationRunOutputCountsRequest,
  type ApplicationRunOutputDestinationGrant,
  type ApplicationRunOutputExportRequest,
  type ApplicationRunOutputExportResponse,
  type ApplicationRunOutputItem,
  type ApplicationRunOutputOperation,
  type ApplicationRunOutputOperations,
  type ApplicationRunOutputPage,
  type ApplicationRunOutputPreview,
  type ApplicationRunOutputPreviewRequest,
  type ApplicationRunOutputPublication,
  type ApplicationRunOutputsRequest,
} from "../shared/application-run-output-model.js";
import type {
  ApplicationAccessDecision,
  ApplicationOperationOptions,
  ApplicationOperationResponse,
  ApplicationRunOutputPayloadUnavailableError,
} from "../shared/application-service-model.js";
import type { PersistenceError } from "../shared/persistence-protocol.js";
import { PersistenceClientError } from "./persistence-worker-client.js";
import type { PersistenceWorkerClient } from "./persistence-worker-client.js";
import { RepositoryReadClient } from "./repository-read-client.js";
import {
  ProcessRunOutputExporter,
  type RunOutputExportWriter,
  type RunOutputExporterPort,
  type RunOutputPublicationOutcome,
} from "./run-output-exporter.js";

type RunOutputReadPort = Pick<
  RepositoryReadClient,
  "sessionGet" | "runOutputCounts" | "runOutputsPage" | "runOutputGet" | "runOutputPayloadMetadata" | "payloadChunk"
>;

type ApplicationRunOutputFailureResponse = Extract<
  ApplicationOperationResponse<never, "read">,
  Readonly<{ overallStatus: "failure" }>
>;

type ApplicationRunOutputPostReadFailureResponse = Omit<
  Extract<
    ApplicationRunOutputExportResponse,
    Readonly<{ overallStatus: "failure"; persistence: Readonly<{ status: "read" }> }>
  >,
  "publication"
>;

type ApplicationRunOutputExportFailureResponse =
  ApplicationRunOutputFailureResponse | ApplicationRunOutputPostReadFailureResponse;

type PreparedOperation<TValue> =
  | Readonly<{ ok: true; input: TValue; control: OperationControl }>
  | Readonly<{ ok: false; response: ApplicationRunOutputFailureResponse }>;

type OperationControl = {
  readonly deadlineAt?: number;
  readonly signal?: AbortSignal;
  persistenceStarted: boolean;
};

type OperationInterruption = "timeout" | "canceled";

type ControlledSettlement<TValue> =
  | Readonly<{ status: "fulfilled"; value: TValue }>
  | Readonly<{ status: "rejected"; error: unknown }>
  | Readonly<{ status: "interrupted"; interruption: OperationInterruption }>;

type OperationResolution<TValue> =
  Readonly<{ ok: true; value: TValue }> | Readonly<{ ok: false; response: ApplicationRunOutputFailureResponse }>;

type RunScope = Readonly<{ sessionId: string; runId: string; workspaceKey: string }>;

type DecodedPreviewRequest<TAuthorizationContext> = Omit<
  ApplicationRunOutputPreviewRequest<TAuthorizationContext>,
  "maxBytes"
> &
  Readonly<{ maxBytes: number }>;

type DecodedChunkRequest<TAuthorizationContext> = Omit<
  ApplicationRunOutputChunkRequest<TAuthorizationContext>,
  "maxBytes"
> &
  Readonly<{ maxBytes: number }>;

type OutputPayloadInput<TAuthorizationContext> =
  DecodedPreviewRequest<TAuthorizationContext> | DecodedChunkRequest<TAuthorizationContext>;

type DecodedExportRequest<TAuthorizationContext> = ApplicationRunOutputExportRequest<TAuthorizationContext>;

type StoredPayloadMetadata = Readonly<{
  outputItemId: string;
  format: "text" | "json" | "binary";
  mediaType?: string;
  byteLength: number;
  contentSha256: string;
}>;

type StoredOutputContext = Readonly<{
  scope: RunScope;
  item: ApplicationRunOutputItem &
    Readonly<{ availability: Extract<ApplicationRunOutputAvailability, { kind: "stored" }> }>;
  metadata: StoredPayloadMetadata;
}>;

type ProjectedStoredChunk = Readonly<{
  sessionId: string;
  runId: string;
  outputItemId: string;
  offset: number;
  totalBytes: number;
  byteLength: number;
  bytes: ArrayBuffer;
}> &
  (Readonly<{ eof: true; nextOffset?: never }> | Readonly<{ eof: false; nextOffset: number }>);

type OutputOmissionIssue = Readonly<{
  kind: "omission";
  code: "response_size_limit";
  message: string;
  ordinal?: number;
}>;

type ProjectedOutputPage = Readonly<{
  value: ApplicationRunOutputPage;
  issues: readonly OutputOmissionIssue[];
}>;

const RUN_OUTPUT_ITEM_PROJECTION_KEYS = [
  "omitted",
  "reason",
  "id",
  "runId",
  "ordinal",
  "category",
  "kind",
  "summary",
  "completionState",
  "payloadState",
  "payloadOriginalByteLength",
  "storedPayloadId",
  "redactionState",
  "createdAt",
] as const;

export type ApplicationRunOutputServiceOptions<TAuthorizationContext> = Readonly<{
  reads: RunOutputReadPort;
  access: ApplicationRunOutputAccessValidator<TAuthorizationContext>;
  snapshotAuthorization(value: unknown): TAuthorizationContext;
  exporter?: RunOutputExporterPort;
}>;

export function createApplicationRunOutputOperations<TAuthorizationContext>(
  worker: PersistenceWorkerClient,
  options: Omit<ApplicationRunOutputServiceOptions<TAuthorizationContext>, "reads">,
): ApplicationRunOutputOperations<TAuthorizationContext> {
  return new ApplicationRunOutputService({ reads: new RepositoryReadClient(worker), ...options });
}

export class ApplicationRunOutputService<
  TAuthorizationContext,
> implements ApplicationRunOutputOperations<TAuthorizationContext> {
  readonly #reads: RunOutputReadPort;
  readonly #access: ApplicationRunOutputAccessValidator<TAuthorizationContext>;
  readonly #snapshotAuthorization: (value: unknown) => TAuthorizationContext;
  readonly #exporter: RunOutputExporterPort;

  constructor(options: ApplicationRunOutputServiceOptions<TAuthorizationContext>) {
    this.#reads = options.reads;
    this.#access = options.access;
    this.#snapshotAuthorization = options.snapshotAuthorization;
    this.#exporter = options.exporter ?? new ProcessRunOutputExporter();
  }

  async outputCounts(
    request: ApplicationRunOutputCountsRequest<TAuthorizationContext>,
    options?: ApplicationOperationOptions,
  ): Promise<ApplicationOperationResponse<ApplicationRunOutputCounts, "read">> {
    const prepared = prepareOperation(options, () => decodeCountsRequest(request, this.#snapshotAuthorization));
    if (!prepared.ok) return prepared.response;
    const scope = await this.#authorizeAndResolveScope("output_counts", prepared.input, prepared.control);
    if (!scope.ok) return scope.response;
    const counts = await readRepository(prepared.control, (repositoryOptions) =>
      this.#reads.runOutputCounts(scope.value, repositoryOptions),
    );
    if (!counts.ok) return counts.response;
    const projected = projectOperationValue(prepared.control, () => projectOutputCounts(counts.value, scope.value));
    return projected.ok ? readSuccess(prepared.control, projected.value) : projected.response;
  }

  async outputs(
    request: ApplicationRunOutputsRequest<TAuthorizationContext>,
    options?: ApplicationOperationOptions,
  ): Promise<ApplicationOperationResponse<ApplicationRunOutputPage, "read">> {
    const prepared = prepareOperation(options, () => decodeOutputsRequest(request, this.#snapshotAuthorization));
    if (!prepared.ok) return prepared.response;
    const scope = await this.#authorizeAndResolveScope("outputs", prepared.input, prepared.control);
    if (!scope.ok) return scope.response;
    const limit = prepared.input.limit ?? APPLICATION_RUN_OUTPUT_LIMITS.outputsDefaultItems;
    const page = await readRepository(prepared.control, (repositoryOptions) =>
      this.#reads.runOutputsPage(
        {
          ...scope.value,
          ...(prepared.input.category === undefined ? {} : { category: prepared.input.category }),
          ...(prepared.input.cursor === undefined ? {} : { cursor: prepared.input.cursor }),
          limit,
        },
        repositoryOptions,
      ),
    );
    if (!page.ok) return page.response;
    const projected = projectOperationValue(prepared.control, () =>
      projectOutputPage(page.value, scope.value, prepared.input.category, prepared.input.cursor, limit),
    );
    return projected.ok
      ? readOutcome(prepared.control, projected.value.value, projected.value.issues)
      : projected.response;
  }

  async outputPreview(
    request: ApplicationRunOutputPreviewRequest<TAuthorizationContext>,
    options?: ApplicationOperationOptions,
  ): Promise<ApplicationOperationResponse<ApplicationRunOutputPreview, "read">> {
    const prepared = prepareOperation(options, () => decodePreviewRequest(request, this.#snapshotAuthorization));
    if (!prepared.ok) return prepared.response;
    const stored = await this.#authorizeAndReadStoredOutput("output_preview", prepared.input, prepared.control);
    if (!stored.ok) return stored.response;
    const { scope, metadata } = stored.value;
    const format = metadata.format;
    if (format === "binary") {
      return readSuccess(prepared.control, { ...publicStoredMetadata(scope, metadata), format: "binary" });
    }
    const chunk = await readRepository(prepared.control, (repositoryOptions) =>
      this.#reads.payloadChunk(
        { ...scope, outputItemId: metadata.outputItemId, offset: 0, maxBytes: prepared.input.maxBytes },
        repositoryOptions,
      ),
    );
    if (!chunk.ok) return chunk.response;
    const projected = projectOperationValue(prepared.control, () => {
      const payload = projectPayloadChunk(chunk.value, scope, metadata, 0, prepared.input.maxBytes);
      const preview = decodeUtf8Preview(payload.bytes, payload.byteLength < payload.totalBytes);
      return {
        ...publicStoredMetadata(scope, metadata),
        format,
        preview: preview.value,
        previewByteLength: preview.byteLength,
        truncated: preview.byteLength < metadata.byteLength,
      } as const;
    });
    return projected.ok ? readSuccess(prepared.control, projected.value) : projected.response;
  }

  async outputChunk(
    request: ApplicationRunOutputChunkRequest<TAuthorizationContext>,
    options?: ApplicationOperationOptions,
  ): Promise<ApplicationOperationResponse<ApplicationRunOutputChunk, "read">> {
    const prepared = prepareOperation(options, () => decodeChunkRequest(request, this.#snapshotAuthorization));
    if (!prepared.ok) return prepared.response;
    const stored = await this.#authorizeAndReadStoredOutput("output_chunk", prepared.input, prepared.control);
    if (!stored.ok) return stored.response;
    const { scope, metadata } = stored.value;
    const format = metadata.format;
    if (format === "binary") return payloadFormatUnsupported();
    const chunk = await readRepository(prepared.control, (repositoryOptions) =>
      this.#reads.payloadChunk(
        {
          ...scope,
          outputItemId: metadata.outputItemId,
          offset: prepared.input.offset,
          maxBytes: prepared.input.maxBytes,
        },
        repositoryOptions,
      ),
    );
    if (!chunk.ok) return chunk.response;
    const projected = projectOperationValue(prepared.control, () =>
      projectPayloadChunk(chunk.value, scope, metadata, prepared.input.offset, prepared.input.maxBytes),
    );
    return projected.ok ? readSuccess(prepared.control, projected.value) : projected.response;
  }

  async outputExport(
    request: ApplicationRunOutputExportRequest<TAuthorizationContext>,
    options?: ApplicationOperationOptions,
  ): Promise<ApplicationRunOutputExportResponse> {
    const prepared = prepareOperation(options, () => decodeExportRequest(request, this.#snapshotAuthorization));
    if (!prepared.ok) return exportFailure(prepared.response, notPublished("complete"));
    const stored = await this.#authorizeAndReadStoredOutput("output_export", prepared.input, prepared.control);
    if (!stored.ok) return exportFailure(stored.response, notPublished("complete"));
    const { scope, metadata } = stored.value;
    const prepareAbort = new AbortController();
    const preparedWriter = await runControlled(
      prepared.control,
      () =>
        this.#exporter.prepare(
          prepared.input.destinationGrant,
          { byteLength: metadata.byteLength, contentSha256: metadata.contentSha256 },
          prepareAbort.signal,
        ),
      () => prepareAbort.abort(),
    );
    if (preparedWriter.status === "interrupted") {
      return exportFailure(exportPostReadInterruption(preparedWriter.interruption), publicationUnknown());
    }
    if (preparedWriter.status === "rejected") {
      return exportFailure(exportPostReadInternalFailure(), publicationUnknown());
    }
    if (preparedWriter.value.status !== "ready") return publicationFailure(preparedWriter.value);
    const writer = preparedWriter.value.writer;
    let offset = 0;
    while (true) {
      const chunk = await readRepository(prepared.control, (repositoryOptions) =>
        this.#reads.payloadChunk(
          {
            ...scope,
            outputItemId: metadata.outputItemId,
            offset,
            maxBytes: APPLICATION_RUN_OUTPUT_LIMITS.chunkMaxBytes,
          },
          repositoryOptions,
        ),
      );
      if (!chunk.ok) return abortExport(writer, chunk.response, prepared.control);
      const projected = projectOperationValue(prepared.control, () =>
        projectStoredChunk(chunk.value, scope, metadata, offset, APPLICATION_RUN_OUTPUT_LIMITS.chunkMaxBytes),
      );
      if (!projected.ok) return abortExport(writer, projected.response, prepared.control);
      if (projected.value.byteLength > 0) {
        const written = await runControlled(prepared.control, () => writer.write(projected.value.bytes));
        if (written.status === "interrupted") {
          return abortExport(writer, exportPostReadInterruption(written.interruption), prepared.control);
        }
        if (written.status === "rejected") {
          return abortExport(writer, exportPostReadInternalFailure(), prepared.control);
        }
      }
      if (projected.value.eof) break;
      offset = projected.value.nextOffset;
    }
    const finished = await runControlled(prepared.control, () => writer.finish());
    if (finished.status === "interrupted") {
      return abortExport(writer, exportPostReadInterruption(finished.interruption), prepared.control);
    }
    if (finished.status === "rejected") {
      return abortExport(writer, exportPostReadInternalFailure(), prepared.control);
    }
    return exportOutcome(scope, metadata, finished.value);
  }

  async #authorizeAndReadStoredOutput(
    operation: "output_preview" | "output_chunk" | "output_export",
    input: OutputPayloadInput<TAuthorizationContext> | DecodedExportRequest<TAuthorizationContext>,
    control: OperationControl,
  ): Promise<OperationResolution<StoredOutputContext>> {
    const scope = await this.#authorizeAndResolveScope(operation, input, control);
    if (!scope.ok) return scope;
    const pointRead = await readRepository(control, (repositoryOptions) =>
      this.#reads.runOutputGet({ ...scope.value, outputItemId: input.outputItemId }, repositoryOptions),
    );
    if (!pointRead.ok) return pointRead;
    const item = projectOperationValue(control, () =>
      projectPointOutput(pointRead.value, scope.value, input.outputItemId),
    );
    if (!item.ok) return item;
    if (item.value.availability.kind !== "stored") {
      return { ok: false, response: payloadUnavailable(item.value.availability) };
    }
    const metadata = await readStoredPayloadMetadata(control, (repositoryOptions) =>
      this.#reads.runOutputPayloadMetadata({ ...scope.value, outputItemId: input.outputItemId }, repositoryOptions),
    );
    if (!metadata.ok) return metadata;
    const projectedMetadata = projectOperationValue(control, () =>
      projectStoredMetadata(metadata.value, scope.value, input.outputItemId),
    );
    return projectedMetadata.ok
      ? {
          ok: true,
          value: {
            scope: scope.value,
            item: item.value as StoredOutputContext["item"],
            metadata: projectedMetadata.value,
          },
        }
      : projectedMetadata;
  }

  async #authorizeAndResolveScope(
    operation: ApplicationRunOutputOperation,
    input:
      | ApplicationRunOutputCountsRequest<TAuthorizationContext>
      | ApplicationRunOutputsRequest<TAuthorizationContext>
      | OutputPayloadInput<TAuthorizationContext>
      | DecodedExportRequest<TAuthorizationContext>,
    control: OperationControl,
  ): Promise<OperationResolution<RunScope>> {
    const target =
      operation === "output_counts"
        ? { kind: "run_outputs", sessionId: input.sessionId, runId: input.runId }
        : operation === "outputs"
          ? {
              kind: "run_outputs",
              sessionId: input.sessionId,
              runId: input.runId,
              ...((input as ApplicationRunOutputsRequest<TAuthorizationContext>).category === undefined
                ? {}
                : { category: (input as ApplicationRunOutputsRequest<TAuthorizationContext>).category }),
            }
          : operation === "output_preview"
            ? {
                kind: "run_output_payload",
                sessionId: input.sessionId,
                runId: input.runId,
                outputItemId: (input as DecodedPreviewRequest<TAuthorizationContext>).outputItemId,
                maxBytes: (input as DecodedPreviewRequest<TAuthorizationContext>).maxBytes,
              }
            : operation === "output_chunk"
              ? {
                  kind: "run_output_payload",
                  sessionId: input.sessionId,
                  runId: input.runId,
                  outputItemId: (input as DecodedChunkRequest<TAuthorizationContext>).outputItemId,
                  offset: (input as DecodedChunkRequest<TAuthorizationContext>).offset,
                  maxBytes: (input as DecodedChunkRequest<TAuthorizationContext>).maxBytes,
                }
              : {
                  kind: "run_output_export",
                  sessionId: input.sessionId,
                  runId: input.runId,
                  outputItemId: (input as DecodedExportRequest<TAuthorizationContext>).outputItemId,
                  destinationGrant: (input as DecodedExportRequest<TAuthorizationContext>).destinationGrant,
                };
    const authorizationInput = {
      operation,
      access: operation === "output_export" ? "write" : "read",
      context: input.context,
      target,
    } as ApplicationRunOutputAccessValidationInput<TAuthorizationContext>;
    const authorization = await runControlled(control, () => this.#access.authorize(authorizationInput));
    if (authorization.status === "interrupted") {
      return { ok: false, response: operationInterruptionFailure(authorization.interruption) };
    }
    if (authorization.status === "rejected") return { ok: false, response: prePersistenceApplicationFailure() };
    const decision = projectOperationValue(control, () => projectAccessDecision(authorization.value));
    if (!decision.ok) return decision;
    if (!decision.value.allowed) return { ok: false, response: accessFailure(decision.value.error) };

    const session = await readRepository(control, (repositoryOptions) =>
      this.#reads.sessionGet({ sessionId: input.sessionId }, repositoryOptions),
    );
    if (!session.ok) return session;
    return projectOperationValue(control, () => {
      const projected = projectionRecord(session.value, ["session"]);
      const projectedSession = projectionRecord(projected.session, ["id", "workspaceKey"]);
      const sessionId = boundedString(projectedSession.id);
      const workspaceKey = boundedString(projectedSession.workspaceKey);
      if (sessionId !== input.sessionId) throw new TypeError("Session scope mismatch.");
      return { sessionId, runId: input.runId, workspaceKey };
    });
  }
}

function decodeCountsRequest<TAuthorizationContext>(
  value: unknown,
  snapshotAuthorization: (value: unknown) => TAuthorizationContext,
): ApplicationRunOutputCountsRequest<TAuthorizationContext> {
  const request = requestRecord(value, ["context", "sessionId", "runId"]);
  return decodeContextAndScope(request, snapshotAuthorization);
}

function decodeOutputsRequest<TAuthorizationContext>(
  value: unknown,
  snapshotAuthorization: (value: unknown) => TAuthorizationContext,
): ApplicationRunOutputsRequest<TAuthorizationContext> {
  const request = requestRecord(value, ["context", "sessionId", "runId", "category", "cursor", "limit"]);
  const base = decodeContextAndScope(request, snapshotAuthorization);
  const category = optionalEnum(request.category, APPLICATION_RUN_OUTPUT_CATEGORIES);
  const cursor = optionalBoundedString(request.cursor, APPLICATION_RUN_OUTPUT_LIMITS.maxCursorLength);
  const limit = optionalInteger(request.limit, 1, APPLICATION_RUN_OUTPUT_LIMITS.outputsMaxItems);
  return {
    ...base,
    ...(category === undefined ? {} : { category }),
    ...(cursor === undefined ? {} : { cursor }),
    ...(limit === undefined ? {} : { limit }),
  };
}

function decodePreviewRequest<TAuthorizationContext>(
  value: unknown,
  snapshotAuthorization: (value: unknown) => TAuthorizationContext,
): DecodedPreviewRequest<TAuthorizationContext> {
  const request = requestRecord(value, ["context", "sessionId", "runId", "outputItemId", "maxBytes"]);
  return {
    ...decodeContextAndScope(request, snapshotAuthorization),
    outputItemId: boundedString(request.outputItemId),
    maxBytes:
      optionalInteger(request.maxBytes, 1, APPLICATION_RUN_OUTPUT_LIMITS.previewMaxBytes) ??
      APPLICATION_RUN_OUTPUT_LIMITS.previewDefaultBytes,
  };
}

function decodeChunkRequest<TAuthorizationContext>(
  value: unknown,
  snapshotAuthorization: (value: unknown) => TAuthorizationContext,
): DecodedChunkRequest<TAuthorizationContext> {
  const request = requestRecord(value, ["context", "sessionId", "runId", "outputItemId", "offset", "maxBytes"]);
  const offset = optionalInteger(request.offset, 0, Number.MAX_SAFE_INTEGER);
  if (offset === undefined) throw new TypeError("Chunk offset is required.");
  return {
    ...decodeContextAndScope(request, snapshotAuthorization),
    outputItemId: boundedString(request.outputItemId),
    offset,
    maxBytes:
      optionalInteger(request.maxBytes, 1, APPLICATION_RUN_OUTPUT_LIMITS.chunkMaxBytes) ??
      APPLICATION_RUN_OUTPUT_LIMITS.chunkDefaultBytes,
  };
}

function decodeExportRequest<TAuthorizationContext>(
  value: unknown,
  snapshotAuthorization: (value: unknown) => TAuthorizationContext,
): DecodedExportRequest<TAuthorizationContext> {
  const request = requestRecord(value, ["context", "sessionId", "runId", "outputItemId", "destinationGrant"]);
  const grant = requestRecord(request.destinationGrant, ["kind", "authority", "absolutePath"]);
  const absolutePath = boundedString(grant.absolutePath, APPLICATION_RUN_OUTPUT_LIMITS.maxDestinationPathLength);
  if (
    grant.kind !== "explicit_absolute_path" ||
    grant.authority !== "cli_user_selection" ||
    absolutePath.includes("\0") ||
    !path.isAbsolute(absolutePath) ||
    path.basename(absolutePath) === ""
  ) {
    throw new TypeError("Destination grant is invalid.");
  }
  const destinationGrant: ApplicationRunOutputDestinationGrant = {
    kind: "explicit_absolute_path",
    authority: "cli_user_selection",
    absolutePath,
  };
  return {
    ...decodeContextAndScope(request, snapshotAuthorization),
    outputItemId: boundedString(request.outputItemId),
    destinationGrant,
  };
}

function decodeContextAndScope<TAuthorizationContext>(
  request: Readonly<Record<string, unknown>>,
  snapshotAuthorization: (value: unknown) => TAuthorizationContext,
): ApplicationRunOutputCountsRequest<TAuthorizationContext> {
  const context = requestRecord(request.context, ["authorization"]);
  return {
    context: { authorization: snapshotAuthorization(context.authorization) },
    sessionId: boundedString(request.sessionId),
    runId: boundedString(request.runId),
  };
}

function projectOutputCounts(value: unknown, expected: RunScope): ApplicationRunOutputCounts {
  const counts = projectionRecord(value, [
    "sessionId",
    "runId",
    "workspaceKey",
    "totalCount",
    "partialCount",
    "byCategory",
  ]);
  assertScope(counts, expected);
  const totalCount = nonNegativeInteger(counts.totalCount);
  const partialCount = nonNegativeInteger(counts.partialCount);
  const rawByCategory = plainRecord(counts.byCategory);
  if (Object.keys(rawByCategory).some((category) => !isOutputCategory(category))) {
    throw new TypeError("Run output category is invalid.");
  }
  const byCategory = Object.fromEntries(
    APPLICATION_RUN_OUTPUT_CATEGORIES.map((category) => [
      category,
      Object.hasOwn(rawByCategory, category) ? nonNegativeInteger(rawByCategory[category]) : 0,
    ]),
  ) as Record<ApplicationRunOutputCategory, number>;
  if (Object.values(byCategory).reduce((sum, count) => sum + count, 0) !== totalCount || partialCount > totalCount) {
    throw new TypeError("Run output counts are inconsistent.");
  }
  return { sessionId: expected.sessionId, runId: expected.runId, totalCount, partialCount, byCategory };
}

function projectOutputPage(
  value: unknown,
  expected: RunScope,
  expectedCategory: ApplicationRunOutputCategory | undefined,
  inputCursor: string | undefined,
  limit: number,
): ProjectedOutputPage {
  const page = projectionRecord(value, ["sessionId", "runId", "workspaceKey", "items", "nextCursor"]);
  assertScope(page, expected);
  if (!Array.isArray(page.items) || page.items.length > limit) throw new TypeError("Run output page is invalid.");
  const nextCursor = optionalBoundedString(page.nextCursor, APPLICATION_RUN_OUTPUT_LIMITS.maxCursorLength);
  if (page.items.length === 0 && nextCursor !== undefined) throw new TypeError("Empty Run output page has a cursor.");
  if (nextCursor !== undefined && nextCursor === inputCursor) throw new TypeError("Run output cursor did not advance.");

  const items: ApplicationRunOutputItem[] = [];
  const issues: OutputOmissionIssue[] = [];
  let previousOrdinal = 0;
  for (const rawItem of page.items) {
    const item = projectionRecord(rawItem, RUN_OUTPUT_ITEM_PROJECTION_KEYS);
    const ordinal = optionalInteger(item.ordinal, 1, Number.MAX_SAFE_INTEGER);
    if (ordinal !== undefined && ordinal <= previousOrdinal) throw new TypeError("Run output ordinals are invalid.");
    if (ordinal !== undefined) previousOrdinal = ordinal;
    if (item.omitted === true) {
      if (item.reason !== "response_size_limit") throw new TypeError("Run output omission is invalid.");
      issues.push({
        kind: "omission",
        code: "response_size_limit",
        message: "Run output was omitted because the response size limit was reached.",
        ...(ordinal === undefined ? {} : { ordinal }),
      });
      continue;
    }
    if (item.omitted !== undefined || item.reason !== undefined || ordinal === undefined) {
      throw new TypeError("Run output item is invalid.");
    }
    const projected = projectOutputItem(item, expected, ordinal);
    if (expectedCategory !== undefined && projected.category !== expectedCategory) {
      throw new TypeError("Run output category scope mismatch.");
    }
    items.push(projected);
  }
  return {
    value: {
      sessionId: expected.sessionId,
      runId: expected.runId,
      items,
      ...(nextCursor === undefined ? {} : { nextCursor }),
    },
    issues,
  };
}

function projectOutputItem(
  item: Readonly<Record<string, unknown>>,
  expected: RunScope,
  ordinal: number,
): ApplicationRunOutputItem {
  const id = boundedString(item.id);
  if (boundedString(item.runId) !== expected.runId) throw new TypeError("Run output identity mismatch.");
  const category = enumString(item.category, APPLICATION_RUN_OUTPUT_CATEGORIES);
  const kind = boundedString(item.kind, APPLICATION_RUN_OUTPUT_LIMITS.maxKindLength);
  const summary = boundedUtf8String(item.summary, APPLICATION_RUN_OUTPUT_LIMITS.maxSummaryBytes);
  const completionState = enumString(item.completionState, ["complete", "partial"] as const);
  const createdAt = nonNegativeInteger(item.createdAt);
  return {
    id,
    ordinal,
    category,
    kind,
    summary,
    completionState,
    availability: projectAvailability(item, id),
    createdAt,
  };
}

function projectPointOutput(
  value: unknown,
  expected: RunScope,
  expectedOutputItemId: string,
): ApplicationRunOutputItem {
  const point = projectionRecord(value, ["sessionId", "runId", "workspaceKey", "item"]);
  assertScope(point, expected);
  const item = projectionRecord(point.item, RUN_OUTPUT_ITEM_PROJECTION_KEYS);
  if (item.omitted !== undefined || item.reason !== undefined) throw new TypeError("Point output is invalid.");
  const ordinal = optionalInteger(item.ordinal, 1, Number.MAX_SAFE_INTEGER);
  if (ordinal === undefined) throw new TypeError("Point output ordinal is invalid.");
  const projected = projectOutputItem(item, expected, ordinal);
  if (projected.id !== expectedOutputItemId) throw new TypeError("Point output identity mismatch.");
  return projected;
}

function projectStoredMetadata(
  value: unknown,
  expected: RunScope,
  expectedOutputItemId: string,
): StoredPayloadMetadata {
  const metadata = projectionRecord(value, [
    "sessionId",
    "runId",
    "workspaceKey",
    "outputItemId",
    "payloadFormat",
    "mediaType",
    "byteLength",
    "contentSha256",
    "createdAt",
  ]);
  assertScope(metadata, expected);
  const outputItemId = boundedString(metadata.outputItemId);
  if (outputItemId !== expectedOutputItemId) throw new TypeError("Payload metadata identity mismatch.");
  const format = enumString(metadata.payloadFormat, ["text", "json", "binary"] as const);
  const mediaType = optionalBoundedString(metadata.mediaType, APPLICATION_RUN_OUTPUT_LIMITS.maxMediaTypeLength);
  const byteLength = optionalInteger(metadata.byteLength, 0, APPLICATION_RUN_OUTPUT_LIMITS.maxStoredBytes);
  if (byteLength === undefined) throw new TypeError("Payload byte length is invalid.");
  const contentSha256 = boundedString(metadata.contentSha256, 64);
  if (!/^[0-9a-f]{64}$/u.test(contentSha256)) throw new TypeError("Payload digest is invalid.");
  nonNegativeInteger(metadata.createdAt);
  return {
    outputItemId,
    format,
    ...(mediaType === undefined ? {} : { mediaType }),
    byteLength,
    contentSha256,
  };
}

function projectPayloadChunk(
  value: unknown,
  expected: RunScope,
  metadata: StoredPayloadMetadata,
  expectedOffset: number,
  requestedMaxBytes: number,
): ApplicationRunOutputChunk {
  if (metadata.format === "binary") throw new TypeError("Binary payload cannot be projected as a chunk.");
  const chunk = projectStoredChunk(value, expected, metadata, expectedOffset, requestedMaxBytes);
  return { ...chunk, format: metadata.format };
}

function projectStoredChunk(
  value: unknown,
  expected: RunScope,
  metadata: StoredPayloadMetadata,
  expectedOffset: number,
  requestedMaxBytes: number,
): ProjectedStoredChunk {
  const chunk = projectionRecord(value, ["sessionId", "runId", "outputItemId", "offset", "totalBytes", "eof", "bytes"]);
  if (
    boundedString(chunk.sessionId) !== expected.sessionId ||
    boundedString(chunk.runId) !== expected.runId ||
    boundedString(chunk.outputItemId) !== metadata.outputItemId
  ) {
    throw new TypeError("Payload chunk scope mismatch.");
  }
  const offset = nonNegativeInteger(chunk.offset);
  const totalBytes = nonNegativeInteger(chunk.totalBytes);
  if (offset !== expectedOffset || totalBytes !== metadata.byteLength) {
    throw new TypeError("Payload chunk range is inconsistent.");
  }
  if (!(chunk.bytes instanceof ArrayBuffer) || typeof chunk.eof !== "boolean") {
    throw new TypeError("Payload chunk body is invalid.");
  }
  const byteLength = chunk.bytes.byteLength;
  if (byteLength > requestedMaxBytes) throw new TypeError("Payload chunk exceeds the requested size.");
  const expectedEof = offset + byteLength >= totalBytes;
  if (chunk.eof !== expectedEof) throw new TypeError("Payload chunk EOF is inconsistent.");
  if (offset < totalBytes && (byteLength === 0 || offset + byteLength > totalBytes)) {
    throw new TypeError("Payload chunk made no valid progress.");
  }
  if (offset >= totalBytes && byteLength !== 0) throw new TypeError("Payload chunk extends past EOF.");
  const result = {
    sessionId: expected.sessionId,
    runId: expected.runId,
    outputItemId: metadata.outputItemId,
    offset,
    totalBytes,
    byteLength,
    bytes: chunk.bytes,
  } as const;
  return chunk.eof ? { ...result, eof: true } : { ...result, eof: false, nextOffset: offset + byteLength };
}

function decodeUtf8Preview(
  bytes: ArrayBuffer,
  sourceIsTruncated: boolean,
): Readonly<{ value: string; byteLength: number }> {
  const value = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes, {
    stream: sourceIsTruncated,
  });
  return { value, byteLength: new TextEncoder().encode(value).byteLength };
}

function publicStoredMetadata(
  scope: RunScope,
  metadata: StoredPayloadMetadata,
): Readonly<{
  sessionId: string;
  runId: string;
  outputItemId: string;
  format: StoredPayloadMetadata["format"];
  mediaType?: string;
  storedByteLength: number;
  contentSha256: string;
}> {
  return {
    sessionId: scope.sessionId,
    runId: scope.runId,
    outputItemId: metadata.outputItemId,
    format: metadata.format,
    ...(metadata.mediaType === undefined ? {} : { mediaType: metadata.mediaType }),
    storedByteLength: metadata.byteLength,
    contentSha256: metadata.contentSha256,
  };
}

function projectAvailability(
  item: Readonly<Record<string, unknown>>,
  outputItemId: string,
): ApplicationRunOutputAvailability {
  const state = enumString(item.payloadState, [
    "none",
    "pending",
    "stored",
    "omitted_size_limit",
    "omitted_redaction",
    "omitted_persistence",
  ] as const);
  const originalByteLength = optionalInteger(item.payloadOriginalByteLength, 0, Number.MAX_SAFE_INTEGER);
  const storedPayloadId = optionalBoundedString(
    item.storedPayloadId,
    APPLICATION_RUN_OUTPUT_LIMITS.maxIdentifierLength,
  );
  const redactionState = enumString(item.redactionState, ["not_required", "redacted", "unknown"] as const);
  if (
    state === "none" &&
    originalByteLength === undefined &&
    storedPayloadId === undefined &&
    redactionState === "not_required"
  ) {
    return { kind: "none", redaction: "not_required" };
  }
  if (
    (state === "pending" || state === "omitted_size_limit" || state === "omitted_persistence") &&
    originalByteLength !== undefined &&
    storedPayloadId === undefined &&
    (redactionState === "not_required" || redactionState === "redacted")
  ) {
    const redaction = redactionState === "redacted" ? "applied" : "not_required";
    if (state === "pending") return { kind: "pending", originalByteLength, redaction };
    return {
      kind: "omitted",
      reason: state === "omitted_size_limit" ? "size_limit" : "persistence_failure",
      originalByteLength,
      redaction,
    };
  }
  if (
    state === "stored" &&
    originalByteLength !== undefined &&
    storedPayloadId === outputItemId &&
    (redactionState === "not_required" || redactionState === "redacted")
  ) {
    return {
      kind: "stored",
      originalByteLength,
      redaction: redactionState === "redacted" ? "applied" : "not_required",
    };
  }
  if (
    state === "omitted_redaction" &&
    originalByteLength !== undefined &&
    storedPayloadId === undefined &&
    redactionState === "unknown"
  ) {
    return { kind: "omitted", reason: "redaction", originalByteLength, redaction: "undetermined" };
  }
  throw new TypeError("Run output availability is invalid.");
}

function assertScope(value: Readonly<Record<string, unknown>>, expected: RunScope): void {
  if (
    boundedString(value.sessionId) !== expected.sessionId ||
    boundedString(value.runId) !== expected.runId ||
    boundedString(value.workspaceKey) !== expected.workspaceKey
  ) {
    throw new TypeError("Run output scope mismatch.");
  }
}

function prepareOperation<TValue>(options: unknown, decodeRequest: () => TValue): PreparedOperation<TValue> {
  const operationStartedAt = Date.now();
  let decodedOptions: ApplicationOperationOptions | undefined;
  try {
    decodedOptions = decodeOperationOptions(options);
  } catch {
    return { ok: false, response: requestFailure() };
  }
  const control: OperationControl = {
    ...(decodedOptions?.timeoutMs === undefined ? {} : { deadlineAt: operationStartedAt + decodedOptions.timeoutMs }),
    ...(decodedOptions?.signal === undefined ? {} : { signal: decodedOptions.signal }),
    persistenceStarted: false,
  };
  const beforeDecode = getOperationInterruption(control);
  if (beforeDecode !== undefined) return { ok: false, response: operationInterruptionFailure(beforeDecode) };
  let input: TValue;
  try {
    input = decodeRequest();
  } catch {
    return { ok: false, response: requestFailure() };
  }
  const afterDecode = getOperationInterruption(control);
  return afterDecode === undefined
    ? { ok: true, input, control }
    : { ok: false, response: operationInterruptionFailure(afterDecode) };
}

function decodeOperationOptions(value: unknown): ApplicationOperationOptions | undefined {
  if (value === undefined) return undefined;
  const options = requestRecord(value, ["timeoutMs", "signal"]);
  const timeoutMs = optionalInteger(options.timeoutMs, 1, 2_147_483_647);
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) throw new TypeError("Invalid signal.");
  return {
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(options.signal === undefined ? {} : { signal: options.signal as AbortSignal }),
  };
}

async function readRepository<TValue>(
  control: OperationControl,
  execute: (options: ApplicationOperationOptions | undefined) => Promise<TValue>,
  mapError: (error: unknown) => ApplicationRunOutputFailureResponse = mapThrownReadFailure,
): Promise<OperationResolution<TValue>> {
  const interruption = getOperationInterruption(control);
  if (interruption !== undefined) return { ok: false, response: interruptionFailure(control, interruption) };
  const repositoryAbort = new AbortController();
  const settlement = await runControlled(
    control,
    () => {
      control.persistenceStarted = true;
      return execute({ signal: repositoryAbort.signal });
    },
    () => repositoryAbort.abort(),
  );
  if (settlement.status === "interrupted") {
    return { ok: false, response: interruptionFailure(control, settlement.interruption) };
  }
  if (settlement.status === "rejected") return { ok: false, response: mapError(settlement.error) };
  return { ok: true, value: settlement.value };
}

function readStoredPayloadMetadata<TValue>(
  control: OperationControl,
  execute: (options: ApplicationOperationOptions | undefined) => Promise<TValue>,
): Promise<OperationResolution<TValue>> {
  return readRepository(control, execute, (error) =>
    error instanceof PersistenceClientError && error.persistenceError.code === "not_found"
      ? persistenceApplicationFailure()
      : mapThrownReadFailure(error),
  );
}

function projectOperationValue<TValue>(control: OperationControl, project: () => TValue): OperationResolution<TValue> {
  try {
    const value = project();
    const interruption = getOperationInterruption(control);
    return interruption === undefined
      ? { ok: true, value }
      : { ok: false, response: interruptionFailure(control, interruption) };
  } catch {
    const interruption = getOperationInterruption(control);
    return {
      ok: false,
      response:
        interruption === undefined
          ? control.persistenceStarted
            ? persistenceApplicationFailure()
            : prePersistenceApplicationFailure()
          : interruptionFailure(control, interruption),
    };
  }
}

async function runControlled<TValue>(
  control: OperationControl,
  start: () => Promise<TValue>,
  interruptStartedWork?: () => void,
): Promise<ControlledSettlement<TValue>> {
  const beforeStart = getOperationInterruption(control);
  if (beforeStart !== undefined) return { status: "interrupted", interruption: beforeStart };
  let work: Promise<TValue>;
  try {
    work = Promise.resolve(start());
  } catch (error) {
    const interruption = getOperationInterruption(control);
    if (interruption !== undefined) return { status: "interrupted", interruption };
    return { status: "rejected", error };
  }
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: ControlledSettlement<TValue>) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      control.signal?.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const interrupt = (interruption: OperationInterruption) => {
      if (settled) return;
      try {
        interruptStartedWork?.();
      } catch {
        // Interruption owns the public result even if an adapter abort hook fails.
      }
      finish({ status: "interrupted", interruption });
    };
    const onAbort = () => interrupt("canceled");
    work.then(
      (value) => {
        const interruption = getOperationInterruption(control);
        if (interruption === undefined) finish({ status: "fulfilled", value });
        else interrupt(interruption);
      },
      (error: unknown) => {
        const interruption = getOperationInterruption(control);
        if (interruption === undefined) finish({ status: "rejected", error });
        else interrupt(interruption);
      },
    );
    const remaining = getRemainingTimeout(control);
    if (remaining !== undefined) timer = setTimeout(() => interrupt("timeout"), remaining);
    control.signal?.addEventListener("abort", onAbort, { once: true });
    if (control.signal?.aborted) onAbort();
  });
}

function readSuccess<TValue>(control: OperationControl, value: TValue): ApplicationOperationResponse<TValue, "read"> {
  const response = { overallStatus: "success", value, persistence: { status: "read", effect: "none" } } as const;
  const interruption = getOperationInterruption(control);
  return interruption === undefined ? response : interruptionFailure(control, interruption);
}

function readOutcome<TValue>(
  control: OperationControl,
  value: TValue,
  issues: readonly OutputOmissionIssue[],
): ApplicationOperationResponse<TValue, "read"> {
  if (issues.length === 0) return readSuccess(control, value);
  const response = {
    overallStatus: "partial_success",
    value,
    issues: issues as [OutputOmissionIssue, ...OutputOmissionIssue[]],
    persistence: { status: "read", effect: "none" },
  } as const;
  const interruption = getOperationInterruption(control);
  return interruption === undefined ? response : interruptionFailure(control, interruption);
}

async function abortExport(
  writer: RunOutputExportWriter,
  response: ApplicationRunOutputExportFailureResponse,
  control: OperationControl,
): Promise<ApplicationRunOutputExportResponse> {
  const abortOutcome = Promise.resolve().then(() => writer.abort());
  if (isInterruptionFailure(response)) {
    void abortOutcome.catch(() => undefined);
    return exportFailure(response, publicationUnknown());
  }
  const aborted = await runControlled(control, () => abortOutcome);
  if (aborted.status === "interrupted") {
    return exportFailure(exportPostReadInterruption(aborted.interruption), publicationUnknown());
  }
  return aborted.status === "fulfilled"
    ? exportFailure(response, publicationFromAbortOutcome(aborted.value))
    : exportFailure(response, publicationUnknown());
}

function exportOutcome(
  scope: RunScope,
  metadata: StoredPayloadMetadata,
  outcome: RunOutputPublicationOutcome,
): ApplicationRunOutputExportResponse {
  if (outcome.status !== "published") return publicationFailure(outcome);
  const value = {
    sessionId: scope.sessionId,
    runId: scope.runId,
    outputItemId: metadata.outputItemId,
    format: metadata.format,
    storedByteLength: metadata.byteLength,
    contentSha256: metadata.contentSha256,
  } as const;
  return outcome.cleanupPending
    ? {
        overallStatus: "partial_success",
        value,
        issues: [
          {
            kind: "cleanup",
            code: "export_temporary_cleanup_pending",
            message: "Run output was published, but temporary file cleanup is pending.",
            retryable: true,
          },
        ],
        publication: { status: "published" },
        persistence: { status: "read", effect: "none" },
      }
    : {
        overallStatus: "success",
        value,
        publication: { status: "published" },
        persistence: { status: "read", effect: "none" },
      };
}

function publicationFailure(
  outcome: Exclude<RunOutputPublicationOutcome, Readonly<{ status: "published" }>>,
): ApplicationRunOutputExportResponse {
  if (outcome.status === "unknown") {
    return exportFailure(exportPostReadInternalFailure(), {
      status: "unknown",
      reconciliation: "inspect_destination_before_retry",
    });
  }
  const response =
    outcome.code === "filesystem_failure" ? exportPostReadInternalFailure() : exportDomainFailure(outcome.code);
  return exportFailure(response, {
    status: "not_published",
    temporaryCleanup: outcome.temporaryCleanup,
  });
}

function exportDomainFailure(
  code: "destination_exists" | "destination_invalid" | "integrity_mismatch",
): ApplicationRunOutputPostReadFailureResponse {
  return {
    overallStatus: "failure",
    error: {
      kind: "domain",
      code: code === "integrity_mismatch" ? "payload_integrity_mismatch" : code,
      message:
        code === "destination_exists"
          ? "Export destination already exists."
          : code === "destination_invalid"
            ? "Export destination is invalid."
            : "Run output payload integrity verification failed.",
      retryable: false,
    },
    persistence: { status: "read", effect: "none" },
  };
}

function exportFailure(
  response: ApplicationRunOutputExportFailureResponse,
  publication: Exclude<ApplicationRunOutputPublication, Readonly<{ status: "published" }>>,
): ApplicationRunOutputExportResponse {
  return { ...response, publication } as ApplicationRunOutputExportResponse;
}

function publicationFromAbortOutcome(
  outcome: RunOutputPublicationOutcome,
): Exclude<ApplicationRunOutputPublication, Readonly<{ status: "published" }>> {
  return outcome.status === "not_published"
    ? { status: "not_published", temporaryCleanup: outcome.temporaryCleanup }
    : publicationUnknown();
}

function notPublished(cleanup: "complete" | "pending") {
  return { status: "not_published", temporaryCleanup: cleanup } as const;
}

function publicationUnknown() {
  return { status: "unknown", reconciliation: "inspect_destination_before_retry" } as const;
}

function exportPostReadInterruption(interruption: OperationInterruption): ApplicationRunOutputPostReadFailureResponse {
  return {
    overallStatus: "failure",
    error:
      interruption === "timeout"
        ? {
            kind: "operation",
            code: "operation_timeout",
            message: "Application operation timed out.",
            retryable: true,
          }
        : {
            kind: "operation",
            code: "operation_canceled",
            message: "Application operation was canceled.",
            retryable: false,
          },
    persistence: { status: "read", effect: "none" },
  };
}

function exportPostReadInternalFailure(): ApplicationRunOutputPostReadFailureResponse {
  return {
    overallStatus: "failure",
    error: {
      kind: "application",
      code: "internal_error",
      message: "Application Service could not complete the operation.",
      retryable: false,
    },
    persistence: { status: "read", effect: "none" },
  };
}

function isInterruptionFailure(response: ApplicationRunOutputExportFailureResponse): boolean {
  return (
    response.error.kind === "operation" ||
    (response.error.kind === "persistence" &&
      (response.error.code === "persistence_timeout" || response.error.code === "persistence_canceled"))
  );
}

function projectAccessDecision(value: unknown): ApplicationAccessDecision {
  const decision = projectionRecord(value, ["allowed", "error"]);
  if (decision.allowed === true) return { allowed: true };
  if (decision.allowed !== false) throw new TypeError("Access decision is invalid.");
  const error = projectionRecord(decision.error, ["code", "message", "retryable"]);
  const code = enumString(error.code, [
    "workspace_invalid",
    "workspace_unavailable",
    "authorization_invalid",
    "forbidden",
  ] as const);
  if (typeof error.retryable !== "boolean") throw new TypeError("Access retryability is invalid.");
  return {
    allowed: false,
    error: { code, message: boundedString(error.message, 4_096), retryable: error.retryable },
  };
}

function requestFailure(): ApplicationRunOutputFailureResponse {
  return {
    overallStatus: "failure",
    error: {
      kind: "request",
      code: "request_invalid",
      message: "Application operation request is invalid.",
      retryable: false,
    },
    persistence: { status: "not_attempted", effect: "none" },
  };
}

function accessFailure(
  error: Extract<ApplicationAccessDecision, Readonly<{ allowed: false }>>["error"],
): ApplicationRunOutputFailureResponse {
  return {
    overallStatus: "failure",
    error: { kind: "access", ...error },
    persistence: { status: "not_attempted", effect: "none" },
  };
}

function payloadUnavailable(
  availability: Exclude<ApplicationRunOutputAvailability, Readonly<{ kind: "stored" }>>,
): ApplicationRunOutputFailureResponse {
  const reason =
    availability.kind === "none"
      ? "no_payload"
      : availability.kind === "pending"
        ? "pending"
        : availability.reason === "size_limit"
          ? "size_limit"
          : availability.reason === "redaction"
            ? "redaction"
            : "persistence_failure";
  const error: ApplicationRunOutputPayloadUnavailableError =
    reason === "pending"
      ? {
          kind: "domain",
          code: "payload_unavailable",
          message: "Run output payload is unavailable.",
          retryable: true,
          details: { reason: "pending" },
        }
      : {
          kind: "domain",
          code: "payload_unavailable",
          message: "Run output payload is unavailable.",
          retryable: false,
          details: { reason },
        };
  return {
    overallStatus: "failure",
    error,
    persistence: { status: "rejected", effect: "none" },
  };
}

function payloadFormatUnsupported(): ApplicationRunOutputFailureResponse {
  return {
    overallStatus: "failure",
    error: {
      kind: "domain",
      code: "payload_format_unsupported",
      message: "Binary Run output payloads must be exported.",
      retryable: false,
      details: { format: "binary", supportedAction: "export" },
    },
    persistence: { status: "rejected", effect: "none" },
  };
}

function operationInterruptionFailure(interruption: OperationInterruption): ApplicationRunOutputFailureResponse {
  return {
    overallStatus: "failure",
    error:
      interruption === "timeout"
        ? {
            kind: "operation",
            code: "operation_timeout",
            message: "Application operation timed out.",
            retryable: true,
          }
        : {
            kind: "operation",
            code: "operation_canceled",
            message: "Application operation was canceled.",
            retryable: false,
          },
    persistence: { status: "not_attempted", effect: "none" },
  };
}

function interruptionFailure(
  control: OperationControl,
  interruption: OperationInterruption,
): ApplicationRunOutputFailureResponse {
  if (!control.persistenceStarted) return operationInterruptionFailure(interruption);
  return {
    overallStatus: "failure",
    error: {
      kind: "persistence",
      code: interruption === "timeout" ? "persistence_timeout" : "persistence_canceled",
      message: interruption === "timeout" ? "Application operation timed out." : "Application operation was canceled.",
      retryable: interruption === "timeout",
      effect: "none",
    },
    persistence: { status: "failed", effect: "none" },
  };
}

function prePersistenceApplicationFailure(): ApplicationRunOutputFailureResponse {
  return {
    overallStatus: "failure",
    error: {
      kind: "application",
      code: "internal_error",
      message: "Application Service could not complete the operation.",
      retryable: false,
    },
    persistence: { status: "not_attempted", effect: "none" },
  };
}

function persistenceApplicationFailure(): ApplicationRunOutputFailureResponse {
  return {
    overallStatus: "failure",
    error: {
      kind: "application",
      code: "internal_error",
      message: "Application Service could not complete the operation.",
      retryable: false,
    },
    persistence: { status: "failed", effect: "none" },
  };
}

function mapThrownReadFailure(error: unknown): ApplicationRunOutputFailureResponse {
  if (!(error instanceof PersistenceClientError)) return persistenceApplicationFailure();
  const persistenceError = error.persistenceError;
  if (
    persistenceError.code === "request_invalid" ||
    persistenceError.code === "cursor_invalid" ||
    persistenceError.code === "not_found"
  ) {
    return {
      overallStatus: "failure",
      error: {
        kind: "domain",
        code: persistenceError.code,
        message: persistenceError.message,
        retryable: persistenceError.retryable,
      },
      persistence: { status: "rejected", effect: "none" },
    };
  }
  return {
    overallStatus: "failure",
    error: {
      kind: "persistence",
      code: mapPersistenceErrorCode(persistenceError.code),
      message: persistenceError.message,
      retryable: persistenceError.retryable,
      effect: "none",
    },
    persistence: { status: "failed", effect: "none" },
  };
}

function mapPersistenceErrorCode(code: PersistenceError["code"]) {
  switch (code) {
    case "worker_not_ready":
    case "worker_closing":
    case "worker_crashed":
    case "worker_start_failed":
    case "worker_shutdown_forced":
    case "database_unavailable":
      return "persistence_unavailable" as const;
    case "queue_full":
    case "database_busy":
      return "persistence_busy" as const;
    case "request_timeout":
      return "persistence_timeout" as const;
    case "request_canceled":
      return "persistence_canceled" as const;
    case "database_path_invalid":
    case "database_identity_mismatch":
    case "database_schema_unknown":
    case "database_schema_too_new":
    case "database_schema_too_old":
    case "database_pragma_mismatch":
    case "database_wal_unavailable":
    case "database_bootstrap_failed":
    case "schema_artifact_invalid":
      return "persistence_configuration_invalid" as const;
    case "database_schema_verification_failed":
    case "database_integrity_check_failed":
      return "persistence_integrity_failed" as const;
    case "response_too_large":
      return "persistence_response_too_large" as const;
    default:
      return "persistence_operation_failed" as const;
  }
}

function getOperationInterruption(control: OperationControl): OperationInterruption | undefined {
  if (control.deadlineAt !== undefined && control.deadlineAt <= Date.now()) return "timeout";
  if (control.signal?.aborted) return "canceled";
  return undefined;
}

function getRemainingTimeout(control: OperationControl): number | undefined {
  return control.deadlineAt === undefined ? undefined : Math.max(0, control.deadlineAt - Date.now());
}

function requestRecord(value: unknown, allowedKeys: readonly string[]): Readonly<Record<string, unknown>> {
  if (!isPlainObject(value) || Object.keys(value).some((key) => !allowedKeys.includes(key))) {
    throw new TypeError("Request object is invalid.");
  }
  return Object.fromEntries(allowedKeys.map((key) => [key, value[key]]));
}

function projectionRecord(value: unknown, allowedKeys: readonly string[]): Readonly<Record<string, unknown>> {
  const record = plainRecord(value);
  return Object.fromEntries(allowedKeys.map((key) => [key, record[key]]));
}

function plainRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (!isPlainObject(value)) throw new TypeError("Projection object is invalid.");
  return value;
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, maxLength: number = APPLICATION_RUN_OUTPUT_LIMITS.maxIdentifierLength): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new TypeError("String is invalid.");
  }
  return value;
}

function boundedUtf8String(value: unknown, maxBytes: number): string {
  if (typeof value !== "string" || new TextEncoder().encode(value).byteLength > maxBytes) {
    throw new TypeError("UTF-8 string is invalid.");
  }
  return value;
}

function optionalBoundedString(value: unknown, maxLength: number): string | undefined {
  return value === undefined ? undefined : boundedString(value, maxLength);
}

function optionalInteger(value: unknown, minimum: number, maximum: number): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new TypeError("Integer is invalid.");
  }
  return value as number;
}

function nonNegativeInteger(value: unknown): number {
  const result = optionalInteger(value, 0, Number.MAX_SAFE_INTEGER);
  if (result === undefined) throw new TypeError("Integer is required.");
  return result;
}

function optionalEnum<TValue extends string>(value: unknown, allowed: readonly TValue[]): TValue | undefined {
  return value === undefined ? undefined : enumString(value, allowed);
}

function enumString<TValue extends string>(value: unknown, allowed: readonly TValue[]): TValue {
  if (typeof value !== "string" || !allowed.includes(value as TValue)) throw new TypeError("Enum is invalid.");
  return value as TValue;
}

function isOutputCategory(value: string): value is ApplicationRunOutputCategory {
  return APPLICATION_RUN_OUTPUT_CATEGORIES.includes(value as ApplicationRunOutputCategory);
}
