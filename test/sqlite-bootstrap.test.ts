import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { resolveSchemaV1Artifacts } from "../src/persistence-worker/schema-artifacts.js";
import {
  DatabaseBootstrapError,
  openOrBootstrapDatabase,
  type DatabaseBootstrapErrorCode,
} from "../src/persistence-worker/sqlite-bootstrap.js";
import { resolveMigrationPath } from "../src/persistence-worker/sqlite-migrations.js";

const APPLICATION_ID = 1_464_686_132;

test("missing database is bootstrapped and reopened without reapplying DDL", () => {
  withTempDirectory((directory) => {
    const databasePath = path.join(directory, "runtime.sqlite3");
    const first = openDatabase(databasePath);
    assert.equal(first.initialized, true);
    assert.equal(readPragma(first.database, "application_id"), APPLICATION_ID);
    assert.equal(readPragma(first.database, "user_version"), 1);
    assert.equal(readPragma(first.database, "journal_mode"), "wal");
    assert.equal(readPragma(first.database, "auto_vacuum"), 2);
    assert.equal(readPragma(first.database, "foreign_keys"), 1);
    assert.equal(readPragma(first.database, "secure_delete"), 2);
    assert.equal(readPragma(first.database, "busy_timeout"), 5_000);
    assert.equal(readPragma(first.database, "wal_autocheckpoint"), 256);
    assert.equal(readPragma(first.database, "journal_size_limit"), 67_108_864);
    first.database.close();

    const second = openDatabase(databasePath);
    assert.equal(second.initialized, false);
    assert.equal(readPragma(second.database, "user_version"), 1);
    second.database.close();
  });
});

test("zero-byte and interrupted databases resume bootstrap", () => {
  withTempDirectory((directory) => {
    const emptyPath = path.join(directory, "empty.sqlite3");
    fs.writeFileSync(emptyPath, "");
    const empty = openDatabase(emptyPath);
    assert.equal(empty.initialized, true);
    empty.database.close();

    const interruptedPath = path.join(directory, "interrupted.sqlite3");
    const interruptedDatabase = new DatabaseSync(interruptedPath);
    interruptedDatabase.exec(`PRAGMA application_id = ${APPLICATION_ID};`);
    interruptedDatabase.close();

    const interrupted = openDatabase(interruptedPath);
    assert.equal(interrupted.initialized, true);
    interrupted.database.close();
  });
});

test("schema transaction failure leaves no user objects and can be retried", () => {
  withTempDirectory((directory) => {
    const databasePath = path.join(directory, "runtime.sqlite3");
    const invalidDdlPath = path.join(directory, "invalid-v1.sql");
    fs.writeFileSync(invalidDdlPath, "CREATE TABLE transient (id INTEGER); CREATE TABLE broken (", "utf8");

    expectBootstrapError(
      () =>
        openOrBootstrapDatabase({
          databasePath,
          legacyDatabasePaths: [],
          artifacts: {
            ddlUrl: pathToFileURL(invalidDdlPath),
            manifestUrl: resolveSchemaV1Artifacts().manifestUrl,
          },
        }),
      "database_bootstrap_failed",
    );

    const failedDatabase = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(readPragma(failedDatabase, "application_id"), APPLICATION_ID);
    assert.equal(readPragma(failedDatabase, "user_version"), 0);
    assert.equal(readUserObjectCount(failedDatabase), 0);
    failedDatabase.close();

    const retried = openDatabase(databasePath);
    assert.equal(retried.initialized, true);
    retried.database.close();
  });
});

test("manifest mismatch rolls back valid but incorrect DDL", () => {
  withTempDirectory((directory) => {
    const databasePath = path.join(directory, "runtime.sqlite3");
    const wrongDdlPath = path.join(directory, "wrong-v1.sql");
    fs.writeFileSync(wrongDdlPath, "CREATE TABLE wrong (id INTEGER PRIMARY KEY) STRICT;", "utf8");

    expectBootstrapError(
      () =>
        openOrBootstrapDatabase({
          databasePath,
          legacyDatabasePaths: [],
          artifacts: {
            ddlUrl: pathToFileURL(wrongDdlPath),
            manifestUrl: resolveSchemaV1Artifacts().manifestUrl,
          },
        }),
      "database_schema_verification_failed",
    );

    const failedDatabase = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(readPragma(failedDatabase, "user_version"), 0);
    assert.equal(readUserObjectCount(failedDatabase), 0);
    failedDatabase.close();

    openDatabase(databasePath).database.close();
  });
});

