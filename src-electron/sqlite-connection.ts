import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const SQLITE_WAL_AUTOCHECKPOINT_PAGES = 256;
export const SQLITE_JOURNAL_SIZE_LIMIT_BYTES = 64 * 1024 * 1024;
const SQLITE_BUSY_TIMEOUT_MS = 5000;
export const SQLITE_MAINTENANCE_BUSY_TIMEOUT_MS = 250;

type AppDatabaseConnectionOptions = {
  busyTimeoutMs?: number;
};

export function openAppDatabase(dbPath: string): DatabaseSync {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  configureAppDatabaseConnection(db);
  return db;
}

export function configureAppDatabaseConnection(db: DatabaseSync, options: AppDatabaseConnectionOptions = {}): void {
  const busyTimeoutMs = options.busyTimeoutMs ?? SQLITE_BUSY_TIMEOUT_MS;
  db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs};`);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`PRAGMA wal_autocheckpoint = ${SQLITE_WAL_AUTOCHECKPOINT_PAGES};`);
  db.exec(`PRAGMA journal_size_limit = ${SQLITE_JOURNAL_SIZE_LIMIT_BYTES};`);
  db.exec("PRAGMA foreign_keys = ON;");
}

export function truncateAppDatabaseWal(dbPath: string, options: AppDatabaseConnectionOptions = {}): void {
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

export function truncateAppDatabaseWalIfLargerThan(
  dbPath: string,
  maxWalBytes = SQLITE_JOURNAL_SIZE_LIMIT_BYTES,
  options: AppDatabaseConnectionOptions = {},
): boolean {
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
