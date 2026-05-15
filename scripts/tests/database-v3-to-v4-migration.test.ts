import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, it } from "node:test";

import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import { buildNewSession } from "../../src/app-state.js";
import { AuditLogStorage } from "../../src-electron/audit-log-storage.js";
import { AuditLogStorageV3 } from "../../src-electron/audit-log-storage-v3.js";
import { CREATE_V3_SCHEMA_SQL, V3_TEXT_PREVIEW_MAX_LENGTH } from "../../src-electron/database-schema-v3.js";
import { isValidV4Database } from "../../src-electron/database-schema-v4.js";
import { SessionStorage } from "../../src-electron/session-storage.js";
import { SessionStorageV3 } from "../../src-electron/session-storage-v3.js";
import {
  createMigrationDryRunReport,
  createMigrationWriteReport,
} from "../migrate-database-v3-to-v4.js";

type Fixture = {
  dirPath: string;
  dbPath: string;
  blobRootPath: string;
  cleanup(): void;
};

function createV3FixtureDatabase(): Fixture {
  const dirPath = mkdtempSync(join(tmpdir(), "withmate-v3-to-v4-"));
  const dbPath = join(dirPath, "withmate-v3.db");
  const blobRootPath = join(dirPath, "blobs", "v3");
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA foreign_keys = ON;");
    for (const statement of CREATE_V3_SCHEMA_SQL) {
      db.exec(statement);
    }
  } finally {
    db.close();
  }

  return {
    dirPath,
    dbPath,
    blobRootPath,
    cleanup: () => rmSync(dirPath, { recursive: true, force: true }),
  };
}

function readRequiredRow<T>(db: DatabaseSync, sql: string, ...params: SQLInputValue[]): T {
  const row = db.prepare(sql).get(...params) as T | undefined;
  assert.ok(row);
  return row;
}

