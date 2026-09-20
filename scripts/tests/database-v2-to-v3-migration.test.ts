import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, it } from "node:test";

import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import { buildNewSession, type MessageArtifact } from "../../src/app-state.js";
import { AuditLogStorageV2 } from "../../src-electron/audit-log-storage-v2.js";
import { AuditLogStorageV3 } from "../../src-electron/audit-log-storage-v3.js";
import { CREATE_V2_SCHEMA_SQL } from "../../src-electron/database-schema-v2.js";
import {
  CREATE_V3_SCHEMA_SQL,
  V3_DETAILS_PREVIEW_MAX_LENGTH,
  V3_TEXT_PREVIEW_MAX_LENGTH,
} from "../../src-electron/database-schema-v3.js";
import { SessionStorageV2 } from "../../src-electron/session-storage-v2.js";
import { SessionStorageV3 } from "../../src-electron/session-storage-v3.js";
import {
  createMigrationDryRunReport,
  createMigrationWriteReport,
} from "../migrate-database-v2-to-v3.js";

function createV2FixtureDatabase(): { dbPath: string; dirPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "withmate-v2-to-v3-"));
  const dbPath = join(dir, "withmate-v2.db");
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA foreign_keys = ON;");
    for (const statement of CREATE_V2_SCHEMA_SQL) {
      db.exec(statement);
    }
  } finally {
    db.close();
  }

  return {
    dbPath,
    dirPath: dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function createArtifact(sentinel: string): MessageArtifact {
  return {
    title: "migration artifact",
    activitySummary: ["migrated"],
    operationTimeline: [
      {
        type: "edit",
        summary: "artifact operation",
        details: `${sentinel}:artifact-operation-details`,
      },
    ],
    changedFiles: [
      {
        kind: "edit",
        path: "src/index.ts",
        summary: "changed",
        diffRows: [
          {
            kind: "add",
            rightNumber: 1,
            rightText: `${sentinel}:artifact-diff-tail`,
          },
        ],
      },
    ],
    runChecks: [{ label: "test", value: "pass" }],
  };
}

function tableExists(db: DatabaseSync, tableName: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?").get(tableName);
  return row !== undefined;
}

function readRequiredRow<T>(db: DatabaseSync, sql: string, ...params: SQLInputValue[]): T {
  const row = db.prepare(sql).get(...params) as T | undefined;
  assert.ok(row);
  return row;
}

function readCount(db: DatabaseSync, tableName: string): number {
  const row = readRequiredRow<{ count: number }>(db, `SELECT COUNT(*) AS count FROM ${tableName}`);
  return row.count;
}

function tableNames(db: DatabaseSync): string[] {
  return (db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>)
    .map((row) => row.name)
    .filter((name) => !name.startsWith("sqlite_"));
}

function textColumnNames(db: DatabaseSync, tableName: string): string[] {
  return (db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string; type: string }>)
    .filter((row) => row.type.toUpperCase().includes("TEXT"))
    .map((row) => row.name);
}

function readAllTextValues(db: DatabaseSync): string[] {
  const values: string[] = [];
  for (const tableName of tableNames(db)) {
    for (const columnName of textColumnNames(db, tableName)) {
      const rows = db.prepare(`SELECT ${columnName} AS value FROM ${tableName}`).all() as Array<{ value: string | null }>;
      for (const row of rows) {
        if (typeof row.value === "string") {
          values.push(row.value);
        }
      }
    }
  }
  return values;
}

function readDatabaseSnapshot(db: DatabaseSync): Record<string, Array<Record<string, unknown>>> {
  const snapshot: Record<string, Array<Record<string, unknown>>> = {};
  for (const tableName of tableNames(db)) {
    const columns = (db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>).map((row) => row.name);
    snapshot[tableName] = db.prepare(
      `SELECT ${columns.join(", ")} FROM ${tableName} ORDER BY rowid`,
    ).all() as Array<Record<string, unknown>>;
  }
  return snapshot;
}

