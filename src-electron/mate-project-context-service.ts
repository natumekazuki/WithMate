import type { MateProfileItem, MateProfileItemStorage } from "./mate-profile-item-storage.js";

const DEFAULT_PROJECT_CONTEXT_LIMIT = 20;
const PROJECT_CONTEXT_MARKDOWN_HEADER = "### Project Digest";
const DEFAULT_QUERY_TEXT_SCORE_WEIGHT = 2;
const DEFAULT_QUERY_TOKEN_SCORE_WEIGHT = 1;
const DEFAULT_QUERY_VECTOR_SCORE_WEIGHT = 2;
const DEFAULT_QUERY_SEMANTIC_LIMIT = 20;
const DEFAULT_QUERY_VECTOR_MIN_SCORE = 0.1;

type MateProjectContextSemanticRetrieval = {
  retrieve: (request: {
    queryText: string;
    ownerType: "profile_item";
    limit?: number;
    candidateLimit?: number;
    minScore?: number;
  }) => Promise<Array<{ embedding: { ownerId: string }; score: number }>>;
};

export class MateProjectContextService {
  constructor(
    private readonly profileItemStorage: MateProfileItemStorage,
    private readonly semanticRetrieval?: MateProjectContextSemanticRetrieval,
  ) {}

  async getProjectDigestContextText(
    projectDigestId: string,
    options: { limit?: number; queryText?: string } = {},
  ): Promise<string | null> {
    const limit =
      typeof options.limit === "number" && Number.isFinite(options.limit)
        ? Math.max(1, Math.floor(options.limit))
        : DEFAULT_PROJECT_CONTEXT_LIMIT;
    const queryText = this.normalizeQueryText(options.queryText);

    const items = this.profileItemStorage.listProfileItems({
      sectionKey: "project_digest",
      projectDigestId,
      state: "active",
      projectionAllowed: true,
      limit: queryText ? undefined : limit,
    });

    if (items.length === 0) {
      return null;
    }

    const selectedItems = (queryText
      ? await this.rankProfileItemsByQuery(items, queryText)
      : items
    ).slice(0, limit);

    return [
      PROJECT_CONTEXT_MARKDOWN_HEADER,
      ...selectedItems.map((item) => this.formatItem(item)),
    ].join("\n");
  }

  buildProjectDigestProjectionText(
    projectDigestId: string,
    options: { items?: readonly MateProfileItem[] } = {},
  ): string {
    const sourceItems = options.items ?? this.profileItemStorage.listProfileItems({
      sectionKey: "project_digest",
      state: "active",
      projectionAllowed: true,
      projectDigestId,
    });
    const items = sourceItems.filter((item) =>
      item.sectionKey === "project_digest" &&
      item.projectDigestId === projectDigestId &&
      item.state === "active" &&
      item.projectionAllowed
    );

    return [
      "### Project Digest",
      ...items
        .slice()
        .sort((left, right) => {
          const keyOrder = left.claimKey.localeCompare(right.claimKey);
          if (keyOrder !== 0) {
            return keyOrder;
          }
          return right.updatedAt.localeCompare(left.updatedAt);
        })
        .map((item) => this.formatItem(item)),
    ].join("\n");
  }

  private async rankProfileItemsByQuery(items: MateProfileItem[], queryText: string): Promise<MateProfileItem[]> {
    const tokens = this.normalizeQueryTokens(queryText);
    const lexicalRanks = items.map((item, index) => ({
      item,
      index,
      score: this.resolveQueryScore(item, queryText, tokens),
    }));

    const semanticScores = await this.getSemanticScores(queryText, lexicalRanks);
    const rankedItems = lexicalRanks.map((rankedItem) => ({
      ...rankedItem,
      score: rankedItem.score + (semanticScores.get(rankedItem.item.id) ?? 0) * DEFAULT_QUERY_VECTOR_SCORE_WEIGHT,
    }));

    return rankedItems
      .sort((left, right) => {
        if (left.score !== right.score) {
          return right.score - left.score;
        }
        if (left.item.salienceScore !== right.item.salienceScore) {
          return right.item.salienceScore - left.item.salienceScore;
        }
        if (left.item.updatedAt !== right.item.updatedAt) {
          return left.item.updatedAt < right.item.updatedAt ? 1 : -1;
        }
        return left.index - right.index;
      })
      .map(({ item }) => item);
  }

  private async getSemanticScores(
    queryText: string,
    rankedItems: Array<{ item: MateProfileItem; index: number; score: number }>,
  ): Promise<Map<string, number>> {
    const query = this.normalizeQueryText(queryText);
    if (!query || !this.semanticRetrieval) {
      return new Map();
    }

    try {
      const itemIds = new Set(rankedItems.map(({ item }) => item.id));
      const retrieved = await this.semanticRetrieval.retrieve({
        queryText,
        ownerType: "profile_item",
        limit: DEFAULT_QUERY_SEMANTIC_LIMIT,
        minScore: DEFAULT_QUERY_VECTOR_MIN_SCORE,
      });

      const scores = new Map<string, number>();
      for (const result of retrieved) {
        const ownerId = result.embedding.ownerId;
        if (!itemIds.has(ownerId)) {
          continue;
        }
        const current = scores.get(ownerId);
        if (current === undefined || result.score > current) {
          scores.set(ownerId, result.score);
        }
      }

      return scores;
    } catch (_error) {
      return new Map();
    }
  }

  private resolveQueryScore(item: MateProfileItem, queryText: string, tokens: string[]): number {
    let score = 0;

    const searchableValues = [
      item.claimKey,
      item.claimValue,
      item.renderedText,
      ...item.tags.map((tag) => tag.value),
    ].map((value) => this.normalizeSearchValue(value));

    const normalizedQuery = this.normalizeSearchValue(queryText);

    for (const searchableValue of searchableValues) {
      if (!searchableValue) {
        continue;
      }
      if (searchableValue.includes(normalizedQuery)) {
        score += DEFAULT_QUERY_TEXT_SCORE_WEIGHT;
      }

      for (const token of tokens) {
        if (token && searchableValue.includes(token)) {
          score += DEFAULT_QUERY_TOKEN_SCORE_WEIGHT;
        }
      }
    }

    return score;
  }

  private normalizeQueryText(queryText?: string | null): string {
    return (queryText ?? "").trim().toLowerCase();
  }

  private normalizeQueryTokens(queryText: string): string[] {
    return this.normalizeQueryText(queryText)
      .split(/[\s,、]+/)
      .map((token) => token.trim().toLowerCase())
      .filter((token) => Boolean(token));
  }

  private normalizeSearchValue(value: string): string {
    return value.trim().toLowerCase();
  }

  private formatItem(item: MateProfileItem): string {
    return `- **${item.claimKey}:** ${item.renderedText}`;
  }
}
