import type { DatabaseSync } from "node:sqlite";
import { normalizeProviderId } from "../../src-shared/settings/model-catalog.js";

/** Session の保存クエリがプロバイダー ID を揃えるときに参照する SQLite 関数名。 */
export const SESSION_PROVIDER_ID_NORMALIZER_SQL_FUNCTION =
  "withmate_normalize_provider_id";

/** 指定接続に共通のプロバイダー ID 正規化を登録し、直接実行される SQL からだけ呼び出せるようにする。 */
export function registerSessionProviderIdNormalizer(db: DatabaseSync): void {
  db.function(
    SESSION_PROVIDER_ID_NORMALIZER_SQL_FUNCTION,
    { deterministic: true, directOnly: true },
    (value) => normalizeProviderId(value),
  );
}