function insertAppSettingsAndModelCatalog(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare("INSERT INTO app_settings (setting_key, setting_value, updated_at) VALUES (?, ?, ?)").run(
      "system_prompt_prefix",
      "prefix-v2",
      "2026-04-28T00:00:00.000Z",
    );
    db.prepare("INSERT INTO model_catalog_revisions (revision, source, imported_at, is_active) VALUES (?, ?, ?, ?)").run(
      10,
      "fixture",
      "2026-04-28T00:00:00.000Z",
      1,
    );
    db.prepare(
      "INSERT INTO model_catalog_providers (revision, provider_id, label, default_model_id, default_reasoning_effort, sort_order) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(10, "codex", "Codex", "gpt-5.4-mini", "medium", 1);
    db.prepare(
      "INSERT INTO model_catalog_models (revision, provider_id, model_id, label, reasoning_efforts_json, sort_order) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(10, "codex", "gpt-5.4-mini", "GPT 5.4 mini", JSON.stringify(["medium", "high"]), 1);
  } finally {
    db.close();
  }
}

function checkpointAndRemoveSqliteSidecars(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  } finally {
    db.close();
  }
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
}

function seedV2Storage(dbPath: string, sentinel = "SENTINEL_V2_TO_V3_BLOB_ONLY"): void {
  const sessionStorage = new SessionStorageV2(dbPath);
  const auditStorage = new AuditLogStorageV2(dbPath);
  const longMessage = `${"m".repeat(V3_TEXT_PREVIEW_MAX_LENGTH + 20)}${sentinel}:message-tail`;
  const session = buildNewSession({
    taskTitle: "V2 migration fixture",
    workspaceLabel: "workspace",
    workspacePath: "/workspace",
    branch: "main",
    characterId: "char",
    character: "Character",
    characterIconPath: "",
    characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
    approvalMode: DEFAULT_APPROVAL_MODE,
  });

  try {
    sessionStorage.upsertSession({
      ...session,
      id: "session-1",
      threadId: "thread-1",
      messages: [
        { role: "user", text: longMessage, isBookmarked: true },
        {
          role: "assistant",
          text: "assistant reply",
          artifact: createArtifact(sentinel),
        },
      ],
    });

    auditStorage.createAuditLog({
      sessionId: "session-1",
      createdAt: "2026-04-28T01:00:00.000Z",
      phase: "completed",
      provider: "codex",
      model: "gpt-5.4-mini",
      reasoningEffort: "medium",
      approvalMode: DEFAULT_APPROVAL_MODE,
      threadId: "thread-1",
      logicalPrompt: {
        systemText: `${sentinel}:logical-system`,
        inputText: "input",
        composedText: `${sentinel}:logical-system\n\ninput`,
      },
      transportPayload: {
        summary: `${sentinel}:transport-summary`,
        fields: [{ label: "payload", value: `${sentinel}:transport-field` }],
      },
      assistantText: `${"a".repeat(V3_TEXT_PREVIEW_MAX_LENGTH + 20)}${sentinel}:assistant-tail`,
      operations: [
        {
          type: "analysis",
          summary: "operation summary",
          details: `${"d".repeat(V3_DETAILS_PREVIEW_MAX_LENGTH + 20)}${sentinel}:operation-details-tail`,
        },
      ],
      rawItemsJson: JSON.stringify([{ type: "message", text: `${sentinel}:raw-item-tail` }]),
      usage: { inputTokens: 11, cachedInputTokens: 2, outputTokens: 7 },
      errorMessage: "",
    });

  } finally {
    sessionStorage.close();
    auditStorage.close();
  }

  insertAppSettingsAndModelCatalog(dbPath);
}

