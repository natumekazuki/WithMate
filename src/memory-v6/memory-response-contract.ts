import {
  MEMORY_V6_SCHEMA_VERSION,
  type MemoryError,
  type MemoryTag,
  type MemoryV6SchemaVersion,
} from "./memory-contract.js";
import type { CharacterCatalogEntry } from "../character/character-catalog.js";
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
  relatedTags?: MemoryTag[];
  nextCursor?: string;
};

export type MemoryGetEntryResponse = {
  schemaVersion: MemoryV6SchemaVersion;
  entry: MemoryEntryDetail;
};

export type MemoryGetFileResponse = {
  schemaVersion: MemoryV6SchemaVersion;
  objectId: string;
  entryId: string;
  outputPath: string;
  bytesWritten: number;
  contentType: string;
  displayName: string;
};

export type MemoryExportedFile = {
  objectId: string;
  outputPath: string;
  bytesWritten: number;
  contentType: string;
  displayName: string;
};

export type MemoryExportFilesResponse = {
  schemaVersion: MemoryV6SchemaVersion;
  entryId: string;
  outputDirectoryPath: string;
  exportedCount: number;
  files: MemoryExportedFile[];
};

export type MemoryListTagsResponse = {
  schemaVersion: MemoryV6SchemaVersion;
  tags: MemoryTag[];
};

export type MemoryCharacterSummary = {
  id: string;
  name: string;
  description?: string;
  isDefault?: boolean;
};

export type MemoryListCharactersResponse = {
  schemaVersion: MemoryV6SchemaVersion;
  characters: MemoryCharacterSummary[];
};

export type MemoryFileUsageResponse = {
  schemaVersion: MemoryV6SchemaVersion;
  quotaBytes: number;
  usedBytes: number;
  physicalBytes: number;
  pendingDeleteBytes: number;
  availableBytes: number;
  objectCount: number;
  pendingDeleteCount: number;
  quotaExceeded: boolean;
  largestEntries?: MemoryLargestFileEntry[];
};

export type MemoryLargestFileEntry = {
  entryId: string;
  title: string;
  preview: string;
  totalFileBytes: number;
  fileCount: number;
  updatedAt: string;
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

export function createMemorySearchResponse(
  items: readonly MemorySearchHit[],
  options: string | { nextCursor?: string; relatedTags?: readonly MemoryTag[] } = {},
): MemorySearchResponse {
  const normalizedOptions = typeof options === "string" ? { nextCursor: options } : options;
  return {
    schemaVersion: MEMORY_V6_SCHEMA_VERSION,
    items: [...items],
    ...(normalizedOptions.relatedTags && normalizedOptions.relatedTags.length > 0
      ? { relatedTags: normalizedOptions.relatedTags.map((tag) => ({ type: tag.type, value: tag.value })) }
      : {}),
    ...(normalizedOptions.nextCursor === undefined ? {} : { nextCursor: normalizedOptions.nextCursor }),
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

export function createMemoryGetFileResponse(input: {
  objectId: string;
  entryId: string;
  outputPath: string;
  bytesWritten: number;
  contentType: string;
  displayName: string;
}): MemoryGetFileResponse {
  return {
    schemaVersion: MEMORY_V6_SCHEMA_VERSION,
    objectId: input.objectId,
    entryId: input.entryId,
    outputPath: input.outputPath,
    bytesWritten: input.bytesWritten,
    contentType: input.contentType,
    displayName: input.displayName,
  };
}

export function createMemoryExportFilesResponse(input: {
  entryId: string;
  outputDirectoryPath: string;
  files: readonly MemoryExportedFile[];
}): MemoryExportFilesResponse {
  return {
    schemaVersion: MEMORY_V6_SCHEMA_VERSION,
    entryId: input.entryId,
    outputDirectoryPath: input.outputDirectoryPath,
    exportedCount: input.files.length,
    files: input.files.map((file) => ({
      objectId: file.objectId,
      outputPath: file.outputPath,
      bytesWritten: file.bytesWritten,
      contentType: file.contentType,
      displayName: file.displayName,
    })),
  };
}

export function createMemoryListTagsResponse(tags: readonly MemoryTag[]): MemoryListTagsResponse {
  return {
    schemaVersion: MEMORY_V6_SCHEMA_VERSION,
    tags: tags.map((tag) => ({ type: tag.type, value: tag.value })),
  };
}

export function createMemoryListCharactersResponse(characters: readonly CharacterCatalogEntry[]): MemoryListCharactersResponse {
  return {
    schemaVersion: MEMORY_V6_SCHEMA_VERSION,
    characters: characters.map((character) => {
      const description = character.description.trim();
      return {
        id: character.id,
        name: character.name,
        ...(description.length > 0 ? { description } : {}),
        ...(character.isDefault ? { isDefault: true } : {}),
      };
    }),
  };
}

export function createMemoryFileUsageResponse(input: {
  quotaBytes: number;
  usedBytes: number;
  physicalBytes: number;
  pendingDeleteBytes: number;
  objectCount: number;
  pendingDeleteCount: number;
  largestEntries?: readonly MemoryLargestFileEntry[];
}): MemoryFileUsageResponse {
  return {
    schemaVersion: MEMORY_V6_SCHEMA_VERSION,
    quotaBytes: input.quotaBytes,
    usedBytes: input.usedBytes,
    physicalBytes: input.physicalBytes,
    pendingDeleteBytes: input.pendingDeleteBytes,
    availableBytes: Math.max(0, input.quotaBytes - input.usedBytes),
    objectCount: input.objectCount,
    pendingDeleteCount: input.pendingDeleteCount,
    quotaExceeded: input.usedBytes > input.quotaBytes,
    ...(input.largestEntries === undefined
      ? {}
      : {
        largestEntries: input.largestEntries.map((entry) => ({
          entryId: entry.entryId,
          title: entry.title,
          preview: entry.preview,
          totalFileBytes: entry.totalFileBytes,
          fileCount: entry.fileCount,
          updatedAt: entry.updatedAt,
        })),
      }),
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

export function createMemoryErrorResponse(error: MemoryError): MemoryErrorResponse {
  return {
    schemaVersion: MEMORY_V6_SCHEMA_VERSION,
    error,
  };
}
