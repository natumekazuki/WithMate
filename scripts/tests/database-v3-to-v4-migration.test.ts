import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, it } from "node:test";

import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import { buildNewSession } from "../../src/app-state.js";
import type { CompanionGroup, CompanionMergeRun, CompanionSession } from "../../src/companion-state.js";
import { DEFAULT_CODEX_SANDBOX_MODE } from "../../src/codex-sandbox-mode.js";
import { DEFAULT_CATALOG_REVISION, DEFAULT_MODEL_ID, DEFAULT_REASONING_EFFORT } from "../../src/model-catalog.js";
import { AuditLogStorage } from "../../src-electron/audit-log-storage.js";
import { AuditLogStorageV3 } from "../../src-electron/audit-log-storage-v3.js";
import { CompanionAuditLogStorageV3 } from "../../src-electron/companion-audit-log-storage-v3.js";
import { CompanionStorage } from "../../src-electron/companion-storage.js";
import { CompanionStorageV3 } from "../../src-electron/companion-storage-v3.js";
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

function createCompanionGroup(): CompanionGroup {
  return {
    id: "companion-group-v3-to-v4",
    repoRoot: "/workspace",
    displayName: "workspace",
    createdAt: "2026-05-14T00:00:00.000Z",
    updatedAt: "2026-05-14T00:00:00.000Z",
  };
}

function createCompanionSession(groupId: string): CompanionSession {
  return {
    id: "companion-session-v3-to-v4",
    groupId,
    taskTitle: "Companion import fixture",
    status: "active",
    repoRoot: "/workspace",
    focusPath: "src",
    targetBranch: "main",
    baseSnapshotRef: "refs/withmate/companion/companion-session-v3-to-v4/base",
    baseSnapshotCommit: "abc123",
    companionBranch: "withmate/companion/companion-session-v3-to-v4",
    worktreePath: "/workspace/.withmate/companion-session-v3-to-v4",
    selectedPaths: ["src/index.ts"],
    changedFiles: [{ kind: "edit", path: "src/index.ts" }],
    siblingWarnings: [],
    allowedAdditionalDirectories: ["/shared/context"],
    runState: "running",
    threadId: "companion-thread-v3-to-v4",
    provider: "codex",
    catalogRevision: DEFAULT_CATALOG_REVISION,
    model: DEFAULT_MODEL_ID,
    reasoningEffort: DEFAULT_REASONING_EFFORT,
    customAgentName: "",
    approvalMode: DEFAULT_APPROVAL_MODE,
    codexSandboxMode: DEFAULT_CODEX_SANDBOX_MODE,
    characterId: "char-v3",
    character: "V3 Companion",
    characterRoleMarkdown: "Companion role markdown",
    characterIconPath: "legacy-companion-icon.png",
    characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
    createdAt: "2026-05-14T00:01:00.000Z",
    updatedAt: "2026-05-14T00:02:00.000Z",
    messages: [
      { role: "user", text: "companion user" },
      { role: "assistant", text: "SENTINEL_COMPANION_V3_TO_V4" },
    ],
  };
}

function createCompanionMergeRun(groupId: string): CompanionMergeRun {
  return {
    id: "companion-merge-run-v3-to-v4",
    sessionId: "companion-session-v3-to-v4",
    groupId,
    operation: "merge",
    selectedPaths: ["src/index.ts"],
    changedFiles: [{ kind: "edit", path: "src/index.ts" }],
    diffSnapshot: [
      {
        kind: "edit",
        path: "src/index.ts",
        summary: "src/index.ts を更新",
        diffRows: [{ kind: "add", rightNumber: 1, rightText: "updated" }],
      },
    ],
    siblingWarnings: [],
    createdAt: "2026-05-14T00:03:00.000Z",
  };
}

