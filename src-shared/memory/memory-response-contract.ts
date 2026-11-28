import {
  MEMORY_V6_SCHEMA_VERSION,
  type MemoryError,
  type MemoryTag,
  type MemoryTargetSelector,
  type MemoryV6SchemaVersion,
} from "./memory-contract.js";
import type { CharacterCatalogEntry } from "../character/character-catalog.js";
import {
  toMemoryEntrySummary,
  validateMemoryEntryDetailInvariant,
  type MemoryEntryDetail,
  type MemoryEntrySummary,
  type MemorySearchHit,
} from "./memory-state.js";

/** 検索の一致項目と、取得できた場合の関連タグおよび次ページの位置。 */
export type MemorySearchResponse = {
  schemaVersion: MemoryV6SchemaVersion;
  items: MemorySearchHit[];
  relatedTags?: MemoryTag[];
  nextCursor?: string;
};

/** 現行エントリーの本文と由来を含む取得成功の応答。 */
export type MemoryGetEntryResponse = {
  schemaVersion: MemoryV6SchemaVersion;
  entry: MemoryEntryDetail;
};

/** 単一の添付オブジェクトの出力先と、実際に書き出したバイト数を示す応答。 */
export type MemoryGetFileResponse = {
  schemaVersion: MemoryV6SchemaVersion;
  objectId: string;
  entryId: string;
  outputPath: string;
  bytesWritten: number;
  contentType: string;
  displayName: string;
};

/** 一括出力された個別ファイルの識別子、保存先、出力サイズと表示情報。 */
export type MemoryExportedFile = {
  objectId: string;
  outputPath: string;
  bytesWritten: number;
  contentType: string;
  displayName: string;
};

/** エントリーに属する添付の出力先ディレクトリと、書き出されたファイルの一覧。 */
export type MemoryExportFilesResponse = {
  schemaVersion: MemoryV6SchemaVersion;
  entryId: string;
  outputDirectoryPath: string;
  exportedCount: number;
  files: MemoryExportedFile[];
};

/** タグ一覧のページ。利用件数、最終更新時刻、サンプルは取得されたものだけを含む。 */
export type MemoryListTagsResponse = {
  schemaVersion: MemoryV6SchemaVersion;
  tags: Array<
    MemoryTag & {
      entryCount?: number;
      latestUpdatedAt?: string;
      samples?: Array<{ id: string; title: string }>;
    }
  >;
  nextCursor?: string;
};

/** 所有者・適用範囲を特定する情報と、対象内の件数・最終更新時刻をまとめた一覧項目。 */
export type MemoryTargetInventoryItem = {
  target: MemoryTargetSelector;
  owner: MemoryTargetSelector["owner"];
  scope: MemoryTargetSelector["scope"];
  project?: { id: string; displayName: string; path?: string };
  character?: { id: string; displayName: string };
  entryCount: number;
  tagCount: number;
  lastUpdatedAt: string | null;
};

/** 対象一覧のページ。続きがある場合は再開用のカーソルを持つ。 */
export type MemoryListTargetsResponse = {
  schemaVersion: MemoryV6SchemaVersion;
  items: MemoryTargetInventoryItem[];
  nextCursor?: string;
};

/** エントリー一覧用の要約に置換関係を加え、要求に応じて本文を持つ項目。 */
export type MemoryEntryListItem = MemoryEntrySummary & {
  body?: string;
  supersedes: string[];
  supersededBy: string | null;
};

/** 条件に一致したエントリー一覧のページ。 */
export type MemoryListEntriesResponse = {
  schemaVersion: MemoryV6SchemaVersion;
  items: MemoryEntryListItem[];
  nextCursor?: string;
};

/** 監査で確認が必要とされたエントリーの要約と、その判定理由。 */
export type MemoryAuditCandidate = {
  id: string;
  title: string;
  preview: string;
  updatedAt: string;
  reasons: string[];
};

/** 一つの対象について、種類別件数、頻出タグ、理由別の監査候補をまとめた結果。 */
export type MemoryTargetAudit = {
  target: MemoryTargetInventoryItem;
  countsByKind: Partial<Record<MemoryEntrySummary["kind"], number>>;
  topTags: Array<MemoryTag & { entryCount: number; latestUpdatedAt: string }>;
  staleOrProgressCandidates: MemoryAuditCandidate[];
  wrongScopeCandidates: MemoryAuditCandidate[];
  duplicateTitleCandidates: Array<{
    normalizedTitle: string;
    entries: MemoryAuditCandidate[];
  }>;
  documentationCandidates: MemoryAuditCandidate[];
  suspiciousTagCandidates: MemoryAuditCandidate[];
};

