import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import type { AuditLogEntry } from "../src/app-state.js";
import { CREATE_APP_SETTINGS_TABLE_SQL, CREATE_MODEL_CATALOG_TABLES_SQL } from "../src-electron/database-schema-v1.js";
import { APP_DATABASE_V3_FILENAME, isValidV3Database } from "../src-electron/database-schema-v3.js";
import { APP_DATABASE_V4_FILENAME, CREATE_V4_SCHEMA_SQL } from "../src-electron/database-schema-v4.js";
import { AuditLogStorage } from "../src-electron/audit-log-storage.js";
import { AuditLogStorageV3 } from "../src-electron/audit-log-storage-v3.js";
import { MateStorage } from "../src-electron/mate-storage.js";
import { SessionStorage } from "../src-electron/session-storage.js";
import { SessionStorageV3 } from "../src-electron/session-storage-v3.js";

type SqliteBackupFile = {
  originalPath: string;
  backupPath: string;
};

type CountRow = {
  count: number;
};

export type V3ToV4MigrationCounts = {
  sessions: number;
  sessionMessages: number;
  sessionMessageArtifacts: number;
  auditLogs: number;
  auditLogDetails: number;
  auditLogOperations: number;
  appSettings: number;
  modelCatalogRevisions: number;
  modelCatalogProviders: number;
  modelCatalogModels: number;
};

export type V3ToV4MigrationDryRunReport = {
  mode: "dry-run";
  input: {
    databaseFile: string;
    blobRootPath: string;
  };
  v3Counts: V3ToV4MigrationCounts;
  plannedV4Counts: V3ToV4MigrationCounts;
};

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

const APP_SETTING_COLUMNS = ["setting_key", "setting_value", "updated_at"] as const;
const MODEL_CATALOG_REVISION_COLUMNS = ["revision", "source", "imported_at", "is_active"] as const;
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

