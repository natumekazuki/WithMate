import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import {
  CREATE_APP_SETTINGS_TABLE_SQL,
  CREATE_AUDIT_LOGS_TABLE_SQL,
  CREATE_CHARACTER_MEMORY_TABLES_SQL,
  CREATE_MODEL_CATALOG_TABLES_SQL,
  CREATE_PROJECT_MEMORY_TABLES_SQL,
  CREATE_SESSION_MEMORIES_TABLE_SQL,
  CREATE_SESSIONS_TABLE_SQL,
} from "../../src-electron/database-schema-v1.js";
import { CREATE_V2_SCHEMA_SQL } from "../../src-electron/database-schema-v2.js";
import { AuditLogStorageV2 } from "../../src-electron/audit-log-storage-v2.js";
import { CharacterRuntimeService } from "../../src-electron/character-runtime-service.js";
import { PersistentStoreLifecycleService, type PersistentStoreBundle } from "../../src-electron/persistent-store-lifecycle-service.js";
import { SessionStorageV2 } from "../../src-electron/session-storage-v2.js";
import { hydrateSessionsFromSummaries } from "../../src-electron/session-summary-adapter.js";
import type { CharacterProfile } from "../../src/character-state.js";
import { createMigrationDryRunReport, createMigrationWriteReport } from "../migrate-database-v1-to-v2.js";

function createV1FixtureDatabase(): { dbPath: string; dirPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "withmate-v1-to-v2-"));
  const dbPath = join(dir, "withmate.db");
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec(CREATE_APP_SETTINGS_TABLE_SQL);
    db.exec(CREATE_SESSIONS_TABLE_SQL);
    db.exec(CREATE_AUDIT_LOGS_TABLE_SQL);
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
      task_summary,
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
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    "task",
    "summary",
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

