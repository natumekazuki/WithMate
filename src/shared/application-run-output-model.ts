import type {
  ApplicationAccessDecision,
  ApplicationOperationError,
  ApplicationOperationOptions,
  ApplicationOperationResponse,
  ApplicationSessionOperationContext,
} from "./application-service-model.js";
import { REPOSITORY_READ_LIMITS } from "./repository-read-model.js";

export const APPLICATION_RUN_OUTPUT_CATEGORIES = [
  "assistant_detail",
  "operation",
  "interaction",
  "telemetry",
  "diagnostic",
  "provider_metadata",
] as const;

export const APPLICATION_RUN_OUTPUT_LIMITS = {
  maxIdentifierLength: 1_024,
  maxCursorLength: 2_048,
  maxKindLength: 64,
  maxSummaryBytes: 4_096,
  maxMediaTypeLength: 1_024,
  maxDestinationPathLength: 32_767,
  outputsDefaultItems: REPOSITORY_READ_LIMITS.outputs.default,
  outputsMaxItems: REPOSITORY_READ_LIMITS.outputs.max,
  previewDefaultBytes: 64 * 1_024,
  previewMaxBytes: 64 * 1_024,
  chunkDefaultBytes: 64 * 1_024,
  chunkMaxBytes: 256 * 1_024,
  maxStoredBytes: 16 * 1_024 * 1_024,
} as const;

export type ApplicationRunOutputCategory = (typeof APPLICATION_RUN_OUTPUT_CATEGORIES)[number];
export type ApplicationRunOutputOperation =
  "output_counts" | "outputs" | "output_preview" | "output_chunk" | "output_export";

export type ApplicationRunOutputRedaction = "not_required" | "applied" | "undetermined";

export type ApplicationRunOutputAvailability =
  | Readonly<{ kind: "none"; redaction: "not_required" }>
  | Readonly<{
      kind: "pending";
      originalByteLength: number;
      redaction: "not_required" | "applied";
    }>
  | Readonly<{
      kind: "stored";
      originalByteLength: number;
      redaction: "not_required" | "applied";
    }>
  | Readonly<{
      kind: "omitted";
      reason: "size_limit" | "persistence_failure";
      originalByteLength: number;
      redaction: "not_required" | "applied";
    }>
  | Readonly<{
      kind: "omitted";
      reason: "redaction";
      originalByteLength: number;
      redaction: "undetermined";
    }>;

export type ApplicationRunOutputItem = Readonly<{
  id: string;
  ordinal: number;
  category: ApplicationRunOutputCategory;
  kind: string;
  summary: string;
  completionState: "complete" | "partial";
  availability: ApplicationRunOutputAvailability;
  createdAt: number;
}>;

export type ApplicationRunOutputCounts = Readonly<{
  sessionId: string;
  runId: string;
  totalCount: number;
  partialCount: number;
  byCategory: Readonly<Record<ApplicationRunOutputCategory, number>>;
}>;

export type ApplicationRunOutputPage = Readonly<{
  sessionId: string;
  runId: string;
  items: readonly ApplicationRunOutputItem[];
  nextCursor?: string;
}>;

type ApplicationRunOutputStoredMetadata = Readonly<{
  sessionId: string;
  runId: string;
  outputItemId: string;
  mediaType?: string;
  storedByteLength: number;
  contentSha256: string;
}>;

export type ApplicationRunOutputPreview =
  | (ApplicationRunOutputStoredMetadata &
      Readonly<{
        format: "text" | "json";
        preview: string;
        previewByteLength: number;
        truncated: boolean;
      }>)
  | (ApplicationRunOutputStoredMetadata &
      Readonly<{
        format: "binary";
        preview?: never;
        previewByteLength?: never;
        truncated?: never;
      }>);

type ApplicationRunOutputChunkBase = Readonly<{
  sessionId: string;
  runId: string;
  outputItemId: string;
  format: "text" | "json";
  offset: number;
  totalBytes: number;
  byteLength: number;
  bytes: ArrayBuffer;
}>;

export type ApplicationRunOutputChunk = ApplicationRunOutputChunkBase &
  (Readonly<{ eof: true; nextOffset?: never }> | Readonly<{ eof: false; nextOffset: number }>);

export type ApplicationRunOutputDestinationGrant = Readonly<{
  kind: "explicit_absolute_path";
  authority: "cli_user_selection";
  absolutePath: string;
}>;