describe("V2 to V3 database migration dry-run", () => {
  // @test-value v2
  // kind = "contract"
  // claim = "V2 migration dry-runはsourceを変更せず通常Session/Audit/blob/settings/catalogの件数とestimateを返す"
  // oracle = { type = "contract", ref = "scripts/migrate-database-v2-to-v3.ts" }
  // fault = "dry-runがsourceを変更するか、通常データの件数またはblob見積りを誤る"
  // observable = "dry-run report counts, estimates, and source file state"
  // observation_boundary = "public-boundary"
  // scope = "database-v2-to-v3 dry-run"
  // lifecycle = "permanent"
  // @end-test-value
  it("V2 source を変更せず件数と estimate bytes を返す", () => {
    const fixture = createV2FixtureDatabase();
    try {
      seedV2Storage(fixture.dbPath);
      checkpointAndRemoveSqliteSidecars(fixture.dbPath);
      const sourceStatBefore = statSync(fixture.dbPath);
      const sourceDbBefore = new DatabaseSync(fixture.dbPath, { readOnly: true });
      let sessionCountBefore = 0;
      let sourceSnapshotBefore: Record<string, Array<Record<string, unknown>>> = {};
      try {
        sessionCountBefore = readCount(sourceDbBefore, "sessions");
        sourceSnapshotBefore = readDatabaseSnapshot(sourceDbBefore);
      } finally {
        sourceDbBefore.close();
      }

      const report = createMigrationDryRunReport(fixture.dbPath);

      assert.equal(report.mode, "dry-run");
      assert.deepEqual(report.v2Counts, {
        sessions: 1,
        sessionMessages: 2,
        sessionMessageArtifacts: 1,
        auditLogs: 1,
        auditLogDetails: 1,
        auditLogOperations: 1,
        appSettings: 1,
        modelCatalogRevisions: 1,
        modelCatalogProviders: 1,
        modelCatalogModels: 1,
      });
      assert.deepEqual(report.plannedV3Counts, report.v2Counts);
      assert.equal(report.estimatedSourceBytes.sessionMessageText > 0, true);
      assert.equal(report.estimatedSourceBytes.auditAssistantText > 0, true);
      assert.equal(report.estimatedSourceBytes.auditOperationDetails > 0, true);

      const sourceDbAfter = new DatabaseSync(fixture.dbPath, { readOnly: true });
      try {
        assert.equal(readCount(sourceDbAfter, "sessions"), sessionCountBefore);
        assert.deepEqual(readDatabaseSnapshot(sourceDbAfter), sourceSnapshotBefore);
      } finally {
        sourceDbAfter.close();
      }
      assert.equal(statSync(fixture.dbPath).size, sourceStatBefore.size);
    } finally {
      fixture.cleanup();
    }
  });
});

