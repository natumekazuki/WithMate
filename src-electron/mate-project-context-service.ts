import type { MateProfileItem, MateProfileItemStorage } from "./mate-profile-item-storage.js";

const DEFAULT_PROJECT_CONTEXT_LIMIT = 20;
const PROJECT_CONTEXT_MARKDOWN_HEADER = "### Project Digest";

export class MateProjectContextService {
  constructor(private readonly profileItemStorage: MateProfileItemStorage) {}

  getProjectDigestContextText(
    projectDigestId: string,
    options: { limit?: number } = {},
  ): string | null {
    const limit =
      typeof options.limit === "number" && Number.isFinite(options.limit)
        ? Math.max(1, Math.floor(options.limit))
        : DEFAULT_PROJECT_CONTEXT_LIMIT;

    const items = this.profileItemStorage.listProfileItems({
      sectionKey: "project_digest",
      projectDigestId,
      state: "active",
      projectionAllowed: true,
      limit,
    });

    if (items.length === 0) {
      return null;
    }

    return [
      PROJECT_CONTEXT_MARKDOWN_HEADER,
      ...items.map((item) => this.formatItem(item)),
    ].join("\n");
  }

  private formatItem(item: MateProfileItem): string {
    return `- **${item.claimKey}:** ${item.renderedText}`;
  }
}
