import { existsSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import type {
  AppDatabaseCompatibilityMode,
  AppDatabaseDiagnostics,
  AppDatabaseFileDiagnostics,
  AppDatabaseFileStatus,
} from "../../src-shared/window/app-database-diagnostics-state.js";
import {
  APP_DATABASE_V1_FILENAME,
  APP_DATABASE_V1_SCHEMA_VERSION,
} from "./database-schema-v1.js";
import {
  APP_DATABASE_V2_FILENAME,
  APP_DATABASE_V2_SCHEMA_VERSION,
  isValidV2Database,
} from "./database-schema-v2.js";
import {
  APP_DATABASE_V3_FILENAME,
  APP_DATABASE_V3_SCHEMA_VERSION,
  isValidV3Database,
} from "./database-schema-v3.js";
import {
  APP_DATABASE_V4_FILENAME,
  APP_DATABASE_V4_SCHEMA_VERSION,
  isValidV4Database,
} from "./database-schema-v4.js";
import {
  APP_DATABASE_V6_FILENAME,
  APP_DATABASE_V6_SCHEMA_VERSION,
  isValidV6DatabaseShallow,
} from "./database-schema-v6.js";
import { openAppDatabaseReadOnly } from "./sqlite-connection.js";

/** 既知の DB ファイル名と期待スキーマ、稼働候補としての扱いと検証方法をまとめる。 */
type KnownDatabaseDefinition = {
  fileName: string;
  schemaVersion: number;
  runtimeGeneration: boolean;
  /** 指定されたファイルがこの世代の診断基準を満たすか判定する。 */
  isValid(dbPath: string): boolean;
};

const KNOWN_DATABASE_DEFINITIONS: KnownDatabaseDefinition[] = [
  {
    fileName: APP_DATABASE_V6_FILENAME,
    schemaVersion: APP_DATABASE_V6_SCHEMA_VERSION,
    runtimeGeneration: true,
    isValid: isValidV6DatabaseShallow,
  },
  {
    fileName: APP_DATABASE_V4_FILENAME,
    schemaVersion: APP_DATABASE_V4_SCHEMA_VERSION,
    runtimeGeneration: true,
    isValid: isValidV4Database,
  },
  {
    fileName: APP_DATABASE_V3_FILENAME,
    schemaVersion: APP_DATABASE_V3_SCHEMA_VERSION,
    runtimeGeneration: true,
    isValid: isValidV3Database,
  },
  {
    fileName: APP_DATABASE_V2_FILENAME,
    schemaVersion: APP_DATABASE_V2_SCHEMA_VERSION,
    runtimeGeneration: true,
    isValid: isValidV2Database,
  },
  {
    fileName: APP_DATABASE_V1_FILENAME,
    schemaVersion: APP_DATABASE_V1_SCHEMA_VERSION,
    runtimeGeneration: true,
    /** V1 の診断ではスキーマ照合を行わず、ファイルの存在を有効性の基準にする。 */
    isValid: (dbPath) => existsSync(dbPath),
  },
];

/** 読み取り専用で SQLite の user_version を取得する。ファイルがないか値を読み取れなければ null を返す。 */
function readUserVersion(dbPath: string): number | null {
  if (!existsSync(dbPath)) {
    return null;
  }

  let db: DatabaseSync | null = null;
  try {
    db = openAppDatabaseReadOnly(dbPath);
    const row = db.prepare("PRAGMA user_version").get() as
      { user_version?: unknown } | undefined;
    return typeof row?.user_version === "number" ? row.user_version : null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/** ファイルの存在とスキーマ検証結果から状態を決める。選択済みの V4/V6 が未作成なら作成待ちと区別する。 */
function statusForFile(input: {
  activeDatabasePath: string;
  dbPath: string;
  fileName: string;
  exists: boolean;
  valid: boolean;
  runtimeGeneration: boolean;
}): AppDatabaseFileStatus {
  if (
    !input.exists &&
    (input.fileName === APP_DATABASE_V6_FILENAME ||
      input.fileName === APP_DATABASE_V4_FILENAME) &&
    input.dbPath === input.activeDatabasePath
  ) {
    return "pending-create";
  }
  if (!input.exists) {
    return "missing";
  }
  return input.valid ? "ready" : "invalid";
}

/** 既知世代のファイルを調べ、実測したバージョン、スキーマの妥当性、稼働候補となるかをまとめる。 */
function inspectKnownDatabaseFile(
  userDataPath: string,
  activeDatabasePath: string,
  definition: KnownDatabaseDefinition,
): AppDatabaseFileDiagnostics {
  const dbPath = path.join(userDataPath, definition.fileName);
  const exists = existsSync(dbPath);
  const schemaValid = exists ? definition.isValid(dbPath) : false;
  const runtimeEligible = definition.runtimeGeneration && schemaValid;
  return {
    fileName: definition.fileName,
    path: dbPath,
    exists,
    role: definition.runtimeGeneration ? "runtime" : "foundation",
    expectedSchemaVersion: definition.schemaVersion,
    userVersion: readUserVersion(dbPath),
    schemaValid,
    runtimeEligible,
    valid: schemaValid,
    status: statusForFile({
      activeDatabasePath,
      dbPath,
      fileName: definition.fileName,
      exists,
      valid: schemaValid,
      runtimeGeneration: definition.runtimeGeneration,
    }),
  };
}

/** 稼働中ファイルの世代と有効性から互換モードを判定する。作成待ちを許すのは V4/V6 のみ。 */
function compatibilityModeFor(
  fileName: string,
  valid: boolean,
  pendingCreate: boolean,
): AppDatabaseCompatibilityMode {
  if (fileName === APP_DATABASE_V6_FILENAME && (valid || pendingCreate)) {
    return "v6";
  }
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

/** 無効な既知ファイル、複数の有効世代の併存、選択中 DB の未対応スキーマを警告にまとめる。 */
function buildWarnings(
  files: AppDatabaseFileDiagnostics[],
  activeFile: AppDatabaseFileDiagnostics,
): string[] {
  const warnings: string[] = [];
  const invalidFiles = files.filter((file) => file.exists && !file.schemaValid);
  for (const file of invalidFiles) {
    warnings.push(
      `${file.fileName} exists but does not match its expected schema.`,
    );
  }

  const validFiles = files.filter((file) => file.runtimeEligible);
  if (validFiles.length > 1) {
    warnings.push(
      `Multiple valid app database generations exist: ${validFiles.map((file) => file.fileName).join(", ")}.`,
    );
  }

  if (activeFile.status === "unsupported" || activeFile.status === "invalid") {
    warnings.push(
      `Active database ${activeFile.fileName} is not a supported WithMate schema.`,
    );
  }

  return warnings;
}

/** ユーザーデータ配下と選択済み DB を作成・移行せずに調べ、互換モードとファイル別の状態を返す。 */
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
  const activeFile =
    files.find((file) => file.path === activeDatabasePath) ??
    ({
      fileName: activeFileName,
      path: activeDatabasePath,
      exists: activePathExists,
      role: "runtime",
      expectedSchemaVersion: null,
      userVersion: readUserVersion(activeDatabasePath),
      schemaValid: false,
      runtimeEligible: false,
      valid: false,
      status: activePathExists ? "unsupported" : "missing",
    } satisfies AppDatabaseFileDiagnostics);
  const pendingCreate = activeFile.status === "pending-create";
  const compatibilityMode = compatibilityModeFor(
    activeFile.fileName,
    activeFile.valid,
    pendingCreate,
  );
  const schemaVersion =
    pendingCreate && activeFile.fileName === APP_DATABASE_V6_FILENAME
      ? APP_DATABASE_V6_SCHEMA_VERSION
      : pendingCreate
        ? APP_DATABASE_V4_SCHEMA_VERSION
        : activeFile.expectedSchemaVersion;
  const schemaValid = activeFile.schemaValid || pendingCreate;
  const runtimeCompatible = activeFile.runtimeEligible || pendingCreate;

  return {
    userDataPath,
    userDataPathOverrideApplied,
    activeDatabasePath,
    activeFileName,
    compatibilityMode,
    schemaVersion: compatibilityMode === "unsupported" ? null : schemaVersion,
    userVersion: activeFile.userVersion,
    exists: activeFile.exists,
    schemaValid,
    runtimeCompatible,
    valid: runtimeCompatible,
    files,
    warnings: buildWarnings(files, activeFile),
  };
}
