import { createHash, randomUUID } from "node:crypto";

import {
  createMemoryAppendResponse,
  createMemoryAuditResponse,
  createMemoryErrorResponse,
  createMemoryExportFilesResponse,
  createMemoryFileUsageResponse,
  createMemoryForgetResponse,
  createMemoryGetEntryResponse,
  createMemoryGetFileResponse,
  createMemoryListCharactersResponse,
  createMemoryListEntriesResponse,
  createMemoryListTagsResponse,
  createMemoryListTargetsResponse,
  createMemoryMoveEntryResponse,
  createMemorySearchResponse,
  type MemoryAppendResponse,
  type MemoryAuditResponse,
  type MemoryErrorResponse,
  type MemoryExportFilesResponse,
  type MemoryFileUsageResponse,
  type MemoryForgetResponse,
  type MemoryGetEntryResponse,
  type MemoryGetFileResponse,
  type MemoryListCharactersResponse,
  type MemoryListEntriesResponse,
  type MemoryListTagsResponse,
  type MemoryListTargetsResponse,
  type MemoryTargetInventoryItem,
  type MemoryMoveEntryResponse,
  type MemorySearchResponse,
} from "../src/memory-v6/memory-response-contract.js";
import type { CharacterCatalogEntry } from "../src/character/character-catalog.js";
import type { MemoryAppendFileInput, MemoryAppendRequest, MemoryError, MemoryMoveEntryRequest, MemoryTargetSelector } from "../src/memory-v6/memory-contract.js";
import { MEMORY_FILE_QUOTA_DEFAULT_BYTES, normalizeMemoryFileQuotaBytes } from "../src/provider-settings-state.js";
import {
  validateMemoryAppendRequest,
  validateMemoryAuditRequest,
  validateMemoryExportFilesRequest,
  validateMemoryForgetRequest,
  validateMemoryGetEntryRequest,
  validateMemoryGetFileRequest,
  validateMemoryListTagsRequest,
  validateMemoryListEntriesRequest,
  validateMemoryListTargetsRequest,
  validateMemoryMoveEntryRequest,
  validateMemorySearchRequest,
} from "../src/memory-v6/memory-validation.js";
import { toMemoryEntrySummary, type MemoryEntryDetail } from "../src/memory-v6/memory-state.js";
import { buildMemoryTargetAudit } from "./memory-v6-audit.js";
import { resolveMemoryV6Target, type MemoryV6TargetResolverDeps } from "./memory-v6-context-resolver.js";
import type { MemoryV6ResolvedTarget } from "./memory-v6-schema.js";
import { requireMemoryPermission, type MemoryV6Principal } from "./memory-v6-permission.js";
import {
  MemoryV6EntryNotFoundError,
  MemoryV6FileQuotaExceededError,
  MemoryV6IdempotencyConflictError,
  type MemoryV6AppendProtectedObjectInput,
  type MemoryV6ProtectedObjectExportMetadata,
  type MemoryV6TargetInventoryItem,
  type MemoryV6Storage,
} from "./memory-v6-storage.js";
import {
  MemoryProtectedObjectImportError,
  type MemoryProtectedObjectInputFileInspection,
} from "./memory-protected-object-importer.js";

export type MemoryV6ServiceDeps = MemoryV6TargetResolverDeps & {
  storage: MemoryV6Storage;
  listCharacters?(): readonly CharacterCatalogEntry[];
  getMemoryFileQuotaBytes?(): number;
  protectedObjectImporter?: MemoryV6ProtectedObjectImporter;
  protectedObjectExporter?: MemoryV6ProtectedObjectExporter;
};

export type MemoryV6ProtectedObjectImporter = {
  inspect(file: MemoryAppendFileInput): Promise<MemoryProtectedObjectInputFileInspection>;
  prepare(input: { entryId: string; file: MemoryAppendFileInput }): Promise<MemoryV6AppendProtectedObjectInput>;
  discardPrepared?(input: { objectId: string }): Promise<void>;
};

