import { existsSync, renameSync, rmSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openAppDatabaseReadOnly, openMigrationDatabase } from "../sqlite-connection.js";

import { CREATE_V2_SCHEMA_SQL } from "../database-schema-v2.js";

export type MigrationIssue = {
  sourceTable: string;
  sourceId: string;
  sourceColumn: string;
  errorKind: string;
  action: "skipped";
};

export type MigrationDryRunReport = {
  mode: "dry-run";
  input: {
    databaseFile: string;
  };
  v1Counts: {
    sessions: number;
    appSettings: number;
    modelCatalogRevisions: number;
    modelCatalogProviders: number;
    modelCatalogModels: number;
  };
  plannedV2Counts: {
    sessions: number;
    sessionMessages: number;
    sessionMessageArtifacts: number;
    appSettings: number;
    modelCatalogRevisions: number;
    modelCatalogProviders: number;
    modelCatalogModels: number;
  };
  skipped: {
    streamEntries: number;
    legacyAppSettings: number;
    sessionMemories: number;
    projectScopes: number;
    projectMemoryEntries: number;
    characterScopes: number;
    characterMemoryEntries: number;
    invalidMessages: number;
  };
  estimatedSourceBytes: {
    sessionMessagesJson: number;
    sessionStreamJson: number;
  };
  issues: MigrationIssue[];
};

export type MigrationWriteReport = {
  mode: "write";
  input: {
    sourceDatabaseFile: string;
    targetDatabaseFile: string;
    overwrite: boolean;
  };
  v1Counts: {
    sessions: number;
    appSettings: number;
    modelCatalogRevisions: number;
    modelCatalogProviders: number;
    modelCatalogModels: number;
  };
  migratedV2Counts: {
    sessions: number;
    sessionMessages: number;
    sessionMessageArtifacts: number;
    appSettings: number;
    modelCatalogRevisions: number;
    modelCatalogProviders: number;
    modelCatalogModels: number;
  };
  skipped: {
    streamEntries: number;
    legacyAppSettings: number;
    sessionMemories: number;
    projectScopes: number;
    projectMemoryEntries: number;
    characterScopes: number;
    characterMemoryEntries: number;
    invalidMessages: number;
  };
  issues: MigrationIssue[];
};

type SessionSourceRow = {
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
  messages_json: string;
  stream_json: string;
  last_active_at: number;
};

type SessionHeaderSourceRow = Omit<SessionSourceRow, "messages_json" | "stream_json">;

type SessionPayloadSourceRow = {
  messages_json: string;
  stream_json: string;
};

type AppSettingSourceRow = {
  setting_key: string;
  setting_value: string;
  updated_at: string;
};

type ModelCatalogRevisionRow = {
  revision: number;
  source: string;
  imported_at: string;
  is_active: number;
};

type ModelCatalogProviderRow = {
  revision: number;
  provider_id: string;
  label: string;
  default_model_id: string;
  default_reasoning_effort: string;
  sort_order: number;
};

type ModelCatalogModelRow = {
  revision: number;
  provider_id: string;
  model_id: string;
  label: string;
  reasoning_efforts_json: string;
  sort_order: number;
};

type CountRow = {
  count: number;
};

const LEGACY_APP_SETTING_KEYS = new Set([
  "memory_generation_enabled",
  "memory_extraction_provider_settings_json",
  "character_reflection_provider_settings_json",
  "character_reflection_trigger_settings_json",
]);

type SqliteBackupFile = {
  originalPath: string;
  backupPath: string;
};

function tableExists(db: DatabaseSync, tableName: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?").get(tableName);
  return row !== undefined;
}

