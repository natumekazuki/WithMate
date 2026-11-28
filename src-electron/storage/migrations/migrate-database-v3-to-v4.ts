import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import {
  openAppDatabaseReadOnly,
  openMigrationDatabase,
} from "../sqlite-connection.js";
import type { Session } from "../../../src-shared/session/session-state.js";
import {
  CREATE_APP_SETTINGS_TABLE_SQL,
  CREATE_MODEL_CATALOG_TABLES_SQL,
} from "../database-schema-v1.js";
import {
  APP_DATABASE_V3_FILENAME,
  isValidV3Database,
} from "../database-schema-v3.js";
import {
  APP_DATABASE_V4_FILENAME,
  CREATE_V4_SCHEMA_SQL,
} from "../database-schema-v4.js";
import { MateStorage } from "../../mate/mate-storage.js";
import { SessionStorage } from "../../session/session-storage.js";
import { SessionStorageV3 } from "../../session/session-storage-v3.js";

/** 既存V4の上書きに備えて退避したSQLiteファイルの元パスと退避先。 */
type SqliteBackupFile = {
  originalPath: string;
  backupPath: string;
};

/** 件数を取得する集計SQLの結果行。 */
type CountRow = {
  count: number;
};

/** Sessionなどの識別子を列だけで取得する際の行型。 */
type IdRow = {
  id: string;
};

/** V3からV4へ継続するSession・会話・設定・カタログの件数。 */
export type V3ToV4MigrationCounts = {
  sessions: number;
  sessionMessages: number;
  sessionMessageArtifacts: number;
  appSettings: number;
  modelCatalogRevisions: number;
  modelCatalogProviders: number;
  modelCatalogModels: number;
};

/** 移行元DBとblobルート、読み取りだけで求めた移行予定件数。 */
export type V3ToV4MigrationDryRunReport = {
  mode: "dry-run";
  input: {
    databaseFile: string;
    blobRootPath: string;
  };
  v3Counts: V3ToV4MigrationCounts;
  plannedV4Counts: V3ToV4MigrationCounts;
};

/** 実際に作成したV4と、その元になったV3・blobおよび件数を示すレポート。 */
export type V3ToV4MigrationWriteReport = {
  mode: "write";
  input: {
    sourceDatabaseFile: string;
    targetDatabaseFile: string;
    blobRootPath: string;
    overwrite: boolean;
  };
  v3Counts: V3ToV4MigrationCounts;
  migratedV4Counts: V3ToV4MigrationCounts;
};

const APP_SETTING_COLUMNS = [
  "setting_key",
  "setting_value",
  "updated_at",
] as const;
const MODEL_CATALOG_REVISION_COLUMNS = [
  "revision",
  "source",
  "imported_at",
  "is_active",
] as const;
const MODEL_CATALOG_PROVIDER_COLUMNS = [
  "revision",
  "provider_id",
  "label",
  "default_model_id",
  "default_reasoning_effort",
  "sort_order",
] as const;
const MODEL_CATALOG_MODEL_COLUMNS = [
  "revision",
  "provider_id",
  "model_id",
  "label",
  "reasoning_efforts_json",
  "sort_order",
] as const;

/** 会話をV4へ取り込んだ後、移行先に残さない旧V3の本文と詳細のテーブル。 */
export const OBSOLETE_V4_IMPORT_TARGET_TABLES = [
  "session_message_artifacts",
  "session_messages",
] as const;

