import fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";

import { MAX_SESSION_CONCURRENT_CHILD_RUNS } from "../shared/session-limits.js";

export type SqliteMigration = Readonly<{
  fromVersion: number;
  toVersion: number;
  apply(database: DatabaseSync): void;
  verify(database: DatabaseSync): void;
}>;

const migration1To2Sql = fs.readFileSync(new URL("../../schema/sqlite/migrations/1-to-2.sql", import.meta.url), "utf8");

export const SQLITE_MIGRATIONS: readonly SqliteMigration[] = [
  {
    fromVersion: 1,
    toVersion: 2,
    apply(database) {
      database.exec(migration1To2Sql);
    },
    verify(database) {
      const outOfRange = database
        .prepare("SELECT count(*) AS count FROM sessions WHERE max_concurrent_child_runs > ?")
        .get(MAX_SESSION_CONCURRENT_CHILD_RUNS) as unknown as { count: number };
      const triggers = database
        .prepare(
          `
            SELECT name
            FROM sqlite_schema
            WHERE type = 'trigger' AND name IN (
              'sessions_max_concurrent_child_runs_insert',
              'sessions_max_concurrent_child_runs_update'
            )
          `,
        )
        .all() as unknown as Array<{ name: string }>;
      if (outOfRange.count !== 0 || triggers.length !== 2) {
        throw new Error("Session child Run safety limit migration verification failed.");
      }
    },
  },
];

export function resolveMigrationPath(
  fromVersion: number,
  toVersion: number,
  migrations: readonly SqliteMigration[] = SQLITE_MIGRATIONS,
): readonly SqliteMigration[] {
  const byFromVersion = new Map(migrations.map((migration) => [migration.fromVersion, migration]));
  const path: SqliteMigration[] = [];
  let version = fromVersion;

  while (version < toVersion) {
    const migration = byFromVersion.get(version);
    if (migration === undefined || migration.toVersion !== version + 1) {
      return [];
    }
    path.push(migration);
    version = migration.toVersion;
  }

  return path;
}
