import type { SQLInputValue } from "node:sqlite";

import type { NormalizedMemoryTag } from "../src/memory-v6/memory-contract.js";
import type {
  MemoryOwnerRef,
  MemoryScopeRef,
  MemorySource,
} from "../src/memory-v6/memory-state.js";

export type MemoryV6ResolvedTarget = {
  owner: MemoryOwnerRef;
  scope: MemoryScopeRef;
};

export type MemoryV6StorageSource = MemorySource & {
  appMessageId?: number | null;
};

export type MemoryV6EntryRow = {
  id: string;
  owner_type: MemoryOwnerRef["type"];
  owner_id: string;
  scope_type: MemoryScopeRef["type"];
  scope_id: string;
  kind: string;
  title: string;
  body: string;
  body_sha256: string;
  preview: string;
  state: string;
  source_type: MemorySource["type"];
  source_session_id: string | null;
  source_app_message_id: number | null;
  source_provider_message_id: string | null;
  source_provider_id: string | null;
  superseded_by_id: string | null;
  created_at: string;
  updated_at: string;
  forgotten_at: string | null;
};

export type MemoryV6TagRow = {
  tag_type: string;
  tag_value: string;
  tag_type_canonical: string;
  tag_value_canonical: string;
};

export const MEMORY_V6_ENTRY_SELECT_COLUMNS = `
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
`;

export function targetWhereSql(alias: string, targets: readonly MemoryV6ResolvedTarget[]): { sql: string; params: SQLInputValue[] } {
  if (targets.length === 0) {
    return { sql: "0", params: [] };
  }

  const clauses: string[] = [];
  const params: SQLInputValue[] = [];
  for (const target of targets) {
    clauses.push(`(${alias}.owner_type = ? AND ${alias}.owner_id = ? AND ${alias}.scope_type = ? AND ${alias}.scope_id = ?)`);
    params.push(target.owner.type, target.owner.id, target.scope.type, target.scope.id);
  }

  return {
    sql: clauses.join(" OR "),
    params,
  };
}

export function targetKey(target: MemoryV6ResolvedTarget): string {
  return `${target.owner.type}\0${target.owner.id}\0${target.scope.type}\0${target.scope.id}`;
}

export function tagIdentityKey(tag: Pick<NormalizedMemoryTag, "canonicalType" | "canonicalValue">): string {
  return `${tag.canonicalType}\0${tag.canonicalValue}`;
}
