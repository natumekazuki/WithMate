import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import type {
  AuditLogEntry,
  AuditLogicalPrompt,
  AuditLogOperation,
  AuditLogPhase,
  AuditLogUsage,
  AuditTransportPayload,
  Session,
} from "../src/app-state.js";
import type { CompanionGroup, CompanionMergeRun, CompanionSession } from "../src/companion-state.js";
import { DEFAULT_APPROVAL_MODE, normalizeApprovalMode } from "../src/approval-mode.js";
import { DEFAULT_CODEX_SANDBOX_MODE, normalizeCodexSandboxMode } from "../src/codex-sandbox-mode.js";
import { DEFAULT_CATALOG_REVISION, DEFAULT_MODEL_ID, DEFAULT_PROVIDER_ID, DEFAULT_REASONING_EFFORT } from "../src/model-catalog.js";
import { normalizeSession } from "../src/session-state.js";
import { AuditLogStorageV3 } from "../src-electron/audit-log-storage-v3.js";
import { CompanionStorageV3 } from "../src-electron/companion-storage-v3.js";
import { CREATE_V3_SCHEMA_SQL } from "../src-electron/database-schema-v3.js";
import { SessionStorageV3 } from "../src-electron/session-storage-v3.js";

export type V2ToV3MigrationDryRunReport = {
  mode: "dry-run";
  input: {
    databaseFile: string;
  };
  v2Counts: {
    sessions: number;
    sessionMessages: number;
    sessionMessageArtifacts: number;
    auditLogs: number;
    auditLogDetails: number;
    auditLogOperations: number;
    companionGroups: number;
    companionSessions: number;
    companionMessages: number;
    companionMessageArtifacts: number;
    companionMergeRuns: number;
    appSettings: number;
    modelCatalogRevisions: number;
    modelCatalogProviders: number;
    modelCatalogModels: number;
  };
  plannedV3Counts: {
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
  estimatedSourceBytes: {
    sessionMessageText: number;
    sessionMessageArtifactsJson: number;
    auditLogicalPromptJson: number;
    auditTransportPayloadJson: number;
    auditAssistantText: number;
    auditRawItemsJson: number;
    auditUsageJson: number;
    auditOperationDetails: number;
    companionCharacterRoleMarkdown: number;
    companionMessageText: number;
    companionMessageArtifactsJson: number;
    companionMergeDiffSnapshotJson: number;
  };
};

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

type SqliteBackupFile = {
  originalPath: string;
  backupPath: string;
};

type PathBackup = {
  originalPath: string;
  backupPath: string;
};

type CountRow = {
  count: number;
};

type SessionHeaderRow = {
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
  last_active_at: number;
};

type SessionMessageRow = {
  role: string;
  text: string;
  accent: number;
  artifact_json: string | null;
};

type AuditLogRow = {
  id: number;
  session_id: string;
  created_at: string;
  phase: string;
  provider: string;
  model: string;
  reasoning_effort: string;
  approval_mode: string;
  thread_id: string;
  error_message: string;
  logical_prompt_json: string | null;
  transport_payload_json: string | null;
  assistant_text: string | null;
  raw_items_json: string | null;
  usage_json: string | null;
};

type AuditLogOperationRow = {
  operation_type: string;
  summary: string;
  details: string;
};

type AppSettingRow = {
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

type CompanionGroupRow = {
  id: string;
  repo_root: string;
  display_name: string;
  created_at: string;
  updated_at: string;
};

type CompanionSessionRow = {
  id: string;
  group_id: string;
  task_title: string;
  status: string;
  repo_root: string;
  focus_path: string;
  target_branch: string;
  base_snapshot_ref: string;
  base_snapshot_commit: string;
  companion_branch: string;
  worktree_path: string;
  selected_paths_json: string;
  changed_files_json: string;
  sibling_warnings_json: string;
  allowed_additional_directories_json: string;
  run_state: string;
  thread_id: string;
  provider: string;
  catalog_revision: number;
  model: string;
  reasoning_effort: string;
  custom_agent_name: string;
  approval_mode: string;
  codex_sandbox_mode: string;
  character_id: string;
  character_name: string;
  character_role_markdown: string;
  character_icon_path: string;
  character_theme_main: string;
  character_theme_sub: string;
  created_at: string;
  updated_at: string;
};

type CompanionMessageRow = {
  role: string;
  text: string;
  accent: number;
  artifact_json: string;
};

type CompanionMergeRunRow = {
  id: string;
  session_id: string;
  group_id: string;
  operation: string;
  selected_paths_json: string;
  changed_files_json: string;
  diff_snapshot_json: string;
  sibling_warnings_json: string;
  created_at: string;
};

const SESSION_HEADER_COLUMNS = `
  id,
  task_title,
  task_summary,
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

const COMPANION_SESSION_COLUMNS = `
  id,
  group_id,
  task_title,
  status,
  repo_root,
  focus_path,
  target_branch,
  base_snapshot_ref,
  base_snapshot_commit,
  companion_branch,
  worktree_path,
  selected_paths_json,
  changed_files_json,
  sibling_warnings_json,
  allowed_additional_directories_json,
  run_state,
  thread_id,
  provider,
  catalog_revision,
  model,
  reasoning_effort,
  custom_agent_name,
  approval_mode,
  codex_sandbox_mode,
  character_id,
  character_name,
  character_role_markdown,
  character_icon_path,
  character_theme_main,
  character_theme_sub,
  created_at,
  updated_at
`;

const COMPANION_MERGE_RUN_COLUMNS = `
  id,
  session_id,
  group_id,
  operation,
  selected_paths_json,
  changed_files_json,
  diff_snapshot_json,
  sibling_warnings_json,
  created_at
`;

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

function countNonEmptyRows(db: DatabaseSync, tableName: string, columnName: string): number {
  if (!tableExists(db, tableName)) {
    return 0;
  }
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${tableName} WHERE ${columnName} IS NOT NULL AND length(trim(${columnName})) > 0`).get() as CountRow;
  return row.count;
}