/** SQLite本体に付随するWALと共有メモリーも含めてパスを返す。 */
function sqliteDatabaseFilePaths(dbPath: string): string[] {
  return [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
}

/** 正常終了まで正式なV4パスを使わないよう、移行用の一時DB名を生成する。 */
function createMigrationTempDatabaseFilePath(
  targetDatabaseFile: string,
): string {
  return `${targetDatabaseFile}.migration-${process.pid}-${Date.now()}.tmp`;
}

/** 既存の出力DB本体とサイドカーを退避し、移動が途中で失敗した場合は元へ戻す。 */
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

/** 指定したSQLite本体とサイドカーを除去する。不在はエラーにしない。 */
function removeSqliteDatabaseFiles(dbPath: string): void {
  for (const filePath of sqliteDatabaseFilePaths(dbPath)) {
    rmSync(filePath, { force: true });
  }
}

/** 実在する退避ファイルを、部分作成された同名ファイルを除去してから元に戻す。 */
function restoreMovedSqliteDatabaseBackups(backups: SqliteBackupFile[]): void {
  for (const backup of backups) {
    if (!existsSync(backup.backupPath)) {
      continue;
    }

    rmSync(backup.originalPath, { force: true });
    renameSync(backup.backupPath, backup.originalPath);
  }
}

/** 処理途中にできた出力一式を除去し、上書き前の退避ファイルを復元する。 */
function restoreSqliteDatabaseBackups(
  dbPath: string,
  backups: SqliteBackupFile[],
): void {
  removeSqliteDatabaseFiles(dbPath);
  restoreMovedSqliteDatabaseBackups(backups);
}

/** 移行成功後に、置き換えたDBの本体とサイドカーの退避を削除する。 */
function discardSqliteDatabaseBackups(backups: SqliteBackupFile[]): void {
  for (const backup of backups) {
    rmSync(backup.backupPath, { force: true });
  }
}

/** 移行が済んだ一時DBとサイドカーを、同じ接尾辞を保ったまま正式なV4パスへ移す。 */
function publishMigratedDatabase(
  tempDatabaseFile: string,
  targetDatabaseFile: string,
): void {
  removeSqliteDatabaseFiles(targetDatabaseFile);
  for (const tempFilePath of sqliteDatabaseFilePaths(tempDatabaseFile)) {
    if (!existsSync(tempFilePath)) {
      continue;
    }

    const suffix = tempFilePath.slice(tempDatabaseFile.length);
    renameSync(tempFilePath, `${targetDatabaseFile}${suffix}`);
  }
}

/** SQLiteのスキーマ情報から指定テーブルが実在するか確認する。 */
function tableExists(db: DatabaseSync, tableName: string): boolean {
  return (
    db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?",
      )
      .get(tableName) !== undefined
  );
}

/** 存在するテーブルの行数を返し、任意テーブルがない場合はゼロとする。 */
function readCount(db: DatabaseSync, tableName: string): number {
  if (!tableExists(db, tableName)) {
    return 0;
  }

  const row = db
    .prepare(`SELECT COUNT(*) AS count FROM ${tableName}`)
    .get() as CountRow;
  return row.count;
}

/** 引き継ぐ通常Session・会話・設定・カタログの報告用件数を集計する。 */
function readCounts(db: DatabaseSync): V3ToV4MigrationCounts {
  return {
    sessions: readCount(db, "sessions"),
    sessionMessages: readCount(db, "session_messages"),
    sessionMessageArtifacts: readCount(db, "session_message_artifacts"),
    appSettings: readCount(db, "app_settings"),
    modelCatalogRevisions: readCount(db, "model_catalog_revisions"),
    modelCatalogProviders: readCount(db, "model_catalog_providers"),
    modelCatalogModels: readCount(db, "model_catalog_models"),
  };
}

/** 想定した名前かつ有効なV3だけを移行元として受け付ける。 */
function assertValidSource(sourceDatabaseFile: string): void {
  if (!sourceDatabaseFile.endsWith(APP_DATABASE_V3_FILENAME)) {
    throw new Error(
      `source database must be ${APP_DATABASE_V3_FILENAME}: ${sourceDatabaseFile}`,
    );
  }

  if (!isValidV3Database(sourceDatabaseFile)) {
    throw new Error(
      `source database is not a valid V3 database: ${sourceDatabaseFile}`,
    );
  }
}

/** 出力パスが所定のV4ファイル名で終わらない場合は移行前に拒否する。 */
function assertValidTarget(targetDatabaseFile: string): void {
  if (!targetDatabaseFile.endsWith(APP_DATABASE_V4_FILENAME)) {
    throw new Error(
      `target database must be ${APP_DATABASE_V4_FILENAME}: ${targetDatabaseFile}`,
    );
  }
}

/** 明示されたblobルート、またはDBに隣接するV3の既定ルートを絶対パスで返す。 */
function resolveBlobRootPath(
  sourceDatabaseFile: string,
  blobRootPath?: string,
): string {
  return resolve(blobRootPath ?? `${dirname(sourceDatabaseFile)}/blobs/v3`);
}

/** 移行元の版を確認し、内容やジャーナル設定を変更しない接続を開く。 */
function openReadOnlySource(sourceDatabaseFile: string): DatabaseSync {
  assertValidSource(sourceDatabaseFile);
  return openAppDatabaseReadOnly(sourceDatabaseFile);
}