async function seedV3Fixture(fixture: Fixture): Promise<void> {
  const sessionStorage = new SessionStorageV3(fixture.dbPath, fixture.blobRootPath);
  const auditLogStorage = new AuditLogStorageV3(fixture.dbPath, fixture.blobRootPath);
  const session = buildNewSession({
    taskTitle: "V3 import fixture",
    workspaceLabel: "workspace",
    workspacePath: "/workspace",
    branch: "main",
    characterId: "char-v3",
    character: "V3",
    characterIconPath: "",
    characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
    approvalMode: DEFAULT_APPROVAL_MODE,
  });
  const sentinel = "SENTINEL_V3_TO_V4";

  try {
    await sessionStorage.upsertSession({
      ...session,
      id: "session-v3-to-v4",
      threadId: "thread-v3-to-v4",
      messages: [
        { role: "user", text: `${"u".repeat(V3_TEXT_PREVIEW_MAX_LENGTH + 20)}${sentinel}:user` },
        { role: "assistant", text: `${sentinel}:assistant` },
      ],
    });

    await auditLogStorage.createAuditLog({
      sessionId: "session-v3-to-v4",
      createdAt: "2026-05-14T00:00:00.000Z",
      phase: "completed",
      provider: "codex",
      model: "gpt-5.4-mini",
      reasoningEffort: "medium",
      approvalMode: DEFAULT_APPROVAL_MODE,
      threadId: "thread-v3-to-v4",
      logicalPrompt: {
        systemText: `${sentinel}:system`,
        inputText: `${sentinel}:input`,
        composedText: `${sentinel}:system\n${sentinel}:input`,
      },
      transportPayload: {
        summary: `${sentinel}:transport`,
        fields: [],
      },
      assistantText: `${sentinel}:audit-assistant`,
      operations: [{ type: "analysis", summary: "migration", details: `${sentinel}:operation` }],
      rawItemsJson: JSON.stringify([{ type: "message", text: `${sentinel}:raw` }]),
      usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 2 },
      errorMessage: "",
    });
  } finally {
    sessionStorage.close();
    auditLogStorage.close();
  }

  const db = new DatabaseSync(fixture.dbPath);
  try {
    db.prepare("INSERT INTO app_settings (setting_key, setting_value, updated_at) VALUES (?, ?, ?)").run(
      "auto_collapse_action_dock_on_send",
      "true",
      "2026-05-14T00:00:00.000Z",
    );
    db.prepare("INSERT INTO model_catalog_revisions (revision, source, imported_at, is_active) VALUES (?, ?, ?, ?)").run(
      77,
      "fixture",
      "2026-05-14T00:00:00.000Z",
      1,
    );
    db.prepare(
      "INSERT INTO model_catalog_providers (revision, provider_id, label, default_model_id, default_reasoning_effort, sort_order) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(77, "codex", "Codex", "gpt-5.4-mini", "medium", 1);
    db.prepare(
      "INSERT INTO model_catalog_models (revision, provider_id, model_id, label, reasoning_efforts_json, sort_order) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(77, "codex", "gpt-5.4-mini", "GPT 5.4 mini", JSON.stringify(["medium"]), 1);
  } finally {
    db.close();
  }
}

describe("migrate-database-v3-to-v4", () => {
  it("dry-run で v3 から v4 への import 対象件数を返す", async () => {
    const fixture = createV3FixtureDatabase();
    try {
      await seedV3Fixture(fixture);
      const report = createMigrationDryRunReport(fixture.dbPath, { blobRootPath: fixture.blobRootPath });
      assert.equal(report.mode, "dry-run");
      assert.equal(report.v3Counts.sessions, 1);
      assert.equal(report.v3Counts.auditLogs, 1);
      assert.equal(report.plannedV4Counts.appSettings, 1);
      assert.equal(report.input.blobRootPath, fixture.blobRootPath);
    } finally {
      fixture.cleanup();
    }
  });

  it("write で v4 DB を作成し、session / audit / settings / model catalog を import する", async () => {
    const fixture = createV3FixtureDatabase();
    const targetDbPath = join(fixture.dirPath, "withmate-v4.db");
    try {
      await seedV3Fixture(fixture);
      const report = await createMigrationWriteReport({
        sourceDatabaseFile: fixture.dbPath,
        targetDatabaseFile: targetDbPath,
        blobRootPath: fixture.blobRootPath,
      });

      assert.equal(report.mode, "write");
      assert.equal(report.migratedV4Counts.sessions, 1);
      assert.equal(report.migratedV4Counts.auditLogs, 1);
      assert.equal(report.migratedV4Counts.modelCatalogModels, 1);
      assert.equal(isValidV4Database(targetDbPath), true);

      const sessionStorage = new SessionStorage(targetDbPath);
      const auditLogStorage = new AuditLogStorage(targetDbPath);
      const db = new DatabaseSync(targetDbPath);
      try {
        const importedSession = await sessionStorage.getSession("session-v3-to-v4");
        assert.ok(importedSession);
        assert.equal(importedSession.accessMode, "legacy_readonly");
        assert.equal(importedSession.sourceSchemaVersion, 3);
        assert.equal(importedSession.characterIconPath, "");
        assert.match(importedSession.messages[0]?.text ?? "", /SENTINEL_V3_TO_V4:user/);
        const importedLogs = auditLogStorage.listSessionAuditLogs("session-v3-to-v4");
        assert.equal(importedLogs.length, 1);
        assert.match(importedLogs[0]?.assistantText ?? "", /SENTINEL_V3_TO_V4:audit-assistant/);
        const setting = readRequiredRow<{ setting_value: string }>(
          db,
          "SELECT setting_value FROM app_settings WHERE setting_key = ?",
          "auto_collapse_action_dock_on_send",
        );
        assert.equal(setting.setting_value, "true");
        const catalog = readRequiredRow<{ model_id: string }>(
          db,
          "SELECT model_id FROM model_catalog_models WHERE revision = ? AND provider_id = ?",
          77,
          "codex",
        );
        assert.equal(catalog.model_id, "gpt-5.4-mini");
      } finally {
        db.close();
        sessionStorage.close();
        auditLogStorage.close();
      }
    } finally {
      fixture.cleanup();
    }
  });

  it("write 失敗時は中途半端な v4 DB を残さない", async () => {
    const fixture = createV3FixtureDatabase();
    const targetDbPath = join(fixture.dirPath, "withmate-v4.db");
    try {
      await seedV3Fixture(fixture);
      rmSync(fixture.blobRootPath, { recursive: true, force: true });
      await assert.rejects(
        () => createMigrationWriteReport({
          sourceDatabaseFile: fixture.dbPath,
          targetDatabaseFile: targetDbPath,
          blobRootPath: fixture.blobRootPath,
        }),
        /blob|ENOENT|no such file/i,
      );
      assert.equal(existsSync(targetDbPath), false);
      assert.equal(existsSync(`${targetDbPath}-wal`), false);
      assert.equal(existsSync(`${targetDbPath}-shm`), false);
    } finally {
      fixture.cleanup();
    }
  });
});
