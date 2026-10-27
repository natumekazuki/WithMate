import type { DatabaseSync } from "node:sqlite";
import type { ModelCatalogProvider, ModelCatalogSnapshot } from "../../src-shared/settings/model-catalog.js";
import { CREATE_V6_PROVIDER_MODEL_CACHE_TABLE_SQL } from "../storage/database-schema-v6.js";
import { openAppDatabase } from "../storage/sqlite-connection.js";

export type CachedProviderModels = {
  provider: ModelCatalogProvider;
  contextKey: string;
  fetchedAt: string;
};

export class ModelCatalogStorage {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = openAppDatabase(dbPath);
    this.db.exec(CREATE_V6_PROVIDER_MODEL_CACHE_TABLE_SQL);
  }

  getCachedProviders(): CachedProviderModels[] {
    const rows = this.db.prepare(`
      SELECT provider_json, context_key, fetched_at FROM provider_model_cache ORDER BY provider_id, context_key
    `).all() as { provider_json: string; context_key: string; fetched_at: string }[];
    return rows.map((row) => ({
      provider: JSON.parse(row.provider_json) as ModelCatalogProvider,
      contextKey: row.context_key,
      fetchedAt: row.fetched_at,
    }));
  }

  getCatalog(): ModelCatalogSnapshot {
    return { providers: Array.from(new Map(this.getCachedProviders().map((entry) => [entry.provider.id, entry.provider])).values()) };
  }

  upsertProvider(entry: CachedProviderModels): ModelCatalogSnapshot {
    this.db.prepare(`
      INSERT INTO provider_model_cache (provider_id, provider_json, context_key, fetched_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(provider_id, context_key) DO UPDATE SET
        provider_json = excluded.provider_json, context_key = excluded.context_key, fetched_at = excluded.fetched_at
    `).run(entry.provider.id, JSON.stringify(entry.provider), entry.contextKey, entry.fetchedAt);
    return this.getCatalog();
  }

  clear(providerId?: string): void {
    if (providerId === undefined) {
      this.db.exec("DELETE FROM provider_model_cache");
    } else {
      this.db.prepare("DELETE FROM provider_model_cache WHERE provider_id = ?").run(providerId);
    }
  }

  close(): void {
    this.db.close();
  }
}
