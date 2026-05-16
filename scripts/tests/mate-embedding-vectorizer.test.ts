import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { MateEmbeddingCacheService } from "../../src-electron/mate-embedding-cache.js";
import { EmbedTextWithLocalModel, MateEmbeddingVectorizer } from "../../src-electron/mate-embedding-vectorizer.js";
import { MateStorage } from "../../src-electron/mate-storage.js";

function createTempPaths(): Promise<{ dbPath: string; userDataPath: string; cleanup: () => Promise<void> }> {
  return mkdtemp(path.join(os.tmpdir(), "withmate-mate-embedding-vectorizer-")).then((tmpDir) => ({
    dbPath: path.join(tmpDir, "withmate-v4.db"),
    userDataPath: path.join(tmpDir, "user-data"),
    cleanup: async () => {
      await rm(tmpDir, { recursive: true, force: true });
    },
  }));
}

function seedReadyEmbeddingSettings(dbPath: string, dimensions: number, modelRevision: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare("UPDATE mate_embedding_settings SET dimension = ?, model_revision = ? WHERE mate_id = 'current'").run(
      dimensions,
      modelRevision,
    );
  } finally {
    db.close();
  }
}

describe("MateEmbeddingVectorizer", () => {
  it("cache が ready 以前は reject する", async () => {
    const { dbPath, userDataPath, cleanup } = await createTempPaths();
    let mateStorage: MateStorage | null = null;
    let cacheService: MateEmbeddingCacheService | null = null;
    let vectorizer: MateEmbeddingVectorizer | null = null;

    try {
      mateStorage = new MateStorage(dbPath, userDataPath);
      await mateStorage.createMate({ displayName: "Mika" });
      cacheService = new MateEmbeddingCacheService(dbPath, userDataPath);
      vectorizer = new MateEmbeddingVectorizer(cacheService);

      await assert.rejects(
        () => vectorizer!.vectorizeText("hello"),
        /embedding cache/,
      );
    } finally {
      mateStorage?.close();
      cacheService?.close();
      vectorizer = null;
      await cleanup();
    }
  });

  it("ready 時は設定を反映して embedText が呼ばれ vector を返す", async () => {
    const { dbPath, userDataPath, cleanup } = await createTempPaths();
    let mateStorage: MateStorage | null = null;
    let cacheService: MateEmbeddingCacheService | null = null;
    let vectorizer: MateEmbeddingVectorizer | null = null;

    try {
      mateStorage = new MateStorage(dbPath, userDataPath);
      await mateStorage.createMate({ displayName: "Mika" });
      cacheService = new MateEmbeddingCacheService(dbPath, userDataPath);
      seedReadyEmbeddingSettings(dbPath, 3, "rev-1");
      cacheService.markDownloadReady({
        cacheManifestSha256: "hash-ready",
        cacheSizeBytes: 1024,
        modelRevision: "rev-1",
      });

      const expectedVector = [0.1, 0.2, 0.3];
      let inputSnapshot: {
        text: string;
        modelId: string;
        cacheDirectory: string;
        expectedDimension: number;
        modelRevision: string;
      } | null = null;
      const fakeEmbedText: EmbedTextWithLocalModel = async (input) => {
        inputSnapshot = input;
        return expectedVector;
      };

      vectorizer = new MateEmbeddingVectorizer(cacheService, fakeEmbedText);
      const vector = await vectorizer.vectorizeText("  hello world  ");
      const cacheDirectory = cacheService.getCacheDirectoryPath();

      assert.deepEqual(vector, expectedVector);
      assert.equal(inputSnapshot?.text, "hello world");
      assert.equal(inputSnapshot?.modelId, "Xenova/multilingual-e5-small");
      assert.equal(inputSnapshot?.cacheDirectory, cacheDirectory);
      assert.equal(inputSnapshot?.expectedDimension, 3);
      assert.equal(inputSnapshot?.modelRevision, "rev-1");
    } finally {
      mateStorage?.close();
      cacheService?.close();
      vectorizer = null;
      await cleanup();
    }
  });

  it("modelRevision が空なら default の main を渡す", async () => {
    const { dbPath, userDataPath, cleanup } = await createTempPaths();
    let mateStorage: MateStorage | null = null;
    let cacheService: MateEmbeddingCacheService | null = null;
    let vectorizer: MateEmbeddingVectorizer | null = null;

    try {
      mateStorage = new MateStorage(dbPath, userDataPath);
      await mateStorage.createMate({ displayName: "Mika" });
      cacheService = new MateEmbeddingCacheService(dbPath, userDataPath);
      seedReadyEmbeddingSettings(dbPath, 2, "");
      cacheService.markDownloadReady({
        cacheManifestSha256: "hash-ready-empty-revision",
        cacheSizeBytes: 1024,
        modelRevision: "",
      });

      let passedModelRevision = "not-called";
      const fakeEmbedText: EmbedTextWithLocalModel = async (input) => {
        passedModelRevision = input.modelRevision;
        return [0.4, 0.5];
      };

      vectorizer = new MateEmbeddingVectorizer(cacheService, fakeEmbedText);
      await vectorizer.vectorizeText("revision test");

      assert.equal(passedModelRevision, "main");
    } finally {
      mateStorage?.close();
      cacheService?.close();
      vectorizer = null;
      await cleanup();
    }
  });

  it("text が空なら reject する", async () => {
    const { dbPath, userDataPath, cleanup } = await createTempPaths();
    let cacheService: MateEmbeddingCacheService | null = null;
    let vectorizer: MateEmbeddingVectorizer | null = null;

    try {
      cacheService = new MateEmbeddingCacheService(dbPath, userDataPath);
      vectorizer = new MateEmbeddingVectorizer(cacheService, async () => [1]);

      await assert.rejects(
        () => vectorizer!.vectorizeText("   "),
        /text が空/,
      );
    } finally {
      cacheService?.close();
      vectorizer = null;
      await cleanup();
    }
  });

  it("embedText の結果 dimension mismatch は reject する", async () => {
    const { dbPath, userDataPath, cleanup } = await createTempPaths();
    let mateStorage: MateStorage | null = null;
    let cacheService: MateEmbeddingCacheService | null = null;
    let vectorizer: MateEmbeddingVectorizer | null = null;

    try {
      mateStorage = new MateStorage(dbPath, userDataPath);
      await mateStorage.createMate({ displayName: "Mika" });
      cacheService = new MateEmbeddingCacheService(dbPath, userDataPath);
      seedReadyEmbeddingSettings(dbPath, 4, "rev-1");
      cacheService.markDownloadReady({
        cacheManifestSha256: "hash-ready-mismatch",
        cacheSizeBytes: 1024,
        modelRevision: "rev-1",
      });

      const fakeEmbedText: EmbedTextWithLocalModel = async () => [1, 2, 3];
      vectorizer = new MateEmbeddingVectorizer(cacheService, fakeEmbedText);

      await assert.rejects(
        () => vectorizer!.vectorizeText("mismatch"),
        /次元/,
      );
    } finally {
      mateStorage?.close();
      cacheService?.close();
      vectorizer = null;
      await cleanup();
    }
  });

  it("embedText の結果が NaN を含む場合は reject する", async () => {
    const { dbPath, userDataPath, cleanup } = await createTempPaths();
    let mateStorage: MateStorage | null = null;
    let cacheService: MateEmbeddingCacheService | null = null;
    let vectorizer: MateEmbeddingVectorizer | null = null;

    try {
      mateStorage = new MateStorage(dbPath, userDataPath);
      await mateStorage.createMate({ displayName: "Mika" });
      cacheService = new MateEmbeddingCacheService(dbPath, userDataPath);
      seedReadyEmbeddingSettings(dbPath, 2, "rev-1");
      cacheService.markDownloadReady({
        cacheManifestSha256: "hash-ready-nan",
        cacheSizeBytes: 1024,
        modelRevision: "rev-1",
      });

      const fakeEmbedText: EmbedTextWithLocalModel = async () => [1, Number.NaN];
      vectorizer = new MateEmbeddingVectorizer(cacheService, fakeEmbedText);

      await assert.rejects(
        () => vectorizer!.vectorizeText("nan"),
        /非数値/,
      );
    } finally {
      mateStorage?.close();
      cacheService?.close();
      vectorizer = null;
      await cleanup();
    }
  });
});
