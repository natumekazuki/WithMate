import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { APP_DATABASE_V4_FILENAME, isValidV4Database } from "../src-electron/database-schema-v4.js";
import {
  APP_DATABASE_V6_FILENAME,
  CREATE_V6_SCHEMA_SQL,
  isValidV6Database,
} from "../src-electron/database-schema-v6.js";

type SqliteBackupFile = {
  originalPath: string;
  backupPath: string;
};

type CountRow = {
  count: number;
};

export type V4ToV6MigrationCounts = {
  appSettings: number;
  modelCatalogRevisions: number;
  modelCatalogProviders: number;
  modelCatalogModels: number;
  characters: number;
  skippedAppSettings: number;
  skippedSessions: number;
  skippedAuditLogs: number;
  skippedLegacyMemoryEntries: number;
  skippedMateRows: number;
  skippedProviderInstructionRows: number;
};

export type V4ToV6MigrationDryRunReport = {
  mode: "dry-run";
  input: {
    databaseFile: string;
  };
  v4Counts: V4ToV6MigrationCounts;
  plannedV6Counts: V4ToV6MigrationCounts;
};

export type V4ToV6MigrationWriteReport = {
  mode: "write";
  input: {
    sourceDatabaseFile: string;
    targetDatabaseFile: string;
    overwrite: boolean;
  };
  v4Counts: V4ToV6MigrationCounts;
  migratedV6Counts: V4ToV6MigrationCounts;
};

const MIGRATED_APP_SETTING_KEYS = new Set([
  "auto_collapse_action_dock_on_send",
  "coding_provider_settings_json",
  "user_microcopy_catalog_json",
]);

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
const CHARACTER_COLUMNS = [
  "id",
  "name",
  "description",
  "icon_file_path",
  "theme_main",
  "theme_sub",
  "state",
  "is_default",
  "created_at",
  "updated_at",
  "archived_at",
] as const;

const LEGACY_MEMORY_TABLES = [
  "session_memories",
  "project_scopes",
  "project_memory_entries",
  "character_scopes",
  "character_memory_entries",
] as const;

const MATE_TABLES = [
  "mate_profile",
  "mate_profile_sections",
  "mate_profile_revisions",
  "mate_profile_revision_sections",
  "mate_growth_settings",
  "mate_growth_model_preferences",
  "mate_growth_runs",
  "mate_growth_cursors",
  "mate_growth_events",
  "mate_growth_event_links",
  "mate_growth_event_profile_item_links",
  "mate_memory_tags",
  "mate_memory_tag_catalog",
  "mate_embedding_settings",
  "mate_semantic_embeddings",
  "mate_growth_event_actions",
  "mate_growth_event_evidence",
  "mate_profile_items",
  "mate_profile_item_tags",
  "mate_profile_item_sources",
  "mate_profile_item_relations",
  "mate_forgotten_tombstones",
  "mate_project_digests",
] as const;

const PROVIDER_INSTRUCTION_TABLES = [
  "provider_instruction_targets",
  "provider_instruction_sync_runs",
] as const;

