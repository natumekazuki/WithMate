import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { createOrVerifyV6FreshDatabase } from "../../src-electron/storage/app-database-v6-bootstrap.js";
import { inspectAppDatabase } from "../../src-electron/storage/app-database-diagnostics.js";
import {
  APP_DATABASE_V3_FILENAME,
  CREATE_V3_SCHEMA_SQL,
} from "../../src-electron/storage/database-schema-v3.js";
import {
  APP_DATABASE_V4_FILENAME,
  APP_DATABASE_V4_SCHEMA_VERSION,
  CREATE_V4_SCHEMA_SQL,
} from "../../src-electron/storage/database-schema-v4.js";
import {
  APP_DATABASE_V6_FILENAME,
  APP_DATABASE_V6_SCHEMA_VERSION,
} from "../../src-electron/storage/database-schema-v6.js";

/** 指定のスキーマで診断用DBを用意し、診断前に接続を閉じる。 */
function createDatabase(dbPath: string, statements: readonly string[]): void {
  const db = new DatabaseSync(dbPath);
  try {
    for (const statement of statements) {
      db.exec(statement);
    }
  } finally {
    db.close();
  }
}

/** 実ファイルの有無・スキーマ・世代の併存が診断にどう反映されるかを検証する。 */
describe("inspectAppDatabase", () => {
  /** 新規インストールの未作成V4を、異常や単なる欠落ではなく作成待ちとして扱う。 */
  it("fresh install の canonical V4 path は pending-create として診断する", async () => {
    const userDataPath = await mkdtemp(
      path.join(tmpdir(), "withmate-app-db-diagnostics-"),
    );
    try {
      const activeDatabasePath = path.join(
        userDataPath,
        APP_DATABASE_V4_FILENAME,
      );

      const diagnostics = inspectAppDatabase(
        userDataPath,
        activeDatabasePath,
        true,
      );

      assert.equal(diagnostics.userDataPath, userDataPath);
      assert.equal(diagnostics.userDataPathOverrideApplied, true);
      assert.equal(diagnostics.activeDatabasePath, activeDatabasePath);
      assert.equal(diagnostics.activeFileName, APP_DATABASE_V4_FILENAME);
      assert.equal(diagnostics.compatibilityMode, "v4");
      assert.equal(diagnostics.schemaVersion, APP_DATABASE_V4_SCHEMA_VERSION);
      assert.equal(diagnostics.userVersion, null);
      assert.equal(diagnostics.schemaValid, true);
      assert.equal(diagnostics.runtimeCompatible, true);
      assert.equal(diagnostics.exists, false);
      assert.equal(diagnostics.valid, true);
      assert.equal(
        diagnostics.files.find(
          (file) => file.fileName === APP_DATABASE_V6_FILENAME,
        )?.status,
        "missing",
      );
      assert.equal(
        diagnostics.files.find(
          (file) => file.fileName === APP_DATABASE_V4_FILENAME,
        )?.status,
        "pending-create",
      );
      assert.deepEqual(diagnostics.warnings, []);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  /** 作成済みV4では期待スキーマとSQLiteに記録された版の両方を返す。 */
  it("有効な V4 DB は user_version と schemaVersion を返す", async () => {
    const userDataPath = await mkdtemp(
      path.join(tmpdir(), "withmate-app-db-diagnostics-"),
    );
    try {
      const activeDatabasePath = path.join(
        userDataPath,
        APP_DATABASE_V4_FILENAME,
      );
      createDatabase(activeDatabasePath, CREATE_V4_SCHEMA_SQL);

      const diagnostics = inspectAppDatabase(
        userDataPath,
        activeDatabasePath,
        false,
      );

      assert.equal(diagnostics.compatibilityMode, "v4");
      assert.equal(diagnostics.schemaVersion, APP_DATABASE_V4_SCHEMA_VERSION);
      assert.equal(diagnostics.userVersion, APP_DATABASE_V4_SCHEMA_VERSION);
      assert.equal(diagnostics.schemaValid, true);
      assert.equal(diagnostics.runtimeCompatible, true);
      assert.equal(diagnostics.exists, true);
      assert.equal(diagnostics.valid, true);
      assert.deepEqual(diagnostics.warnings, []);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  /** V3で動作中でも、併存する空のV4ファイルを別途異常として報告する。 */
  it("上位世代 DB が壊れていて legacy V3 を開く場合は mixed generation warning を返す", async () => {
    const userDataPath = await mkdtemp(
      path.join(tmpdir(), "withmate-app-db-diagnostics-"),
    );
    try {
      const v3Path = path.join(userDataPath, APP_DATABASE_V3_FILENAME);
      const v4Path = path.join(userDataPath, APP_DATABASE_V4_FILENAME);
      createDatabase(v3Path, CREATE_V3_SCHEMA_SQL);
      await writeFile(v4Path, "");

      const diagnostics = inspectAppDatabase(userDataPath, v3Path, false);

      assert.equal(diagnostics.compatibilityMode, "legacy-v3");
      assert.equal(diagnostics.schemaVersion, 3);
      assert.equal(
        diagnostics.files.find(
          (file) => file.fileName === APP_DATABASE_V4_FILENAME,
        )?.status,
        "invalid",
      );
      assert.equal(
        diagnostics.warnings.includes(
          "withmate-v4.db exists but does not match its expected schema.",
        ),
        true,
      );
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  /** V3とV4がともに有効なとき、稼働世代をV4としたまま併存を警告する。 */
  it("複数の有効な DB 世代がある場合は警告する", async () => {
    const userDataPath = await mkdtemp(
      path.join(tmpdir(), "withmate-app-db-diagnostics-"),
    );
    try {
      const v3Path = path.join(userDataPath, APP_DATABASE_V3_FILENAME);
      const v4Path = path.join(userDataPath, APP_DATABASE_V4_FILENAME);
      createDatabase(v3Path, CREATE_V3_SCHEMA_SQL);
      createDatabase(v4Path, CREATE_V4_SCHEMA_SQL);

      const diagnostics = inspectAppDatabase(userDataPath, v4Path, false);

      assert.equal(diagnostics.compatibilityMode, "v4");
      assert.equal(
        diagnostics.warnings.includes(
          "Multiple valid app database generations exist: withmate-v4.db, withmate-v3.db.",
        ),
        true,
      );
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  /** 稼働中のV4とは別に、初期化済みV6を使用可能なDBとして列挙する。 */
  it("V6 DB は既知 runtime file として診断する", async () => {
    const userDataPath = await mkdtemp(
      path.join(tmpdir(), "withmate-app-db-diagnostics-"),
    );
    try {
      const activeDatabasePath = path.join(
        userDataPath,
        APP_DATABASE_V4_FILENAME,
      );
      createDatabase(activeDatabasePath, CREATE_V4_SCHEMA_SQL);
      await createOrVerifyV6FreshDatabase(userDataPath);

      const diagnostics = inspectAppDatabase(
        userDataPath,
        activeDatabasePath,
        false,
      );
      const v6File = diagnostics.files.find(
        (file) => file.fileName === APP_DATABASE_V6_FILENAME,
      );

      assert.equal(diagnostics.compatibilityMode, "v4");
      assert.equal(diagnostics.schemaVersion, APP_DATABASE_V4_SCHEMA_VERSION);
      assert.equal(
        v6File?.expectedSchemaVersion,
        APP_DATABASE_V6_SCHEMA_VERSION,
      );
      assert.equal(v6File?.userVersion, APP_DATABASE_V6_SCHEMA_VERSION);
      assert.equal(v6File?.role, "runtime");
      assert.equal(v6File?.schemaValid, true);
      assert.equal(v6File?.runtimeEligible, true);
      assert.equal(v6File?.valid, true);
      assert.equal(v6File?.status, "ready");
      assert.equal(
        diagnostics.warnings.includes(
          "Multiple valid app database generations exist: withmate-v6.db, withmate-v4.db.",
        ),
        true,
      );
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  /** V6が稼働DBに指定されたときは、診断全体の互換モードと版もV6になる。 */
  it("activeDatabasePath に V6 DB を渡した場合は v6 として診断する", async () => {
    const userDataPath = await mkdtemp(
      path.join(tmpdir(), "withmate-app-db-diagnostics-"),
    );
    try {
      const { dbPath } = await createOrVerifyV6FreshDatabase(userDataPath);

      const diagnostics = inspectAppDatabase(userDataPath, dbPath, false);

      assert.equal(diagnostics.activeFileName, APP_DATABASE_V6_FILENAME);
      assert.equal(diagnostics.compatibilityMode, "v6");
      assert.equal(diagnostics.schemaVersion, APP_DATABASE_V6_SCHEMA_VERSION);
      assert.equal(diagnostics.userVersion, APP_DATABASE_V6_SCHEMA_VERSION);
      assert.equal(diagnostics.schemaValid, true);
      assert.equal(diagnostics.runtimeCompatible, true);
      assert.equal(diagnostics.exists, true);
      assert.equal(diagnostics.valid, true);
      assert.deepEqual(diagnostics.warnings, []);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });
});
