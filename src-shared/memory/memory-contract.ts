/** Memory の要求と応答を識別する公開形式のバージョン。DB スキーマのバージョンとは別に扱う。 */
export const MEMORY_V6_SCHEMA_VERSION = "withmate-memory-v1" as const;

/** 検索など、通常のページ取得で指定できる最大件数。 */
export const MEMORY_RESULT_LIMIT_MAX = 50;

/** 現行の公開形式に固定したスキーマ識別子。 */
export type MemoryV6SchemaVersion = typeof MEMORY_V6_SCHEMA_VERSION;

/** エントリーが現行か、後継に置換済みか、忘却済みかを表す。 */
export type MemoryEntryState = "active" | "superseded" | "forgotten";

/** エントリーの作成と種類による絞り込みで受け付ける分類値。 */
export const MEMORY_ENTRY_KINDS = [
  "decision",
  "constraint",
  "convention",
  "context",
  "deferred",
  "preference",
  "relationship",
  "boundary",
  "note",
] as const;

/** Memory エントリーの内容に応じて選ぶ分類。 */
export type MemoryEntryKind = (typeof MEMORY_ENTRY_KINDS)[number];

/** Memory 操作ごとに区別する権限名。閲覧・変更・ファイル出力は別の権限で表す。 */
export type MemoryPermission =
  | "memory.list_targets"
  | "memory.list_entries"
  | "memory.audit"
  | "memory.search"
  | "memory.append"
  | "memory.forget"
  | "memory.move_entry"
  | "memory.get_entry"
  | "memory.get_file"
  | "memory.export_files"
  | "memory.list_tags"
  | "memory.list_characters"
  | "memory.file_usage";

/** プロジェクトを登録 ID または絶対パスで指定する入力。 */
export type ProjectTargetRef =
  { type: "id"; id: string } | { type: "path"; path: string };

/** キャラクターを名前ではなく登録 ID で指定する入力。 */
export type CharacterTargetRef = { type: "id"; id: string };

/** 所有者と適用範囲の許可された組み合わせを表し、選んだ範囲に必要な参照だけを持つ。 */
export type MemoryTargetSelector<
  ProjectRef extends ProjectTargetRef = ProjectTargetRef,
> =
  | { owner: "project"; project: ProjectRef; scope: "project" }
  | { owner: "character"; character: CharacterTargetRef; scope: "character" }
  | {
      owner: "character";
      character: CharacterTargetRef;
      scope: "project";
      project: ProjectRef;
    }
  | { owner: "user"; scope: "global" };

/** 表示時の表記を保持するタグの種別と値。 */
export type MemoryTag = {
  type: string;
  value: string;
};

/** 表示用の表記に加え、照合と重複排除に使う正規形を持つタグ。 */
export type NormalizedMemoryTag = MemoryTag & {
  canonicalType: string;
  canonicalValue: string;
};

/** 一つ以上の対象を検索し、種類・タグでの絞り込みや前ページからの再開を指定する。 */
export type MemorySearchRequest = {
  schemaVersion: MemoryV6SchemaVersion;
  targets: MemoryTargetSelector[];
  query: string;
  kinds?: MemoryEntryKind[];
  tags?: NormalizedMemoryTag[];
  limit?: number;
  cursor?: string;
};

/** 単一のエントリーを、その所属先と ID の組で指定する。 */
export type MemoryGetEntryRequest = {
  schemaVersion: MemoryV6SchemaVersion;
  entryId: string;
  target: MemoryTargetSelector;
};

/** 対象内の添付オブジェクトを指定した絶対パスへ出力する要求。 */
export type MemoryGetFileRequest = {
  schemaVersion: MemoryV6SchemaVersion;
  target: MemoryTargetSelector;
  objectId: string;
  outputPath: string;
};

/** 対象内のエントリーに属するファイルを指定ディレクトリへ出力する要求。 */
export type MemoryExportFilesRequest = {
  schemaVersion: MemoryV6SchemaVersion;
  target: MemoryTargetSelector;
  entryId: string;
  outputDirectoryPath: string;
};

/** 単一の対象のタグを列挙し、利用件数やサンプルの要否とページ位置を指定する。 */
export type MemoryListTagsRequest = {
  schemaVersion: MemoryV6SchemaVersion;
  targets: MemoryTargetSelector[];
  withCounts?: boolean;
  sampleLimit?: number;
  limit?: number;
  cursor?: string;
};

/** 対象一覧で選べる所有主体の分類。適用範囲とは独立したフィルター。 */
export type MemoryTargetOwner = MemoryTargetSelector["owner"];
/** 対象一覧で選べる適用範囲の分類。特定のプロジェクト ID とは区別する。 */
export type MemoryTargetScope = MemoryTargetSelector["scope"];

/** 所有者・適用範囲・参照先で対象を絞り込み、空の対象を含めるか指定する。 */
export type MemoryListTargetsRequest = {
  schemaVersion: MemoryV6SchemaVersion;
  owner?: MemoryTargetOwner;
  scope?: MemoryTargetScope;
  project?: ProjectTargetRef;
  character?: CharacterTargetRef;
  includeEmpty?: boolean;
  limit?: number;
  cursor?: string;
};

