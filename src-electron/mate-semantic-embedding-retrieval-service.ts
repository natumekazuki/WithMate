import type {
  ListMateSemanticEmbeddingsForModelRequest,
  MateSemanticEmbedding,
  MateSemanticEmbeddingOwnerType,
} from "./mate-semantic-embedding-storage.js";
import { rankByCosineSimilarity } from "./vector-similarity.js";

export type MateSemanticEmbeddingRetrievalRequest = {
  queryText: string;
  ownerType?: MateSemanticEmbeddingOwnerType;
  minScore?: number;
  limit?: number;
  candidateLimit?: number;
};

export type RetrievedMateSemanticEmbedding = {
  embedding: MateSemanticEmbedding;
  score: number;
};

type EmbeddingCacheService = {
  getEmbeddingSettings: () => {
    enabled: boolean;
    backendType: string;
    modelId: string;
    dimension: number;
    cacheState: "missing" | "downloading" | "ready" | "failed" | "stale";
    lastStatus: "unknown" | "available" | "unavailable" | "failed";
  } | null;
};

type EmbeddingVectorizer = {
  vectorizeText: (text: string) => Promise<number[]>;
};

type EmbeddingStorage = {
  listEmbeddingsForModel: (request: ListMateSemanticEmbeddingsForModelRequest) => MateSemanticEmbedding[];
};

const DEFAULT_CANDIDATE_LIMIT = 500;

function normalizePositiveInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || !Number.isFinite(value) || value < 1) {
    throw new Error(`${field} は1以上の整数のみ許可されています`);
  }
  return value;
}

function normalizeMinScore(minScore: number): number {
  if (!Number.isFinite(minScore)) {
    throw new Error("minScore は有限数のみ許可されています");
  }
  return minScore;
}

export class MateSemanticEmbeddingRetrievalService {
  private readonly cacheService: EmbeddingCacheService;
  private readonly vectorizer: EmbeddingVectorizer;
  private readonly embeddingStorage: EmbeddingStorage;

  constructor(cacheService: EmbeddingCacheService, vectorizer: EmbeddingVectorizer, embeddingStorage: EmbeddingStorage) {
    this.cacheService = cacheService;
    this.vectorizer = vectorizer;
    this.embeddingStorage = embeddingStorage;
  }

  async retrieve(
    request: MateSemanticEmbeddingRetrievalRequest,
  ): Promise<Array<{ embedding: MateSemanticEmbedding; score: number }>> {
    const trimmedQueryText = request.queryText.trim();
    if (!trimmedQueryText) {
      throw new Error("queryText が空です");
    }

    const settings = this.cacheService.getEmbeddingSettings();
    if (
      !settings
      || !settings.enabled
      || settings.cacheState !== "ready"
      || settings.lastStatus !== "available"
    ) {
      throw new Error("embedding cache が有効化されていないまたは利用可能ではない");
    }

    if (request.limit !== undefined) {
      normalizePositiveInteger(request.limit, "limit");
    }

    if (request.candidateLimit !== undefined) {
      normalizePositiveInteger(request.candidateLimit, "candidateLimit");
    }

    if (request.minScore !== undefined) {
      normalizeMinScore(request.minScore);
    }

    const queryVector = await this.vectorizer.vectorizeText(trimmedQueryText);

    const candidates = this.embeddingStorage.listEmbeddingsForModel({
      embeddingBackendType: settings.backendType,
      embeddingModelId: settings.modelId,
      ownerType: request.ownerType,
      dimension: settings.dimension,
      limit: request.candidateLimit ?? DEFAULT_CANDIDATE_LIMIT,
    });

    const ranked = rankByCosineSimilarity(queryVector, candidates, (candidate) => candidate.vector, {
      minScore: request.minScore,
      limit: request.limit,
    });

    return ranked.map((entry) => ({
      embedding: entry.item,
      score: entry.score,
    }));
  }
}