function sqliteDatabaseFilePaths(dbPath: string): string[] {
  return [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
}

function createMigrationTempDatabaseFilePath(targetDatabaseFile: string): string {
  return `${targetDatabaseFile}.migration-${process.pid}-${Date.now()}.tmp`;
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

function publishMigratedDatabase(tempDatabaseFile: string, targetDatabaseFile: string): void {
  removeSqliteDatabaseFiles(targetDatabaseFile);
  for (const tempFilePath of sqliteDatabaseFilePaths(tempDatabaseFile)) {
    if (!existsSync(tempFilePath)) {
      continue;
    }

    const suffix = tempFilePath.slice(tempDatabaseFile.length);
    renameSync(tempFilePath, `${targetDatabaseFile}${suffix}`);
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

function sumCounts(db: DatabaseSync, tableNames: readonly string[]): number {
  return tableNames.reduce((total, tableName) => total + readCount(db, tableName), 0);
}

function readMigratedAppSettingsCount(db: DatabaseSync): number {
  if (!tableExists(db, "app_settings")) {
    return 0;
  }

  const rows = db.prepare("SELECT setting_key FROM app_settings").all() as Array<{ setting_key: string }>;
  return rows.filter((row) => MIGRATED_APP_SETTING_KEYS.has(row.setting_key)).length;
}

function readSkippedAppSettingsCount(db: DatabaseSync): number {
  if (!tableExists(db, "app_settings")) {
    return 0;
  }

  const rows = db.prepare("SELECT setting_key FROM app_settings").all() as Array<{ setting_key: string }>;
  return rows.filter((row) => !MIGRATED_APP_SETTING_KEYS.has(row.setting_key)).length;
}

function readCounts(db: DatabaseSync): V4ToV6MigrationCounts {
  return {
    appSettings: readMigratedAppSettingsCount(db),
    modelCatalogRevisions: readCount(db, "model_catalog_revisions"),
    modelCatalogProviders: readCount(db, "model_catalog_providers"),
    modelCatalogModels: readCount(db, "model_catalog_models"),
    characters: readCount(db, "characters"),
    skippedAppSettings: readSkippedAppSettingsCount(db),
    skippedSessions: readCount(db, "sessions") + readCount(db, "companion_sessions"),
    skippedAuditLogs: readCount(db, "audit_logs") + readCount(db, "companion_audit_logs"),
    skippedLegacyMemoryEntries: sumCounts(db, LEGACY_MEMORY_TABLES),
    skippedMateRows: sumCounts(db, MATE_TABLES),
    skippedProviderInstructionRows: sumCounts(db, PROVIDER_INSTRUCTION_TABLES),
  };
}

function zeroSkippedCounts(counts: V4ToV6MigrationCounts): V4ToV6MigrationCounts {
  return {
    ...counts,
    skippedAppSettings: 0,
    skippedSessions: 0,
    skippedAuditLogs: 0,
    skippedLegacyMemoryEntries: 0,
    skippedMateRows: 0,
    skippedProviderInstructionRows: 0,
  };
}

function assertValidSource(sourceDatabaseFile: string): void {
  if (!sourceDatabaseFile.endsWith(APP_DATABASE_V4_FILENAME)) {
    throw new Error(`source database must be ${APP_DATABASE_V4_FILENAME}: ${sourceDatabaseFile}`);
  }

  if (!isValidV4Database(sourceDatabaseFile)) {
    throw new Error(`source database is not a valid V4 database: ${sourceDatabaseFile}`);
  }
}

function assertValidTarget(targetDatabaseFile: string): void {
  if (!targetDatabaseFile.endsWith(APP_DATABASE_V6_FILENAME)) {
    throw new Error(`target database must be ${APP_DATABASE_V6_FILENAME}: ${targetDatabaseFile}`);
  }
}

function openReadOnlySource(sourceDatabaseFile: string): DatabaseSync {
  assertValidSource(sourceDatabaseFile);
  return new DatabaseSync(sourceDatabaseFile, { readOnly: true });
}

function createV6BaseSchema(targetDatabaseFile: string): void {
  mkdirSync(dirname(targetDatabaseFile), { recursive: true });
  const db = new DatabaseSync(targetDatabaseFile);
  try {
    db.exec("PRAGMA foreign_keys = ON;");
    for (const statement of CREATE_V6_SCHEMA_SQL) {
      db.exec(statement);
    }
  } finally {
    db.close();
  }
}

function copyTableRows(
  sourceDb: DatabaseSync,
  targetDb: DatabaseSync,
  tableName: string,
  columns: readonly string[],
  whereSql = "",
  whereParams: SQLInputValue[] = [],
): number {
  if (!tableExists(sourceDb, tableName)) {
    return 0;
  }

  const columnSql = columns.join(", ");
  const placeholders = columns.map(() => "?").join(", ");
  const rows = sourceDb
    .prepare(`SELECT ${columnSql} FROM ${tableName}${whereSql}`)
    .all(...whereParams) as Array<Record<string, SQLInputValue>>;
  const insert = targetDb.prepare(`INSERT OR IGNORE INTO ${tableName} (${columnSql}) VALUES (${placeholders})`);
  for (const row of rows) {
    insert.run(...columns.map((column) => row[column]));
  }
  return rows.length;
}

function copyReleaseData(sourceDb: DatabaseSync, targetDb: DatabaseSync): Pick<
  V4ToV6MigrationCounts,
  "appSettings" | "modelCatalogRevisions" | "modelCatalogProviders" | "modelCatalogModels" | "characters"
> {
  const appSettings = copyTableRows(
    sourceDb,
    targetDb,
    "app_settings",
    APP_SETTING_COLUMNS,
    ` WHERE setting_key IN (${Array.from(MIGRATED_APP_SETTING_KEYS).map(() => "?").join(", ")})`,
    Array.from(MIGRATED_APP_SETTING_KEYS),
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
  const modelCatalogModels = copyTableRows(sourceDb, targetDb, "model_catalog_models", MODEL_CATALOG_MODEL_COLUMNS);
  const characters = copyTableRows(sourceDb, targetDb, "characters", CHARACTER_COLUMNS);
  return { appSettings, modelCatalogRevisions, modelCatalogProviders, modelCatalogModels, characters };
}

function copyReleaseDataInTransaction(sourceDb: DatabaseSync, targetDb: DatabaseSync): V4ToV6MigrationCounts {
  targetDb.exec("BEGIN IMMEDIATE TRANSACTION");
  try {
    const copied = copyReleaseData(sourceDb, targetDb);
    targetDb.exec("COMMIT");
    return zeroSkippedCounts({
      ...copied,
      skippedAppSettings: 0,
      skippedSessions: 0,
      skippedAuditLogs: 0,
      skippedLegacyMemoryEntries: 0,
      skippedMateRows: 0,
      skippedProviderInstructionRows: 0,
    });
  } catch (error) {
    targetDb.exec("ROLLBACK");
    throw error;
  }
}

export function createMigrationDryRunReport(sourceDatabaseFile: string): V4ToV6MigrationDryRunReport {
  const sourceDb = openReadOnlySource(resolve(sourceDatabaseFile));
  try {
    const v4Counts = readCounts(sourceDb);
    return {
      mode: "dry-run",
      input: {
        databaseFile: resolve(sourceDatabaseFile),
      },
      v4Counts,
      plannedV6Counts: zeroSkippedCounts(v4Counts),
    };
  } finally {
    sourceDb.close();
  }
}

export async function createMigrationWriteReport(input: {
  sourceDatabaseFile: string;
  targetDatabaseFile: string;
  overwrite?: boolean;
}): Promise<V4ToV6MigrationWriteReport> {
  const sourceDatabaseFile = resolve(input.sourceDatabaseFile);
  const targetDatabaseFile = resolve(input.targetDatabaseFile);
  const overwrite = input.overwrite ?? false;
  assertValidSource(sourceDatabaseFile);
  assertValidTarget(targetDatabaseFile);

  const sourceDb = new DatabaseSync(sourceDatabaseFile, { readOnly: true });
  const v4Counts = readCounts(sourceDb);
  let backups: SqliteBackupFile[] = [];
  const targetExists = existsSync(targetDatabaseFile);
  const useExistingTarget = targetExists && !overwrite;
  const tempDatabaseFile = useExistingTarget
    ? targetDatabaseFile
    : createMigrationTempDatabaseFilePath(targetDatabaseFile);
  let published = false;

  try {
    if (useExistingTarget) {
      if (!isValidV6Database(targetDatabaseFile)) {
        throw new Error(`target database is not a valid V6 database: ${targetDatabaseFile}`);
      }
    } else {
      backups = targetExists ? backupExistingSqliteDatabaseFiles(targetDatabaseFile) : [];
      createV6BaseSchema(tempDatabaseFile);
    }

    const targetDb = new DatabaseSync(tempDatabaseFile);
    let migratedV6Counts: V4ToV6MigrationCounts;
    try {
      migratedV6Counts = copyReleaseDataInTransaction(sourceDb, targetDb);
    } finally {
      targetDb.close();
    }

    if (!useExistingTarget) {
      publishMigratedDatabase(tempDatabaseFile, targetDatabaseFile);
    }
    if (!isValidV6Database(targetDatabaseFile)) {
      throw new Error(`migrated database is not a valid V6 database: ${targetDatabaseFile}`);
    }
    discardSqliteDatabaseBackups(backups);
    published = true;

    return {
      mode: "write",
      input: {
        sourceDatabaseFile,
        targetDatabaseFile,
        overwrite,
      },
      v4Counts,
      migratedV6Counts,
    };
  } catch (error) {
    if (!published && !useExistingTarget) {
      restoreSqliteDatabaseBackups(targetDatabaseFile, backups);
    }
    throw error;
  } finally {
    sourceDb.close();
    if (!useExistingTarget) {
      removeSqliteDatabaseFiles(tempDatabaseFile);
    }
  }
}

function usage(): string {
  return "Usage: npx tsx scripts/migrate-database-v4-to-v6.ts --dry-run --v4 <path-to-withmate-v4.db>\n"
    + "       npx tsx scripts/migrate-database-v4-to-v6.ts --write --v4 <path-to-withmate-v4.db> --v6 <path-to-withmate-v6.db> [--overwrite]";
}

async function main(argv: string[]): Promise<void> {
  const mode = argv.includes("--write") ? "write" : argv.includes("--dry-run") ? "dry-run" : null;
  const v4Index = argv.indexOf("--v4");
  const v6Index = argv.indexOf("--v6");
  const v4Path = v4Index >= 0 ? argv[v4Index + 1] : undefined;
  const v6Path = v6Index >= 0 ? argv[v6Index + 1] : undefined;
  const overwrite = argv.includes("--overwrite");

  if (!mode || !v4Path || (mode === "write" && !v6Path)) {
    throw new Error(usage());
  }

  const report = mode === "dry-run"
    ? createMigrationDryRunReport(v4Path)
    : await createMigrationWriteReport({
      sourceDatabaseFile: v4Path,
      targetDatabaseFile: v6Path ?? "",
      overwrite,
    });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (import.meta.url === pathToFileURL(invokedPath).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
