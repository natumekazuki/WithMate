import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const SQLITE_WAL_AUTOCHECKPOINT_PAGES = 256;
export const SQLITE_JOURNAL_SIZE_LIMIT_BYTES = 64 * 1024 * 1024;
const SQLITE_BUSY_TIMEOUT_MS = 5000;

export function openAppDatabase(dbPath: string): DatabaseSync {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  configureAppDatabaseConnection(db);
  return db;
}

export function configureAppDatabaseConnection(db: DatabaseSync): void {
  db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS};`);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`PRAGMA wal_autocheckpoint = ${SQLITE_WAL_AUTOCHECKPOINT_PAGES};`);
  db.exec(`PRAGMA journal_size_limit = ${SQLITE_JOURNAL_SIZE_LIMIT_BYTES};`);
  db.exec("PRAGMA foreign_keys = ON;");
}

export function truncateAppDatabaseWal(dbPath: string): void {
  if (!fs.existsSync(dbPath)) {
    return;
  }

  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS};`);
    db.exec(`PRAGMA journal_size_limit = ${SQLITE_JOURNAL_SIZE_LIMIT_BYTES};`);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  } finally {
    db.close();
  }
}

export function truncateAppDatabaseWalIfLargerThan(
  dbPath: string,
  maxWalBytes = SQLITE_JOURNAL_SIZE_LIMIT_BYTES,
): boolean {
  const walPath = `${dbPath}-wal`;
  if (!fs.existsSync(walPath)) {
    return false;
  }

  const walStats = fs.statSync(walPath);
  if (walStats.size <= maxWalBytes) {
    return false;
  }

  truncateAppDatabaseWal(dbPath);
  return true;
}