export type MemoryV6ProtectedObjectExporter = {
  exportFile(input: {
    metadata: MemoryV6ProtectedObjectExportMetadata;
    outputPath: string;
  }): Promise<{ bytesWritten: number }>;
  exportFiles?(input: {
    metadata: readonly MemoryV6ProtectedObjectExportMetadata[];
    outputDirectoryPath: string;
  }): Promise<{
    files: Array<{
      objectId: string;
      outputPath: string;
      bytesWritten: number;
      contentType: string;
      displayName: string;
    }>;
  }>;
};

type MemoryV6ServiceResult<T> = T | MemoryErrorResponse;

type MemoryV6FileUsageOptions = {
  includeLargestEntries?: boolean;
  largestLimit?: number;
};

function normalizeLargestFileEntryLimit(value: number | undefined): number {
  if (value === undefined) {
    return 20;
  }
  const limit = Math.floor(value);
  return Number.isFinite(limit) ? Math.max(1, Math.min(50, limit)) : 20;
}

function entryTarget(entry: MemoryEntryDetail): MemoryV6ResolvedTarget {
  return {
    owner: entry.owner,
    scope: entry.scope,
  };
}

function sameTarget(left: MemoryV6ResolvedTarget, right: MemoryV6ResolvedTarget): boolean {
  return left.owner.type === right.owner.type
    && left.owner.id === right.owner.id
    && left.scope.type === right.scope.type
    && left.scope.id === right.scope.id;
}

function selectorForResolvedTarget(target: MemoryV6ResolvedTarget): MemoryTargetSelector {
  if (target.owner.type === "user" && target.scope.type === "global") {
    return { owner: "user", scope: "global" };
  }
  if (target.owner.type === "project" && target.scope.type === "project") {
    return { owner: "project", scope: "project", project: { type: "id", id: target.owner.id } };
  }
  if (target.owner.type === "character" && target.scope.type === "character") {
    return { owner: "character", scope: "character", character: { type: "id", id: target.owner.id } };
  }
  if (target.owner.type === "character" && target.scope.type === "project") {
    return {
      owner: "character",
      scope: "project",
      character: { type: "id", id: target.owner.id },
      project: { type: "id", id: target.scope.id },
    };
  }
  throw new Error("Unsupported resolved Memory target.");
}

function toTargetInventoryItem(item: MemoryV6TargetInventoryItem): MemoryTargetInventoryItem {
  const selector = selectorForResolvedTarget(item.target);
  return {
    target: selector,
    owner: selector.owner,
    scope: selector.scope,
    ...(item.project ? { project: { ...item.project } } : {}),
    ...(item.character ? { character: { ...item.character } } : {}),
    entryCount: item.entryCount,
    tagCount: item.tagCount,
    lastUpdatedAt: item.lastUpdatedAt,
  };
}

function buildMoveFingerprint(input: {
  request: MemoryMoveEntryRequest;
  from: MemoryV6ResolvedTarget;
  to: MemoryV6ResolvedTarget;
}): string {
  return fingerprint({
    operation: "move_entry",
    entryId: input.request.entryId,
    from: input.from,
    to: input.to,
    sourceMessageId: input.request.sourceMessageId ?? null,
  });
}

function toMemoryErrorResponse(error: MemoryError): MemoryErrorResponse {
  return createMemoryErrorResponse(error);
}

function requirePrincipalPermission(principal: MemoryV6Principal | null, permission: Parameters<typeof requireMemoryPermission>[1]): MemoryErrorResponse | null {
  const permissionError = requireMemoryPermission(principal, permission);
  return permissionError ? toMemoryErrorResponse(permissionError) : null;
}

function bindingIdHashForPrincipal(principal: MemoryV6Principal): string {
  return principal.bindingIdHash;
}