/** 一時DBへV4のMate、既存設定とカタログの基盤を作り、Mateストアの初期化も済ませる。 */
function createV4BaseSchema(
  targetDatabaseFile: string,
  userDataPath: string,
): void {
  mkdirSync(dirname(targetDatabaseFile), { recursive: true });
  const db = openMigrationDatabase(targetDatabaseFile);
  try {
    db.exec("PRAGMA foreign_keys = ON;");
    for (const statement of CREATE_V4_SCHEMA_SQL) {
      db.exec(statement);
    }
    db.exec(CREATE_APP_SETTINGS_TABLE_SQL);
    db.exec(CREATE_MODEL_CATALOG_TABLES_SQL);
  } finally {
    db.close();
  }

  const mateStorage = new MateStorage(targetDatabaseFile, userDataPath);
  mateStorage.close();
}

/** 維持する指定列に限って行を移し、移行元にテーブルがなければゼロ件を返す。 */
function copyTableRows(
  sourceDb: DatabaseSync,
  targetDb: DatabaseSync,
  tableName: string,
  columns: readonly string[],
): number {
  if (!tableExists(sourceDb, tableName)) {
    return 0;
  }

  const columnSql = columns.join(", ");
  const placeholders = columns.map(() => "?").join(", ");
  const rows = sourceDb
    .prepare(`SELECT ${columnSql} FROM ${tableName}`)
    .all() as Array<Record<string, SQLInputValue>>;
  const insert = targetDb.prepare(
    `INSERT INTO ${tableName} (${columnSql}) VALUES (${placeholders})`,
  );
  for (const row of rows) {
    insert.run(...columns.map((column) => row[column]));
  }
  return rows.length;
}

/** 設定と旧モデル一覧を一つのトランザクションで移し、一部だけの反映は残さない。 */
function copySettingsAndCatalog(
  sourceDb: DatabaseSync,
  targetDb: DatabaseSync,
): Pick<
  V3ToV4MigrationCounts,
  | "appSettings"
  | "modelCatalogRevisions"
  | "modelCatalogProviders"
  | "modelCatalogModels"
> {
  targetDb.exec("BEGIN IMMEDIATE TRANSACTION");
  try {
    const appSettings = copyTableRows(
      sourceDb,
      targetDb,
      "app_settings",
      APP_SETTING_COLUMNS,
    );
    const modelCatalogRevisions = copyTableRows(
      sourceDb,
      targetDb,
      "model_catalog_revisions",
      MODEL_CATALOG_REVISION_COLUMNS,
    );
    const modelCatalogProviders = copyTableRows(
      sourceDb,
      targetDb,
      "model_catalog_providers",
      MODEL_CATALOG_PROVIDER_COLUMNS,
    );
    const modelCatalogModels = copyTableRows(
      sourceDb,
      targetDb,
      "model_catalog_models",
      MODEL_CATALOG_MODEL_COLUMNS,
    );
    targetDb.exec("COMMIT");
    return {
      appSettings,
      modelCatalogRevisions,
      modelCatalogProviders,
      modelCatalogModels,
    };
  } catch (error) {
    targetDb.exec("ROLLBACK");
    throw error;
  }
}

/** V4への取り込み後は不要になる旧本文・詳細テーブルを、移行先だけから取り除く。 */
function dropObsoleteV4ImportTargetTables(targetDb: DatabaseSync): void {
  for (const tableName of OBSOLETE_V4_IMPORT_TARGET_TABLES) {
    targetDb.exec(`DROP TABLE IF EXISTS ${tableName}`);
  }
}

/** V3由来のSessionを旧版参照専用にする。進行中の状態は解除し、スレッドIDは維持する。 */
function toLegacyReadOnlySession(session: Session): Session {
  return {
    ...session,
    status: session.status === "running" ? "saved" : session.status,
    runState: session.runState === "running" ? "idle" : session.runState,
    accessMode: "legacy_readonly",
    sourceSchemaVersion: 3,
    characterIconPath: "",
    threadId: session.threadId,
  };
}

