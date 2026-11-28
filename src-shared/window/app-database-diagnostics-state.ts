/** 診断対象のDB世代。旧世代と未対応を、現在の実行用DBから区別する。 */
export type AppDatabaseCompatibilityMode =
  "v6" | "v4" | "legacy-v3" | "legacy-v2" | "legacy-v1" | "unsupported";

/** DBファイルが未作成、作成予定、利用可能、不正、未対応のどれかを示す。 */
export type AppDatabaseFileStatus =
  "missing" | "pending-create" | "ready" | "invalid" | "unsupported";

/** 現行ランタイムの候補と、照合する基盤DBを区別する。 */
export type AppDatabaseFileRole = "runtime" | "foundation";

/** ファイル単位の存在・スキーマ検証結果と、実行DBとして選択できるかどうか。 */
export type AppDatabaseFileDiagnostics = {
  fileName: string;
  path: string;
  exists: boolean;
  role: AppDatabaseFileRole;
  expectedSchemaVersion: number | null;
  userVersion: number | null;
  schemaValid: boolean;
  runtimeEligible: boolean;
  valid: boolean;
  status: AppDatabaseFileStatus;
};

/** 実際のユーザーデータ先で選ばれたDBと、調べた候補ファイルおよび警告。 */
export type AppDatabaseDiagnostics = {
  userDataPath: string;
  userDataPathOverrideApplied: boolean;
  activeDatabasePath: string;
  activeFileName: string;
  compatibilityMode: AppDatabaseCompatibilityMode;
  schemaVersion: number | null;
  userVersion: number | null;
  schemaValid: boolean;
  runtimeCompatible: boolean;
  exists: boolean;
  valid: boolean;
  files: AppDatabaseFileDiagnostics[];
  warnings: string[];
};
