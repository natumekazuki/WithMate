import {
  MEMORY_V6_SCHEMA_VERSION,
  type MemoryError,
  type MemoryTag,
  type MemoryTargetSelector,
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
  tags: Array<MemoryTag & {
    entryCount?: number;
    latestUpdatedAt?: string;
    samples?: Array<{ id: string; title: string }>;
  }>;
};

export type MemoryTargetInventoryItem = {
  target: MemoryTargetSelector;
  owner: MemoryTargetSelector["owner"];
  scope: MemoryTargetSelector["scope"];
  project?: { id: string; displayName: string; path?: string };
  character?: { id: string; displayName: string };
  entryCount: number;
  tagCount: number;
  lastUpdatedAt: string | null;
};

export type MemoryListTargetsResponse = {
  schemaVersion: MemoryV6SchemaVersion;
  items: MemoryTargetInventoryItem[];
  nextCursor?: string;
};

export type MemoryEntryListItem = MemoryEntrySummary & {
  body?: string;
  supersedes: string[];
  supersededBy: string | null;
};

export type MemoryListEntriesResponse = {
  schemaVersion: MemoryV6SchemaVersion;
  items: MemoryEntryListItem[];
  nextCursor?: string;
};

export type MemoryAuditCandidate = {
  id: string;
  title: string;
  preview: string;
  updatedAt: string;
  reasons: string[];
};

export type MemoryTargetAudit = {
  target: MemoryTargetInventoryItem;
  countsByKind: Partial<Record<MemoryEntrySummary["kind"], number>>;
  topTags: Array<MemoryTag & { entryCount: number; latestUpdatedAt: string }>;
  staleOrProgressCandidates: MemoryAuditCandidate[];
  wrongScopeCandidates: MemoryAuditCandidate[];
  duplicateTitleCandidates: Array<{ normalizedTitle: string; entries: MemoryAuditCandidate[] }>;
  documentationCandidates: MemoryAuditCandidate[];
  suspiciousTagCandidates: MemoryAuditCandidate[];
};

export type MemoryAuditResponse = {
  schemaVersion: MemoryV6SchemaVersion;
  generatedAt: string;
  staleBefore: string;
  targets: MemoryTargetAudit[];
  nextCursor?: string;
};

export type MemoryCharacterSummary = {
  id: string;
  name: string;
  description?: string;
};

export type MemoryListCharactersResponse = {
  schemaVersion: MemoryV6SchemaVersion;
  characters: MemoryCharacterSummary[];
};

export type MemoryFileUsageResponse = {
  schemaVersion: MemoryV6SchemaVersion;
  quotaBytes: number;
  usedBytes: number;
  /**
   * DB metadata で active / delete_pending として把握している encrypted object size.
   * DB reference を持たない orphan object files は GC dry-run の orphanFiles で確認する。
   */
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
  entry?: MemoryEntrySummary;
  warning?: "target_mismatch_or_not_found";
};

export type MemoryForgetResponse = {
  schemaVersion: MemoryV6SchemaVersion;
  results: MemoryForgetResult[];
  dryRun?: true;
  writeOccurred?: false;
};

export type MemoryMoveEntryResponse = {
  schemaVersion: MemoryV6SchemaVersion;
  entry: MemoryEntrySummary;
  moved: boolean;
  from: MemoryTargetSelector;
  to: MemoryTargetSelector;
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

export function createMemoryListTagsResponse(tags: MemoryListTagsResponse["tags"]): MemoryListTagsResponse {
  return {
    schemaVersion: MEMORY_V6_SCHEMA_VERSION,
    tags: tags.map((tag) => ({
      type: tag.type,
      value: tag.value,
      ...(tag.entryCount === undefined ? {} : { entryCount: tag.entryCount }),
      ...(tag.latestUpdatedAt === undefined ? {} : { latestUpdatedAt: tag.latestUpdatedAt }),
      ...(tag.samples === undefined ? {} : { samples: tag.samples.map((sample) => ({ ...sample })) }),
    })),
  };
}

export function createMemoryListTargetsResponse(
  items: readonly MemoryTargetInventoryItem[],
  nextCursor?: string,
): MemoryListTargetsResponse {
  return {
    schemaVersion: MEMORY_V6_SCHEMA_VERSION,
    items: items.map((item) => ({ ...item })),
    ...(nextCursor === undefined ? {} : { nextCursor }),
  };
}

export function createMemoryListEntriesResponse(
  items: readonly MemoryEntryListItem[],
  nextCursor?: string,
): MemoryListEntriesResponse {
  return {
    schemaVersion: MEMORY_V6_SCHEMA_VERSION,
    items: items.map((item) => ({ ...item })),
    ...(nextCursor === undefined ? {} : { nextCursor }),
  };
}

export function createMemoryAuditResponse(input: Omit<MemoryAuditResponse, "schemaVersion">): MemoryAuditResponse {
  return {
    schemaVersion: MEMORY_V6_SCHEMA_VERSION,
    ...input,
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

export function createMemoryForgetResponse(
  results: readonly MemoryForgetResult[],
  options: { dryRun?: boolean } = {},
): MemoryForgetResponse {
  return {
    schemaVersion: MEMORY_V6_SCHEMA_VERSION,
    results: results.map((result) => ({ ...result })),
    ...(options.dryRun ? { dryRun: true as const, writeOccurred: false as const } : {}),
  };
}

export function createMemoryMoveEntryResponse(input: {
  entry: MemoryEntryDetail;
  moved: boolean;
  from: MemoryTargetSelector;
  to: MemoryTargetSelector;
}): MemoryMoveEntryResponse {
  return {
    schemaVersion: MEMORY_V6_SCHEMA_VERSION,
    entry: toMemoryEntrySummary(input.entry),
    moved: input.moved,
    from: input.from,
    to: input.to,
  };
}

export function createMemoryErrorResponse(error: MemoryError): MemoryErrorResponse {
  return {
    schemaVersion: MEMORY_V6_SCHEMA_VERSION,
    error,
  };
}
