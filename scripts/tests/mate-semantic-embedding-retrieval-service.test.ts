import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { MateSemanticEmbedding } from "../../src-electron/mate-semantic-embedding-storage.js";
import { MateSemanticEmbeddingRetrievalService } from "../../src-electron/mate-semantic-embedding-retrieval-service.js";

const READY_SETTINGS = {
  enabled: true,
  backendType: "local_transformers_js",
  modelId: "Xenova/multilingual-e5-small",
  dimension: 2,
  cacheState: "ready" as const,
  lastStatus: "available" as const,
};

function buildEmbeddings(embeddingModelId: string): MateSemanticEmbedding[] {
  return [
    {
      id: 1,
      ownerType: "growth_event",
      ownerId: "growth-1",
      textHash: "hash-1",
      embeddingBackendType: "local_transformers_js",
      embeddingModelId,
      dimension: 2,
      vector: [1, 0],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    {
      id: 2,
      ownerType: "profile_item",
      ownerId: "profile-1",
      textHash: "hash-2",
      embeddingBackendType: "local_transformers_js",
      embeddingModelId,
      dimension: 2,
      vector: [0.6, 0.8],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    {
      id: 3,
      ownerType: "tag_catalog",
      ownerId: "tag-1",
      textHash: "hash-3",
      embeddingBackendType: "local_transformers_js",
      embeddingModelId,
      dimension: 2,
      vector: [1, 0],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    {
      id: 4,
      ownerType: "growth_event",
      ownerId: "growth-2",
      textHash: "hash-4",
      embeddingBackendType: "local_transformers_js",
      embeddingModelId,
      dimension: 2,
      vector: [-1, 0],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ];
}

describe("MateSemanticEmbeddingRetrievalService", () => {
  it("settings が未設定 / 無効 / 利用不可なら reject する", async () => {
    const requests = [{}, { enabled: false }, { cacheState: "missing" as const }, { lastStatus: "unavailable" as const }] as Array<
      Partial<typeof READY_SETTINGS>
    >;

    for (const request of requests) {
      const cacheService = {
        getEmbeddingSettings: () => request.enabled === undefined ? null : ({
          ...READY_SETTINGS,
          ...request,
        }),
      };
      const vectorizer = {
        vectorizeText: async () => [1, 0],
      };
      const embeddingStorage = {
        listEmbeddingsForModel: () => [],
      };
      const service = new MateSemanticEmbeddingRetrievalService(cacheService, vectorizer, embeddingStorage);

      await assert.rejects(
        () => service.retrieve({
          queryText: "query",
        }),
        /embedding cache/,
      );
    }
  });

  it("queryText が空なら reject", async () => {
    let vectorized = false;
    const cacheService = { getEmbeddingSettings: () => READY_SETTINGS };
    const vectorizer = {
      vectorizeText: async () => {
        vectorized = true;
        return [1, 0];
      },
    };
    const embeddingStorage = {
      listEmbeddingsForModel: () => [],
    };

    const service = new MateSemanticEmbeddingRetrievalService(cacheService, vectorizer, embeddingStorage);

    await assert.rejects(
      () => service.retrieve({ queryText: "   " }),
      /queryText/,
    );
    assert.equal(vectorized, false);
  });

  it("listEmbeddingsForModel に backend/model/dimension/ownerType/candidateLimit が渡る", async () => {
    let requestSnapshot: Record<string, unknown> | null = null;
    const cacheService = { getEmbeddingSettings: () => READY_SETTINGS };
    const vectorizer = {
      vectorizeText: async () => [0.5, 0.2],
    };
    const embeddingStorage = {
      listEmbeddingsForModel: (request: Record<string, unknown>) => {
        requestSnapshot = request;
        return [];
      },
    };
    const service = new MateSemanticEmbeddingRetrievalService(cacheService, vectorizer, embeddingStorage);

    const result = await service.retrieve({
      queryText: "  hello ",
      ownerType: "profile_item",
      candidateLimit: 123,
    });

    assert.equal(result.length, 0);
    assert.equal(requestSnapshot?.embeddingBackendType, READY_SETTINGS.backendType);
    assert.equal(requestSnapshot?.embeddingModelId, READY_SETTINGS.modelId);
    assert.equal(requestSnapshot?.dimension, READY_SETTINGS.dimension);
    assert.equal(requestSnapshot?.ownerType, "profile_item");
    assert.equal(requestSnapshot?.limit, 123);
  });

  it("candidateLimit 未指定時は 500 が渡る", async () => {
    let requestSnapshot: Record<string, unknown> | null = null;
    const cacheService = { getEmbeddingSettings: () => READY_SETTINGS };
    const vectorizer = {
      vectorizeText: async () => [0.5, 0.2],
    };
    const embeddingStorage = {
      listEmbeddingsForModel: (request: Record<string, unknown>) => {
        requestSnapshot = request;
        return [];
      },
    };
    const service = new MateSemanticEmbeddingRetrievalService(cacheService, vectorizer, embeddingStorage);

    await service.retrieve({
      queryText: "hello",
    });

    assert.equal(requestSnapshot?.limit, 500);
  });

  it("score 降順で並び、minScore と limit が反映される", async () => {
    const cacheService = { getEmbeddingSettings: () => READY_SETTINGS };
    const vectorizer = {
      vectorizeText: async () => [1, 0],
    };
    const embeddingStorage = {
      listEmbeddingsForModel: () => buildEmbeddings(READY_SETTINGS.modelId),
    };
    const service = new MateSemanticEmbeddingRetrievalService(cacheService, vectorizer, embeddingStorage);

    const result = await service.retrieve({
      queryText: "query",
      minScore: 0.1,
      limit: 2,
      candidateLimit: 10,
    });

    assert.deepEqual(result.map((entry) => entry.embedding.id), [1, 3]);
    assert.ok(result[0].score >= result[1].score);
  });

  it("limit / candidateLimit / minScore の不正値は reject する", async () => {
    const cacheService = { getEmbeddingSettings: () => READY_SETTINGS };
    const vectorizer = {
      vectorizeText: async () => [1, 0],
    };
    const embeddingStorage = {
      listEmbeddingsForModel: () => buildEmbeddings(READY_SETTINGS.modelId),
    };
    const service = new MateSemanticEmbeddingRetrievalService(cacheService, vectorizer, embeddingStorage);

    await assert.rejects(() => service.retrieve({
      queryText: "query",
      limit: 0,
    }), /limit/);
    await assert.rejects(() => service.retrieve({
      queryText: "query",
      limit: 1.5,
    }), /limit/);
    await assert.rejects(() => service.retrieve({
      queryText: "query",
      candidateLimit: 0,
    }), /candidateLimit/);
    await assert.rejects(() => service.retrieve({
      queryText: "query",
      candidateLimit: 1.5,
    }), /candidateLimit/);
    await assert.rejects(() => service.retrieve({
      queryText: "query",
      minScore: Number.NaN,
    }), /minScore/);
    await assert.rejects(() => service.retrieve({
      queryText: "query",
      minScore: Number.POSITIVE_INFINITY,
    }), /minScore/);
  });
});
