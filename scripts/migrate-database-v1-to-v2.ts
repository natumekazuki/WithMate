import { existsSync, renameSync, rmSync } from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { CREATE_V2_SCHEMA_SQL } from "../src-electron/database-schema-v2.js";

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
    auditLogs: number;
    appSettings: number;
    modelCatalogRevisions: number;
    modelCatalogProviders: number;
    modelCatalogModels: number;
  };
  plannedV2Counts: {
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
  skipped: {
    streamEntries: number;
    backgroundAuditLogs: number;
    legacyAppSettings: number;
    sessionMemories: number;
    projectScopes: number;
    projectMemoryEntries: number;
    characterScopes: number;
    characterMemoryEntries: number;
    invalidMessages: number;
    invalidAuditOperations: number;
  };
  estimatedSourceBytes: {
    sessionMessagesJson: number;
    sessionStreamJson: number;
    auditOperationsJson: number;
    auditRawItemsJson: number;
    auditUsageJson: number;
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
    auditLogs: number;
    appSettings: number;
    modelCatalogRevisions: number;
    modelCatalogProviders: number;
    modelCatalogModels: number;
  };
  migratedV2Counts: {
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
  skipped: {
    streamEntries: number;
    backgroundAuditLogs: number;
    legacyAppSettings: number;
    sessionMemories: number;
    projectScopes: number;
    projectMemoryEntries: number;
    characterScopes: number;
    characterMemoryEntries: number;
    invalidMessages: number;
    invalidAuditOperations: number;
  };
  issues: MigrationIssue[];
};

type SessionSourceRow = {
  id: string;
  task_title: string;
  task_summary: string;
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

type AuditLogSourceRow = {
  id: number;
  session_id: string;
  created_at: string;
  phase: string;
  provider: string;
  model: string;
  reasoning_effort: string;
  approval_mode: string;
  thread_id: string;
  logical_prompt_json: string;
  transport_payload_json: string;
  assistant_text: string;
  operations_json: string;
  raw_items_json: string;
  usage_json: string;
  error_message: string;
};

type AuditLogSummarySourceRow = Omit<
  AuditLogSourceRow,
  "logical_prompt_json" | "transport_payload_json" | "assistant_text" | "operations_json" | "raw_items_json" | "usage_json"
>;

type AuditLogPayloadSourceRow = Pick<
  AuditLogSourceRow,
  "logical_prompt_json" | "transport_payload_json" | "assistant_text" | "operations_json" | "raw_items_json" | "usage_json"
>;

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

const ASSISTANT_TEXT_PREVIEW_MAX_LENGTH = 500;

type SqliteBackupFile = {
  originalPath: string;
  backupPath: string;
};

function tableExists(db: DatabaseSync, tableName: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?").get(tableName);
  return row !== undefined;
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

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function recordJsonArrayIssue(issues: MigrationIssue[], issue: MigrationIssue): void {
  issues.push(issue);
}

function parseJsonObjectForDetail(issues: MigrationIssue[], input: {
  sourceId: string;
  sourceColumn: string;
  value: string;
}): string {
  if (!input.value) {
    return "";
  }

  const parsed = parseJsonObject(input.value);
  if (parsed === null) {
    issues.push({
      sourceTable: "audit_logs",
      sourceId: input.sourceId,
      sourceColumn: input.sourceColumn,
      errorKind: "invalid_json_object",
      action: "skipped",
    });
    return "";
  }

  return JSON.stringify(parsed);
}

function isMessageCandidate(value: unknown): value is { role?: unknown; artifact?: unknown; text?: unknown; accent?: unknown } {
  return typeof value === "object" && value !== null;
}

function isValidMessage(value: unknown): value is { role: "user" | "assistant"; artifact?: unknown; text?: unknown } {
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

function buildAssistantTextPreview(value: string): string {
  return value.length > ASSISTANT_TEXT_PREVIEW_MAX_LENGTH ? value.slice(0, ASSISTANT_TEXT_PREVIEW_MAX_LENGTH) : value;
}

function isBackgroundAuditLog(phase: string): boolean {
  return phase.startsWith("background-");
}

function toNullableInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
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

  const v1Db = new DatabaseSync(v1DbPath, { readOnly: true });
  try {
    const issues: MigrationIssue[] = [];
    const sessions = tableExists(v1Db, "sessions")
      ? (v1Db.prepare("SELECT id, messages_json, stream_json FROM sessions ORDER BY id").all() as SessionSourceRow[])
      : [];
    const auditLogs = tableExists(v1Db, "audit_logs")
      ? (v1Db.prepare("SELECT id, phase, operations_json, raw_items_json, usage_json FROM audit_logs ORDER BY id").all() as AuditLogSourceRow[])
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

    let plannedAuditLogs = 0;
    let auditLogOperations = 0;
    let backgroundAuditLogs = 0;
    let invalidAuditOperations = 0;

    for (const auditLog of auditLogs) {
      if (isBackgroundAuditLog(auditLog.phase)) {
        backgroundAuditLogs += 1;
        continue;
      }

      plannedAuditLogs += 1;
      const operations = parseJsonArray(auditLog.operations_json);
      if (operations === null) {
        invalidAuditOperations += 1;
        recordJsonArrayIssue(issues, {
          sourceTable: "audit_logs",
          sourceId: String(auditLog.id),
          sourceColumn: "operations_json",
          errorKind: "invalid_json_array",
          action: "skipped",
        });
      } else {
        auditLogOperations += operations.length;
      }

      if (parseJsonArray(auditLog.raw_items_json) === null) {
        recordJsonArrayIssue(issues, {
          sourceTable: "audit_logs",
          sourceId: String(auditLog.id),
          sourceColumn: "raw_items_json",
          errorKind: "invalid_json_array",
          action: "skipped",
        });
      }

      if (auditLog.usage_json) {
        try {
          JSON.parse(auditLog.usage_json);
        } catch {
          issues.push({
            sourceTable: "audit_logs",
            sourceId: String(auditLog.id),
            sourceColumn: "usage_json",
            errorKind: "invalid_json",
            action: "skipped",
          });
        }
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
        auditLogs: auditLogs.length,
        appSettings: appSettings.length,
        modelCatalogRevisions: countRows(v1Db, "model_catalog_revisions"),
        modelCatalogProviders: countRows(v1Db, "model_catalog_providers"),
        modelCatalogModels: countRows(v1Db, "model_catalog_models"),
      },
      plannedV2Counts: {
        sessions: sessions.length,
        sessionMessages,
        sessionMessageArtifacts,
        auditLogs: plannedAuditLogs,
        auditLogDetails: plannedAuditLogs,
        auditLogOperations,
        appSettings: appSettings.length - legacyAppSettings,
        modelCatalogRevisions: countRows(v1Db, "model_catalog_revisions"),
        modelCatalogProviders: countRows(v1Db, "model_catalog_providers"),
        modelCatalogModels: countRows(v1Db, "model_catalog_models"),
      },
      skipped: {
        streamEntries,
        backgroundAuditLogs,
        legacyAppSettings,
        sessionMemories: countRows(v1Db, "session_memories"),
        projectScopes: countRows(v1Db, "project_scopes"),
        projectMemoryEntries: countRows(v1Db, "project_memory_entries"),
        characterScopes: countRows(v1Db, "character_scopes"),
        characterMemoryEntries: countRows(v1Db, "character_memory_entries"),
        invalidMessages,
        invalidAuditOperations,
      },
      estimatedSourceBytes: {
        sessionMessagesJson: sessions.reduce((total, row) => total + row.messages_json.length, 0),
        sessionStreamJson: sessions.reduce((total, row) => total + row.stream_json.length, 0),
        auditOperationsJson: auditLogs.reduce((total, row) => total + row.operations_json.length, 0),
        auditRawItemsJson: auditLogs.reduce((total, row) => total + row.raw_items_json.length, 0),
        auditUsageJson: auditLogs.reduce((total, row) => total + row.usage_json.length, 0),
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
    v1Db = new DatabaseSync(input.v1DbPath, { readOnly: true });
    v2Db = new DatabaseSync(input.v2DbPath);

    const sessionRows = tableExists(v1Db, "sessions")
      ? (v1Db.prepare(
          "SELECT id, task_title, task_summary, status, updated_at, provider, catalog_revision, workspace_label, workspace_path, branch, session_kind, character_id, character_name, character_icon_path, character_theme_main, character_theme_sub, run_state, approval_mode, codex_sandbox_mode, model, reasoning_effort, custom_agent_name, allowed_additional_directories_json, thread_id, last_active_at FROM sessions ORDER BY id",
        ).all() as SessionHeaderSourceRow[])
      : [];

    const auditLogRows = tableExists(v1Db, "audit_logs")
      ? (v1Db.prepare(
          "SELECT id, session_id, created_at, phase, provider, model, reasoning_effort, approval_mode, thread_id, error_message FROM audit_logs ORDER BY id",
        ).all() as AuditLogSummarySourceRow[])
      : [];

    const appSettings = tableExists(v1Db, "app_settings")
      ? (v1Db.prepare("SELECT setting_key, setting_value, updated_at FROM app_settings ORDER BY setting_key").all() as AppSettingSourceRow[])
      : [];

    const appSettingLegacyCount = appSettings.filter((row) => LEGACY_APP_SETTING_KEYS.has(row.setting_key)).length;
    const v1Counts = {
      sessions: sessionRows.length,
      auditLogs: auditLogRows.length,
      appSettings: appSettings.length,
      modelCatalogRevisions: countRows(v1Db, "model_catalog_revisions"),
      modelCatalogProviders: countRows(v1Db, "model_catalog_providers"),
      modelCatalogModels: countRows(v1Db, "model_catalog_models"),
    };

    const sessionPayloadStmt = tableExists(v1Db, "sessions")
      ? v1Db.prepare("SELECT messages_json, stream_json FROM sessions WHERE id = ?")
      : null;
    const auditLogPayloadStmt = tableExists(v1Db, "audit_logs")
      ? v1Db.prepare(
          "SELECT logical_prompt_json, transport_payload_json, assistant_text, operations_json, raw_items_json, usage_json FROM audit_logs WHERE id = ?",
        )
      : null;

    const auditLogsBySession = new Map<string, AuditLogSummarySourceRow[]>();
    const nonBackgroundAuditLogs: AuditLogSummarySourceRow[] = [];
    let skippedStreamEntries = 0;
    let backgroundAuditLogs = 0;
    let invalidMessages = 0;
    let invalidAuditOperations = 0;

    for (const auditLog of auditLogRows) {
      if (isBackgroundAuditLog(auditLog.phase)) {
        backgroundAuditLogs += 1;
        continue;
      }

      nonBackgroundAuditLogs.push(auditLog);
      const list = auditLogsBySession.get(auditLog.session_id) ?? [];
      list.push(auditLog);
      auditLogsBySession.set(auditLog.session_id, list);
    }

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
    let auditLogsInserted = 0;
    let auditLogDetailsInserted = 0;
    let auditLogOperationsInserted = 0;

    try {
      v2Db.exec("BEGIN IMMEDIATE");
      transactionStarted = true;

      for (const statement of CREATE_V2_SCHEMA_SQL) {
        v2Db.exec(statement);
      }

      const sessionStmt = v2Db.prepare(
        "INSERT INTO sessions (id, task_title, task_summary, status, updated_at, provider, catalog_revision, workspace_label, workspace_path, branch, session_kind, character_id, character_name, character_icon_path, character_theme_main, character_theme_sub, run_state, approval_mode, codex_sandbox_mode, model, reasoning_effort, custom_agent_name, allowed_additional_directories_json, thread_id, message_count, audit_log_count, last_active_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      const messageStmt = v2Db.prepare(
        "INSERT INTO session_messages (session_id, seq, role, text, accent, artifact_available) VALUES (?, ?, ?, ?, ?, ?)",
      );
      const messageArtifactStmt = v2Db.prepare("INSERT INTO session_message_artifacts (message_id, artifact_json) VALUES (?, ?)");
      const auditLogStmt = v2Db.prepare(
        "INSERT INTO audit_logs (session_id, created_at, phase, provider, model, reasoning_effort, approval_mode, thread_id, assistant_text_preview, operation_count, raw_item_count, input_tokens, cached_input_tokens, output_tokens, has_error, error_message, detail_available) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      const auditLogDetailStmt = v2Db.prepare(
        "INSERT INTO audit_log_details (audit_log_id, logical_prompt_json, transport_payload_json, assistant_text, raw_items_json, usage_json) VALUES (?, ?, ?, ?, ?, ?)",
      );
      const auditLogOperationStmt = v2Db.prepare(
        "INSERT INTO audit_log_operations (audit_log_id, seq, operation_type, summary, details) VALUES (?, ?, ?, ?, ?)",
      );
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

        const sessionAuditLogs = auditLogsBySession.get(session.id) ?? [];
        const sessionAuditLogCount = sessionAuditLogs.length;

        sessionStmt.run(
          session.id,
          session.task_title,
          session.task_summary,
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
          sessionAuditLogCount,
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

      for (const row of nonBackgroundAuditLogs) {
        const auditLogPayload = auditLogPayloadStmt?.get(row.id) as AuditLogPayloadSourceRow | undefined;
        if (auditLogPayload === undefined) {
          continue;
        }

        const operations = parseJsonArray(auditLogPayload.operations_json);
        const rawItems = parseJsonArray(auditLogPayload.raw_items_json);
        let inputTokens = null as number | null;
        let cachedInputTokens = null as number | null;
        let outputTokens = null as number | null;

        const logicalPromptJsonForDetail = parseJsonObjectForDetail(issues, {
          sourceId: String(row.id),
          sourceColumn: "logical_prompt_json",
          value: auditLogPayload.logical_prompt_json,
        });
        const transportPayloadJsonForDetail = parseJsonObjectForDetail(issues, {
          sourceId: String(row.id),
          sourceColumn: "transport_payload_json",
          value: auditLogPayload.transport_payload_json,
        });
        const usageJsonForDetail = parseJsonObjectForDetail(issues, {
          sourceId: String(row.id),
          sourceColumn: "usage_json",
          value: auditLogPayload.usage_json,
        });

        if (usageJsonForDetail) {
          const usage = parseJsonObject(usageJsonForDetail);
          if (usage === null) {
            issues.push({
              sourceTable: "audit_logs",
              sourceId: String(row.id),
              sourceColumn: "usage_json",
              errorKind: "invalid_json_object",
              action: "skipped",
            });
          } else {
            inputTokens = toNullableInteger(usage.inputTokens);
            cachedInputTokens = toNullableInteger(usage.cachedInputTokens);
            outputTokens = toNullableInteger(usage.outputTokens);
          }
        }

        if (operations === null) {
          invalidAuditOperations += 1;
          recordJsonArrayIssue(issues, {
            sourceTable: "audit_logs",
            sourceId: String(row.id),
            sourceColumn: "operations_json",
            errorKind: "invalid_json_array",
            action: "skipped",
          });
        }

        if (rawItems === null) {
          issues.push({
            sourceTable: "audit_logs",
            sourceId: String(row.id),
            sourceColumn: "raw_items_json",
            errorKind: "invalid_json_array",
            action: "skipped",
          });
        }

        const operationCount = operations === null ? 0 : operations.length;
        const rawItemCount = rawItems === null ? 0 : rawItems.length;

        const auditLogIdResult = auditLogStmt.run(
          row.session_id,
          row.created_at,
          row.phase,
          row.provider,
          row.model,
          row.reasoning_effort,
          row.approval_mode,
          row.thread_id,
          buildAssistantTextPreview(auditLogPayload.assistant_text),
          operationCount,
          rawItemCount,
          inputTokens,
          cachedInputTokens,
          outputTokens,
          row.error_message ? 1 : 0,
          row.error_message,
          1,
        );

        const auditLogId = auditLogIdResult.lastInsertRowid;
        const rawItemsForInsert = rawItems === null ? "[]" : JSON.stringify(rawItems);

        auditLogDetailStmt.run(
          auditLogId,
          logicalPromptJsonForDetail,
          transportPayloadJsonForDetail,
          auditLogPayload.assistant_text,
          rawItemsForInsert,
          usageJsonForDetail,
        );

        if (operations !== null) {
          operations.forEach((operation: unknown, operationIndex) => {
            const operationType =
              isMessageCandidate(operation) && typeof operation.type === "string" ? operation.type : "";
            const summary = isMessageCandidate(operation) && typeof operation.summary === "string" ? operation.summary : "";
            const details = isMessageCandidate(operation) && typeof operation.details === "string" ? operation.details : "";

            auditLogOperationStmt.run(auditLogId, operationIndex, operationType, summary, details);
          });
          auditLogOperationsInserted += operationCount;
        }

        auditLogDetailsInserted += 1;
        auditLogsInserted += 1;
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
        auditLogs: auditLogsInserted,
        auditLogDetails: auditLogDetailsInserted,
        auditLogOperations: auditLogOperationsInserted,
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
          backgroundAuditLogs,
          legacyAppSettings: appSettingLegacyCount,
          sessionMemories: countRows(v1Db, "session_memories"),
          projectScopes: countRows(v1Db, "project_scopes"),
          projectMemoryEntries: countRows(v1Db, "project_memory_entries"),
          characterScopes: countRows(v1Db, "character_scopes"),
          characterMemoryEntries: countRows(v1Db, "character_memory_entries"),
          invalidMessages,
          invalidAuditOperations,
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

type CliArgs = {
  mode: "dry-run" | "write" | null;
  v1DbPath: string | null;
  v2DbPath: string | null;
  overwrite: boolean;
};

function parseCliArgs(argv: string[]): CliArgs {
  let mode: "dry-run" | "write" | null = null;
  let v1DbPath: string | null = null;
  let v2DbPath: string | null = null;
  let overwrite = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      mode = "dry-run";
      continue;
    }

    if (arg === "--write") {
      mode = "write";
      continue;
    }

    if (arg === "--v1" || arg === "--input") {
      v1DbPath = argv[index + 1] ?? null;
      index += 1;
      continue;
    }

    if (arg === "--v2") {
      v2DbPath = argv[index + 1] ?? null;
      index += 1;
      continue;
    }

    if (arg === "--overwrite") {
      overwrite = true;
      continue;
    }
  }

  return {
    mode,
    v1DbPath,
    v2DbPath,
    overwrite,
  };
}

function printUsageAndExit(): never {
  console.error(
    "Usage: npx tsx scripts/migrate-database-v1-to-v2.ts --dry-run --v1 <path-to-withmate.db>\n" +
      "       npx tsx scripts/migrate-database-v1-to-v2.ts --write --v1 <path-to-withmate.db> --v2 <path-to-withmate-v2.db> [--overwrite]",
  );
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { mode, v1DbPath, v2DbPath, overwrite } = parseCliArgs(process.argv.slice(2));

  if (mode === "dry-run") {
    if (!v1DbPath) {
      printUsageAndExit();
    }
    const report = createMigrationDryRunReport(v1DbPath);
    console.log(JSON.stringify(report, null, 2));
  } else if (mode === "write") {
    if (!v1DbPath || !v2DbPath) {
      printUsageAndExit();
    }
    const report = createMigrationWriteReport({
      v1DbPath,
      v2DbPath,
      overwrite,
    });
    console.log(JSON.stringify(report, null, 2));
  } else {
    printUsageAndExit();
  }
}
