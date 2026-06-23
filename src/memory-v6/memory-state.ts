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

type MemoryEntryDetailBase = Omit<MemoryEntrySummary, "state"> & {
  body: string;
  source: MemorySource;
  supersedes: string[];
};

export type ActiveMemoryEntryDetail = MemoryEntryDetailBase & {
  state: "active";
  supersededBy: null;
  forgottenAt: null;
};

export type SupersededMemoryEntryDetail = MemoryEntryDetailBase & {
  state: "superseded";
  supersededBy: string;
  forgottenAt: null;
};

export type ForgottenMemoryEntryDetail = MemoryEntryDetailBase & {
  state: "forgotten";
  supersededBy: string | null;
  forgottenAt: string;
};

export type MemoryEntryDetail =
  | ActiveMemoryEntryDetail
  | SupersededMemoryEntryDetail
  | ForgottenMemoryEntryDetail;

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

export function toMemorySearchHit(entry: ActiveMemoryEntryDetail): MemorySearchHit {
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

export function validateMemoryEntryDetailInvariant(entry: MemoryEntryDetail): boolean {
  if (entry.state === "active") {
    return entry.supersededBy === null && entry.forgottenAt === null;
  }

  if (entry.state === "superseded") {
    return entry.supersededBy !== null && entry.forgottenAt === null;
  }

  return entry.forgottenAt !== null;
}
