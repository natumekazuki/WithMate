import {
  MEMORY_V6_SCHEMA_VERSION,
  type MemoryError,
  type MemoryTag,
  type MemoryV6SchemaVersion,
} from "./memory-contract.js";
import {
  toMemoryEntrySummary,
  toMemorySearchHit,
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
  created: boolean;
};

export type MemoryForgetResultStatus = "forgotten" | "already_forgotten" | "not_found" | "forbidden";

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

export function createMemorySearchResponse(entries: readonly MemoryEntryDetail[], nextCursor?: string): MemorySearchResponse {
  const items = entries.flatMap((entry) => {
    const hit = toMemorySearchHit(entry);
    return hit === null ? [] : [hit];
  });

  return {
    schemaVersion: MEMORY_V6_SCHEMA_VERSION,
    items,
    ...(nextCursor === undefined ? {} : { nextCursor }),
  };
}

export function createMemoryGetEntryResponse(entry: MemoryEntryDetail | null): MemoryGetEntryResponse | MemoryErrorResponse {
  if (entry === null || entry.state !== "active") {
    return {
      schemaVersion: MEMORY_V6_SCHEMA_VERSION,
      error: {
        code: "MEMORY_ENTRY_NOT_FOUND",
        message: "Memory entry was not found.",
      },
    };
  }

  return {
    schemaVersion: MEMORY_V6_SCHEMA_VERSION,
    entry,
  };
}

export function createMemoryListTagsResponse(tags: readonly MemoryTag[]): MemoryListTagsResponse {
  return {
    schemaVersion: MEMORY_V6_SCHEMA_VERSION,
    tags: [...tags],
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
