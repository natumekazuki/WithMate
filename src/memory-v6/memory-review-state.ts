import type { MemoryEntryDetail, MemorySearchHit } from "./memory-state.js";
import type { MemoryForgetReason, MemoryV6ReviewSearchRequest } from "./memory-contract.js";

export type MemoryV6ReviewSearchHit = MemorySearchHit & {
  sourceSessionId: string | null;
  sourceProviderId: string | null;
};

export type MemoryV6ReviewSearchResult = {
  items: MemoryV6ReviewSearchHit[];
  nextCursor?: string;
};

export type MemoryV6ReviewEntryDetail = MemoryEntryDetail;

export type MemoryV6ReviewForgetResult = {
  entryId: string;
  status: "forgotten" | "already_forgotten" | "not_found";
  reason: MemoryForgetReason;
};

export type MemoryV6ReviewApi = {
  searchMemoryV6Entries(request: MemoryV6ReviewSearchRequest): Promise<MemoryV6ReviewSearchResult>;
  getMemoryV6Entry(entryId: string): Promise<MemoryV6ReviewEntryDetail | null>;
  forgetMemoryV6Entry(entryId: string, reason?: MemoryForgetReason): Promise<MemoryV6ReviewForgetResult>;
};