export type ApplicationRunOutputExportResult = Readonly<{
  sessionId: string;
  runId: string;
  outputItemId: string;
  format: "text" | "json" | "binary";
  storedByteLength: number;
  contentSha256: string;
}>;

export type ApplicationRunOutputExportCleanupIssue = Readonly<{
  kind: "cleanup";
  code: "export_temporary_cleanup_pending";
  message: string;
  retryable: true;
}>;

type ApplicationRunOutputPrePersistenceFailure = Readonly<{
  overallStatus: "failure";
  error: Extract<ApplicationOperationError, Readonly<{ kind: "request" | "access" | "operation" | "application" }>>;
  publication: Readonly<{ status: "not_published"; temporaryCleanup: "complete" }>;
  persistence: Readonly<{ status: "not_attempted"; effect: "none" }>;
}>;

type ApplicationRunOutputPayloadUnavailableFailure = Readonly<{
  overallStatus: "failure";
  error: Extract<ApplicationOperationError, Readonly<{ code: "payload_unavailable" }>>;
  publication: Readonly<{ status: "not_published"; temporaryCleanup: "complete" }>;
  persistence: Readonly<{ status: "rejected"; effect: "none" }>;
}>;

type ApplicationRunOutputRepositoryDomainFailure = Readonly<{
  overallStatus: "failure";
  error: Readonly<{
    kind: "domain";
    code: "request_invalid" | "cursor_invalid" | "not_found";
    message: string;
    retryable: boolean;
    details?: never;
  }>;
  publication: ApplicationRunOutputFailedPublication;
  persistence: Readonly<{ status: "rejected"; effect: "none" }>;
}>;

type ApplicationRunOutputPersistenceFailure = Readonly<{
  overallStatus: "failure";
  error:
    | (Extract<ApplicationOperationError, Readonly<{ kind: "persistence" }>> & Readonly<{ effect: "none" }>)
    | Extract<ApplicationOperationError, Readonly<{ kind: "application" }>>;
  publication: ApplicationRunOutputFailedPublication;
  persistence: Readonly<{ status: "failed"; effect: "none" }>;
}>;

type ApplicationRunOutputPostReadFailure = Readonly<{
  overallStatus: "failure";
  error: Extract<ApplicationOperationError, Readonly<{ kind: "operation" | "application" }>>;
  publication: ApplicationRunOutputFailedPublication;
  persistence: Readonly<{ status: "read"; effect: "none" }>;
}>;

type ApplicationRunOutputPublicationDomainFailure = Readonly<{
  overallStatus: "failure";
  error: Readonly<{
    kind: "domain";
    code: "destination_exists" | "destination_invalid" | "payload_integrity_mismatch";
    message: string;
    retryable: false;
    details?: never;
  }>;
  publication: Readonly<{ status: "not_published"; temporaryCleanup: "complete" | "pending" }>;
  persistence: Readonly<{ status: "read"; effect: "none" }>;
}>;

export type ApplicationRunOutputPublication =
  | Readonly<{ status: "published" }>
  | Readonly<{ status: "not_published"; temporaryCleanup: "complete" | "pending" }>
  | Readonly<{ status: "unknown"; reconciliation: "inspect_destination_before_retry" }>;

type ApplicationRunOutputFailedPublication = Exclude<
  ApplicationRunOutputPublication,
  Readonly<{ status: "published" }>
>;

export type ApplicationRunOutputExportResponse =
  | Readonly<{
      overallStatus: "success";
      value: ApplicationRunOutputExportResult;
      publication: Readonly<{ status: "published" }>;
      persistence: Readonly<{ status: "read"; effect: "none" }>;
    }>
  | Readonly<{
      overallStatus: "partial_success";
      value: ApplicationRunOutputExportResult;
      issues: readonly [ApplicationRunOutputExportCleanupIssue];
      publication: Readonly<{ status: "published" }>;
      persistence: Readonly<{ status: "read"; effect: "none" }>;
    }>
  | ApplicationRunOutputPrePersistenceFailure
  | ApplicationRunOutputPayloadUnavailableFailure
  | ApplicationRunOutputRepositoryDomainFailure
  | ApplicationRunOutputPersistenceFailure
  | ApplicationRunOutputPostReadFailure
  | ApplicationRunOutputPublicationDomainFailure;

