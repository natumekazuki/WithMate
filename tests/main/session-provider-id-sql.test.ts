import assert from "node:assert/strict";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, it } from "node:test";

import { normalizeProviderId } from "../../src-shared/settings/model-catalog.js";
import {
  registerSessionProviderIdNormalizer,
  SESSION_PROVIDER_ID_NORMALIZER_SQL_FUNCTION,
} from "../../src-electron/session/session-provider-id-sql.js";

/** SQLite の Session プロバイダー正規化と、集約側の共有ヘルパーで同じ判断になることを確認する。 */
describe("session provider id SQL normalizer", () => {
  /** 空白だけの値・前後の Unicode 空白・文字列でない値も、実 SQL 関数が共有の正規化結果と同じ値に解決する。 */
  it("Session summary と同じ文字列正規化を SQLite query へ提供する", () => {
    const db = new DatabaseSync(":memory:");
    try {
      registerSessionProviderIdNormalizer(db);
      const statement = db.prepare(`
        SELECT ${SESSION_PROVIDER_ID_NORMALIZER_SQL_FUNCTION}(?) AS normalized
      `);
      const inputs: SQLInputValue[] = [
        "\tcodex\t",
        "\nCodex\n",
        "\u00a0custom-provider\u00a0",
        " \t\r\n\u00a0 ",
        42,
        null,
      ];

      for (const input of inputs) {
        const row = statement.get(input) as { normalized: string };
        assert.equal(row.normalized, normalizeProviderId(input));
      }
    } finally {
      db.close();
    }
  });
});