test("schema artifact cannot escape the worker-owned transaction", () => {
  withTempDirectory((directory) => {
    const databasePath = path.join(directory, "runtime.sqlite3");
    const controlDdlPath = path.join(directory, "control-v1.sql");
    fs.writeFileSync(controlDdlPath, "COMMIT; CREATE TABLE wrong (id INTEGER);", "utf8");

    expectBootstrapError(
      () =>
        openOrBootstrapDatabase({
          databasePath,
          legacyDatabasePaths: [],
          artifacts: {
            ddlUrl: pathToFileURL(controlDdlPath),
            manifestUrl: resolveSchemaV1Artifacts().manifestUrl,
          },
        }),
      "database_schema_verification_failed",
    );

    const failedDatabase = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(readPragma(failedDatabase, "user_version"), 0);
    assert.equal(readUserObjectCount(failedDatabase), 0);
    failedDatabase.close();

    openDatabase(databasePath).database.close();
  });
});

test("identity mismatch, unknown schema, and future schema are rejected without file mutation", () => {
  withTempDirectory((directory) => {
    const cases = [
      {
        name: "identity",
        expectedCode: "database_identity_mismatch" as const,
        initialize(database: DatabaseSync) {
          database.exec("PRAGMA application_id = 123; CREATE TABLE alien (id INTEGER);");
        },
      },
      {
        name: "unknown",
        expectedCode: "database_schema_unknown" as const,
        initialize(database: DatabaseSync) {
          database.exec(`PRAGMA application_id = ${APPLICATION_ID}; CREATE TABLE partial (id INTEGER);`);
        },
      },
      {
        name: "future",
        expectedCode: "database_schema_too_new" as const,
        initialize(database: DatabaseSync) {
          database.exec(
            `PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = 2; CREATE TABLE future_data (id INTEGER);`,
          );
        },
      },
      {
        name: "negative",
        expectedCode: "database_schema_unknown" as const,
        initialize(database: DatabaseSync) {
          database.exec(
            `PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = -1; CREATE TABLE invalid_version (id INTEGER);`,
          );
        },
      },
    ];

    for (const testCase of cases) {
      const databasePath = path.join(directory, `${testCase.name}.sqlite3`);
      const database = new DatabaseSync(databasePath);
      testCase.initialize(database);
      database.close();
      const before = snapshotDirectory(directory);

      expectBootstrapError(() => openDatabase(databasePath), testCase.expectedCode);

      assert.deepEqual(snapshotDirectory(directory), before);
    }
  });
});

test("current schema drift is rejected without mutation", () => {
  withTempDirectory((directory) => {
    const databasePath = path.join(directory, "runtime.sqlite3");
    openDatabase(databasePath).database.close();

    const drifted = new DatabaseSync(databasePath);
    drifted.exec("CREATE INDEX unexpected_sessions_idx ON sessions(created_at);");
    drifted.close();
    const before = snapshotDirectory(directory);

    expectBootstrapError(() => openDatabase(databasePath), "database_schema_verification_failed");

    assert.deepEqual(snapshotDirectory(directory), before);
  });
});

test("pending WAL is inspected through a snapshot without mutating source sidecars", () => {
  withTempDirectory((directory) => {
    const databasePath = path.join(directory, "runtime.sqlite3");
    openDatabase(databasePath).database.close();

    const child = spawnSqliteProcess(
      databasePath,
      "database.exec('PRAGMA wal_autocheckpoint = 0; CREATE INDEX pending_drift_idx ON sessions(updated_at);');",
    );
    assert.equal(child.status, 23);
    assert.equal(fs.statSync(`${databasePath}-wal`).size > 0, true);
    const before = snapshotDirectory(directory);

    expectBootstrapError(() => openDatabase(databasePath), "database_schema_verification_failed");

    assert.deepEqual(snapshotDirectory(directory), before);
  });
});

