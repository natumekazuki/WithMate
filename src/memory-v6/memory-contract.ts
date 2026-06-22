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

export type MemorySearchRequest = {
  schemaVersion: MemoryV6SchemaVersion;
  targets: MemoryTargetSelector[];
  query: string;
  kinds?: MemoryEntryKind[];
  tags?: MemoryTag[];
  limit?: number;
  cursor?: string;
};

export type MemoryAppendRequest = {
  schemaVersion: MemoryV6SchemaVersion;
  target: MemoryTargetSelector;
  kind: MemoryEntryKind;
  title: string;
  body: string;
  preview: string;
  tags: MemoryTag[];
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
