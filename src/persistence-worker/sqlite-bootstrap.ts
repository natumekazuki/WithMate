import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { constants as sqliteConstants, DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

import { resolveSchemaV1Artifacts, type SchemaArtifacts } from "./schema-artifacts.js";
import {
  computeSchemaDefinitionSha256,
  loadSqliteSchemaBundle,
  readSchemaObjectNames,
  readUniqueConstraintAutoindexes,
  type SqliteSchemaBundle,
  type SqliteSchemaManifest,
} from "./sqlite-manifest.js";

const EXPECTED_ENCODING = "UTF-8";
const EXPECTED_AUTO_VACUUM = 2;
const EXPECTED_SECURE_DELETE = 2;
const EXPECTED_BUSY_TIMEOUT_MS = 5_000;
const EXPECTED_WAL_AUTOCHECKPOINT_PAGES = 256;
const EXPECTED_JOURNAL_SIZE_LIMIT_BYTES = 64 * 1024 * 1024;

export type DatabaseBootstrapErrorCode =
  | "database_path_invalid"
  | "database_busy"
  | "database_identity_mismatch"
  | "database_schema_unknown"
  | "database_schema_too_new"
  | "database_schema_too_old"
  | "database_schema_verification_failed"
  | "database_integrity_check_failed"
  | "database_pragma_mismatch"
  | "database_wal_unavailable"
  | "database_bootstrap_failed"
  | "schema_artifact_invalid";

export class DatabaseBootstrapError extends Error {
  readonly code: DatabaseBootstrapErrorCode;
  readonly retryable: boolean;
  readonly details: Readonly<Record<string, string | number | boolean>>;

  constructor(
    code: DatabaseBootstrapErrorCode,
    message: string,
    options: Readonly<{
      retryable?: boolean;
      details?: Readonly<Record<string, string | number | boolean>>;
      cause?: unknown;
    }> = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "DatabaseBootstrapError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details ?? {};
  }
}

export type DatabaseClassification =
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "empty" }>
  | Readonly<{ kind: "interrupted" }>
  | Readonly<{ kind: "current"; schemaVersion: number }>
  | Readonly<{ kind: "upgrade"; schemaVersion: number }>;

export type OpenDatabaseOptions = Readonly<{
  databasePath: string;
  legacyDatabasePaths: readonly string[];
  artifacts?: SchemaArtifacts;
}>;

export type OpenDatabaseResult = Readonly<{
  database: DatabaseSync;
  initialized: boolean;
  schemaVersion: number;
}>;

export function openOrBootstrapDatabase(options: OpenDatabaseOptions): OpenDatabaseResult {
  assertDedicatedDatabasePath(options.databasePath, options.legacyDatabasePaths);
  const bundle = loadBundle(options.artifacts ?? resolveSchemaV1Artifacts());
  let classification = classifyDatabaseFile(options.databasePath, bundle.manifest);

  if (classification.kind === "missing") {
    classification = reserveFreshDatabaseFile(options.databasePath, bundle.manifest);
  }

  if (classification.kind === "upgrade") {
    throw new DatabaseBootstrapError("database_schema_too_old", "Database migration is not available.", {
      details: { actualVersion: classification.schemaVersion, expectedVersion: bundle.manifest.schemaVersion },
    });
  }

  if (classification.kind === "current") {
    verifyExistingDatabaseReadOnly(options.databasePath, bundle.manifest);
    const database = openWritableDatabase(options.databasePath);
    try {
      verifyPersistentSchema(database, bundle.manifest);
      configureConnection(database);
      return { database, initialized: false, schemaVersion: bundle.manifest.schemaVersion };
    } catch (error) {
      database.close();
      throw normalizeDatabaseError(error, "database_schema_verification_failed", "Database verification failed.");
    }
  }

  const database = openWritableDatabase(options.databasePath);
  try {
    const writableClassification = classifyOpenDatabase(database, bundle.manifest);
    if (writableClassification.kind !== "empty" && writableClassification.kind !== "interrupted") {
      throw new DatabaseBootstrapError("database_schema_unknown", "Database changed before bootstrap started.");
    }

    bootstrapFreshDatabase(database, bundle);
    configureConnection(database);
    return { database, initialized: true, schemaVersion: bundle.manifest.schemaVersion };
  } catch (error) {
    rollbackIfNeeded(database);
    database.close();
    if (error instanceof DatabaseBootstrapError) {
      throw error;
    }
    throw normalizeDatabaseError(error, "database_bootstrap_failed", "Database bootstrap failed.");
  }
}