test("hot bootstrap journal is recovered only after snapshot classification", () => {
  withTempDirectory((directory) => {
    const child = spawnHotJournalRecoveryProcess(directory);
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), { initialized: true, userObjectCount: 16 });
  });
});

test("non-SQLite and legacy paths are never bootstrapped", () => {
  withTempDirectory((directory) => {
    const invalidPath = path.join(directory, "not-sqlite.db");
    fs.writeFileSync(invalidPath, "not a sqlite database", "utf8");
    const invalidBefore = fs.readFileSync(invalidPath);
    expectBootstrapError(() => openDatabase(invalidPath), "database_schema_unknown");
    assert.deepEqual(fs.readFileSync(invalidPath), invalidBefore);

    const legacyPath = path.join(directory, "legacy.db");
    fs.writeFileSync(legacyPath, "legacy database sentinel", "utf8");
    const legacyBefore = fs.readFileSync(legacyPath);
    expectBootstrapError(
      () => openOrBootstrapDatabase({ databasePath: legacyPath, legacyDatabasePaths: [legacyPath] }),
      "database_path_invalid",
    );
    assert.deepEqual(fs.readFileSync(legacyPath), legacyBefore);

    const legacyEmptyPath = path.join(directory, "legacy-empty.db");
    const hardlinkPath = path.join(directory, "runtime-hardlink.db");
    fs.writeFileSync(legacyEmptyPath, "");
    fs.linkSync(legacyEmptyPath, hardlinkPath);
    expectBootstrapError(
      () => openOrBootstrapDatabase({ databasePath: hardlinkPath, legacyDatabasePaths: [legacyEmptyPath] }),
      "database_path_invalid",
    );
    assert.equal(fs.statSync(legacyEmptyPath).size, 0);

    const legacyDirectory = path.join(directory, "legacy-directory");
    const aliasDirectory = path.join(directory, "legacy-alias");
    fs.mkdirSync(legacyDirectory);
    const legacyAliasTarget = path.join(legacyDirectory, "aliased.db");
    fs.writeFileSync(legacyAliasTarget, "");
    fs.symlinkSync(legacyDirectory, aliasDirectory, process.platform === "win32" ? "junction" : "dir");
    expectBootstrapError(
      () =>
        openOrBootstrapDatabase({
          databasePath: path.join(aliasDirectory, "aliased.db"),
          legacyDatabasePaths: [legacyAliasTarget],
        }),
      "database_path_invalid",
    );
    assert.equal(fs.statSync(legacyAliasTarget).size, 0);

    const runtimePath = path.join(directory, "runtime.sqlite3");
    openOrBootstrapDatabase({ databasePath: runtimePath, legacyDatabasePaths: [legacyPath] }).database.close();
    assert.deepEqual(fs.readFileSync(legacyPath), legacyBefore);
  });
});

test("invalid schema artifact fails before creating a database", () => {
  withTempDirectory((directory) => {
    const databasePath = path.join(directory, "runtime.sqlite3");
    const invalidManifestPath = path.join(directory, "invalid-manifest.json");
    fs.writeFileSync(invalidManifestPath, JSON.stringify({ schemaVersion: 1 }), "utf8");

    expectBootstrapError(
      () =>
        openOrBootstrapDatabase({
          databasePath,
          legacyDatabasePaths: [],
          artifacts: {
            ddlUrl: resolveSchemaV1Artifacts().ddlUrl,
            manifestUrl: pathToFileURL(invalidManifestPath),
          },
        }),
      "schema_artifact_invalid",
    );
    assert.equal(fs.existsSync(databasePath), false);
  });
});

test("bootstrap lock contention is retryable", () => {
  withTempDirectory((directory) => {
    const databasePath = path.join(directory, "runtime.sqlite3");
    const owner = new DatabaseSync(databasePath);
    owner.exec("BEGIN EXCLUSIVE;");
    try {
      assert.throws(
        () => openDatabase(databasePath),
        (error: unknown) =>
          error instanceof DatabaseBootstrapError && error.code === "database_busy" && error.retryable,
      );
    } finally {
      owner.exec("ROLLBACK;");
      owner.close();
    }
  });
});

