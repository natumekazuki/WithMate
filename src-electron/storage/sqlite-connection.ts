import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/** SQLite が自動チェックポイントを試みる WAL のページ数。 */
export const SQLITE_WAL_AUTOCHECKPOINT_PAGES = 256;
/** SQLite のジャーナルサイズ制限と WAL 保守処理の既定しきい値（バイト）。 */
export const SQLITE_JOURNAL_SIZE_LIMIT_BYTES = 64 * 1024 * 1024;
const SQLITE_BUSY_TIMEOUT_MS = 5000;
/** 保守用接続がロック解除を待つ時間（ミリ秒）。 */
export const SQLITE_MAINTENANCE_BUSY_TIMEOUT_MS = 250;

/** 接続のロック待ち時間を既定値から変更するための設定。 */
type AppDatabaseConnectionOptions = {
  busyTimeoutMs?: number;
};

let mainThreadMarkedAsNonStorageOwner = false;

/** 現在のスレッドでは同期版のアプリデータベースを開けないことを記録する。 */
export function markMainThreadAsNonStorageOwner(): void {
  mainThreadMarkedAsNonStorageOwner = true;
}

/** 同期 SQLite の利用を禁止されたスレッドからのアクセスを拒否する。 */
function assertStorageOwner(): void {
  if (mainThreadMarkedAsNonStorageOwner) {
    throw new Error(
      "Synchronous SQLite app-database access is restricted to the storage worker.",
    );
  }
}

/** 必要なら親ディレクトリを作り、アプリ用の接続設定を適用してデータベースを開く。 */
export function openAppDatabase(dbPath: string): DatabaseSync {
  assertStorageOwner();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  configureAppDatabaseConnection(db);
  return db;
}

/** 接続設定を変更せず、既存のデータベースを読み取り専用で開く。 */
export function openAppDatabaseReadOnly(dbPath: string): DatabaseSync {
  assertStorageOwner();
  return new DatabaseSync(dbPath, { readOnly: true });
}

/** アプリ接続用の PRAGMA 一式を適用せず、移行用データベースを開く。 */
export function openMigrationDatabase(dbPath: string): DatabaseSync {
  assertStorageOwner();
  return new DatabaseSync(dbPath);
}

/** ロック待ち時間、WAL とその管理設定、外部キー制約を接続に適用する。 */
export function configureAppDatabaseConnection(
  db: DatabaseSync,
  options: AppDatabaseConnectionOptions = {},
): void {
  const busyTimeoutMs = options.busyTimeoutMs ?? SQLITE_BUSY_TIMEOUT_MS;
  db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs};`);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`PRAGMA wal_autocheckpoint = ${SQLITE_WAL_AUTOCHECKPOINT_PAGES};`);
  db.exec(`PRAGMA journal_size_limit = ${SQLITE_JOURNAL_SIZE_LIMIT_BYTES};`);
  db.exec("PRAGMA foreign_keys = ON;");
}

/** DB が存在する場合に WAL の切り詰めを試み、成功・失敗にかかわらず保守用接続を閉じる。 */
export function truncateAppDatabaseWal(
  dbPath: string,
  options: AppDatabaseConnectionOptions = {},
): void {
  assertStorageOwner();
  if (!fs.existsSync(dbPath)) {
    return;
  }

  const db = new DatabaseSync(dbPath);
  try {
    configureAppDatabaseConnection(db, options);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  } finally {
    db.close();
  }
}

/** WAL が指定バイト数を超えた場合だけ切り詰め処理を呼び出し、その呼び出しの有無を返す。 */
export function truncateAppDatabaseWalIfLargerThan(
  dbPath: string,
  maxWalBytes = SQLITE_JOURNAL_SIZE_LIMIT_BYTES,
  options: AppDatabaseConnectionOptions = {},
): boolean {
  assertStorageOwner();
  const walPath = `${dbPath}-wal`;
  if (!fs.existsSync(walPath)) {
    return false;
  }

  const walStats = fs.statSync(walPath);
  if (walStats.size <= maxWalBytes) {
    return false;
  }

  truncateAppDatabaseWal(dbPath, options);
  return true;
}
