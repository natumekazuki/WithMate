import { mkdirSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { CREATE_V4_SCHEMA_SQL } from "./database-schema-v4.js";
import { openAppDatabase } from "./sqlite-connection.js";

const MATE_ID = "current";
const EMBEDDING_CACHE_DIR_NAME = "embedding-cache";
const DEFAULT_MATE_EMBEDDING_MODEL_ID = "Xenova/multilingual-e5-small";
const ERROR_PREVIEW_MAX_LENGTH = 512;

export type MateEmbeddingCacheBackendType = "local_transformers_js";
export type MateEmbeddingCachePolicy = "download_once_local_cache";
export type MateEmbeddingCacheState = "missing" | "downloading" | "ready" | "failed" | "stale";
export type MateEmbeddingCacheLastStatus = "unknown" | "available" | "unavailable" | "failed";

export type MateEmbeddingCacheSettings = {
  mateId: "current";
  enabled: boolean;
  backendType: MateEmbeddingCacheBackendType;
  modelId: string;
  sourceModelId: string;
  dimension: number;
  cachePolicy: MateEmbeddingCachePolicy;
  cacheState: MateEmbeddingCacheState;
  cacheDirPath: string;
  cacheManifestSha256: string;
  modelRevision: string;
  cacheSizeBytes: number;
  cacheUpdatedAt: string | null;
  lastVerifiedAt: string | null;
  lastStatus: MateEmbeddingCacheLastStatus;
  lastErrorPreview: string;
  createdAt: string;
  updatedAt: string;
};

type MateEmbeddingSettingsRow = {
  mate_id: string;
  enabled: number;
  backend_type: MateEmbeddingCacheBackendType;
  model_id: string;
  source_model_id: string;
  dimension: number;
  cache_policy: MateEmbeddingCachePolicy;
  cache_state: MateEmbeddingCacheState;
  cache_dir_path: string;
  cache_manifest_sha256: string;
  model_revision: string;
  cache_size_bytes: number;
  cache_updated_at: string | null;
  last_verified_at: string | null;
  last_status: MateEmbeddingCacheLastStatus;
  last_error_preview: string;
  created_at: string;
  updated_at: string;
};

export type MarkDownloadReadyInput = {
  cacheManifestSha256: string;
  cacheSizeBytes: number;
  modelRevision: string;
};

function nowIso(): string {
  return new Date().toISOString();
}

function sanitizePathSegment(value: string): string {
  const normalized = value.trim().replace(/[^a-zA-Z0-9._-]/g, "_");
  return normalized.length > 0 ? normalized : "model";
}

function toSafeModelPath(modelId: string): string {
  return modelId
    .split("/")
    .filter(Boolean)
    .map(sanitizePathSegment)
    .join(path.sep);
}

function clampPreview(value: string): string {
  return value.trim().slice(0, ERROR_PREVIEW_MAX_LENGTH);
}

function rowToSettings(row: MateEmbeddingSettingsRow): MateEmbeddingCacheSettings {
  return {
    mateId: MATE_ID,
    enabled: row.enabled === 1,
    backendType: row.backend_type,
    modelId: row.model_id,
    sourceModelId: row.source_model_id,
    dimension: row.dimension,
    cachePolicy: row.cache_policy,
    cacheState: row.cache_state,
    cacheDirPath: row.cache_dir_path,
    cacheManifestSha256: row.cache_manifest_sha256,
    modelRevision: row.model_revision,
    cacheSizeBytes: row.cache_size_bytes,
    cacheUpdatedAt: row.cache_updated_at,
    lastVerifiedAt: row.last_verified_at,
    lastStatus: row.last_status,
    lastErrorPreview: row.last_error_preview,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function nonNegativeInteger(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.max(0, Math.floor(value));
}

function assertUpdated(changed: number | bigint, message: string): void {
  if (changed === 0 || changed === 0n) {
    throw new Error(message);
  }
}

export class MateEmbeddingCacheService {
  private readonly db: DatabaseSync;
  private readonly userDataPath: string;

  constructor(dbPath: string, userDataPath: string) {
    this.db = openAppDatabase(dbPath);
    this.userDataPath = userDataPath;

    for (const statement of CREATE_V4_SCHEMA_SQL) {
      this.db.exec(statement);
    }
  }

  getCacheDirectoryPath(): string {
    const settings = this.getEmbeddingSettings();
    const modelId = settings?.modelId ?? DEFAULT_MATE_EMBEDDING_MODEL_ID;
    return path.join(this.userDataPath, EMBEDDING_CACHE_DIR_NAME, toSafeModelPath(modelId));
  }

  getEmbeddingSettings(): MateEmbeddingCacheSettings | null {
    const row = this.db
      .prepare(`
        SELECT
          mate_id,
          enabled,
          backend_type,
          model_id,
          source_model_id,
          dimension,
          cache_policy,
          cache_state,
          cache_dir_path,
          cache_manifest_sha256,
          model_revision,
          cache_size_bytes,
          cache_updated_at,
          last_verified_at,
          last_status,
          last_error_preview,
          created_at,
          updated_at
        FROM mate_embedding_settings
        WHERE mate_id = ?
      `)
      .get(MATE_ID) as MateEmbeddingSettingsRow | undefined;

    if (!row) {
      return null;
    }

    return rowToSettings(row);
  }

  markDownloadStarted(): void {
    const now = nowIso();
    const cacheDirPath = this.getCacheDirectoryPath();
    mkdirSync(cacheDirPath, { recursive: true });

    const changed = this.db
      .prepare(`
        UPDATE mate_embedding_settings
        SET
          cache_state = 'downloading',
          last_status = 'unknown',
          cache_dir_path = ?,
          updated_at = ?
        WHERE mate_id = ?
      `)
      .run(cacheDirPath, now, MATE_ID).changes;

    assertUpdated(changed, "downloading 状態へ更新できる行が見つからないよ。");
  }

  markDownloadReady(input: MarkDownloadReadyInput): void {
    const now = nowIso();
    const cacheDirPath = this.getCacheDirectoryPath();
    mkdirSync(cacheDirPath, { recursive: true });

    const changed = this.db
      .prepare(`
        UPDATE mate_embedding_settings
        SET
          cache_state = 'ready',
          last_status = 'available',
          cache_dir_path = ?,
          cache_manifest_sha256 = ?,
          model_revision = ?,
          cache_size_bytes = ?,
          cache_updated_at = ?,
          last_verified_at = ?,
          updated_at = ?
        WHERE mate_id = ?
      `)
      .run(
        cacheDirPath,
        input.cacheManifestSha256,
        input.modelRevision,
        nonNegativeInteger(input.cacheSizeBytes),
        now,
        now,
        now,
        MATE_ID,
      ).changes;

    assertUpdated(changed, "ready 状態へ更新できる行が見つからないよ。");
  }

  markDownloadFailed(errorPreview: string): void {
    const now = nowIso();

    const changed = this.db
      .prepare(`
        UPDATE mate_embedding_settings
        SET
          cache_state = 'failed',
          last_status = 'failed',
          last_error_preview = ?,
          updated_at = ?
        WHERE mate_id = ?
      `)
      .run(clampPreview(errorPreview), now, MATE_ID).changes;

    assertUpdated(changed, "failed 状態へ更新できる行が見つからないよ。");
  }

  markCacheMissing(): void {
    const now = nowIso();
    const cacheDirPath = this.getCacheDirectoryPath();

    const changed = this.db
      .prepare(`
        UPDATE mate_embedding_settings
        SET
          cache_state = 'missing',
          last_status = 'unknown',
          cache_dir_path = ?,
          last_error_preview = '',
          updated_at = ?
        WHERE mate_id = ?
      `)
      .run(cacheDirPath, now, MATE_ID).changes;

    assertUpdated(changed, "missing 状態へ更新できる行が見つからないよ。");
  }

  markStale(): void {
    const now = nowIso();

    const changed = this.db
      .prepare(`
        UPDATE mate_embedding_settings
        SET
          cache_state = 'stale',
          last_status = 'unknown',
          last_error_preview = '',
          updated_at = ?
        WHERE mate_id = ?
      `)
      .run(now, MATE_ID).changes;

    assertUpdated(changed, "stale 状態へ更新できる行が見つからないよ。");
  }

  close(): void {
    this.db.close();
  }
}