test("migration path requires contiguous single-version steps", () => {
  const migrations = [
    { fromVersion: 1, toVersion: 2, apply() {}, verify() {} },
    { fromVersion: 2, toVersion: 3, apply() {}, verify() {} },
  ];
  assert.deepEqual(resolveMigrationPath(1, 3, migrations), migrations);
  assert.deepEqual(resolveMigrationPath(1, 3, migrations.slice(1)), []);
});

function openDatabase(databasePath: string) {
  return openOrBootstrapDatabase({ databasePath, legacyDatabasePaths: [] });
}

function expectBootstrapError(callback: () => unknown, expectedCode: DatabaseBootstrapErrorCode): void {
  assert.throws(callback, (error: unknown) => error instanceof DatabaseBootstrapError && error.code === expectedCode);
}

function readPragma(database: DatabaseSync, pragma: string): unknown {
  const row = database.prepare(`PRAGMA ${pragma}`).get() as unknown as Record<string, unknown>;
  return Object.values(row)[0];
}

function readUserObjectCount(database: DatabaseSync): number {
  const row = database
    .prepare(
      "SELECT count(*) AS count FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND type IN ('table', 'index', 'trigger', 'view')",
    )
    .get() as unknown as { count: number };
  return row.count;
}

function snapshotDirectory(
  directory: string,
): Readonly<Record<string, Readonly<{ content: string; mtimeMs: number }>>> {
  return Object.fromEntries(
    fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const filePath = path.join(directory, entry.name);
        return [
          entry.name,
          {
            content: fs.readFileSync(filePath).toString("base64"),
            mtimeMs: fs.statSync(filePath).mtimeMs,
          },
        ];
      }),
  );
}

function spawnSqliteProcess(databasePath: string, operation: string) {
  const script = `
    import { DatabaseSync } from "node:sqlite";
    const database = new DatabaseSync(process.argv[1]);
    ${operation}
    process.exit(23);
  `;
  return spawnSync(process.execPath, ["--input-type=module", "--eval", script, databasePath], { encoding: "utf8" });
}

function spawnHotJournalRecoveryProcess(directory: string) {
  const bootstrapModuleUrl = new URL("../src/persistence-worker/sqlite-bootstrap.ts", import.meta.url).href;
  const script = `
    import fs from "node:fs";
    import path from "node:path";
    import { DatabaseSync } from "node:sqlite";
    import { openOrBootstrapDatabase } from ${JSON.stringify(bootstrapModuleUrl)};
    const directory = process.argv[1];
    const databasePath = path.join(directory, "runtime.sqlite3");
    const savedJournalPath = path.join(directory, "saved-journal");
    const database = new DatabaseSync(databasePath);
    database.exec("PRAGMA auto_vacuum = INCREMENTAL; PRAGMA application_id = ${APPLICATION_ID};");
    database.exec("BEGIN IMMEDIATE; CREATE TABLE transient (id INTEGER);");
    fs.copyFileSync(databasePath + "-journal", savedJournalPath);
    database.exec("ROLLBACK;");
    database.close();
    fs.copyFileSync(savedJournalPath, databasePath + "-journal");
    fs.rmSync(savedJournalPath);
    const result = openOrBootstrapDatabase({ databasePath, legacyDatabasePaths: [] });
    const row = result.database.prepare(
      "SELECT count(*) AS count FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND type = 'table'",
    ).get();
    result.database.close();
    console.log(JSON.stringify({ initialized: result.initialized, userObjectCount: row.count }));
  `;
  return spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script, directory], {
    encoding: "utf8",
  });
}

function withTempDirectory(callback: (directory: string) => void): void {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "withmate-sqlite-bootstrap-"));
  try {
    callback(directory);
  } finally {
    removeDirectoryWithRetry(directory);
  }
}

function removeDirectoryWithRetry(directory: string): void {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM" || attempt === 19) {
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}
