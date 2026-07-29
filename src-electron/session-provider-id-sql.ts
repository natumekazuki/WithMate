import type { DatabaseSync } from "node:sqlite";
import { normalizeProviderId } from "../src/model-catalog.js";

export const SESSION_PROVIDER_ID_NORMALIZER_SQL_FUNCTION = "withmate_normalize_provider_id";

export function registerSessionProviderIdNormalizer(db: DatabaseSync): void {
  db.function(
    SESSION_PROVIDER_ID_NORMALIZER_SQL_FUNCTION,
    { deterministic: true, directOnly: true },
    (value) => normalizeProviderId(value),
  );
}
