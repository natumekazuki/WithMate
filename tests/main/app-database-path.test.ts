import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { createOrVerifyV6FreshDatabase } from "../../src-electron/storage/app-database-v6-bootstrap.js";
import { APP_DATABASE_V1_FILENAME } from "../../src-electron/storage/database-schema-v1.js";
import {
  APP_DATABASE_V2_FILENAME,
  CREATE_V2_SCHEMA_SQL,
  isValidV2Database,
} from "../../src-electron/storage/database-schema-v2.js";
import {
  APP_DATABASE_V3_FILENAME,
  CREATE_V3_SCHEMA_SQL,
  isValidV3Database,
} from "../../src-electron/storage/database-schema-v3.js";
import {
  APP_DATABASE_V4_FILENAME,
  APP_DATABASE_V4_SCHEMA_VERSION,
  CREATE_V4_SCHEMA_SQL,
  isValidV4Database,
  readV4DatabaseUserVersion,
} from "../../src-electron/storage/database-schema-v4.js";
import {
  APP_DATABASE_V6_FILENAME,
  CREATE_V6_AUXILIARY_SESSIONS_TABLE_SQL,
  CREATE_V6_SCHEMA_SQL,
  CREATE_V6_SESSION_TURNS_TABLE_SQL,
  isValidV6Database,
} from "../../src-electron/storage/database-schema-v6.js";
import {
  resolveAppDatabasePath,
  resolveOrMigrateAppDatabasePath,
} from "../../src-electron/storage/app-database-path.js";
import { hasV4ToV6ReleaseDataMigrationMarker } from "../../src-electron/storage/migrations/migrate-database-v4-to-v6.js";

/** V2 の DDL を適用した候補ファイルを指定位置に作る。 */
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

/** バージョン番号を設定しなかった旧 V2 のテーブル構成を再現する。 */
function createLegacyV2DatabaseWithoutUserVersion(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    for (const statement of CREATE_V2_SCHEMA_SQL) {
      if (!statement.trim().startsWith("PRAGMA user_version")) {
        db.exec(statement);
      }
    }
  } finally {
    db.close();
  }
}

/** V3 の DDL を適用し、選択や移行に使える候補を作る。 */
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

/** テーブルは揃うが user_version が未設定だった旧 V3 を再現する。 */
function createLegacyV3DatabaseWithoutUserVersion(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    for (const statement of CREATE_V3_SCHEMA_SQL) {
      if (!statement.trim().startsWith("PRAGMA user_version")) {
        db.exec(statement);
      }
    }
  } finally {
    db.close();
  }
}

/** 起動判定に通る V4 の候補を指定位置へ用意する。 */
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

/** 旧形式の Auxiliary と未作成の Turn テーブルを持ち、修復後の保持を識別できる V6 を作る。 */
function createRepairableLegacyV6Database(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA foreign_keys = ON;");
    for (const statement of CREATE_V6_SCHEMA_SQL) {
      if (statement === CREATE_V6_SESSION_TURNS_TABLE_SQL) {
        continue;
      }
      if (statement === CREATE_V6_AUXILIARY_SESSIONS_TABLE_SQL) {
        db.exec(`
          CREATE TABLE IF NOT EXISTS auxiliary_sessions (
            id TEXT PRIMARY KEY,
            parent_session_id TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('active', 'closed')),
            updated_at TEXT NOT NULL,
            payload_json TEXT NOT NULL
          );

          CREATE INDEX IF NOT EXISTS idx_auxiliary_sessions_parent_updated
            ON auxiliary_sessions(parent_session_id, updated_at DESC);
        `);
        continue;
      }
      db.exec(statement);
    }
    db.exec("CREATE TABLE v6_only_sentinel (id TEXT PRIMARY KEY);");
    db.prepare("INSERT INTO v6_only_sentinel (id) VALUES (?)").run("keep-v6");
  } finally {
    db.close();
  }
}

