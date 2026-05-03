import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { APP_DATABASE_V1_FILENAME } from "../../src-electron/database-schema-v1.js";
import { APP_DATABASE_V2_FILENAME, CREATE_V2_SCHEMA_SQL } from "../../src-electron/database-schema-v2.js";
import { APP_DATABASE_V3_FILENAME, CREATE_V3_SCHEMA_SQL } from "../../src-electron/database-schema-v3.js";
import { APP_DATABASE_V4_FILENAME, CREATE_V4_SCHEMA_SQL } from "../../src-electron/database-schema-v4.js";
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

function createV3Database(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    for (const statement of CREATE_V3_SCHEMA_SQL) {
      db.exec(statement);
    }
  } finally {
    db.close();
  }
}

function createV4Database(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    for (const statement of CREATE_V4_SCHEMA_SQL) {
      db.exec(statement);
    }
  } finally {
    db.close();
  }
}

describe("resolveAppDatabasePath", () => {
  it("有効な V4/V3/V2/V1 がある場合は withmate-v4.db を最優先する", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-app-db-path-"));

    try {
      const v1Path = path.join(userDataPath, APP_DATABASE_V1_FILENAME);
      const v2Path = path.join(userDataPath, APP_DATABASE_V2_FILENAME);
      const v3Path = path.join(userDataPath, APP_DATABASE_V3_FILENAME);
      const v4Path = path.join(userDataPath, APP_DATABASE_V4_FILENAME);
      await writeFile(v1Path, "");
      createV2Database(v2Path);
      createV3Database(v3Path);
      createV4Database(v4Path);

      const selectedPath = resolveAppDatabasePath(userDataPath);
      assert.equal(selectedPath, v4Path);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("有効な V3/V2/V1 がある場合は withmate-v3.db を最優先する", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-app-db-path-"));

    try {
      const v1Path = path.join(userDataPath, APP_DATABASE_V1_FILENAME);
      const v2Path = path.join(userDataPath, APP_DATABASE_V2_FILENAME);
      const v3Path = path.join(userDataPath, APP_DATABASE_V3_FILENAME);
      await writeFile(v1Path, "");
      createV2Database(v2Path);
      createV3Database(v3Path);

      const selectedPath = resolveAppDatabasePath(userDataPath);
      assert.equal(selectedPath, v3Path);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

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

  it("空の withmate-v3.db が V2 を shadow しない", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-app-db-path-"));

    try {
      const v2Path = path.join(userDataPath, APP_DATABASE_V2_FILENAME);
      const v3Path = path.join(userDataPath, APP_DATABASE_V3_FILENAME);
      createV2Database(v2Path);
      await writeFile(v3Path, "");

      const selectedPath = resolveAppDatabasePath(userDataPath);
      assert.equal(selectedPath, v2Path);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("空の withmate-v4.db が V3 を shadow しない", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-app-db-path-"));

    try {
      const v3Path = path.join(userDataPath, APP_DATABASE_V3_FILENAME);
      const v4Path = path.join(userDataPath, APP_DATABASE_V4_FILENAME);
      createV3Database(v3Path);
      await writeFile(v4Path, "");

      const selectedPath = resolveAppDatabasePath(userDataPath);
      assert.equal(selectedPath, v3Path);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("invalid な withmate-v3.db が V1 を shadow しない", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-app-db-path-"));

    try {
      const v1Path = path.join(userDataPath, APP_DATABASE_V1_FILENAME);
      const v3Path = path.join(userDataPath, APP_DATABASE_V3_FILENAME);
      await writeFile(v1Path, "");
      await writeFile(v3Path, "not sqlite");

      const selectedPath = resolveAppDatabasePath(userDataPath);
      assert.equal(selectedPath, v1Path);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });
});
