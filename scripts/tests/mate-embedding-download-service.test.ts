import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { MateEmbeddingCacheService } from "../../src-electron/mate-embedding-cache.js";
import { MateEmbeddingDownloadService } from "../../src-electron/mate-embedding-download-service.js";
import { MateStorage } from "../../src-electron/mate-storage.js";

function createTempPaths(): Promise<{
  dbPath: string;
  userDataPath: string;
  cleanup: () => Promise<void>;
}> {
  return mkdtemp(path.join(os.tmpdir(), "withmate-mate-embedding-download-")).then((tmpDir) => ({
    dbPath: path.join(tmpDir, "withmate-v4.db"),
    userDataPath: path.join(tmpDir, "user-data"),
    cleanup: async () => {
      await rm(tmpDir, { recursive: true, force: true });
    },
  }));
}

async function createServices(): Promise<{
  mateStorage: MateStorage;
  cacheService: MateEmbeddingCacheService;
  cleanup: () => Promise<void>;
}> {
  const { dbPath, userDataPath, cleanup } = await createTempPaths();
  const mateStorage = new MateStorage(dbPath, userDataPath);
  await mateStorage.createMate({ displayName: "Mika" });
  const cacheService = new MateEmbeddingCacheService(dbPath, userDataPath);
  return { mateStorage, cacheService, cleanup };
}

describe("MateEmbeddingDownloadService", () => {
  it("モデル取得後に cache を ready にする", async () => {
    const { mateStorage, cacheService, cleanup } = await createServices();

    try {
      const downloader = new MateEmbeddingDownloadService({
        cacheService,
        loadModel: async (input) => {
          assert.equal(input.modelId, "Xenova/multilingual-e5-small");
          assert.equal(input.expectedDimension, 384);
          assert.equal(input.modelRevision, "main");
          assert.match(input.cacheDirectory, /\.withmate-embedding-staged-/);

          await writeFile(path.join(input.cacheDirectory, "model.onnx"), "fake model");
          return {
            modelRevision: input.modelRevision,
          };
        },
      });

      await downloader.downloadModel();

      const settings = cacheService.getEmbeddingSettings();
      assert.equal(settings?.cacheState, "ready");
      assert.equal(settings?.lastStatus, "available");
      assert.equal(settings?.modelRevision, "main");
      assert.equal(settings?.cacheManifestSha256.length, 64);
      assert.equal(settings?.cacheSizeBytes, "fake model".length);
    } finally {
      mateStorage.close();
      cacheService.close();
      await cleanup();
    }
  });

  it("取得失敗時は failed にしてエラーを返す", async () => {
    const { mateStorage, cacheService, cleanup } = await createServices();

    try {
      const downloader = new MateEmbeddingDownloadService({
        cacheService,
        loadModel: async () => {
          throw new Error("embedding dimension が一致しません。expected=384, actual=383");
        },
      });

      await assert.rejects(
        () => downloader.downloadModel(),
        /embedding dimension が一致しません/,
      );

      const settings = cacheService.getEmbeddingSettings();
      assert.equal(settings?.cacheState, "failed");
      assert.equal(settings?.lastStatus, "failed");
      assert.match(settings?.lastErrorPreview ?? "", /embedding dimension が一致しません/);
    } finally {
      mateStorage.close();
      cacheService.close();
      await cleanup();
    }
  });

  it("ready 済みなら ensureDownloadedModelReady は再取得しない", async () => {
    const { mateStorage, cacheService, cleanup } = await createServices();
    let loadCount = 0;

    try {
      cacheService.markDownloadReady({
        cacheManifestSha256: "ready",
        cacheSizeBytes: 1,
        modelRevision: "main",
      });

      const downloader = new MateEmbeddingDownloadService({
        cacheService,
        loadModel: async () => {
          loadCount += 1;
          return {
            modelRevision: "main",
          };
        },
      });

      await downloader.ensureDownloadedModelReady();

      assert.equal(loadCount, 0);
      assert.equal(cacheService.getEmbeddingSettings()?.cacheState, "ready");
    } finally {
      mateStorage.close();
      cacheService.close();
      await cleanup();
    }
  });
});