/** 単一の対象内で状態・種類・タグを絞り込み、本文の取得有無を選ぶ一覧要求。 */
export type MemoryListEntriesRequest = {
  schemaVersion: MemoryV6SchemaVersion;
  target: MemoryTargetSelector;
  states?: MemoryEntryState[];
  kinds?: MemoryEntryKind[];
  tags?: NormalizedMemoryTag[];
  includeBody?: boolean;
  limit?: number;
  cursor?: string;
};

/** 対象を列挙するか全対象を選び、古さの判定基準とページ位置を指定する監査要求。 */
export type MemoryAuditRequest = {
  schemaVersion: MemoryV6SchemaVersion;
  allTargets?: boolean;
  targets?: MemoryTargetSelector[];
  staleBefore?: string;
  limit?: number;
  cursor?: string;
};

/** エントリーに添付するファイルの位置付けとして受け付ける値。 */
export const MEMORY_APPEND_FILE_ROLES = [
  "evidence",
  "source",
  "snapshot",
  "artifact",
  "reference",
  "other",
] as const;

/** 添付が証拠、出典、成果物などのどの用途を担うかを示す分類。 */
export type MemoryAppendFileRole = (typeof MEMORY_APPEND_FILE_ROLES)[number];

/** 添付元パスと内容を説明する要約を指定し、表示名などを任意で補う。 */
export type MemoryAppendFileInput = {
  path: string;
  summary: string;
  role?: MemoryAppendFileRole;
  displayName?: string;
  contentType?: string;
};

/** 一つの対象へエントリーを記録し、添付・置換する既存項目・再送時の冪等キーを必要に応じて与える。 */
export type MemoryAppendRequest = {
  schemaVersion: MemoryV6SchemaVersion;
  target: MemoryTargetSelector;
  kind: MemoryEntryKind;
  title: string;
  body: string;
  preview: string;
  tags: NormalizedMemoryTag[];
  supersedes?: string[];
  mutationReason?: string;
  files?: MemoryAppendFileInput[];
  sourceMessageId?: string;
  idempotencyKey?: string;
};

/** 保存先や変更操作の情報を除いた、エントリーとして記録する内容。 */
export type MemoryEntryContent = Pick<
  MemoryAppendRequest,
  "kind" | "title" | "body" | "preview" | "tags"
>;

/** 一括追加の個別入力。保存先と形式の版をバッチと共有し、項目別に冪等キーを持つ。 */
export type MemoryAppendEntryInput = Omit<
  MemoryAppendRequest,
  "schemaVersion" | "target" | "idempotencyKey"
> & {
  idempotencyKey: string;
};

/** 共通の対象へ複数のエントリーを追加する要求。 */
export type MemoryAppendEntriesRequest = {
  schemaVersion: MemoryV6SchemaVersion;
  target: MemoryTargetSelector;
  entries: MemoryAppendEntryInput[];
};

/** 忘却操作の理由として受け付ける分類値。 */
export const MEMORY_FORGET_REASONS = [
  "user_request",
  "incorrect",
  "outdated",
  "privacy",
  "other",
] as const;

/** 忘却の理由をユーザー依頼、誤り、陳腐化、プライバシーなどで区別する分類。 */
export type MemoryForgetReason = (typeof MEMORY_FORGET_REASONS)[number];

/** 同一対象内のエントリーを ID で忘却し、必要に応じて保存を伴わない確認を指定する。 */
export type MemoryForgetRequest = {
  schemaVersion: MemoryV6SchemaVersion;
  target: MemoryTargetSelector;
  entryIds: string[];
  reason?: MemoryForgetReason;
  sourceMessageId?: string;
  idempotencyKey?: string;
  dryRun?: boolean;
};

/** 一つのエントリーの移動元と移動先を指定し、移動理由を記録する要求。 */
export type MemoryMoveEntryRequest = {
  schemaVersion: MemoryV6SchemaVersion;
  entryId: string;
  from: MemoryTargetSelector;
  to: MemoryTargetSelector;
  reason: string;
  sourceMessageId?: string;
  idempotencyKey?: string;
};

/** レビューで使う検索条件。キャラクター・プロジェクト・種類での絞り込みを指定できる。 */
export type MemoryV6ReviewSearchRequest = {
  query: string;
  characterId?: string;
  projectId?: string;
  kinds?: MemoryEntryKind[];
  limit?: number;
  cursor?: string;
};

/** Memory 操作の失敗を表し、必要に応じて対象フィールド、容量、再試行可否、保存への効果を補う。 */
export type MemoryError = {
  code: string;
  message: string;
  field?: string;
  quotaBytes?: number;
  usedBytes?: number;
  incomingBytes?: number;
  availableBytes?: number;
  allowedProjectTargets?: string[];
  suggestion?: string;
  retryable?: boolean;
  conversationMayContinue?: boolean;
  effect?: "none" | "committed" | "partial" | "unknown";
  details?: Record<string, unknown>;
};

/** 入力検証の結果。成功時に正規化済みの値、失敗時に構造化エラーを返す。 */
export type MemoryValidationResult<T> =
  { ok: true; value: T } | { ok: false; error: MemoryError };