/** 監査時点と古さの判定基準、対象別の監査結果を返すページ。 */
export type MemoryAuditResponse = {
  schemaVersion: MemoryV6SchemaVersion;
  generatedAt: string;
  staleBefore: string;
  targets: MemoryTargetAudit[];
  nextCursor?: string;
};

/** Memory の対象を選ぶ際に表示するキャラクターの ID・名前・説明。 */
export type MemoryCharacterSummary = {
  id: string;
  name: string;
  description?: string;
};

/** キャラクター一覧を Memory の公開形式で返す応答。 */
export type MemoryListCharactersResponse = {
  schemaVersion: MemoryV6SchemaVersion;
  characters: MemoryCharacterSummary[];
};

/** 添付の利用量と上限、回収待ちの容量を区別する応答。大きいエントリーを任意で含む。 */
export type MemoryFileUsageResponse = {
  schemaVersion: MemoryV6SchemaVersion;
  quotaBytes: number;
  usedBytes: number;
  /**
   * DB メタデータ上で active / delete_pending として把握している暗号化オブジェクトのサイズ。
   * DB から参照されていないオブジェクトファイルは、GC の dry-run の orphanFiles で確認する。
   */
  physicalBytes: number;
  pendingDeleteBytes: number;
  availableBytes: number;
  objectCount: number;
  pendingDeleteCount: number;
  quotaExceeded: boolean;
  largestEntries?: MemoryLargestFileEntry[];
};

/** 添付容量の大きいエントリーを比較するための合計サイズとファイル数。 */
export type MemoryLargestFileEntry = {
  entryId: string;
  title: string;
  preview: string;
  totalFileBytes: number;
  fileCount: number;
  updatedAt: string;
};

/** 追加後の要約と、最初の操作による新規作成か冪等な再実行かを区別する応答。 */
export type MemoryAppendResponse = {
  schemaVersion: MemoryV6SchemaVersion;
  entry: MemoryEntrySummary;
  /**
   * 最初の冪等な append 操作でこのエントリーを作成した場合に true。
   * 冪等な再実行では、現在のアクセス権と状態を検査した後に同じ値を返す。
   */
  created: boolean;
  replayed?: true;
};

/** 忘却の対象ごとに、新規に忘却したか、忘却済みか、見つからないかを区別する状態。 */
export type MemoryForgetResultStatus =
  "forgotten" | "already_forgotten" | "not_found";

/** 一括追加の項目ごとの保存・失敗・結果不明・未実行を入力順の索引で対応付ける応答。 */
export type MemoryAppendEntriesResponse = {
  schemaVersion: MemoryV6SchemaVersion;
  results: Array<
    | { index: number; status: "saved"; result: MemoryAppendResponse }
    | {
        index: number;
        status: "failed" | "unknown";
        result: MemoryErrorResponse;
      }
    | { index: number; status: "not_run" }
  >;
  error?: MemoryError;
};

/** 単一 ID に対する忘却結果。再実行と対象不一致の情報は該当時に補う。 */
export type MemoryForgetResult = {
  entryId: string;
  status: MemoryForgetResultStatus;
  replayed?: true;
  entry?: MemoryEntrySummary;
  warning?: "target_mismatch_or_not_found";
};

/** 忘却の項目別結果。事前確認だけの場合は保存が行われなかったことを明示する。 */
export type MemoryForgetResponse = {
  schemaVersion: MemoryV6SchemaVersion;
  results: MemoryForgetResult[];
  dryRun?: true;
  writeOccurred?: false;
};

/** 移動後の要約と、実際の移動有無、元と先を返す応答。 */
export type MemoryMoveEntryResponse = {
  schemaVersion: MemoryV6SchemaVersion;
  entry: MemoryEntrySummary;
  moved: boolean;
  replayed?: true;
  from: MemoryTargetSelector;
  to: MemoryTargetSelector;
};

/** エラー時にも公開形式の版と構造化エラーを一緒に返す応答。 */
export type MemoryErrorResponse = {
  schemaVersion: MemoryV6SchemaVersion;
  error: MemoryError;
};

