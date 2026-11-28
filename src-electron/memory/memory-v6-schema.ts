import type { SQLInputValue } from "node:sqlite";

import type { NormalizedMemoryTag } from "../../src-shared/memory/memory-contract.js";
import type { ResolvedProjectScopeInput } from "../platform/project-scope.js";
import type {
  MemoryOwnerRef,
  MemoryScopeRef,
  MemorySource,
} from "../../src-shared/memory/memory-state.js";

/** 旧 V6 Memory で対象を一意に絞る所有者とスコープの組。 */
export type MemoryV6ResolvedTarget = {
  owner: MemoryOwnerRef;
  scope: MemoryScopeRef;
};

/** 旧 V6 Memory のプロジェクト範囲と、それに紐付いた保存 ID。 */
export type MemoryV6ProjectScopeAdmission = ResolvedProjectScopeInput & {
  id: string;
};

/** 旧 V6 Memory の由来情報に、存在する場合はアプリ内メッセージの ID も保持する。 */
export type MemoryV6StorageSource = MemorySource & {
  appMessageId?: number | null;
};

/** 旧 V6 Memory の本文、検索用プレビュー、由来、状態と更新履歴を取得する行形式。 */
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
  source_auxiliary_session_id: string | null;
  source_app_message_id: number | null;
  source_provider_message_id: string | null;
  source_provider_id: string | null;
  superseded_by_id: string | null;
  created_at: string;
  updated_at: string;
  forgotten_at: string | null;
};

/** 旧 V6 Memory のタグで、表示値と同一性の照合に使う正規化値を区別する。 */
export type MemoryV6TagRow = {
  tag_type: string;
  tag_value: string;
  tag_type_canonical: string;
  tag_value_canonical: string;
};

/** 旧 V6 の読み取り列を組み立てる。本文を読まない場合も行形式に合わせた空の本文列を返す。 */
export function memoryV6EntrySelectColumns(includeBody = true): string {
  return `
  id,
  owner_type,
  owner_id,
  scope_type,
  scope_id,
  kind,
  title,
  ${includeBody ? "body" : "'' AS body"},
  body_sha256,
  preview,
  state,
  source_type,
  source_session_id,
  source_auxiliary_session_id,
  source_app_message_id,
  source_provider_message_id,
  source_provider_id,
  superseded_by_id,
  created_at,
  updated_at,
  forgotten_at
`;
}

/** 旧 V6 Memory の本文を含む読み取り用の列一覧。 */
export const MEMORY_V6_ENTRY_SELECT_COLUMNS = memoryV6EntrySelectColumns();

/** 旧 V6 の所有者・スコープの組をプレースホルダー付きで絞り込む。対象がなければどの行にも一致させない。 */
export function targetWhereSql(
  alias: string,
  targets: readonly MemoryV6ResolvedTarget[],
): { sql: string; params: SQLInputValue[] } {
  if (targets.length === 0) {
    return { sql: "0", params: [] };
  }

  const clauses: string[] = [];
  const params: SQLInputValue[] = [];
  for (const target of targets) {
    clauses.push(
      `(${alias}.owner_type = ? AND ${alias}.owner_id = ? AND ${alias}.scope_type = ? AND ${alias}.scope_id = ?)`,
    );
    params.push(
      target.owner.type,
      target.owner.id,
      target.scope.type,
      target.scope.id,
    );
  }

  return {
    sql: clauses.join(" OR "),
    params,
  };
}

/** 旧 V6 Memory の対象について、所有者とスコープの種別・ID を区切ってキー化する。 */
export function targetKey(target: MemoryV6ResolvedTarget): string {
  return `${target.owner.type}\0${target.owner.id}\0${target.scope.type}\0${target.scope.id}`;
}

/** タグの表示値ではなく、正規化済みの種別と値を区切って同一性のキーを作る。 */
export function tagIdentityKey(
  tag: Pick<NormalizedMemoryTag, "canonicalType" | "canonicalValue">,
): string {
  return `${tag.canonicalType}\0${tag.canonicalValue}`;
}
