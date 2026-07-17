import type { DatabaseSync } from "node:sqlite";

export type SqliteMigration = Readonly<{
  fromVersion: number;
  toVersion: number;
  apply(database: DatabaseSync): void;
  verify(database: DatabaseSync): void;
}>;

export const SQLITE_MIGRATIONS: readonly SqliteMigration[] = [];

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
