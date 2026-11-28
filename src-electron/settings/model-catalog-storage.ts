import type { DatabaseSync } from "node:sqlite";
import type {
  ModelCatalogProvider,
  ModelCatalogSnapshot,
} from "../../src-shared/settings/model-catalog.js";
import { CREATE_V6_PROVIDER_MODEL_CACHE_TABLE_SQL } from "../storage/database-schema-v6.js";
import { openAppDatabase } from "../storage/sqlite-connection.js";

/** プロバイダーが返したモデル候補と、それが有効な接続条件・取得日時の記録。 */
export type CachedProviderModels = {
  provider: ModelCatalogProvider;
  contextKey: string;
  fetchedAt: string;
};

/** SDK 由来の候補一覧を、プロバイダー ID と接続条件ごとに SQLite へ保持する。 */
export class ModelCatalogStorage {
  private readonly db: DatabaseSync;

  /** モデル候補のキャッシュを読み書きする接続を開き、必要なテーブルを用意する。 */
  constructor(dbPath: string) {
    this.db = openAppDatabase(dbPath);
    this.db.exec(CREATE_V6_PROVIDER_MODEL_CACHE_TABLE_SQL);
  }

  /** 接続条件の異なる行をまとめず、すべてのキャッシュ行をプロバイダー ID と条件キーの順に返す。 */
  getCachedProviders(): CachedProviderModels[] {
    const rows = this.db
      .prepare(
        `
      SELECT provider_json, context_key, fetched_at FROM provider_model_cache ORDER BY provider_id, context_key
    `,
      )
      .all() as {
      provider_json: string;
      context_key: string;
      fetched_at: string;
    }[];
    return rows.map((row) => ({
      provider: JSON.parse(row.provider_json) as ModelCatalogProvider,
      contextKey: row.context_key,
      fetchedAt: row.fetched_at,
    }));
  }

  /** 接続条件キー順の末尾の候補を採用し、プロバイダー ID ごとに一件へまとめたスナップショットを返す。 */
  getCatalog(): ModelCatalogSnapshot {
    return {
      providers: Array.from(
        new Map(
          this.getCachedProviders().map((entry) => [
            entry.provider.id,
            entry.provider,
          ]),
        ).values(),
      ),
    };
  }

  /** 同じプロバイダーと接続条件の組だけを書き換え、保存後の一覧を返す。 */
  upsertProvider(entry: CachedProviderModels): ModelCatalogSnapshot {
    this.db
      .prepare(
        `
      INSERT INTO provider_model_cache (provider_id, provider_json, context_key, fetched_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(provider_id, context_key) DO UPDATE SET
        provider_json = excluded.provider_json, context_key = excluded.context_key, fetched_at = excluded.fetched_at
    `,
      )
      .run(
        entry.provider.id,
        JSON.stringify(entry.provider),
        entry.contextKey,
        entry.fetchedAt,
      );
    return this.getCatalog();
  }

  /** 個別指定時はそのプロバイダーの全接続条件を消去し、省略時はキャッシュ全体を消去する。 */
  clear(providerId?: string): void {
    if (providerId === undefined) {
      this.db.exec("DELETE FROM provider_model_cache");
    } else {
      this.db
        .prepare("DELETE FROM provider_model_cache WHERE provider_id = ?")
        .run(providerId);
    }
  }

  /** モデルキャッシュの SQLite 接続を閉じる。 */
  close(): void {
    this.db.close();
  }
}
