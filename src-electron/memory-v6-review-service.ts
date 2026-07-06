import type {
  MemoryEntryKind,
  MemoryForgetReason,
  MemoryV6ReviewSearchRequest,
} from "../src/memory-v6/memory-contract.js";
import type { MemoryEntryDetail, MemoryFileSummary } from "../src/memory-v6/memory-state.js";
import type {
  MemoryV6ReviewEntryDetail,
  MemoryV6ReviewFileSummary,
  MemoryV6ReviewExportFilesResult,
  MemoryV6ReviewForgetResult,
  MemoryV6ProtectedObjectGcRequest,
  MemoryV6ProtectedObjectGcResponse,
  MemoryV6ReviewSearchResult,
} from "../src/memory-v6/memory-review-state.js";
import { MEMORY_V6_SCHEMA_VERSION } from "../src/memory-v6/memory-contract.js";
import {
  createMemoryFileUsageResponse,
  type MemoryFileUsageResponse,
} from "../src/memory-v6/memory-response-contract.js";
import { MEMORY_FILE_QUOTA_DEFAULT_BYTES, normalizeMemoryFileQuotaBytes } from "../src/provider-settings-state.js";
import type { MemoryProtectedObjectStore } from "./memory-protected-object-store.js";
import type { MemoryV6ProtectedObjectExporter } from "./memory-v6-service.js";
import { MemoryV6Storage } from "./memory-v6-storage.js";

export type MemoryV6ReviewServiceDeps = {
  resolveDbPath(): string | null;
  getMemoryFileQuotaBytes?(): number;
  protectedObjectExporter?: MemoryV6ProtectedObjectExporter;
  protectedObjectStore?: Pick<MemoryProtectedObjectStore, "deleteObject" | "objectExists" | "listObjectFilesForGc" | "collectStagingGarbage">;
};

const VALID_KIND_SET = new Set<MemoryEntryKind>([
  "decision",
  "constraint",
  "convention",
  "context",
  "deferred",
  "preference",
  "relationship",
  "boundary",
  "note",
]);

const VALID_FORGET_REASON_SET = new Set<MemoryForgetReason>([
  "user_request",
  "incorrect",
  "outdated",
  "privacy",
  "other",
]);

const DEFAULT_GC_GRACE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_GC_LIMIT = 100;

function normalizeGcRequest(request: unknown): Required<MemoryV6ProtectedObjectGcRequest> {
  if (!request || typeof request !== "object" || typeof (request as MemoryV6ProtectedObjectGcRequest).dryRun !== "boolean") {
    throw new Error("Memory file GC request requires dryRun boolean.");
  }
  const gcRequest = request as MemoryV6ProtectedObjectGcRequest;
  const graceMs = typeof gcRequest.graceMs === "number" && Number.isFinite(gcRequest.graceMs)
    ? Math.max(0, Math.floor(gcRequest.graceMs))
    : DEFAULT_GC_GRACE_MS;
  const requestedLimit = typeof gcRequest.limit === "number" && Number.isFinite(gcRequest.limit)
    ? Math.floor(gcRequest.limit)
    : DEFAULT_GC_LIMIT;
  return {
    dryRun: gcRequest.dryRun,
    graceMs,
    limit: Math.max(1, Math.min(500, requestedLimit)),
  };
}

function sanitizeReviewFileSummary(file: MemoryFileSummary | MemoryV6ReviewFileSummary): MemoryV6ReviewFileSummary {
  const { objectId: _objectId, ...safeFile } = file as MemoryFileSummary;
  return safeFile;
}

function sanitizeReviewEntryDetail(entry: MemoryEntryDetail): MemoryV6ReviewEntryDetail {
  const { files, ...safeEntry } = entry;
  return {
    ...safeEntry,
    ...(files && files.length > 0 ? { files: files.map(sanitizeReviewFileSummary) } : {}),
  };
}

function normalizeSearchRequest(request: MemoryV6ReviewSearchRequest | null | undefined): MemoryV6ReviewSearchRequest {
  const kinds = (request?.kinds ?? []).filter((kind): kind is MemoryEntryKind => VALID_KIND_SET.has(kind));
  return {
    query: typeof request?.query === "string" ? request.query : "",
    ...(kinds.length > 0 ? { kinds } : {}),
    ...(typeof request?.limit === "number" ? { limit: request.limit } : {}),
    ...(typeof request?.cursor === "string" ? { cursor: request.cursor } : {}),
  };
}

function normalizeForgetReason(reason: MemoryForgetReason | null | undefined): MemoryForgetReason {
  return reason && VALID_FORGET_REASON_SET.has(reason) ? reason : "user_request";
}

export class MemoryV6ReviewService {
  constructor(private readonly deps: MemoryV6ReviewServiceDeps) {}

  getFileUsage(): MemoryFileUsageResponse {
    return this.withStorage((storage) => createMemoryFileUsageResponse({
      quotaBytes: normalizeMemoryFileQuotaBytes(this.deps.getMemoryFileQuotaBytes?.() ?? MEMORY_FILE_QUOTA_DEFAULT_BYTES),
      ...storage.getFileUsage(),
      largestEntries: storage.listLargestFileEntries({ limit: 10 }),
    }));
  }