export function classifyDatabaseFile(databasePath: string, manifest: SqliteSchemaManifest): DatabaseClassification {
  if (!fs.existsSync(databasePath)) {
    return { kind: "missing" };
  }

  const stats = fs.lstatSync(databasePath);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new DatabaseBootstrapError("database_path_invalid", "Database path must be a regular file.");
  }
  if (stats.size === 0) {
    return { kind: "empty" };
  }

  try {
    return inspectDatabaseWithoutMutation(databasePath, (database) => classifyOpenDatabase(database, manifest));
  } catch (error) {
    throw normalizeDatabaseError(error, "database_schema_unknown", "Database could not be classified.");
  }
}

function classifyOpenDatabase(database: DatabaseSync, manifest: SqliteSchemaManifest): DatabaseClassification {
  const applicationId = readPragmaNumber(database, "application_id");
  const userVersion = readPragmaNumber(database, "user_version");
  const userObjectCount = readUserSchemaObjectCount(database);

  if (applicationId !== 0 && applicationId !== manifest.applicationId) {
    throw new DatabaseBootstrapError("database_identity_mismatch", "Database identity does not match.", {
      details: { actualApplicationId: applicationId, expectedApplicationId: manifest.applicationId },
    });
  }
  if (userVersion < 0) {
    throw new DatabaseBootstrapError("database_schema_unknown", "Database schema version is invalid.", {
      details: { actualVersion: userVersion },
    });
  }
  if (applicationId === 0 && userVersion === 0 && userObjectCount === 0) {
    return { kind: "empty" };
  }
  if (applicationId === manifest.applicationId && userVersion === 0 && userObjectCount === 0) {
    return { kind: "interrupted" };
  }
  if (applicationId !== manifest.applicationId) {
    throw new DatabaseBootstrapError("database_identity_mismatch", "Database identity does not match.", {
      details: { actualApplicationId: applicationId, expectedApplicationId: manifest.applicationId },
    });
  }
  if (userVersion === 0 || userObjectCount === 0) {
    throw new DatabaseBootstrapError("database_schema_unknown", "Database schema state is incomplete.", {
      details: { actualVersion: userVersion, userObjectCount },
    });
  }
  if (userVersion > manifest.schemaVersion) {
    throw new DatabaseBootstrapError("database_schema_too_new", "Database schema is newer than this application.", {
      details: { actualVersion: userVersion, expectedVersion: manifest.schemaVersion },
    });
  }
  if (userVersion < 1) {
    throw new DatabaseBootstrapError("database_schema_too_old", "Database schema is no longer supported.", {
      details: { actualVersion: userVersion, minimumVersion: 1 },
    });
  }
  if (userVersion < manifest.schemaVersion) {
    return { kind: "upgrade", schemaVersion: userVersion };
  }
  return { kind: "current", schemaVersion: userVersion };
}

function bootstrapFreshDatabase(database: DatabaseSync, bundle: SqliteSchemaBundle): void {
  const { manifest } = bundle;
  database.exec(`PRAGMA encoding = '${EXPECTED_ENCODING}';`);
  database.exec("PRAGMA auto_vacuum = INCREMENTAL;");
  database.exec(`PRAGMA application_id = ${manifest.applicationId};`);
  database.exec("PRAGMA secure_delete = FAST;");
  database.exec("PRAGMA foreign_keys = ON;");
  database.exec(`PRAGMA busy_timeout = ${EXPECTED_BUSY_TIMEOUT_MS};`);

  if (readPragmaNumber(database, "auto_vacuum") !== EXPECTED_AUTO_VACUUM) {
    database.exec("VACUUM;");
    database.exec("PRAGMA auto_vacuum = INCREMENTAL;");
  }

  assertPragma(database, "application_id", manifest.applicationId);
  assertPragma(database, "auto_vacuum", EXPECTED_AUTO_VACUUM);
  assertPragma(database, "encoding", EXPECTED_ENCODING);

  try {
    database.exec("BEGIN IMMEDIATE;");
    executeSchemaDdl(database, bundle.ddl);
    verifySchemaDefinition(database, manifest);
    verifyIntegrity(database);
    database.exec(`PRAGMA user_version = ${manifest.schemaVersion};`);
    assertPragma(database, "user_version", manifest.schemaVersion);
    database.exec("COMMIT;");
  } catch (error) {
    rollbackIfNeeded(database);
    if (error instanceof DatabaseBootstrapError) {
      throw error;
    }
    throw new DatabaseBootstrapError("database_bootstrap_failed", "Database schema transaction failed.", {
      cause: error,
    });
  }

  verifyPersistentSchema(database, manifest);
}

