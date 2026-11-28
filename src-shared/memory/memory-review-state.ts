import type {
  MemoryEntryDetail,
  MemoryFileSummary,
  MemorySearchHit,
} from "./memory-state.js";
import type {
  MemoryForgetReason,
  MemoryV6ReviewSearchRequest,
  MemoryV6SchemaVersion,
} from "./memory-contract.js";
import type { MemoryFileUsageResponse } from "./memory-response-contract.js";

/** レビューに表示する添付概要。内部で使うオブジェクト ID は含めない。 */
export type MemoryV6ReviewFileSummary = Omit<MemoryFileSummary, "objectId">;

/** レビュー対象のキャラクターを識別し、アーカイブ済みや登録が見つからない場合も区別できる情報。 */
export type MemoryV6ReviewCharacter = {
  id: string;
  name: string | null;
  iconFilePath: string | null;
  state: "active" | "archived" | "missing";
  disambiguation?: string;
};

/** レビュー対象のプロジェクトを識別し、登録情報が見つからない場合も区別できる情報。 */
export type MemoryV6ReviewProject = {
  id: string;
  name: string | null;
  path: string | null;
  state: "available" | "missing";
  disambiguation?: string;
};

/** レビューの絞り込みに使うキャラクターとプロジェクトの候補。 */
export type MemoryV6ReviewTargets = {
  characters: MemoryV6ReviewCharacter[];
  projects: MemoryV6ReviewProject[];
};

/** レビュー表示用の所属先。区分に応じてキャラクターやプロジェクトの情報を持つ。 */
export type MemoryV6ReviewTarget = {
  kind: "user-global" | "project" | "character" | "character-project";
  character?: MemoryV6ReviewCharacter;
  project?: MemoryV6ReviewProject;
};

/** 検索結果にレビュー表示用の所属先を加え、添付から内部オブジェクト ID を除いた項目。 */
export type MemoryV6ReviewSearchHit = Omit<MemorySearchHit, "files"> & {
  target: MemoryV6ReviewTarget;
  files?: MemoryV6ReviewFileSummary[];
};

/** レビュー検索の一致項目と、次の取得位置を示す任意のカーソル。 */
export type MemoryV6ReviewSearchResult = {
  items: MemoryV6ReviewSearchHit[];
  nextCursor?: string;
};

/** 本文や由来を含むエントリー詳細に、レビュー用の所属先と添付概要を持たせた型。 */
export type MemoryV6ReviewEntryDetail = Omit<MemoryEntryDetail, "files"> & {
  target: MemoryV6ReviewTarget;
  files?: MemoryV6ReviewFileSummary[];
};

/** レビューで指定したエントリーの忘却状態と、適用された理由。 */
export type MemoryV6ReviewForgetResult = {
  entryId: string;
  status: "forgotten" | "already_forgotten" | "not_found";
  reason: MemoryForgetReason;
};

/** エントリーの添付をまとめて書き出した結果。個別の出力パスは含まない。 */
export type MemoryV6ReviewExportFilesResult = {
  entryId: string;
  exportedCount: number;
};

/** 保護オブジェクト回収の実行条件。試行のみかどうかと、猶予や処理上限を指定する。 */
export type MemoryV6ProtectedObjectGcRequest = {
  dryRun: boolean;
  graceMs?: number;
  limit?: number;
};

/** 保護オブジェクト回収の候補数と削除・欠損・失敗の集計。容量は取得できる区分だけが持つ。 */
export type MemoryV6ProtectedObjectGcSummary = {
  candidates: number;
  bytes?: number;
  deleted: number;
  missing?: number;
  failed: number;
};

/** 保護オブジェクト回収を削除待ち・孤立・ステージングのファイルに分け、欠損と利用容量も示す結果。 */
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

/** Memory レビューで使う検索・詳細表示・忘却・添付の管理操作の契約。 */
export type MemoryV6ReviewApi = {
  /** レビューの絞り込み候補となるキャラクターとプロジェクトを取得する。 */
  listMemoryV6ReviewTargets(): Promise<MemoryV6ReviewTargets>;
  /** 添付の利用量と上限、回収待ち容量を取得する。 */
  getMemoryV6FileUsage(): Promise<MemoryFileUsageResponse>;
  /** 指定したエントリーに属する添付を書き出し、取得できた結果には出力件数を返す。 */
  exportMemoryV6EntryFiles(
    entryId: string,
  ): Promise<MemoryV6ReviewExportFilesResult | null>;
  /** 指定条件で保護オブジェクトの回収または事前確認を依頼し、区分別の集計を取得する。 */
  runMemoryV6ProtectedObjectGc(
    request: MemoryV6ProtectedObjectGcRequest,
  ): Promise<MemoryV6ProtectedObjectGcResponse>;
  /** 入力された検索・絞り込み条件から、レビュー表示用のページを取得する。 */
  searchMemoryV6Entries(
    request: MemoryV6ReviewSearchRequest,
  ): Promise<MemoryV6ReviewSearchResult>;
  /** ID でレビュー用のエントリー詳細を取得し、取得できない場合は null を返す。 */
  getMemoryV6Entry(entryId: string): Promise<MemoryV6ReviewEntryDetail | null>;
  /** レビュー対象の ID を忘却し、理由と項目の状態を取得する。 */
  forgetMemoryV6Entry(
    entryId: string,
    reason?: MemoryForgetReason,
  ): Promise<MemoryV6ReviewForgetResult>;
};