function tableColumnNames(db: DatabaseSync, tableName: string): Set<string> {
  if (!tableExists(db, tableName)) {
    return new Set();
  }

  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function sqlStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function selectColumnOrDefault(columnNames: Set<string>, columnName: string, defaultValue: string | number): string {
  if (columnNames.has(columnName)) {
    return columnName;
  }

  return typeof defaultValue === "number"
    ? `${defaultValue} AS ${columnName}`
    : `${sqlStringLiteral(defaultValue)} AS ${columnName}`;
}

function countRows(db: DatabaseSync, tableName: string): number {
  if (!tableExists(db, tableName)) {
    return 0;
  }
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get() as CountRow;
  return row.count;
}

function parseJsonArray(value: string): unknown[] | null {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function recordJsonArrayIssue(issues: MigrationIssue[], issue: MigrationIssue): void {
  issues.push(issue);
}

function isMessageCandidate(value: unknown): value is { role?: unknown; artifact?: unknown; text?: unknown; accent?: unknown } {
  return typeof value === "object" && value !== null;
}

function isValidMessage(value: unknown): value is { role: "user" | "assistant"; artifact?: unknown; text?: unknown; accent?: unknown } {
  if (!isMessageCandidate(value)) {
    return false;
  }
  return value.role === "user" || value.role === "assistant";
}

function hasArtifact(value: unknown): boolean {
  return isMessageCandidate(value) && typeof value.artifact === "object" && value.artifact !== null;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function toSqliteBoolean(value: unknown): number {
  return value === true ? 1 : 0;
}

function sqliteDatabaseFilePaths(dbPath: string): string[] {
  return [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
}

function sqliteDatabaseFilesExist(dbPath: string): boolean {
  return sqliteDatabaseFilePaths(dbPath).some((path) => existsSync(path));
}

function assertDistinctMigrationPaths(v1DbPath: string, v2DbPath: string): void {
  const v1Paths = new Set(sqliteDatabaseFilePaths(v1DbPath).map((path) => resolve(path)));
  const v2Paths = new Set(sqliteDatabaseFilePaths(v2DbPath).map((path) => resolve(path)));

  for (const path of v1Paths) {
    if (v2Paths.has(path)) {
      throw new Error("V1 and V2 database paths must be different");
    }
  }
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
  for (const path of sqliteDatabaseFilePaths(dbPath)) {
    rmSync(path, { force: true });
  }
}

function restoreMovedSqliteDatabaseBackups(backups: SqliteBackupFile[]): void {
  for (const backup of backups) {
    if (existsSync(backup.backupPath)) {
      rmSync(backup.originalPath, { force: true });
      renameSync(backup.backupPath, backup.originalPath);
    }
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

function copyModelCatalogTables(v1Db: DatabaseSync, v2Db: DatabaseSync): {
  modelCatalogRevisions: number;
  modelCatalogProviders: number;
  modelCatalogModels: number;
} {
  const revisionStmt = v2Db.prepare(
    "INSERT INTO model_catalog_revisions (revision, source, imported_at, is_active) VALUES (?, ?, ?, ?)",
  );
  const providerStmt = v2Db.prepare(
    "INSERT INTO model_catalog_providers (revision, provider_id, label, default_model_id, default_reasoning_effort, sort_order) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const modelStmt = v2Db.prepare(
    "INSERT INTO model_catalog_models (revision, provider_id, model_id, label, reasoning_efforts_json, sort_order) VALUES (?, ?, ?, ?, ?, ?)",
  );

  let revisions = 0;
  let providers = 0;
  let models = 0;

  if (tableExists(v1Db, "model_catalog_revisions")) {
    const rows = v1Db.prepare("SELECT revision, source, imported_at, is_active FROM model_catalog_revisions ORDER BY revision").all() as
      ModelCatalogRevisionRow[];
    for (const row of rows) {
      revisionStmt.run(row.revision, row.source, row.imported_at, row.is_active);
      revisions += 1;
    }
  }

  if (tableExists(v1Db, "model_catalog_providers")) {
    const rows = v1Db
      .prepare(
        "SELECT revision, provider_id, label, default_model_id, default_reasoning_effort, sort_order FROM model_catalog_providers ORDER BY revision, provider_id",
      )
      .all() as ModelCatalogProviderRow[];
    for (const row of rows) {
      providerStmt.run(
        row.revision,
        row.provider_id,
        row.label,
        row.default_model_id,
        row.default_reasoning_effort,
        row.sort_order,
      );
      providers += 1;
    }
  }

  if (tableExists(v1Db, "model_catalog_models")) {
    const rows = v1Db
      .prepare(
        "SELECT revision, provider_id, model_id, label, reasoning_efforts_json, sort_order FROM model_catalog_models ORDER BY revision, provider_id, model_id",
      )
      .all() as ModelCatalogModelRow[];
    for (const row of rows) {
      modelStmt.run(
        row.revision,
        row.provider_id,
        row.model_id,
        row.label,
        row.reasoning_efforts_json,
        row.sort_order,
      );
      models += 1;
    }
  }

  return {
    modelCatalogRevisions: revisions,
    modelCatalogProviders: providers,
    modelCatalogModels: models,
  };
}

export function createMigrationDryRunReport(v1DbPath: string): MigrationDryRunReport {
  if (!existsSync(v1DbPath)) {
    throw new Error(`V1 database not found: ${v1DbPath}`);
  }

  const v1Db = openAppDatabaseReadOnly(v1DbPath);
  try {
    const issues: MigrationIssue[] = [];
    const sessions = tableExists(v1Db, "sessions")
      ? (v1Db.prepare("SELECT id, messages_json, stream_json FROM sessions ORDER BY id").all() as SessionSourceRow[])
      : [];
    const appSettings = tableExists(v1Db, "app_settings")
      ? (v1Db.prepare("SELECT setting_key FROM app_settings ORDER BY setting_key").all() as AppSettingSourceRow[])
      : [];

    let sessionMessages = 0;
    let sessionMessageArtifacts = 0;
    let streamEntries = 0;
    let invalidMessages = 0;

    for (const session of sessions) {
      const messages = parseJsonArray(session.messages_json);
      if (messages === null) {
        recordJsonArrayIssue(issues, {
          sourceTable: "sessions",
          sourceId: session.id,
          sourceColumn: "messages_json",
          errorKind: "invalid_json_array",
          action: "skipped",
        });
      } else {
        for (let index = 0; index < messages.length; index += 1) {
          const message = messages[index];
          if (!isValidMessage(message)) {
            invalidMessages += 1;
            issues.push({
              sourceTable: "sessions",
              sourceId: `${session.id}:${index}`,
              sourceColumn: "messages_json",
              errorKind: "invalid_message_role",
              action: "skipped",
            });
            continue;
          }
          sessionMessages += 1;
          if (hasArtifact(message)) {
            sessionMessageArtifacts += 1;
          }
        }
      }

      const stream = parseJsonArray(session.stream_json);
      if (stream === null) {
        recordJsonArrayIssue(issues, {
          sourceTable: "sessions",
          sourceId: session.id,
          sourceColumn: "stream_json",
          errorKind: "invalid_json_array",
          action: "skipped",
        });
      } else {
        streamEntries += stream.length;
      }
    }

    const legacyAppSettings = appSettings.filter((row) => LEGACY_APP_SETTING_KEYS.has(row.setting_key)).length;

    return {
      mode: "dry-run",
      input: {
        databaseFile: basename(v1DbPath),
      },
      v1Counts: {
        sessions: sessions.length,
        appSettings: appSettings.length,
        modelCatalogRevisions: countRows(v1Db, "model_catalog_revisions"),
        modelCatalogProviders: countRows(v1Db, "model_catalog_providers"),
        modelCatalogModels: countRows(v1Db, "model_catalog_models"),
      },
      plannedV2Counts: {
        sessions: sessions.length,
        sessionMessages,
        sessionMessageArtifacts,
        appSettings: appSettings.length - legacyAppSettings,
        modelCatalogRevisions: countRows(v1Db, "model_catalog_revisions"),
        modelCatalogProviders: countRows(v1Db, "model_catalog_providers"),
        modelCatalogModels: countRows(v1Db, "model_catalog_models"),
      },
      skipped: {
        streamEntries,
        legacyAppSettings,
        sessionMemories: countRows(v1Db, "session_memories"),
        projectScopes: countRows(v1Db, "project_scopes"),
        projectMemoryEntries: countRows(v1Db, "project_memory_entries"),
        characterScopes: countRows(v1Db, "character_scopes"),
        characterMemoryEntries: countRows(v1Db, "character_memory_entries"),
        invalidMessages,
      },
      estimatedSourceBytes: {
        sessionMessagesJson: sessions.reduce((total, row) => total + row.messages_json.length, 0),
        sessionStreamJson: sessions.reduce((total, row) => total + row.stream_json.length, 0),
      },
      issues,
    };
  } finally {
    v1Db.close();
  }
}

export function createMigrationWriteReport(input: {
  v1DbPath: string;
  v2DbPath: string;
  overwrite?: boolean;
}): MigrationWriteReport {
  const overwrite = input.overwrite ?? false;

  if (!existsSync(input.v1DbPath)) {
    throw new Error(`V1 database not found: ${input.v1DbPath}`);
  }

  assertDistinctMigrationPaths(input.v1DbPath, input.v2DbPath);

  if (!overwrite && sqliteDatabaseFilesExist(input.v2DbPath)) {
    throw new Error(`V2 database already exists: ${input.v2DbPath}`);
  }

  let backups: SqliteBackupFile[] = [];
  let migrationSucceeded = false;
  let v1Db: DatabaseSync | null = null;
  let v2Db: DatabaseSync | null = null;
  const issues: MigrationIssue[] = [];

  try {
    backups = overwrite ? backupExistingSqliteDatabaseFiles(input.v2DbPath) : [];
    v1Db = openAppDatabaseReadOnly(input.v1DbPath);
    v2Db = openMigrationDatabase(input.v2DbPath);

    const sessionColumnNames = tableColumnNames(v1Db, "sessions");
    const sessionRows = tableExists(v1Db, "sessions")
      ? (v1Db.prepare(
          `SELECT id, task_title, status, updated_at, provider, ${selectColumnOrDefault(sessionColumnNames, "catalog_revision", 1)}, workspace_label, workspace_path, branch, ${selectColumnOrDefault(sessionColumnNames, "session_kind", "default")}, character_id, character_name, character_icon_path, ${selectColumnOrDefault(sessionColumnNames, "character_theme_main", "#6f8cff")}, ${selectColumnOrDefault(sessionColumnNames, "character_theme_sub", "#6fb8c7")}, run_state, approval_mode, ${selectColumnOrDefault(sessionColumnNames, "codex_sandbox_mode", "workspace-write")}, ${selectColumnOrDefault(sessionColumnNames, "model", "gpt-5.4")}, ${selectColumnOrDefault(sessionColumnNames, "reasoning_effort", "high")}, ${selectColumnOrDefault(sessionColumnNames, "custom_agent_name", "")}, ${selectColumnOrDefault(sessionColumnNames, "allowed_additional_directories_json", "[]")}, ${selectColumnOrDefault(sessionColumnNames, "thread_id", "")}, last_active_at FROM sessions ORDER BY id`,
        ).all() as SessionHeaderSourceRow[])
      : [];

    const appSettings = tableExists(v1Db, "app_settings")
      ? (v1Db.prepare("SELECT setting_key, setting_value, updated_at FROM app_settings ORDER BY setting_key").all() as AppSettingSourceRow[])
      : [];

    const appSettingLegacyCount = appSettings.filter((row) => LEGACY_APP_SETTING_KEYS.has(row.setting_key)).length;
    const v1Counts = {
      sessions: sessionRows.length,
      appSettings: appSettings.length,
      modelCatalogRevisions: countRows(v1Db, "model_catalog_revisions"),
      modelCatalogProviders: countRows(v1Db, "model_catalog_providers"),
      modelCatalogModels: countRows(v1Db, "model_catalog_models"),
    };

    const sessionPayloadStmt = tableExists(v1Db, "sessions")
      ? v1Db.prepare("SELECT messages_json, stream_json FROM sessions WHERE id = ?")
      : null;
    let skippedStreamEntries = 0;
    let invalidMessages = 0;

    for (const session of sessionRows) {
      const sessionPayload = sessionPayloadStmt?.get(session.id) as SessionPayloadSourceRow | undefined;
      if (sessionPayload === undefined) {
        continue;
      }

      const stream = parseJsonArray(sessionPayload.stream_json);
      if (stream === null) {
        recordJsonArrayIssue(issues, {
          sourceTable: "sessions",
          sourceId: session.id,
          sourceColumn: "stream_json",
          errorKind: "invalid_json_array",
          action: "skipped",
        });
      } else {
        skippedStreamEntries += stream.length;
      }
    }

    v2Db.exec("PRAGMA foreign_keys = ON;");
    let transactionStarted = false;

    let sessionMessages = 0;
    let sessionMessageArtifacts = 0;

    try {
      v2Db.exec("BEGIN IMMEDIATE");
      transactionStarted = true;

      for (const statement of CREATE_V2_SCHEMA_SQL) {
        v2Db.exec(statement);
      }

      const sessionStmt = v2Db.prepare(
        "INSERT INTO sessions (id, task_title, status, updated_at, provider, catalog_revision, workspace_label, workspace_path, branch, session_kind, character_id, character_name, character_icon_path, character_theme_main, character_theme_sub, run_state, approval_mode, codex_sandbox_mode, model, reasoning_effort, custom_agent_name, allowed_additional_directories_json, thread_id, message_count, last_active_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      const messageStmt = v2Db.prepare(
        "INSERT INTO session_messages (session_id, seq, role, text, accent, artifact_available) VALUES (?, ?, ?, ?, ?, ?)",
      );
      const messageArtifactStmt = v2Db.prepare("INSERT INTO session_message_artifacts (message_id, artifact_json) VALUES (?, ?)");
      const appSettingStmt = v2Db.prepare("INSERT INTO app_settings (setting_key, setting_value, updated_at) VALUES (?, ?, ?)");

      for (const session of sessionRows) {
        const sessionPayload = sessionPayloadStmt?.get(session.id) as SessionPayloadSourceRow | undefined;
        if (sessionPayload === undefined) {
          continue;
        }

        let messageCount = 0;
        const messagesForInsert: Array<{
          role: "user" | "assistant";
          text: string;
          accent: number;
          artifact?: unknown;
        }> = [];

        const messages = parseJsonArray(sessionPayload.messages_json);

        if (messages === null) {
          recordJsonArrayIssue(issues, {
            sourceTable: "sessions",
            sourceId: session.id,
            sourceColumn: "messages_json",
            errorKind: "invalid_json_array",
            action: "skipped",
          });
        } else {
          for (let index = 0; index < messages.length; index += 1) {
            const message = messages[index];
            if (!isValidMessage(message)) {
              invalidMessages += 1;
              issues.push({
                sourceTable: "sessions",
                sourceId: `${session.id}:${index}`,
                sourceColumn: "messages_json",
                errorKind: "invalid_message_role",
                action: "skipped",
              });
              continue;
            }

            messagesForInsert.push({
              role: message.role,
              text: asText((message as { text?: unknown }).text),
              accent: toSqliteBoolean(message.accent),
              artifact: isMessageCandidate(message) ? message.artifact : undefined,
            });
            messageCount += 1;
          }
        }

        sessionStmt.run(
          session.id,
          session.task_title,
          session.status,
          session.updated_at,
          session.provider,
          session.catalog_revision,
          session.workspace_label,
          session.workspace_path,
          session.branch,
          session.session_kind,
          session.character_id,
          session.character_name,
          session.character_icon_path,
          session.character_theme_main,
          session.character_theme_sub,
          session.run_state,
          session.approval_mode,
          session.codex_sandbox_mode,
          session.model,
          session.reasoning_effort,
          session.custom_agent_name,
          session.allowed_additional_directories_json,
          session.thread_id,
          messageCount,
          session.last_active_at,
        );

        for (let index = 0; index < messagesForInsert.length; index += 1) {
          const message = messagesForInsert[index];
          const messageResult = messageStmt.run(
            session.id,
            index,
            message.role,
            message.text,
            message.accent,
            message.artifact === undefined ? 0 : 1,
          );
          const messageRowId = messageResult.lastInsertRowid;
          if (message.artifact !== undefined) {
            messageArtifactStmt.run(messageRowId, JSON.stringify(message.artifact));
            sessionMessageArtifacts += 1;
          }
        }

        sessionMessages += messagesForInsert.length;
      }

      for (const row of appSettings) {
        if (LEGACY_APP_SETTING_KEYS.has(row.setting_key)) {
          continue;
        }

        appSettingStmt.run(row.setting_key, row.setting_value, row.updated_at);
      }

      const modelCatalogCounts = copyModelCatalogTables(v1Db, v2Db);

      const v2InsertedCounts = {
        appSettings: appSettings.length - appSettingLegacyCount,
        ...modelCatalogCounts,
      };

      const issuesForReport = issues;
      const migratedV2Counts = {
        sessions: sessionRows.length,
        sessionMessages,
        sessionMessageArtifacts,
        appSettings: v2InsertedCounts.appSettings,
        modelCatalogRevisions: v2InsertedCounts.modelCatalogRevisions,
        modelCatalogProviders: v2InsertedCounts.modelCatalogProviders,
        modelCatalogModels: v2InsertedCounts.modelCatalogModels,
      };

      v2Db.exec("COMMIT");
      transactionStarted = false;
      migrationSucceeded = true;

      return {
        mode: "write",
        input: {
          sourceDatabaseFile: basename(input.v1DbPath),
          targetDatabaseFile: basename(input.v2DbPath),
          overwrite,
        },
        v1Counts,
        migratedV2Counts,
        skipped: {
          streamEntries: skippedStreamEntries,
          legacyAppSettings: appSettingLegacyCount,
          sessionMemories: countRows(v1Db, "session_memories"),
          projectScopes: countRows(v1Db, "project_scopes"),
          projectMemoryEntries: countRows(v1Db, "project_memory_entries"),
          characterScopes: countRows(v1Db, "character_scopes"),
          characterMemoryEntries: countRows(v1Db, "character_memory_entries"),
          invalidMessages,
        },
        issues: issuesForReport,
      };
    } catch (error) {
      if (transactionStarted) {
        v2Db.exec("ROLLBACK");
      }
      throw error;
    }
  } finally {
    v1Db?.close();
    v2Db?.close();
    if (migrationSucceeded) {
      discardSqliteDatabaseBackups(backups);
    } else {
      restoreSqliteDatabaseBackups(input.v2DbPath, backups);
    }
  }
}