function executeSchemaDdl(database: DatabaseSync, ddl: string): void {
  assertSchemaDdlHasNoControlStatements(ddl);
  const databaseWithAuthorizer = database as DatabaseSync & {
    setAuthorizer?: DatabaseSync["setAuthorizer"];
  };
  const deniedActions = new Set([
    sqliteConstants.SQLITE_TRANSACTION,
    sqliteConstants.SQLITE_SAVEPOINT,
    sqliteConstants.SQLITE_ATTACH,
    sqliteConstants.SQLITE_DETACH,
    sqliteConstants.SQLITE_PRAGMA,
    sqliteConstants.SQLITE_CREATE_TEMP_INDEX,
    sqliteConstants.SQLITE_CREATE_TEMP_TABLE,
    sqliteConstants.SQLITE_CREATE_TEMP_TRIGGER,
    sqliteConstants.SQLITE_CREATE_TEMP_VIEW,
    sqliteConstants.SQLITE_CREATE_VTABLE,
  ]);

  if (databaseWithAuthorizer.setAuthorizer === undefined) {
    throw new DatabaseBootstrapError(
      "database_schema_verification_failed",
      "SQLite authorizer is unavailable for schema installation.",
    );
  }
  databaseWithAuthorizer.setAuthorizer((actionCode) =>
    deniedActions.has(actionCode) ? sqliteConstants.SQLITE_DENY : sqliteConstants.SQLITE_OK,
  );
  try {
    database.exec(ddl);
  } finally {
    databaseWithAuthorizer.setAuthorizer(null);
  }
}