  async runProtectedObjectGc(request: unknown): Promise<MemoryV6ProtectedObjectGcResponse> {
    const normalized = normalizeGcRequest(request);
    const warnings: string[] = [];
    const objectStore = this.deps.protectedObjectStore;
    if (!objectStore) {
      throw new Error("Memory protected object store is not configured.");
    }

    return this.withStorage(async (storage) => {
      const deletePendingCandidates = storage.listDeletePendingProtectedObjectsForGc({ limit: normalized.limit });
      const deletePending = {
        candidates: deletePendingCandidates.length,
        bytes: deletePendingCandidates.reduce((total, candidate) => total + candidate.storedBytes, 0),
        deleted: 0,
        missing: 0,
        failed: 0,
      };

      if (!normalized.dryRun) {
        const deletedAt = new Date().toISOString();
        for (const candidate of deletePendingCandidates) {
          try {
            const deleted = await objectStore.deleteObject(candidate.objectId);
            if (deleted) {
              deletePending.deleted += 1;
            } else {
              deletePending.missing += 1;
            }
            storage.markProtectedObjectDeletedForGc({ objectId: candidate.objectId, deletedAt });
          } catch {
            deletePending.failed += 1;
            warnings.push("Some delete-pending protected objects could not be deleted.");
          }
        }
      }

      const liveObjectIds = new Set(storage.listProtectedObjectIdsForGc({ states: ["active", "delete_pending"] }));
      const activeObjectIds = storage.listProtectedObjectIdsForGc({ states: ["active"] });
      let missingActiveObjects = 0;
      for (const objectId of activeObjectIds) {
        if (!(await objectStore.objectExists(objectId))) {
          missingActiveObjects += 1;
        }
      }

      const storeFiles = await objectStore.listObjectFilesForGc({
        graceMs: normalized.graceMs,
        limit: normalized.limit,
      });
      const orphanCandidates = storeFiles.filter((candidate) => !liveObjectIds.has(candidate.objectId));
      const orphanFiles = {
        candidates: orphanCandidates.length,
        bytes: orphanCandidates.reduce((total, candidate) => total + candidate.bytes, 0),
        deleted: 0,
        failed: 0,
      };
      if (!normalized.dryRun) {
        for (const candidate of orphanCandidates) {
          try {
            await objectStore.deleteObject(candidate.objectId);
            orphanFiles.deleted += 1;
          } catch {
            orphanFiles.failed += 1;
            warnings.push("Some orphan protected object files could not be deleted.");
          }
        }
      }

      const stagingFiles = await objectStore.collectStagingGarbage({
        dryRun: normalized.dryRun,
        graceMs: normalized.graceMs,
        limit: normalized.limit,
      });

      return {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        dryRun: normalized.dryRun,
        deletePending,
        orphanFiles,
        stagingFiles,
        missingActiveObjects,
        fileUsage: createMemoryFileUsageResponse({
          quotaBytes: normalizeMemoryFileQuotaBytes(this.deps.getMemoryFileQuotaBytes?.() ?? MEMORY_FILE_QUOTA_DEFAULT_BYTES),
          ...storage.getFileUsage(),
          largestEntries: storage.listLargestFileEntries({ limit: 10 }),
        }),
        warnings: [...new Set(warnings)],
      };
    });
  }

  async exportEntryFiles(entryId: string, outputDirectoryPath: string): Promise<MemoryV6ReviewExportFilesResult> {
    const normalizedEntryId = entryId.trim();
    if (!normalizedEntryId) {
      throw new Error("Memory entry id is required.");
    }
    if (!this.deps.protectedObjectExporter?.exportFiles) {
      throw new Error("Memory file export is not implemented yet.");
    }

    return this.withStorage(async (storage) => {
      const entry = storage.getEntry(normalizedEntryId);
      if (!entry || entry.state !== "active") {
        throw new Error("Memory entry was not found.");
      }
      const metadata = storage.listProtectedObjectsForEntryExport({
        target: { owner: entry.owner, scope: entry.scope },
        entryId: normalizedEntryId,
      });
      if (!metadata) {
        throw new Error("Memory entry was not found.");
      }

      const result = await this.deps.protectedObjectExporter!.exportFiles!({
        metadata,
        outputDirectoryPath,
      });
      return {
        entryId: normalizedEntryId,
        exportedCount: result.files.length,
      };
    });
  }

  searchEntries(request: MemoryV6ReviewSearchRequest | null | undefined): MemoryV6ReviewSearchResult {
    return this.withStorage((storage) => {
      const result = storage.searchEntriesForReview(normalizeSearchRequest(request));
      return {
        ...result,
        items: result.items.map((item) => {
          const { files, ...safeItem } = item;
          return {
            ...safeItem,
            ...(files && files.length > 0 ? { files: files.map(sanitizeReviewFileSummary) } : {}),
          };
        }),
      };
    });
  }

  getEntry(entryId: string): MemoryV6ReviewEntryDetail | null {
    const normalizedEntryId = entryId.trim();
    if (!normalizedEntryId) {
      return null;
    }
    return this.withStorage((storage) => {
      const entry = storage.getEntry(normalizedEntryId);
      return entry?.state === "active" ? sanitizeReviewEntryDetail(entry) : null;
    });
  }

  forgetEntry(entryId: string, reason?: MemoryForgetReason | null): MemoryV6ReviewForgetResult {
    const normalizedEntryId = entryId.trim();
    const normalizedReason = normalizeForgetReason(reason);
    if (!normalizedEntryId) {
      return { entryId: "", status: "not_found", reason: normalizedReason };
    }
    return this.withStorage((storage) =>
      storage.forgetEntryForReview({ entryId: normalizedEntryId, reason: normalizedReason })
    );
  }

  private withStorage<T>(runner: (storage: MemoryV6Storage) => T): T {
    const dbPath = this.deps.resolveDbPath();
    if (!dbPath) {
      throw new Error("Memory V6 database is unavailable.");
    }
    const storage = new MemoryV6Storage(dbPath);
    try {
      const result = runner(storage);
      if (result && typeof result === "object" && "finally" in result && typeof result.finally === "function") {
        return result.finally(() => storage.close()) as T;
      }
      storage.close();
      return result;
    } catch (error) {
      storage.close();
      throw error;
    }
  }
}
