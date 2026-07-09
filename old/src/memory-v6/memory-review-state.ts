import type { MemoryEntryDetail, MemoryFileSummary, MemorySearchHit } from "./memory-state.js";
import type { MemoryForgetReason, MemoryV6ReviewSearchRequest, MemoryV6SchemaVersion } from "./memory-contract.js";
import type { MemoryFileUsageResponse } from "./memory-response-contract.js";

export type MemoryV6ReviewFileSummary = Omit<MemoryFileSummary, "objectId">;

export type MemoryV6ReviewSearchHit = Omit<MemorySearchHit, "files"> & {
  sourceSessionId: string | null;
  sourceProviderId: string | null;
  files?: MemoryV6ReviewFileSummary[];
};

export type MemoryV6ReviewSearchResult = {
  items: MemoryV6ReviewSearchHit[];
  nextCursor?: string;
};

export type MemoryV6ReviewEntryDetail = Omit<MemoryEntryDetail, "files"> & {
  files?: MemoryV6ReviewFileSummary[];
};

export type MemoryV6ReviewForgetResult = {
  entryId: string;
  status: "forgotten" | "already_forgotten" | "not_found";
  reason: MemoryForgetReason;
};

export type MemoryV6ReviewExportFilesResult = {
  entryId: string;
  exportedCount: number;
};

export type MemoryV6ProtectedObjectGcRequest = {
  dryRun: boolean;
  graceMs?: number;
  limit?: number;
};

export type MemoryV6ProtectedObjectGcSummary = {
  candidates: number;
  bytes?: number;
  deleted: number;
  missing?: number;
  failed: number;
};

export type MemoryV6ProtectedObjectGcResponse = {
  schemaVersion: MemoryV6SchemaVersion;
  dryRun: boolean;
  deletePending: MemoryV6ProtectedObjectGcSummary;
  orphanFiles: MemoryV6ProtectedObjectGcSummary;
  stagingFiles: Omit<MemoryV6ProtectedObjectGcSummary, "bytes" | "missing">;
  missingActiveObjects: number;
  fileUsage: MemoryFileUsageResponse;
  warnings: string[];
};

export type MemoryV6ReviewApi = {
  getMemoryV6FileUsage(): Promise<MemoryFileUsageResponse>;
  exportMemoryV6EntryFiles(entryId: string): Promise<MemoryV6ReviewExportFilesResult | null>;
  runMemoryV6ProtectedObjectGc(request: MemoryV6ProtectedObjectGcRequest): Promise<MemoryV6ProtectedObjectGcResponse>;
  searchMemoryV6Entries(request: MemoryV6ReviewSearchRequest): Promise<MemoryV6ReviewSearchResult>;
  getMemoryV6Entry(entryId: string): Promise<MemoryV6ReviewEntryDetail | null>;
  forgetMemoryV6Entry(entryId: string, reason?: MemoryForgetReason): Promise<MemoryV6ReviewForgetResult>;
};
