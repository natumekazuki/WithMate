import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import {
  openAppDatabaseReadOnly,
  openMigrationDatabase,
} from "../sqlite-connection.js";
import type { Session } from "../../../src-shared/session/session-state.js";
import {
  DEFAULT_APPROVAL_MODE,
  normalizeApprovalMode,
} from "../../../src-shared/settings/approval-mode.js";
import {
  DEFAULT_CODEX_SANDBOX_MODE,
  normalizeCodexSandboxMode,
} from "../../../src-shared/settings/codex-sandbox-mode.js";
import { DEFAULT_PROVIDER_ID } from "../../../src-shared/settings/model-catalog.js";
import { normalizeSession } from "../../../src-shared/session/session-state.js";
import { CREATE_V3_SCHEMA_SQL } from "../database-schema-v3.js";
import { SessionStorageV3 } from "../../session/session-storage-v3.js";

/** 移行元の件数と移行予定件数、SQLiteから外へ出す本文・詳細のサイズを示す事前レポート。 */
export type V2ToV3MigrationDryRunReport = {
  mode: "dry-run";
  input: {
    databaseFile: string;
  };
  v2Counts: {
    sessions: number;
    sessionMessages: number;
    sessionMessageArtifacts: number;
    appSettings: number;
    modelCatalogRevisions: number;
    modelCatalogProviders: number;
    modelCatalogModels: number;
  };
  plannedV3Counts: {
    sessions: number;
    sessionMessages: number;
    sessionMessageArtifacts: number;
    appSettings: number;
    modelCatalogRevisions: number;
    modelCatalogProviders: number;
    modelCatalogModels: number;
  };
  estimatedSourceBytes: {
    sessionMessageText: number;
    sessionMessageArtifactsJson: number;
  };
};

/** 移行先DBとblobルート、およびV3へ移した件数を示す実行レポート。 */
export type V2ToV3MigrationWriteReport = {
  mode: "write";
  input: {
    sourceDatabaseFile: string;
    targetDatabaseFile: string;
    blobRootPath: string;
    overwrite: boolean;
  };
  v2Counts: V2ToV3MigrationDryRunReport["v2Counts"];
  migratedV3Counts: V2ToV3MigrationDryRunReport["plannedV3Counts"] & {
    blobObjects: number;
  };
};

/** 既存V3のDB本体またはサイドカーを上書き前に移動した元パスと退避先。 */
type SqliteBackupFile = {
  originalPath: string;
  backupPath: string;
};

/** 旧blobルートを上書き前に移動した元パスと退避先。 */
type PathBackup = {
  originalPath: string;
  backupPath: string;
};

/** 移行対象テーブルの集計SQLから読み取る行数。 */
type CountRow = {
  count: number;
};

/** 会話本文を結合する前に読み込むV2のSession識別情報と実行設定。 */
type SessionHeaderRow = {
  id: string;
  task_title: string;
  status: string;
  updated_at: string;
  provider: string;
  catalog_revision: number;
  workspace_label: string;
  workspace_path: string;
  branch: string;
  session_kind: string;
  character_id: string;
  character_name: string;
  character_icon_path: string;
  character_theme_main: string;
  character_theme_sub: string;
  run_state: string;
  approval_mode: string;
  codex_sandbox_mode: string;
  model: string;
  reasoning_effort: string;
  custom_agent_name: string;
  allowed_additional_directories_json: string;
  thread_id: string;
  last_active_at: number;
};

/** V2の会話本文・表示フラグと、詳細がある場合のJSONを結合した結果。 */
type SessionMessageRow = {
  role: string;
  text: string;
  accent: number;
  is_bookmarked: number;
  artifact_json: string | null;
};

/** V3にも継続するアプリ設定のキー・値・最終更新時刻。 */
type AppSettingRow = {
  setting_key: string;
  setting_value: string;
  updated_at: string;
};

/** 旧モデル一覧の版番号、取得元、取込時刻と有効状態。 */
type ModelCatalogRevisionRow = {
  revision: number;
  source: string;
  imported_at: string;
  is_active: number;
};

/** 旧モデル一覧の版とプロバイダーごとに引き継ぐ既定値・表示順。 */
type ModelCatalogProviderRow = {
  revision: number;
  provider_id: string;
  label: string;
  default_model_id: string;
  default_reasoning_effort: string;
  sort_order: number;
};

