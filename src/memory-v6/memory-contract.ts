export const MEMORY_V6_SCHEMA_VERSION = "withmate-memory-v1" as const;

export type MemoryV6SchemaVersion = typeof MEMORY_V6_SCHEMA_VERSION;

export type MemoryEntryState = "active" | "superseded" | "forgotten";

export const MEMORY_ENTRY_KINDS = [
  "decision",
  "constraint",
  "convention",
  "context",
  "deferred",
  "preference",
  "relationship",
  "boundary",
  "note",
] as const;

export type MemoryEntryKind = typeof MEMORY_ENTRY_KINDS[number];

export type MemoryPermission =
  | "memory.search"
  | "memory.append"
  | "memory.forget"
  | "memory.get_entry"
  | "memory.list_tags"
  | "memory.list_characters";

export type ProjectTargetRef =
  | { type: "id"; id: string }
  | { type: "path"; path: string };

export type CharacterTargetRef = { type: "id"; id: string };

export type MemoryTargetSelector =
  | { owner: "project"; project: ProjectTargetRef; scope: "project" }
  | { owner: "character"; character: CharacterTargetRef; scope: "character" }
  | { owner: "character"; character: CharacterTargetRef; scope: "project"; project: ProjectTargetRef }
  | { owner: "user"; scope: "global" };

export type MemoryTag = {
  type: string;
  value: string;
};

export type NormalizedMemoryTag = MemoryTag & {
  canonicalType: string;
  canonicalValue: string;
};

export type MemorySearchRequest = {
  schemaVersion: MemoryV6SchemaVersion;
  targets: MemoryTargetSelector[];
  query: string;
  kinds?: MemoryEntryKind[];
  tags?: NormalizedMemoryTag[];
  limit?: number;
  cursor?: string;
};

export type MemoryGetEntryRequest = {
  schemaVersion: MemoryV6SchemaVersion;
  entryId: string;
  target?: MemoryTargetSelector;
};

export type MemoryListTagsRequest = {
  schemaVersion: MemoryV6SchemaVersion;
  targets: MemoryTargetSelector[];
};

export type MemoryAppendRequest = {
  schemaVersion: MemoryV6SchemaVersion;
  target: MemoryTargetSelector;
  kind: MemoryEntryKind;
  title: string;
  body: string;
  preview: string;
  tags: NormalizedMemoryTag[];
  supersedes?: string[];
  sourceMessageId?: string;
  idempotencyKey?: string;
};

export const MEMORY_FORGET_REASONS = [
  "user_request",
  "incorrect",
  "outdated",
  "privacy",
  "other",
] as const;

export type MemoryForgetReason = typeof MEMORY_FORGET_REASONS[number];

export type MemoryForgetRequest = {
  schemaVersion: MemoryV6SchemaVersion;
  target: MemoryTargetSelector;
  entryIds: string[];
  reason?: MemoryForgetReason;
  sourceMessageId?: string;
  idempotencyKey?: string;
};

export type MemoryV6ReviewSearchRequest = {
  query: string;
  kinds?: MemoryEntryKind[];
  limit?: number;
  cursor?: string;
};

export type MemoryError = {
  code: string;
  message: string;
  field?: string;
  allowedProjectTargets?: string[];
  suggestion?: string;
};

export type MemoryValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: MemoryError };
