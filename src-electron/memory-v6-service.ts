import { createHash, randomUUID } from "node:crypto";

import {
  createMemoryAppendResponse,
  createMemoryErrorResponse,
  createMemoryExportFilesResponse,
  createMemoryFileUsageResponse,
  createMemoryForgetResponse,
  createMemoryGetEntryResponse,
  createMemoryGetFileResponse,
  createMemoryListCharactersResponse,
  createMemoryListTagsResponse,
  createMemorySearchResponse,
  type MemoryAppendResponse,
  type MemoryErrorResponse,
  type MemoryExportFilesResponse,
  type MemoryFileUsageResponse,
  type MemoryForgetResponse,
  type MemoryGetEntryResponse,
  type MemoryGetFileResponse,
  type MemoryListCharactersResponse,
  type MemoryListTagsResponse,
  type MemorySearchResponse,
} from "../src/memory-v6/memory-response-contract.js";
import type { CharacterCatalogEntry } from "../src/character/character-catalog.js";
import type { MemoryAppendFileInput, MemoryAppendRequest, MemoryError } from "../src/memory-v6/memory-contract.js";
import { MEMORY_FILE_QUOTA_DEFAULT_BYTES, normalizeMemoryFileQuotaBytes } from "../src/provider-settings-state.js";
import {
  validateMemoryAppendRequest,
  validateMemoryExportFilesRequest,
  validateMemoryForgetRequest,
  validateMemoryGetEntryRequest,
  validateMemoryGetFileRequest,
  validateMemoryListTagsRequest,
  validateMemorySearchRequest,
} from "../src/memory-v6/memory-validation.js";
import type { MemoryEntryDetail } from "../src/memory-v6/memory-state.js";
import { resolveMemoryV6Target, type MemoryV6TargetResolverDeps } from "./memory-v6-context-resolver.js";
import type { MemoryV6ResolvedTarget } from "./memory-v6-schema.js";
import { requireMemoryPermission, type MemoryV6Principal } from "./memory-v6-permission.js";
import {
  MemoryV6EntryNotFoundError,
  MemoryV6FileQuotaExceededError,
  MemoryV6IdempotencyConflictError,
  type MemoryV6AppendProtectedObjectInput,
  type MemoryV6ProtectedObjectExportMetadata,
  type MemoryV6Storage,
} from "./memory-v6-storage.js";
import type { MemoryProtectedObjectInputFileInspection } from "./memory-protected-object-importer.js";

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
      const result = this.deps.storage.appendEntry({
        ...(entryId ? { id: entryId } : {}),
        target: resolved.target,
        kind: validated.value.kind,
        title: validated.value.title,
        body: validated.value.body,
        preview: validated.value.preview,
        tags: validated.value.tags,
        supersedes: validated.value.supersedes,
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
    const inspections = await Promise.all(
      input.files.map((file) => this.deps.protectedObjectImporter!.inspect(file)),
    );
    const incomingBytes = inspections.reduce((sum, item) => sum + item.originalBytes, 0);
    const usage = this.deps.storage.getFileUsage();
    if (usage.usedBytes + incomingBytes > input.fileQuotaBytes) {
      throw new MemoryV6FileQuotaExceededError(input.fileQuotaBytes, usage.usedBytes, incomingBytes);
    }

    const protectedObjects: MemoryV6AppendProtectedObjectInput[] = [];
    for (const file of input.files) {
      protectedObjects.push(await this.deps.protectedObjectImporter.prepare({
        entryId: input.entryId,
        file,
      }));
    }
    return protectedObjects;
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
    files: (input.request.files ?? []).map((file) => ({
      path: file.path,
      summary: file.summary,
      role: file.role ?? "",
      displayName: file.displayName ?? "",
      contentType: file.contentType ?? "",
    })),
  });
}
