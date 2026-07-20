import assert from "node:assert/strict";
import test from "node:test";

import * as publicApi from "../src/main/index.js";
import type { ApplicationRunOutputOperations } from "../src/main/index.js";
import type {
  ApplicationRunOutputChunk,
  ApplicationRunOutputDestinationGrant,
  ApplicationRunOutputExportResponse,
  ApplicationRunOutputPreview,
} from "../src/shared/application-run-output-model.js";
import type { ApplicationRunOutputPayloadUnavailableError } from "../src/shared/application-service-model.js";

type Authorization = Readonly<{ principalId: string }>;
type Equal<TLeft, TRight> = (<T>() => T extends TLeft ? 1 : 2) extends <T>() => T extends TRight ? 1 : 2 ? true : false;
type Assert<TValue extends true> = TValue;
type Operations = ApplicationRunOutputOperations<Authorization>;
type CountsRequest = Parameters<Operations["outputCounts"]>[0];
type ChunkResponse = Awaited<ReturnType<Operations["outputChunk"]>>;
type ExportRequest = Parameters<Operations["outputExport"]>[0];
type SuccessfulExport = Extract<ApplicationRunOutputExportResponse, Readonly<{ overallStatus: "success" }>>;
type FailedExport = Extract<ApplicationRunOutputExportResponse, Readonly<{ overallStatus: "failure" }>>;
type NonFailureExport = Exclude<ApplicationRunOutputExportResponse, Readonly<{ overallStatus: "failure" }>>;
type BinaryPreview = Extract<ApplicationRunOutputPreview, Readonly<{ format: "binary" }>>;

type _OperationsAreComplete = Assert<
  Equal<keyof Operations, "outputCounts" | "outputs" | "outputPreview" | "outputChunk" | "outputExport">
>;
type _CountsOwnRunScope = Assert<
  Equal<Pick<CountsRequest, "sessionId" | "runId">, Readonly<{ sessionId: string; runId: string }>>
>;
type _ChunkUsesReadEnvelope = Assert<Equal<ChunkResponse["overallStatus"], "success" | "partial_success" | "failure">>;
type _BinaryChunkIsUnsupported = Assert<
  Equal<Extract<ApplicationRunOutputChunk, Readonly<{ format: "binary" }>>, never>
>;
type _BinaryPreviewHasNoBody = Assert<Equal<BinaryPreview["preview"], undefined>>;
type _ExportRequiresExplicitGrant = Assert<
  Equal<ExportRequest["destinationGrant"], ApplicationRunOutputDestinationGrant>
>;
type _SuccessfulExportIsPublished = Assert<Equal<SuccessfulExport["publication"], Readonly<{ status: "published" }>>>;
type _OnlyFailuresCanHaveUnknownPublication = Assert<Equal<NonFailureExport["publication"]["status"], "published">>;
type _FailuresCannotClaimPublished = Assert<
  Equal<Extract<FailedExport["publication"], Readonly<{ status: "published" }>>, never>
>;

const invalidGrant: ApplicationRunOutputDestinationGrant = {
  kind: "explicit_absolute_path",
  // @ts-expect-error the public contract accepts only an explicit CLI-selected absolute-path authority
  authority: "renderer_selection",
  absolutePath: "C:\\output.txt",
};

// @ts-expect-error binary payloads are metadata-only in preview and cannot carry source text
const invalidBinaryPreview: ApplicationRunOutputPreview = {
  sessionId: "session-1",
  runId: "run-1",
  outputItemId: "output-1",
  format: "binary",
  storedByteLength: 1,
  contentSha256: "a".repeat(64),
  preview: "x",
};

const invalidSuccessfulExport: ApplicationRunOutputExportResponse = {
  overallStatus: "success",
  value: {
    sessionId: "session-1",
    runId: "run-1",
    outputItemId: "output-1",
    format: "text",
    storedByteLength: 1,
    contentSha256: "a".repeat(64),
  },
  // @ts-expect-error successful export publication cannot be ambiguous
  publication: { status: "unknown", reconciliation: "inspect_destination_before_retry" },
  persistence: { status: "read", effect: "none" },
};

// @ts-expect-error payload availability is determined by a Repository rejection, not a completed read
const invalidPayloadUnavailableTiming: ApplicationRunOutputExportResponse = {
  overallStatus: "failure",
  error: {
    kind: "domain",
    code: "payload_unavailable",
    message: "Run output payload is unavailable.",
    retryable: false,
    details: { reason: "no_payload" },
  },
  publication: { status: "not_published", temporaryCleanup: "complete" },
  persistence: { status: "read", effect: "none" },
};

// @ts-expect-error destination existence is observed only after the payload read has completed
const invalidDestinationExistsTiming: ApplicationRunOutputExportResponse = {
  overallStatus: "failure",
  error: {
    kind: "domain",
    code: "destination_exists",
    message: "Export destination already exists.",
    retryable: false,
  },
  publication: { status: "not_published", temporaryCleanup: "complete" },
  persistence: { status: "rejected", effect: "none" },
};

// @ts-expect-error only a pending payload is retryable
const invalidPermanentPayloadRetry: ApplicationRunOutputPayloadUnavailableError = {
  kind: "domain",
  code: "payload_unavailable",
  message: "Run output payload is unavailable.",
  retryable: true,
  details: { reason: "no_payload" },
};

// @ts-expect-error a pending payload must remain retryable
const invalidPendingPayloadRetry: ApplicationRunOutputPayloadUnavailableError = {
  kind: "domain",
  code: "payload_unavailable",
  message: "Run output payload is unavailable.",
  retryable: false,
  details: { reason: "pending" },
};

void invalidGrant;
void invalidBinaryPreview;
void invalidSuccessfulExport;
void invalidPayloadUnavailableTiming;
void invalidDestinationExistsTiming;
void invalidPermanentPayloadRetry;
void invalidPendingPayloadRetry;

test("public Run output API is type-only and owns bounded read and export contracts", () => {
  const operations = null as Operations | null;
  const compileTimeAssertions = null as
    | _OperationsAreComplete
    | _CountsOwnRunScope
    | _ChunkUsesReadEnvelope
    | _BinaryChunkIsUnsupported
    | _BinaryPreviewHasNoBody
    | _ExportRequiresExplicitGrant
    | _SuccessfulExportIsPublished
    | _OnlyFailuresCanHaveUnknownPublication
    | _FailuresCannotClaimPublished
    | null;

  assert.deepEqual(Object.keys(publicApi), []);
  assert.equal(operations, null);
  assert.equal(compileTimeAssertions, null);
});