function sqliteDatabaseFilePaths(dbPath: string): string[] {
  return [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
}

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

function removeSqliteDatabaseFiles(dbPath: string): void {
  for (const filePath of sqliteDatabaseFilePaths(dbPath)) {
    rmSync(filePath, { force: true });
  }
}

function restoreMovedSqliteDatabaseBackups(backups: SqliteBackupFile[]): void {
  for (const backup of backups) {
    if (!existsSync(backup.backupPath)) {
      continue;
    }

    rmSync(backup.originalPath, { force: true });
    renameSync(backup.backupPath, backup.originalPath);
  }
}

function restoreSqliteDatabaseBackups(dbPath: string, backups: SqliteBackupFile[]): void {
  removeSqliteDatabaseFiles(dbPath);
  restoreMovedSqliteDatabaseBackups(backups);
}

function discardSqliteDatabaseBackups(backups: SqliteBackupFile[]): void {
  for (const backup of backups) {
    rmSync(backup.backupPath, { force: true });
  }
}

function tableExists(db: DatabaseSync, tableName: string): boolean {
  return db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?").get(tableName) !== undefined;
}

function readCount(db: DatabaseSync, tableName: string): number {
  if (!tableExists(db, tableName)) {
    return 0;
  }

  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get() as CountRow;
  return row.count;
}

function readCounts(db: DatabaseSync): V3ToV4MigrationCounts {
  return {
    sessions: readCount(db, "sessions"),
    sessionMessages: readCount(db, "session_messages"),
    sessionMessageArtifacts: readCount(db, "session_message_artifacts"),
    auditLogs: readCount(db, "audit_logs"),
    auditLogDetails: readCount(db, "audit_log_details"),
    auditLogOperations: readCount(db, "audit_log_operations"),
    appSettings: readCount(db, "app_settings"),
    modelCatalogRevisions: readCount(db, "model_catalog_revisions"),
    modelCatalogProviders: readCount(db, "model_catalog_providers"),
    modelCatalogModels: readCount(db, "model_catalog_models"),
  };
}

function assertValidSource(sourceDatabaseFile: string): void {
  if (!sourceDatabaseFile.endsWith(APP_DATABASE_V3_FILENAME)) {
    throw new Error(`source database must be ${APP_DATABASE_V3_FILENAME}: ${sourceDatabaseFile}`);
  }

  if (!isValidV3Database(sourceDatabaseFile)) {
    throw new Error(`source database is not a valid V3 database: ${sourceDatabaseFile}`);
  }
}

function assertValidTarget(targetDatabaseFile: string): void {
  if (!targetDatabaseFile.endsWith(APP_DATABASE_V4_FILENAME)) {
    throw new Error(`target database must be ${APP_DATABASE_V4_FILENAME}: ${targetDatabaseFile}`);
  }
}

function resolveBlobRootPath(sourceDatabaseFile: string, blobRootPath?: string): string {
  return resolve(blobRootPath ?? `${dirname(sourceDatabaseFile)}/blobs/v3`);
}

function openReadOnlySource(sourceDatabaseFile: string): DatabaseSync {
  assertValidSource(sourceDatabaseFile);
  return new DatabaseSync(sourceDatabaseFile, { readOnly: true });
}

function createV4BaseSchema(targetDatabaseFile: string, userDataPath: string): void {
  mkdirSync(dirname(targetDatabaseFile), { recursive: true });
  const db = new DatabaseSync(targetDatabaseFile);
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
  const rows = sourceDb.prepare(`SELECT ${columnSql} FROM ${tableName}`).all() as Array<Record<string, SQLInputValue>>;
  const insert = targetDb.prepare(`INSERT INTO ${tableName} (${columnSql}) VALUES (${placeholders})`);
  for (const row of rows) {
    insert.run(...columns.map((column) => row[column]));
  }
  return rows.length;
}

function copySettingsAndCatalog(sourceDb: DatabaseSync, targetDb: DatabaseSync): Pick<
  V3ToV4MigrationCounts,
  "appSettings" | "modelCatalogRevisions" | "modelCatalogProviders" | "modelCatalogModels"
> {
  targetDb.exec("BEGIN IMMEDIATE TRANSACTION");
  try {
    const appSettings = copyTableRows(sourceDb, targetDb, "app_settings", APP_SETTING_COLUMNS);
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
    const modelCatalogModels = copyTableRows(sourceDb, targetDb, "model_catalog_models", MODEL_CATALOG_MODEL_COLUMNS);
    targetDb.exec("COMMIT");
    return { appSettings, modelCatalogRevisions, modelCatalogProviders, modelCatalogModels };
  } catch (error) {
    targetDb.exec("ROLLBACK");
    throw error;
  }
}

function auditLogInput(entry: AuditLogEntry): Omit<AuditLogEntry, "id"> {
  const { id: _id, ...input } = entry;
  return input;
}

export function createMigrationDryRunReport(
  sourceDatabaseFile: string,
  options?: { blobRootPath?: string },
): V3ToV4MigrationDryRunReport {
  const blobRootPath = resolveBlobRootPath(sourceDatabaseFile, options?.blobRootPath);
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
  const blobRootPath = resolveBlobRootPath(input.sourceDatabaseFile, input.blobRootPath);
  const userDataPath = resolve(input.userDataPath ?? dirname(input.targetDatabaseFile));
  if (!overwrite && sqliteDatabaseFilePaths(input.targetDatabaseFile).some((filePath) => existsSync(filePath))) {
    throw new Error(`target database already exists: ${input.targetDatabaseFile}`);
  }

  const sourceDb = openReadOnlySource(input.sourceDatabaseFile);
  let targetDb: DatabaseSync | null = null;
  let sourceSessionStorage: SessionStorageV3 | null = null;
  let sourceAuditStorage: AuditLogStorageV3 | null = null;
  let targetSessionStorage: SessionStorage | null = null;
  let targetAuditStorage: AuditLogStorage | null = null;
  let backups: SqliteBackupFile[] = [];
  let migrationSucceeded = false;

  try {
    const v3Counts = readCounts(sourceDb);
    backups = overwrite ? backupExistingSqliteDatabaseFiles(input.targetDatabaseFile) : [];
    createV4BaseSchema(input.targetDatabaseFile, userDataPath);

    sourceSessionStorage = new SessionStorageV3(input.sourceDatabaseFile, blobRootPath);
    sourceAuditStorage = new AuditLogStorageV3(input.sourceDatabaseFile, blobRootPath);
    targetSessionStorage = new SessionStorage(input.targetDatabaseFile);
    targetAuditStorage = new AuditLogStorage(input.targetDatabaseFile);

    const sessions = await sourceSessionStorage.listSessions();
    await targetSessionStorage.replaceSessions(sessions);

    let migratedAuditLogs = 0;
    for (const session of sessions) {
      const auditLogs = await sourceAuditStorage.listSessionAuditLogs(session.id);
      for (const auditLog of auditLogs) {
        targetAuditStorage.createAuditLog(auditLogInput(auditLog));
        migratedAuditLogs += 1;
      }
    }

    targetDb = new DatabaseSync(input.targetDatabaseFile);
    const catalogCounts = copySettingsAndCatalog(sourceDb, targetDb);
    migrationSucceeded = true;

    return {
      mode: "write",
      input: {
        sourceDatabaseFile: input.sourceDatabaseFile,
        targetDatabaseFile: input.targetDatabaseFile,
        blobRootPath,
        overwrite,
      },
      v3Counts,
      migratedV4Counts: {
        sessions: sessions.length,
        sessionMessages: v3Counts.sessionMessages,
        sessionMessageArtifacts: v3Counts.sessionMessageArtifacts,
        auditLogs: migratedAuditLogs,
        auditLogDetails: v3Counts.auditLogDetails,
        auditLogOperations: v3Counts.auditLogOperations,
        ...catalogCounts,
      },
    };
  } finally {
    targetDb?.close();
    sourceSessionStorage?.close();
    sourceAuditStorage?.close();
    targetSessionStorage?.close();
    targetAuditStorage?.close();
    sourceDb.close();

    if (migrationSucceeded) {
      discardSqliteDatabaseBackups(backups);
    } else {
      restoreSqliteDatabaseBackups(input.targetDatabaseFile, backups);
    }
  }
}

function getArgValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1 || index + 1 >= args.length) {
    return undefined;
  }
  return args[index + 1];
}