function assertSchemaDdlHasNoControlStatements(ddl: string): void {
  const sqlWithoutLiteralsOrComments = ddl
    .replace(/'(?:''|[^'])*'/g, "''")
    .replace(/"(?:""|[^"])*"/g, '""')
    .replace(/--[^\r\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const tokens = sqlWithoutLiteralsOrComments.match(/[A-Za-z_][A-Za-z_0-9]*|;/g) ?? [];
  const forbidden = new Set(["ATTACH", "DETACH", "PRAGMA", "COMMIT", "ROLLBACK", "SAVEPOINT", "RELEASE"]);
  let statementWords: string[] = [];
  let inTriggerBody = false;
  let triggerCaseDepth = 0;
  let invalid = false;
  for (const token of tokens) {
    const normalized = token.toUpperCase();
    if (inTriggerBody) {
      if (forbidden.has(normalized) || normalized === "BEGIN") {
        invalid = true;
        break;
      }
      if (normalized === "CASE") triggerCaseDepth += 1;
      if (normalized === "END") {
        if (triggerCaseDepth > 0) triggerCaseDepth -= 1;
        else inTriggerBody = false;
      }
      continue;
    }
    if (normalized === ";") {
      statementWords = [];
      continue;
    }
    if (forbidden.has(normalized) || normalized === "END") {
      invalid = true;
      break;
    }
    if (normalized === "BEGIN") {
      if (!isCreateTriggerPrefix(statementWords)) {
        invalid = true;
        break;
      }
      inTriggerBody = true;
      triggerCaseDepth = 0;
      continue;
    }
    statementWords.push(normalized);
  }
  if (invalid) {
    throw new DatabaseBootstrapError(
      "database_schema_verification_failed",
      "Schema artifact contains a forbidden control statement.",
    );
  }
}

function isCreateTriggerPrefix(words: readonly string[]): boolean {
  if (words[0] !== "CREATE") return false;
  const triggerIndex = words[1] === "TEMP" || words[1] === "TEMPORARY" ? 2 : 1;
  return words[triggerIndex] === "TRIGGER";
}

function configureConnection(database: DatabaseSync): void {
  const journalMode = readPragmaString(database, "journal_mode = WAL").toLowerCase();
  if (journalMode !== "wal") {
    throw new DatabaseBootstrapError("database_wal_unavailable", "Database WAL mode is unavailable.", {
      details: { actualJournalMode: journalMode },
    });
  }

  database.exec("PRAGMA foreign_keys = ON;");
  database.exec("PRAGMA secure_delete = FAST;");
  database.exec(`PRAGMA busy_timeout = ${EXPECTED_BUSY_TIMEOUT_MS};`);
  database.exec(`PRAGMA wal_autocheckpoint = ${EXPECTED_WAL_AUTOCHECKPOINT_PAGES};`);
  database.exec(`PRAGMA journal_size_limit = ${EXPECTED_JOURNAL_SIZE_LIMIT_BYTES};`);

  assertPragma(database, "journal_mode", "wal", true);
  assertPragma(database, "foreign_keys", 1);
  assertPragma(database, "secure_delete", EXPECTED_SECURE_DELETE);
  assertPragma(database, "busy_timeout", EXPECTED_BUSY_TIMEOUT_MS);
  assertPragma(database, "wal_autocheckpoint", EXPECTED_WAL_AUTOCHECKPOINT_PAGES);
  assertPragma(database, "journal_size_limit", EXPECTED_JOURNAL_SIZE_LIMIT_BYTES);
}

function verifyExistingDatabaseReadOnly(databasePath: string, manifest: SqliteSchemaManifest): void {
  inspectDatabaseWithoutMutation(databasePath, (database) => {
    verifyPersistentSchema(database, manifest);
  });
}

function verifyPersistentSchema(database: DatabaseSync, manifest: SqliteSchemaManifest): void {
  assertPragma(database, "application_id", manifest.applicationId);
  assertPragma(database, "user_version", manifest.schemaVersion);
  assertPragma(database, "auto_vacuum", EXPECTED_AUTO_VACUUM);
  assertPragma(database, "encoding", EXPECTED_ENCODING);

  verifySchemaDefinition(database, manifest);
  verifyIntegrity(database);
}

function verifySchemaDefinition(database: DatabaseSync, manifest: SqliteSchemaManifest): void {
  const actualObjects = readSchemaObjectNames(database);
  assertNameSet("tables", actualObjects.tables, manifest.tables);
  assertNameSet("indexes", actualObjects.indexes, manifest.indexes);
  assertNameSet("triggers", actualObjects.triggers, manifest.triggers);

  const actualHash = computeSchemaDefinitionSha256(database);
  if (actualHash !== manifest.schemaDefinitionSha256) {
    throw new DatabaseBootstrapError("database_schema_verification_failed", "Database schema definition differs.", {
      details: { expectedHash: manifest.schemaDefinitionSha256, actualHash },
    });
  }

  const autoindexes = readUniqueConstraintAutoindexes(database, actualObjects.tables);
  if (autoindexes.length > 0) {
    throw new DatabaseBootstrapError(
      "database_schema_verification_failed",
      "Database contains unexpected UNIQUE autoindexes.",
      { details: { autoindexCount: autoindexes.length } },
    );
  }
}

function verifyIntegrity(database: DatabaseSync): void {
  const foreignKeyViolations = database.prepare("PRAGMA foreign_key_check").all();
  const quickCheck = readPragmaString(database, "quick_check").toLowerCase();
  if (foreignKeyViolations.length > 0 || quickCheck !== "ok") {
    throw new DatabaseBootstrapError("database_integrity_check_failed", "Database integrity check failed.", {
      details: { foreignKeyViolationCount: foreignKeyViolations.length, quickCheckOk: quickCheck === "ok" },
    });
  }
}

function assertDedicatedDatabasePath(databasePath: string, legacyDatabasePaths: readonly string[]): void {
  if (!path.isAbsolute(databasePath)) {
    throw new DatabaseBootstrapError("database_path_invalid", "Database path must be absolute.");
  }
  const normalizedDatabasePath = normalizePath(databasePath);
  for (const legacyPath of legacyDatabasePaths) {
    if (normalizePath(legacyPath) === normalizedDatabasePath || pathsReferenceSameFile(databasePath, legacyPath)) {
      throw new DatabaseBootstrapError("database_path_invalid", "Database path must not reference a legacy database.");
    }
  }
}

function reserveFreshDatabaseFile(databasePath: string, manifest: SqliteSchemaManifest): DatabaseClassification {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  try {
    fs.closeSync(fs.openSync(databasePath, "wx"));
    return { kind: "empty" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw new DatabaseBootstrapError("database_path_invalid", "Database file could not be reserved.", {
        cause: error,
      });
    }
    return classifyDatabaseFile(databasePath, manifest);
  }
}

function inspectDatabaseWithoutMutation<TResult>(
  databasePath: string,
  inspect: (database: DatabaseSync) => TResult,
): TResult {
  const walPath = `${databasePath}-wal`;
  const journalPath = `${databasePath}-journal`;
  if (fs.existsSync(walPath) || fs.existsSync(journalPath)) {
    return inspectDatabaseSnapshot(databasePath, inspect);
  }

  const databaseUrl = pathToFileURL(databasePath);
  databaseUrl.searchParams.set("immutable", "1");
  const database = openInspectionDatabase(databaseUrl, true);
  try {
    return inspect(database);
  } finally {
    database.close();
  }
}

function inspectDatabaseSnapshot<TResult>(databasePath: string, inspect: (database: DatabaseSync) => TResult): TResult {
  const before = readDatabaseFileStates(databasePath);
  const snapshotDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "withmate-sqlite-inspection-"));
  const snapshotPath = path.join(snapshotDirectory, "database.sqlite3");

  try {
    fs.copyFileSync(databasePath, snapshotPath);
    if (fs.existsSync(`${databasePath}-wal`)) {
      fs.copyFileSync(`${databasePath}-wal`, `${snapshotPath}-wal`);
    }
    if (fs.existsSync(`${databasePath}-journal`)) {
      fs.copyFileSync(`${databasePath}-journal`, `${snapshotPath}-journal`);
    }
    assertDatabaseFileStatesUnchanged(databasePath, before);

    const requiresRecovery = fs.existsSync(`${snapshotPath}-journal`);
    const database = openInspectionDatabase(snapshotPath, !requiresRecovery);
    try {
      return inspect(database);
    } finally {
      database.close();
    }
  } finally {
    fs.rmSync(snapshotDirectory, { recursive: true, force: true });
  }
}

