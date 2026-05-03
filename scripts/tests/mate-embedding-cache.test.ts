import assert from "node:assert/strict";
import { access, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { MateEmbeddingCacheService } from "../../src-electron/mate-embedding-cache.js";
import { MateStorage } from "../../src-electron/mate-storage.js";

function createTempPaths(): Promise<{
  dbPath: string;
  userDataPath: string;
  cleanup: () => Promise<void>;
}> {
  return mkdtemp(path.join(os.tmpdir(), "withmate-mate-embedding-cache-")).then((tmpDir) => ({
    dbPath: path.join(tmpDir, "withmate-v4.db"),
    userDataPath: path.join(tmpDir, "user-data"),
    cleanup: async () => {
      await rm(tmpDir, { recursive: true, force: true });
    },
  }));
}

describe("MateEmbeddingCacheService", () => {
  it("未作成時は getEmbeddingSettings が null を返す", async () => {
    const { dbPath, userDataPath, cleanup } = await createTempPaths();
    let service: MateEmbeddingCacheService | null = null;

    try {
      service = new MateEmbeddingCacheService(dbPath, userDataPath);
      assert.equal(service.getEmbeddingSettings(), null);
    } finally {
      service?.close();
      await cleanup();
    }
  });

  it("getEmbeddingSettings が current の settings を camelCase で返す", async () => {
    const { dbPath, userDataPath, cleanup } = await createTempPaths();
    let mateStorage: MateStorage | null = null;
    let service: MateEmbeddingCacheService | null = null;

    try {
      mateStorage = new MateStorage(dbPath, userDataPath);
      await mateStorage.createMate({ displayName: "Mika" });
      service = new MateEmbeddingCacheService(dbPath, userDataPath);

      const settings = service.getEmbeddingSettings();
      assert.notEqual(settings, null);
      assert.equal(settings?.mateId, "current");
      assert.equal(settings?.cachePolicy, "download_once_local_cache");
      assert.equal(settings?.cacheState, "missing");
      assert.equal(settings?.cacheDirPath, "");
      assert.equal(settings?.backendType, "local_transformers_js");
      assert.equal(settings?.modelId, "Xenova/multilingual-e5-small");
      assert.equal(settings?.sourceModelId, "intfloat/multilingual-e5-small");
      assert.equal(settings?.dimension, 384);
    } finally {
      mateStorage?.close();
      service?.close();
      await cleanup();
    }
  });

  it("getCacheDirectoryPath が user data 配下の決定論的パスを返す", async () => {
    const { dbPath, userDataPath, cleanup } = await createTempPaths();
    let mateStorage: MateStorage | null = null;
    let service: MateEmbeddingCacheService | null = null;

    try {
      mateStorage = new MateStorage(dbPath, userDataPath);
      await mateStorage.createMate({ displayName: "Mika" });
      service = new MateEmbeddingCacheService(dbPath, userDataPath);

      assert.equal(service.getCacheDirectoryPath(), path.join(userDataPath, "embedding-cache", "Xenova", "multilingual-e5-small"));
    } finally {
      mateStorage?.close();
      service?.close();
      await cleanup();
    }
  });

  it("markDownloadStarted でダウンロード状態に更新し、cache ディレクトリを作る", async () => {
    const { dbPath, userDataPath, cleanup } = await createTempPaths();
    let mateStorage: MateStorage | null = null;
    let service: MateEmbeddingCacheService | null = null;

    try {
      mateStorage = new MateStorage(dbPath, userDataPath);
      await mateStorage.createMate({ displayName: "Mika" });
      service = new MateEmbeddingCacheService(dbPath, userDataPath);

      const cacheDirPath = service.getCacheDirectoryPath();
      service.markDownloadStarted();
      await access(cacheDirPath, constants.F_OK);

      const db = new DatabaseSync(dbPath);
      try {
        const row = db
          .prepare("SELECT cache_state, last_status, cache_dir_path FROM mate_embedding_settings WHERE mate_id = 'current'")
          .get() as { cache_state: string; last_status: string; cache_dir_path: string };
        assert.equal(row.cache_state, "downloading");
        assert.equal(row.last_status, "unknown");
        assert.equal(row.cache_dir_path, cacheDirPath);
      } finally {
        db.close();
      }
    } finally {
      mateStorage?.close();
      service?.close();
      await cleanup();
    }
  });

  it("markDownloadReady で manifest 情報と検証日時を ready へ反映する", async () => {
    const { dbPath, userDataPath, cleanup } = await createTempPaths();
    let mateStorage: MateStorage | null = null;
    let service: MateEmbeddingCacheService | null = null;

    try {
      mateStorage = new MateStorage(dbPath, userDataPath);
      await mateStorage.createMate({ displayName: "Mika" });
      service = new MateEmbeddingCacheService(dbPath, userDataPath);

      service.markDownloadReady({
        cacheManifestSha256: "abcdef",
        cacheSizeBytes: 1234,
        modelRevision: "rev-1",
      });

      const settings = service.getEmbeddingSettings();
      assert.equal(settings?.cacheState, "ready");
      assert.equal(settings?.lastStatus, "available");
      assert.equal(settings?.cacheManifestSha256, "abcdef");
      assert.equal(settings?.cacheSizeBytes, 1234);
      assert.equal(settings?.modelRevision, "rev-1");
      assert.equal(settings?.cacheDirPath, service.getCacheDirectoryPath());
      assert.ok(Boolean(settings?.cacheUpdatedAt));
      assert.ok(Boolean(settings?.lastVerifiedAt));
    } finally {
      mateStorage?.close();
      service?.close();
      await cleanup();
    }
  });

  it("markDownloadFailed がエラープレビューを短くして保存し、再DL向けメソッドで戻せる", async () => {
    const { dbPath, userDataPath, cleanup } = await createTempPaths();
    let mateStorage: MateStorage | null = null;
    let service: MateEmbeddingCacheService | null = null;

    try {
      mateStorage = new MateStorage(dbPath, userDataPath);
      await mateStorage.createMate({ displayName: "Mika" });
      service = new MateEmbeddingCacheService(dbPath, userDataPath);

      service.markDownloadStarted();
      service.markDownloadFailed("x".repeat(2000));
      const failed = service.getEmbeddingSettings();
      assert.equal(failed?.cacheState, "failed");
      assert.equal(failed?.lastStatus, "failed");
      assert.equal(failed?.lastErrorPreview.length <= 512, true);

      service.markCacheMissing();
      const missing = service.getEmbeddingSettings();
      assert.equal(missing?.cacheState, "missing");
      assert.equal(missing?.lastStatus, "unknown");
    } finally {
      mateStorage?.close();
      service?.close();
      await cleanup();
    }
  });
});
