import type { MateGrowthEvent } from "./mate-growth-storage.js";
import type { MateProfileItem } from "./mate-profile-item-storage.js";
import type { MateSemanticEmbedding } from "./mate-semantic-embedding-storage.js";

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

type SemanticEmbeddingStorage = {
  upsertEmbedding: (input: {
    ownerType: "growth_event" | "profile_item";
    ownerId: string;
    text: string;
    embeddingBackendType: string;
    embeddingModelId: string;
    vector: number[];
  }) => MateSemanticEmbedding;
};

function normalizeText(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("text が空です");
  }
  return trimmed;
}

function joinProfileItemText(item: MateProfileItem): string {
  const values = new Set<string>();
  const pushed: string[] = [];

  const add = (value: string): void => {
    const normalized = value.trim();
    if (!normalized) {
      return;
    }
    if (values.has(normalized)) {
      return;
    }
    values.add(normalized);
    pushed.push(normalized);
  };

  add(item.renderedText);
  add(item.claimKey);
  add(item.claimValue);

  for (const tag of item.tags) {
    add(`${tag.type}:${tag.value}`);
  }

  return pushed.join("\n");
}

export class MateSemanticEmbeddingIndexService {
  private readonly cacheService: EmbeddingCacheService;
  private readonly vectorizer: EmbeddingVectorizer;
  private readonly embeddingStorage: SemanticEmbeddingStorage;

  constructor(
    cacheService: EmbeddingCacheService,
    vectorizer: EmbeddingVectorizer,
    embeddingStorage: SemanticEmbeddingStorage,
  ) {
    this.cacheService = cacheService;
    this.vectorizer = vectorizer;
    this.embeddingStorage = embeddingStorage;
  }

  private getSettingsOrThrow(): { backendType: string; modelId: string; dimension: number } {
    const settings = this.cacheService.getEmbeddingSettings();
    if (
      !settings
      || !settings.enabled
      || settings.cacheState !== "ready"
      || settings.lastStatus !== "available"
    ) {
      throw new Error("embedding cache が有効化されていないまたは利用可能ではない");
    }

    return {
      backendType: settings.backendType,
      modelId: settings.modelId,
      dimension: settings.dimension,
    };
  }

  async indexGrowthEvent(event: MateGrowthEvent): Promise<MateSemanticEmbedding> {
    const text = normalizeText(event.statement);
    const settings = this.getSettingsOrThrow();
    const vector = await this.vectorizer.vectorizeText(text);

    return this.embeddingStorage.upsertEmbedding({
      ownerType: "growth_event",
      ownerId: event.id,
      text,
      embeddingBackendType: settings.backendType,
      embeddingModelId: settings.modelId,
      vector,
    });
  }

  async indexProfileItem(item: MateProfileItem): Promise<MateSemanticEmbedding> {
    const text = normalizeText(joinProfileItemText(item));
    const settings = this.getSettingsOrThrow();
    const vector = await this.vectorizer.vectorizeText(text);

    return this.embeddingStorage.upsertEmbedding({
      ownerType: "profile_item",
      ownerId: item.id,
      text,
      embeddingBackendType: settings.backendType,
      embeddingModelId: settings.modelId,
      vector,
    });
  }
}
