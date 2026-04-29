import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { APP_DATABASE_V1_FILENAME } from "../../src-electron/database-schema-v1.js";
import { APP_DATABASE_V2_FILENAME, CREATE_V2_SCHEMA_SQL } from "../../src-electron/database-schema-v2.js";
import { resolveAppDatabasePath } from "../../src-electron/app-database-path.js";

function createV2Database(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    for (const statement of CREATE_V2_SCHEMA_SQL) {
      db.exec(statement);
    }
  } finally {
    db.close();
  }
}

describe("resolveAppDatabasePath", () => {
  it("有効な withmate-v2.db が存在すれば V2 を返す", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-app-db-path-"));

    try {
      const v2Path = path.join(userDataPath, APP_DATABASE_V2_FILENAME);
      createV2Database(v2Path);

      const selectedPath = resolveAppDatabasePath(userDataPath);
      assert.equal(selectedPath, v2Path);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("withmate-v2.db が無い場合は withmate.db を返す", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-app-db-path-"));

    try {
      const v1Path = path.join(userDataPath, APP_DATABASE_V1_FILENAME);
      await writeFile(v1Path, "");

      const selectedPath = resolveAppDatabasePath(userDataPath);
      assert.equal(selectedPath, v1Path);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("有効な V2 と V1 が両方ある場合は withmate-v2.db を優先する", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-app-db-path-"));

    try {
      const v1Path = path.join(userDataPath, APP_DATABASE_V1_FILENAME);
      const v2Path = path.join(userDataPath, APP_DATABASE_V2_FILENAME);
      await writeFile(v1Path, "");
      createV2Database(v2Path);

      const selectedPath = resolveAppDatabasePath(userDataPath);
      assert.equal(selectedPath, v2Path);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("どちらの DB も無い場合は withmate.db を返す（初回起動フォールバック）", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-app-db-path-"));

    try {
      const v1Path = path.join(userDataPath, APP_DATABASE_V1_FILENAME);
      const selectedPath = resolveAppDatabasePath(userDataPath);
      assert.equal(selectedPath, v1Path);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("どちらも存在しない場合でも起動時 migration を呼び出さない", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-app-db-path-"));

    try {
      const v1Path = path.join(userDataPath, APP_DATABASE_V1_FILENAME);
      const v2Path = path.join(userDataPath, APP_DATABASE_V2_FILENAME);

      const selectedPath = resolveAppDatabasePath(userDataPath);
      assert.equal(selectedPath, v1Path);
      assert.equal(existsSync(v1Path), false);
      assert.equal(existsSync(v2Path), false);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("空の withmate-v2.db が V1 を shadow しない", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-app-db-path-"));

    try {
      const v1Path = path.join(userDataPath, APP_DATABASE_V1_FILENAME);
      const v2Path = path.join(userDataPath, APP_DATABASE_V2_FILENAME);
      await writeFile(v1Path, "");
      await writeFile(v2Path, "");

      const selectedPath = resolveAppDatabasePath(userDataPath);
      assert.equal(selectedPath, v1Path);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });
});