function printUsageAndExit(): never {
  console.error(
    "Usage: npx tsx scripts/migrate-database-v3-to-v4.ts --dry-run --v3 <path-to-withmate-v3.db> [--blob-root <path-to-blobs>]\n"
      + "       npx tsx scripts/migrate-database-v3-to-v4.ts --write --v3 <path-to-withmate-v3.db> --v4 <path-to-withmate-v4.db> [--blob-root <path-to-blobs>] [--overwrite]",
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const sourceDatabaseFile = getArgValue(args, "--v3");
  if (!sourceDatabaseFile) {
    printUsageAndExit();
  }

  if (args.includes("--dry-run")) {
    console.log(JSON.stringify(createMigrationDryRunReport(sourceDatabaseFile, {
      blobRootPath: getArgValue(args, "--blob-root"),
    }), null, 2));
    return;
  }

  if (args.includes("--write")) {
    const targetDatabaseFile = getArgValue(args, "--v4");
    if (!targetDatabaseFile) {
      printUsageAndExit();
    }

    console.log(JSON.stringify(await createMigrationWriteReport({
      sourceDatabaseFile,
      targetDatabaseFile,
      blobRootPath: getArgValue(args, "--blob-root"),
      overwrite: args.includes("--overwrite"),
    }), null, 2));
    return;
  }

  printUsageAndExit();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
