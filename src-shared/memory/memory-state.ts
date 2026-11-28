import type {
  MemoryEntryKind,
  MemoryEntryState,
  MemoryAppendFileRole,
  MemoryTag,
} from "./memory-contract.js";

/** エントリーの所有主体を識別する参照。ユーザー所有はローカルユーザーを指す。 */
export type MemoryOwnerRef =
  | { type: "character"; id: string }
  | { type: "project"; id: string }
  | { type: "user"; id: "local-user" };

/** エントリーが適用される範囲の参照。所有主体とは独立して保持する。 */
export type MemoryScopeRef =
  | { type: "session"; id: string }
  | { type: "project"; id: string }
  | { type: "character"; id: string }
  | { type: "global"; id: "global" };

/** エントリーが作られた経路と、追跡できる場合のセッション・メッセージ・プロバイダー。 */
export type MemorySource = {
  type: "agent" | "manual" | "migration";
  sessionId: string | null;
  auxiliarySessionId?: string;
  messageId: string | null;
  providerId: string | null;
};

/** エントリーの現在の状態、表示項目、タグ、添付概要を本文や由来から分離した要約。 */
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

/** 添付のオブジェクト ID と内容を表す概要。ファイル本体は含まない。 */
export type MemoryFileSummary = {
  objectId: string;
  role: MemoryAppendFileRole;
  mediaKind: "image" | "text" | "source" | "archive" | "document" | "other";
  contentType: string;
  displayName: string;
  summary: string;
  originalBytes: number;
};

/** 状態別の詳細に共通する本文、由来と置換元エントリーの情報。 */
type MemoryEntryDetailBase = Omit<MemoryEntrySummary, "state"> & {
  body: string;
  source: MemorySource;
  supersedes: string[];
};

/** 現行エントリーの詳細。後継への参照も忘却日時も持たない。 */
export type ActiveMemoryEntryDetail = MemoryEntryDetailBase & {
  state: "active";
  supersededBy: null;
  forgottenAt: null;
};

/** 後継へ置換されたエントリーの詳細。後継 ID を持ち、忘却日時は持たない。 */
export type SupersededMemoryEntryDetail = MemoryEntryDetailBase & {
  state: "superseded";
  supersededBy: string;
  forgottenAt: null;
};

/** 忘却日時を持つエントリーの詳細。置換を経ている場合は後継 ID も残る。 */
export type ForgottenMemoryEntryDetail = MemoryEntryDetailBase & {
  state: "forgotten";
  supersededBy: string | null;
  forgottenAt: string;
};

/** 現行・置換済み・忘却済みの状態で、後継参照と忘却日時の条件を判別できる詳細。 */
export type MemoryEntryDetail =
  | ActiveMemoryEntryDetail
  | SupersededMemoryEntryDetail
  | ForgottenMemoryEntryDetail;

/** 検索語が一致した箇所を、表示項目・本文・タグの単位で示す値。 */
export type MemorySearchMatchField = "title" | "preview" | "body" | "tags";

/** 検索語が一致したフィールドと、取得できた場合の抜粋。 */
export type MemorySearchMatch = {
  fields: MemorySearchMatchField[];
  snippet?: string;
};

/** 現行エントリーを対象とした検索結果。状態を省き、必要なら一致情報を持つ。 */
export type MemorySearchHit = Omit<MemoryEntrySummary, "state"> & {
  match?: MemorySearchMatch;
};

/** 本文や由来、置換関係を除いた一覧用の要約に変換し、添付が空なら省く。 */
export function toMemoryEntrySummary(
  entry: MemoryEntryDetail,
): MemoryEntrySummary {
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

/** 現行エントリーを検索用に投影し、一致情報が渡されたときだけ含める。 */
export function toMemorySearchHit(
  entry: ActiveMemoryEntryDetail,
  match?: MemorySearchMatch,
): MemorySearchHit {
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

/** 詳細の状態に対して後継 ID と忘却日時の有無が矛盾しないかを確かめる。 */
export function validateMemoryEntryDetailInvariant(
  entry: MemoryEntryDetail,
): boolean {
  if (entry.state === "active") {
    return entry.supersededBy === null && entry.forgottenAt === null;
  }

  if (entry.state === "superseded") {
    return entry.supersededBy !== null && entry.forgottenAt === null;
  }

  return entry.forgottenAt !== null;
}
