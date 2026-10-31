import type {
  MemoryEntryKind,
  MemoryEntryState,
  MemoryAppendFileRole,
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
  files?: MemoryFileSummary[];
};

export type MemoryFileSummary = {
  objectId: string;
  role: MemoryAppendFileRole;
  mediaKind: "image" | "text" | "source" | "archive" | "document" | "other";
  contentType: string;
  displayName: string;
  summary: string;
  originalBytes: number;
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

export type MemorySearchMatchField = "title" | "preview" | "body" | "tags";

export type MemorySearchMatch = {
  fields: MemorySearchMatchField[];
  snippet?: string;
};

export type MemorySearchHit = Omit<MemoryEntrySummary, "state"> & {
  match?: MemorySearchMatch;
};

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
    ...(entry.files && entry.files.length > 0 ? { files: entry.files } : {}),
  };
}

export function toMemorySearchHit(entry: ActiveMemoryEntryDetail, match?: MemorySearchMatch): MemorySearchHit {
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
    ...(entry.files && entry.files.length > 0 ? { files: entry.files } : {}),
    ...(match ? { match } : {}),
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
