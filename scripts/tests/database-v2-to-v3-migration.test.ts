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
import { CompanionStorage } from "../../src-electron/companion-storage.js";
import { CompanionStorageV3 } from "../../src-electron/companion-storage-v3.js";
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
  const companionStorage = new CompanionStorage(dbPath);
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
        { role: "user", text: longMessage },
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

    const companionGroup = companionStorage.ensureGroup({
      id: "companion-group-1",
      repoRoot: "/workspace",
      displayName: "workspace",
      createdAt: "2026-04-28T02:00:00.000Z",
      updatedAt: "2026-04-28T02:00:00.000Z",
    });
    const companionSession = companionStorage.createSession({
      id: "companion-session-1",
      groupId: companionGroup.id,
      taskTitle: "V2 companion fixture",
      status: "active",
      repoRoot: "/workspace",
      focusPath: "src",
      targetBranch: "main",
      baseSnapshotRef: "refs/withmate/base",
      baseSnapshotCommit: "abc123",
      companionBranch: "withmate/companion/session-1",
      worktreePath: "/workspace/.withmate/companion/session-1",
      selectedPaths: ["src/index.ts"],
      changedFiles: [{ path: "src/index.ts", kind: "edit" }],
      siblingWarnings: [],
      allowedAdditionalDirectories: [],
      runState: "idle",
      threadId: "companion-thread-1",
      provider: "codex",
      catalogRevision: 1,
      model: "gpt-5.4-mini",
      reasoningEffort: "medium",
      customAgentName: "",
      approvalMode: DEFAULT_APPROVAL_MODE,
      codexSandboxMode: "workspace-write",
      characterId: "companion-char",
      character: "Companion",
      characterRoleMarkdown: `${"role ".repeat(160)}${sentinel}:companion-role-tail`,
      characterIconPath: "",
      characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
      createdAt: "2026-04-28T02:01:00.000Z",
      updatedAt: "2026-04-28T02:01:00.000Z",
      messages: [
        {
          role: "assistant",
          text: `${"c".repeat(V3_TEXT_PREVIEW_MAX_LENGTH + 20)}${sentinel}:companion-message-tail`,
          artifact: createArtifact(`${sentinel}:companion`),
        },
      ],
    });
    companionStorage.createMergeRun({
      id: "companion-merge-1",
      sessionId: companionSession.id,
      groupId: companionGroup.id,
      operation: "merge",
      selectedPaths: ["src/index.ts"],
      changedFiles: [{ path: "src/index.ts", kind: "edit" }],
      diffSnapshot: [
        {
          kind: "edit",
          path: "src/index.ts",
          summary: "companion diff",
          diffRows: [{ kind: "add", rightNumber: 1, rightText: `${sentinel}:companion-diff-tail` }],
        },
      ],
      siblingWarnings: [],
      createdAt: "2026-04-28T02:02:00.000Z",
    });
  } finally {
    sessionStorage.close();
    auditStorage.close();
    companionStorage.close();
  }

  insertAppSettingsAndModelCatalog(dbPath);
}

describe("V2 to V3 database migration dry-run", () => {
  it("V2 source を変更せず件数と estimate bytes を返す", () => {
    const fixture = createV2FixtureDatabase();
    try {
      seedV2Storage(fixture.dbPath);
      checkpointAndRemoveSqliteSidecars(fixture.dbPath);
      const sourceStatBefore = statSync(fixture.dbPath);
      const sourceDbBefore = new DatabaseSync(fixture.dbPath, { readOnly: true });
      let sessionCountBefore = 0;
      try {
        sessionCountBefore = readCount(sourceDbBefore, "sessions");
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
        companionGroups: 1,
        companionSessions: 1,
        companionMessages: 1,
        companionMessageArtifacts: 1,
        companionMergeRuns: 1,
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
      assert.equal(report.migratedV3Counts.companionGroups, 1);
      assert.equal(report.migratedV3Counts.companionSessions, 1);
      assert.equal(report.migratedV3Counts.companionMessages, 1);
      assert.equal(report.migratedV3Counts.companionMessageArtifacts, 1);
      assert.equal(report.migratedV3Counts.companionMergeRuns, 1);
      assert.equal(report.migratedV3Counts.appSettings, 1);
      assert.equal(report.migratedV3Counts.modelCatalogModels, 1);
      assert.equal(report.migratedV3Counts.blobObjects > 0, true);

      const db = new DatabaseSync(v3DbPath, { readOnly: true });
      try {
        for (const statement of CREATE_V3_SCHEMA_SQL) {
          assert.equal(typeof statement, "string");
        }
        assert.equal(tableExists(db, "companion_sessions"), true);
        assert.equal(readCount(db, "companion_groups"), 1);
        assert.equal(readCount(db, "companion_sessions"), 1);
        assert.equal(readCount(db, "companion_messages"), 1);
        assert.equal(readCount(db, "companion_message_artifacts"), 1);
        assert.equal(readCount(db, "companion_merge_runs"), 1);
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
      const companionStorage = new CompanionStorageV3(v3DbPath, blobRootPath);
      try {
        const migratedSession = await sessionStorage.getSession("session-1");
        assert.ok(migratedSession);
        assert.equal(migratedSession.messages.length, 2);
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

        const migratedCompanion = await companionStorage.getSession("companion-session-1");
        assert.ok(migratedCompanion);
        assert.equal(migratedCompanion.messages[0]?.text.includes("SENTINEL_V2_TO_V3_BLOB_ONLY:companion-message-tail"), true);
        assert.equal(
          (await companionStorage.getMessageArtifact("companion-session-1", 0))?.changedFiles[0]?.diffRows[0]?.rightText,
          "SENTINEL_V2_TO_V3_BLOB_ONLY:companion:artifact-diff-tail",
        );
        const mergeRuns = await companionStorage.listMergeRunsForSession("companion-session-1");
        assert.equal(mergeRuns[0]?.diffSnapshot[0]?.diffRows[0]?.rightText, "SENTINEL_V2_TO_V3_BLOB_ONLY:companion-diff-tail");
      } finally {
        sessionStorage.close();
        auditStorage.close();
        companionStorage.close();
      }
    } finally {
      fixture.cleanup();
    }
  });

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
      const companionStorage = new CompanionStorageV3(v3DbPath, blobRootPath);
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

        const companion = await companionStorage.getSession("companion-session-1");
        assert.ok(companion);
        assert.equal(companion.characterRoleMarkdown.endsWith(`${sentinel}:companion-role-tail`), true);
        assert.equal(companion.messages[0]?.text.includes(`${sentinel}:companion-message-tail`), true);
        assert.equal(
          (await companionStorage.getMessageArtifact("companion-session-1", 0))?.changedFiles[0]?.diffRows[0]?.rightText,
          `${sentinel}:companion:artifact-diff-tail`,
        );
        assert.equal(
          (await companionStorage.listMergeRunsForSession("companion-session-1"))[0]?.diffSnapshot[0]?.diffRows[0]?.rightText,
          `${sentinel}:companion-diff-tail`,
        );
      } finally {
        sessionStorage.close();
        auditStorage.close();
        companionStorage.close();
      }
    } finally {
      fixture.cleanup();
    }
  });

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

      await assert.rejects(
        () =>
          createMigrationWriteReport({
            sourceDatabaseFile: fixture.dbPath,
            targetDatabaseFile: v3DbPath,
            blobRootPath,
          }),
        /V3 database already exists/,
      );

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
    } finally {
      fixture.cleanup();
    }
  });
});
