import type { DatabaseSync } from "node:sqlite";
import path from "node:path";

import type {
  ProviderInstructionFailPolicy,
  ProviderInstructionLastSyncState,
  ProviderInstructionSyncStatus,
  ProviderInstructionTarget,
  ProviderInstructionTargetInput,
  ProviderInstructionWriteMode,
} from "../src/provider-instruction-target-state.js";
import { CREATE_V4_SCHEMA_SQL } from "./database-schema-v4.js";
import { openAppDatabase } from "./sqlite-connection.js";

export type {
  ProviderInstructionFailPolicy,
  ProviderInstructionLastSyncState,
  ProviderInstructionSyncStatus,
  ProviderInstructionTarget,
  ProviderInstructionTargetInput,
  ProviderInstructionWriteMode,
} from "../src/provider-instruction-target-state.js";

const DEFAULT_TARGET_ID = "main";
const MAX_ERROR_PREVIEW_LENGTH = 512;
const PROVIDER_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,63})$/;

type ProviderInstructionTargetRow = {
  provider_id: string;
  target_id: string;
  enabled: number;
  root_directory: string;
  instruction_relative_path: string;
  write_mode: string;
  projection_scope: string;
  fail_policy: string;
  requires_restart: number;
  last_sync_state: string;
  last_sync_run_id: number | null;
  last_synced_revision_id: string | null;
  last_error_preview: string;
  last_synced_at: string | null;
};

export type ProviderInstructionTargetSyncRunInput = {
  providerId: string;
  targetId?: string;
  mateRevisionId?: string;
  writeMode: ProviderInstructionWriteMode;
  projectionScope: "mate_only";
  projectionSha256: string;
  status: ProviderInstructionSyncStatus;
  errorPreview?: string;
  requiresRestart?: boolean;
};

export type ProviderInstructionSyncRun = {
  id: number;
  providerId: string;
  targetId: string;
  mateRevisionId: string | null;
  writeMode: ProviderInstructionWriteMode;
  projectionScope: "mate_only";
  projectionSha256: string;
  status: ProviderInstructionSyncStatus;
  errorPreview: string;
  requiresRestart: boolean;
  startedAt: string;
  finishedAt: string;
};

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeText(value: unknown, field: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    throw new Error(`${field} が空です`);
  }
  return text;
}

function normalizeProviderId(value: unknown): string {
  const normalized = normalizeText(value, "providerId").toLowerCase();
  if (!PROVIDER_ID_PATTERN.test(normalized)) {
    throw new Error(`invalid providerId: ${normalized}`);
  }
  return normalized;
}

function normalizeTargetId(value: unknown): string {
  const normalized = normalizeText(value, "targetId").toLowerCase();
  if (!PROVIDER_ID_PATTERN.test(normalized)) {
    throw new Error(`invalid targetId: ${normalized}`);
  }
  return normalized;
}

function isWindowsAbsolutePath(value: string): boolean {
  return path.win32.isAbsolute(value);
}

function isWindowsDriveRelativePath(value: string): boolean {
  return /^[A-Za-z]:/.test(value) && !path.win32.isAbsolute(value);
}

function normalizeRootDirectory(value: unknown, enabled: boolean): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (enabled && !normalized) {
    throw new Error("enabled=true の target は rootDirectory を指定してください");
  }
  if (normalized && !path.isAbsolute(normalized)) {
    throw new Error("rootDirectory は絶対パスを指定してください");
  }
  return normalized ? path.resolve(normalized) : "";
}

function ensureInstructionWithinRoot(rootDirectory: string, instructionRelativePath: string): void {
  if (!rootDirectory) {
    return;
  }

  const rootDirectoryPath = path.resolve(rootDirectory);
  const resolvedInstructionPath = path.resolve(rootDirectoryPath, instructionRelativePath);
  const relativeInstructionPath = path.relative(rootDirectoryPath, resolvedInstructionPath);
  const topSegment = relativeInstructionPath.split(/[\\\/]/)[0] ?? "";

  if (!relativeInstructionPath || topSegment === "..") {
    throw new Error("instructionRelativePath は rootDirectory から外れるパスにできません");
  }
}

function normalizeOptionalBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${field} は true/false を指定してください`);
  }
  return value;
}

function normalizeWriteMode(value: unknown): ProviderInstructionWriteMode {
  if (value !== "managed_block" && value !== "managed_file") {
    throw new Error("writeMode は managed_block または managed_file で指定してください");
  }
  return value;
}

function normalizeFailPolicy(value: unknown): ProviderInstructionFailPolicy {
  if (value !== "block_session" && value !== "warn_continue") {
    throw new Error("failPolicy は block_session または warn_continue で指定してください");
  }
  return value;
}

function normalizeProjectionScope(value: unknown): "mate_only" {
  if (value !== "mate_only") {
    throw new Error("projectionScope は mate_only のみ対応しています");
  }
  return "mate_only";
}

function normalizeSyncStatus(value: unknown): ProviderInstructionSyncStatus {
  if (value !== "synced" && value !== "skipped" && value !== "failed") {
    throw new Error("status は synced / skipped / failed のいずれかで指定してください");
  }
  return value;
}

function normalizeInstructionRelativePath(value: unknown): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) {
    throw new Error("instructionRelativePath が空です");
  }
  if (path.isAbsolute(normalized) || isWindowsAbsolutePath(normalized) || isWindowsDriveRelativePath(normalized)) {
    throw new Error("instructionRelativePath は相対パスで指定してください");
  }

  const segments = normalized.split(/[\\\/]+/);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error("instructionRelativePath は . や .. を含められません");
  }

  return normalized;
}

function normalizeErrorPreview(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }

  const text = typeof value === "string" ? value : String(value);
  return text.length > MAX_ERROR_PREVIEW_LENGTH ? text.slice(0, MAX_ERROR_PREVIEW_LENGTH) : text;
}

function toBoolean(value: number): boolean {
  return value === 1;
}

function rowToTarget(row: ProviderInstructionTargetRow): ProviderInstructionTarget {
  return {
    providerId: row.provider_id,
    targetId: row.target_id,
    enabled: row.enabled === 1,
    rootDirectory: row.root_directory,
    instructionRelativePath: row.instruction_relative_path,
    writeMode: row.write_mode as ProviderInstructionWriteMode,
    projectionScope: row.projection_scope as "mate_only",
    failPolicy: row.fail_policy as ProviderInstructionFailPolicy,
    requiresRestart: toBoolean(row.requires_restart),
    lastSyncState: row.last_sync_state as ProviderInstructionLastSyncState,
    lastSyncRunId: row.last_sync_run_id ?? null,
    lastSyncedRevisionId: row.last_synced_revision_id ?? null,
    lastErrorPreview: row.last_error_preview,
    lastSyncedAt: row.last_synced_at,
  };
}

const TARGET_SELECT_SQL = `
  SELECT
    provider_id,
    target_id,
    enabled,
    root_directory,
    instruction_relative_path,
    write_mode,
    projection_scope,
    fail_policy,
    requires_restart,
    last_sync_state,
    last_sync_run_id,
    last_synced_revision_id,
    last_error_preview,
    last_synced_at
  FROM provider_instruction_targets
