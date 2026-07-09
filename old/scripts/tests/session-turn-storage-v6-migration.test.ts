import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { createOrVerifyV6FreshDatabase } from "../../src-electron/app-database-v6-bootstrap.js";
import { AuditLogStorageV6 } from "../../src-electron/audit-log-storage-v6.js";
import { CREATE_V6_AUDIT_EVENTS_TABLE_SQL } from "../../src-electron/database-schema-v6.js";
import { createSessionTurnStorageV6DryRunReport, migrateSessionTurnStorageV6 } from "../migrate-session-turn-storage-v6.js";

function insertSession(db: DatabaseSync): void {
  db.prepare(`
    INSERT INTO sessions_v6 (
      id,
      title,
      state,
      provider_id,
      catalog_revision,
      model_id,
      approval_mode,
      created_at,
      updated_at,
      last_active_at
    ) VALUES (?, ?, 'active', 'codex', 1, 'gpt-5', 'on-request', ?, ?, ?)
  `).run(
    "session-1",
    "Session 1",
    "2026-07-05T00:00:00.000Z",
    "2026-07-05T00:00:00.000Z",
    "2026-07-05T00:00:00.000Z",
  );

  db.prepare(`
    INSERT INTO session_messages_v6 (
      session_id,
      seq,
      role,
      body,
      artifact_body,
      created_at
    ) VALUES (?, ?, ?, ?, NULL, ?)
  `).run("session-1", 0, "assistant", "final ok", "2026-07-05T00:01:00.000Z");
}

function insertAuxiliarySession(db: DatabaseSync): void {
  db.prepare(`
    INSERT INTO auxiliary_sessions (
      id,
      parent_session_id,
      status,
      created_at,
      updated_at,
      payload_json
    ) VALUES (?, ?, 'active', ?, ?, ?)
  `).run(
    "aux-1",
    "session-1",
    "2026-07-05T00:00:30.000Z",
    "2026-07-05T00:00:30.000Z",
    "{}",
  );
}

function insertAssistantMessage(db: DatabaseSync, seq: number, body: string, createdAt: string): void {
  db.prepare(`
    INSERT INTO session_messages_v6 (
      session_id,
      seq,
      role,
      body,
      artifact_body,
      created_at
    ) VALUES (?, ?, 'assistant', ?, NULL, ?)
  `).run("session-1", seq, body, createdAt);
}

function insertAuditRow(
  db: DatabaseSync,
  input: {
    sessionId: string | null;
    auxiliarySessionId?: string | null;
    metadataJson: string;
    createdAt: string;
  },
): void {
  db.prepare(`
    INSERT INTO audit_events_v6 (
      session_id,
      auxiliary_session_id,
      event_type,
      provider_id,
      summary,
      metadata_json,
      created_at
    ) VALUES (?, ?, 'session_turn', 'codex', 'summary', ?, ?)
  `).run(input.sessionId, input.auxiliarySessionId ?? null, input.metadataJson, input.createdAt);
}