function openInspectionDatabase(databasePath: string | URL, readOnly: boolean): DatabaseSync {
  try {
    return new DatabaseSync(databasePath, { readOnly, allowExtension: false });
  } catch (error) {
    throw normalizeDatabaseError(error, "database_schema_unknown", "Database could not be opened for inspection.");
  }
}

function openWritableDatabase(databasePath: string): DatabaseSync {
  try {
    return new DatabaseSync(databasePath, { allowExtension: false });
  } catch (error) {
    throw normalizeDatabaseError(error, "database_bootstrap_failed", "Database could not be opened for bootstrap.");
  }
}

function readUserSchemaObjectCount(database: DatabaseSync): number {
  const row = database
    .prepare(
      `
        SELECT count(*) AS count
        FROM sqlite_schema
        WHERE name NOT LIKE 'sqlite_%' AND type IN ('table', 'index', 'trigger', 'view')
      `,
    )
    .get() as unknown as { count: number };
  return row.count;
}

function assertPragma(
  database: DatabaseSync,
  pragma: string,
  expected: number | string,
  caseInsensitive = false,
): void {
  const actual = readPragmaScalar(database, pragma);
  const matches =
    caseInsensitive && typeof actual === "string" && typeof expected === "string"
      ? actual.toLowerCase() === expected.toLowerCase()
      : actual === expected;
  if (!matches) {
    throw new DatabaseBootstrapError("database_pragma_mismatch", "Database PRAGMA does not match.", {
      details: { pragma, expected, actual: String(actual) },
    });
  }
}

function readPragmaNumber(database: DatabaseSync, pragma: string): number {
  const value = readPragmaScalar(database, pragma);
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new DatabaseBootstrapError("database_schema_unknown", "Database PRAGMA is not an integer.", {
      details: { pragma },
    });
  }
  return value;
}

function readPragmaString(database: DatabaseSync, pragma: string): string {
  const value = readPragmaScalar(database, pragma);
  if (typeof value !== "string") {
    throw new DatabaseBootstrapError("database_schema_unknown", "Database PRAGMA is not text.", {
      details: { pragma },
    });
  }
  return value;
}

function readPragmaScalar(database: DatabaseSync, pragma: string): unknown {
  const row = database.prepare(`PRAGMA ${pragma}`).get() as unknown;
  if (typeof row !== "object" || row === null) {
    throw new DatabaseBootstrapError("database_schema_unknown", "Database PRAGMA did not return a value.");
  }
  const values = Object.values(row);
  if (values.length !== 1) {
    throw new DatabaseBootstrapError("database_schema_unknown", "Database PRAGMA returned an unexpected shape.");
  }
  return values[0];
}