`;

export class ProviderInstructionTargetStorage {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = openAppDatabase(dbPath);
    for (const statement of CREATE_V4_SCHEMA_SQL) {
      this.db.exec(statement);
    }
  }

  private withTransaction<T>(runner: (db: DatabaseSync) => T): T {
    this.db.exec("BEGIN IMMEDIATE TRANSACTION;");
    try {
      const result = runner(this.db);
      this.db.exec("COMMIT;");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  upsertTarget(input: ProviderInstructionTargetInput): ProviderInstructionTarget {
    const providerId = normalizeProviderId(input.providerId);
    const targetId = input.targetId === undefined ? DEFAULT_TARGET_ID : normalizeTargetId(input.targetId);
    const enabled = normalizeOptionalBoolean(input.enabled, "enabled");
    const rootDirectory = normalizeRootDirectory(input.rootDirectory, enabled);
    const instructionRelativePath = normalizeInstructionRelativePath(input.instructionRelativePath);
    ensureInstructionWithinRoot(rootDirectory, instructionRelativePath);
    const writeMode = normalizeWriteMode(input.writeMode);
    const failPolicy = normalizeFailPolicy(input.failPolicy);
    const requiresRestart = input.requiresRestart === undefined ? false : normalizeOptionalBoolean(input.requiresRestart, "requiresRestart");
    const now = nowIso();

    this.db.prepare(`
      INSERT INTO provider_instruction_targets (
        provider_id,
        target_id,
        enabled,
        root_directory,
        instruction_relative_path,
        write_mode,
        projection_scope,
        fail_policy,
        requires_restart,
        last_sync_state,
        last_synced_revision_id,
        last_sync_run_id,
        last_error_preview,
        last_synced_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'never', NULL, NULL, '', NULL, ?)
      ON CONFLICT(provider_id, target_id) DO UPDATE SET
        enabled = excluded.enabled,
        root_directory = excluded.root_directory,
        instruction_relative_path = excluded.instruction_relative_path,
        write_mode = excluded.write_mode,
        projection_scope = excluded.projection_scope,
        fail_policy = excluded.fail_policy,
        requires_restart = excluded.requires_restart,
        updated_at = excluded.updated_at
    `).run(
      providerId,
      targetId,
      enabled ? 1 : 0,
      rootDirectory,
      instructionRelativePath,
      writeMode,
      "mate_only",
      failPolicy,
      requiresRestart ? 1 : 0,
      now,
    );

    const target = this.getTarget(providerId, targetId);
    if (!target) {
      throw new Error("target を保存して再読込できませんでした");
    }

    return target;
  }

  listTargets(options?: { enabledOnly?: boolean }): ProviderInstructionTarget[] {
    const enabledOnly = options?.enabledOnly === true;
    const rows = this.db.prepare(`
      ${TARGET_SELECT_SQL}
      ${enabledOnly ? "WHERE enabled = 1" : ""}
      ORDER BY provider_id, target_id
    `).all() as ProviderInstructionTargetRow[];

    return rows.map(rowToTarget);
  }

  getTarget(providerId: string, targetId = DEFAULT_TARGET_ID): ProviderInstructionTarget | null {
    const normalizedProviderId = normalizeProviderId(providerId);
    const normalizedTargetId = normalizeTargetId(targetId);

    const row = this.db.prepare(`
      ${TARGET_SELECT_SQL}
      WHERE provider_id = ?
        AND target_id = ?
    `).get(normalizedProviderId, normalizedTargetId) as ProviderInstructionTargetRow | undefined;

    return row ? rowToTarget(row) : null;
  }

  markTargetStale(providerId: string, targetId = DEFAULT_TARGET_ID): void {
    const normalizedProviderId = normalizeProviderId(providerId);
    const normalizedTargetId = normalizeTargetId(targetId);
    const now = nowIso();

    this.db.prepare(`
      UPDATE provider_instruction_targets
      SET
        last_sync_state = 'stale',
        updated_at = ?
      WHERE provider_id = ?
        AND target_id = ?
    `).run(now, normalizedProviderId, normalizedTargetId);
  }

  markEnabledTargetsStale(): number {
    const candidates = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM provider_instruction_targets
      WHERE enabled = 1
        AND last_sync_state != 'redaction_required'
    `).get() as { count: number };

    if (candidates.count > 0) {
      const now = nowIso();
      this.db.prepare(`
        UPDATE provider_instruction_targets
        SET
          last_sync_state = 'stale',
          updated_at = ?
        WHERE enabled = 1
          AND last_sync_state != 'redaction_required'
      `).run(now);
    }

    return candidates.count;
  }

  recordSyncRun(input: ProviderInstructionTargetSyncRunInput): ProviderInstructionSyncRun {
    const providerId = normalizeProviderId(input.providerId);
    const targetId = input.targetId === undefined ? DEFAULT_TARGET_ID : normalizeTargetId(input.targetId);
    const writeMode = normalizeWriteMode(input.writeMode);
    const projectionScope = normalizeProjectionScope(input.projectionScope);
    const status = normalizeSyncStatus(input.status);
    const projectionSha256 = normalizeText(input.projectionSha256, "projectionSha256");
    const mateRevisionId = typeof input.mateRevisionId === "string" ? input.mateRevisionId.trim() || null : null;
    const errorPreview = normalizeErrorPreview(input.errorPreview);
    const requiresRestart = input.requiresRestart === undefined ? false : normalizeOptionalBoolean(input.requiresRestart, "requiresRestart");
    const now = nowIso();

    const target = this.getTarget(providerId, targetId);
    if (!target) {
      throw new Error("対象 target が見つかりません");
    }

    const runId = this.withTransaction(() => {
      const syncRunResult = this.db.prepare(`
        INSERT INTO provider_instruction_sync_runs (
          provider_id,
          target_id,
          mate_revision_id,
          write_mode,
          projection_scope,
          projection_sha256,
          status,
          error_preview,
          requires_restart,
          started_at,
          finished_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        providerId,
        targetId,
        mateRevisionId,
        writeMode,
        projectionScope,
        projectionSha256,
        status,
        errorPreview,
        requiresRestart ? 1 : 0,
        now,
        now,
      );

      const runId = Number(syncRunResult.lastInsertRowid);
      this.db.prepare(`
        UPDATE provider_instruction_targets
        SET
          last_sync_state = ?,
          last_sync_run_id = ?,
          last_synced_revision_id = ?,
          last_error_preview = ?,
          last_synced_at = ?,
          requires_restart = ?,
          updated_at = ?
        WHERE provider_id = ?
          AND target_id = ?
      `).run(
        status,
        runId,
        mateRevisionId,
        errorPreview,
        now,
        requiresRestart ? 1 : 0,
        now,
        providerId,
        targetId,
      );

      return runId;
    });

    return {
      id: runId,
      providerId,
      targetId,
      mateRevisionId,
      writeMode,
      projectionScope,
      projectionSha256,
      status,
      errorPreview,
      requiresRestart,
      startedAt: now,
      finishedAt: now,
    };
  }

  deleteTarget(providerId: string, targetId = DEFAULT_TARGET_ID): boolean {
    const normalizedProviderId = normalizeProviderId(providerId);
    const normalizedTargetId = normalizeTargetId(targetId);

    const result = this.db.prepare(`
      DELETE FROM provider_instruction_targets
      WHERE provider_id = ?
        AND target_id = ?
    `).run(normalizedProviderId, normalizedTargetId);

    return result.changes > 0;
  }

  close(): void {
    this.db.close();
  }
}