function textBytes(value: string | null | undefined): number {
  return Buffer.byteLength(value ?? "", "utf8");
}

function sqliteDatabaseFilePaths(dbPath: string): string[] {
  return [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
}

function sqliteDatabaseFilesExist(dbPath: string): boolean {
  return sqliteDatabaseFilePaths(dbPath).some((path) => existsSync(path));
}

function assertDistinctMigrationPaths(sourceDbPath: string, targetDbPath: string): void {
  const sourcePaths = new Set(sqliteDatabaseFilePaths(sourceDbPath).map((path) => resolve(path)));
  const targetPaths = new Set(sqliteDatabaseFilePaths(targetDbPath).map((path) => resolve(path)));

  for (const path of sourcePaths) {
    if (targetPaths.has(path)) {
      throw new Error("V2 and V3 database paths must be different");
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

function backupExistingPath(path: string): PathBackup | null {
  if (!existsSync(path)) {
    return null;
  }
  const backupPath = `${path}.migration-backup-${process.pid}-${Date.now()}`;
  renameSync(path, backupPath);
  return { originalPath: path, backupPath };
}

function restorePathBackup(path: string, backup: PathBackup | null): void {
  rmSync(path, { recursive: true, force: true });
  if (backup && existsSync(backup.backupPath)) {
    renameSync(backup.backupPath, backup.originalPath);
  }
}

function discardPathBackup(backup: PathBackup | null): void {
  if (backup) {
    rmSync(backup.backupPath, { recursive: true, force: true });
  }
}

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

function parseJsonObject<T extends object>(value: string | null | undefined, fallback: T): T {
  if (!value) {
    return fallback;
  }
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as T : fallback;
  } catch {
    return fallback;
  }
}

function parseAllowedAdditionalDirectories(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function parseStringArray(value: string | null | undefined): string[] {
  return parseJsonArray(value).filter((entry): entry is string => typeof entry === "string");
}

function normalizeAuditLogPhase(value: string): AuditLogPhase {
  if (
    value === "running"
    || value === "started"
    || value === "completed"
    || value === "failed"
    || value === "canceled"
    || value === "background-running"
    || value === "background-completed"
    || value === "background-failed"
    || value === "background-canceled"
  ) {
    return value;
  }

  return "failed";
}

function normalizeReasoningEffort(value: string): typeof DEFAULT_REASONING_EFFORT {
  if (value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh") {
    return value;
  }

  return DEFAULT_REASONING_EFFORT;
}

function normalizeCompanionStatus(value: string): CompanionSession["status"] {
  if (value === "merged" || value === "discarded" || value === "recovery-required") {
    return value;
  }
  return "active";
}

function normalizeCompanionRunState(value: string): CompanionSession["runState"] {
  return value === "running" || value === "error" ? value : "idle";
}

function rowToCompanionGroup(row: CompanionGroupRow): CompanionGroup {
  return {
    id: row.id,
    repoRoot: row.repo_root,
    displayName: row.display_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToCompanionMessage(row: CompanionMessageRow): CompanionSession["messages"][number] {
  return {
    role: row.role === "assistant" ? "assistant" : "user",
    text: row.text,
    accent: row.accent === 1 ? true : undefined,
    artifact: row.artifact_json.trim()
      ? parseJsonObject(row.artifact_json, {}) as CompanionSession["messages"][number]["artifact"]
      : undefined,
  };
}

function rowToCompanionSession(row: CompanionSessionRow, messages: CompanionMessageRow[]): CompanionSession {
  return {
    id: row.id,
    groupId: row.group_id,
    taskTitle: row.task_title,
    status: normalizeCompanionStatus(row.status),
    repoRoot: row.repo_root,
    focusPath: row.focus_path,
    targetBranch: row.target_branch,
    baseSnapshotRef: row.base_snapshot_ref,
    baseSnapshotCommit: row.base_snapshot_commit,
    companionBranch: row.companion_branch,
    worktreePath: row.worktree_path,
    selectedPaths: parseStringArray(row.selected_paths_json),
    changedFiles: parseJsonArray(row.changed_files_json) as CompanionSession["changedFiles"],
    siblingWarnings: parseJsonArray(row.sibling_warnings_json) as CompanionSession["siblingWarnings"],
    allowedAdditionalDirectories: parseStringArray(row.allowed_additional_directories_json),
    runState: normalizeCompanionRunState(row.run_state),
    threadId: row.thread_id,
    provider: row.provider || DEFAULT_PROVIDER_ID,
    catalogRevision: row.catalog_revision || DEFAULT_CATALOG_REVISION,
    model: row.model || DEFAULT_MODEL_ID,
    reasoningEffort: normalizeReasoningEffort(row.reasoning_effort),
    customAgentName: row.custom_agent_name,
    approvalMode: normalizeApprovalMode(row.approval_mode),
    codexSandboxMode: normalizeCodexSandboxMode(row.codex_sandbox_mode),
    characterId: row.character_id,
    character: row.character_name,
    characterRoleMarkdown: row.character_role_markdown,
    characterIconPath: row.character_icon_path,
    characterThemeColors: {
      main: row.character_theme_main,
      sub: row.character_theme_sub,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messages: messages.map(rowToCompanionMessage),
  };
}

function rowToCompanionMergeRun(row: CompanionMergeRunRow): CompanionMergeRun {
  return {
    id: row.id,
    sessionId: row.session_id,
    groupId: row.group_id,
    operation: row.operation === "discard" ? "discard" : "merge",
    selectedPaths: parseStringArray(row.selected_paths_json),
    changedFiles: parseJsonArray(row.changed_files_json) as CompanionMergeRun["changedFiles"],
    diffSnapshot: parseJsonArray(row.diff_snapshot_json) as CompanionMergeRun["diffSnapshot"],
    siblingWarnings: parseJsonArray(row.sibling_warnings_json) as CompanionMergeRun["siblingWarnings"],
    createdAt: row.created_at,
  };
}

function rowToSession(row: SessionHeaderRow, messages: SessionMessageRow[]): Session {
  const session = normalizeSession({
    id: row.id,
    taskTitle: row.task_title,
    taskSummary: row.task_summary,
    status: row.status,
    updatedAt: row.updated_at,
    provider: row.provider || DEFAULT_PROVIDER_ID,
    catalogRevision: row.catalog_revision || DEFAULT_CATALOG_REVISION,
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
    approvalMode: normalizeApprovalMode(row.approval_mode, DEFAULT_APPROVAL_MODE),
    codexSandboxMode: normalizeCodexSandboxMode(row.codex_sandbox_mode, DEFAULT_CODEX_SANDBOX_MODE),
    model: row.model || DEFAULT_MODEL_ID,
    reasoningEffort: normalizeReasoningEffort(row.reasoning_effort),
    customAgentName: row.custom_agent_name,
    allowedAdditionalDirectories: parseAllowedAdditionalDirectories(row.allowed_additional_directories_json),
    threadId: row.thread_id,
    messages: messages.map((message) => ({
      role: message.role,
      text: message.text,
      accent: message.accent === 1 ? true : undefined,
      artifact: message.artifact_json ? parseJsonObject(message.artifact_json, {}) : undefined,
    })),
    stream: [],
  });

  if (!session) {
    throw new Error(`V2 session ${row.id} is invalid`);
  }
  return session;
}

function rowToAuditLogEntry(row: AuditLogRow, operations: AuditLogOperationRow[]): Omit<AuditLogEntry, "id"> {
  const usage = parseJsonObject<Partial<AuditLogUsage>>(row.usage_json, {});
  const normalizedUsage =
    typeof usage.inputTokens === "number"
    && typeof usage.cachedInputTokens === "number"
    && typeof usage.outputTokens === "number"
      ? {
          inputTokens: usage.inputTokens,
          cachedInputTokens: usage.cachedInputTokens,
          outputTokens: usage.outputTokens,
        }
      : null;

  return {
    sessionId: row.session_id,
    createdAt: row.created_at,
    phase: normalizeAuditLogPhase(row.phase),
    provider: row.provider || DEFAULT_PROVIDER_ID,
    model: row.model || DEFAULT_MODEL_ID,
    reasoningEffort: normalizeReasoningEffort(row.reasoning_effort),
    approvalMode: normalizeApprovalMode(row.approval_mode, DEFAULT_APPROVAL_MODE),
    threadId: row.thread_id,
    logicalPrompt: parseJsonObject<AuditLogicalPrompt>(row.logical_prompt_json, {
      systemText: "",
      inputText: "",
      composedText: "",
    }),
    transportPayload: row.transport_payload_json
      ? parseJsonObject<AuditTransportPayload>(row.transport_payload_json, { summary: "", fields: [] })
      : null,
    assistantText: row.assistant_text ?? "",
    operations: operations.map((operation): AuditLogOperation => ({
      type: operation.operation_type,
      summary: operation.summary,
      details: operation.details || undefined,
    })),
    rawItemsJson: JSON.stringify(parseJsonArray(row.raw_items_json)),
    usage: normalizedUsage,
    errorMessage: row.error_message,
  };
}

function readV2Counts(db: DatabaseSync): V2ToV3MigrationDryRunReport["v2Counts"] {
  return {
    sessions: countRows(db, "sessions"),
    sessionMessages: countRows(db, "session_messages"),
    sessionMessageArtifacts: countRows(db, "session_message_artifacts"),
    auditLogs: countRows(db, "audit_logs"),
    auditLogDetails: countRows(db, "audit_log_details"),
    auditLogOperations: countRows(db, "audit_log_operations"),
    companionGroups: countRows(db, "companion_groups"),
    companionSessions: countRows(db, "companion_sessions"),
    companionMessages: countRows(db, "companion_messages"),
    companionMessageArtifacts: countNonEmptyRows(db, "companion_messages", "artifact_json"),
    companionMergeRuns: countRows(db, "companion_merge_runs"),
    appSettings: countRows(db, "app_settings"),
    modelCatalogRevisions: countRows(db, "model_catalog_revisions"),
    modelCatalogProviders: countRows(db, "model_catalog_providers"),
    modelCatalogModels: countRows(db, "model_catalog_models"),
  };
}

function sumTextBytes(db: DatabaseSync, sql: string, ...params: SQLInputValue[]): number {
  return (db.prepare(sql).all(...params) as Array<{ value: string | null }>)
    .reduce((total, row) => total + textBytes(row.value), 0);
}

function createEstimatedSourceBytes(db: DatabaseSync): V2ToV3MigrationDryRunReport["estimatedSourceBytes"] {
  return {
    sessionMessageText: tableExists(db, "session_messages")
      ? sumTextBytes(db, "SELECT text AS value FROM session_messages")
      : 0,
    sessionMessageArtifactsJson: tableExists(db, "session_message_artifacts")
      ? sumTextBytes(db, "SELECT artifact_json AS value FROM session_message_artifacts")
      : 0,
    auditLogicalPromptJson: tableExists(db, "audit_log_details")
      ? sumTextBytes(db, "SELECT logical_prompt_json AS value FROM audit_log_details")
      : 0,
    auditTransportPayloadJson: tableExists(db, "audit_log_details")
      ? sumTextBytes(db, "SELECT transport_payload_json AS value FROM audit_log_details")
      : 0,
    auditAssistantText: tableExists(db, "audit_log_details")
      ? sumTextBytes(db, "SELECT assistant_text AS value FROM audit_log_details")
      : 0,
    auditRawItemsJson: tableExists(db, "audit_log_details")
      ? sumTextBytes(db, "SELECT raw_items_json AS value FROM audit_log_details")
      : 0,
    auditUsageJson: tableExists(db, "audit_log_details")
      ? sumTextBytes(db, "SELECT usage_json AS value FROM audit_log_details")
      : 0,
    auditOperationDetails: tableExists(db, "audit_log_operations")
      ? sumTextBytes(db, "SELECT details AS value FROM audit_log_operations")
      : 0,
    companionCharacterRoleMarkdown: tableExists(db, "companion_sessions")
      ? sumTextBytes(db, "SELECT character_role_markdown AS value FROM companion_sessions")
      : 0,
    companionMessageText: tableExists(db, "companion_messages")
      ? sumTextBytes(db, "SELECT text AS value FROM companion_messages")
      : 0,
    companionMessageArtifactsJson: tableExists(db, "companion_messages")
      ? sumTextBytes(db, "SELECT artifact_json AS value FROM companion_messages")
      : 0,
    companionMergeDiffSnapshotJson: tableExists(db, "companion_merge_runs")
      ? sumTextBytes(db, "SELECT diff_snapshot_json AS value FROM companion_merge_runs")
      : 0,
  };
}

function openReadOnlySource(dbPath: string): DatabaseSync {
  if (!existsSync(dbPath)) {
    throw new Error(`V2 database not found: ${dbPath}`);
  }
  return new DatabaseSync(dbPath, { readOnly: true });
}

function createV3Schema(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA foreign_keys = ON;");
    for (const statement of CREATE_V3_SCHEMA_SQL) {
      db.exec(statement);
    }
  } finally {
    db.close();
  }
}

function copyAppSettings(sourceDb: DatabaseSync, targetDb: DatabaseSync): number {
  if (!tableExists(sourceDb, "app_settings")) {
    return 0;
  }
  const rows = sourceDb
    .prepare("SELECT setting_key, setting_value, updated_at FROM app_settings ORDER BY setting_key")
    .all() as AppSettingRow[];
  const stmt = targetDb.prepare("INSERT INTO app_settings (setting_key, setting_value, updated_at) VALUES (?, ?, ?)");
  for (const row of rows) {
    stmt.run(row.setting_key, row.setting_value, row.updated_at);
  }
  return rows.length;
}

function copyModelCatalogTables(sourceDb: DatabaseSync, targetDb: DatabaseSync): {
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
    ? sourceDb.prepare("SELECT revision, source, imported_at, is_active FROM model_catalog_revisions ORDER BY revision").all() as ModelCatalogRevisionRow[]
    : [];
  const providers = tableExists(sourceDb, "model_catalog_providers")
    ? sourceDb.prepare("SELECT revision, provider_id, label, default_model_id, default_reasoning_effort, sort_order FROM model_catalog_providers ORDER BY revision, provider_id").all() as ModelCatalogProviderRow[]
    : [];
  const models = tableExists(sourceDb, "model_catalog_models")
    ? sourceDb.prepare("SELECT revision, provider_id, model_id, label, reasoning_efforts_json, sort_order FROM model_catalog_models ORDER BY revision, provider_id, model_id").all() as ModelCatalogModelRow[]
    : [];

  for (const row of revisions) {
    revisionStmt.run(row.revision, row.source, row.imported_at, row.is_active);
  }
  for (const row of providers) {
    providerStmt.run(row.revision, row.provider_id, row.label, row.default_model_id, row.default_reasoning_effort, row.sort_order);
  }
  for (const row of models) {
    modelStmt.run(row.revision, row.provider_id, row.model_id, row.label, row.reasoning_efforts_json, row.sort_order);
  }

  return {
    modelCatalogRevisions: revisions.length,
    modelCatalogProviders: providers.length,
    modelCatalogModels: models.length,
  };
}

function readSessionMessages(db: DatabaseSync, sessionId: string): SessionMessageRow[] {
  return db.prepare(`
    SELECT
      m.role,
      m.text,
      m.accent,
      a.artifact_json
    FROM session_messages AS m
    LEFT JOIN session_message_artifacts AS a
      ON a.message_id = m.id
    WHERE m.session_id = ?
    ORDER BY m.seq ASC
  `).all(sessionId) as SessionMessageRow[];
}

function readAuditOperations(db: DatabaseSync, auditLogId: number): AuditLogOperationRow[] {
  return db.prepare(`
    SELECT operation_type, summary, details
    FROM audit_log_operations
    WHERE audit_log_id = ?
    ORDER BY seq ASC
  `).all(auditLogId) as AuditLogOperationRow[];
}

function readCompanionGroups(db: DatabaseSync): CompanionGroup[] {
  if (!tableExists(db, "companion_groups")) {
    return [];
  }
  const rows = db.prepare(`
    SELECT id, repo_root, display_name, created_at, updated_at
    FROM companion_groups
    ORDER BY created_at ASC, id ASC
  `).all() as CompanionGroupRow[];
  return rows.map(rowToCompanionGroup);
}

function readCompanionMessages(db: DatabaseSync, sessionId: string): CompanionMessageRow[] {
  if (!tableExists(db, "companion_messages")) {
    return [];
  }
  return db.prepare(`
    SELECT role, text, accent, artifact_json
    FROM companion_messages
    WHERE session_id = ?
    ORDER BY position ASC
  `).all(sessionId) as CompanionMessageRow[];
}

function readCompanionSessions(db: DatabaseSync): CompanionSession[] {
  if (!tableExists(db, "companion_sessions")) {
    return [];
  }
  const rows = db.prepare(`
    SELECT ${COMPANION_SESSION_COLUMNS}
    FROM companion_sessions
    ORDER BY updated_at ASC, id ASC
  `).all() as CompanionSessionRow[];
  return rows.map((row) => rowToCompanionSession(row, readCompanionMessages(db, row.id)));
}

function readCompanionMergeRuns(db: DatabaseSync): CompanionMergeRun[] {
  if (!tableExists(db, "companion_merge_runs")) {
    return [];
  }
  const rows = db.prepare(`
    SELECT ${COMPANION_MERGE_RUN_COLUMNS}
    FROM companion_merge_runs
    ORDER BY created_at ASC, id ASC
  `).all() as CompanionMergeRunRow[];
  return rows.map(rowToCompanionMergeRun);
}

export function createMigrationDryRunReport(v2DbPath: string): V2ToV3MigrationDryRunReport {
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

  assertDistinctMigrationPaths(input.sourceDatabaseFile, input.targetDatabaseFile);

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
  let auditLogStorage: AuditLogStorageV3 | null = null;
  let companionStorage: CompanionStorageV3 | null = null;

  try {
    dbBackups = overwrite ? backupExistingSqliteDatabaseFiles(input.targetDatabaseFile) : [];
    blobBackup = overwrite ? backupExistingPath(input.blobRootPath) : null;
    mkdirSync(resolve(input.blobRootPath), { recursive: true });

    createV3Schema(input.targetDatabaseFile);

    const v2Counts = readV2Counts(sourceDb);

    const targetDb = new DatabaseSync(input.targetDatabaseFile);
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

    sessionStorage = new SessionStorageV3(input.targetDatabaseFile, input.blobRootPath);
    auditLogStorage = new AuditLogStorageV3(input.targetDatabaseFile, input.blobRootPath);
    companionStorage = new CompanionStorageV3(input.targetDatabaseFile, input.blobRootPath);

    const sessionRows = tableExists(sourceDb, "sessions")
      ? sourceDb.prepare(`SELECT ${SESSION_HEADER_COLUMNS} FROM sessions ORDER BY last_active_at DESC, id DESC`).all() as SessionHeaderRow[]
      : [];
    for (const row of sessionRows) {
      await sessionStorage.upsertSession(rowToSession(row, readSessionMessages(sourceDb, row.id)));
    }

    const auditRows = tableExists(sourceDb, "audit_logs")
      ? sourceDb.prepare(`
          SELECT
            a.id,
            a.session_id,
            a.created_at,
            a.phase,
            a.provider,
            a.model,
            a.reasoning_effort,
            a.approval_mode,
            a.thread_id,
            a.error_message,
            d.logical_prompt_json,
            d.transport_payload_json,
            d.assistant_text,
            d.raw_items_json,
            d.usage_json
          FROM audit_logs AS a
          LEFT JOIN audit_log_details AS d
            ON d.audit_log_id = a.id
          ORDER BY a.id ASC
        `).all() as AuditLogRow[]
      : [];
    for (const row of auditRows) {
      await auditLogStorage.createAuditLog(rowToAuditLogEntry(row, readAuditOperations(sourceDb, row.id)));
    }

    const companionGroups = readCompanionGroups(sourceDb);
    for (const group of companionGroups) {
      await companionStorage.ensureGroup(group);
    }

    const companionSessions = readCompanionSessions(sourceDb);
    for (const session of companionSessions) {
      await companionStorage.createSession(session);
    }

    const companionMergeRuns = readCompanionMergeRuns(sourceDb);
    for (const run of companionMergeRuns) {
      await companionStorage.createMergeRun(run);
    }

    const reportDb = new DatabaseSync(input.targetDatabaseFile, { readOnly: true });
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
        auditLogs: auditRows.length,
        auditLogDetails: v2Counts.auditLogDetails,
        auditLogOperations: v2Counts.auditLogOperations,
        companionGroups: companionGroups.length,
        companionSessions: companionSessions.length,
        companionMessages: v2Counts.companionMessages,
        companionMessageArtifacts: v2Counts.companionMessageArtifacts,
        companionMergeRuns: companionMergeRuns.length,
        appSettings: copiedAppSettings,
        ...copiedModelCatalogCounts,
        blobObjects,
      },
    };
  } finally {
    sessionStorage?.close();
    auditLogStorage?.close();
    companionStorage?.close();
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

type CliArgs = {
  mode: "dry-run" | "write" | null;
  sourceDatabaseFile: string | null;
  targetDatabaseFile: string | null;
  blobRootPath: string | null;
  overwrite: boolean;
};

function parseCliArgs(argv: string[]): CliArgs {
  let mode: "dry-run" | "write" | null = null;
  let sourceDatabaseFile: string | null = null;
  let targetDatabaseFile: string | null = null;
  let blobRootPath: string | null = null;
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
    if (arg === "--v2" || arg === "--source" || arg === "--input") {
      sourceDatabaseFile = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (arg === "--v3" || arg === "--target") {
      targetDatabaseFile = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (arg === "--blob-root" || arg === "--blobs") {
      blobRootPath = argv[index + 1] ?? null;
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
    sourceDatabaseFile,
    targetDatabaseFile,
    blobRootPath,
    overwrite,
  };
}

function printUsageAndExit(): never {
  console.error(
    "Usage: npx tsx scripts/migrate-database-v2-to-v3.ts --dry-run --v2 <path-to-withmate-v2.db>\n"
      + "       npx tsx scripts/migrate-database-v2-to-v3.ts --write --v2 <path-to-withmate-v2.db> --v3 <path-to-withmate-v3.db> --blob-root <path-to-blobs> [--overwrite]",
  );
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { mode, sourceDatabaseFile, targetDatabaseFile, blobRootPath, overwrite } = parseCliArgs(process.argv.slice(2));

  if (mode === "dry-run") {
    if (!sourceDatabaseFile) {
      printUsageAndExit();
    }
    const report = createMigrationDryRunReport(sourceDatabaseFile);
    console.log(JSON.stringify(report, null, 2));
  } else if (mode === "write") {
    if (!sourceDatabaseFile || !targetDatabaseFile || !blobRootPath) {
      printUsageAndExit();
    }
    const report = await createMigrationWriteReport({
      sourceDatabaseFile,
      targetDatabaseFile,
      blobRootPath,
      overwrite,
    });
    console.log(JSON.stringify(report, null, 2));
  } else {
    printUsageAndExit();
  }
}
