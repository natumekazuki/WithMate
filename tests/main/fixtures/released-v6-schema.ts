import { readFileSync } from "node:fs";

/** リリース済みスキーマの合成 DDL であり、ユーザーのデータベースをコピーしたものではない。 */
export const RELEASED_V6_SCHEMA_SQL = readFileSync(
  new URL("./released-memory-affect-schema.sql", import.meta.url), "utf8",
);