/** 旧モデル一覧の版とモデルごとに引き継ぐ推論候補・表示順。 */
type ModelCatalogModelRow = {
  revision: number;
  provider_id: string;
  model_id: string;
  label: string;
  reasoning_efforts_json: string;
  sort_order: number;
};

const SESSION_HEADER_COLUMNS = `
  id,
  task_title,
  status,
  updated_at,
  provider,
  catalog_revision,
  workspace_label,
  workspace_path,
  branch,
  session_kind,
  character_id,
  character_name,
  character_icon_path,
  character_theme_main,
  character_theme_sub,
  run_state,
  approval_mode,
  codex_sandbox_mode,
  model,
  reasoning_effort,
  custom_agent_name,
  allowed_additional_directories_json,
  thread_id,
  last_active_at
`;

/** 旧版ごとに存在が異なるテーブルの有無を調べる。 */
function tableExists(db: DatabaseSync, tableName: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
    .get(tableName);
  return row !== undefined;
}

/** 既存テーブルに指定列があるか確認し、旧版で列がない場合の代替値選択に使う。 */
function tableHasColumn(
  db: DatabaseSync,
  tableName: string,
  columnName: string,
): boolean {
  return (
    db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
      name: string;
    }>
  ).some((column) => column.name === columnName);
}

/** 移行元テーブルの行数を返す。テーブルがない場合はゼロとする。 */
function countRows(db: DatabaseSync, tableName: string): number {
  if (!tableExists(db, tableName)) {
    return 0;
  }
  const row = db
    .prepare(`SELECT COUNT(*) AS count FROM ${tableName}`)
    .get() as CountRow;
  return row.count;
}

