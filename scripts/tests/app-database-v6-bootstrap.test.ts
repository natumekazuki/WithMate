import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { createOrVerifyV6FreshDatabase } from "../../src-electron/app-database-v6-bootstrap.js";
import {
  APP_DATABASE_V6_FILENAME,
  APP_DATABASE_V6_SCHEMA_VERSION,
  isValidV6Database,
  readV6DatabaseUserVersion,
} from "../../src-electron/database-schema-v6.js";
import { APP_DATABASE_V4_FILENAME } from "../../src-electron/database-schema-v4.js";

describe("createOrVerifyV6FreshDatabase", () => {
  it("userData 配下に fresh V6 DB を作成し、V4 active path には触れない", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-v6-bootstrap-"));
    try {
      const result = createOrVerifyV6FreshDatabase(userDataPath);
      const v6Path = path.join(userDataPath, APP_DATABASE_V6_FILENAME);
      const v4Path = path.join(userDataPath, APP_DATABASE_V4_FILENAME);

      assert.deepEqual(result, { dbPath: v6Path, created: true });
      assert.equal(isValidV6Database(v6Path), true);
      assert.equal(readV6DatabaseUserVersion(v6Path), APP_DATABASE_V6_SCHEMA_VERSION);
      assert.equal(existsSync(v4Path), false);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("既存の valid V6 DB は再作成せず検証だけ行う", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-v6-bootstrap-"));
    try {
      const created = createOrVerifyV6FreshDatabase(userDataPath);
      const verified = createOrVerifyV6FreshDatabase(userDataPath);

      assert.equal(created.created, true);
      assert.deepEqual(verified, { dbPath: created.dbPath, created: false });
      assert.equal(isValidV6Database(created.dbPath), true);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("既存の invalid V6 DB は上書きしない", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-v6-bootstrap-"));
    try {
      const v6Path = path.join(userDataPath, APP_DATABASE_V6_FILENAME);
      await writeFile(v6Path, "not sqlite");

      assert.throws(
        () => createOrVerifyV6FreshDatabase(userDataPath),
        /does not match the V6 foundation schema/,
      );
      assert.equal(isValidV6Database(v6Path), false);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });
});