describe("V2 to V3 database migration write mode", () => {
  // @test-value v2
  // kind = "invariant"
  // claim = "V2からV3への移行はsession messageのbookmark stateとblob-backed artifactを維持する"
  // oracle = { type = "contract", ref = "docs/features/message-bookmark-filter.md: V2/V3 migration" }
  // fault = "V2 session sourceのbookmark stateを読み落とすか、V3 targetへの書込時に解除し、またはartifactを失う"
  // observable = "V3 SessionStorageV3のmessage isBookmarkedとmessage artifact"
  // observation_boundary = "public-boundary"
  // scope = "database-v2-to-v3 message bookmark migration"
  // lifecycle = "permanent"
  // impact = "既存利用者の保存済みbookmarkがmigration後に失われる"
  // distinction = "単体storageのroundtripとは別に、V2 sourceからV3 targetまでの変換経路を確認する"
  // @end-test-value
  it("V3 DB と blob store に session/audit/app_settings/model_catalog を移す", async () => {
    const fixture = createV2FixtureDatabase();
    try {
      seedV2Storage(fixture.dbPath);
      const v3DbPath = join(fixture.dirPath, "withmate-v3.db");
      const blobRootPath = join(fixture.dirPath, "blobs");

      const report = await createMigrationWriteReport({
        sourceDatabaseFile: fixture.dbPath,
        targetDatabaseFile: v3DbPath,
        blobRootPath,
      });

      assert.equal(report.mode, "write");
      assert.equal(report.migratedV3Counts.sessions, 1);
      assert.equal(report.migratedV3Counts.sessionMessages, 2);
      assert.equal(report.migratedV3Counts.sessionMessageArtifacts, 1);
      assert.equal(report.migratedV3Counts.auditLogs, 1);
      assert.equal(report.migratedV3Counts.auditLogOperations, 1);
      assert.equal(report.migratedV3Counts.appSettings, 1);
      assert.equal(report.migratedV3Counts.modelCatalogModels, 1);
      assert.equal(report.migratedV3Counts.blobObjects > 0, true);

      const db = new DatabaseSync(v3DbPath, { readOnly: true });
      try {
        for (const statement of CREATE_V3_SCHEMA_SQL) {
          assert.equal(typeof statement, "string");
        }
        assert.equal(readCount(db, "sessions"), 1);
        assert.equal(readCount(db, "session_messages"), 2);
        assert.equal(readCount(db, "audit_logs"), 1);
        assert.equal(readCount(db, "app_settings"), 1);
        assert.equal(readCount(db, "model_catalog_models"), 1);
        assert.equal(readCount(db, "blob_objects") > 0, true);
      } finally {
        db.close();
      }

      const sessionStorage = new SessionStorageV3(v3DbPath, blobRootPath);
      const auditStorage = new AuditLogStorageV3(v3DbPath, blobRootPath);
      try {
        const migratedSession = await sessionStorage.getSession("session-1");
        assert.ok(migratedSession);
        assert.equal(migratedSession.messages.length, 2);
        assert.equal(migratedSession.messages[0]?.isBookmarked, true);
        assert.equal(migratedSession.messages[0]?.text.includes("SENTINEL_V2_TO_V3_BLOB_ONLY:message-tail"), true);
        assert.equal(
          (await sessionStorage.getSessionMessageArtifact("session-1", 1))?.changedFiles[0]?.diffRows[0]?.rightText,
          "SENTINEL_V2_TO_V3_BLOB_ONLY:artifact-diff-tail",
        );

        const page = await auditStorage.listSessionAuditLogSummaryPage("session-1", { cursor: 0, limit: 10 });
        assert.equal(page.entries.length, 1);
        const detail = await auditStorage.getSessionAuditLogDetail("session-1", page.entries[0]?.id ?? -1);
        assert.ok(detail);
        assert.equal(detail.logicalPrompt.systemText, "SENTINEL_V2_TO_V3_BLOB_ONLY:logical-system");
        assert.equal(detail.transportPayload?.fields[0]?.value, "SENTINEL_V2_TO_V3_BLOB_ONLY:transport-field");
        assert.equal(detail.assistantText.includes("SENTINEL_V2_TO_V3_BLOB_ONLY:assistant-tail"), true);
        assert.equal(detail.rawItemsJson.includes("SENTINEL_V2_TO_V3_BLOB_ONLY:raw-item-tail"), true);
        assert.equal(detail.operations[0]?.details?.includes("SENTINEL_V2_TO_V3_BLOB_ONLY:operation-details-tail"), true);

      } finally {
        sessionStorage.close();
        auditStorage.close();
      }
    } finally {
      fixture.cleanup();
    }
  });

  // @test-value v2
  // kind = "contract"
  // claim = "V2からV3への移行は長いSession message/artifact/Audit payloadをSQLite text columnへ戻さずblobへ保持する"
  // oracle = { type = "contract", ref = "scripts/migrate-database-v2-to-v3.ts" }
  // fault = "重いpayloadのtailをV3 SQLite text columnへ保存し、blob-backed storage境界を破る"
  // observable = "V3 SQLite text values and migrated blob-backed detail values"
  // observation_boundary = "public-boundary"
  // scope = "database-v2-to-v3 blob payload boundary"
  // lifecycle = "permanent"
  // @end-test-value
  it("長い message / artifact / audit details / raw items / operation details の sentinel tail を sqlite text columns に残さない", async () => {
    const fixture = createV2FixtureDatabase();
    try {
      const sentinel = "SENTINEL_SQLITE_TEXT_COLUMNS_MUST_NOT_CONTAIN_THIS_TAIL";
      seedV2Storage(fixture.dbPath, sentinel);
      const v3DbPath = join(fixture.dirPath, "withmate-v3.db");
      const blobRootPath = join(fixture.dirPath, "blobs");

      await createMigrationWriteReport({
        sourceDatabaseFile: fixture.dbPath,
        targetDatabaseFile: v3DbPath,
        blobRootPath,
      });

      const db = new DatabaseSync(v3DbPath, { readOnly: true });
      try {
        const textValues = readAllTextValues(db);
        assert.equal(
          textValues.some((value) => value.includes(sentinel)),
          false,
          "sentinel tail must be stored in blobs, not sqlite text columns",
        );
      } finally {
        db.close();
      }

      const sessionStorage = new SessionStorageV3(v3DbPath, blobRootPath);
      const auditStorage = new AuditLogStorageV3(v3DbPath, blobRootPath);
      try {
        const session = await sessionStorage.getSession("session-1");
        assert.ok(session);
        assert.equal(session.messages[0]?.text.includes(`${sentinel}:message-tail`), true);
        assert.equal(
          (await sessionStorage.getSessionMessageArtifact("session-1", 1))?.changedFiles[0]?.diffRows[0]?.rightText,
          `${sentinel}:artifact-diff-tail`,
        );

        const page = await auditStorage.listSessionAuditLogSummaryPage("session-1", { cursor: 0, limit: 1 });
        const detail = await auditStorage.getSessionAuditLogDetail("session-1", page.entries[0]?.id ?? -1);
        assert.ok(detail);
        assert.equal(detail.logicalPrompt.systemText, `${sentinel}:logical-system`);
        assert.equal(detail.assistantText.includes(`${sentinel}:assistant-tail`), true);
        assert.equal(detail.rawItemsJson.includes(`${sentinel}:raw-item-tail`), true);
        assert.equal(detail.operations[0]?.details?.includes(`${sentinel}:operation-details-tail`), true);

      } finally {
        sessionStorage.close();
        auditStorage.close();
      }
    } finally {
      fixture.cleanup();
    }
  });

  // @test-value v2
  // kind = "contract"
  // claim = "V2のlast_active_atとSession orderingはV3 migration後も保持される"
  // oracle = { type = "contract", ref = "scripts/migrate-database-v2-to-v3.ts" }
  // fault = "migration後にSessionの最終利用時刻または一覧順を失う"
  // observable = "V3 session summaries and last_active_at values"
  // observation_boundary = "public-boundary"
  // scope = "database-v2-to-v3 session ordering"
  // lifecycle = "permanent"
  // @end-test-value
  it("V2 の last_active_at と session ordering を V3 に保持する", async () => {
    const fixture = createV2FixtureDatabase();
    try {
      const sessionStorage = new SessionStorageV2(fixture.dbPath);
      try {
        for (const [id, title] of [["session-old", "Old"], ["session-new", "New"]] as const) {
          sessionStorage.upsertSession({
            ...buildNewSession({
              taskTitle: title,
              workspaceLabel: "workspace",
              workspacePath: "/workspace",
              branch: "main",
              characterId: "char",
              character: "Character",
              characterIconPath: "",
              characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
              approvalMode: DEFAULT_APPROVAL_MODE,
            }),
            id,
          });
        }
      } finally {
        sessionStorage.close();
      }
      const sourceDb = new DatabaseSync(fixture.dbPath);
      try {
        sourceDb.prepare("UPDATE sessions SET last_active_at = ? WHERE id = ?").run(100, "session-old");
        sourceDb.prepare("UPDATE sessions SET last_active_at = ? WHERE id = ?").run(200, "session-new");
      } finally {
        sourceDb.close();
      }

      const v3DbPath = join(fixture.dirPath, "withmate-v3.db");
      const blobRootPath = join(fixture.dirPath, "blobs");
      await createMigrationWriteReport({
        sourceDatabaseFile: fixture.dbPath,
        targetDatabaseFile: v3DbPath,
        blobRootPath,
      });

      const storage = new SessionStorageV3(v3DbPath, blobRootPath);
      try {
        assert.deepEqual((await storage.listSessionSummaries()).map((session) => session.id), ["session-new", "session-old"]);
      } finally {
        storage.close();
      }

      const targetDb = new DatabaseSync(v3DbPath, { readOnly: true });
      try {
        assert.equal(
          readRequiredRow<{ last_active_at: number }>(targetDb, "SELECT last_active_at FROM sessions WHERE id = ?", "session-old").last_active_at,
          100,
        );
        assert.equal(
          readRequiredRow<{ last_active_at: number }>(targetDb, "SELECT last_active_at FROM sessions WHERE id = ?", "session-new").last_active_at,
          200,
        );
      } finally {
        targetDb.close();
      }
    } finally {
      fixture.cleanup();
    }
  });

  // @test-value v2
  // kind = "contract"
  // claim = "V2 to V3 writeは既存targetを安全に拒否し、overwrite指定時だけ置換する"
  // oracle = { type = "contract", ref = "scripts/migrate-database-v2-to-v3.ts" }
  // fault = "既存targetを無断上書きするか、overwrite指定でもV3 targetを作成できない"
  // observable = "write rejection and overwrite report/target existence"
  // observation_boundary = "public-boundary"
  // scope = "database-v2-to-v3 overwrite policy"
  // lifecycle = "permanent"
  // @end-test-value
  it("overwrite=false で既存 target があると失敗し、overwrite=true で置き換える", async () => {
    const fixture = createV2FixtureDatabase();
    try {
      seedV2Storage(fixture.dbPath);
      const v3DbPath = join(dirname(fixture.dbPath), "withmate-v3.db");
      const blobRootPath = join(fixture.dirPath, "blobs");

      await createMigrationWriteReport({
        sourceDatabaseFile: fixture.dbPath,
        targetDatabaseFile: v3DbPath,
        blobRootPath,
      });

      const targetBeforeReject = new DatabaseSync(v3DbPath);
      try {
        targetBeforeReject.prepare("UPDATE sessions SET task_title = ? WHERE id = ?").run(
          "stale target marker",
          "session-1",
        );
      } finally {
        targetBeforeReject.close();
      }

      await assert.rejects(
        () =>
          createMigrationWriteReport({
            sourceDatabaseFile: fixture.dbPath,
            targetDatabaseFile: v3DbPath,
            blobRootPath,
          }),
        /V3 database already exists/,
      );

      const rejectedTarget = new DatabaseSync(v3DbPath, { readOnly: true });
      try {
        assert.equal(
          readRequiredRow<{ task_title: string }>(rejectedTarget, "SELECT task_title FROM sessions WHERE id = ?", "session-1").task_title,
          "stale target marker",
        );
      } finally {
        rejectedTarget.close();
      }

      const overwriteReport = await createMigrationWriteReport({
        sourceDatabaseFile: fixture.dbPath,
        targetDatabaseFile: v3DbPath,
        blobRootPath,
        overwrite: true,
      });

      assert.equal(overwriteReport.input.overwrite, true);
      assert.equal(overwriteReport.migratedV3Counts.sessions, 1);
      assert.equal(existsSync(v3DbPath), true);
      assert.equal(existsSync(blobRootPath), true);
      const replacedTarget = new DatabaseSync(v3DbPath, { readOnly: true });
      try {
        assert.equal(
          readRequiredRow<{ task_title: string }>(replacedTarget, "SELECT task_title FROM sessions WHERE id = ?", "session-1").task_title,
          "V2 migration fixture",
        );
      } finally {
        replacedTarget.close();
      }
    } finally {
      fixture.cleanup();
    }
  });
});
