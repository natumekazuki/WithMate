import { existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { APP_DATABASE_V1_FILENAME } from "./database-schema-v1.js";
import { APP_DATABASE_V2_FILENAME } from "./database-schema-v2.js";

const REQUIRED_V2_TABLES = [
  "sessions",
  "session_messages",
  "session_message_artifacts",
  "audit_logs",
  "audit_log_details",
  "audit_log_operations",
] as const;

function isValidV2Database(dbPath: string): boolean {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const placeholders = REQUIRED_V2_TABLES.map(() => "?").join(", ");
    const rows = db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
        AND name IN (${placeholders})
    `).all(...REQUIRED_V2_TABLES) as Array<{ name: string }>;
    const tableNames = new Set(rows.map((row) => row.name));
    return REQUIRED_V2_TABLES.every((tableName) => tableNames.has(tableName));
  } catch {
    return false;
  } finally {
    db?.close();
  }
}

export function resolveAppDatabasePath(userDataPath: string): string {
  const v2Path = path.join(userDataPath, APP_DATABASE_V2_FILENAME);
  if (existsSync(v2Path) && isValidV2Database(v2Path)) {
    return v2Path;
  }

  return path.join(userDataPath, APP_DATABASE_V1_FILENAME);
}