/** 検索結果に形式の版を付け、関連タグは表示用の種別・値だけを返す。 */
export function createMemorySearchResponse(
  items: readonly MemorySearchHit[],
  options:
    string | { nextCursor?: string; relatedTags?: readonly MemoryTag[] } = {},
): MemorySearchResponse {
  const normalizedOptions =
    typeof options === "string" ? { nextCursor: options } : options;
  return {
    schemaVersion: MEMORY_V6_SCHEMA_VERSION,
    items: [...items],
    ...(normalizedOptions.relatedTags &&
    normalizedOptions.relatedTags.length > 0
      ? {
          relatedTags: normalizedOptions.relatedTags.map((tag) => ({
            type: tag.type,
            value: tag.value,
          })),
        }
      : {}),
    ...(normalizedOptions.nextCursor === undefined
      ? {}
      : { nextCursor: normalizedOptions.nextCursor }),
  };
}

/** 詳細を返すのは状態整合性を満たす現行エントリーに限り、それ以外は未検出として扱う。 */
export function createMemoryGetEntryResponse(
  entry: MemoryEntryDetail | null,
): MemoryGetEntryResponse | MemoryErrorResponse {
  if (
    entry === null ||
    entry.state !== "active" ||
    !validateMemoryEntryDetailInvariant(entry)
  ) {
    return createMemoryErrorResponse({
      code: "MEMORY_ENTRY_NOT_FOUND",
      message: "Memory entry was not found.",
    });
  }

  return {
    schemaVersion: MEMORY_V6_SCHEMA_VERSION,
    entry,
  };
}

/** 出力済みの単一ファイルに関するメタデータを公開形式へ写す。ファイル自体は操作しない。 */
export function createMemoryGetFileResponse(input: {
  objectId: string;
  entryId: string;
  outputPath: string;
  bytesWritten: number;
  contentType: string;
  displayName: string;
}): MemoryGetFileResponse {
  return {
    schemaVersion: MEMORY_V6_SCHEMA_VERSION,
    objectId: input.objectId,
    entryId: input.entryId,
    outputPath: input.outputPath,
    bytesWritten: input.bytesWritten,
    contentType: input.contentType,
    displayName: input.displayName,
  };
}

/** 書き出したファイルの情報から一覧を組み立て、件数を一覧の長さで確定する。 */
export function createMemoryExportFilesResponse(input: {
  entryId: string;
  outputDirectoryPath: string;
  files: readonly MemoryExportedFile[];
}): MemoryExportFilesResponse {
  return {
    schemaVersion: MEMORY_V6_SCHEMA_VERSION,
    entryId: input.entryId,
    outputDirectoryPath: input.outputDirectoryPath,
    exportedCount: input.files.length,
    files: input.files.map((file) => ({
      objectId: file.objectId,
      outputPath: file.outputPath,
      bytesWritten: file.bytesWritten,
      contentType: file.contentType,
      displayName: file.displayName,
    })),
  };
}

/** タグ一覧を公開項目へ写し、指定されなかった集計値や次ページの位置を省く。 */
export function createMemoryListTagsResponse(
  tags: MemoryListTagsResponse["tags"],
  nextCursor?: string,
): MemoryListTagsResponse {
  return {
    schemaVersion: MEMORY_V6_SCHEMA_VERSION,
    tags: tags.map((tag) => ({
      type: tag.type,
      value: tag.value,
      ...(tag.entryCount === undefined ? {} : { entryCount: tag.entryCount }),
      ...(tag.latestUpdatedAt === undefined
        ? {}
        : { latestUpdatedAt: tag.latestUpdatedAt }),
      ...(tag.samples === undefined
        ? {}
        : { samples: tag.samples.map((sample) => ({ ...sample })) }),
    })),
    ...(nextCursor === undefined ? {} : { nextCursor }),
  };
}

/** 対象の一覧をページ応答に包み、次ページの位置は指定時だけ付ける。 */
export function createMemoryListTargetsResponse(
  items: readonly MemoryTargetInventoryItem[],
  nextCursor?: string,
): MemoryListTargetsResponse {
  return {
    schemaVersion: MEMORY_V6_SCHEMA_VERSION,
    items: items.map((item) => ({ ...item })),
    ...(nextCursor === undefined ? {} : { nextCursor }),
  };
}

