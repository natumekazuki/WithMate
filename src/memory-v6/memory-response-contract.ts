import {
  MEMORY_V6_SCHEMA_VERSION,
  type MemoryError,
  type MemoryPermission,
  type MemoryTag,
  type MemoryV6SchemaVersion,
} from "./memory-contract.js";
import {
  toMemoryEntrySummary,
  validateMemoryEntryDetailInvariant,
  type MemoryEntryDetail,
  type MemoryEntrySummary,
  type MemorySearchHit,
} from "./memory-state.js";

export type MemorySearchResponse = {
  schemaVersion: MemoryV6SchemaVersion;
  items: MemorySearchHit[];
  nextCursor?: string;
};

export type MemoryGetEntryResponse = {
  schemaVersion: MemoryV6SchemaVersion;
  entry: MemoryEntryDetail;
};

export type MemoryListTagsResponse = {
  schemaVersion: MemoryV6SchemaVersion;
  tags: MemoryTag[];
};

export type MemoryAppendResponse = {
  schemaVersion: MemoryV6SchemaVersion;
  entry: MemoryEntrySummary;
  /**
   * True when the original idempotent append operation created this entry.
   * Idempotent replays return the same value after current access and state checks.
   */
  created: boolean;
};

export type MemoryForgetResultStatus = "forgotten" | "already_forgotten" | "not_found";

export type MemoryForgetResult = {
  entryId: string;
  status: MemoryForgetResultStatus;
};

export type MemoryForgetResponse = {
  schemaVersion: MemoryV6SchemaVersion;
  results: MemoryForgetResult[];
};

export type MemoryErrorResponse = {
  schemaVersion: MemoryV6SchemaVersion;
  error: MemoryError;
};

export type MemoryResolveContextResponse = {
  schemaVersion: MemoryV6SchemaVersion;
  session: { id: string };
  character: { id: string; name: string } | null;
  sessionProject: { id: string; displayName: string } | null;
  permissions: MemoryPermission[];
};

export function createMemorySearchResponse(items: readonly MemorySearchHit[], nextCursor?: string): MemorySearchResponse {
  return {
    schemaVersion: MEMORY_V6_SCHEMA_VERSION,
    items: [...items],
    ...(nextCursor === undefined ? {} : { nextCursor }),
  };
}

export function createMemoryGetEntryResponse(entry: MemoryEntryDetail | null): MemoryGetEntryResponse | MemoryErrorResponse {
  if (entry === null || entry.state !== "active" || !validateMemoryEntryDetailInvariant(entry)) {
    return createMemoryErrorResponse({
      code: "MEMORY_ENTRY_NOT_FOUND",
      message: "Memory entry was not found.",
    });
  }

  return {
    schemaVersion: MEMORY_V6_SCHEMA_VERSION,
    entry,
  };
}

export function createMemoryListTagsResponse(tags: readonly MemoryTag[]): MemoryListTagsResponse {
  return {
    schemaVersion: MEMORY_V6_SCHEMA_VERSION,
    tags: tags.map((tag) => ({ type: tag.type, value: tag.value })),
  };
}

export function createMemoryAppendResponse(entry: MemoryEntryDetail, created: boolean): MemoryAppendResponse {
  return {
    schemaVersion: MEMORY_V6_SCHEMA_VERSION,
    entry: toMemoryEntrySummary(entry),
    created,
  };
}

export function createMemoryForgetResponse(results: readonly MemoryForgetResult[]): MemoryForgetResponse {
  return {
    schemaVersion: MEMORY_V6_SCHEMA_VERSION,
    results: [...results],
  };
}

export function createMemoryResolveContextResponse(input: Omit<MemoryResolveContextResponse, "schemaVersion">): MemoryResolveContextResponse {
  return {
    schemaVersion: MEMORY_V6_SCHEMA_VERSION,
    session: input.session,
    character: input.character,
    sessionProject: input.sessionProject,
    permissions: [...input.permissions],
  };
}

export function createMemoryErrorResponse(error: MemoryError): MemoryErrorResponse {
  return {
    schemaVersion: MEMORY_V6_SCHEMA_VERSION,
    error,
  };
}
