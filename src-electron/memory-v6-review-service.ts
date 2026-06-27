import type {
  MemoryEntryKind,
  MemoryForgetReason,
  MemoryV6ReviewSearchRequest,
} from "../src/memory-v6/memory-contract.js";
import type {
  MemoryV6ReviewEntryDetail,
  MemoryV6ReviewForgetResult,
  MemoryV6ReviewSearchResult,
} from "../src/memory-v6/memory-review-state.js";
import { MemoryV6Storage } from "./memory-v6-storage.js";

export type MemoryV6ReviewServiceDeps = {
  resolveDbPath(): string | null;
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

  searchEntries(request: MemoryV6ReviewSearchRequest | null | undefined): MemoryV6ReviewSearchResult {
    return this.withStorage((storage) => storage.searchEntriesForReview(normalizeSearchRequest(request)));
  }

  getEntry(entryId: string): MemoryV6ReviewEntryDetail | null {
    const normalizedEntryId = entryId.trim();
    if (!normalizedEntryId) {
      return null;
    }
    return this.withStorage((storage) => {
      const entry = storage.getEntry(normalizedEntryId);
      return entry?.state === "active" ? entry : null;
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
      return runner(storage);
    } finally {
      storage.close();
    }
  }
}