function createLegacyAuditEventsTableWithoutAuxiliarySessionId(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE audit_events_v6 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      event_type TEXT NOT NULL CHECK (event_type IN (
        'session_turn',
        'memory_mutation',
        'runtime_binding',
        'diagnostic'
      )),
      provider_id TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions_v6(id) ON DELETE SET NULL
    );

    CREATE INDEX idx_v6_audit_events_session_created
      ON audit_events_v6(session_id, created_at DESC, id DESC);

    CREATE INDEX idx_v6_audit_events_type_created
      ON audit_events_v6(event_type, created_at DESC);
  `);
}

function metadata(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    phase: "completed",
    provider: "codex",
    model: "gpt-5",
    reasoningEffort: "medium",
    approvalMode: "on-request",
    threadId: "thread-1",
    logicalPrompt: null,
    transportPayload: null,
    assistantText: "",
    operations: [],
    rawItemsJson: "",
    usage: null,
    errorMessage: "",
    ...overrides,
  });
}

function tableExists(db: DatabaseSync, tableName: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?").get(tableName) as
    | { name?: string }
    | undefined;
  return row?.name === tableName;
}

describe("session turn storage v6 migration dry-run", () => {
  it("audit_events_v6 の session_turn payload を final/interim/provider output へ再分類して報告する", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-session-turn-migration-"));
    try {
      const { dbPath } = await createOrVerifyV6FreshDatabase(userDataPath);
      const db = new DatabaseSync(dbPath);
      try {
        db.exec("PRAGMA foreign_keys = ON;");
        db.exec(CREATE_V6_AUDIT_EVENTS_TABLE_SQL);
        insertSession(db);
        insertAuditRow(db, {
          sessionId: "session-1",
          createdAt: "2026-07-05T00:02:00.000Z",
          metadataJson: metadata({
            assistantText: "final ok",
            logicalPrompt: { systemText: "system", inputText: "input", composedText: "composed" },
            transportPayload: { summary: "request", fields: [{ label: "model", value: "gpt-5" }] },
            operations: [
              { type: "shell", summary: "npm test", details: "ok" },
              { type: "tool", summary: "read file", details: "ok" },
            ],
            rawItemsJson: "[{\"type\":\"message\"}]",
            providerMetadata: [{ summary: "Unsupported event", provider: "codex", type: "unknown.item" }],
            usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5 },
          }),
        });
        insertAuditRow(db, {
          sessionId: "session-1",
          createdAt: "2026-07-05T00:03:00.000Z",
          metadataJson: metadata({ assistantText: "not in timeline" }),
        });
        insertAuditRow(db, {
          sessionId: "session-1",
          createdAt: "2026-07-05T00:04:00.000Z",
          metadataJson: metadata({ phase: "running", assistantText: "thinking" }),
        });
        insertAuditRow(db, {
          sessionId: "session-1",
          createdAt: "2026-07-05T00:05:00.000Z",
          metadataJson: metadata({ phase: "failed", assistantText: "partial", errorMessage: "boom" }),
        });
        insertAuditRow(db, {
          sessionId: "session-1",
          createdAt: "2026-07-05T00:06:00.000Z",
          metadataJson: metadata({ phase: "background-canceled", assistantText: "background partial" }),
        });
        insertAuditRow(db, {
          sessionId: "session-1",
          createdAt: "2026-07-05T00:07:00.000Z",
          metadataJson: "{",
        });
        insertAuditRow(db, {
          sessionId: null,
          createdAt: "2026-07-05T00:08:00.000Z",
          metadataJson: metadata({ phase: "completed", assistantText: "orphan" }),
        });
      } finally {
        db.close();
      }

      const report = createSessionTurnStorageV6DryRunReport(dbPath);

      assert.equal(report.mode, "dry-run");
      assert.equal(report.sourceCounts.auditSessionTurnRows, 7);
      assert.equal(report.sourceCounts.auditEventRows, 7);
      assert.equal(report.sourceCounts.existingSessionTurnRows, 0);
      assert.deepEqual(report.sourceCounts.legacyTables, []);
      assert.equal(report.plannedCounts.sessionTurns, 5);
      assert.equal(report.plannedCounts.mainAssistantMessages, 0);
      assert.equal(report.plannedCounts.interims, 1);
      assert.equal(report.plannedCounts.providerOutputs, 12);
      assert.deepEqual(report.plannedCounts.providerOutputsByKind, {
        operation: 2,
        raw_items: 1,
        usage: 1,
        logical_prompt: 1,
        transport_payload: 1,
        provider_error: 1,
        legacy_assistant_text: 4,
        quota: 0,
        context_telemetry: 0,
        background_task: 0,
        provider_metadata: 1,
      });
      assert.deepEqual(report.assistantText, {
        completedMatchedFinalMessages: 1,
        completedUnmatchedFinalMessages: 1,
        runningSnapshots: 1,
        terminalPartialResponses: 2,
        empty: 0,
      });
      assert.deepEqual(report.skipped, {
        invalidMetadataJson: 1,
        nonSessionTurnRows: 0,
        orphanTurnRows: 1,
      });
      assert.deepEqual(report.cleanupCandidates, {
        dropAuditEventsV6: false,
        dropLegacyTables: [],
      });
      assert.equal(report.caveats.some((caveat) => caveat.includes("stream delta chunk boundaries")), true);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("write mode は turn storage へ移行し、audit_events_v6 と legacy Memory table を削除する", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-session-turn-migration-"));
    try {
      const { dbPath } = await createOrVerifyV6FreshDatabase(userDataPath);
      const db = new DatabaseSync(dbPath);
      try {
        db.exec("PRAGMA foreign_keys = ON;");
        db.exec(CREATE_V6_AUDIT_EVENTS_TABLE_SQL);
        db.exec("CREATE TABLE companion_groups (id TEXT PRIMARY KEY);");
        db.exec("CREATE TABLE project_memory_entries (id TEXT PRIMARY KEY);");
        insertSession(db);
        insertAuxiliarySession(db);
        insertAuditRow(db, {
          sessionId: "session-1",
          createdAt: "2026-07-05T00:02:00.000Z",
          metadataJson: metadata({
            assistantText: "final ok",
            operations: [{ type: "shell", summary: "npm test", details: "ok" }],
          }),
        });
        insertAuditRow(db, {
          sessionId: "session-1",
          createdAt: "2026-07-05T00:03:00.000Z",
          metadataJson: metadata({
            assistantText: "new final",
            providerMetadata: [{ summary: "Unsupported event", provider: "codex", type: "unknown.item" }],
          }),
        });
        insertAuditRow(db, {
          sessionId: null,
          auxiliarySessionId: "aux-1",
          createdAt: "2026-07-05T00:04:00.000Z",
          metadataJson: metadata({ assistantText: "aux final" }),
        });
      } finally {
        db.close();
      }

      const report = migrateSessionTurnStorageV6(dbPath, "2026-07-05T01:00:00.000Z");
      assert.equal(report.mode, "write");
      assert.equal(report.plannedCounts.sessionTurns, 3);
      assert.equal(report.skipped.nonSessionTurnRows, 0);
      assert.equal(report.skipped.orphanTurnRows, 0);

      const migratedDb = new DatabaseSync(dbPath, { readOnly: true });
      try {
        assert.equal(tableExists(migratedDb, "audit_events_v6"), false);
        assert.equal(tableExists(migratedDb, "project_memory_entries"), false);
        assert.equal(tableExists(migratedDb, "companion_groups"), true);
        assert.equal(
          (migratedDb.prepare("SELECT COUNT(*) AS count FROM session_turns_v6").get() as { count: number }).count,
          3,
        );
        assert.equal(
          (migratedDb.prepare("SELECT COUNT(*) AS count FROM session_messages_v6 WHERE role = 'assistant'").get() as
            { count: number }).count,
          1,
        );
        assert.equal(
          (migratedDb.prepare("SELECT setting_value FROM app_settings WHERE setting_key = ?").get(
            "session_turn_storage_v6_migrated_at",
          ) as { setting_value: string } | undefined)?.setting_value,
          "2026-07-05T01:00:00.000Z",
        );
      } finally {
        migratedDb.close();
      }

      const auditStorage = new AuditLogStorageV6(dbPath);
      try {
        const summaries = auditStorage.listSessionAuditLogSummaries("session-1");
        assert.deepEqual(
          summaries.map((summary) => summary.assistantTextPreview),
          ["aux final", "new final", "final ok"],
        );
        const newFinalSummary = summaries.find((summary) => summary.assistantTextPreview === "new final");
        const newFinalDetail = auditStorage.getSessionAuditLogDetail("session-1", newFinalSummary?.id ?? -1);
        assert.equal(newFinalDetail?.assistantText, "new final");
        assert.deepEqual(newFinalDetail?.providerMetadata, [{
          summary: "Unsupported event",
          provider: "codex",
          type: "unknown.item",
        }]);
        const newestDetail = auditStorage.getSessionAuditLogDetail("session-1", summaries[0]?.id ?? -1);
        assert.equal(newestDetail?.sessionId, "aux-1");
        assert.equal(newestDetail?.assistantText, "aux final");
        const auxiliarySummaries = auditStorage.listSessionAuditLogSummaries("aux-1");
        assert.deepEqual(
          auxiliarySummaries.map((summary) => summary.assistantTextPreview),
          ["aux final"],
        );
        const auxiliaryDetail = auditStorage.getSessionAuditLogDetail("aux-1", auxiliarySummaries[0]?.id ?? -1);
        assert.equal(auxiliaryDetail?.assistantText, "aux final");
      } finally {
        auditStorage.close();
      }
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("write mode は skipped row がある場合も valid row を非破壊移行して source table と marker 未設定を残す", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-session-turn-migration-"));
    try {
      const { dbPath } = await createOrVerifyV6FreshDatabase(userDataPath);
      const db = new DatabaseSync(dbPath);
      try {
        db.exec("PRAGMA foreign_keys = ON;");
        db.exec(CREATE_V6_AUDIT_EVENTS_TABLE_SQL);
        insertSession(db);
        insertAuditRow(db, {
          sessionId: "session-1",
          createdAt: "2026-07-05T00:02:00.000Z",
          metadataJson: metadata({ assistantText: "final ok" }),
        });
        insertAuditRow(db, {
          sessionId: null,
          createdAt: "2026-07-05T00:03:00.000Z",
          metadataJson: metadata({ assistantText: "orphan" }),
        });
      } finally {
        db.close();
      }

      const report = migrateSessionTurnStorageV6(dbPath, "2026-07-05T01:00:00.000Z");
      assert.equal(report.mode, "write");
      assert.equal(report.plannedCounts.sessionTurns, 1);
      assert.equal(report.skipped.orphanTurnRows, 1);

      const migratedDb = new DatabaseSync(dbPath, { readOnly: true });
      try {
        assert.equal(tableExists(migratedDb, "audit_events_v6"), true);
        assert.equal(
          (migratedDb.prepare("SELECT COUNT(*) AS count FROM session_turns_v6").get() as { count: number }).count,
          1,
        );
        assert.equal(
          migratedDb.prepare("SELECT setting_value FROM app_settings WHERE setting_key = ?").get(
            "session_turn_storage_v6_migrated_at",
          ),
          undefined,
        );
      } finally {
        migratedDb.close();
      }

      const auditStorage = new AuditLogStorageV6(dbPath);
      try {
        const summaries = auditStorage.listSessionAuditLogSummaries("session-1");
        assert.deepEqual(
          summaries.map((summary) => summary.assistantTextPreview),
          ["final ok"],
        );
        assert.equal(auditStorage.getSessionAuditLogDetail("session-1", summaries[0]?.id ?? -1)?.assistantText, "final ok");
      } finally {
        auditStorage.close();
      }

      const repairedDb = new DatabaseSync(dbPath);
      try {
        repairedDb.prepare("DELETE FROM audit_events_v6 WHERE session_id IS NULL AND auxiliary_session_id IS NULL").run();
      } finally {
        repairedDb.close();
      }

      const finalizedReport = migrateSessionTurnStorageV6(dbPath, "2026-07-05T02:00:00.000Z");
      assert.equal(finalizedReport.mode, "write");
      assert.equal(finalizedReport.skipped.orphanTurnRows, 0);

      const finalizedDb = new DatabaseSync(dbPath, { readOnly: true });
      try {
        assert.equal(tableExists(finalizedDb, "audit_events_v6"), false);
        assert.equal(
          (finalizedDb.prepare("SELECT COUNT(*) AS count FROM session_turns_v6").get() as { count: number }).count,
          1,
        );
        const markerRow = finalizedDb.prepare("SELECT setting_value FROM app_settings WHERE setting_key = ?").get(
            "session_turn_storage_v6_migrated_at",
          ) as { setting_value: string } | undefined;
        assert.equal(markerRow?.setting_value, "2026-07-05T02:00:00.000Z");
      } finally {
        finalizedDb.close();
      }
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("write mode は auxiliary_session_id がない旧 audit_events_v6 も main session row として移行する", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-session-turn-migration-"));
    try {
      const { dbPath } = await createOrVerifyV6FreshDatabase(userDataPath);
      const db = new DatabaseSync(dbPath);
      try {
        db.exec("PRAGMA foreign_keys = ON;");
        createLegacyAuditEventsTableWithoutAuxiliarySessionId(db);
        insertSession(db);
        db.prepare(`
          INSERT INTO audit_events_v6 (
            session_id,
            event_type,
            provider_id,
            summary,
            metadata_json,
            created_at
          ) VALUES (?, 'session_turn', 'codex', 'summary', ?, ?)
        `).run(
          "session-1",
          metadata({ assistantText: "legacy final" }),
          "2026-07-05T00:02:00.000Z",
        );
      } finally {
        db.close();
      }

      const report = migrateSessionTurnStorageV6(dbPath, "2026-07-05T01:00:00.000Z");
      assert.equal(report.plannedCounts.sessionTurns, 1);

      const migratedDb = new DatabaseSync(dbPath, { readOnly: true });
      try {
        assert.equal(tableExists(migratedDb, "audit_events_v6"), false);
        const migratedTurnRow = migratedDb.prepare(`
            SELECT session_id, auxiliary_session_id
            FROM session_turns_v6
          `).get() as { session_id: string; auxiliary_session_id: string | null } | undefined;
        assert.equal(migratedTurnRow?.session_id, "session-1");
        assert.equal(migratedTurnRow?.auxiliary_session_id, null);
      } finally {
        migratedDb.close();
      }
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("write mode は未移行の non-session_turn audit row がある場合も valid row を非破壊移行する", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-session-turn-migration-"));
    try {
      const { dbPath } = await createOrVerifyV6FreshDatabase(userDataPath);
      const db = new DatabaseSync(dbPath);
      try {
        db.exec("PRAGMA foreign_keys = ON;");
        db.exec(CREATE_V6_AUDIT_EVENTS_TABLE_SQL);
        insertSession(db);
        insertAuditRow(db, {
          sessionId: "session-1",
          createdAt: "2026-07-05T00:02:00.000Z",
          metadataJson: metadata({ assistantText: "final ok" }),
        });
        db.prepare(`
          INSERT INTO audit_events_v6 (
            session_id,
            auxiliary_session_id,
            event_type,
            provider_id,
            summary,
            metadata_json,
            created_at
          ) VALUES (?, NULL, 'diagnostic', 'system', 'diagnostic', '{}', ?)
        `).run("session-1", "2026-07-05T00:03:00.000Z");
      } finally {
        db.close();
      }

      const report = createSessionTurnStorageV6DryRunReport(dbPath);
      assert.equal(report.skipped.nonSessionTurnRows, 1);
      assert.equal(report.cleanupCandidates.dropAuditEventsV6, false);

      const writeReport = migrateSessionTurnStorageV6(dbPath, "2026-07-05T01:00:00.000Z");
      assert.equal(writeReport.mode, "write");
      assert.equal(writeReport.skipped.nonSessionTurnRows, 1);

      const migratedDb = new DatabaseSync(dbPath, { readOnly: true });
      try {
        assert.equal(tableExists(migratedDb, "audit_events_v6"), true);
        assert.equal(
          (migratedDb.prepare("SELECT COUNT(*) AS count FROM session_turns_v6").get() as { count: number }).count,
          1,
        );
        assert.equal(
          migratedDb.prepare("SELECT setting_value FROM app_settings WHERE setting_key = ?").get(
            "session_turn_storage_v6_migrated_at",
          ),
          undefined,
        );
      } finally {
        migratedDb.close();
      }
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("write mode が拒否された場合は cleanup table を削除しない", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-session-turn-migration-"));
    try {
      const { dbPath } = await createOrVerifyV6FreshDatabase(userDataPath);
      const db = new DatabaseSync(dbPath);
      try {
        db.exec("PRAGMA foreign_keys = ON;");
        db.exec(CREATE_V6_AUDIT_EVENTS_TABLE_SQL);
        db.exec("CREATE TABLE project_memory_entries (id TEXT PRIMARY KEY);");
        db.prepare("INSERT INTO project_memory_entries (id) VALUES (?)").run("legacy-memory-1");
        insertSession(db);
        insertAuditRow(db, {
          sessionId: "session-1",
          createdAt: "2026-07-05T00:02:00.000Z",
          metadataJson: metadata({ assistantText: "final ok" }),
        });
        db.prepare(`
          INSERT INTO session_turns_v6 (
            session_id,
            phase,
            provider_id,
            started_at,
            updated_at
          ) VALUES (?, 'completed', 'codex', ?, ?)
        `).run("session-1", "2026-07-05T00:01:00.000Z", "2026-07-05T00:01:00.000Z");
      } finally {
        db.close();
      }

      assert.throws(
        () => migrateSessionTurnStorageV6(dbPath, "2026-07-05T01:00:00.000Z"),
        /session_turns_v6 already has rows/,
      );

      const failedDb = new DatabaseSync(dbPath, { readOnly: true });
      try {
        assert.equal(tableExists(failedDb, "audit_events_v6"), true);
        assert.equal(tableExists(failedDb, "project_memory_entries"), true);
        assert.equal(
          (failedDb.prepare("SELECT COUNT(*) AS count FROM project_memory_entries").get() as { count: number }).count,
          1,
        );
      } finally {
        failedDb.close();
      }
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("write mode は重複する assistant body を時刻近傍で照合する", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-session-turn-migration-"));
    try {
      const { dbPath } = await createOrVerifyV6FreshDatabase(userDataPath);
      const db = new DatabaseSync(dbPath);
      try {
        db.exec("PRAGMA foreign_keys = ON;");
        db.exec(CREATE_V6_AUDIT_EVENTS_TABLE_SQL);
        insertSession(db);
        insertAssistantMessage(db, 1, "duplicate final", "2026-07-05T00:01:00.000Z");
        insertAssistantMessage(db, 2, "duplicate final", "2026-07-05T00:10:01.000Z");
        insertAuditRow(db, {
          sessionId: "session-1",
          createdAt: "2026-07-05T00:10:00.000Z",
          metadataJson: metadata({ assistantText: "duplicate final" }),
        });
      } finally {
        db.close();
      }

      migrateSessionTurnStorageV6(dbPath, "2026-07-05T01:00:00.000Z");

      const migratedDb = new DatabaseSync(dbPath, { readOnly: true });
      try {
        assert.equal(
          (migratedDb.prepare("SELECT assistant_message_seq FROM session_turns_v6").get() as
            { assistant_message_seq: number }).assistant_message_seq,
          2,
        );
      } finally {
        migratedDb.close();
      }
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });
});