/** エントリー一覧を受け取り、本文の有無を保ったままページ応答に包む。 */
export function createMemoryListEntriesResponse(
  items: readonly MemoryEntryListItem[],
  nextCursor?: string,
): MemoryListEntriesResponse {
  return {
    schemaVersion: MEMORY_V6_SCHEMA_VERSION,
    items: items.map((item) => ({ ...item })),
    ...(nextCursor === undefined ? {} : { nextCursor }),
  };
}

/** 呼び出し元で集計済みの監査結果に公開形式の版を付ける。 */
export function createMemoryAuditResponse(
  input: Omit<MemoryAuditResponse, "schemaVersion">,
): MemoryAuditResponse {
  return {
    schemaVersion: MEMORY_V6_SCHEMA_VERSION,
    ...input,
  };
}

/** キャラクターの公開情報を取り出し、前後の空白を除いた説明が空なら省く。 */
export function createMemoryListCharactersResponse(
  characters: readonly CharacterCatalogEntry[],
): MemoryListCharactersResponse {
  return {
    schemaVersion: MEMORY_V6_SCHEMA_VERSION,
    characters: characters.map((character) => {
      const description = character.description.trim();
      return {
        id: character.id,
        name: character.name,
        ...(description.length > 0 ? { description } : {}),
      };
    }),
  };
}

/** 集計済みの添付利用量から残容量と超過を計算し、残容量は負にしない。 */
export function createMemoryFileUsageResponse(input: {
  quotaBytes: number;
  usedBytes: number;
  physicalBytes: number;
  pendingDeleteBytes: number;
  objectCount: number;
  pendingDeleteCount: number;
  largestEntries?: readonly MemoryLargestFileEntry[];
}): MemoryFileUsageResponse {
  return {
    schemaVersion: MEMORY_V6_SCHEMA_VERSION,
    quotaBytes: input.quotaBytes,
    usedBytes: input.usedBytes,
    physicalBytes: input.physicalBytes,
    pendingDeleteBytes: input.pendingDeleteBytes,
    availableBytes: Math.max(0, input.quotaBytes - input.usedBytes),
    objectCount: input.objectCount,
    pendingDeleteCount: input.pendingDeleteCount,
    quotaExceeded: input.usedBytes > input.quotaBytes,
    ...(input.largestEntries === undefined
      ? {}
      : {
          largestEntries: input.largestEntries.map((entry) => ({
            entryId: entry.entryId,
            title: entry.title,
            preview: entry.preview,
            totalFileBytes: entry.totalFileBytes,
            fileCount: entry.fileCount,
            updatedAt: entry.updatedAt,
          })),
        }),
  };
}

/** 追加後の詳細を要約に変換し、再実行時だけ再送の印を付ける。 */
export function createMemoryAppendResponse(
  entry: MemoryEntryDetail,
  created: boolean,
  replayed = false,
): MemoryAppendResponse {
  return {
    schemaVersion: MEMORY_V6_SCHEMA_VERSION,
    entry: toMemoryEntrySummary(entry),
    created,
    ...(replayed ? { replayed: true as const } : {}),
  };
}

/** 忘却の項目別結果をまとめ、事前確認の場合は書き込みなしの印を付ける。 */
export function createMemoryForgetResponse(
  results: readonly MemoryForgetResult[],
  options: { dryRun?: boolean } = {},
): MemoryForgetResponse {
  return {
    schemaVersion: MEMORY_V6_SCHEMA_VERSION,
    results: results.map((result) => ({ ...result })),
    ...(options.dryRun
      ? { dryRun: true as const, writeOccurred: false as const }
      : {}),
  };
}

/** 移動後の詳細を要約に変換し、移動元・移動先と実行結果をそろえる。 */
export function createMemoryMoveEntryResponse(input: {
  entry: MemoryEntryDetail;
  moved: boolean;
  replayed?: true;
  from: MemoryTargetSelector;
  to: MemoryTargetSelector;
}): MemoryMoveEntryResponse {
  return {
    schemaVersion: MEMORY_V6_SCHEMA_VERSION,
    entry: toMemoryEntrySummary(input.entry),
    moved: input.moved,
    ...(input.replayed ? { replayed: true as const } : {}),
    from: input.from,
    to: input.to,
  };
}

/** 操作または検証で得たエラーを、内容を変えず共通の応答形式に包む。 */
export function createMemoryErrorResponse(
  error: MemoryError,
): MemoryErrorResponse {
  return {
    schemaVersion: MEMORY_V6_SCHEMA_VERSION,
    error,
  };
}