function insertAuditLog(db: DatabaseSync, input: {
  sessionId: string;
  phase: string;
  operationsJson: string;
  assistantText?: string;
  logicalPromptJson?: string;
  transportPayloadJson?: string;
  rawItemsJson?: string;
  usageJson?: string;
}): void {
  db.prepare(`
    INSERT INTO audit_logs (
      session_id,
      created_at,
      phase,
      provider,
      model,
      reasoning_effort,
      approval_mode,
      thread_id,
      logical_prompt_json,
      transport_payload_json,
      assistant_text,
      operations_json,
      raw_items_json,
      usage_json,
      error_message
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.sessionId,
    "2026-04-27T00:00:00.000Z",
    input.phase,
    "codex",
    "gpt-5.4-mini",
    "medium",
    "never",
    "thread",
    input.logicalPromptJson ?? "{\"prompt\":true}",
    input.transportPayloadJson ?? "{\"transport\":true}",
    input.assistantText ?? "assistant text",
    input.operationsJson,
    input.rawItemsJson ?? "[]",
    input.usageJson ?? "",
    "",
  );
}

function createCharacterProfile(overrides?: Partial<CharacterProfile>): CharacterProfile {
  return {
    id: "character",
    name: "Character",
    iconPath: "",
    description: "",
    roleMarkdown: "",
    notesMarkdown: "",
    themeColors: { main: "#6f8cff", sub: "#6fb8c7" },
    sessionCopy: {
      pendingApproval: [],
      pendingWorking: [],
      pendingResponding: [],
      pendingPreparing: [],
      retryInterruptedTitle: [],
      retryFailedTitle: [],
      retryCanceledTitle: [],
      latestCommandEmpty: [],
      latestCommandWaiting: [],
      contextEmpty: [],
      changedFilesEmpty: [],
    },
    createdAt: "2026-04-27T00:00:00.000Z",
    updatedAt: "2026-04-27T00:00:00.000Z",
    ...overrides,
  };
}

describe("V1 to V2 database migration dry-run", () => {
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
        insertAuditLog(db, {
          sessionId: "session-1",
          phase: "completed",
          operationsJson: JSON.stringify([
            { type: "tool", summary: "run test", details: "ok" },
            { type: "edit", summary: "update file" },
          ]),
          rawItemsJson: JSON.stringify([{ type: "message" }]),
          usageJson: JSON.stringify({ inputTokens: 10, cachedInputTokens: 2, outputTokens: 5 }),
        });
        insertAuditLog(db, {
          sessionId: "session-1",
          phase: "background-completed",
          operationsJson: "[]",
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
        auditLogs: 2,
        appSettings: 2,
        modelCatalogRevisions: 0,
        modelCatalogProviders: 0,
        modelCatalogModels: 0,
      });
      assert.equal(report.plannedV2Counts.sessions, 1);
      assert.equal(report.plannedV2Counts.sessionMessages, 2);
      assert.equal(report.plannedV2Counts.sessionMessageArtifacts, 1);
      assert.equal(report.plannedV2Counts.auditLogs, 1);
      assert.equal(report.plannedV2Counts.auditLogDetails, 1);
      assert.equal(report.plannedV2Counts.auditLogOperations, 2);
      assert.equal(report.plannedV2Counts.appSettings, 1);
      assert.equal(report.skipped.streamEntries, 1);
      assert.equal(report.skipped.backgroundAuditLogs, 1);
      assert.equal(report.skipped.legacyAppSettings, 1);
      assert.equal(report.skipped.sessionMemories, 1);
      assert.deepEqual(report.issues, []);
    } finally {
      fixture.cleanup();
    }
  });

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
        insertAuditLog(db, {
          sessionId: "session-1",
          phase: "completed",
          operationsJson: "not-json",
          rawItemsJson: "not-json",
          usageJson: "not-json",
        });
      } finally {
        db.close();
      }

      const report = createMigrationDryRunReport(fixture.dbPath);

      assert.equal(report.plannedV2Counts.sessionMessages, 0);
      assert.equal(report.skipped.invalidMessages, 1);
      assert.equal(report.skipped.invalidAuditOperations, 1);
      assert.deepEqual(
        report.issues.map((issue) => `${issue.sourceTable}.${issue.sourceColumn}:${issue.errorKind}`),
        [
          "sessions.messages_json:invalid_message_role",
          "sessions.stream_json:invalid_json_array",
          "audit_logs.operations_json:invalid_json_array",
          "audit_logs.raw_items_json:invalid_json_array",
          "audit_logs.usage_json:invalid_json",
        ],
      );
    } finally {
      fixture.cleanup();
    }
  });
});

describe("V1 to V2 database migration write mode", () => {
  it("V1 DB から V2 DB を作成し、sessions/messages/artifacts/audit を write する", () => {
    const fixture = createV1FixtureDatabase();
    try {
      const longAssistantText = "x".repeat(620);
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
        insertAuditLog(sourceDb, {
          sessionId: "session-1",
          phase: "completed",
          operationsJson: JSON.stringify([
            { type: "tool", summary: "run test", details: "ok" },
            { type: "edit", summary: "update file", details: "modified" },
          ]),
          rawItemsJson: JSON.stringify([{ type: "message", text: "x" }]),
          usageJson: JSON.stringify({ inputTokens: 10, cachedInputTokens: 1, outputTokens: 7 }),
          assistantText: longAssistantText,
        });
        insertAuditLog(sourceDb, {
          sessionId: "session-1",
          phase: "background-completed",
          operationsJson: JSON.stringify([]),
          rawItemsJson: JSON.stringify([]),
          usageJson: JSON.stringify({ inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 }),
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

      const v1SessionCountBefore = (() => {
        const sourceDb = new DatabaseSync(fixture.dbPath);
        try {
          return countRows(sourceDb, "sessions");
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
          "audit_logs",
          "audit_log_details",
          "audit_log_operations",
          "model_catalog_revisions",
          "model_catalog_providers",
          "model_catalog_models",
        ];
        for (const tableName of expectedSchemaTables) {
          assert.equal(tableExists(v2Db, tableName), true, `${tableName} が V2 スキーマとして作成される`);
        }
        assert.equal(tableExists(v2Db, "session_memories"), false, "session_memories は V2 スキーマに含まれない");

        const sessionSummaries = v2Db.prepare("SELECT id, message_count, audit_log_count FROM sessions ORDER BY id").all() as Array<{
          id: string;
          message_count: number;
          audit_log_count: number;
        }>;
        const session1 = sessionSummaries.find((session) => session.id === "session-1");
        const session2 = sessionSummaries.find((session) => session.id === "session-2");

        assert.ok(session1);
        assert.ok(session2);
        assert.equal(session1.message_count, 2);
        assert.equal(session1.audit_log_count, 1);

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

        const auditLogSummaries = v2Db
          .prepare(
            "SELECT id, session_id, phase, assistant_text_preview, operation_count, raw_item_count, input_tokens, cached_input_tokens, output_tokens FROM audit_logs ORDER BY id",
          )
          .all() as Array<{
          id: number;
          session_id: string;
          phase: string;
          assistant_text_preview: string;
          operation_count: number;
          raw_item_count: number;
          input_tokens: number;
          cached_input_tokens: number;
          output_tokens: number;
        }>;
        assert.equal(auditLogSummaries.length, 1);
        assert.equal(auditLogSummaries[0].session_id, "session-1");
        assert.equal(auditLogSummaries[0].phase, "completed");
        assert.equal(auditLogSummaries[0].operation_count, 2);
        assert.equal(auditLogSummaries[0].raw_item_count, 1);
        assert.equal(auditLogSummaries[0].input_tokens, 10);
        assert.equal(auditLogSummaries[0].assistant_text_preview.length, 500);

        const detailRows = v2Db
          .prepare("SELECT audit_log_id, logical_prompt_json, transport_payload_json, assistant_text, raw_items_json, usage_json FROM audit_log_details ORDER BY audit_log_id")
          .all() as Array<{
          audit_log_id: number;
          logical_prompt_json: string;
          transport_payload_json: string;
          assistant_text: string;
          raw_items_json: string;
          usage_json: string;
        }>;
        assert.equal(detailRows.length, 1);
        assert.equal(detailRows[0].audit_log_id, auditLogSummaries[0].id);
        assert.deepEqual(JSON.parse(detailRows[0].logical_prompt_json), { prompt: true });
        assert.deepEqual(JSON.parse(detailRows[0].transport_payload_json), { transport: true });
        assert.equal(detailRows[0].assistant_text, longAssistantText);

        const operationRows = v2Db
          .prepare("SELECT seq, operation_type, summary, details FROM audit_log_operations WHERE audit_log_id = ? ORDER BY seq")
          .all(auditLogSummaries[0].id) as Array<{
          seq: number;
          operation_type: string;
          summary: string;
          details: string;
        }>;
        assert.deepEqual(operationRows.map((row) => row.seq), [0, 1]);
        assert.deepEqual(operationRows.map((row) => row.operation_type), ["tool", "edit"]);

        assert.equal(countRowsBySessionId(v2Db, "session_messages", "session-2"), 1);
        assert.equal(countRowsBySessionId(v2Db, "audit_logs", "session-2"), 0);

        assert.equal(
          v2Db.prepare("SELECT COUNT(*) AS count FROM app_settings WHERE setting_key = ?").get("system_prompt_prefix").count,
          1,
        );
        assert.equal(
          v2Db.prepare("SELECT COUNT(*) AS count FROM app_settings WHERE setting_key = ?").get("memory_generation_enabled").count,
          0,
        );
      } finally {
        v2Db.close();
      }

      const sourceDbAfter = new DatabaseSync(fixture.dbPath);
      try {
        const v1SessionCountAfter = countRows(sourceDbAfter, "sessions");
        assert.equal(v1SessionCountAfter, v1SessionCountBefore);
      } finally {
        sourceDbAfter.close();
      }
    } finally {
      fixture.cleanup();
    }
  });

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

      assert.throws(
        () =>
          createMigrationWriteReport({
            v1DbPath: fixture.dbPath,
            v2DbPath,
          }),
        /V2 database already exists/,
      );

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
        sourceDbWithBadRow.exec("PRAGMA foreign_keys = OFF;");
        insertAuditLog(sourceDbWithBadRow, {
          sessionId: "missing-session",
          phase: "completed",
          operationsJson: "[]",
        });
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
        assert.equal(countRows(restoredV2Db, "audit_logs"), 0);
      } finally {
        restoredV2Db.close();
      }
    } finally {
      fixture.cleanup();
    }
  });

  it("write mode でも broken usage_json は V2 detail に持ち込まない", () => {
    const fixture = createV1FixtureDatabase();
    try {
      const sourceDb = new DatabaseSync(fixture.dbPath);
      try {
        insertSession(sourceDb, {
          id: "session-1",
          messagesJson: JSON.stringify([{ role: "user", text: "hello" }]),
          streamJson: JSON.stringify([]),
        });
        insertAuditLog(sourceDb, {
          sessionId: "session-1",
          phase: "completed",
          operationsJson: "[]",
          usageJson: "not-json",
        });
      } finally {
        sourceDb.close();
      }

      const v2DbPath = join(fixture.dirPath, "withmate-v2.db");
      const report = createMigrationWriteReport({
        v1DbPath: fixture.dbPath,
        v2DbPath,
      });

      assert.deepEqual(
        report.issues.map((issue) => `${issue.sourceTable}.${issue.sourceColumn}:${issue.errorKind}`),
        ["audit_logs.usage_json:invalid_json_object"],
      );

      const v2Db = new DatabaseSync(v2DbPath);
      try {
        const row = v2Db.prepare("SELECT usage_json FROM audit_log_details").get() as { usage_json: string };
        assert.equal(row.usage_json, "");
      } finally {
        v2Db.close();
      }
    } finally {
      fixture.cleanup();
    }
  });

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
        insertAuditLog(sourceDb, {
          sessionId: "session-1",
          phase: "completed",
          operationsJson: JSON.stringify([
            { type: "tool", summary: "run test", details: "ok" },
          ]),
          assistantText: "assistant detail",
          rawItemsJson: JSON.stringify([{ type: "message" }]),
          usageJson: JSON.stringify({ inputTokens: 10, cachedInputTokens: 2, outputTokens: 5 }),
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
      assert.equal(migrationReport.migratedV2Counts.auditLogs, 1);

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
        createCharacterMemoryStorage: () => ({ close() {} }) as never,
        createAuditLogStorage: () => {
          throw new Error("V2 lifecycle では V1 audit log storage を生成しない");
        },
        createAppSettingsStorage: () => ({ close() {} }) as never,
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
      const auditLogStorage = bundle.auditLogStorage as AuditLogStorageV2;

      try {
        assert.equal(bundle.sessionStorage instanceof SessionStorageV2, true);
        assert.equal(bundle.auditLogStorage instanceof AuditLogStorageV2, true);
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

        const auditPage = auditLogStorage.listSessionAuditLogSummaryPage("session-1", { cursor: 0, limit: 10 });
        assert.equal(auditPage.entries.length, 1);
        assert.equal(auditPage.entries[0]?.operations.length, 1);
        assert.equal(auditPage.entries[0]?.operations[0]?.details, undefined);
        const auditDetail = auditLogStorage.getSessionAuditLogDetail("session-1", auditPage.entries[0]?.id ?? -1);
        assert.equal(auditDetail?.assistantText, "assistant detail");
        assert.deepEqual(auditDetail?.operations.map((operation) => operation.summary), ["run test"]);
        assert.equal(auditDetail?.operations[0]?.details, "ok");

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

        const createdAuditLog = auditLogStorage.createAuditLog({
          sessionId: "session-1",
          createdAt: "2026-04-27T01:00:00.000Z",
          phase: "completed",
          provider: "codex",
          model: "gpt-5.4-mini",
          reasoningEffort: "medium",
          approvalMode: "never",
          threadId: "thread-runtime",
          logicalPrompt: {
            systemText: "system",
            inputText: "input",
            composedText: "system\n\ninput",
          },
          transportPayload: { summary: "payload", fields: [] },
          assistantText: "new assistant detail",
          operations: [{ type: "analysis", summary: "runtime write", details: "ok" }],
          rawItemsJson: "[]",
          usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 2 },
          errorMessage: "",
        });
        assert.equal(auditLogStorage.getSessionAuditLogDetail("session-1", createdAuditLog.id)?.assistantText, "new assistant detail");

        let runtimeSessions = bundle.sessions;
        const listFullSessions = () => hydrateSessionsFromSummaries(sessionStorage);
        const characterRuntime = new CharacterRuntimeService({
          getCharacters: () => [createCharacterProfile()],
          setCharacters() {},
          async listStoredCharacters() {
            return [createCharacterProfile({ name: "Character+" })];
          },
          async getStoredCharacter() {
            return createCharacterProfile();
          },
          async createStoredCharacter(input) {
            return createCharacterProfile({ id: "character-2", name: input.name });
          },
          async updateStoredCharacter(character) {
            return createCharacterProfile(character);
          },
          async deleteStoredCharacter() {},
          listSessions: listFullSessions,
          upsertStoredSession(session) {
            return sessionStorage.upsertSession(session);
          },
          reloadStoredSessions: listFullSessions,
          setSessions(nextSessions) {
            runtimeSessions = nextSessions;
          },
          closeCharacterEditor() {},
          broadcastCharacters() {},
          broadcastSessions() {},
        });

        await characterRuntime.updateCharacter(createCharacterProfile({ name: "Character+" }));

        const characterUpdatedSession = sessionStorage.getSession("session-1");
        assert.equal(characterUpdatedSession?.character, "Character+");
        assert.deepEqual(characterUpdatedSession?.messages.map((message) => message.text), [
          "hello from v1",
          "done from v1",
        ]);
        assert.equal(characterUpdatedSession?.messages[1]?.artifact?.title, "runtime artifact");
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
          assert.equal(recreated.auditLogStorage instanceof AuditLogStorageV2, true);

          const recreatedSessionStorage = recreated.sessionStorage as SessionStorageV2;
          const recreatedAuditLogStorage = recreated.auditLogStorage as AuditLogStorageV2;
          recreatedSessionStorage.upsertSession({
            ...characterUpdatedSession,
            id: "session-after-recreate",
            messages: [{ role: "user", text: "after recreate" }],
          });
          assert.deepEqual(
            recreatedSessionStorage.getSession("session-after-recreate")?.messages.map((message) => message.text),
            ["after recreate"],
          );
          const recreatedAuditLog = recreatedAuditLogStorage.createAuditLog({
            sessionId: "session-after-recreate",
            createdAt: "2026-04-27T02:00:00.000Z",
            phase: "completed",
            provider: "codex",
            model: "gpt-5.4-mini",
            reasoningEffort: "medium",
            approvalMode: "never",
            threadId: "thread-recreate",
            logicalPrompt: {
              systemText: "system",
              inputText: "input",
              composedText: "system\n\ninput",
            },
            transportPayload: { summary: "payload", fields: [] },
            assistantText: "recreated assistant detail",
            operations: [{ type: "analysis", summary: "recreate write", details: "ok" }],
            rawItemsJson: "[]",
            usage: { inputTokens: 3, cachedInputTokens: 0, outputTokens: 4 },
            errorMessage: "",
          });
          const recreatedAuditDetail = recreatedAuditLogStorage.getSessionAuditLogDetail("session-after-recreate", recreatedAuditLog.id);
          assert.equal(recreatedAuditDetail?.assistantText, "recreated assistant detail");
          assert.equal(recreatedAuditDetail?.operations[0]?.details, "ok");
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

  it("write mode では object ではない detail JSON を V2 detail に持ち込まない", () => {
    const fixture = createV1FixtureDatabase();
    try {
      const sourceDb = new DatabaseSync(fixture.dbPath);
      try {
        insertSession(sourceDb, {
          id: "session-1",
          messagesJson: JSON.stringify([{ role: "user", text: "hello" }]),
          streamJson: JSON.stringify([]),
        });
        insertAuditLog(sourceDb, {
          sessionId: "session-1",
          phase: "completed",
          operationsJson: "[]",
          logicalPromptJson: "not-json",
          transportPayloadJson: "[]",
          usageJson: "[]",
        });
      } finally {
        sourceDb.close();
      }

      const v2DbPath = join(fixture.dirPath, "withmate-v2.db");
      const report = createMigrationWriteReport({
        v1DbPath: fixture.dbPath,
        v2DbPath,
      });

      assert.deepEqual(
        report.issues.map((issue) => `${issue.sourceTable}.${issue.sourceColumn}:${issue.errorKind}`),
        [
          "audit_logs.logical_prompt_json:invalid_json_object",
          "audit_logs.transport_payload_json:invalid_json_object",
          "audit_logs.usage_json:invalid_json_object",
        ],
      );

      const v2Db = new DatabaseSync(v2DbPath);
      try {
        const row = v2Db.prepare("SELECT logical_prompt_json, transport_payload_json, usage_json FROM audit_log_details").get() as {
          logical_prompt_json: string;
          transport_payload_json: string;
          usage_json: string;
        };
        assert.equal(row.logical_prompt_json, "");
        assert.equal(row.transport_payload_json, "");
        assert.equal(row.usage_json, "");
      } finally {
        v2Db.close();
      }
    } finally {
      fixture.cleanup();
    }
  });
});