export type ApplicationRunOutputCountsRequest<TAuthorizationContext> = Readonly<{
  context: ApplicationSessionOperationContext<TAuthorizationContext>;
  sessionId: string;
  runId: string;
}>;

export type ApplicationRunOutputsRequest<TAuthorizationContext> =
  ApplicationRunOutputCountsRequest<TAuthorizationContext> &
    Readonly<{
      category?: ApplicationRunOutputCategory;
      cursor?: string;
      limit?: number;
    }>;

export type ApplicationRunOutputPreviewRequest<TAuthorizationContext> =
  ApplicationRunOutputCountsRequest<TAuthorizationContext> &
    Readonly<{
      outputItemId: string;
      maxBytes?: number;
    }>;

export type ApplicationRunOutputChunkRequest<TAuthorizationContext> =
  ApplicationRunOutputCountsRequest<TAuthorizationContext> &
    Readonly<{
      outputItemId: string;
      offset: number;
      maxBytes?: number;
    }>;

export type ApplicationRunOutputExportRequest<TAuthorizationContext> =
  ApplicationRunOutputCountsRequest<TAuthorizationContext> &
    Readonly<{
      outputItemId: string;
      destinationGrant: ApplicationRunOutputDestinationGrant;
    }>;

export type ApplicationRunOutputAccessValidationInput<TAuthorizationContext> =
  | Readonly<{
      operation: "output_counts";
      access: "read";
      context: ApplicationSessionOperationContext<TAuthorizationContext>;
      target: Readonly<{ kind: "run_outputs"; sessionId: string; runId: string }>;
    }>
  | Readonly<{
      operation: "outputs";
      access: "read";
      context: ApplicationSessionOperationContext<TAuthorizationContext>;
      target: Readonly<{
        kind: "run_outputs";
        sessionId: string;
        runId: string;
        category?: ApplicationRunOutputCategory;
      }>;
    }>
  | Readonly<{
      operation: "output_preview";
      access: "read";
      context: ApplicationSessionOperationContext<TAuthorizationContext>;
      target: Readonly<{
        kind: "run_output_payload";
        sessionId: string;
        runId: string;
        outputItemId: string;
        maxBytes: number;
      }>;
    }>
  | Readonly<{
      operation: "output_chunk";
      access: "read";
      context: ApplicationSessionOperationContext<TAuthorizationContext>;
      target: Readonly<{
        kind: "run_output_payload";
        sessionId: string;
        runId: string;
        outputItemId: string;
        offset: number;
        maxBytes: number;
      }>;
    }>
  | Readonly<{
      operation: "output_export";
      access: "write";
      context: ApplicationSessionOperationContext<TAuthorizationContext>;
      target: Readonly<{
        kind: "run_output_export";
        sessionId: string;
        runId: string;
        outputItemId: string;
        destinationGrant: ApplicationRunOutputDestinationGrant;
      }>;
    }>;

export interface ApplicationRunOutputAccessValidator<TAuthorizationContext> {
  authorize(
    input: ApplicationRunOutputAccessValidationInput<TAuthorizationContext>,
  ): Promise<ApplicationAccessDecision>;
}

export interface ApplicationRunOutputOperations<TAuthorizationContext> {
  outputCounts(
    request: ApplicationRunOutputCountsRequest<TAuthorizationContext>,
    options?: ApplicationOperationOptions,
  ): Promise<ApplicationOperationResponse<ApplicationRunOutputCounts, "read">>;
  outputs(
    request: ApplicationRunOutputsRequest<TAuthorizationContext>,
    options?: ApplicationOperationOptions,
  ): Promise<ApplicationOperationResponse<ApplicationRunOutputPage, "read">>;
  outputPreview(
    request: ApplicationRunOutputPreviewRequest<TAuthorizationContext>,
    options?: ApplicationOperationOptions,
  ): Promise<ApplicationOperationResponse<ApplicationRunOutputPreview, "read">>;
  outputChunk(
    request: ApplicationRunOutputChunkRequest<TAuthorizationContext>,
    options?: ApplicationOperationOptions,
  ): Promise<ApplicationOperationResponse<ApplicationRunOutputChunk, "read">>;
  outputExport(
    request: ApplicationRunOutputExportRequest<TAuthorizationContext>,
    options?: ApplicationOperationOptions,
  ): Promise<ApplicationRunOutputExportResponse>;
}
