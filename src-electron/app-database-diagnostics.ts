import { existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  AppDatabaseCompatibilityMode,
  AppDatabaseDiagnostics,
  AppDatabaseFileDiagnostics,
  AppDatabaseFileStatus,
} from "../src/app-database-diagnostics-state.js";
import { APP_DATABASE_V1_FILENAME, APP_DATABASE_V1_SCHEMA_VERSION } from "./database-schema-v1.js";
import { APP_DATABASE_V2_FILENAME, APP_DATABASE_V2_SCHEMA_VERSION, isValidV2Database } from "./database-schema-v2.js";
import { APP_DATABASE_V3_FILENAME, APP_DATABASE_V3_SCHEMA_VERSION, isValidV3Database } from "./database-schema-v3.js";
import { APP_DATABASE_V4_FILENAME, APP_DATABASE_V4_SCHEMA_VERSION, isValidV4Database } from "./database-schema-v4.js";

type KnownDatabaseDefinition = {
  fileName: string;
  schemaVersion: number;
  isValid(dbPath: string): boolean;
};

const KNOWN_DATABASE_DEFINITIONS: KnownDatabaseDefinition[] = [
  {
    fileName: APP_DATABASE_V4_FILENAME,
    schemaVersion: APP_DATABASE_V4_SCHEMA_VERSION,
    isValid: isValidV4Database,
  },
  {
    fileName: APP_DATABASE_V3_FILENAME,
    schemaVersion: APP_DATABASE_V3_SCHEMA_VERSION,
    isValid: isValidV3Database,
  },
  {
    fileName: APP_DATABASE_V2_FILENAME,
    schemaVersion: APP_DATABASE_V2_SCHEMA_VERSION,
    isValid: isValidV2Database,
  },
  {
    fileName: APP_DATABASE_V1_FILENAME,
    schemaVersion: APP_DATABASE_V1_SCHEMA_VERSION,
    isValid: (dbPath) => existsSync(dbPath),
  },
];

function readUserVersion(dbPath: string): number | null {
  if (!existsSync(dbPath)) {
    return null;
  }

  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare("PRAGMA user_version").get() as { user_version?: unknown } | undefined;
    return typeof row?.user_version === "number" ? row.user_version : null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

function statusForFile(input: {
  activeDatabasePath: string;
  dbPath: string;
  fileName: string;
  exists: boolean;
  valid: boolean;
}): AppDatabaseFileStatus {
  if (!input.exists && input.fileName === APP_DATABASE_V4_FILENAME && input.dbPath === input.activeDatabasePath) {
    return "pending-create";
  }
  if (!input.exists) {
    return "missing";
  }
  return input.valid ? "ready" : "invalid";
}

function inspectKnownDatabaseFile(
  userDataPath: string,
  activeDatabasePath: string,
  definition: KnownDatabaseDefinition,
): AppDatabaseFileDiagnostics {
  const dbPath = path.join(userDataPath, definition.fileName);
  const exists = existsSync(dbPath);
  const valid = exists ? definition.isValid(dbPath) : false;
  return {
    fileName: definition.fileName,
    path: dbPath,
    exists,
    expectedSchemaVersion: definition.schemaVersion,
    userVersion: readUserVersion(dbPath),
    valid,
    status: statusForFile({
      activeDatabasePath,
      dbPath,
      fileName: definition.fileName,
      exists,
      valid,
    }),
  };
}

function compatibilityModeFor(fileName: string, valid: boolean, pendingCreate: boolean): AppDatabaseCompatibilityMode {
  if (fileName === APP_DATABASE_V4_FILENAME && (valid || pendingCreate)) {
    return "v4";
  }
  if (fileName === APP_DATABASE_V3_FILENAME && valid) {
    return "legacy-v3";
  }
  if (fileName === APP_DATABASE_V2_FILENAME && valid) {
    return "legacy-v2";
  }
  if (fileName === APP_DATABASE_V1_FILENAME && valid) {
    return "legacy-v1";
  }
  return "unsupported";
}

function buildWarnings(files: AppDatabaseFileDiagnostics[], activeFile: AppDatabaseFileDiagnostics): string[] {
  const warnings: string[] = [];
  const invalidFiles = files.filter((file) => file.exists && !file.valid);
  for (const file of invalidFiles) {
    warnings.push(`${file.fileName} exists but does not match its expected schema.`);
  }

  const validFiles = files.filter((file) => file.valid);
  if (validFiles.length > 1) {
    warnings.push(`Multiple valid app database generations exist: ${validFiles.map((file) => file.fileName).join(", ")}.`);
  }

  if (activeFile.status === "unsupported" || activeFile.status === "invalid") {
    warnings.push(`Active database ${activeFile.fileName} is not a supported WithMate schema.`);
  }

  return warnings;
}

export function inspectAppDatabase(
  userDataPath: string,
  activeDatabasePath: string,
  userDataPathOverrideApplied: boolean,
): AppDatabaseDiagnostics {
  const activeFileName = path.basename(activeDatabasePath);
  const files = KNOWN_DATABASE_DEFINITIONS.map((definition) =>
    inspectKnownDatabaseFile(userDataPath, activeDatabasePath, definition),
  );
  const activePathExists = existsSync(activeDatabasePath);
  const activeFile = files.find((file) => file.path === activeDatabasePath) ?? {
    fileName: activeFileName,
    path: activeDatabasePath,
    exists: activePathExists,
    expectedSchemaVersion: null,
    userVersion: readUserVersion(activeDatabasePath),
    valid: false,
    status: activePathExists ? "unsupported" : "missing",
  } satisfies AppDatabaseFileDiagnostics;
  const pendingCreate = activeFile.status === "pending-create";
  const compatibilityMode = compatibilityModeFor(activeFile.fileName, activeFile.valid, pendingCreate);
  const schemaVersion = pendingCreate ? APP_DATABASE_V4_SCHEMA_VERSION : activeFile.expectedSchemaVersion;

  return {
    userDataPath,
    userDataPathOverrideApplied,
    activeDatabasePath,
    activeFileName,
    compatibilityMode,
    schemaVersion: compatibilityMode === "unsupported" ? null : schemaVersion,
    userVersion: activeFile.userVersion,
    exists: activeFile.exists,
    valid: activeFile.valid || pendingCreate,
    files,
    warnings: buildWarnings(files, activeFile),
  };
}