async function seedV3Fixture(fixture: Fixture): Promise<void> {
  const sessionStorage = new SessionStorageV3(fixture.dbPath, fixture.blobRootPath);
  const auditLogStorage = new AuditLogStorageV3(fixture.dbPath, fixture.blobRootPath);
  const companionStorage = new CompanionStorageV3(fixture.dbPath, fixture.blobRootPath);
  const companionAuditLogStorage = new CompanionAuditLogStorageV3(fixture.dbPath, fixture.blobRootPath);
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

    const companionGroup = createCompanionGroup();
    const companionSession = createCompanionSession(companionGroup.id);
    await companionStorage.ensureGroup(companionGroup);
    await companionStorage.createSession(companionSession);
    await companionStorage.createMergeRun(createCompanionMergeRun(companionGroup.id));
    await companionAuditLogStorage.createAuditLog({
      sessionId: companionSession.id,
      createdAt: "2026-05-14T00:04:00.000Z",
      phase: "completed",
      provider: "codex",
      model: "gpt-5.4-mini",
      reasoningEffort: "medium",
      approvalMode: DEFAULT_APPROVAL_MODE,
      threadId: "companion-thread-v3-to-v4",
      logicalPrompt: {
        systemText: "SENTINEL_COMPANION_V3_TO_V4:system",
        inputText: "SENTINEL_COMPANION_V3_TO_V4:input",
        composedText: "SENTINEL_COMPANION_V3_TO_V4:system\nSENTINEL_COMPANION_V3_TO_V4:input",
      },
      transportPayload: {
        summary: "SENTINEL_COMPANION_V3_TO_V4:transport",
        fields: [],
      },
      assistantText: "SENTINEL_COMPANION_V3_TO_V4:audit-assistant",
      operations: [{ type: "analysis", summary: "companion migration", details: "SENTINEL_COMPANION_V3_TO_V4:operation" }],
      rawItemsJson: JSON.stringify([{ type: "message", text: "SENTINEL_COMPANION_V3_TO_V4:raw" }]),
      usage: { inputTokens: 3, cachedInputTokens: 0, outputTokens: 4 },
      errorMessage: "",
    });
  } finally {
    sessionStorage.close();
    auditLogStorage.close();
    companionStorage.close();
    companionAuditLogStorage.close();
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
      assert.equal(report.v3Counts.companionSessions, 1);
      assert.equal(report.v3Counts.companionAuditLogs, 1);
      assert.equal(report.plannedV4Counts.appSettings, 1);
      assert.equal(report.input.blobRootPath, fixture.blobRootPath);
    } finally {
      fixture.cleanup();
    }
  });

  it("write で v4 DB を作成し、session / audit / settings / model catalog を import する", async () => {
    const fixture = createV3FixtureDatabase();
    const targetDirPath = mkdtempSync(join(tmpdir(), "withmate-v3-to-v4-target-"));
    const targetDbPath = join(targetDirPath, "withmate-v4.db");
    const targetBlobRootPath = join(targetDirPath, "blobs", "v3");
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
      assert.equal(report.migratedV4Counts.companionGroups, 1);
      assert.equal(report.migratedV4Counts.companionSessions, 1);
      assert.equal(report.migratedV4Counts.companionMessages, 2);
      assert.equal(report.migratedV4Counts.companionMergeRuns, 1);
      assert.equal(report.migratedV4Counts.companionAuditLogs, 1);
      assert.equal(report.migratedV4Counts.modelCatalogModels, 1);
      assert.equal(isValidV4Database(targetDbPath), true);
      assert.equal(
        readdirSync(targetDirPath).some((entry) => entry.includes("withmate-v4.db.migration-")),
        false,
      );

      const sessionStorage = new SessionStorage(targetDbPath);
      const auditLogStorage = new AuditLogStorage(targetDbPath);
      const companionStorage = new CompanionStorage(targetDbPath);
      const companionAuditLogStorage = new CompanionAuditLogStorageV3(targetDbPath, targetBlobRootPath);
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
        const importedCompanionSession = await companionStorage.getSession("companion-session-v3-to-v4");
        assert.ok(importedCompanionSession);
        assert.equal(importedCompanionSession.runState, "idle");
        assert.equal(importedCompanionSession.characterIconPath, "");
        assert.match(importedCompanionSession.messages[1]?.text ?? "", /SENTINEL_COMPANION_V3_TO_V4/);
        const importedCompanionMergeRuns = await companionStorage.listMergeRunsForSession("companion-session-v3-to-v4");
        assert.equal(importedCompanionMergeRuns.length, 1);
        const importedCompanionAuditLogs = await companionAuditLogStorage.listSessionAuditLogs("companion-session-v3-to-v4");
        assert.equal(importedCompanionAuditLogs.length, 1);
        assert.match(importedCompanionAuditLogs[0]?.assistantText ?? "", /SENTINEL_COMPANION_V3_TO_V4:audit-assistant/);
        assert.equal(existsSync(targetBlobRootPath), true);
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
        companionStorage.close();
        companionAuditLogStorage.close();
      }
    } finally {
      fixture.cleanup();
      rmSync(targetDirPath, { recursive: true, force: true });
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
      assert.equal(
        readdirSync(fixture.dirPath).some((entry) => entry.includes("withmate-v4.db.migration-")),
        false,
      );
    } finally {
      fixture.cleanup();
    }
  });
});