function providerIdForPrincipal(principal: MemoryV6Principal): string | null {
  return principal.providerId;
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
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function storageErrorResponse(error: unknown): MemoryErrorResponse {
  if (error instanceof MemoryV6FileImportError) {
    return toMemoryErrorResponse(error.error);
  }
  if (error instanceof MemoryV6IdempotencyConflictError) {
    return toMemoryErrorResponse({
      code: "MEMORY_IDEMPOTENCY_CONFLICT",
      message: "Memory idempotency key was reused with a different request.",
    });
  }
  if (error instanceof MemoryV6EntryNotFoundError) {
    return toMemoryErrorResponse({
      code: "MEMORY_ENTRY_NOT_FOUND",
      message: "Memory entry was not found.",
    });
  }
  if (error instanceof MemoryV6FileQuotaExceededError) {
    return toMemoryErrorResponse({
      code: "MEMORY_FILE_QUOTA_EXCEEDED",
      message: "Memory file storage quota would be exceeded.",
      field: "files",
      quotaBytes: error.quotaBytes,
      usedBytes: error.usedBytes,
      incomingBytes: error.incomingBytes,
      availableBytes: error.availableBytes,
    });
  }
  throw error;
}

class MemoryV6FileImportError extends Error {
  constructor(readonly error: MemoryError) {
    super(error.message);
    this.name = "MemoryV6FileImportError";
  }
}

function fileImportErrorField(index: number, field: MemoryProtectedObjectImportError["field"]): string {
  if (field === "path" || field === "summary") {
    return `files[${index}].${field}`;
  }
  return `files[${index}]`;
}

function toFileImportError(error: unknown, index: number): MemoryV6FileImportError {
  if (error instanceof MemoryProtectedObjectImportError) {
    return new MemoryV6FileImportError({
      code: error.code,
      message: error.message,
      field: fileImportErrorField(index, error.field),
    });
  }
  return new MemoryV6FileImportError({
    code: "MEMORY_FILE_IMPORT_FAILED",
    message: "Memory file import failed.",
    field: `files[${index}]`,
  });
}

export class MemoryV6Service {
  constructor(private readonly deps: MemoryV6ServiceDeps) {}

  listCharacters(principal: MemoryV6Principal | null): MemoryV6ServiceResult<MemoryListCharactersResponse> {
    const permissionError = requirePrincipalPermission(principal, "memory.list_characters");
    if (permissionError) {
      return permissionError;
    }
    return createMemoryListCharactersResponse(this.deps.listCharacters?.() ?? []);
  }

  fileUsage(principal: MemoryV6Principal | null, options: MemoryV6FileUsageOptions = {}): MemoryV6ServiceResult<MemoryFileUsageResponse> {
    const permissionError = requirePrincipalPermission(principal, "memory.file_usage");
    if (permissionError) {
      return permissionError;
    }
    const quotaBytes = normalizeMemoryFileQuotaBytes(this.deps.getMemoryFileQuotaBytes?.() ?? MEMORY_FILE_QUOTA_DEFAULT_BYTES);
    const largestEntries = options.includeLargestEntries
      ? this.deps.storage.listLargestFileEntries({ limit: normalizeLargestFileEntryLimit(options.largestLimit) })
      : undefined;
    return createMemoryFileUsageResponse({
      quotaBytes,
      ...this.deps.storage.getFileUsage(),
      ...(largestEntries === undefined ? {} : { largestEntries }),
    });
  }

  listTargets(principal: MemoryV6Principal | null, request: unknown): MemoryV6ServiceResult<MemoryListTargetsResponse> {
    const permissionError = requirePrincipalPermission(principal, "memory.list_targets");
    if (permissionError) {
      return permissionError;
    }
    if (!principal) {
      throw new Error("Memory principal permission check failed.");
    }
    const validated = validateMemoryListTargetsRequest(request);
    if (!validated.ok) {
      return toMemoryErrorResponse(validated.error);
    }
    let projectId: string | undefined;
    if (validated.value.project) {
      const resolved = resolveMemoryV6Target({ owner: "project", scope: "project", project: validated.value.project }, principal, this.deps);
      if (!resolved.ok) {
        return toMemoryErrorResponse(resolved.error);
      }
      projectId = resolved.target.owner.id;
    }
    let characterId: string | undefined;
    if (validated.value.character) {
      const resolved = resolveMemoryV6Target({ owner: "character", scope: "character", character: validated.value.character }, principal, this.deps);
      if (!resolved.ok) {
        return toMemoryErrorResponse(resolved.error);
      }
      characterId = resolved.target.owner.id;
    }
    const result = this.deps.storage.listTargets({
      ownerType: validated.value.owner,
      scopeType: validated.value.scope,
      projectId,
      characterId,
      includeEmpty: validated.value.includeEmpty,
      limit: validated.value.limit,
      cursor: validated.value.cursor,
    });
    return createMemoryListTargetsResponse(result.items.map(toTargetInventoryItem), result.nextCursor);
  }

  listEntries(principal: MemoryV6Principal | null, request: unknown): MemoryV6ServiceResult<MemoryListEntriesResponse> {
    const permissionError = requirePrincipalPermission(principal, "memory.list_entries");
    if (permissionError) {
      return permissionError;
    }
    if (!principal) {
      throw new Error("Memory principal permission check failed.");
    }
    const validated = validateMemoryListEntriesRequest(request);
    if (!validated.ok) {
      return toMemoryErrorResponse(validated.error);
    }
    const resolved = resolveMemoryV6Target(validated.value.target, principal, this.deps);
    if (!resolved.ok) {
      return toMemoryErrorResponse(resolved.error);
    }
    const result = this.deps.storage.listEntries({
      target: resolved.target,
      states: validated.value.states,
      kinds: validated.value.kinds,
      tags: validated.value.tags,
      limit: validated.value.limit,
      cursor: validated.value.cursor,
    });
    return createMemoryListEntriesResponse(result.items.map((entry) => ({
      ...toMemoryEntrySummary(entry),
      ...(validated.value.includeBody ? { body: entry.body } : {}),
      supersedes: [...entry.supersedes],
      supersededBy: entry.supersededBy,
    })), result.nextCursor);
  }

  audit(principal: MemoryV6Principal | null, request: unknown): MemoryV6ServiceResult<MemoryAuditResponse> {
    const permissionError = requirePrincipalPermission(principal, "memory.audit");
    if (permissionError) {
      return permissionError;
    }
    if (!principal) {
      throw new Error("Memory principal permission check failed.");
    }
    const validated = validateMemoryAuditRequest(request);
    if (!validated.ok) {
      return toMemoryErrorResponse(validated.error);
    }
    const generatedAt = new Date().toISOString();
    const staleBefore = validated.value.staleBefore
      ?? new Date(Date.parse(generatedAt) - 90 * 24 * 60 * 60 * 1_000).toISOString();
    let inventoryItems: MemoryV6TargetInventoryItem[];
    let nextCursor: string | undefined;
    if (validated.value.allTargets) {
      const inventory = this.deps.storage.listTargets({ limit: validated.value.limit, cursor: validated.value.cursor });
      inventoryItems = inventory.items;
      nextCursor = inventory.nextCursor;
    } else {
      inventoryItems = [];
      for (const selector of validated.value.targets ?? []) {
        const resolved = resolveMemoryV6Target(selector, principal, this.deps);
        if (!resolved.ok) {
          return toMemoryErrorResponse(resolved.error);
        }
        const inventory = this.deps.storage.listTargets({
          ownerType: resolved.target.owner.type,
          scopeType: resolved.target.scope.type,
          projectId: resolved.target.scope.type === "project" ? resolved.target.scope.id : undefined,
          characterId: resolved.target.owner.type === "character" ? resolved.target.owner.id : undefined,
          includeEmpty: true,
          limit: 50,
        }).items.find((item) => sameTarget(item.target, resolved.target));
        inventoryItems.push(inventory ?? {
          target: resolved.target,
          entryCount: 0,
          tagCount: 0,
          lastUpdatedAt: null,
        });
      }
    }

    const targets = inventoryItems.map((inventory) => {
      const entries: MemoryEntryDetail[] = [];
      let cursor: string | undefined;
      do {
        const page = this.deps.storage.listEntries({ target: inventory.target, states: ["active"], limit: 50, cursor });
        entries.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor);
      return buildMemoryTargetAudit({
        target: toTargetInventoryItem(inventory),
        resolvedTarget: inventory.target,
        entries,
        tagStatistics: this.deps.storage.listTagStatistics([inventory.target]),
        staleBefore,
      });
    });
    return createMemoryAuditResponse({ generatedAt, staleBefore, targets, ...(nextCursor ? { nextCursor } : {}) });
  }

  search(principal: MemoryV6Principal | null, request: unknown): MemoryV6ServiceResult<MemorySearchResponse> {
    const permissionError = requirePrincipalPermission(principal, "memory.search");
    if (permissionError) {
      return permissionError;
    }
    if (!principal) {
      throw new Error("Memory principal permission check failed.");
    }
    const validated = validateMemorySearchRequest(request);
    if (!validated.ok) {
      return toMemoryErrorResponse(validated.error);
    }

    const resolvedTargets: MemoryV6ResolvedTarget[] = [];
    for (const target of validated.value.targets) {
      const resolved = resolveMemoryV6Target(target, principal, this.deps);
      if (!resolved.ok) {
        return toMemoryErrorResponse(resolved.error);
      }
      resolvedTargets.push(resolved.target);
    }

    const result = this.deps.storage.searchEntries({
      targets: resolvedTargets,
      query: validated.value.query,
      kinds: validated.value.kinds,
      tags: validated.value.tags,
      limit: validated.value.limit,
      cursor: validated.value.cursor,
    });
    return createMemorySearchResponse(result.items, {
      nextCursor: result.nextCursor,
      relatedTags: result.relatedTags,
    });
  }

  getEntry(principal: MemoryV6Principal | null, request: unknown): MemoryV6ServiceResult<MemoryGetEntryResponse> {
    const permissionError = requirePrincipalPermission(principal, "memory.get_entry");
    if (permissionError) {
      return permissionError;
    }
    if (!principal) {
      throw new Error("Memory principal permission check failed.");
    }
    const validated = validateMemoryGetEntryRequest(request);
    if (!validated.ok) {
      return toMemoryErrorResponse(validated.error);
    }

    const resolved = resolveMemoryV6Target(validated.value.target, principal, this.deps);
    if (!resolved.ok) {
      return toMemoryErrorResponse(resolved.error);
    }
    const requestedTarget = resolved.target;

    const entry = this.deps.storage.getEntry(validated.value.entryId);
    if (!entry || entry.state !== "active") {
      return createMemoryGetEntryResponse(null);
    }
    const target = entryTarget(entry);
    if (!sameTarget(requestedTarget, target)) {
      return createMemoryGetEntryResponse(null);
    }
    return createMemoryGetEntryResponse(entry);
  }

  async getFile(principal: MemoryV6Principal | null, request: unknown): Promise<MemoryV6ServiceResult<MemoryGetFileResponse>> {
    const permissionError = requirePrincipalPermission(principal, "memory.get_file");
    if (permissionError) {
      return permissionError;
    }
    if (!principal) {
      throw new Error("Memory principal permission check failed.");
    }
    const validated = validateMemoryGetFileRequest(request);
    if (!validated.ok) {
      return toMemoryErrorResponse(validated.error);
    }
    const resolved = resolveMemoryV6Target(validated.value.target, principal, this.deps);
    if (!resolved.ok) {
      return toMemoryErrorResponse(resolved.error);
    }
    if (!this.deps.protectedObjectExporter) {
      return toMemoryErrorResponse({
        code: "MEMORY_FILE_EXPORT_UNIMPLEMENTED",
        message: "Memory file export is not implemented yet.",
        field: "objectId",
      });
    }

    const metadata = this.deps.storage.getProtectedObjectForExport({
      target: resolved.target,
      objectId: validated.value.objectId,
    });
    if (!metadata) {
      return toMemoryErrorResponse({
        code: "MEMORY_FILE_NOT_FOUND",
        message: "Memory file was not found.",
        field: "objectId",
      });
    }

    try {
      const result = await this.deps.protectedObjectExporter.exportFile({
        metadata,
        outputPath: validated.value.outputPath,
      });
      return createMemoryGetFileResponse({
        objectId: metadata.objectId,
        entryId: metadata.entryId,
        outputPath: validated.value.outputPath,
        bytesWritten: result.bytesWritten,
        contentType: metadata.contentType,
        displayName: metadata.displayName,
      });
    } catch {
      return toMemoryErrorResponse({
        code: "MEMORY_FILE_EXPORT_FAILED",
        message: "Memory file export failed.",
        field: "outputPath",
      });
    }
  }

  async exportFiles(principal: MemoryV6Principal | null, request: unknown): Promise<MemoryV6ServiceResult<MemoryExportFilesResponse>> {
    const permissionError = requirePrincipalPermission(principal, "memory.export_files");
    if (permissionError) {
      return permissionError;
    }
    if (!principal) {
      throw new Error("Memory principal permission check failed.");
    }
    const validated = validateMemoryExportFilesRequest(request);
    if (!validated.ok) {
      return toMemoryErrorResponse(validated.error);
    }
    const resolved = resolveMemoryV6Target(validated.value.target, principal, this.deps);
    if (!resolved.ok) {
      return toMemoryErrorResponse(resolved.error);
    }
    if (!this.deps.protectedObjectExporter?.exportFiles) {
      return toMemoryErrorResponse({
        code: "MEMORY_FILE_EXPORT_UNIMPLEMENTED",
        message: "Memory file export is not implemented yet.",
        field: "entryId",
      });
    }

    const metadata = this.deps.storage.listProtectedObjectsForEntryExport({
      target: resolved.target,
      entryId: validated.value.entryId,
    });
    if (!metadata) {
      return toMemoryErrorResponse({
        code: "MEMORY_ENTRY_NOT_FOUND",
        message: "Memory entry was not found.",
        field: "entryId",
      });
    }

    try {
      const result = await this.deps.protectedObjectExporter.exportFiles({
        metadata,
        outputDirectoryPath: validated.value.outputDirectoryPath,
      });
      return createMemoryExportFilesResponse({
        entryId: validated.value.entryId,
        outputDirectoryPath: validated.value.outputDirectoryPath,
        files: result.files,
      });
    } catch {
      return toMemoryErrorResponse({
        code: "MEMORY_FILE_EXPORT_FAILED",
        message: "Memory file export failed.",
        field: "outputDirectoryPath",
      });
    }
  }

  listTags(principal: MemoryV6Principal | null, request: unknown): MemoryV6ServiceResult<MemoryListTagsResponse> {
    const permissionError = requirePrincipalPermission(principal, "memory.list_tags");
    if (permissionError) {
      return permissionError;
    }
    if (!principal) {
      throw new Error("Memory principal permission check failed.");
    }
    const validated = validateMemoryListTagsRequest(request);
    if (!validated.ok) {
      return toMemoryErrorResponse(validated.error);
    }

    const resolvedTargets: MemoryV6ResolvedTarget[] = [];
    for (const target of validated.value.targets) {
      const resolved = resolveMemoryV6Target(target, principal, this.deps);
      if (!resolved.ok) {
        return toMemoryErrorResponse(resolved.error);
      }
      resolvedTargets.push(resolved.target);
    }

    if (validated.value.withCounts) {
      return createMemoryListTagsResponse(this.deps.storage.listTagStatistics(resolvedTargets, validated.value.sampleLimit ?? 0).map((tag) => ({
        type: tag.type,
        value: tag.value,
        entryCount: tag.entryCount,
        latestUpdatedAt: tag.latestUpdatedAt,
        ...(tag.samples.length > 0 ? { samples: tag.samples } : {}),
      })));
    }
    return createMemoryListTagsResponse(this.deps.storage.listTags(resolvedTargets));
  }

  async append(principal: MemoryV6Principal | null, request: unknown): Promise<MemoryV6ServiceResult<MemoryAppendResponse>> {
    const permissionError = requirePrincipalPermission(principal, "memory.append");
    if (permissionError) {
      return permissionError;
    }
    if (!principal) {
      throw new Error("Memory principal permission check failed.");
    }
    const validated = validateMemoryAppendRequest(request);
    if (!validated.ok) {
      return toMemoryErrorResponse(validated.error);
    }
    const resolved = resolveMemoryV6Target(validated.value.target, principal, this.deps);
    if (!resolved.ok) {
      return toMemoryErrorResponse(resolved.error);
    }
    const files = validated.value.files ?? [];
    const hasFiles = files.length > 0;
    if (hasFiles && !this.deps.protectedObjectImporter) {
      return toMemoryErrorResponse({
        code: "MEMORY_FILE_APPEND_UNIMPLEMENTED",
        message: "Memory file append is not implemented yet.",
        field: "files",
      });
    }

    try {
      const requestFingerprint = hasFiles
        ? buildAppendRequestFingerprint({
          target: resolved.target,
          request: validated.value,
          principal,
        })
        : undefined;
      if (hasFiles && validated.value.idempotencyKey && requestFingerprint) {
        const replay = this.deps.storage.resolveAppendIdempotencyReplay({
          target: resolved.target,
          idempotencyKey: validated.value.idempotencyKey,
          bindingIdHash: bindingIdHashForPrincipal(principal),
          requestFingerprint,
        });
        if (replay) {
          return createMemoryAppendResponse(replay.entry, replay.created);
        }
      }

      const entryId = hasFiles ? `mem-${randomUUID()}` : undefined;
      const fileQuotaBytes = normalizeMemoryFileQuotaBytes(this.deps.getMemoryFileQuotaBytes?.() ?? MEMORY_FILE_QUOTA_DEFAULT_BYTES);
      const protectedObjects = hasFiles && this.deps.protectedObjectImporter
        ? await this.prepareProtectedObjects({
          entryId: entryId ?? `mem-${randomUUID()}`,
          files,
          fileQuotaBytes,
        })
        : [];
      let result;
      try {
        result = this.deps.storage.appendEntry({
          ...(entryId ? { id: entryId } : {}),
          target: resolved.target,
          kind: validated.value.kind,
          title: validated.value.title,
          body: validated.value.body,
          preview: validated.value.preview,
          tags: validated.value.tags,
          supersedes: validated.value.supersedes,
          mutationReason: validated.value.mutationReason,
          idempotencyKey: validated.value.idempotencyKey,
          bindingIdHash: bindingIdHashForPrincipal(principal),
          ...(hasFiles ? {
            protectedObjects,
            fileQuotaBytes,
            requestFingerprint,
          } : {}),
          source: {
            type: "agent",
            sessionId: null,
            messageId: validated.value.sourceMessageId ?? null,
            providerId: providerIdForPrincipal(principal),
            appMessageId: null,
          },
        });
      } catch (error) {
        await this.discardPreparedObjects(protectedObjects);
        throw error;
      }
      return createMemoryAppendResponse(result.entry, result.created);
    } catch (error) {
      return storageErrorResponse(error);
    }
  }

  private async prepareProtectedObjects(input: {
    entryId: string;
    files: readonly MemoryAppendFileInput[];
    fileQuotaBytes: number;
  }): Promise<MemoryV6AppendProtectedObjectInput[]> {
    if (!this.deps.protectedObjectImporter) {
      throw new Error("Memory protected object importer is not configured.");
    }
    const importer = this.deps.protectedObjectImporter;
    const inspections = await Promise.all(
      input.files.map(async (file, index) => {
        try {
          return await importer.inspect(file);
        } catch (error) {
          throw toFileImportError(error, index);
        }
      }),
    );
    const incomingBytes = inspections.reduce((sum, item) => sum + item.originalBytes, 0);
    const usage = this.deps.storage.getFileUsage();
    if (usage.usedBytes + incomingBytes > input.fileQuotaBytes) {
      throw new MemoryV6FileQuotaExceededError(input.fileQuotaBytes, usage.usedBytes, incomingBytes);
    }

    const protectedObjects: MemoryV6AppendProtectedObjectInput[] = [];
    try {
      for (let index = 0; index < input.files.length; index += 1) {
        const file = input.files[index];
        protectedObjects.push(await importer.prepare({
          entryId: input.entryId,
          file,
        }));
      }
    } catch (error) {
      await this.discardPreparedObjects(protectedObjects);
      throw toFileImportError(error, protectedObjects.length);
    }
    return protectedObjects;
  }

  private async discardPreparedObjects(protectedObjects: readonly MemoryV6AppendProtectedObjectInput[]): Promise<void> {
    if (protectedObjects.length === 0 || !this.deps.protectedObjectImporter?.discardPrepared) {
      return;
    }
    await Promise.all(protectedObjects.map(async (object) => {
      try {
        await this.deps.protectedObjectImporter?.discardPrepared?.({ objectId: object.objectId });
      } catch {
        // Best-effort cleanup: keep the original append/import error visible to the caller.
      }
    }));
  }

  forget(principal: MemoryV6Principal | null, request: unknown): MemoryV6ServiceResult<MemoryForgetResponse> {
    const permissionError = requirePrincipalPermission(principal, "memory.forget");
    if (permissionError) {
      return permissionError;
    }
    if (!principal) {
      throw new Error("Memory principal permission check failed.");
    }
    const validated = validateMemoryForgetRequest(request);
    if (!validated.ok) {
      return toMemoryErrorResponse(validated.error);
    }
    const resolved = resolveMemoryV6Target(validated.value.target, principal, this.deps);
    if (!resolved.ok) {
      return toMemoryErrorResponse(resolved.error);
    }

    try {
      if (validated.value.dryRun) {
        const results = this.deps.storage.previewForgetEntries({
          target: resolved.target,
          entryIds: validated.value.entryIds,
          reason: validated.value.reason,
          idempotencyKey: validated.value.idempotencyKey,
          bindingIdHash: bindingIdHashForPrincipal(principal),
        }).map((result) => ({
          entryId: result.entryId,
          status: result.status,
          ...(result.entry ? { entry: toMemoryEntrySummary(result.entry) } : {}),
          ...(result.warning ? { warning: result.warning } : {}),
        }));
        return createMemoryForgetResponse(results, { dryRun: true });
      }
      const results = this.deps.storage.forgetEntries({
        target: resolved.target,
        entryIds: validated.value.entryIds,
        reason: validated.value.reason,
        idempotencyKey: validated.value.idempotencyKey,
        bindingIdHash: bindingIdHashForPrincipal(principal),
        sessionId: null,
      });
      return createMemoryForgetResponse(results);
    } catch (error) {
      return storageErrorResponse(error);
    }
  }

  moveEntry(principal: MemoryV6Principal | null, request: unknown): MemoryV6ServiceResult<MemoryMoveEntryResponse> {
    const permissionError = requirePrincipalPermission(principal, "memory.move_entry");
    if (permissionError) {
      return permissionError;
    }
    if (!principal) {
      throw new Error("Memory principal permission check failed.");
    }
    const validated = validateMemoryMoveEntryRequest(request);
    if (!validated.ok) {
      return toMemoryErrorResponse(validated.error);
    }
    const from = resolveMemoryV6Target(validated.value.from, principal, this.deps);
    if (!from.ok) {
      return toMemoryErrorResponse(from.error);
    }
    const to = resolveMemoryV6Target(validated.value.to, principal, this.deps);
    if (!to.ok) {
      return toMemoryErrorResponse(to.error);
    }
    if (sameTarget(from.target, to.target)) {
      return toMemoryErrorResponse({
        code: "MEMORY_INVALID_FIELD",
        message: "from and to must resolve to different targets.",
        field: "to",
      });
    }
    try {
      const result = this.deps.storage.moveEntry({
        entryId: validated.value.entryId,
        from: from.target,
        to: to.target,
        bindingIdHash: bindingIdHashForPrincipal(principal),
        idempotencyKey: validated.value.idempotencyKey,
        requestFingerprint: buildMoveFingerprint({ request: validated.value, from: from.target, to: to.target }),
      });
      return createMemoryMoveEntryResponse({
        entry: result.entry,
        moved: result.moved,
        from: validated.value.from,
        to: validated.value.to,
      });
    } catch (error) {
      return storageErrorResponse(error);
    }
  }
}

function buildAppendRequestFingerprint(input: {
  target: MemoryV6ResolvedTarget;
  request: MemoryAppendRequest;
  principal: MemoryV6Principal;
}): string {
  return fingerprint({
    operation: "append",
    target: input.target,
    kind: input.request.kind,
    title: input.request.title,
    body: input.request.body,
    preview: input.request.preview,
    tags: input.request.tags.map((tag) => ({
      type: tag.type,
      value: tag.value,
      canonicalType: tag.canonicalType,
      canonicalValue: tag.canonicalValue,
    })),
    source: {
      type: "agent",
      sessionId: null,
      messageId: input.request.sourceMessageId ?? null,
      providerId: providerIdForPrincipal(input.principal),
      appMessageId: null,
    },
    supersedes: [...(input.request.supersedes ?? [])].sort(),
    mutationReason: input.request.mutationReason ?? "",
    files: (input.request.files ?? []).map((file) => ({
      path: file.path,
      summary: file.summary,
      role: file.role ?? "",
      displayName: file.displayName ?? "",
      contentType: file.contentType ?? "",
    })),
  });
}
