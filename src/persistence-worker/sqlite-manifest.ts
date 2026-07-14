import { createHash } from "node:crypto";
import fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";

import type { SchemaArtifacts } from "./schema-artifacts.js";

export type SqliteSchemaManifest = Readonly<{
  schemaVersion: number;
  applicationId: number;
  applicationIdHex: string;
  applicationIdText: string;
  schemaDefinitionSha256: string;
  tables: readonly string[];
  indexes: readonly string[];
  triggers: readonly string[];
}>;

export type SqliteSchemaBundle = Readonly<{
  ddl: string;
  manifest: SqliteSchemaManifest;
}>;

type SchemaDefinitionRow = Readonly<{
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}>;

type SchemaObjectNames = Readonly<{
  tables: readonly string[];
  indexes: readonly string[];
  triggers: readonly string[];
}>;

export function loadSqliteSchemaBundle(artifacts: SchemaArtifacts): SqliteSchemaBundle {
  const ddl = fs.readFileSync(artifacts.ddlUrl, "utf8");
  const rawManifest: unknown = JSON.parse(fs.readFileSync(artifacts.manifestUrl, "utf8"));

  return {
    ddl,
    manifest: parseSqliteSchemaManifest(rawManifest),
  };
}

export function computeSchemaDefinitionSha256(database: DatabaseSync): string {
  const rows = database
    .prepare(
      `
        SELECT type, name, tbl_name, sql
        FROM sqlite_schema
        WHERE name NOT LIKE 'sqlite_%' AND type IN ('table', 'index', 'trigger')
        ORDER BY type, name
      `,
    )
    .all() as unknown as SchemaDefinitionRow[];

  const normalized = rows.map((row) => ({
    type: row.type,
    name: row.name,
    table: row.tbl_name,
    sql: row.sql === null ? null : row.sql.split(/\s+/u).filter(Boolean).join(" "),
  }));

  return createHash("sha256").update(JSON.stringify(normalized), "utf8").digest("hex");
}

export function readSchemaObjectNames(database: DatabaseSync): SchemaObjectNames {
  const rows = database
    .prepare(
      `
        SELECT type, name
        FROM sqlite_schema
        WHERE name NOT LIKE 'sqlite_%' AND type IN ('table', 'index', 'trigger')
        ORDER BY type, name
      `,
    )
    .all() as unknown as Array<{ type: string; name: string }>;

  return {
    tables: rows.filter((row) => row.type === "table").map((row) => row.name),
    indexes: rows.filter((row) => row.type === "index").map((row) => row.name),
    triggers: rows.filter((row) => row.type === "trigger").map((row) => row.name),
  };
}

export function readUniqueConstraintAutoindexes(database: DatabaseSync, tables: readonly string[]): readonly string[] {
  const autoindexes: string[] = [];

  for (const table of tables) {
    const escapedTable = table.replaceAll('"', '""');
    const rows = database.prepare(`PRAGMA index_list("${escapedTable}")`).all() as unknown as Array<{
      name: string;
      origin: string;
    }>;
    for (const row of rows) {
      if (row.origin === "u") {
        autoindexes.push(`${table}.${row.name}`);
      }
    }
  }

  return autoindexes;
}

function parseSqliteSchemaManifest(value: unknown): SqliteSchemaManifest {
  if (!isRecord(value)) {
    throw new TypeError("SQLite schema manifest must be an object.");
  }

  return {
    schemaVersion: requireNonNegativeInteger(value.schemaVersion, "schemaVersion"),
    applicationId: requireNonNegativeInteger(value.applicationId, "applicationId"),
    applicationIdHex: requireString(value.applicationIdHex, "applicationIdHex"),
    applicationIdText: requireString(value.applicationIdText, "applicationIdText"),
    schemaDefinitionSha256: requireSha256(value.schemaDefinitionSha256),
    tables: requireUniqueStringArray(value.tables, "tables"),
    indexes: requireUniqueStringArray(value.indexes, "indexes"),
    triggers: requireUniqueStringArray(value.triggers, "triggers"),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`SQLite schema manifest ${field} must be a non-negative integer.`);
  }
  return value as number;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`SQLite schema manifest ${field} must be a non-empty string.`);
  }
  return value;
}

function requireSha256(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new TypeError("SQLite schema manifest schemaDefinitionSha256 must be lowercase SHA-256 hex.");
  }
  return value;
}

function requireUniqueStringArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.length > 0)) {
    throw new TypeError(`SQLite schema manifest ${field} must be an array of non-empty strings.`);
  }
  if (new Set(value).size !== value.length) {
    throw new TypeError(`SQLite schema manifest ${field} must not contain duplicates.`);
  }
  return value;
}
