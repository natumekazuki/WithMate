import { existsSync, linkSync, mkdirSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  CREATE_V6_SCHEMA_SQL,
  APP_DATABASE_V6_FILENAME,
  isValidV6Database,
  resolveV6FreshDatabasePath,
} from "./database-schema-v6.js";
import { openAppDatabase } from "./sqlite-connection.js";

export type V6FreshDatabaseBootstrapResult = {
  dbPath: string;
  created: boolean;
};

type V6FreshDatabaseBootstrapOptions = {
  schemaSql?: readonly string[];
};

export async function createOrVerifyV6FreshDatabase(
  userDataPath: string,
  options: V6FreshDatabaseBootstrapOptions = {},
): Promise<V6FreshDatabaseBootstrapResult> {
  const dbPath = resolveV6FreshDatabasePath(userDataPath);
  if (existsSync(dbPath)) {
    if (!isValidV6Database(dbPath)) {
      throw new Error("withmate-v6.db exists but does not match the V6 foundation schema.");
    }
    return { dbPath, created: false };
  }

  mkdirSync(dirname(dbPath), { recursive: true });
  const tempDirectoryPath = await mkdtemp(join(dirname(dbPath), ".withmate-v6-bootstrap-"));
  const tempDbPath = join(tempDirectoryPath, APP_DATABASE_V6_FILENAME);

  try {
    const db = openAppDatabase(tempDbPath);
    let committed = false;
    try {
      db.exec("BEGIN IMMEDIATE TRANSACTION;");
      for (const statement of options.schemaSql ?? CREATE_V6_SCHEMA_SQL) {
        db.exec(statement);
      }
      db.exec("COMMIT;");
      committed = true;
      db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    } catch (error) {
      if (!committed) {
        try {
          db.exec("ROLLBACK;");
        } catch {
          // Best-effort rollback before closing and deleting the temporary database.
        }
      }
      throw error;
    } finally {
      db.close();
    }

    if (!isValidV6Database(tempDbPath)) {
      throw new Error("Failed to create a valid withmate-v6.db foundation database.");
    }

    try {
      linkSync(tempDbPath, dbPath);
    } catch (error) {
      if (existsSync(dbPath) && isValidV6Database(dbPath)) {
        return { dbPath, created: false };
      }
      throw error;
    }

    return { dbPath, created: true };
  } finally {
    rmSync(tempDirectoryPath, { recursive: true, force: true });
  }
}
