import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import type {
  MemoryEntryKind,
  MemoryAppendFileRole,
  MemoryForgetReason,
  MemoryEntryState,
  NormalizedMemoryTag,
} from "../src/memory-v6/memory-contract.js";
import {
  decodeMemoryListTagsCursor,
  encodeMemoryListTagsCursor,
  type MemoryListTagsCursor,
} from "../src/memory-v6/memory-validation.js";
import type {
  MemoryV6ReviewForgetResult,
  MemoryV6ReviewSearchHit,
  MemoryV6ReviewSearchResult,
} from "../src/memory-v6/memory-review-state.js";
import {
  toMemorySearchHit,
  type ActiveMemoryEntryDetail,
  type MemoryEntryDetail,
  type MemoryFileSummary,
  type MemorySearchHit,
  type MemorySearchMatch,
  type MemorySearchMatchField,
} from "../src/memory-v6/memory-state.js";
import { isValidV6Database } from "./database-schema-v6.js";
import {
  MEMORY_V6_ENTRY_SELECT_COLUMNS,
  tagIdentityKey,
  targetKey,
  targetWhereSql,
  type MemoryV6EntryRow,
  type MemoryV6ProjectScopeAdmission,
  type MemoryV6ResolvedTarget,
  type MemoryV6StorageSource,
  type MemoryV6TagRow,
} from "./memory-v6-schema.js";
import { openAppDatabase } from "./sqlite-connection.js";

type AppendMemoryEntryInput = {
  target: MemoryV6ResolvedTarget;
  kind: MemoryEntryKind;
  title: string;
  body: string;
  preview: string;
  tags: readonly NormalizedMemoryTag[];
  source: MemoryV6StorageSource;
  supersedes?: readonly string[];
  mutationReason?: string;
  id?: string;
  idempotencyKey?: string;
  bindingIdHash?: string;
  requestFingerprint?: string;
  protectedObjects?: readonly MemoryV6AppendProtectedObjectInput[];
  fileQuotaBytes?: number;
  now?: string;
  projectScopeAdmissions?: readonly MemoryV6ProjectScopeAdmission[];
};

type ForgetMemoryEntriesInput = {
  target: MemoryV6ResolvedTarget;
  entryIds: readonly string[];
  reason?: MemoryForgetReason;
  idempotencyKey?: string;
  bindingIdHash?: string;
  requestFingerprint?: string;
  sessionId?: string | null;
  sourceMessageId?: string | null;
  now?: string;
};

export type MemoryV6AppendResult = {
  entry: MemoryEntryDetail;
  created: boolean;
  replayed?: true;
  cleanupRequired?: true;
};

export type MemoryV6ForgetResultStatus = "forgotten" | "already_forgotten" | "not_found";

export type MemoryV6ForgetResult = {
  entryId: string;
  status: MemoryV6ForgetResultStatus;
  replayed?: true;
};

export type MemoryV6ForgetPreviewResult = MemoryV6ForgetResult & {
  entry?: MemoryEntryDetail;
  warning?: "target_mismatch_or_not_found";
};

export type MemoryV6SearchInput = {
  targets: readonly MemoryV6ResolvedTarget[];
  query: string;
  kinds?: readonly MemoryEntryKind[];
  tags?: readonly NormalizedMemoryTag[];
  limit?: number;
  cursor?: string;
};

export type MemoryV6SearchResult = {
  items: MemorySearchHit[];
  relatedTags?: NormalizedMemoryTag[];
  nextCursor?: string;
};

export type MemoryV6TagStatistic = NormalizedMemoryTag & {
  entryCount: number;
  latestUpdatedAt: string;
  samples: Array<{ id: string; title: string }>;
};

export type MemoryV6TargetInventoryItem = {
  target: MemoryV6ResolvedTarget;
  project?: { id: string; displayName: string; path?: string };
  character?: { id: string; displayName: string };
  entryCount: number;
  tagCount: number;
  lastUpdatedAt: string | null;
};

export type MemoryV6ListTargetsInput = {
  ownerType?: MemoryV6ResolvedTarget["owner"]["type"];
  scopeType?: MemoryV6ResolvedTarget["scope"]["type"];
  projectId?: string;
  characterId?: string;
  includeEmpty?: boolean;
  limit?: number;
  cursor?: string;
};

export type MemoryV6ListTargetsResult = {
  items: MemoryV6TargetInventoryItem[];
  nextCursor?: string;
};

export type MemoryV6ListEntriesInput = {
  target: MemoryV6ResolvedTarget;
  states?: readonly MemoryEntryState[];
  kinds?: readonly MemoryEntryKind[];
  tags?: readonly NormalizedMemoryTag[];
  limit?: number;
  cursor?: string;
};

export type MemoryV6ListEntriesResult = {
  items: MemoryEntryDetail[];
  nextCursor?: string;
};

export type MemoryV6ListTagsResult<T> = {
  items: T[];
  nextCursor?: string;
};

export type MemoryV6MoveEntryInput = {
  entryId: string;
  from: MemoryV6ResolvedTarget;
  to: MemoryV6ResolvedTarget;
  bindingIdHash?: string;
  idempotencyKey?: string;
  requestFingerprint: string;
  now?: string;
  projectScopeAdmissions?: readonly MemoryV6ProjectScopeAdmission[];
};

export type MemoryV6MoveEntryResult = {
  entry: MemoryEntryDetail;
  moved: boolean;
  replayed?: true;
};

export type MemoryV6ReviewSearchInput = {
  query: string;
  kinds?: readonly MemoryEntryKind[];
  limit?: number;
  cursor?: string;
};

export type MemoryV6ReviewForgetInput = {
  entryId: string;
  reason?: MemoryForgetReason;
  now?: string;
};

export type MemoryV6FileUsage = {
  usedBytes: number;
  physicalBytes: number;
  pendingDeleteBytes: number;
  objectCount: number;
  pendingDeleteCount: number;
};

export type MemoryV6LargestFileEntry = {
  entryId: string;
  title: string;
  preview: string;
  totalFileBytes: number;
  fileCount: number;
  updatedAt: string;
};

export type MemoryV6ProtectedObjectMediaKind =
  | "image"
  | "text"
  | "source"
  | "archive"
  | "document"
  | "other";

export type MemoryV6AppendProtectedObjectInput = {
  objectId: string;
  role: MemoryAppendFileRole;
  mediaKind: MemoryV6ProtectedObjectMediaKind;
  contentType?: string;
  displayName?: string;
  summary: string;
  originalBytes: number;
  storedBytes: number;
  sha256: string;
  keyId: string;
};

export type MemoryV6ProtectedObjectExportMetadata = {
  objectId: string;
  entryId: string;
  contentType: string;
  displayName: string;
  originalBytes: number;
  storedBytes: number;
  sha256: string;
  keyId: string;
};

export type MemoryV6ProtectedObjectGcCandidate = {
  objectId: string;
  storedBytes: number;
  updatedAt: string;
};

export class MemoryV6IdempotencyConflictError extends Error {
  constructor() {
    super("Memory V6 idempotency key was reused with a different request.");
  }
}

export class MemoryV6EntryNotFoundError extends Error {
  constructor(entryId: string) {
    super(`Memory V6 entry was not found: ${entryId}`);
  }
}

export class MemoryV6FileQuotaExceededError extends Error {
  constructor(
    readonly quotaBytes: number,
    readonly usedBytes: number,
    readonly incomingBytes: number,
  ) {
    super("Memory V6 file quota would be exceeded.");
  }

  get availableBytes(): number {
    return Math.max(0, this.quotaBytes - this.usedBytes);
  }
}

type IdempotencyRow = {
  response_entry_id: string | null;
  operation_created: number;
  request_fingerprint: string;
  cleanup_pending_count: number;
};

const DEFAULT_SEARCH_LIMIT = 20;
const MAX_SEARCH_LIMIT = 50;
const MAX_MAINTENANCE_LIMIT = 200;
const EMPTY_INVENTORY_UPDATED_AT = "__empty_target__";
const PROTECTED_OBJECT_ID_PATTERN = /^[a-f0-9]{32}$/;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;
const PROTECTED_OBJECT_MEDIA_KINDS = new Set<MemoryV6ProtectedObjectMediaKind>([
  "image",
  "text",
  "source",
  "archive",
  "document",
  "other",
]);
const PROTECTED_OBJECT_ROLES = new Set<MemoryAppendFileRole>([
  "evidence",
  "source",
  "snapshot",
  "artifact",
  "reference",
  "other",
]);

function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function nowIso(): string {
  return new Date().toISOString();
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function fingerprint(value: unknown): string {
  return sha256Hex(stableJson(value));
}

function normalizeLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    return DEFAULT_SEARCH_LIMIT;
  }
  return Math.max(1, Math.min(MAX_SEARCH_LIMIT, Math.floor(limit)));
}

type SearchCursor = {
  updatedAt: string;
  id: string;
};

type SearchQueryPlan = {
  normalizedQuery: string;
  tokens: string[];
};

type ScoredSearchEntry = {
  row: MemoryV6EntryRow;
  entry: ActiveMemoryEntryDetail;
  match: MemorySearchMatch;
};

type MemoryV6ProtectedObjectSummaryRow = {
  object_id: string;
  role: MemoryAppendFileRole;
  media_kind: MemoryFileSummary["mediaKind"];
  content_type: string;
  display_name: string;
  summary: string;
  original_bytes: number;
};

type MemoryV6ProtectedObjectExportRow = {
  object_id: string;
  entry_id: string;
  content_type: string;
  display_name: string;
  original_bytes: number;
  stored_bytes: number;
  sha256: string;
  key_id: string;
};

