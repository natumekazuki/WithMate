import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { MateGrowthEvent } from "../../src-electron/mate-growth-storage.js";
import type { MateProfileItem } from "../../src-electron/mate-profile-item-storage.js";
import { MateSemanticEmbeddingIndexService } from "../../src-electron/mate-semantic-embedding-index-service.js";

const READY_SETTINGS = {
  enabled: true,
  backendType: "local_transformers_js",
  modelId: "Xenova/multilingual-e5-small",
  dimension: 2,
  cacheState: "ready" as const,
  lastStatus: "available" as const,
};

function buildReadyCacheService(): { getEmbeddingSettings: () => typeof READY_SETTINGS } {
  return {
    getEmbeddingSettings: () => READY_SETTINGS,
  };
}

function buildGrowthEvent(overrides: Partial<MateGrowthEvent> = {}): MateGrowthEvent {
  return {
    id: "growth-event-1",
    mateId: "current",
    sourceGrowthRunId: null,
    sourceType: "manual",
    sourceSessionId: null,
    sourceAuditLogId: null,
    projectDigestId: null,
    growthSourceType: "assistant_inference",
    kind: "preference",
    targetSection: "core",
    statement: "ユーザーの行動が観測された",
    statementFingerprint: "",
    rationalePreview: "",
    retention: "auto",
    relation: "new",
    targetClaimKey: "example",
    confidence: 90,
    salienceScore: 70,
    recurrenceCount: 1,
    projectionAllowed: true,
    state: "candidate",
    appliedRevisionId: null,
    appliedAt: null,
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

function buildProfileItem(overrides: Partial<MateProfileItem> = {}): MateProfileItem {
  return {
    id: "profile-item-1",
    sectionKey: "core",
    projectDigestId: null,
    category: "preference",
    claimKey: "example",
    claimValue: "value-a",
    claimValueNormalized: "value-a",
    renderedText: "レンダリング済み",
    normalizedClaim: "",
    confidence: 90,
    salienceScore: 60,
    recurrenceCount: 1,
    projectionAllowed: true,
    state: "active",
    firstSeenAt: "",
    lastSeenAt: "",
    createdRevisionId: null,
    updatedRevisionId: null,
    disabledRevisionId: null,
    forgottenRevisionId: null,
    disabledAt: null,
    forgottenAt: null,
    createdAt: "",
    updatedAt: "",
    tags: [],
    ...overrides,
  };
}

describe("MateSemanticEmbeddingIndexService", () => {
  it("growth event は statement を trim して vectorizer/upsert に渡す", async () => {
    let vectorizedText: string | null = null;
    let upsertedText: string | null = null;
    const cacheService = buildReadyCacheService();
    const vectorizer = {
      vectorizeText: async (text: string) => {
        vectorizedText = text;
        return [0.1, 0.2];
      },
    };
    const embeddingStorage = {
      upsertEmbedding: (input: {
        ownerType: "growth_event" | "profile_item";
        ownerId: string;
        text: string;
        embeddingBackendType: string;
        embeddingModelId: string;
        vector: number[];
      }) => {
        upsertedText = input.text;
        return {
          id: 1,
          ownerType: input.ownerType,
          ownerId: input.ownerId,
          textHash: "hash",
          embeddingBackendType: input.embeddingBackendType,
          embeddingModelId: input.embeddingModelId,
          dimension: input.vector.length,
          vector: input.vector,
          createdAt: "",
          updatedAt: "",
        };
      },
    };
    const service = new MateSemanticEmbeddingIndexService(cacheService, vectorizer, embeddingStorage);
    const event = buildGrowthEvent({ statement: "   trimmed growth text  " });

    const result = await service.indexGrowthEvent(event);

    assert.equal(vectorizedText, "trimmed growth text");
    assert.equal(upsertedText, "trimmed growth text");
    assert.equal(result.ownerType, "growth_event");
    assert.equal(result.ownerId, event.id);
    assert.equal(result.embeddingBackendType, READY_SETTINGS.backendType);
    assert.equal(result.embeddingModelId, READY_SETTINGS.modelId);
  });

  it("profile item は renderedText/claimKey/claimValue/tag を改行結合して保存する", async () => {
    let upsertedText: string | null = null;
    const cacheService = buildReadyCacheService();
    const vectorizer = {
      vectorizeText: async () => [0.4, 0.5],
    };
    const embeddingStorage = {
      upsertEmbedding: (input: {
        ownerType: "growth_event" | "profile_item";
        ownerId: string;
        text: string;
        embeddingBackendType: string;
        embeddingModelId: string;
        vector: number[];
      }) => {
        upsertedText = input.text;
        return {
          id: 2,
          ownerType: input.ownerType,
          ownerId: input.ownerId,
          textHash: "hash",
          embeddingBackendType: input.embeddingBackendType,
          embeddingModelId: input.embeddingModelId,
          dimension: input.vector.length,
          vector: input.vector,
          createdAt: "",
          updatedAt: "",
        };
      },
    };
    const service = new MateSemanticEmbeddingIndexService(cacheService, vectorizer, embeddingStorage);
    const item = buildProfileItem({
      renderedText: "rendered text",
      claimKey: "claim-key",
      claimValue: "claim-value",
      tags: [
        { type: "style", value: "formal", valueNormalized: "formal" },
        { type: "style", value: "formal", valueNormalized: "formal" },
        { type: "topic", value: "ai", valueNormalized: "ai" },
      ],
    });

    await service.indexProfileItem(item);

    assert.equal(
      upsertedText,
      "rendered text\nclaim-key\nclaim-value\nstyle:formal\ntopic:ai",
    );
  });

  it("embedding settings が無効なら reject する", async () => {
    const requests = [
      null,
      { ...READY_SETTINGS, enabled: false },
      { ...READY_SETTINGS, cacheState: "missing" as const },
      { ...READY_SETTINGS, lastStatus: "failed" as const },
    ] as Array<typeof READY_SETTINGS | null>;

    for (const request of requests) {
      const cacheService = {
        getEmbeddingSettings: () => request,
      };
      const vectorizer = {
        vectorizeText: async () => [0.1, 0.2],
      };
      const embeddingStorage = {
        upsertEmbedding: () => {
          throw new Error("must not call");
        },
      };
      const service = new MateSemanticEmbeddingIndexService(cacheService, vectorizer, embeddingStorage);

      await assert.rejects(
        () => service.indexGrowthEvent(buildGrowthEvent({ statement: "text" })),
        /embedding cache/,
      );
    }
  });

  it("growth event の statement が空なら reject", async () => {
    const cacheService = buildReadyCacheService();
    const vectorizer = {
      vectorizeText: async () => [0.1, 0.2],
    };
    const embeddingStorage = {
      upsertEmbedding: () => {
        throw new Error("must not call");
      },
    };
    const service = new MateSemanticEmbeddingIndexService(cacheService, vectorizer, embeddingStorage);

    await assert.rejects(
      () => service.indexGrowthEvent(buildGrowthEvent({ statement: "   " })),
      /text が空/,
    );
  });

  it("profile item が claimKey/renderedText のみでも空なら reject できる", async () => {
    const cacheService = buildReadyCacheService();
    const vectorizer = {
      vectorizeText: async () => [0.1, 0.2],
    };
    const embeddingStorage = {
      upsertEmbedding: () => {
        throw new Error("must not call");
      },
    };
    const service = new MateSemanticEmbeddingIndexService(cacheService, vectorizer, embeddingStorage);

    await assert.rejects(
      () => service.indexProfileItem(buildProfileItem({
        claimKey: "  ",
        renderedText: " \t",
        claimValue: " \n",
        tags: [],
      })),
      /text が空/,
    );
  });
});