/** V3を読み取り専用で集計し、V4で引き継ぐ予定件数と使用するblobルートを返す。 */
export function createMigrationDryRunReport(
  sourceDatabaseFile: string,
  options?: { blobRootPath?: string },
): V3ToV4MigrationDryRunReport {
  const blobRootPath = resolveBlobRootPath(
    sourceDatabaseFile,
    options?.blobRootPath,
  );
  const sourceDb = openReadOnlySource(sourceDatabaseFile);
  try {
    const v3Counts = readCounts(sourceDb);
    return {
      mode: "dry-run",
      input: {
        databaseFile: sourceDatabaseFile,
        blobRootPath,
      },
      v3Counts,
      plannedV4Counts: { ...v3Counts },
    };
  } finally {
    sourceDb.close();
  }
}

/** V3 DBと共有blobを変更せず、会話を参照専用SessionとしてV4へ取り込む。成功後に一時DBを反映し、失敗時は退避を復元する。 */
export async function createMigrationWriteReport(input: {
  sourceDatabaseFile: string;
  targetDatabaseFile: string;
  blobRootPath?: string;
  userDataPath?: string;
  overwrite?: boolean;
}): Promise<V3ToV4MigrationWriteReport> {
  assertValidSource(input.sourceDatabaseFile);
  assertValidTarget(input.targetDatabaseFile);

  const overwrite = input.overwrite === true;
  const sourceBlobRootPath = resolveBlobRootPath(
    input.sourceDatabaseFile,
    input.blobRootPath,
  );
  const targetBlobRootPath = resolveBlobRootPath(input.targetDatabaseFile);
  const tempTargetDatabaseFile = createMigrationTempDatabaseFilePath(
    input.targetDatabaseFile,
  );
  const userDataPath = resolve(
    input.userDataPath ?? dirname(input.targetDatabaseFile),
  );
  if (
    !overwrite &&
    sqliteDatabaseFilePaths(input.targetDatabaseFile).some((filePath) =>
      existsSync(filePath),
    )
  ) {
    throw new Error(
      `target database already exists: ${input.targetDatabaseFile}`,
    );
  }

  const sourceDb = openReadOnlySource(input.sourceDatabaseFile);
  let targetDb: DatabaseSync | null = null;
  let sourceSessionStorage: SessionStorageV3 | null = null;
  let targetSessionStorage: SessionStorage | null = null;
  let backups: SqliteBackupFile[] = [];
  let migrationSucceeded = false;

  try {
    const v3Counts = readCounts(sourceDb);
    backups = overwrite
      ? backupExistingSqliteDatabaseFiles(input.targetDatabaseFile)
      : [];
    createV4BaseSchema(tempTargetDatabaseFile, userDataPath);

    sourceSessionStorage = new SessionStorageV3(
      input.sourceDatabaseFile,
      sourceBlobRootPath,
      { readOnly: true },
    );
    targetSessionStorage = new SessionStorage(tempTargetDatabaseFile);

    const sessions = (await sourceSessionStorage.listSessions()).map(
      toLegacyReadOnlySession,
    );
    await targetSessionStorage.replaceSessions(sessions);
    for (const session of sessions) {
    }

    targetDb = openMigrationDatabase(tempTargetDatabaseFile);
    const catalogCounts = copySettingsAndCatalog(sourceDb, targetDb);
    dropObsoleteV4ImportTargetTables(targetDb);
    targetDb.close();
    targetDb = null;
    targetSessionStorage.close();
    targetSessionStorage = null;

    publishMigratedDatabase(tempTargetDatabaseFile, input.targetDatabaseFile);
    migrationSucceeded = true;

    return {
      mode: "write",
      input: {
        sourceDatabaseFile: input.sourceDatabaseFile,
        targetDatabaseFile: input.targetDatabaseFile,
        blobRootPath: sourceBlobRootPath,
        overwrite,
      },
      v3Counts,
      migratedV4Counts: {
        sessions: sessions.length,
        sessionMessages: v3Counts.sessionMessages,
        sessionMessageArtifacts: v3Counts.sessionMessageArtifacts,
        ...catalogCounts,
      },
    };
  } finally {
    targetDb?.close();
    sourceSessionStorage?.close();
    targetSessionStorage?.close();
    sourceDb.close();

    if (migrationSucceeded) {
      discardSqliteDatabaseBackups(backups);
    } else {
      restoreSqliteDatabaseBackups(input.targetDatabaseFile, backups);
      removeSqliteDatabaseFiles(tempTargetDatabaseFile);
    }
  }
}