function encodeCursor(cursor: SearchCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(cursor: string | undefined): SearchCursor | null {
  if (!cursor) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { updatedAt?: unknown; id?: unknown };
    if (typeof parsed.updatedAt === "string" && typeof parsed.id === "string" && parsed.updatedAt && parsed.id) {
      return { updatedAt: parsed.updatedAt, id: parsed.id };
    }
    return null;
  } catch {
    return null;
  }
}

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFC")
    .toLowerCase()
    .replace(/[\u2010-\u2015_-]+/g, " ")
    .replace(/[/:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function expandSearchToken(token: string): string[] {
  switch (token) {
    case "delivery":
      return [token, "納品"];
    case "納品":
      return [token, "delivery"];
    case "branch":
      return [token, "ブランチ"];
    case "ブランチ":
      return [token, "branch"];
    default:
      return [token];
  }
}

function buildSearchQueryPlan(query: string): SearchQueryPlan {
  const normalizedQuery = normalizeSearchText(query);
  const tokens = new Set<string>();
  for (const token of normalizedQuery.split(" ")) {
    if (!token) {
      continue;
    }
    for (const expanded of expandSearchToken(token)) {
      tokens.add(expanded);
    }
  }

  return {
    normalizedQuery,
    tokens: [...tokens],
  };
}

function scoreNormalizedText(text: string, plan: SearchQueryPlan, weight: number): number {
  if (!text) {
    return 0;
  }
  let score = 0;
  if (plan.normalizedQuery && text.includes(plan.normalizedQuery)) {
    score += weight * 2;
  }
  for (const token of plan.tokens) {
    if (text.includes(token)) {
      score += weight;
    }
  }
  return score;
}

function buildSnippet(value: string, plan: SearchQueryPlan): string | undefined {
  const normalizedValue = normalizeSearchText(value);
  const token = plan.tokens.find((item) => normalizedValue.includes(item));
  if (!token) {
    return undefined;
  }
  const normalizedIndex = normalizedValue.indexOf(token);
  const start = Math.max(0, normalizedIndex - 48);
  const end = Math.min(value.length, normalizedIndex + token.length + 96);
  const snippet = value.slice(start, end).trim();
  if (!snippet) {
    return undefined;
  }
  return `${start > 0 ? "..." : ""}${snippet}${end < value.length ? "..." : ""}`;
}

function tagSearchText(tag: NormalizedMemoryTag): string {
  return normalizeSearchText([
    tag.type,
    tag.value,
    tag.canonicalType,
    tag.canonicalValue,
    `${tag.type}:${tag.value}`,
  ].join(" "));
}

function tagSnippet(tags: readonly NormalizedMemoryTag[], plan: SearchQueryPlan): string | undefined {
  const matchedTags = tags
    .filter((tag) => scoreNormalizedText(tagSearchText(tag), plan, 1) > 0)
    .map((tag) => `${tag.type}:${tag.value}`);
  return matchedTags.length > 0 ? `tags: ${matchedTags.join(", ")}` : undefined;
}

function uniqueSearchTokens(plan: SearchQueryPlan): string[] {
  return plan.tokens.filter((token, index, tokens) => token.length > 0 && tokens.indexOf(token) === index);
}

export function countMemorySearchQueryTerms(query: string): number {
  return uniqueSearchTokens(buildSearchQueryPlan(query)).length;
}

function ownerRef(row: MemoryV6EntryRow): MemoryEntryDetail["owner"] {
  if (row.owner_type === "user") {
    return { type: "user", id: "local-user" };
  }
  return { type: row.owner_type, id: row.owner_id };
}

function scopeRef(row: MemoryV6EntryRow): MemoryEntryDetail["scope"] {
  if (row.scope_type === "global") {
    return { type: "global", id: "global" };
  }
  return { type: row.scope_type, id: row.scope_id };
}

function hasValidTargetInvariant(row: MemoryV6EntryRow): boolean {
  const hasUserOwner = row.owner_type === "user";
  const hasGlobalScope = row.scope_type === "global";
  if (!hasUserOwner && !hasGlobalScope) {
    return true;
  }
  return hasUserOwner
    && row.owner_id === "local-user"
    && hasGlobalScope
    && row.scope_id === "global";
}

function normalizeMaintenanceLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    return DEFAULT_SEARCH_LIMIT;
  }
  return Math.max(1, Math.min(MAX_MAINTENANCE_LIMIT, Math.floor(limit)));
}

function isSupportedResolvedTarget(target: MemoryV6ResolvedTarget): boolean {
  return (target.owner.type === "user" && target.owner.id === "local-user" && target.scope.type === "global" && target.scope.id === "global")
    || (target.owner.type === "project" && target.scope.type === "project" && target.owner.id === target.scope.id)
    || (target.owner.type === "character" && target.scope.type === "character" && target.owner.id === target.scope.id)
    || (target.owner.type === "character" && target.scope.type === "project");
}

function compareInventoryItems(left: MemoryV6TargetInventoryItem, right: MemoryV6TargetInventoryItem): number {
  return targetKey(left.target).localeCompare(targetKey(right.target));
}

function inventoryItemFollowsCursor(item: MemoryV6TargetInventoryItem, cursor: SearchCursor): boolean {
  return targetKey(item.target).localeCompare(cursor.id) > 0;
}

function buildAppendFingerprint(input: AppendMemoryEntryInput): string {
  return fingerprint({
    operation: "append",
    target: input.target,
    kind: input.kind,
    title: input.title,
    body: input.body,
    preview: input.preview,
    tags: input.tags.map((tag) => ({
      type: tag.type,
      value: tag.value,
      canonicalType: tag.canonicalType,
      canonicalValue: tag.canonicalValue,
    })),
    source: input.source,
    supersedes: [...(input.supersedes ?? [])].sort(),
    mutationReason: input.mutationReason ?? "",
    protectedObjects: (input.protectedObjects ?? []).map((object) => ({
      objectId: object.objectId,
      role: object.role,
      mediaKind: object.mediaKind,
      contentType: object.contentType ?? "",
      displayName: object.displayName ?? "",
      summary: object.summary,
      originalBytes: object.originalBytes,
      storedBytes: object.storedBytes,
      sha256: object.sha256,
      keyId: object.keyId,
    })),
  });
}

function buildForgetFingerprint(input: ForgetMemoryEntriesInput): string {
  return fingerprint({
    operation: "forget",
    target: input.target,
    entryIds: [...input.entryIds].sort(),
    reason: input.reason ?? "user_request",
    sourceMessageId: input.sourceMessageId ?? null,
  });
}

function uniqueIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const id of ids) {
    const trimmed = id.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

function normalizeProtectedObjects(
  protectedObjects: readonly MemoryV6AppendProtectedObjectInput[],
): MemoryV6AppendProtectedObjectInput[] {
  return protectedObjects.map((object) => {
    if (!PROTECTED_OBJECT_ID_PATTERN.test(object.objectId)) {
      throw new Error("Memory protected object ID is invalid.");
    }
    if (!SHA256_HEX_PATTERN.test(object.sha256)) {
      throw new Error("Memory protected object sha256 is invalid.");
    }
    if (!PROTECTED_OBJECT_MEDIA_KINDS.has(object.mediaKind)) {
      throw new Error("Memory protected object media kind is invalid.");
    }
    if (!PROTECTED_OBJECT_ROLES.has(object.role)) {
      throw new Error("Memory protected object role is invalid.");
    }
    if (object.keyId.trim().length === 0) {
      throw new Error("Memory protected object key id is required.");
    }
    if (object.summary.trim().length === 0) {
      throw new Error("Memory protected object summary is required.");
    }
    if (!Number.isSafeInteger(object.originalBytes) || object.originalBytes < 0) {
      throw new Error("Memory protected object original bytes are invalid.");
    }
    if (!Number.isSafeInteger(object.storedBytes) || object.storedBytes < 0) {
      throw new Error("Memory protected object stored bytes are invalid.");
    }
    return {
      ...object,
      contentType: object.contentType?.trim() ?? "",
      displayName: object.displayName?.trim() ?? "",
      summary: object.summary.trim(),
    };
  });
}

export class MemoryV6Storage {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    if (!isValidV6Database(dbPath)) {
      throw new Error("MemoryV6Storage requires a valid withmate-v6.db database.");
    }
    this.db = openAppDatabase(dbPath);
  }

  resolveAppendIdempotencyReplay(input: {
    target: MemoryV6ResolvedTarget;
    idempotencyKey: string;
    bindingIdHash?: string;
    requestFingerprint: string;
  }): MemoryV6AppendResult | null {
    return this.resolveAppendIdempotency(
      input.target,
      input.idempotencyKey,
      input.bindingIdHash ?? "",
      input.requestFingerprint,
    );
  }

  settleAppendCleanupObligation(input: {
    target: MemoryV6ResolvedTarget;
    idempotencyKey: string;
    bindingIdHash?: string;
  }): void {
    const result = this.db.prepare(`
      UPDATE memory_idempotency_keys_v6
      SET cleanup_pending_count = cleanup_pending_count - 1
      WHERE binding_id_hash = ?
        AND key = ?
        AND operation = 'append'
        AND owner_type = ?
        AND owner_id = ?
        AND scope_type = ?
        AND scope_id = ?
        AND cleanup_pending_count > 0
    `).run(
      input.bindingIdHash ?? "",
      input.idempotencyKey,
      input.target.owner.type,
      input.target.owner.id,
      input.target.scope.type,
      input.target.scope.id,
    );
    if (result.changes !== 1) {
      throw new MemoryV6EntryNotFoundError(input.idempotencyKey);
    }
  }

  private addAppendCleanupObligation(input: {
    target: MemoryV6ResolvedTarget;
    idempotencyKey: string;
    bindingIdHash: string;
  }): void {
    const result = this.db.prepare(`
      UPDATE memory_idempotency_keys_v6
      SET cleanup_pending_count = cleanup_pending_count + 1
      WHERE binding_id_hash = ?
        AND key = ?
        AND operation = 'append'
        AND owner_type = ?
        AND owner_id = ?
        AND scope_type = ?
        AND scope_id = ?
    `).run(
      input.bindingIdHash,
      input.idempotencyKey,
      input.target.owner.type,
      input.target.owner.id,
      input.target.scope.type,
      input.target.scope.id,
    );
    if (result.changes !== 1) {
      throw new MemoryV6EntryNotFoundError(input.idempotencyKey);
    }
  }

  appendEntry(input: AppendMemoryEntryInput): MemoryV6AppendResult {
    const createdAt = input.now ?? nowIso();
    const entryId = input.id ?? `mem-${randomUUID()}`;
    const bindingIdHash = input.bindingIdHash ?? "";
    const requestFingerprint = input.requestFingerprint ?? buildAppendFingerprint(input);
    const protectedObjects = normalizeProtectedObjects(input.protectedObjects ?? []);

    return this.transaction(() => {
      if (input.idempotencyKey) {
        const replay = this.resolveAppendIdempotency(input.target, input.idempotencyKey, bindingIdHash, requestFingerprint);
        if (replay) {
          if (protectedObjects.length > 0) {
            this.addAppendCleanupObligation({
              target: input.target,
              idempotencyKey: input.idempotencyKey,
              bindingIdHash,
            });
            return { ...replay, cleanupRequired: true };
          }
          return replay;
        }
      }

      const supersedes = uniqueIds(input.supersedes ?? []);
      const supersededRows = supersedes.map((supersededId) => {
        const row = this.getEntryRow(supersededId);
        if (!row || row.state !== "active" || !this.rowMatchesTarget(row, input.target)) {
          throw new MemoryV6EntryNotFoundError(supersededId);
        }
        return row;
      });
      this.assertProtectedObjectQuota(protectedObjects, input.fileQuotaBytes);
      this.admitProjectScopes(input.projectScopeAdmissions ?? [], createdAt);

      this.db.prepare(`
        INSERT INTO memory_entries_v6 (
          id,
          owner_type,
          owner_id,
          scope_type,
          scope_id,
          kind,
          title,
          body,
          body_sha256,
          preview,
          state,
          source_type,
          source_session_id,
          source_app_message_id,
          source_provider_message_id,
          source_provider_id,
          superseded_by_id,
          created_at,
          updated_at,
          forgotten_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, NULL, ?, ?, NULL)
      `).run(
        entryId,
        input.target.owner.type,
        input.target.owner.id,
        input.target.scope.type,
        input.target.scope.id,
        input.kind,
        input.title,
        input.body,
        sha256Hex(input.body),
        input.preview,
        input.source.type,
        input.source.sessionId,
        input.source.appMessageId ?? null,
        input.source.messageId,
        input.source.providerId,
        createdAt,
        createdAt,
      );

      this.replaceTags(entryId, input.tags, createdAt);
      this.incrementTagCatalog(input.tags, createdAt);
      this.incrementTargetTagStats(input.target, input.tags, createdAt);
      this.insertProtectedObjects(entryId, protectedObjects, createdAt);

      for (const supersededRow of supersededRows) {
        this.db.prepare(`
          INSERT INTO memory_entry_relations_v6 (
            source_entry_id,
            target_entry_id,
            relation_type,
            created_at
          ) VALUES (?, ?, 'supersedes', ?)
        `).run(entryId, supersededRow.id, createdAt);

        this.db.prepare(`
          UPDATE memory_entries_v6
          SET state = 'superseded',
              superseded_by_id = ?,
              updated_at = ?
          WHERE id = ?
            AND state = 'active'
        `).run(entryId, createdAt, supersededRow.id);

        const supersededTags = this.getEntryTags(supersededRow.id);
        this.decrementTagCatalog(supersededTags);
        this.refreshTargetTagStats(input.target, supersededTags);
        this.insertMutationEvent(
          "supersede",
          supersededRow.id,
          bindingIdHash,
          input.source.sessionId,
          "success",
          input.mutationReason ?? "",
          createdAt,
        );
      }

      this.insertMutationEvent(
        "append",
        entryId,
        bindingIdHash,
        input.source.sessionId,
        "success",
        input.mutationReason ?? "",
        createdAt,
      );

      if (input.idempotencyKey) {
        this.insertIdempotencyKey({
          key: input.idempotencyKey,
          operation: "append",
          bindingIdHash,
          target: input.target,
          responseEntryId: entryId,
          operationCreated: true,
          requestFingerprint,
          createdAt,
        });
      }

      const entry = this.getEntry(entryId);
      if (!entry) {
        throw new MemoryV6EntryNotFoundError(entryId);
      }
      return { entry, created: true };
    });
  }

  getEntry(entryId: string): MemoryEntryDetail | null {
    const row = this.getEntryRow(entryId);
    return row ? this.rowToEntry(row) : null;
  }

  listTargets(input: MemoryV6ListTargetsInput = {}): MemoryV6ListTargetsResult {
    type InventoryRow = {
      owner_type: MemoryV6ResolvedTarget["owner"]["type"];
      owner_id: string;
      scope_type: MemoryV6ResolvedTarget["scope"]["type"];
      scope_id: string;
      entry_count: number;
      tag_count: number;
      last_updated_at: string | null;
      project_id: string | null;
      project_display_name: string | null;
      project_path: string | null;
      character_id: string | null;
      character_display_name: string | null;
    };

    const rows = this.db.prepare(`
      SELECT
        e.owner_type,
        e.owner_id,
        e.scope_type,
        e.scope_id,
        COUNT(DISTINCT e.id) AS entry_count,
        COUNT(DISTINCT t.tag_type_canonical || char(0) || t.tag_value_canonical) AS tag_count,
        MAX(e.updated_at) AS last_updated_at,
        p.id AS project_id,
        p.display_name AS project_display_name,
        p.workspace_path AS project_path,
        c.id AS character_id,
        c.name AS character_display_name
      FROM memory_entries_v6 AS e
      LEFT JOIN memory_entry_tags_v6 AS t ON t.entry_id = e.id
      LEFT JOIN project_scopes_v6 AS p
        ON p.id = CASE
          WHEN e.owner_type = 'project' THEN e.owner_id
          WHEN e.scope_type = 'project' THEN e.scope_id
          ELSE NULL
        END
      LEFT JOIN characters AS c ON c.id = CASE WHEN e.owner_type = 'character' THEN e.owner_id ELSE NULL END
      WHERE e.state = 'active'
      GROUP BY e.owner_type, e.owner_id, e.scope_type, e.scope_id
    `).all() as InventoryRow[];

    const items = new Map<string, MemoryV6TargetInventoryItem>();
    const add = (item: MemoryV6TargetInventoryItem): void => {
      if (isSupportedResolvedTarget(item.target)) {
        items.set(targetKey(item.target), item);
      }
    };
    for (const row of rows) {
      const target = {
        owner: row.owner_type === "user"
          ? { type: "user" as const, id: "local-user" as const }
          : { type: row.owner_type, id: row.owner_id },
        scope: row.scope_type === "global"
          ? { type: "global" as const, id: "global" as const }
          : { type: row.scope_type, id: row.scope_id },
      } satisfies MemoryV6ResolvedTarget;
      add({
        target,
        ...(row.project_id ? {
          project: {
            id: row.project_id,
            displayName: row.project_display_name || row.project_id,
            ...(row.project_path ? { path: row.project_path } : {}),
          },
        } : {}),
        ...(row.character_id ? {
          character: { id: row.character_id, displayName: row.character_display_name || row.character_id },
        } : {}),
        entryCount: Number(row.entry_count),
        tagCount: Number(row.tag_count),
        lastUpdatedAt: row.last_updated_at,
      });
    }

    if (input.includeEmpty) {
      const projects = this.db.prepare(`
        SELECT id, display_name, workspace_path
        FROM project_scopes_v6
      `).all() as Array<{ id: string; display_name: string; workspace_path: string }>;
      for (const project of projects) {
        const target = { owner: { type: "project" as const, id: project.id }, scope: { type: "project" as const, id: project.id } };
        if (!items.has(targetKey(target))) {
          add({
            target,
            project: { id: project.id, displayName: project.display_name || project.id, ...(project.workspace_path ? { path: project.workspace_path } : {}) },
            entryCount: 0,
            tagCount: 0,
            lastUpdatedAt: null,
          });
        }
      }
      const characters = this.db.prepare(`
        SELECT id, name
        FROM characters
        WHERE state = 'active'
      `).all() as Array<{ id: string; name: string }>;
      for (const character of characters) {
        const target = { owner: { type: "character" as const, id: character.id }, scope: { type: "character" as const, id: character.id } };
        if (!items.has(targetKey(target))) {
          add({
            target,
            character: { id: character.id, displayName: character.name || character.id },
            entryCount: 0,
            tagCount: 0,
            lastUpdatedAt: null,
          });
        }
      }
      const userTarget = { owner: { type: "user" as const, id: "local-user" as const }, scope: { type: "global" as const, id: "global" as const } };
      if (!items.has(targetKey(userTarget))) {
        add({ target: userTarget, entryCount: 0, tagCount: 0, lastUpdatedAt: null });
      }
    }

    const filtered = [...items.values()]
      .filter((item) => input.ownerType === undefined || item.target.owner.type === input.ownerType)
      .filter((item) => input.scopeType === undefined || item.target.scope.type === input.scopeType)
      .filter((item) => input.projectId === undefined || item.project?.id === input.projectId || (item.target.scope.type === "project" && item.target.scope.id === input.projectId))
      .filter((item) => input.characterId === undefined || item.character?.id === input.characterId || (item.target.owner.type === "character" && item.target.owner.id === input.characterId))
      .sort(compareInventoryItems);
    const cursor = decodeCursor(input.cursor);
    const nextIndex = cursor ? filtered.findIndex((item) => inventoryItemFollowsCursor(item, cursor)) : 0;
    const start = nextIndex < 0 ? filtered.length : nextIndex;
    const limit = normalizeMaintenanceLimit(input.limit);
    const page = filtered.slice(start, start + limit);
    const last = page[page.length - 1];
    return {
      items: page,
      ...(start + page.length < filtered.length && last
        ? { nextCursor: encodeCursor({ updatedAt: last.lastUpdatedAt ?? EMPTY_INVENTORY_UPDATED_AT, id: targetKey(last.target) }) }
        : {}),
    };
  }

  listEntries(input: MemoryV6ListEntriesInput): MemoryV6ListEntriesResult {
    const limit = normalizeMaintenanceLimit(input.limit);
    const cursor = decodeCursor(input.cursor);
    const clauses = ["e.owner_type = ?", "e.owner_id = ?", "e.scope_type = ?", "e.scope_id = ?"];
    const params: SQLInputValue[] = [input.target.owner.type, input.target.owner.id, input.target.scope.type, input.target.scope.id];
    const states = input.states && input.states.length > 0 ? input.states : ["active"];
    clauses.push(`e.state IN (${states.map(() => "?").join(", ")})`);
    params.push(...states);
    if (input.kinds && input.kinds.length > 0) {
      clauses.push(`e.kind IN (${input.kinds.map(() => "?").join(", ")})`);
      params.push(...input.kinds);
    }
    for (const tag of input.tags ?? []) {
      clauses.push(`EXISTS (
        SELECT 1 FROM memory_entry_tags_v6 AS filter_tag
        WHERE filter_tag.entry_id = e.id
          AND filter_tag.tag_type_canonical = ?
          AND filter_tag.tag_value_canonical = ?
      )`);
      params.push(tag.canonicalType, tag.canonicalValue);
    }
    if (cursor) {
      clauses.push("(e.updated_at < ? OR (e.updated_at = ? AND e.id < ?))");
      params.push(cursor.updatedAt, cursor.updatedAt, cursor.id);
    }
    const rows = this.db.prepare(`
      SELECT ${MEMORY_V6_ENTRY_SELECT_COLUMNS}
      FROM memory_entries_v6 AS e
      WHERE ${clauses.join(" AND ")}
      ORDER BY e.updated_at DESC, e.id DESC
      LIMIT ?
    `).all(...params, limit + 1) as MemoryV6EntryRow[];
    const validRows = rows.filter(hasValidTargetInvariant);
    const page = validRows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((row) => this.rowToEntry(row)),
      ...(validRows.length > limit && last ? { nextCursor: encodeCursor({ updatedAt: last.updated_at, id: last.id }) } : {}),
    };
  }

  searchEntries(input: MemoryV6SearchInput): MemoryV6SearchResult {
    const limit = normalizeLimit(input.limit);
    const cursor = decodeCursor(input.cursor);
    const targetWhere = targetWhereSql("e", input.targets);
    const clauses = [`e.state = 'active'`, `(${targetWhere.sql})`];
    const params: SQLInputValue[] = [...targetWhere.params];
    const queryPlan = buildSearchQueryPlan(input.query);
    const queryTokens = uniqueSearchTokens(queryPlan);
    const isQuerySearch = queryTokens.length > 0;

    if (isQuerySearch) {
      const tokenClauses: string[] = [];
      for (const token of queryTokens) {
        tokenClauses.push(`
          instr(lower(e.title), ?) > 0
          OR instr(lower(e.preview), ?) > 0
          OR instr(lower(e.body), ?) > 0
          OR EXISTS (
            SELECT 1
            FROM memory_entry_tags_v6 AS t
            WHERE t.entry_id = e.id
              AND (
                instr(lower(t.tag_type), ?) > 0
                OR instr(lower(t.tag_value), ?) > 0
                OR instr(lower(t.tag_type_canonical), ?) > 0
                OR instr(lower(t.tag_value_canonical), ?) > 0
              )
          )
        `);
        params.push(token, token, token, token, token, token, token);
      }
      clauses.push(`(${tokenClauses.map((clause) => `(${clause})`).join(" OR ")})`);
    }

    if (input.kinds && input.kinds.length > 0) {
      clauses.push(`e.kind IN (${input.kinds.map(() => "?").join(", ")})`);
      params.push(...input.kinds);
    }

    for (const tag of input.tags ?? []) {
      clauses.push(`
        EXISTS (
          SELECT 1
          FROM memory_entry_tags_v6 AS filter_tag
          WHERE filter_tag.entry_id = e.id
            AND filter_tag.tag_type_canonical = ?
            AND filter_tag.tag_value_canonical = ?
        )
      `);
      params.push(tag.canonicalType, tag.canonicalValue);
    }

    if (cursor) {
      clauses.push(`(e.updated_at < ? OR (e.updated_at = ? AND e.id < ?))`);
      params.push(cursor.updatedAt, cursor.updatedAt, cursor.id);
    }

    const rows = this.db.prepare(`
      SELECT ${MEMORY_V6_ENTRY_SELECT_COLUMNS}
      FROM memory_entries_v6 AS e
      WHERE ${clauses.join(" AND ")}
      ORDER BY e.updated_at DESC, e.id DESC
      LIMIT ?
    `).all(...params, limit + 1) as MemoryV6EntryRow[];

    const scoredEntries: ScoredSearchEntry[] = [];
    for (const row of rows) {
      if (!hasValidTargetInvariant(row)) {
        continue;
      }
      const tags = this.getEntryTags(row.id);
      const entry = this.rowToEntry(row, tags);
      if (entry.state !== "active") {
        continue;
      }
      if (!isQuerySearch) {
        scoredEntries.push({ row, entry, match: { fields: [] } });
        continue;
      }
      const match = this.scoreSearchEntry(entry, queryPlan, tags);
      if (!match) {
        continue;
      }
      scoredEntries.push({ row, entry, match });
    }

    const pageEntries = scoredEntries.slice(0, limit);
    const lastRow = pageEntries[pageEntries.length - 1]?.row;
    return {
      items: pageEntries.map((item) => toMemorySearchHit(item.entry, item.match.fields.length > 0 ? item.match : undefined)),
      ...(scoredEntries.length > limit && lastRow ? { nextCursor: encodeCursor({ updatedAt: lastRow.updated_at, id: lastRow.id }) } : {}),
      ...(isQuerySearch && scoredEntries.length === 0 ? { relatedTags: this.relatedTags(input.targets, queryPlan) } : {}),
    };
  }

  searchEntriesForReview(input: MemoryV6ReviewSearchInput): MemoryV6ReviewSearchResult {
    const limit = normalizeLimit(input.limit);
    const cursor = decodeCursor(input.cursor);
    const clauses = [`e.state = 'active'`];
    const params: SQLInputValue[] = [];
    const query = input.query.trim().toLowerCase();

    if (query) {
      clauses.push(`
        (
          instr(lower(e.title), ?) > 0
          OR instr(lower(e.preview), ?) > 0
          OR instr(lower(e.body), ?) > 0
          OR instr(lower(e.owner_id), ?) > 0
          OR instr(lower(e.scope_id), ?) > 0
          OR EXISTS (
            SELECT 1
            FROM memory_entry_tags_v6 AS t
            WHERE t.entry_id = e.id
              AND (
                instr(lower(t.tag_type), ?) > 0
                OR instr(lower(t.tag_value), ?) > 0
              )
          )
        )
      `);
      params.push(query, query, query, query, query, query, query);
    }

    if (input.kinds && input.kinds.length > 0) {
      clauses.push(`e.kind IN (${input.kinds.map(() => "?").join(", ")})`);
      params.push(...input.kinds);
    }

    if (cursor) {
      clauses.push(`(e.updated_at < ? OR (e.updated_at = ? AND e.id < ?))`);
      params.push(cursor.updatedAt, cursor.updatedAt, cursor.id);
    }

    const rows = this.db.prepare(`
      SELECT ${MEMORY_V6_ENTRY_SELECT_COLUMNS}
      FROM memory_entries_v6 AS e
      WHERE ${clauses.join(" AND ")}
      ORDER BY e.updated_at DESC, e.id DESC
      LIMIT ?
    `).all(...params, limit + 1) as MemoryV6EntryRow[];

    const validRows = rows.filter((row) => hasValidTargetInvariant(row));
    const pageRows = validRows.slice(0, limit);
    const lastRow = pageRows[pageRows.length - 1];
    return {
      items: pageRows.map((row) => {
        const entry = this.rowToEntry(row);
        if (entry.state !== "active") {
          throw new Error(`Memory V6 review search returned inactive entry: ${entry.id}`);
        }
        const hit = toMemorySearchHit(entry);
        return {
          ...hit,
          sourceSessionId: entry.source.sessionId,
          sourceProviderId: entry.source.providerId,
        } satisfies MemoryV6ReviewSearchHit;
      }),
      ...(validRows.length > limit && lastRow ? { nextCursor: encodeCursor({ updatedAt: lastRow.updated_at, id: lastRow.id }) } : {}),
    };
  }

  getFileUsage(): MemoryV6FileUsage {
    const row = this.db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN state = 'active' THEN original_bytes ELSE 0 END), 0) AS used_bytes,
        COALESCE(SUM(CASE WHEN state IN ('active', 'delete_pending') THEN stored_bytes ELSE 0 END), 0) AS physical_bytes,
        COALESCE(SUM(CASE WHEN state = 'delete_pending' THEN stored_bytes ELSE 0 END), 0) AS pending_delete_bytes,
        COALESCE(SUM(CASE WHEN state = 'active' THEN 1 ELSE 0 END), 0) AS object_count,
        COALESCE(SUM(CASE WHEN state = 'delete_pending' THEN 1 ELSE 0 END), 0) AS pending_delete_count
      FROM memory_protected_objects_v6
    `).get() as {
      used_bytes?: number;
      physical_bytes?: number;
      pending_delete_bytes?: number;
      object_count?: number;
      pending_delete_count?: number;
    } | undefined;

    return {
      usedBytes: Number(row?.used_bytes ?? 0),
      physicalBytes: Number(row?.physical_bytes ?? 0),
      pendingDeleteBytes: Number(row?.pending_delete_bytes ?? 0),
      objectCount: Number(row?.object_count ?? 0),
      pendingDeleteCount: Number(row?.pending_delete_count ?? 0),
    };
  }

  listLargestFileEntries(input: { limit: number }): MemoryV6LargestFileEntry[] {
    const requestedLimit = Math.floor(input.limit);
    const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(50, requestedLimit)) : 20;
    const rows = this.db.prepare(`
      SELECT
        e.id AS entry_id,
        e.title AS title,
        e.preview AS preview,
        e.updated_at AS updated_at,
        COALESCE(SUM(o.original_bytes), 0) AS total_file_bytes,
        COUNT(o.object_id) AS file_count
      FROM memory_protected_objects_v6 AS o
      INNER JOIN memory_entries_v6 AS e ON e.id = o.entry_id
      WHERE o.state = 'active'
        AND e.state = 'active'
      GROUP BY e.id, e.title, e.preview, e.updated_at
      HAVING file_count > 0
      ORDER BY total_file_bytes DESC, e.updated_at DESC, e.id ASC
      LIMIT ?
    `).all(limit) as Array<{
      entry_id: string;
      title: string;
      preview: string;
      updated_at: string;
      total_file_bytes: number;
      file_count: number;
    }>;

    return rows.map((row) => ({
      entryId: row.entry_id,
      title: row.title,
      preview: row.preview,
      totalFileBytes: Number(row.total_file_bytes),
      fileCount: Number(row.file_count),
      updatedAt: row.updated_at,
    }));
  }

  getProtectedObjectForExport(input: {
    target: MemoryV6ResolvedTarget;
    objectId: string;
  }): MemoryV6ProtectedObjectExportMetadata | null {
    if (!PROTECTED_OBJECT_ID_PATTERN.test(input.objectId)) {
      return null;
    }
    const row = this.db.prepare(`
      SELECT
        o.object_id,
        o.entry_id,
        o.content_type,
        o.display_name,
        o.original_bytes,
        o.stored_bytes,
        o.sha256,
        o.key_id
      FROM memory_protected_objects_v6 AS o
      INNER JOIN memory_entries_v6 AS e ON e.id = o.entry_id
      WHERE o.object_id = ?
        AND o.state = 'active'
        AND e.state = 'active'
        AND e.owner_type = ?
        AND e.owner_id = ?
        AND e.scope_type = ?
        AND e.scope_id = ?
    `).get(
      input.objectId,
      input.target.owner.type,
      input.target.owner.id,
      input.target.scope.type,
      input.target.scope.id,
    ) as MemoryV6ProtectedObjectExportRow | undefined;

    if (!row) {
      return null;
    }
    return {
      objectId: row.object_id,
      entryId: row.entry_id,
      contentType: row.content_type,
      displayName: row.display_name,
      originalBytes: Number(row.original_bytes),
      storedBytes: Number(row.stored_bytes),
      sha256: row.sha256,
      keyId: row.key_id,
    };
  }

  listProtectedObjectsForEntryExport(input: {
    target: MemoryV6ResolvedTarget;
    entryId: string;
  }): MemoryV6ProtectedObjectExportMetadata[] | null {
    const entryRow = this.getEntryRow(input.entryId);
    if (!entryRow || entryRow.state !== "active" || !this.rowMatchesTarget(entryRow, input.target)) {
      return null;
    }

    const rows = this.db.prepare(`
      SELECT
        object_id,
        entry_id,
        content_type,
        display_name,
        original_bytes,
        stored_bytes,
        sha256,
        key_id
      FROM memory_protected_objects_v6
      WHERE entry_id = ?
        AND state = 'active'
      ORDER BY created_at ASC, object_id ASC
    `).all(input.entryId) as MemoryV6ProtectedObjectExportRow[];

    return rows.map((row) => ({
      objectId: row.object_id,
      entryId: row.entry_id,
      contentType: row.content_type,
      displayName: row.display_name,
      originalBytes: Number(row.original_bytes),
      storedBytes: Number(row.stored_bytes),
      sha256: row.sha256,
      keyId: row.key_id,
    }));
  }

  listDeletePendingProtectedObjectsForGc(input: { limit: number }): MemoryV6ProtectedObjectGcCandidate[] {
    const requestedLimit = Math.floor(input.limit);
    const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(500, requestedLimit)) : 100;
    const rows = this.db.prepare(`
      SELECT object_id, stored_bytes, updated_at
      FROM memory_protected_objects_v6
      WHERE state = 'delete_pending'
      ORDER BY updated_at ASC, object_id ASC
      LIMIT ?
    `).all(limit) as Array<{
      object_id: string;
      stored_bytes: number;
      updated_at: string;
    }>;

    return rows.map((row) => ({
      objectId: row.object_id,
      storedBytes: Number(row.stored_bytes),
      updatedAt: row.updated_at,
    }));
  }

  listProtectedObjectIdsForGc(input: { states: readonly ("active" | "delete_pending")[] }): string[] {
    const states = input.states.filter((state) => state === "active" || state === "delete_pending");
    if (states.length === 0) {
      return [];
    }
    const placeholders = states.map(() => "?").join(", ");
    const rows = this.db.prepare(`
      SELECT object_id
      FROM memory_protected_objects_v6
      WHERE state IN (${placeholders})
      ORDER BY object_id ASC
    `).all(...states) as Array<{ object_id: string }>;
    return rows.map((row) => row.object_id);
  }

  markProtectedObjectDeletedForGc(input: { objectId: string; deletedAt?: string }): boolean {
    const deletedAt = input.deletedAt ?? nowIso();
    const result = this.db.prepare(`
      UPDATE memory_protected_objects_v6
      SET state = 'deleted',
          updated_at = ?,
          deleted_at = ?
      WHERE object_id = ?
        AND state = 'delete_pending'
    `).run(deletedAt, deletedAt, input.objectId);
    return result.changes > 0;
  }

  private scoreSearchEntry(
    entry: ActiveMemoryEntryDetail,
    queryPlan: SearchQueryPlan,
    tags: readonly NormalizedMemoryTag[],
  ): MemorySearchMatch | null {
    const normalizedTitle = normalizeSearchText(entry.title);
    const normalizedPreview = normalizeSearchText(entry.preview);
    const normalizedBody = normalizeSearchText(entry.body);
    const normalizedTags = normalizeSearchText(tags.map((tag) => tagSearchText(tag)).join(" "));
    const fields: MemorySearchMatchField[] = [];
    let score = 0;

    const titleScore = scoreNormalizedText(normalizedTitle, queryPlan, 6);
    if (titleScore > 0) {
      fields.push("title");
      score += titleScore;
    }

    const previewScore = scoreNormalizedText(normalizedPreview, queryPlan, 4);
    if (previewScore > 0) {
      fields.push("preview");
      score += previewScore;
    }

    const bodyScore = scoreNormalizedText(normalizedBody, queryPlan, 2);
    if (bodyScore > 0) {
      fields.push("body");
      score += bodyScore;
    }

    const tagScore = scoreNormalizedText(normalizedTags, queryPlan, 8);
    if (tagScore > 0) {
      fields.push("tags");
      score += tagScore;
    }

    if (score === 0) {
      return null;
    }

    const snippet = tagSnippet(tags, queryPlan)
      ?? buildSnippet(entry.title, queryPlan)
      ?? buildSnippet(entry.preview, queryPlan);

    return {
      fields,
      ...(snippet ? { snippet } : {}),
    };
  }

  private relatedTags(targets: readonly MemoryV6ResolvedTarget[], queryPlan: SearchQueryPlan): NormalizedMemoryTag[] {
    return this.listTags(targets)
      .map((tag) => ({ tag, score: scoreNormalizedText(tagSearchText(tag), queryPlan, 1) }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || left.tag.canonicalValue.localeCompare(right.tag.canonicalValue))
      .slice(0, 5)
      .map((item) => item.tag);
  }

  listTags(targets: readonly MemoryV6ResolvedTarget[]): NormalizedMemoryTag[] {
    const targetWhere = targetWhereSql("e", targets);
    const rows = this.db.prepare(`
      SELECT
        t.tag_type,
        t.tag_value,
        t.tag_type_canonical,
        t.tag_value_canonical,
        COUNT(*) AS active_usage_count,
        MAX(e.updated_at) AS latest_entry_updated_at
      FROM memory_entry_tags_v6 AS t
      INNER JOIN memory_entries_v6 AS e ON e.id = t.entry_id
      WHERE e.state = 'active'
        AND (${targetWhere.sql})
      GROUP BY t.tag_type_canonical, t.tag_value_canonical
      ORDER BY active_usage_count DESC, latest_entry_updated_at DESC, t.tag_type_canonical ASC, t.tag_value_canonical ASC
    `).all(...targetWhere.params) as Array<MemoryV6TagRow & { active_usage_count: number; latest_entry_updated_at: string }>;

    return rows.map((row) => ({
      type: row.tag_type,
      value: row.tag_value,
      canonicalType: row.tag_type_canonical,
      canonicalValue: row.tag_value_canonical,
    }));
  }

  private listTargetTagStatsRows(
    target: MemoryV6ResolvedTarget,
    cursor: MemoryListTagsCursor | null,
    rowLimit: number,
  ): Array<MemoryV6TagRow & { active_usage_count: number; latest_entry_updated_at: string }> {
    const columns = `
      s.tag_type,
      s.tag_value,
      s.tag_type_canonical,
      s.tag_value_canonical,
      s.usage_count AS active_usage_count,
      s.latest_entry_updated_at
    `;
    const targetPredicate = `
      s.owner_type = ?
      AND s.owner_id = ?
      AND s.scope_type = ?
      AND s.scope_id = ?
    `;
    const order = "s.usage_count DESC, s.latest_entry_updated_at DESC, s.tag_type_canonical ASC, s.tag_value_canonical ASC";
    const targetParams = [target.owner.type, target.owner.id, target.scope.type, target.scope.id];
    if (!cursor) {
      return this.db.prepare(`
        SELECT ${columns}
        FROM memory_target_tag_stats_v6 AS s
        WHERE ${targetPredicate}
        ORDER BY ${order}
        LIMIT ?
      `).all(...targetParams, rowLimit) as Array<MemoryV6TagRow & { active_usage_count: number; latest_entry_updated_at: string }>;
    }

    // Each branch starts at one concrete index range and is independently capped.
    // The outer merge therefore sorts at most four bounded pages instead of scanning
    // every tag preceding a deep cursor through a multi-column OR predicate.
    return this.db.prepare(`
      WITH candidates AS (
        SELECT * FROM (
          SELECT ${columns}
          FROM memory_target_tag_stats_v6 AS s
          WHERE ${targetPredicate} AND s.usage_count < ?
          ORDER BY ${order}
          LIMIT ?
        )
        UNION ALL
        SELECT * FROM (
          SELECT ${columns}
          FROM memory_target_tag_stats_v6 AS s
          WHERE ${targetPredicate}
            AND s.usage_count = ?
            AND s.latest_entry_updated_at < ?
          ORDER BY ${order}
          LIMIT ?
        )
        UNION ALL
        SELECT * FROM (
          SELECT ${columns}
          FROM memory_target_tag_stats_v6 AS s
          WHERE ${targetPredicate}
            AND s.usage_count = ?
            AND s.latest_entry_updated_at = ?
            AND s.tag_type_canonical > ?
          ORDER BY ${order}
          LIMIT ?
        )
        UNION ALL
        SELECT * FROM (
          SELECT ${columns}
          FROM memory_target_tag_stats_v6 AS s
          WHERE ${targetPredicate}
            AND s.usage_count = ?
            AND s.latest_entry_updated_at = ?
            AND s.tag_type_canonical = ?
            AND s.tag_value_canonical > ?
          ORDER BY ${order}
          LIMIT ?
        )
      )
      SELECT *
      FROM candidates
      ORDER BY active_usage_count DESC, latest_entry_updated_at DESC, tag_type_canonical ASC, tag_value_canonical ASC
      LIMIT ?
    `).all(
      ...targetParams, cursor.usageCount, rowLimit,
      ...targetParams, cursor.usageCount, cursor.latestUpdatedAt, rowLimit,
      ...targetParams, cursor.usageCount, cursor.latestUpdatedAt, cursor.canonicalType, rowLimit,
      ...targetParams, cursor.usageCount, cursor.latestUpdatedAt, cursor.canonicalType, cursor.canonicalValue, rowLimit,
      rowLimit,
    ) as Array<MemoryV6TagRow & { active_usage_count: number; latest_entry_updated_at: string }>;
  }

  listTagsPage(
    targets: readonly MemoryV6ResolvedTarget[],
    options: { limit?: number; cursor?: string } = {},
  ): MemoryV6ListTagsResult<NormalizedMemoryTag> {
    if (targets.length !== 1) {
      throw new Error("Memory V6 list-tags page requires exactly one target.");
    }
    const target = targets[0]!;
    const limit = normalizeMaintenanceLimit(options.limit);
    const cursor = options.cursor ? decodeMemoryListTagsCursor(options.cursor) : null;
    if (options.cursor && !cursor) {
      throw new Error("Memory V6 list-tags cursor is invalid.");
    }
    const rows = this.listTargetTagStatsRows(target, cursor, limit + 1);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => ({
        type: row.tag_type,
        value: row.tag_value,
        canonicalType: row.tag_type_canonical,
        canonicalValue: row.tag_value_canonical,
      })),
      ...(rows.length > limit && last ? {
        nextCursor: encodeMemoryListTagsCursor({
          usageCount: Number(last.active_usage_count),
          latestUpdatedAt: last.latest_entry_updated_at,
          canonicalType: last.tag_type_canonical,
          canonicalValue: last.tag_value_canonical,
        }),
      } : {}),
    };
  }

  listTagStatistics(targets: readonly MemoryV6ResolvedTarget[], sampleLimit = 0): MemoryV6TagStatistic[] {
    const targetWhere = targetWhereSql("e", targets);
    const rows = this.db.prepare(`
      SELECT
        t.tag_type,
        t.tag_value,
        t.tag_type_canonical,
        t.tag_value_canonical,
        COUNT(*) AS active_usage_count,
        MAX(e.updated_at) AS latest_entry_updated_at
      FROM memory_entry_tags_v6 AS t
      INNER JOIN memory_entries_v6 AS e ON e.id = t.entry_id
      WHERE e.state = 'active'
        AND (${targetWhere.sql})
      GROUP BY t.tag_type_canonical, t.tag_value_canonical
      ORDER BY active_usage_count DESC, latest_entry_updated_at DESC, t.tag_type_canonical ASC, t.tag_value_canonical ASC
    `).all(...targetWhere.params) as Array<MemoryV6TagRow & { active_usage_count: number; latest_entry_updated_at: string }>;
    return rows.map((row) => {
      const samples = sampleLimit <= 0 ? [] : this.db.prepare(`
        SELECT e.id, e.title
        FROM memory_entry_tags_v6 AS t
        INNER JOIN memory_entries_v6 AS e ON e.id = t.entry_id
        WHERE e.state = 'active'
          AND (${targetWhere.sql})
          AND t.tag_type_canonical = ?
          AND t.tag_value_canonical = ?
        ORDER BY e.updated_at DESC, e.id DESC
        LIMIT ?
      `).all(...targetWhere.params, row.tag_type_canonical, row.tag_value_canonical, sampleLimit) as Array<{ id: string; title: string }>;
      return {
        type: row.tag_type,
        value: row.tag_value,
        canonicalType: row.tag_type_canonical,
        canonicalValue: row.tag_value_canonical,
        entryCount: Number(row.active_usage_count),
        latestUpdatedAt: row.latest_entry_updated_at,
        samples,
      };
    });
  }

  listTagStatisticsPage(
    targets: readonly MemoryV6ResolvedTarget[],
    options: { sampleLimit?: number; limit?: number; cursor?: string } = {},
  ): MemoryV6ListTagsResult<MemoryV6TagStatistic> {
    if (targets.length !== 1) {
      throw new Error("Memory V6 list-tags statistics page requires exactly one target.");
    }
    const target = targets[0]!;
    const limit = normalizeMaintenanceLimit(options.limit);
    const sampleLimit = options.sampleLimit ?? 0;
    const cursor = options.cursor ? decodeMemoryListTagsCursor(options.cursor) : null;
    if (options.cursor && !cursor) {
      throw new Error("Memory V6 list-tags cursor is invalid.");
    }
    const rows = this.listTargetTagStatsRows(target, cursor, limit + 1);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => {
        const samples = sampleLimit <= 0 ? [] : this.db.prepare(`
          SELECT e.id, e.title
          FROM memory_entry_tags_v6 AS t
          INNER JOIN memory_entries_v6 AS e ON e.id = t.entry_id
          WHERE e.state = 'active'
            AND e.owner_type = ?
            AND e.owner_id = ?
            AND e.scope_type = ?
            AND e.scope_id = ?
            AND t.tag_type_canonical = ?
            AND t.tag_value_canonical = ?
          ORDER BY e.updated_at DESC, e.id DESC
          LIMIT ?
        `).all(
          target.owner.type,
          target.owner.id,
          target.scope.type,
          target.scope.id,
          row.tag_type_canonical,
          row.tag_value_canonical,
          sampleLimit,
        ) as Array<{ id: string; title: string }>;
        return {
          type: row.tag_type,
          value: row.tag_value,
          canonicalType: row.tag_type_canonical,
          canonicalValue: row.tag_value_canonical,
          entryCount: Number(row.active_usage_count),
          latestUpdatedAt: row.latest_entry_updated_at,
          samples,
        };
      }),
      ...(rows.length > limit && last ? {
        nextCursor: encodeMemoryListTagsCursor({
          usageCount: Number(last.active_usage_count),
          latestUpdatedAt: last.latest_entry_updated_at,
          canonicalType: last.tag_type_canonical,
          canonicalValue: last.tag_value_canonical,
        }),
      } : {}),
    };
  }

  previewForgetEntries(input: Pick<ForgetMemoryEntriesInput, "target" | "entryIds" | "reason" | "idempotencyKey" | "bindingIdHash" | "requestFingerprint" | "sourceMessageId">): MemoryV6ForgetPreviewResult[] {
    if (input.idempotencyKey) {
      const replay = this.resolveForgetIdempotency(
        input.target,
        input.idempotencyKey,
        input.bindingIdHash ?? "",
        input.requestFingerprint ?? buildForgetFingerprint(input),
      );
      if (replay) {
        return replay.map((result) => {
          const row = this.getEntryRow(result.entryId);
          return {
            ...result,
            ...(result.status !== "not_found" && row && this.rowMatchesTarget(row, input.target)
              ? { entry: this.rowToEntry(row) }
              : {}),
            ...(result.status === "not_found" ? { warning: "target_mismatch_or_not_found" as const } : {}),
          };
        });
      }
    }
    return uniqueIds(input.entryIds).map((entryId) => {
      const row = this.getEntryRow(entryId);
      if (!row || !this.rowMatchesTarget(row, input.target)) {
        return { entryId, status: "not_found", warning: "target_mismatch_or_not_found" };
      }
      return {
        entryId,
        status: row.state === "forgotten" ? "already_forgotten" : "forgotten",
        entry: this.rowToEntry(row),
      };
    });
  }

  forgetEntries(input: ForgetMemoryEntriesInput): MemoryV6ForgetResult[] {
    const entryIds = uniqueIds(input.entryIds);
    const updatedAt = input.now ?? nowIso();
    const reason = input.reason ?? "user_request";
    const bindingIdHash = input.bindingIdHash ?? "";
    const requestFingerprint = input.requestFingerprint ?? buildForgetFingerprint(input);

    return this.transaction(() => {
      if (input.idempotencyKey) {
        const replay = this.resolveForgetIdempotency(input.target, input.idempotencyKey, bindingIdHash, requestFingerprint);
        if (replay) {
          return replay;
        }
      }

      const results: MemoryV6ForgetResult[] = entryIds.map((entryId) => {
        const row = this.getEntryRow(entryId);
        if (!row || !this.rowMatchesTarget(row, input.target)) {
          this.insertMutationEvent("forget", null, bindingIdHash, input.sessionId ?? null, "not_found", reason, updatedAt, input.sourceMessageId ?? null);
          return { entryId, status: "not_found" };
        }
        if (row.state === "forgotten") {
          if (reason === "privacy") {
            this.redactForgottenEntryForPrivacy(entryId, updatedAt);
          }
          this.markProtectedObjectsDeletePendingForEntry(entryId, updatedAt, { redactMetadata: reason === "privacy" });
          this.insertMutationEvent("forget", entryId, bindingIdHash, input.sessionId ?? row.source_session_id, "already_forgotten", reason, updatedAt, input.sourceMessageId ?? null);
          return { entryId, status: "already_forgotten" };
        }

        const previousTags = row.state === "active" ? this.getEntryTags(entryId) : [];
        const nextBody = reason === "privacy" ? "" : row.body;
        const nextTitle = reason === "privacy" ? "" : row.title;
        const nextPreview = reason === "privacy" ? "" : row.preview;
        this.db.prepare(`
          UPDATE memory_entries_v6
          SET state = 'forgotten',
              title = ?,
              body = ?,
              body_sha256 = ?,
              preview = ?,
              updated_at = ?,
              forgotten_at = ?
          WHERE id = ?
        `).run(nextTitle, nextBody, sha256Hex(nextBody), nextPreview, updatedAt, updatedAt, entryId);

        if (previousTags.length > 0) {
          this.decrementTagCatalog(previousTags);
          this.refreshTargetTagStats(input.target, previousTags);
        }
        if (reason === "privacy") {
          this.db.prepare("DELETE FROM memory_entry_tags_v6 WHERE entry_id = ?").run(entryId);
        }
        this.markProtectedObjectsDeletePendingForEntry(entryId, updatedAt, { redactMetadata: reason === "privacy" });
        this.insertMutationEvent("forget", entryId, bindingIdHash, input.sessionId ?? row.source_session_id, "success", reason, updatedAt, input.sourceMessageId ?? null);
        return { entryId, status: "forgotten" };
      });

      if (input.idempotencyKey) {
        this.insertIdempotencyKey({
          key: input.idempotencyKey,
          operation: "forget",
          bindingIdHash,
          target: input.target,
          responseEntryId: null,
          operationCreated: results.some((result) => result.status === "forgotten"),
          requestFingerprint,
          createdAt: updatedAt,
        });
        for (const result of results) {
          this.db.prepare(`
            INSERT INTO memory_idempotency_forget_results_v6 (
              key,
              operation,
              binding_id_hash,
              owner_type,
              owner_id,
              scope_type,
              scope_id,
              entry_id,
              result_status,
              created_at
            ) VALUES (?, 'forget', ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            input.idempotencyKey,
            bindingIdHash,
            input.target.owner.type,
            input.target.owner.id,
            input.target.scope.type,
            input.target.scope.id,
            result.entryId,
            result.status,
            updatedAt,
          );
        }
      }

      return results;
    });
  }

  moveEntry(input: MemoryV6MoveEntryInput): MemoryV6MoveEntryResult {
    const movedAt = input.now ?? nowIso();
    const bindingIdHash = input.bindingIdHash ?? "";
    if (!isSupportedResolvedTarget(input.from) || !isSupportedResolvedTarget(input.to) || targetKey(input.from) === targetKey(input.to)) {
      throw new MemoryV6EntryNotFoundError(input.entryId);
    }

    return this.transaction(() => {
      if (input.idempotencyKey) {
        const replay = this.db.prepare(`
          SELECT entry_id, request_fingerprint
          FROM memory_move_events_v6
          WHERE binding_id_hash = ?
            AND idempotency_key = ?
        `).get(bindingIdHash, input.idempotencyKey) as { entry_id: string; request_fingerprint: string } | undefined;
        if (replay) {
          if (replay.request_fingerprint !== input.requestFingerprint) {
            throw new MemoryV6IdempotencyConflictError();
          }
          const replayedEntry = this.getEntry(replay.entry_id);
          if (!replayedEntry || replayedEntry.state !== "active" || !this.rowMatchesTarget(this.getEntryRow(replay.entry_id)!, input.to)) {
            throw new MemoryV6EntryNotFoundError(replay.entry_id);
          }
          return { entry: replayedEntry, moved: true, replayed: true };
        }
      }

      const row = this.getEntryRow(input.entryId);
      if (!row || row.state !== "active" || !this.rowMatchesTarget(row, input.from)) {
        throw new MemoryV6EntryNotFoundError(input.entryId);
      }
      this.admitProjectScopes(input.projectScopeAdmissions ?? [], movedAt);
      const movedTags = this.getEntryTags(input.entryId);
      this.db.prepare(`
        UPDATE memory_entries_v6
        SET owner_type = ?,
            owner_id = ?,
            scope_type = ?,
            scope_id = ?,
            updated_at = ?
        WHERE id = ?
          AND state = 'active'
      `).run(input.to.owner.type, input.to.owner.id, input.to.scope.type, input.to.scope.id, movedAt, input.entryId);
      this.refreshTargetTagStats(input.from, movedTags);
      this.incrementTargetTagStats(input.to, movedTags, movedAt);
      this.db.prepare(`
        INSERT INTO memory_move_events_v6 (
          id,
          entry_id,
          from_owner_type,
          from_owner_id,
          from_scope_type,
          from_scope_id,
          to_owner_type,
          to_owner_id,
          to_scope_type,
          to_scope_id,
          binding_id_hash,
          idempotency_key,
          request_fingerprint,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        `memory-move-${randomUUID()}`,
        input.entryId,
        input.from.owner.type,
        input.from.owner.id,
        input.from.scope.type,
        input.from.scope.id,
        input.to.owner.type,
        input.to.owner.id,
        input.to.scope.type,
        input.to.scope.id,
        bindingIdHash,
        input.idempotencyKey ?? null,
        input.requestFingerprint,
        movedAt,
      );
      const entry = this.getEntry(input.entryId);
      if (!entry || entry.state !== "active") {
        throw new MemoryV6EntryNotFoundError(input.entryId);
      }
      return { entry, moved: true };
    });
  }

  private admitProjectScopes(
    admissions: readonly MemoryV6ProjectScopeAdmission[],
    admittedAt: string,
  ): void {
    for (const admission of admissions) {
      this.db.prepare(`
        INSERT INTO project_scopes_v6 (
          id,
          project_type,
          project_key,
          workspace_path,
          git_root,
          git_remote_url,
          display_name,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_type, project_key) DO UPDATE SET
          workspace_path = excluded.workspace_path,
          git_root = excluded.git_root,
          git_remote_url = excluded.git_remote_url,
          display_name = excluded.display_name,
          updated_at = excluded.updated_at
      `).run(
        admission.id,
        admission.projectType,
        admission.projectKey,
        admission.workspacePath,
        admission.gitRoot ?? "",
        admission.gitRemoteUrl ?? "",
        admission.displayName,
        admittedAt,
        admittedAt,
      );
    }
  }

  private markProtectedObjectsDeletePendingForEntry(
    entryId: string,
    updatedAt: string,
    options: { redactMetadata?: boolean } = {},
  ): void {
    this.db.prepare(`
      UPDATE memory_protected_objects_v6
      SET state = 'delete_pending',
          summary = CASE WHEN ? THEN '' ELSE summary END,
          display_name = CASE WHEN ? THEN '' ELSE display_name END,
          updated_at = ?,
          deleted_at = NULL
      WHERE entry_id = ?
        AND state = 'active'
    `).run(options.redactMetadata ? 1 : 0, options.redactMetadata ? 1 : 0, updatedAt, entryId);
  }

  private assertProtectedObjectQuota(
    protectedObjects: readonly MemoryV6AppendProtectedObjectInput[],
    fileQuotaBytes: number | undefined,
  ): void {
    if (protectedObjects.length === 0 || fileQuotaBytes === undefined) {
      return;
    }
    const usage = this.getFileUsage();
    const incomingBytes = protectedObjects.reduce((total, object) => total + object.originalBytes, 0);
    if (usage.usedBytes + incomingBytes > fileQuotaBytes) {
      throw new MemoryV6FileQuotaExceededError(fileQuotaBytes, usage.usedBytes, incomingBytes);
    }
  }

  private insertProtectedObjects(
    entryId: string,
    protectedObjects: readonly MemoryV6AppendProtectedObjectInput[],
    createdAt: string,
  ): void {
    for (const object of protectedObjects) {
      this.db.prepare(`
        INSERT INTO memory_protected_objects_v6 (
          object_id,
          entry_id,
          state,
          role,
          media_kind,
          content_type,
          display_name,
          summary,
          original_bytes,
          stored_bytes,
          sha256,
          key_id,
          created_at,
          updated_at,
          deleted_at
        ) VALUES (?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      `).run(
        object.objectId,
        entryId,
        object.role,
        object.mediaKind,
        object.contentType ?? "",
        object.displayName ?? "",
        object.summary,
        object.originalBytes,
        object.storedBytes,
        object.sha256,
        object.keyId,
        createdAt,
        createdAt,
      );
    }
  }

  forgetEntryForReview(input: MemoryV6ReviewForgetInput): MemoryV6ReviewForgetResult {
    const row = this.getEntryRow(input.entryId);
    const reason = input.reason ?? "user_request";
    if (!row || row.state !== "active") {
      return { entryId: input.entryId, status: "not_found", reason };
    }

    const [result] = this.forgetEntries({
      target: { owner: ownerRef(row), scope: scopeRef(row) },
      entryIds: [input.entryId],
      reason,
      bindingIdHash: "",
      sessionId: row.source_session_id,
      now: input.now,
    });
    return {
      entryId: input.entryId,
      status: result?.status ?? "not_found",
      reason,
    };
  }

  private redactForgottenEntryForPrivacy(entryId: string, updatedAt: string): void {
    this.db.prepare(`
      UPDATE memory_entries_v6
      SET title = '',
          body = '',
          body_sha256 = ?,
          preview = '',
          updated_at = ?
      WHERE id = ?
        AND state = 'forgotten'
    `).run(sha256Hex(""), updatedAt, entryId);
    this.db.prepare("DELETE FROM memory_entry_tags_v6 WHERE entry_id = ?").run(entryId);
  }

  close(): void {
    this.db.close();
  }

  private transaction<T>(runner: () => T): T {
    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      const result = runner();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private getEntryRow(entryId: string): MemoryV6EntryRow | null {
    const row = this.db.prepare(`
      SELECT ${MEMORY_V6_ENTRY_SELECT_COLUMNS}
      FROM memory_entries_v6
      WHERE id = ?
    `).get(entryId) as MemoryV6EntryRow | undefined;
    return row && hasValidTargetInvariant(row) ? row : null;
  }

  private rowMatchesTarget(row: MemoryV6EntryRow, target: MemoryV6ResolvedTarget): boolean {
    return hasValidTargetInvariant(row) && targetKey({ owner: ownerRef(row), scope: scopeRef(row) }) === targetKey(target);
  }

  private rowToEntry(row: MemoryV6EntryRow, tags = this.getEntryTags(row.id)): MemoryEntryDetail {
    const files = row.state === "active" ? this.getEntryFileSummaries(row.id) : [];
    const base = {
      id: row.id,
      owner: ownerRef(row),
      scope: scopeRef(row),
      kind: row.kind as MemoryEntryKind,
      title: row.title,
      body: row.body,
      preview: row.preview,
      tags: tags.map((tag) => ({ type: tag.type, value: tag.value })),
      source: {
        type: row.source_type,
        sessionId: row.source_session_id,
        messageId: row.source_provider_message_id ?? (row.source_app_message_id === null ? null : String(row.source_app_message_id)),
        providerId: row.source_provider_id,
      },
      supersedes: this.getSupersedes(row.id),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(files.length > 0 ? { files } : {}),
    };

    if (row.state === "active") {
      return {
        ...base,
        state: "active",
        supersededBy: null,
        forgottenAt: null,
      };
    }

    if (row.state === "superseded") {
      if (!row.superseded_by_id) {
        throw new Error(`Memory V6 superseded entry is missing superseded_by_id: ${row.id}`);
      }
      return {
        ...base,
        state: "superseded",
        supersededBy: row.superseded_by_id,
        forgottenAt: null,
      };
    }

    return {
      ...base,
      state: "forgotten",
      supersededBy: row.superseded_by_id,
      forgottenAt: row.forgotten_at ?? row.updated_at,
    };
  }

  private getEntryFileSummaries(entryId: string): MemoryFileSummary[] {
    const rows = this.db.prepare(`
      SELECT
        object_id,
        role,
        media_kind,
        content_type,
        display_name,
        summary,
        original_bytes
      FROM memory_protected_objects_v6
      WHERE entry_id = ?
        AND state = 'active'
      ORDER BY created_at ASC, object_id ASC
    `).all(entryId) as MemoryV6ProtectedObjectSummaryRow[];

    return rows.map((row) => ({
      objectId: row.object_id,
      role: row.role,
      mediaKind: row.media_kind,
      contentType: row.content_type,
      displayName: row.display_name,
      summary: row.summary,
      originalBytes: Number(row.original_bytes),
    }));
  }

  private getEntryTags(entryId: string): NormalizedMemoryTag[] {
    const rows = this.db.prepare(`
      SELECT
        tag_type,
        tag_value,
        tag_type_canonical,
        tag_value_canonical
      FROM memory_entry_tags_v6
      WHERE entry_id = ?
      ORDER BY created_at ASC, tag_type_canonical ASC, tag_value_canonical ASC
    `).all(entryId) as MemoryV6TagRow[];

    return rows.map((row) => ({
      type: row.tag_type,
      value: row.tag_value,
      canonicalType: row.tag_type_canonical,
      canonicalValue: row.tag_value_canonical,
    }));
  }

  private getSupersedes(entryId: string): string[] {
    const rows = this.db.prepare(`
      SELECT target_entry_id
      FROM memory_entry_relations_v6
      WHERE source_entry_id = ?
        AND relation_type = 'supersedes'
      ORDER BY created_at ASC, target_entry_id ASC
    `).all(entryId) as Array<{ target_entry_id: string }>;
    return rows.map((row) => row.target_entry_id);
  }

  private replaceTags(entryId: string, tags: readonly NormalizedMemoryTag[], createdAt: string): void {
    this.db.prepare("DELETE FROM memory_entry_tags_v6 WHERE entry_id = ?").run(entryId);
    const uniqueTags = new Map<string, NormalizedMemoryTag>();
    for (const tag of tags) {
      if (!uniqueTags.has(tagIdentityKey(tag))) {
        uniqueTags.set(tagIdentityKey(tag), tag);
      }
    }
    for (const tag of uniqueTags.values()) {
      this.db.prepare(`
        INSERT INTO memory_entry_tags_v6 (
          entry_id,
          tag_type,
          tag_value,
          tag_type_canonical,
          tag_value_canonical,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(entryId, tag.type, tag.value, tag.canonicalType, tag.canonicalValue, createdAt);
    }
  }

  private incrementTagCatalog(tags: readonly NormalizedMemoryTag[], updatedAt: string): void {
    const uniqueTags = new Map<string, NormalizedMemoryTag>();
    for (const tag of tags) {
      if (!uniqueTags.has(tagIdentityKey(tag))) {
        uniqueTags.set(tagIdentityKey(tag), tag);
      }
    }
    for (const tag of uniqueTags.values()) {
      this.db.prepare(`
        INSERT INTO memory_tag_catalog_v6 (
          tag_type,
          tag_value,
          tag_type_canonical,
          tag_value_canonical,
          state,
          usage_count,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, 'active', 1, ?, ?)
        ON CONFLICT(tag_type_canonical, tag_value_canonical) DO UPDATE SET
          tag_type = excluded.tag_type,
          tag_value = excluded.tag_value,
          state = 'active',
          usage_count = usage_count + 1,
          updated_at = excluded.updated_at
      `).run(tag.type, tag.value, tag.canonicalType, tag.canonicalValue, updatedAt, updatedAt);
    }
  }

  private decrementTagCatalog(tags: readonly NormalizedMemoryTag[]): void {
    const uniqueTags = new Map<string, NormalizedMemoryTag>();
    for (const tag of tags) {
      if (!uniqueTags.has(tagIdentityKey(tag))) {
        uniqueTags.set(tagIdentityKey(tag), tag);
      }
    }
    for (const tag of uniqueTags.values()) {
      this.db.prepare(`
        UPDATE memory_tag_catalog_v6
        SET usage_count = CASE WHEN usage_count > 0 THEN usage_count - 1 ELSE 0 END,
            updated_at = updated_at
        WHERE tag_type_canonical = ?
          AND tag_value_canonical = ?
      `).run(tag.canonicalType, tag.canonicalValue);
    }
  }

  private incrementTargetTagStats(
    target: MemoryV6ResolvedTarget,
    tags: readonly NormalizedMemoryTag[],
    updatedAt: string,
  ): void {
    const uniqueTags = new Map<string, NormalizedMemoryTag>();
    for (const tag of tags) {
      if (!uniqueTags.has(tagIdentityKey(tag))) {
        uniqueTags.set(tagIdentityKey(tag), tag);
      }
    }
    for (const tag of uniqueTags.values()) {
      this.db.prepare(`
        INSERT INTO memory_target_tag_stats_v6 (
          owner_type,
          owner_id,
          scope_type,
          scope_id,
          tag_type,
          tag_value,
          tag_type_canonical,
          tag_value_canonical,
          usage_count,
          latest_entry_updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
        ON CONFLICT(owner_type, owner_id, scope_type, scope_id, tag_type_canonical, tag_value_canonical) DO UPDATE SET
          tag_type = excluded.tag_type,
          tag_value = excluded.tag_value,
          usage_count = usage_count + 1,
          latest_entry_updated_at = MAX(latest_entry_updated_at, excluded.latest_entry_updated_at)
      `).run(
        target.owner.type,
        target.owner.id,
        target.scope.type,
        target.scope.id,
        tag.type,
        tag.value,
        tag.canonicalType,
        tag.canonicalValue,
        updatedAt,
      );
    }
  }

  private refreshTargetTagStats(target: MemoryV6ResolvedTarget, tags: readonly NormalizedMemoryTag[]): void {
    const uniqueTags = new Map<string, NormalizedMemoryTag>();
    for (const tag of tags) {
      if (!uniqueTags.has(tagIdentityKey(tag))) {
        uniqueTags.set(tagIdentityKey(tag), tag);
      }
    }
    for (const tag of uniqueTags.values()) {
      const remaining = this.db.prepare(`
        SELECT COUNT(*) AS usage_count, MAX(e.updated_at) AS latest_entry_updated_at
        FROM memory_entry_tags_v6 AS t
        INNER JOIN memory_entries_v6 AS e ON e.id = t.entry_id
        WHERE e.state = 'active'
          AND e.owner_type = ?
          AND e.owner_id = ?
          AND e.scope_type = ?
          AND e.scope_id = ?
          AND t.tag_type_canonical = ?
          AND t.tag_value_canonical = ?
      `).get(
        target.owner.type,
        target.owner.id,
        target.scope.type,
        target.scope.id,
        tag.canonicalType,
        tag.canonicalValue,
      ) as { usage_count: number; latest_entry_updated_at: string | null };
      if (Number(remaining.usage_count) === 0 || !remaining.latest_entry_updated_at) {
        this.db.prepare(`
          DELETE FROM memory_target_tag_stats_v6
          WHERE owner_type = ?
            AND owner_id = ?
            AND scope_type = ?
            AND scope_id = ?
            AND tag_type_canonical = ?
            AND tag_value_canonical = ?
        `).run(
          target.owner.type,
          target.owner.id,
          target.scope.type,
          target.scope.id,
          tag.canonicalType,
          tag.canonicalValue,
        );
        continue;
      }
      this.db.prepare(`
        INSERT INTO memory_target_tag_stats_v6 (
          owner_type,
          owner_id,
          scope_type,
          scope_id,
          tag_type,
          tag_value,
          tag_type_canonical,
          tag_value_canonical,
          usage_count,
          latest_entry_updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(owner_type, owner_id, scope_type, scope_id, tag_type_canonical, tag_value_canonical) DO UPDATE SET
          tag_type = excluded.tag_type,
          tag_value = excluded.tag_value,
          usage_count = excluded.usage_count,
          latest_entry_updated_at = excluded.latest_entry_updated_at
      `).run(
        target.owner.type,
        target.owner.id,
        target.scope.type,
        target.scope.id,
        tag.type,
        tag.value,
        tag.canonicalType,
        tag.canonicalValue,
        Number(remaining.usage_count),
        remaining.latest_entry_updated_at,
      );
    }
  }

  private insertMutationEvent(
    operation: "append" | "forget" | "supersede",
    entryId: string | null,
    bindingIdHash: string,
    sessionId: string | null,
    resultStatus: "success" | "already_forgotten" | "not_found" | "forbidden" | "failed",
    reason: string,
    createdAt: string,
    sourceMessageId: string | null = null,
  ): void {
    this.db.prepare(`
      INSERT INTO memory_mutation_events_v6 (
        id,
        operation,
        entry_id,
        binding_id_hash,
        session_id,
        source_message_id,
        result_status,
        reason,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(`memory-event-${randomUUID()}`, operation, entryId, bindingIdHash || null, sessionId, sourceMessageId, resultStatus, reason, createdAt);
  }

  private insertIdempotencyKey(input: {
    key: string;
    operation: "append" | "forget";
    bindingIdHash: string;
    target: MemoryV6ResolvedTarget;
    responseEntryId: string | null;
    operationCreated: boolean;
    requestFingerprint: string;
    createdAt: string;
  }): void {
    this.db.prepare(`
      INSERT INTO memory_idempotency_keys_v6 (
        key,
        operation,
        binding_id_hash,
        owner_type,
        owner_id,
        scope_type,
        scope_id,
        response_entry_id,
        operation_created,
        request_fingerprint,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.key,
      input.operation,
      input.bindingIdHash,
      input.target.owner.type,
      input.target.owner.id,
      input.target.scope.type,
      input.target.scope.id,
      input.responseEntryId,
      input.operationCreated ? 1 : 0,
      input.requestFingerprint,
      input.createdAt,
    );
  }

  private resolveAppendIdempotency(
    target: MemoryV6ResolvedTarget,
    idempotencyKey: string,
    bindingIdHash: string,
    requestFingerprint: string,
  ): MemoryV6AppendResult | null {
    const row = this.getIdempotencyRow(target, "append", idempotencyKey, bindingIdHash);
    if (!row) {
      return null;
    }
    if (row.request_fingerprint !== requestFingerprint) {
      throw new MemoryV6IdempotencyConflictError();
    }
    if (!row.response_entry_id) {
      throw new MemoryV6EntryNotFoundError(idempotencyKey);
    }
    const entry = this.getEntry(row.response_entry_id);
    if (!entry || entry.state !== "active") {
      throw new MemoryV6EntryNotFoundError(row.response_entry_id);
    }
    return {
      entry,
      created: row.operation_created === 1,
      replayed: true,
      ...(row.cleanup_pending_count > 0 ? { cleanupRequired: true as const } : {}),
    };
  }

  private resolveForgetIdempotency(
    target: MemoryV6ResolvedTarget,
    idempotencyKey: string,
    bindingIdHash: string,
    requestFingerprint: string,
  ): MemoryV6ForgetResult[] | null {
    const row = this.getIdempotencyRow(target, "forget", idempotencyKey, bindingIdHash);
    if (!row) {
      return null;
    }
    if (row.request_fingerprint !== requestFingerprint) {
      throw new MemoryV6IdempotencyConflictError();
    }
    const rows = this.db.prepare(`
      SELECT entry_id, result_status
      FROM memory_idempotency_forget_results_v6
      WHERE binding_id_hash = ?
        AND key = ?
        AND operation = 'forget'
        AND owner_type = ?
        AND owner_id = ?
        AND scope_type = ?
        AND scope_id = ?
      ORDER BY created_at ASC, entry_id ASC
    `).all(
      bindingIdHash,
      idempotencyKey,
      target.owner.type,
      target.owner.id,
      target.scope.type,
      target.scope.id,
    ) as Array<{ entry_id: string; result_status: MemoryV6ForgetResultStatus }>;
    return rows.map((result) => ({ entryId: result.entry_id, status: result.result_status, replayed: true }));
  }

  private getIdempotencyRow(
    target: MemoryV6ResolvedTarget,
    operation: "append" | "forget",
    idempotencyKey: string,
    bindingIdHash: string,
  ): IdempotencyRow | null {
    const row = this.db.prepare(`
      SELECT response_entry_id, operation_created, request_fingerprint, cleanup_pending_count
      FROM memory_idempotency_keys_v6
      WHERE binding_id_hash = ?
        AND key = ?
        AND operation = ?
        AND owner_type = ?
        AND owner_id = ?
        AND scope_type = ?
        AND scope_id = ?
    `).get(
      bindingIdHash,
      idempotencyKey,
      operation,
      target.owner.type,
      target.owner.id,
      target.scope.type,
      target.scope.id,
    ) as IdempotencyRow | undefined;
    return row ?? null;
  }
}
