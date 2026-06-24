export const MEMORY_V6_SCHEMA_VERSION = "withmate-memory-v1" as const;

export type MemoryV6SchemaVersion = typeof MEMORY_V6_SCHEMA_VERSION;

export type MemoryEntryState = "active" | "superseded" | "forgotten";

export type MemoryEntryKind =
  | "decision"
  | "constraint"
  | "convention"
  | "context"
  | "deferred"
  | "preference"
  | "relationship"
  | "boundary"
  | "note";

export type MemoryPermission =
  | "memory.search"
  | "memory.append"
  | "memory.forget"
  | "memory.get_entry"
  | "memory.list_tags"
  | "memory.resolve_context";

export type ProjectTargetRef =
  | { type: "id"; id: string }
  | { type: "path"; path: string }
  | { type: "alias"; alias: string };

export type CharacterTargetRef =
  | { type: "id"; id: string }
  | { type: "current" };

export type MemoryTargetSelector =
  | { owner: "project"; project: ProjectTargetRef; scope: "project" }
  | { owner: "character"; character: CharacterTargetRef; scope: "character" }
  | { owner: "character"; character: CharacterTargetRef; scope: "project"; project: ProjectTargetRef };

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

export type MemoryForgetReason = "user_request" | "incorrect" | "outdated" | "privacy" | "other";

export type MemoryForgetRequest = {
  schemaVersion: MemoryV6SchemaVersion;
  entryIds: string[];
  reason?: MemoryForgetReason;
  sourceMessageId?: string;
  idempotencyKey?: string;
};

export type MemoryError = {
  code: string;
  message: string;
  field?: string;
};

export type MemoryValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: MemoryError };