/** 指定列がNULLでも空白だけでもない行を集計し、テーブルがなければゼロを返す。 */
function countNonEmptyRows(
  db: DatabaseSync,
  tableName: string,
  columnName: string,
): number {
  if (!tableExists(db, tableName)) {
    return 0;
  }
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count FROM ${tableName} WHERE ${columnName} IS NOT NULL AND length(trim(${columnName})) > 0`,
    )
    .get() as CountRow;
  return row.count;
}

/** 文字数ではなくUTF-8でのバイト数を求める。欠落値はゼロバイトとする。 */
function textBytes(value: string | null | undefined): number {
  return Buffer.byteLength(value ?? "", "utf8");
}

/** SQLite本体とWAL・共有メモリーをまとめて扱うためのパスを返す。 */
function sqliteDatabaseFilePaths(dbPath: string): string[] {
  return [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
}

/** SQLite本体かサイドカーのいずれかがあれば既存の出力先として扱う。 */
function sqliteDatabaseFilesExist(dbPath: string): boolean {
  return sqliteDatabaseFilePaths(dbPath).some((path) => existsSync(path));
}

/** 入出力のDB本体・サイドカーの絶対パスを照合し、パスが重なる移行を拒否する。 */
function assertDistinctMigrationPaths(
  sourceDbPath: string,
  targetDbPath: string,
): void {
  const sourcePaths = new Set(
    sqliteDatabaseFilePaths(sourceDbPath).map((path) => resolve(path)),
  );
  const targetPaths = new Set(
    sqliteDatabaseFilePaths(targetDbPath).map((path) => resolve(path)),
  );

  for (const path of sourcePaths) {
    if (targetPaths.has(path)) {
      throw new Error("V2 and V3 database paths must be different");
    }
  }
}

/** 既存V3の本体とサイドカーを退避する。途中で失敗した場合は移動済み分を元に戻す。 */
function backupExistingSqliteDatabaseFiles(dbPath: string): SqliteBackupFile[] {
  const suffix = `.migration-backup-${process.pid}-${Date.now()}`;
  const backups: SqliteBackupFile[] = [];

  try {
    for (const originalPath of sqliteDatabaseFilePaths(dbPath)) {
      if (!existsSync(originalPath)) {
        continue;
      }

      const backupPath = `${originalPath}${suffix}`;
      renameSync(originalPath, backupPath);
      backups.push({ originalPath, backupPath });
    }
  } catch (error) {
    restoreMovedSqliteDatabaseBackups(backups);
    throw error;
  }

  return backups;
}

/** 指定DBの本体とサイドカーを除去する。既に削除済みでも失敗にしない。 */
function removeSqliteDatabaseFiles(dbPath: string): void {
  for (const path of sqliteDatabaseFilePaths(dbPath)) {
    rmSync(path, { force: true });
  }
}

/** 実在する退避ファイルを、移行前の本体・サイドカー名へ戻す。 */
function restoreMovedSqliteDatabaseBackups(backups: SqliteBackupFile[]): void {
  for (const backup of backups) {
    if (existsSync(backup.backupPath)) {
      rmSync(backup.originalPath, { force: true });
      renameSync(backup.backupPath, backup.originalPath);
    }
  }
}

/** 失敗時に出力DBとサイドカーを取り除き、退避済みのファイルがあれば戻す。 */
function restoreSqliteDatabaseBackups(
  dbPath: string,
  backups: SqliteBackupFile[],
): void {
  removeSqliteDatabaseFiles(dbPath);
  restoreMovedSqliteDatabaseBackups(backups);
}

/** 移行が完了した後、旧DB本体とサイドカーの一時退避を削除する。 */
function discardSqliteDatabaseBackups(backups: SqliteBackupFile[]): void {
  for (const backup of backups) {
    rmSync(backup.backupPath, { force: true });
  }
}

/** 既存のblobルートを上書き前に退避し、存在しなければnullを返す。 */
function backupExistingPath(path: string): PathBackup | null {
  if (!existsSync(path)) {
    return null;
  }
  const backupPath = `${path}.migration-backup-${process.pid}-${Date.now()}`;
  renameSync(path, backupPath);
  return { originalPath: path, backupPath };
}

/** 移行途中のblobルートを除去し、旧ルートを退避していれば元に戻す。 */
function restorePathBackup(path: string, backup: PathBackup | null): void {
  rmSync(path, { recursive: true, force: true });
  if (backup && existsSync(backup.backupPath)) {
    renameSync(backup.backupPath, backup.originalPath);
  }
}

/** 移行成功後、保持が不要になった旧blobルートの退避を除去する。 */
function discardPathBackup(backup: PathBackup | null): void {
  if (backup) {
    rmSync(backup.backupPath, { recursive: true, force: true });
  }
}

/** 空・不正・配列以外のJSONを空配列として扱い、配列だけを取得する。 */
function parseJsonArray(value: string | null | undefined): unknown[] {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** 空や不正なJSON、配列などの非オブジェクトは受け入れず、指定した代替値を返す。 */
function parseJsonObject<T extends object>(
  value: string | null | undefined,
  fallback: T,
): T {
  if (!value) {
    return fallback;
  }
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as T)
      : fallback;
  } catch {
    return fallback;
  }
}

/** 旧Sessionの追加許可先を配列から読み、文字列でない要素を取り除く。 */
function parseAllowedAdditionalDirectories(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

/** 保存済みJSON配列から文字列の要素だけを取り出す。 */
function parseStringArray(value: string | null | undefined): string[] {
  return parseJsonArray(value).filter(
    (entry): entry is string => typeof entry === "string",
  );
}

/** V2のヘッダーと会話行をV3保存用Sessionへ組み直す。既定値を補っても正規化できない場合は移行を中止する。 */
function rowToSession(
  row: SessionHeaderRow,
  messages: SessionMessageRow[],
): Session {
  const session = normalizeSession({
    id: row.id,
    taskTitle: row.task_title,
    status: row.status,
    updatedAt: row.updated_at,
    provider: row.provider || DEFAULT_PROVIDER_ID,
    catalogRevision: row.catalog_revision || 1,
    workspaceLabel: row.workspace_label,
    workspacePath: row.workspace_path,
    branch: row.branch,
    sessionKind: row.session_kind,
    characterId: row.character_id,
    character: row.character_name,
    characterIconPath: row.character_icon_path,
    characterThemeColors: {
      main: row.character_theme_main,
      sub: row.character_theme_sub,
    },
    runState: row.run_state,
    approvalMode: normalizeApprovalMode(
      row.approval_mode,
      DEFAULT_APPROVAL_MODE,
    ),
    codexSandboxMode: normalizeCodexSandboxMode(
      row.codex_sandbox_mode,
      DEFAULT_CODEX_SANDBOX_MODE,
    ),
    model: row.model || "gpt-5.4",
    reasoningEffort: row.reasoning_effort ?? "high",
    customAgentName: row.custom_agent_name,
    allowedAdditionalDirectories: parseAllowedAdditionalDirectories(
      row.allowed_additional_directories_json,
    ),
    threadId: row.thread_id,
    messages: messages.map((message) => ({
      role: message.role,
      text: message.text,
      accent: message.accent === 1 ? true : undefined,
      ...(message.is_bookmarked === 1 ? { isBookmarked: true } : {}),
      artifact: message.artifact_json
        ? parseJsonObject(message.artifact_json, {})
        : undefined,
    })),
    stream: [],
  });

  if (!session) {
    throw new Error(`V2 session ${row.id} is invalid`);
  }
  return session;
}

/** 移行元の会話・設定・カタログの件数を報告用に集計する。 */
function readV2Counts(
  db: DatabaseSync,
): V2ToV3MigrationDryRunReport["v2Counts"] {
  return {
    sessions: countRows(db, "sessions"),
    sessionMessages: countRows(db, "session_messages"),
    sessionMessageArtifacts: countRows(db, "session_message_artifacts"),
    appSettings: countRows(db, "app_settings"),
    modelCatalogRevisions: countRows(db, "model_catalog_revisions"),
    modelCatalogProviders: countRows(db, "model_catalog_providers"),
    modelCatalogModels: countRows(db, "model_catalog_models"),
  };
}

/** SQLがvalue列へ射影した文字列のUTF-8バイト数を合計する。 */
function sumTextBytes(
  db: DatabaseSync,
  sql: string,
  ...params: SQLInputValue[]
): number {
  return (
    db.prepare(sql).all(...params) as Array<{ value: string | null }>
  ).reduce((total, row) => total + textBytes(row.value), 0);
}

/** V2に格納された本文と詳細JSONのサイズをUTF-8のバイト数で別々に集計する。 */
function createEstimatedSourceBytes(
  db: DatabaseSync,
): V2ToV3MigrationDryRunReport["estimatedSourceBytes"] {
  return {
    sessionMessageText: tableExists(db, "session_messages")
      ? sumTextBytes(db, "SELECT text AS value FROM session_messages")
      : 0,
    sessionMessageArtifactsJson: tableExists(db, "session_message_artifacts")
      ? sumTextBytes(
          db,
          "SELECT artifact_json AS value FROM session_message_artifacts",
        )
      : 0,
  };
}

/** V2が存在する場合だけ読み取り専用で開き、欠落時に空DBを作成しない。 */
function openReadOnlySource(dbPath: string): DatabaseSync {
  if (!existsSync(dbPath)) {
    throw new Error(`V2 database not found: ${dbPath}`);
  }
  return openAppDatabaseReadOnly(dbPath);
}

/** V3の移行先に外部キーを有効にした状態で版番号とテーブルを設定する。 */
function createV3Schema(dbPath: string): void {
  const db = openMigrationDatabase(dbPath);
  try {
    db.exec("PRAGMA foreign_keys = ON;");
    for (const statement of CREATE_V3_SCHEMA_SQL) {
      db.exec(statement);
    }
  } finally {
    db.close();
  }
}

/** V2に保存されたアプリ設定を更新時刻ごと移し、挿入件数を返す。 */
function copyAppSettings(
  sourceDb: DatabaseSync,
  targetDb: DatabaseSync,
): number {
  if (!tableExists(sourceDb, "app_settings")) {
    return 0;
  }
  const rows = sourceDb
    .prepare(
      "SELECT setting_key, setting_value, updated_at FROM app_settings ORDER BY setting_key",
    )
    .all() as AppSettingRow[];
  const stmt = targetDb.prepare(
    "INSERT INTO app_settings (setting_key, setting_value, updated_at) VALUES (?, ?, ?)",
  );
  for (const row of rows) {
    stmt.run(row.setting_key, row.setting_value, row.updated_at);
  }
  return rows.length;
}

/** モデル一覧の版、プロバイダー、モデルを参照順にV3へコピーし、各件数を返す。 */
function copyModelCatalogTables(
  sourceDb: DatabaseSync,
  targetDb: DatabaseSync,
): {
  modelCatalogRevisions: number;
  modelCatalogProviders: number;
  modelCatalogModels: number;
} {
  const revisionStmt = targetDb.prepare(
    "INSERT INTO model_catalog_revisions (revision, source, imported_at, is_active) VALUES (?, ?, ?, ?)",
  );
  const providerStmt = targetDb.prepare(
    "INSERT INTO model_catalog_providers (revision, provider_id, label, default_model_id, default_reasoning_effort, sort_order) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const modelStmt = targetDb.prepare(
    "INSERT INTO model_catalog_models (revision, provider_id, model_id, label, reasoning_efforts_json, sort_order) VALUES (?, ?, ?, ?, ?, ?)",
  );

  const revisions = tableExists(sourceDb, "model_catalog_revisions")
    ? (sourceDb
        .prepare(
          "SELECT revision, source, imported_at, is_active FROM model_catalog_revisions ORDER BY revision",
        )
        .all() as ModelCatalogRevisionRow[])
    : [];
  const providers = tableExists(sourceDb, "model_catalog_providers")
    ? (sourceDb
        .prepare(
          "SELECT revision, provider_id, label, default_model_id, default_reasoning_effort, sort_order FROM model_catalog_providers ORDER BY revision, provider_id",
        )
        .all() as ModelCatalogProviderRow[])
    : [];
  const models = tableExists(sourceDb, "model_catalog_models")
    ? (sourceDb
        .prepare(
          "SELECT revision, provider_id, model_id, label, reasoning_efforts_json, sort_order FROM model_catalog_models ORDER BY revision, provider_id, model_id",
        )
        .all() as ModelCatalogModelRow[])
    : [];

  for (const row of revisions) {
    revisionStmt.run(row.revision, row.source, row.imported_at, row.is_active);
  }
  for (const row of providers) {
    providerStmt.run(
      row.revision,
      row.provider_id,
      row.label,
      row.default_model_id,
      row.default_reasoning_effort,
      row.sort_order,
    );
  }
  for (const row of models) {
    modelStmt.run(
      row.revision,
      row.provider_id,
      row.model_id,
      row.label,
      row.reasoning_efforts_json,
      row.sort_order,
    );
  }

  return {
    modelCatalogRevisions: revisions.length,
    modelCatalogProviders: providers.length,
    modelCatalogModels: models.length,
  };
}

/** Sessionの本文を順序番号順に詳細と結合して取得する。Bookmark列がない版では未設定として扱う。 */
function readSessionMessages(
  db: DatabaseSync,
  sessionId: string,
): SessionMessageRow[] {
  const bookmarkColumn = tableHasColumn(db, "session_messages", "is_bookmarked")
    ? "m.is_bookmarked"
    : "0";
  return db
    .prepare(
      `
    SELECT
      m.role,
      m.text,
      m.accent,
      ${bookmarkColumn} AS is_bookmarked,
      a.artifact_json
    FROM session_messages AS m
    LEFT JOIN session_message_artifacts AS a
      ON a.message_id = m.id
    WHERE m.session_id = ?
    ORDER BY m.seq ASC
  `,
    )
    .all(sessionId) as SessionMessageRow[];
}

/** V2を読み取り専用で集計し、V3の予定件数と本文・詳細の推定サイズを返す。 */
export function createMigrationDryRunReport(
  v2DbPath: string,
): V2ToV3MigrationDryRunReport {
  const v2Db = openReadOnlySource(v2DbPath);
  try {
    const v2Counts = readV2Counts(v2Db);
    return {
      mode: "dry-run",
      input: {
        databaseFile: basename(v2DbPath),
      },
      v2Counts,
      plannedV3Counts: { ...v2Counts },
      estimatedSourceBytes: createEstimatedSourceBytes(v2Db),
    };
  } finally {
    v2Db.close();
  }
}

/** 元DBを変更せず、V3 DBと外部blobへ会話・設定を移す。失敗時は作成途中の出力を除去し、退避した旧出力を戻す。 */
export async function createMigrationWriteReport(input: {
  sourceDatabaseFile: string;
  targetDatabaseFile: string;
  blobRootPath: string;
  overwrite?: boolean;
}): Promise<V2ToV3MigrationWriteReport> {
  const overwrite = input.overwrite ?? false;

  if (!existsSync(input.sourceDatabaseFile)) {
    throw new Error(`V2 database not found: ${input.sourceDatabaseFile}`);
  }

  assertDistinctMigrationPaths(
    input.sourceDatabaseFile,
    input.targetDatabaseFile,
  );

  if (!overwrite && sqliteDatabaseFilesExist(input.targetDatabaseFile)) {
    throw new Error(`V3 database already exists: ${input.targetDatabaseFile}`);
  }
  if (!overwrite && existsSync(input.blobRootPath)) {
    throw new Error(`V3 blob root already exists: ${input.blobRootPath}`);
  }

  let dbBackups: SqliteBackupFile[] = [];
  let blobBackup: PathBackup | null = null;
  let migrationSucceeded = false;
  const sourceDb = openReadOnlySource(input.sourceDatabaseFile);
  let sessionStorage: SessionStorageV3 | null = null;

  try {
    dbBackups = overwrite
      ? backupExistingSqliteDatabaseFiles(input.targetDatabaseFile)
      : [];
    blobBackup = overwrite ? backupExistingPath(input.blobRootPath) : null;
    mkdirSync(resolve(input.blobRootPath), { recursive: true });

    createV3Schema(input.targetDatabaseFile);

    const v2Counts = readV2Counts(sourceDb);

    const targetDb = openMigrationDatabase(input.targetDatabaseFile);
    let copiedAppSettings = 0;
    let copiedModelCatalogCounts = {
      modelCatalogRevisions: 0,
      modelCatalogProviders: 0,
      modelCatalogModels: 0,
    };
    try {
      targetDb.exec("PRAGMA foreign_keys = ON;");
      targetDb.exec("BEGIN IMMEDIATE");
      try {
        copiedAppSettings = copyAppSettings(sourceDb, targetDb);
        copiedModelCatalogCounts = copyModelCatalogTables(sourceDb, targetDb);
        targetDb.exec("COMMIT");
      } catch (error) {
        targetDb.exec("ROLLBACK");
        throw error;
      }
    } finally {
      targetDb.close();
    }

    sessionStorage = new SessionStorageV3(
      input.targetDatabaseFile,
      input.blobRootPath,
    );

    const sessionRows = tableExists(sourceDb, "sessions")
      ? (sourceDb
          .prepare(
            `SELECT ${SESSION_HEADER_COLUMNS} FROM sessions ORDER BY last_active_at DESC, id DESC`,
          )
          .all() as SessionHeaderRow[])
      : [];
    for (const row of sessionRows) {
      await sessionStorage.upsertSessionWithLastActiveAt(
        rowToSession(row, readSessionMessages(sourceDb, row.id)),
        row.last_active_at,
      );
    }

    const reportDb = openAppDatabaseReadOnly(input.targetDatabaseFile);
    let blobObjects = 0;
    try {
      blobObjects = countRows(reportDb, "blob_objects");
    } finally {
      reportDb.close();
    }

    migrationSucceeded = true;
    return {
      mode: "write",
      input: {
        sourceDatabaseFile: basename(input.sourceDatabaseFile),
        targetDatabaseFile: basename(input.targetDatabaseFile),
        blobRootPath: basename(input.blobRootPath),
        overwrite,
      },
      v2Counts,
      migratedV3Counts: {
        sessions: sessionRows.length,
        sessionMessages: v2Counts.sessionMessages,
        sessionMessageArtifacts: v2Counts.sessionMessageArtifacts,
        appSettings: copiedAppSettings,
        ...copiedModelCatalogCounts,
        blobObjects,
      },
    };
  } finally {
    sessionStorage?.close();
    sourceDb.close();
    if (migrationSucceeded) {
      discardSqliteDatabaseBackups(dbBackups);
      discardPathBackup(blobBackup);
    } else {
      restoreSqliteDatabaseBackups(input.targetDatabaseFile, dbBackups);
      restorePathBackup(input.blobRootPath, blobBackup);
    }
  }
}