/** セッションテーブルの名前をビューが占有し、通常の修復では使えない V6 を作る。 */
function createUnrepairableV6Database(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      PRAGMA user_version = 6;
      CREATE VIEW sessions_v6 AS SELECT 'invalid' AS id;
    `);
  } finally {
    db.close();
  }
}

/** 読み取り専用で開き、検査対象の名前が実テーブルとして存在するかを確認する。 */
function hasTable(dbPath: string, tableName: string): boolean {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?",
      )
      .get(tableName) as { name?: string } | undefined;
    return row?.name === tableName;
  } finally {
    db.close();
  }
}

/** 保存対象の設定キーが V6 の DB に残っているかを、書き込まずに確認する。 */
function hasV6Setting(dbPath: string, settingKey: string): boolean {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db
      .prepare("SELECT setting_key FROM app_settings WHERE setting_key = ?")
      .get(settingKey) as { setting_key?: string } | undefined;
    return row?.setting_key === settingKey;
  } finally {
    db.close();
  }
}

/** テーブルを作らず、検証に使う任意のスキーマバージョンだけを設定する。 */
function createV4DatabaseWithUserVersion(
  dbPath: string,
  userVersion: number,
): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`PRAGMA user_version = ${userVersion};`);
  } finally {
    db.close();
  }
}

/** パス解決だけを行うときの優先順位と、無効な候補の扱いを確認する。 */
describe("resolveAppDatabasePath", () => {
  /** 複数世代の有効な候補から V4 を選び、古いファイルへ戻らないことを確認する。 */
  it("有効な V4/V3/V2/V1 がある場合は withmate-v4.db を最優先する", async () => {
    const userDataPath = await mkdtemp(
      path.join(tmpdir(), "withmate-app-db-path-"),
    );

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

  /** V4 が未配置なら、V3 が V2 と V1 より先に選ばれる。 */
  it("有効な V3/V2/V1 がある場合は withmate-v3.db を最優先する", async () => {
    const userDataPath = await mkdtemp(
      path.join(tmpdir(), "withmate-app-db-path-"),
    );

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

  /** 有効な V2 の候補をそのまま利用する。 */
  it("有効な withmate-v2.db が存在すれば V2 を返す", async () => {
    const userDataPath = await mkdtemp(
      path.join(tmpdir(), "withmate-app-db-path-"),
    );

    try {
      const v2Path = path.join(userDataPath, APP_DATABASE_V2_FILENAME);
      createV2Database(v2Path);

      const selectedPath = resolveAppDatabasePath(userDataPath);
      assert.equal(selectedPath, v2Path);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  /** V2 が見つからない既存環境で V1 の保存先を認識する。 */
  it("withmate-v2.db が無い場合でも legacy withmate.db があれば返す", async () => {
    const userDataPath = await mkdtemp(
      path.join(tmpdir(), "withmate-app-db-path-"),
    );

    try {
      const v1Path = path.join(userDataPath, APP_DATABASE_V1_FILENAME);
      await writeFile(v1Path, "");

      const selectedPath = resolveAppDatabasePath(userDataPath);
      assert.equal(selectedPath, v1Path);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  /** 旧 V1 が残っていても、検証に通った V2 を優先する。 */
  it("有効な V2 と V1 が両方ある場合は withmate-v2.db を優先する", async () => {
    const userDataPath = await mkdtemp(
      path.join(tmpdir(), "withmate-app-db-path-"),
    );

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

  /** 初回起動では未作成でも現行 V6 のファイルパスを選ぶ。 */
  it("どの DB も無い場合は withmate-v6.db を返す（初回起動 canonical path）", async () => {
    const userDataPath = await mkdtemp(
      path.join(tmpdir(), "withmate-app-db-path-"),
    );

    try {
      const v6Path = path.join(userDataPath, APP_DATABASE_V6_FILENAME);
      const selectedPath = resolveAppDatabasePath(userDataPath);
      assert.equal(selectedPath, v6Path);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  /** 現行 V6 がすでに有効なら、そのファイルを実行時の保存先にする。 */
  it("有効な withmate-v6.db が存在すれば active runtime DB path selection は V6 を選ぶ", async () => {
    const userDataPath = await mkdtemp(
      path.join(tmpdir(), "withmate-app-db-path-"),
    );

    try {
      const v6Path = path.join(userDataPath, APP_DATABASE_V6_FILENAME);
      await createOrVerifyV6FreshDatabase(userDataPath);

      const selectedPath = resolveAppDatabasePath(userDataPath);
      assert.equal(selectedPath, v6Path);
      assert.equal(isValidV6Database(v6Path), true);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  /** 修復不能な V6 があっても、有効な V4 を候補にできることを確認する。 */
  it("V6 repair が失敗しても valid V4 があれば active path selection は V4 へ fallback する", async () => {
    const userDataPath = await mkdtemp(
      path.join(tmpdir(), "withmate-app-db-path-"),
    );

    try {
      const v4Path = path.join(userDataPath, APP_DATABASE_V4_FILENAME);
      const v6Path = path.join(userDataPath, APP_DATABASE_V6_FILENAME);
      createV4Database(v4Path);
      createUnrepairableV6Database(v6Path);

      const selectedPath = resolveAppDatabasePath(userDataPath);

      assert.equal(selectedPath, v4Path);
      assert.equal(isValidV4Database(v4Path), true);
      assert.equal(isValidV6Database(v6Path), false);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  /** 空の領域に対するパス解決は、移行も新規ファイル作成も行わない。 */
  it("どの DB も存在しない場合でも起動時 migration や DB 作成を呼び出さない", async () => {
    const userDataPath = await mkdtemp(
      path.join(tmpdir(), "withmate-app-db-path-"),
    );

    try {
      const v1Path = path.join(userDataPath, APP_DATABASE_V1_FILENAME);
      const v2Path = path.join(userDataPath, APP_DATABASE_V2_FILENAME);
      const v3Path = path.join(userDataPath, APP_DATABASE_V3_FILENAME);
      const v6Path = path.join(userDataPath, APP_DATABASE_V6_FILENAME);

      const selectedPath = resolveAppDatabasePath(userDataPath);
      assert.equal(selectedPath, v6Path);
      assert.equal(existsSync(v1Path), false);
      assert.equal(existsSync(v2Path), false);
      assert.equal(existsSync(v3Path), false);
      assert.equal(existsSync(v6Path), false);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  /** ファイル名だけが V2 と一致しても、空ファイルなら既存 V1 を隠さない。 */
  it("空の withmate-v2.db が V1 を shadow しない", async () => {
    const userDataPath = await mkdtemp(
      path.join(tmpdir(), "withmate-app-db-path-"),
    );

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

  /** 中身のない V3 候補より、検証に通る既存 V2 を優先する。 */
  it("空の withmate-v3.db が V2 を shadow しない", async () => {
    const userDataPath = await mkdtemp(
      path.join(tmpdir(), "withmate-app-db-path-"),
    );

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

  /** 中身のない V4 候補より、検証に通る既存 V3 を優先する。 */
  it("空の withmate-v4.db が V3 を shadow しない", async () => {
    const userDataPath = await mkdtemp(
      path.join(tmpdir(), "withmate-app-db-path-"),
    );

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

  /** バージョン番号が未設定でも、必要テーブルの揃った V3 を有効とみなす。 */
  it("user_version=0 の既存 V3 DB は required tables が揃っていれば有効扱いにする", async () => {
    const userDataPath = await mkdtemp(
      path.join(tmpdir(), "withmate-app-db-path-"),
    );

    try {
      const v3Path = path.join(userDataPath, APP_DATABASE_V3_FILENAME);
      createLegacyV3DatabaseWithoutUserVersion(v3Path);

      assert.equal(isValidV3Database(v3Path), true);
      const selectedPath = resolveAppDatabasePath(userDataPath);
      assert.equal(selectedPath, v3Path);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  /** 旧 V2 の user_version が未設定でも、スキーマ構成から V2 と判断する。 */
  it("user_version=0 の既存 V2 DB は required tables が揃っていれば有効扱いにする", async () => {
    const userDataPath = await mkdtemp(
      path.join(tmpdir(), "withmate-app-db-path-"),
    );

    try {
      const v2Path = path.join(userDataPath, APP_DATABASE_V2_FILENAME);
      createLegacyV2DatabaseWithoutUserVersion(v2Path);

      assert.equal(isValidV2Database(v2Path), true);
      const selectedPath = resolveAppDatabasePath(userDataPath);
      assert.equal(selectedPath, v2Path);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  /** 構造が無効な V3 のファイル名があっても、既存 V1 を選択できることを確認する。 */
  it("invalid な withmate-v3.db が V1 を shadow しない", async () => {
    const userDataPath = await mkdtemp(
      path.join(tmpdir(), "withmate-app-db-path-"),
    );

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

/** 起動時に実際の保存先を準備する処理の移行・修復・保護条件を確認する。 */
describe("resolveOrMigrateAppDatabasePath", () => {
  // @test-value v2
  // kind = "contract"
  // claim = "有効な withmate-v4.db は元DBを有効なまま保持してV6へ移行しV6 pathを返す"
  // oracle = { type = "contract", ref = "docs/design/database-schema.md#起動時の移行とデータ保護" }
  // fault = "有効なV4を移行せず旧pathを返す、無効なV6を返す、または移行元V4のschemaを無効にする"
  // observable = "V6 path selection and V4/V6 validity"
  // observation_boundary = "public-boundary"
  // scope = "resolveOrMigrateAppDatabasePath valid V4"
  // lifecycle = "permanent"
  // @end-test-value
  /** 有効な V4 を移行しても、移行元を残したまま有効な V6 で起動できる。 */
  it("有効な withmate-v4.db が存在する場合は V6 へ移行して V6 を返す", async () => {
    const userDataPath = await mkdtemp(
      path.join(tmpdir(), "withmate-app-db-migrate-"),
    );

    try {
      const v4Path = path.join(userDataPath, APP_DATABASE_V4_FILENAME);
      createV4Database(v4Path);

      const selectedPath = await resolveOrMigrateAppDatabasePath(userDataPath);
      const v6Path = path.join(userDataPath, APP_DATABASE_V6_FILENAME);
      assert.equal(selectedPath, v6Path);
      assert.equal(isValidV4Database(v4Path), true);
      assert.equal(isValidV6Database(v6Path), true);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  /** 既に有効な V6 がある起動時は、同じ保存先を使う。 */
  it("V6 DB は起動時 migration target として選ばれる", async () => {
    const userDataPath = await mkdtemp(
      path.join(tmpdir(), "withmate-app-db-migrate-"),
    );

    try {
      const v6Path = path.join(userDataPath, APP_DATABASE_V6_FILENAME);
      await createOrVerifyV6FreshDatabase(userDataPath);

      const selectedPath = await resolveOrMigrateAppDatabasePath(userDataPath);
      assert.equal(selectedPath, v6Path);
      assert.equal(isValidV6Database(v6Path), true);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  /** 廃止された Memory テーブルだけが残る場合は、既存 V6 を使いながらそのテーブルを取り除く。 */
  it("既存 V6 DB に legacy Memory table だけが残っている場合は起動時に cleanup する", async () => {
    const userDataPath = await mkdtemp(
      path.join(tmpdir(), "withmate-app-db-migrate-"),
    );

    try {
      const v6Path = path.join(userDataPath, APP_DATABASE_V6_FILENAME);
      await createOrVerifyV6FreshDatabase(userDataPath);
      const db = new DatabaseSync(v6Path);
      try {
        db.exec("CREATE TABLE project_memory_entries (id TEXT PRIMARY KEY);");
        db.prepare("INSERT INTO project_memory_entries (id) VALUES (?)").run(
          "legacy-memory-1",
        );
      } finally {
        db.close();
      }

      const selectedPath = await resolveOrMigrateAppDatabasePath(userDataPath);

      assert.equal(selectedPath, v6Path);
      assert.equal(isValidV6Database(v6Path), true);
      assert.equal(hasTable(v6Path, "project_memory_entries"), false);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  /** 修復できる V6 を優先し、V6 固有の行が V4 の再移行で失われないことを確認する。 */
  it("旧 V6 DB と valid V4 が併存する場合は V6 を repair して overwrite migration しない", async () => {
    const userDataPath = await mkdtemp(
      path.join(tmpdir(), "withmate-app-db-migrate-"),
    );

    try {
      const v4Path = path.join(userDataPath, APP_DATABASE_V4_FILENAME);
      createV4Database(v4Path);
      const v6Path = path.join(userDataPath, APP_DATABASE_V6_FILENAME);
      createRepairableLegacyV6Database(v6Path);

      assert.equal(isValidV6Database(v6Path), false);
      const selectedPath = await resolveOrMigrateAppDatabasePath(userDataPath);

      assert.equal(selectedPath, v6Path);
      assert.equal(isValidV6Database(v6Path), true);
      assert.equal(hasTable(v6Path, "v6_only_sentinel"), true);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  /** V6 を修復できなければ有効な V4 から V6 を再構成し、V4 は保持する。 */
  it("V6 repair が失敗しても valid V4 があれば V4 から V6 へ移行する", async () => {
    const userDataPath = await mkdtemp(
      path.join(tmpdir(), "withmate-app-db-migrate-"),
    );

    try {
      const v4Path = path.join(userDataPath, APP_DATABASE_V4_FILENAME);
      createV4Database(v4Path);
      const v6Path = path.join(userDataPath, APP_DATABASE_V6_FILENAME);
      createUnrepairableV6Database(v6Path);

      const selectedPath = await resolveOrMigrateAppDatabasePath(userDataPath);

      assert.equal(selectedPath, v6Path);
      assert.equal(isValidV4Database(v4Path), true);
      assert.equal(isValidV6Database(v6Path), true);
      assert.equal(hasTable(v6Path, "v6_only_sentinel"), false);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  // @test-value v2
  // kind = "contract"
  // claim = "release data migration marker済みのV6 DBとV4 DBが併存しても、2回目の解決は再移行せずV6を返す"
  // oracle = { type = "contract", ref = "docs/design/v6-database-foundation.md: v4_to_v6_release_data_migrated_atと再copy・migration progress非実行" }
  // fault = "既存markerを無視してV4を再移行し、保存済みデータを重複処理または上書きする"
  // observable = "2回の選択pathと各回のmigration progress title、およびrelease marker"
  // observation_boundary = "public-boundary"
  // scope = "release data migration marker idempotence"
  // lifecycle = "permanent"
  // impact = "既存データの再移行による重複処理や上書きが起きる"
  // distinction = "同じ管理DBを2回解決し、2回目のprogressにmigrationが含まれないことを直接確認する"
  // @end-test-value
  /** 初回移行で完了マーカーを記録し、次回起動に移行の進捗を出さないことを確認する。 */
  it("V6 DB と V4 DB が併存しても release data migration marker 済みなら再移行しない", async () => {
    const userDataPath = await mkdtemp(
      path.join(tmpdir(), "withmate-app-db-migrate-"),
    );

    try {
      const v4Path = path.join(userDataPath, APP_DATABASE_V4_FILENAME);
      createV4Database(v4Path);
      const v6Path = path.join(userDataPath, APP_DATABASE_V6_FILENAME);

      const firstProgress: string[] = [];
      const firstSelectedPath = await resolveOrMigrateAppDatabasePath(
        userDataPath,
        (progress) => {
          firstProgress.push(progress.title);
        },
      );
      assert.equal(firstSelectedPath, v6Path);
      assert.equal(hasV4ToV6ReleaseDataMigrationMarker(v6Path), true);
      assert.equal(firstProgress.includes("Migrating saved data"), true);

      const secondProgress: string[] = [];
      const secondSelectedPath = await resolveOrMigrateAppDatabasePath(
        userDataPath,
        (progress) => {
          secondProgress.push(progress.title);
        },
      );
      assert.equal(secondSelectedPath, v6Path);
      assert.equal(secondProgress.includes("Migrating saved data"), false);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "SQLiteとして読めないV4のcleanup失敗を明示して起動を拒否し、既存のV3/V4を残してV6を生成しない"
  // oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/729: cleanup未完了を明示し成功扱いしない・非Companionデータの保全" }
  // fault = "cleanup失敗を握り潰して起動を継続するか、既存DBを削除・上書きする"
  // observable = "rejection, V3/V4 existence and validity, no V6 creation"
  // observation_boundary = "public-boundary"
  // scope = "startup cleanup failure and source database preservation"
  // lifecycle = "permanent"
  // @end-test-value
  /** SQLite として開けない V4 の片付けに失敗したら既存 DB を保持し、V6 を作らない。 */
  it("SQLiteとして読めないV4のcleanup失敗は既存DBを残して起動を拒否する", async () => {
    const userDataPath = await mkdtemp(
      path.join(tmpdir(), "withmate-app-db-migrate-"),
    );

    try {
      const v3Path = path.join(userDataPath, APP_DATABASE_V3_FILENAME);
      const v4Path = path.join(userDataPath, APP_DATABASE_V4_FILENAME);
      createV3Database(v3Path);
      await writeFile(v4Path, "not sqlite");

      await assert.rejects(
        () => resolveOrMigrateAppDatabasePath(userDataPath),
        /Companion data removal is incomplete/,
      );
      assert.equal(existsSync(v3Path), true);
      assert.equal(isValidV3Database(v3Path), true);
      assert.equal(existsSync(v4Path), true);
      assert.equal(isValidV4Database(v4Path), false);
      assert.equal(
        existsSync(path.join(userDataPath, APP_DATABASE_V6_FILENAME)),
        false,
      );
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  /** バージョン番号だけが正しい不完全な V4 で、有効な V3 からの移行を妨げない。 */
  it("user_version=4 でも required tables が欠けた withmate-v4.db は有効な V3 を shadow しない", async () => {
    const userDataPath = await mkdtemp(
      path.join(tmpdir(), "withmate-app-db-migrate-"),
    );

    try {
      const v3Path = path.join(userDataPath, APP_DATABASE_V3_FILENAME);
      const v4Path = path.join(userDataPath, APP_DATABASE_V4_FILENAME);
      createV3Database(v3Path);
      createV4DatabaseWithUserVersion(v4Path, APP_DATABASE_V4_SCHEMA_VERSION);

      assert.equal(isValidV4Database(v4Path), false);
      const selectedPath = await resolveOrMigrateAppDatabasePath(userDataPath);
      const v6Path = path.join(userDataPath, APP_DATABASE_V6_FILENAME);
      assert.equal(selectedPath, v6Path);
      assert.equal(isValidV4Database(v4Path), true);
      assert.equal(isValidV6Database(v6Path), true);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "対応外の新しいV4 DBはunsupported newer versionとして拒否され、内容を維持する"
  // oracle = { type = "contract", ref = "docs/design/database-schema.md#起動時の移行とデータ保護" }
  // fault = "新しいDBをlegacy migrationで上書きするか、日本語旧エラーを期待して契約を見失う"
  // observable = "English rejection, user_version, V4 validity"
  // observation_boundary = "public-boundary"
  // scope = "newer managed database version"
  // lifecycle = "permanent"
  // @end-test-value
  /** アプリが対応しない新しい V4 は拒否し、バージョン番号を変更しない。 */
  it("対応外の新しい withmate-v4.db は legacy migration で上書きしない", async () => {
    const userDataPath = await mkdtemp(
      path.join(tmpdir(), "withmate-app-db-migrate-"),
    );

    try {
      const v3Path = path.join(userDataPath, APP_DATABASE_V3_FILENAME);
      const v4Path = path.join(userDataPath, APP_DATABASE_V4_FILENAME);
      const newerVersion = APP_DATABASE_V4_SCHEMA_VERSION + 1;
      createV3Database(v3Path);
      createV4DatabaseWithUserVersion(v4Path, newerVersion);

      await assert.rejects(
        () => resolveOrMigrateAppDatabasePath(userDataPath),
        /unsupported newer version/,
      );
      assert.equal(readV4DatabaseUserVersion(v4Path), newerVersion);
      assert.equal(isValidV4Database(v4Path), false);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  /** 既存 V3 を残し、同じユーザーデータ領域に有効な V4 と V6 を用意する。 */
  it("withmate-v4.db が無く V3 がある場合は同じ userData 内に V4 を作成し、V3 を残す", async () => {
    const userDataPath = await mkdtemp(
      path.join(tmpdir(), "withmate-app-db-migrate-"),
    );

    try {
      const v3Path = path.join(userDataPath, APP_DATABASE_V3_FILENAME);
      const v4Path = path.join(userDataPath, APP_DATABASE_V4_FILENAME);
      createV3Database(v3Path);

      const selectedPath = await resolveOrMigrateAppDatabasePath(userDataPath);
      const v6Path = path.join(userDataPath, APP_DATABASE_V6_FILENAME);
      assert.equal(selectedPath, v6Path);
      assert.equal(existsSync(v3Path), true);
      assert.equal(isValidV4Database(v4Path), true);
      assert.equal(isValidV6Database(v6Path), true);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  /** バージョン番号がない旧 V3 からでも、有効な V4 と V6 を準備する。 */
  it("user_version=0 の既存 V3 DB から V4 へ自動移行する", async () => {
    const userDataPath = await mkdtemp(
      path.join(tmpdir(), "withmate-app-db-migrate-"),
    );

    try {
      const v3Path = path.join(userDataPath, APP_DATABASE_V3_FILENAME);
      const v4Path = path.join(userDataPath, APP_DATABASE_V4_FILENAME);
      createLegacyV3DatabaseWithoutUserVersion(v3Path);

      const selectedPath = await resolveOrMigrateAppDatabasePath(userDataPath);
      const v6Path = path.join(userDataPath, APP_DATABASE_V6_FILENAME);
      assert.equal(selectedPath, v6Path);
      assert.equal(isValidV4Database(v4Path), true);
      assert.equal(isValidV6Database(v6Path), true);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  /** V2 だけがある環境では移行元を保持して V3 と V4 を経由し、V6 を有効にする。 */
  it("V2 しか無い場合は V2 を残したまま V3 経由で V4 を作成する", async () => {
    const userDataPath = await mkdtemp(
      path.join(tmpdir(), "withmate-app-db-migrate-"),
    );

    try {
      const v2Path = path.join(userDataPath, APP_DATABASE_V2_FILENAME);
      const v3Path = path.join(userDataPath, APP_DATABASE_V3_FILENAME);
      const v4Path = path.join(userDataPath, APP_DATABASE_V4_FILENAME);
      createV2Database(v2Path);

      const selectedPath = await resolveOrMigrateAppDatabasePath(userDataPath);
      const v6Path = path.join(userDataPath, APP_DATABASE_V6_FILENAME);
      assert.equal(selectedPath, v6Path);
      assert.equal(existsSync(v2Path), true);
      assert.equal(existsSync(v3Path), true);
      assert.equal(isValidV4Database(v4Path), true);
      assert.equal(isValidV6Database(v6Path), true);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  /** バージョン番号のない旧 V2 でも、元のファイルを残して V6 まで更新する。 */
  it("user_version=0 の既存 V2 DB から V4 へ自動移行する", async () => {
    const userDataPath = await mkdtemp(
      path.join(tmpdir(), "withmate-app-db-migrate-"),
    );

    try {
      const v2Path = path.join(userDataPath, APP_DATABASE_V2_FILENAME);
      const v3Path = path.join(userDataPath, APP_DATABASE_V3_FILENAME);
      const v4Path = path.join(userDataPath, APP_DATABASE_V4_FILENAME);
      createLegacyV2DatabaseWithoutUserVersion(v2Path);

      const selectedPath = await resolveOrMigrateAppDatabasePath(userDataPath);
      const v6Path = path.join(userDataPath, APP_DATABASE_V6_FILENAME);
      assert.equal(selectedPath, v6Path);
      assert.equal(existsSync(v2Path), true);
      assert.equal(existsSync(v3Path), true);
      assert.equal(isValidV4Database(v4Path), true);
      assert.equal(isValidV6Database(v6Path), true);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  /** 最も古い V1 だけがある場合も、中間世代の保存先を用意して V6 を選ぶ。 */
  it("V1 しか無い場合は V1 を残したまま V2/V3 経由で V4 を作成する", async () => {
    const userDataPath = await mkdtemp(
      path.join(tmpdir(), "withmate-app-db-migrate-"),
    );

    try {
      const v1Path = path.join(userDataPath, APP_DATABASE_V1_FILENAME);
      const v2Path = path.join(userDataPath, APP_DATABASE_V2_FILENAME);
      const v3Path = path.join(userDataPath, APP_DATABASE_V3_FILENAME);
      const v4Path = path.join(userDataPath, APP_DATABASE_V4_FILENAME);
      await writeFile(v1Path, "");

      const selectedPath = await resolveOrMigrateAppDatabasePath(userDataPath);
      const v6Path = path.join(userDataPath, APP_DATABASE_V6_FILENAME);
      assert.equal(selectedPath, v6Path);
      assert.equal(existsSync(v1Path), true);
      assert.equal(existsSync(v2Path), true);
      assert.equal(existsSync(v3Path), true);
      assert.equal(isValidV4Database(v4Path), true);
      assert.equal(isValidV6Database(v6Path), true);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });
});
