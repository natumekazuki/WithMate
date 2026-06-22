import type {
  MemoryEntryKind,
  MemoryEntryState,
  MemoryTag,
} from "./memory-contract.js";

export type MemoryOwnerRef =
  | { type: "character"; id: string }
  | { type: "project"; id: string }
  | { type: "user"; id: "local-user" };

export type MemoryScopeRef =
  | { type: "session"; id: string }
  | { type: "project"; id: string }
  | { type: "character"; id: string }
  | { type: "global"; id: "global" };

export type MemorySource = {
  type: "agent" | "manual" | "migration";
  sessionId: string | null;
  messageId: string | null;
  providerId: string | null;
};

export type MemoryEntrySummary = {
  id: string;
  owner: MemoryOwnerRef;
  scope: MemoryScopeRef;
  kind: MemoryEntryKind;
  title: string;
  preview: string;
  state: MemoryEntryState;
  tags: MemoryTag[];
  createdAt: string;
  updatedAt: string;
};

export type MemoryEntryDetail = MemoryEntrySummary & {
  body: string;
  source: MemorySource;
  supersedes: string[];
  supersededBy: string | null;
  forgottenAt: string | null;
};

export type MemorySearchHit = Omit<MemoryEntrySummary, "state">;

export function toMemoryEntrySummary(entry: MemoryEntryDetail): MemoryEntrySummary {
  return {
    id: entry.id,
    owner: entry.owner,
    scope: entry.scope,
    kind: entry.kind,
    title: entry.title,
    preview: entry.preview,
    state: entry.state,
    tags: entry.tags,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

export function toMemorySearchHit(entry: MemoryEntryDetail): MemorySearchHit | null {
  if (entry.state !== "active") {
    return null;
  }

  return {
    id: entry.id,
    owner: entry.owner,
    scope: entry.scope,
    kind: entry.kind,
    title: entry.title,
    preview: entry.preview,
    tags: entry.tags,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}
