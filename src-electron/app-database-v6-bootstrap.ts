import { existsSync } from "node:fs";

import {
  CREATE_V6_SCHEMA_SQL,
  isValidV6Database,
  resolveV6FreshDatabasePath,
} from "./database-schema-v6.js";
import { openAppDatabase } from "./sqlite-connection.js";

export type V6FreshDatabaseBootstrapResult = {
  dbPath: string;
  created: boolean;
};

export function createOrVerifyV6FreshDatabase(userDataPath: string): V6FreshDatabaseBootstrapResult {
  const dbPath = resolveV6FreshDatabasePath(userDataPath);
  if (existsSync(dbPath)) {
    if (!isValidV6Database(dbPath)) {
      throw new Error("withmate-v6.db exists but does not match the V6 foundation schema.");
    }
    return { dbPath, created: false };
  }

  const db = openAppDatabase(dbPath);
  try {
    for (const statement of CREATE_V6_SCHEMA_SQL) {
      db.exec(statement);
    }
  } finally {
    db.close();
  }

  if (!isValidV6Database(dbPath)) {
    throw new Error("Failed to create a valid withmate-v6.db foundation database.");
  }
  return { dbPath, created: true };
}
