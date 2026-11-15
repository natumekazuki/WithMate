import { readFileSync } from "node:fs";

/** Released synthetic DDL, not a copy of any user's database. */
export const RELEASED_V6_SCHEMA_SQL = readFileSync(
  new URL("./released-memory-affect-schema.sql", import.meta.url), "utf8",
);
