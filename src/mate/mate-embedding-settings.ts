export type MateEmbeddingCacheBackendType = "local_transformers_js";
export type MateEmbeddingCachePolicy = "download_once_local_cache";
export type MateEmbeddingCacheState = "missing" | "downloading" | "ready" | "failed" | "stale";
export type MateEmbeddingCacheLastStatus = "unknown" | "available" | "unavailable" | "failed";

export type MateEmbeddingSettings = {
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