function assertNameSet(kind: string, actual: readonly string[], expected: readonly string[]): void {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const missingCount = expected.filter((name) => !actualSet.has(name)).length;
  const extraCount = actual.filter((name) => !expectedSet.has(name)).length;
  if (missingCount > 0 || extraCount > 0) {
    throw new DatabaseBootstrapError("database_schema_verification_failed", `Database ${kind} differ.`, {
      details: { missingCount, extraCount },
    });
  }
}

function rollbackIfNeeded(database: DatabaseSync): void {
  try {
    database.exec("ROLLBACK");
  } catch {
    // transaction開始前またはcommit後の失敗ではrollback対象がない。
  }
}

function loadBundle(artifacts: SchemaArtifacts): SqliteSchemaBundle {
  try {
    return loadSqliteSchemaBundle(artifacts);
  } catch (error) {
    throw new DatabaseBootstrapError("schema_artifact_invalid", "SQLite schema artifacts are invalid.", {
      cause: error,
    });
  }
}

function normalizePath(value: string): string {
  const resolved = path.resolve(value);
  const normalized = fs.existsSync(resolved)
    ? fs.realpathSync.native(resolved)
    : fs.existsSync(path.dirname(resolved))
      ? path.join(fs.realpathSync.native(path.dirname(resolved)), path.basename(resolved))
      : resolved;
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function pathsReferenceSameFile(firstPath: string, secondPath: string): boolean {
  if (!fs.existsSync(firstPath) || !fs.existsSync(secondPath)) {
    return false;
  }
  const first = fs.statSync(firstPath);
  const second = fs.statSync(secondPath);
  return first.dev === second.dev && first.ino === second.ino;
}

type FileState = Readonly<{
  path: string;
  device: bigint;
  inode: bigint;
  size: bigint;
  mtimeNs: bigint;
  sha256: string;
}>;

function readDatabaseFileStates(databasePath: string): readonly FileState[] {
  const filePaths = [databasePath, `${databasePath}-wal`, `${databasePath}-journal`, `${databasePath}-shm`].filter(
    (filePath) => fs.existsSync(filePath),
  );
  return filePaths.map((filePath) => {
    const stats = fs.statSync(filePath, { bigint: true });
    return {
      path: filePath,
      device: stats.dev,
      inode: stats.ino,
      size: stats.size,
      mtimeNs: stats.mtimeNs,
      sha256: hashFile(filePath),
    };
  });
}

function assertDatabaseFileStatesUnchanged(databasePath: string, before: readonly FileState[]): void {
  const after = readDatabaseFileStates(databasePath);
  if (
    before.length !== after.length ||
    before.some((expected, index) => {
      const actual = after[index];
      return (
        actual === undefined ||
        actual.path !== expected.path ||
        actual.device !== expected.device ||
        actual.inode !== expected.inode ||
        actual.size !== expected.size ||
        actual.mtimeNs !== expected.mtimeNs ||
        actual.sha256 !== expected.sha256
      );
    })
  ) {
    throw new DatabaseBootstrapError("database_busy", "Database changed during inspection.", { retryable: true });
  }
}

function hashFile(filePath: string): string {
  const hash = createHash("sha256");
  const descriptor = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) {
        hash.update(buffer.subarray(0, bytesRead));
      }
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
}

function normalizeDatabaseError(
  error: unknown,
  fallbackCode: DatabaseBootstrapErrorCode,
  message: string,
): DatabaseBootstrapError {
  if (error instanceof DatabaseBootstrapError) {
    return error;
  }
  if (isSqliteBusyError(error)) {
    return new DatabaseBootstrapError("database_busy", "Database is busy.", { retryable: true, cause: error });
  }
  return new DatabaseBootstrapError(fallbackCode, message, { cause: error });
}

function isSqliteBusyError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const candidate = error as { code?: unknown; errcode?: unknown; message?: unknown };
  return (
    candidate.code === "SQLITE_BUSY" ||
    candidate.code === "SQLITE_LOCKED" ||
    candidate.code === "EBUSY" ||
    candidate.errcode === 5 ||
    candidate.errcode === 6 ||
    (typeof candidate.message === "string" && /\b(?:busy|locked)\b/iu.test(candidate.message))
  );
}
