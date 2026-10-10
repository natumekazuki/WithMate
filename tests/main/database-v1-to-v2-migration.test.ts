import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import {
  CREATE_APP_SETTINGS_TABLE_SQL,
  CREATE_CHARACTER_MEMORY_TABLES_SQL,
  CREATE_MODEL_CATALOG_TABLES_SQL,
  CREATE_PROJECT_MEMORY_TABLES_SQL,
  CREATE_SESSION_MEMORIES_TABLE_SQL,
  CREATE_SESSIONS_TABLE_SQL,
} from "../../src-electron/storage/database-schema-v1.js";
import { CREATE_V2_SCHEMA_SQL } from "../../src-electron/storage/database-schema-v2.js";
import { PersistentStoreLifecycleService, type PersistentStoreBundle } from "../../src-electron/storage/persistent-store-lifecycle-service.js";
import { SessionStorageV2 } from "../../src-electron/session/session-storage-v2.js";
import { hydrateSessionsFromSummaries } from "../../src-electron/session/session-summary-adapter.js";
import { createMigrationDryRunReport, createMigrationWriteReport } from "../../src-electron/storage/migrations/migrate-database-v1-to-v2.js";

function createV1FixtureDatabase(): { dbPath: string; dirPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "withmate-v1-to-v2-"));
  const dbPath = join(dir, "withmate.db");
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec(CREATE_APP_SETTINGS_TABLE_SQL);
    db.exec(CREATE_SESSIONS_TABLE_SQL);
    db.exec(CREATE_MODEL_CATALOG_TABLES_SQL);
    db.exec(CREATE_SESSION_MEMORIES_TABLE_SQL);
    db.exec(CREATE_PROJECT_MEMORY_TABLES_SQL);
    db.exec(CREATE_CHARACTER_MEMORY_TABLES_SQL);
  } finally {
    db.close();
  }
  return {
    dbPath,
    dirPath: dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function tableExists(db: DatabaseSync, tableName: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?").get(tableName);
  return row !== undefined;
}

function countRows(db: DatabaseSync, tableName: string): number {
  if (!tableExists(db, tableName)) {
    return 0;
  }
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get() as { count: number };
  return row.count;
}

function countRowsBySessionId(db: DatabaseSync, tableName: string, sessionId: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${tableName} WHERE session_id = ?`).get(sessionId) as { count: number };
  return row.count;
}

function insertSession(db: DatabaseSync, input: {
  id: string;
  messagesJson: string;
  streamJson: string;
}): void {
  db.prepare(`
    INSERT INTO sessions (
      id,
      task_title,
      status,
      updated_at,
      provider,
      catalog_revision,
      workspace_label,
      workspace_path,
      branch,
      session_kind,
      character_id,
      character_name,
      character_icon_path,
      character_theme_main,
      character_theme_sub,
      run_state,
      approval_mode,
      codex_sandbox_mode,
      model,
      reasoning_effort,
      custom_agent_name,
      allowed_additional_directories_json,
      thread_id,
      messages_json,
      stream_json,
      last_active_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    "task",
    "idle",
    "2026-04-27T00:00:00.000Z",
    "codex",
    1,
    "workspace",
    "workspace",
    "main",
    "default",
    "character",
    "Character",
    "",
    "#6f8cff",
    "#6fb8c7",
    "idle",
    "never",
    "workspace-write",
    "gpt-5.4-mini",
    "medium",
    "",
    "[]",
    "thread",
    input.messagesJson,
    input.streamJson,
    1,
  );
}

describe("V1 to V2 database migration dry-run", () => {
  // @test-value v2
  // kind = "contract"
  // claim = "V1 DB を変更せず V2 変換予定件数と skip 件数を report する"
  // oracle = { type = "contract", ref = "docs/design/database-schema.md#起動時の移行とデータ保護" }
  // fault = "通常messages/artifactsの予定件数が誤るかdry-runがsource行を書き換える"
  // observable = "dry-run counts、skip件数、source保存行数"
  // observation_boundary = "public-boundary"
  // scope = "main/database-v1-to-v2-migration"
  // lifecycle = "permanent"
  // impact = "既存の通常会話・artifactの継続利用または移行先データ保護を損なう"
  // distinction = "型検査だけではSQLite移行後の実データとsource保持を検証できない"
  // @end-test-value
  it("V1 DB を変更せず V2 変換予定件数と skip 件数を report する", () => {
    const fixture = createV1FixtureDatabase();
    try {
      const db = new DatabaseSync(fixture.dbPath);
      try {
        insertSession(db, {
          id: "session-1",
          messagesJson: JSON.stringify([
            { role: "user", text: "hello" },
            { role: "assistant", text: "done", artifact: { title: "result", changedFiles: [] } },
          ]),
          streamJson: JSON.stringify([{ mood: "calm", time: "10:00", text: "legacy monologue" }]),
        });
        db.prepare("INSERT INTO app_settings (setting_key, setting_value, updated_at) VALUES (?, ?, ?)").run(
          "system_prompt_prefix",
          "prefix",
          "2026-04-27T00:00:00.000Z",
        );
        db.prepare("INSERT INTO app_settings (setting_key, setting_value, updated_at) VALUES (?, ?, ?)").run(
          "memory_extraction_provider_settings_json",
          "{}",
          "2026-04-27T00:00:00.000Z",
        );
        db.prepare("INSERT INTO session_memories (session_id, workspace_path, thread_id, updated_at) VALUES (?, ?, ?, ?)").run(
          "session-1",
          "workspace",
          "thread",
          "2026-04-27T00:00:00.000Z",
        );
      } finally {
        db.close();
      }

      const report = createMigrationDryRunReport(fixture.dbPath);

      assert.equal(report.mode, "dry-run");
      assert.deepEqual(report.v1Counts, {
        sessions: 1,
        appSettings: 2,
        modelCatalogRevisions: 0,
        modelCatalogProviders: 0,
        modelCatalogModels: 0,
      });
      assert.equal(report.plannedV2Counts.sessions, 1);
      assert.equal(report.plannedV2Counts.sessionMessages, 2);
      assert.equal(report.plannedV2Counts.sessionMessageArtifacts, 1);
      assert.equal(report.plannedV2Counts.appSettings, 1);
      assert.equal(report.skipped.streamEntries, 1);
      assert.equal(report.skipped.legacyAppSettings, 1);
      assert.equal(report.skipped.sessionMemories, 1);
      assert.deepEqual(report.issues, []);
    } finally {
      fixture.cleanup();
    }
  });

  // @test-value v2
  // kind = "contract"
  // claim = "壊れた JSON と invalid message を V2 へ入れず report に記録する"
  // oracle = { type = "contract", ref = "docs/design/database-schema.md#起動時の移行とデータ保護" }
  // fault = "不正なmessage roleまたはJSON配列を正常messageとして移行する"
  // observable = "invalidMessages件数とissuesのcolumn/errorKind"
  // observation_boundary = "public-boundary"
  // scope = "main/database-v1-to-v2-migration"
  // lifecycle = "permanent"
  // impact = "既存の通常会話・artifactの継続利用または移行先データ保護を損なう"
  // distinction = "型検査だけではSQLite移行後の実データとsource保持を検証できない"
  // @end-test-value
  it("壊れた JSON と invalid message を V2 へ入れず report に記録する", () => {
    const fixture = createV1FixtureDatabase();
    try {
      const db = new DatabaseSync(fixture.dbPath);
      try {
        insertSession(db, {
          id: "session-1",
          messagesJson: JSON.stringify([{ role: "system", text: "skip" }]),
          streamJson: "not-json",
        });
      } finally {
        db.close();
      }

      const report = createMigrationDryRunReport(fixture.dbPath);

      assert.equal(report.plannedV2Counts.sessionMessages, 0);
      assert.equal(report.skipped.invalidMessages, 1);
      assert.deepEqual(
        report.issues.map((issue) => `${issue.sourceTable}.${issue.sourceColumn}:${issue.errorKind}`),
        [
          "sessions.messages_json:invalid_message_role",
          "sessions.stream_json:invalid_json_array",
        ],
      );
    } finally {
      fixture.cleanup();
    }
  });
});

describe("V1 to V2 database migration write mode", () => {
  // @test-value v2
  // kind = "contract"
  // claim = "V1 DB から V2 DB を作成し、sessions/messages/artifacts を write する"
  // oracle = { type = "contract", ref = "docs/design/database-schema.md#起動時の移行とデータ保護" }
  // fault = "通常Sessionのmessage順序・accent・artifact本文または設定を失う、あるいはsourceのSession本文・stream・設定を変更する"
  // observable = "V2 session headers、順序付きmessage行、artifact JSON、app settings行と移行前後のsource保存内容・行数"
  // observation_boundary = "public-boundary"
  // scope = "main/database-v1-to-v2-migration"
  // lifecycle = "permanent"
  // impact = "既存の通常会話・artifactの継続利用または移行先データ保護を損なう"
  // distinction = "型検査だけではSQLite移行後の実データとsource保持を検証できない"
  // @end-test-value
  it("V1 DB から V2 DB を作成し、sessions/messages/artifacts を write する", () => {
    const fixture = createV1FixtureDatabase();
    try {
      const sourceDb = new DatabaseSync(fixture.dbPath);
      try {
        insertSession(sourceDb, {
          id: "session-1",
          messagesJson: JSON.stringify([
            { role: "user", text: "hello" },
            {
              role: "assistant",
              text: "done",
              accent: true,
              artifact: {
                title: "result",
                changedFiles: ["src/index.ts"],
                summary: "implemented migration",
              },
            },
          ]),
          streamJson: JSON.stringify([{ mood: "calm", time: "10:00", text: "legacy monologue" }]),
        });
        insertSession(sourceDb, {
          id: "session-2",
          messagesJson: JSON.stringify([{ role: "assistant", text: "second session only" }]),
          streamJson: JSON.stringify([]),
        });
        sourceDb.prepare("INSERT INTO app_settings (setting_key, setting_value, updated_at) VALUES (?, ?, ?)").run(
          "system_prompt_prefix",
          "prefix",
          "2026-04-27T00:00:00.000Z",
        );
        sourceDb.prepare("INSERT INTO app_settings (setting_key, setting_value, updated_at) VALUES (?, ?, ?)").run(
          "memory_generation_enabled",
          "true",
          "2026-04-27T00:00:00.000Z",
        );
      } finally {
        sourceDb.close();
      }

      const sourceContentsBefore = (() => {
        const sourceDb = new DatabaseSync(fixture.dbPath);
        try {
          return {
            sessions: sourceDb.prepare("SELECT id, task_title, messages_json, stream_json FROM sessions ORDER BY id").all(),
            appSettings: sourceDb.prepare("SELECT setting_key, setting_value, updated_at FROM app_settings ORDER BY setting_key").all(),
          };
        } finally {
          sourceDb.close();
        }
      })();
      const v2DbPath = join(dirname(fixture.dbPath), "withmate-v2.db");

      createMigrationWriteReport({
        v1DbPath: fixture.dbPath,
        v2DbPath,
      });

      const v2Db = new DatabaseSync(v2DbPath);
      try {
        const expectedSchemaTables = [
          "app_settings",
          "sessions",
          "session_messages",
          "session_message_artifacts",
          "model_catalog_revisions",
          "model_catalog_providers",
          "model_catalog_models",
        ];
        for (const tableName of expectedSchemaTables) {
          assert.equal(tableExists(v2Db, tableName), true, `${tableName} が V2 スキーマとして作成される`);
        }
        assert.equal(tableExists(v2Db, "session_memories"), false, "session_memories は V2 スキーマに含まれない");

        const sessionSummaries = v2Db.prepare("SELECT id, message_count FROM sessions ORDER BY id").all() as Array<{
          id: string;
          message_count: number;
        }>;
        const session1 = sessionSummaries.find((session) => session.id === "session-1");
        const session2 = sessionSummaries.find((session) => session.id === "session-2");

        assert.ok(session1);
        assert.ok(session2);
        assert.equal(session1.message_count, 2);

        const sessionMessages = v2Db.prepare("SELECT id, seq, role, accent, artifact_available FROM session_messages WHERE session_id = ? ORDER BY seq").all(
          "session-1",
        ) as Array<{
          id: number;
          seq: number;
          role: string;
          accent: number;
          artifact_available: number;
        }>;
        assert.equal(sessionMessages.length, 2);
        assert.deepEqual(sessionMessages.map((row) => row.seq), [0, 1]);
        assert.deepEqual(sessionMessages.map((row) => row.role), ["user", "assistant"]);
        assert.deepEqual(sessionMessages.map((row) => row.accent), [0, 1]);

        const artifactRows = v2Db
          .prepare(
            `
              SELECT m.seq, a.artifact_json
              FROM session_messages AS m
              INNER JOIN session_message_artifacts AS a ON m.id = a.message_id
              WHERE m.session_id = ?
              ORDER BY m.seq
            `,
          )
          .all("session-1") as Array<{
          seq: number;
          artifact_json: string;
        }>;
        assert.equal(artifactRows.length, 1);
        assert.equal(artifactRows[0].seq, 1);
        assert.deepEqual(JSON.parse(artifactRows[0].artifact_json), {
          title: "result",
          changedFiles: ["src/index.ts"],
          summary: "implemented migration",
        });


        assert.equal(countRowsBySessionId(v2Db, "session_messages", "session-2"), 1);

        const migratedSystemPromptPrefixRow = v2Db
          .prepare("SELECT COUNT(*) AS count FROM app_settings WHERE setting_key = ?")
          .get("system_prompt_prefix") as { count: number };
        const skippedMemoryGenerationEnabledRow = v2Db
          .prepare("SELECT COUNT(*) AS count FROM app_settings WHERE setting_key = ?")
          .get("memory_generation_enabled") as { count: number };
        assert.equal(migratedSystemPromptPrefixRow.count, 1);
        assert.equal(skippedMemoryGenerationEnabledRow.count, 0);
      } finally {
        v2Db.close();
      }

      const sourceDbAfter = new DatabaseSync(fixture.dbPath);
      try {
        assert.equal(countRows(sourceDbAfter, "sessions"), 2);
        assert.equal(countRows(sourceDbAfter, "app_settings"), 2);
        assert.deepEqual(
          sourceDbAfter.prepare("SELECT id, task_title, messages_json, stream_json FROM sessions ORDER BY id").all(),
          sourceContentsBefore.sessions,
        );
        assert.deepEqual(
          sourceDbAfter.prepare("SELECT setting_key, setting_value, updated_at FROM app_settings ORDER BY setting_key").all(),
          sourceContentsBefore.appSettings,
        );
      } finally {
        sourceDbAfter.close();
      }
    } finally {
      fixture.cleanup();
    }
  });

  // @test-value v2
  // kind = "contract"
  // claim = "既存 V2 DB は overwrite 指定がない限り置き換えない"
  // oracle = { type = "contract", ref = "docs/design/database-schema.md#起動時の移行とデータ保護" }
  // fault = "overwriteなしで既存targetのSessionやmessageを破壊してから拒否例外を返す"
  // observable = "migration拒否例外と次のoverwrite前に読んだtargetのSession・message内容と行数"
  // observation_boundary = "public-boundary"
  // scope = "main/database-v1-to-v2-migration"
  // lifecycle = "permanent"
  // impact = "既存の通常会話・artifactの継続利用または移行先データ保護を損なう"
  // distinction = "型検査だけではSQLite移行後の実データとsource保持を検証できない"
  // @end-test-value
  it("既存 V2 DB は overwrite 指定がない限り置き換えない", () => {
    const fixture = createV1FixtureDatabase();
    try {
      const sourceDb = new DatabaseSync(fixture.dbPath);
      try {
        insertSession(sourceDb, {
          id: "session-1",
          messagesJson: JSON.stringify([{ role: "user", text: "hello" }]),
          streamJson: JSON.stringify([]),
        });
      } finally {
        sourceDb.close();
      }

      const v2DbPath = join(fixture.dirPath, "withmate-v2.db");
      createMigrationWriteReport({
        v1DbPath: fixture.dbPath,
        v2DbPath,
      });

      const existingTargetDb = new DatabaseSync(v2DbPath);
      try {
        existingTargetDb.prepare("UPDATE sessions SET task_title = ? WHERE id = ?").run("existing target task", "session-1");
        existingTargetDb.prepare("UPDATE session_messages SET text = ? WHERE session_id = ?").run("existing target message", "session-1");
      } finally {
        existingTargetDb.close();
      }

      assert.throws(
        () =>
          createMigrationWriteReport({
            v1DbPath: fixture.dbPath,
            v2DbPath,
          }),
        /V2 database already exists/,
      );

      const targetDbAfterRejection = new DatabaseSync(v2DbPath, { readOnly: true });
      try {
        assert.equal(countRows(targetDbAfterRejection, "sessions"), 1);
        assert.equal(countRows(targetDbAfterRejection, "session_messages"), 1);
        assert.deepEqual(
          targetDbAfterRejection.prepare("SELECT id, task_title, message_count FROM sessions ORDER BY id").all().map((row) => ({ ...row })),
          [{ id: "session-1", task_title: "existing target task", message_count: 1 }],
        );
        assert.deepEqual(
          targetDbAfterRejection.prepare("SELECT session_id, seq, role, text FROM session_messages ORDER BY session_id, seq").all().map((row) => ({ ...row })),
          [{ session_id: "session-1", seq: 0, role: "user", text: "existing target message" }],
        );
      } finally {
        targetDbAfterRejection.close();
      }

      const overwriteReport = createMigrationWriteReport({
        v1DbPath: fixture.dbPath,
        v2DbPath,
        overwrite: true,
      });

      assert.equal(overwriteReport.input.overwrite, true);
      assert.equal(overwriteReport.migratedV2Counts.sessions, 1);
    } finally {
      fixture.cleanup();
    }
  });

  // @test-value v2
  // kind = "contract"
  // claim = "V1 と V2 が同一パスの場合は overwrite 指定でも拒否する"
  // oracle = { type = "contract", ref = "docs/design/database-schema.md#起動時の移行とデータ保護" }
  // fault = "同一source/targetを許可しsource DBを破棄する"
  // observable = "migration拒否例外とsource sessions行数"
  // observation_boundary = "public-boundary"
  // scope = "main/database-v1-to-v2-migration"
  // lifecycle = "permanent"
  // impact = "既存の通常会話・artifactの継続利用または移行先データ保護を損なう"
  // distinction = "型検査だけではSQLite移行後の実データとsource保持を検証できない"
  // @end-test-value
  it("V1 と V2 が同一パスの場合は overwrite 指定でも拒否する", () => {
    const fixture = createV1FixtureDatabase();
    try {
      assert.throws(
        () =>
          createMigrationWriteReport({
            v1DbPath: fixture.dbPath,
            v2DbPath: fixture.dbPath,
            overwrite: true,
          }),
        /V1 and V2 database paths must be different/,
      );

      const sourceDb = new DatabaseSync(fixture.dbPath);
      try {
        assert.equal(tableExists(sourceDb, "sessions"), true);
      } finally {
        sourceDb.close();
      }
    } finally {
      fixture.cleanup();
    }
  });

  // @test-value v2
  // kind = "contract"
  // claim = "overwrite 中に失敗した場合は既存 V2 DB を復旧する"
  // oracle = { type = "contract", ref = "docs/design/database-schema.md#起動時の移行とデータ保護" }
  // fault = "必須source列の欠損でwrite失敗した後に既存targetを復旧しない"
  // observable = "writeの拒否例外と復旧されたV2 sessions行数"
  // observation_boundary = "public-boundary"
  // scope = "main/database-v1-to-v2-migration"
  // lifecycle = "permanent"
  // impact = "既存の通常会話・artifactの継続利用または移行先データ保護を損なう"
  // distinction = "型検査だけではSQLite移行後の実データとsource保持を検証できない"
  // @end-test-value
  it("overwrite 中に失敗した場合は既存 V2 DB を復旧する", () => {
    const fixture = createV1FixtureDatabase();
    try {
      const sourceDb = new DatabaseSync(fixture.dbPath);
      try {
        insertSession(sourceDb, {
          id: "session-1",
          messagesJson: JSON.stringify([{ role: "user", text: "hello" }]),
          streamJson: JSON.stringify([]),
        });
      } finally {
        sourceDb.close();
      }

      const v2DbPath = join(fixture.dirPath, "withmate-v2.db");
      createMigrationWriteReport({
        v1DbPath: fixture.dbPath,
        v2DbPath,
      });

      const sourceDbWithBadRow = new DatabaseSync(fixture.dbPath);
      try {
        sourceDbWithBadRow.exec("ALTER TABLE sessions DROP COLUMN task_title;");
      } finally {
        sourceDbWithBadRow.close();
      }

      assert.throws(
        () =>
          createMigrationWriteReport({
            v1DbPath: fixture.dbPath,
            v2DbPath,
            overwrite: true,
          }),
      );

      const restoredV2Db = new DatabaseSync(v2DbPath);
      try {
        assert.equal(countRows(restoredV2Db, "sessions"), 1);
      } finally {
        restoredV2Db.close();
      }
    } finally {
      fixture.cleanup();
    }
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "V1から移行したV2 DBをruntime lifecycleで開き主要read/write pathを継続できる"
  // oracle = { type = "contract", ref = "V1 to V2 migration contract" }
  // fault = "migration後のlifecycle初期化に失敗する、またはsession read-write pathが欠落する"
  // observable = "migration reportとlifecycle経由の保存・取得結果"
  // observation_boundary = "public-boundary"
  // scope = "V1 to V2 migration runtime lifecycle"
  // lifecycle = "permanent"
  // @end-test-value
  it("V1 から移行した V2 DB を runtime lifecycle で開き主要 read/write path を通せる", async () => {
    const fixture = createV1FixtureDatabase();
    try {
      const sourceDb = new DatabaseSync(fixture.dbPath);
      try {
        insertSession(sourceDb, {
          id: "session-1",
          messagesJson: JSON.stringify([
            { role: "user", text: "hello from v1" },
            {
              role: "assistant",
              text: "done from v1",
              artifact: {
                title: "runtime artifact",
                activitySummary: ["migrated"],
                changedFiles: [
                  { kind: "edit", path: "src/index.ts", summary: "updated", diffRows: [] },
                ],
                runChecks: [{ label: "test", value: "pass" }],
              },
            },
          ]),
          streamJson: JSON.stringify([{ mood: "calm", text: "legacy monologue" }]),
        });
      } finally {
        sourceDb.close();
      }

      const v2DbPath = join(fixture.dirPath, "withmate-v2.db");
      const migrationReport = createMigrationWriteReport({
        v1DbPath: fixture.dbPath,
        v2DbPath,
      });
      assert.equal(migrationReport.migratedV2Counts.sessions, 1);
      assert.equal(migrationReport.migratedV2Counts.sessionMessages, 2);
      assert.equal(migrationReport.migratedV2Counts.sessionMessageArtifacts, 1);

      const removedPaths: string[] = [];
      const truncatedWalPaths: string[] = [];
      const lifecycle = new PersistentStoreLifecycleService({
        createModelCatalogStorage: () =>
          ({
            ensureSeeded: () => ({ revision: 1, providers: [] }),
            close() {},
          }) as never,
        createSessionStorage: () => {
          throw new Error("V2 lifecycle では V1 session storage を生成しない");
        },
        createSessionMemoryStorage: () => ({ close() {} }) as never,
        createProjectMemoryStorage: () => ({ close() {} }) as never,
        createAppSettingsStorage: () => ({ close() {} }) as never,
        createMateStorage: () => ({ close() {} }) as never,
        ensureV2Schema(dbPath) {
          const db = new DatabaseSync(dbPath);
          try {
            for (const statement of CREATE_V2_SCHEMA_SQL) {
              db.exec(statement);
            }
          } finally {
            db.close();
          }
        },
        onBeforeClose: () => {},
        truncateWal(dbPath) {
          truncatedWalPaths.push(dbPath);
        },
        async removeFile(filePath) {
          removedPaths.push(filePath);
          rmSync(filePath, { force: true });
        },
      });

      let bundle: PersistentStoreBundle | null = await lifecycle.initialize(v2DbPath, "model-catalog.json");
      const sessionStorage = bundle.sessionStorage as SessionStorageV2;

      try {
        assert.equal(bundle.sessionStorage instanceof SessionStorageV2, true);
        assert.deepEqual(bundle.sessions.map((session) => ({
          id: session.id,
          messages: session.messages.length,
        })), [{ id: "session-1", messages: 0 }]);

        const migratedSession = sessionStorage.getSession("session-1");
        assert.ok(migratedSession);
        assert.deepEqual(migratedSession.messages.map((message) => message.text), [
          "hello from v1",
          "done from v1",
        ]);
        assert.equal(migratedSession.messages[1]?.artifact?.title, "runtime artifact");

        sessionStorage.upsertSession({
          ...migratedSession,
          taskTitle: "updated in runtime",
        });
        const updatedSession = sessionStorage.getSession("session-1");
        assert.equal(updatedSession?.taskTitle, "updated in runtime");
        assert.deepEqual(updatedSession?.messages.map((message) => message.text), [
          "hello from v1",
          "done from v1",
        ]);
        assert.equal(updatedSession?.messages[1]?.artifact?.title, "runtime artifact");

        const listFullSessions = () => hydrateSessionsFromSummaries(sessionStorage);
        const runtimeSessions = listFullSessions();
        assert.equal(runtimeSessions[0]?.messages.length, 2);
        assert.equal(runtimeSessions[0]?.messages[1]?.artifact?.title, "runtime artifact");

        const recreated = await lifecycle.recreate(v2DbPath, "model-catalog.json", bundle);
        bundle = null;
        try {
          assert.deepEqual(truncatedWalPaths.map((filePath) => basename(filePath)), ["withmate-v2.db"]);
          assert.deepEqual(removedPaths.map((filePath) => basename(filePath)), [
            "withmate-v2.db-wal",
            "withmate-v2.db-shm",
            "withmate-v2.db",
          ]);
          assert.deepEqual(recreated.sessions, []);
          assert.equal(recreated.sessionStorage instanceof SessionStorageV2, true);

          const recreatedSessionStorage = recreated.sessionStorage as SessionStorageV2;
          recreatedSessionStorage.upsertSession({
            ...updatedSession,
            id: "session-after-recreate",
            messages: [{ role: "user", text: "after recreate" }],
          });
          assert.deepEqual(
            recreatedSessionStorage.getSession("session-after-recreate")?.messages.map((message) => message.text),
            ["after recreate"],
          );
        } finally {
          lifecycle.close(recreated, v2DbPath);
        }
      } finally {
        if (bundle) {
          lifecycle.close(bundle, v2DbPath);
        }
      }
    } finally {
      fixture.cleanup();
    }
  });
});
