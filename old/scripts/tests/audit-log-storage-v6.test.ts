import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import type { AuditLogEntry } from "../../src/runtime-state.js";
import { createOrVerifyV6FreshDatabase } from "../../src-electron/app-database-v6-bootstrap.js";
import { AuditLogStorageV6, deleteAuditEventsForSessionTargets } from "../../src-electron/audit-log-storage-v6.js";
import { AuditLogService } from "../../src-electron/audit-log-service.js";
import { AuxiliarySessionStorage } from "../../src-electron/auxiliary-session-storage.js";
import { CREATE_V6_AUDIT_EVENTS_TABLE_SQL } from "../../src-electron/database-schema-v6.js";
import { SessionStorageV6 } from "../../src-electron/session-storage-v6.js";

function baseAuditLog(overrides: Partial<Omit<AuditLogEntry, "id">> = {}): Omit<AuditLogEntry, "id"> {
  return {
    sessionId: "session-v6",
    createdAt: "2026-06-28T00:00:00.000Z",
    phase: "completed",
    provider: "codex",
    model: "gpt-5.4",
    reasoningEffort: "medium",
    approvalMode: "untrusted",
    threadId: "thread-v6",
    logicalPrompt: {
      systemText: "",
      inputText: "",
      composedText: "",
    },
    transportPayload: null,
    assistantText: "ok",
    operations: [],
    rawItemsJson: "",
    usage: null,
    errorMessage: "",
    ...overrides,
  };
}

function seedSession(dbPath: string): void {
  const sessionStorage = new SessionStorageV6(dbPath);
  try {
    sessionStorage.upsertSession({
      id: "session-v6",
      taskTitle: "V6 audit",
      status: "idle",
      updatedAt: "2026-06-28T00:00:00.000Z",
      provider: "codex",
      catalogRevision: 1,
      workspaceLabel: "workspace",
      workspacePath: "",
      branch: "main",
      sessionKind: "default",
      accessMode: "active",
      sourceSchemaVersion: 5,
      characterId: "",
      character: "キャラクター",
      characterIconPath: "",
      characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
      characterRuntimeSnapshot: null,
      runState: "idle",
      approvalMode: "untrusted",
      codexSandboxMode: "workspace-write",
      model: "gpt-5.4",
      reasoningEffort: "medium",
      customAgentName: "",
      allowedAdditionalDirectories: [],
      threadId: "thread-v6",
      messages: [],
      stream: [],
    });
  } finally {
    sessionStorage.close();
  }
}

function seedAuxiliarySession(dbPath: string): void {
  const auxiliaryStorage = new AuxiliarySessionStorage(dbPath);
  try {
    auxiliaryStorage.upsertAuxiliarySession({
      id: "aux-session-v6",
      parentSessionId: "session-v6",
      status: "active",
      runState: "idle",
      title: "Auxiliary audit",
      provider: "codex",
      catalogRevision: 1,
      model: "gpt-5.4",
      reasoningEffort: "medium",
      approvalMode: "untrusted",
      codexSandboxMode: "workspace-write",
      customAgentName: "",
      allowedAdditionalDirectories: [],
      threadId: "",
      composerDraft: "",
      messages: [],
      displayAfterMessageIndex: -1,
      createdAt: "2026-06-28T00:00:00.000Z",
      updatedAt: "2026-06-28T00:00:00.000Z",
      closedAt: "",
    });
  } finally {
    auxiliaryStorage.close();
  }
}

describe("AuditLogStorageV6", () => {
  it("summary では operation details を落とし、detail では保持する", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-audit-log-v6-"));
    try {
      const { dbPath } = await createOrVerifyV6FreshDatabase(userDataPath);
      seedSession(dbPath);
      const storage = new AuditLogStorageV6(dbPath);
      try {
        const created = storage.createAuditLog(baseAuditLog({
          operations: [
            {
              type: "shell",
              summary: "npm test",
              details: "stdout ".repeat(10_000),
            },
          ],
        }));

        const summary = storage.listSessionAuditLogSummaries("session-v6")[0];
        assert.deepEqual(summary?.operations, [{ type: "shell", summary: "npm test" }]);
        assert.equal("details" in (summary?.operations[0] ?? {}), false);

        const operations = storage.getSessionAuditLogDetailSection("session-v6", created.id, "operations");
        assert.deepEqual(operations?.operations, [{
          type: "shell",
          summary: "npm test",
          detailAvailable: true,
        }]);
        assert.equal("details" in (operations?.operations?.[0] ?? {}), false);

        const detail = storage.getSessionAuditLogOperationDetail("session-v6", created.id, 0);
        assert.equal(detail?.details.includes("stdout"), true);
      } finally {
        storage.close();
      }
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("AuditLogService 経由の update contract で terminal audit を保存する", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-audit-log-v6-"));
    try {
      const { dbPath } = await createOrVerifyV6FreshDatabase(userDataPath);
      seedSession(dbPath);
      const storage = new AuditLogStorageV6(dbPath);
      try {
        const service = new AuditLogService(storage);
        const created = await service.createAuditLog(baseAuditLog({ phase: "running", assistantText: "" }));
        const updated = await service.updateAuditLog(created.id, baseAuditLog({
          phase: "completed",
          assistantText: "done",
          operations: [{ type: "provider", summary: "completed", details: "details" }],
        }));

        assert.equal(updated.id, created.id);
        assert.equal(updated.phase, "completed");
        const summary = storage.listSessionAuditLogSummaries("session-v6")[0];
        assert.equal(summary?.phase, "completed");
        assert.equal(summary?.assistantTextPreview, "done");
        assert.deepEqual(summary?.operations, [{ type: "provider", summary: "completed" }]);
        const detail = storage.getSessionAuditLogDetail("session-v6", created.id);
        assert.equal(detail?.assistantText, "done");
        assert.equal(detail?.operations[0]?.details, "details");
      } finally {
        storage.close();
      }
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("completed audit は assistantMessageSeq がある場合も immutable fallback text を保存する", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-audit-log-v6-"));
    try {
      const { dbPath } = await createOrVerifyV6FreshDatabase(userDataPath);
      seedSession(dbPath);
      const db = new DatabaseSync(dbPath);
      try {
        db.prepare(`
          INSERT INTO session_messages_v6 (
            session_id,
            seq,
            role,
            body,
            artifact_body,
            created_at
          ) VALUES (?, ?, 'assistant', ?, NULL, ?)
        `).run("session-v6", 0, "done", "2026-06-28T00:00:01.000Z");
      } finally {
        db.close();
      }

      let createdAuditLogId = -1;
      const storage = new AuditLogStorageV6(dbPath);
      try {
        const created = storage.createAuditLog(baseAuditLog({
          phase: "completed",
          assistantText: "done",
          assistantMessageSeq: 0,
        }));
        createdAuditLogId = created.id;
        const detail = storage.getSessionAuditLogDetail("session-v6", created.id);
        assert.equal(detail?.assistantText, "done");
      } finally {
        storage.close();
      }

      const verifyDb = new DatabaseSync(dbPath, { readOnly: true });
      try {
        assert.equal(
          (verifyDb.prepare(`
            SELECT COUNT(*) AS count
            FROM session_turn_provider_outputs_v6
            WHERE kind = 'legacy_assistant_text'
          `).get() as { count: number }).count,
          1,
        );
      } finally {
        verifyDb.close();
      }

      seedSession(dbPath);

      const reopenedStorage = new AuditLogStorageV6(dbPath);
      try {
        const detail = reopenedStorage.getSessionAuditLogDetail("session-v6", createdAuditLogId);
        assert.equal(detail?.assistantText, "done");
      } finally {
        reopenedStorage.close();
      }
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("clearAuditLogs は transitional audit_events_v6 の session_turn source も削除する", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-audit-log-v6-"));
    try {
      const { dbPath } = await createOrVerifyV6FreshDatabase(userDataPath);
      seedSession(dbPath);
      const db = new DatabaseSync(dbPath);
      try {
        db.exec(CREATE_V6_AUDIT_EVENTS_TABLE_SQL);
        db.prepare(`
          INSERT INTO audit_events_v6 (
            session_id,
            auxiliary_session_id,
            event_type,
            provider_id,
            summary,
            metadata_json,
            created_at
          ) VALUES (?, NULL, 'session_turn', 'codex', 'legacy session turn', ?, ?)
        `).run(
          "session-v6",
          JSON.stringify({
            phase: "completed",
            provider: "codex",
            model: "gpt-5.4",
            reasoningEffort: "medium",
            approvalMode: "untrusted",
            assistantText: "legacy source",
            operations: [],
            rawItemsJson: "",
            errorMessage: "",
          }),
          "2026-06-28T00:00:00.000Z",
        );
        db.prepare(`
          INSERT INTO audit_events_v6 (
            session_id,
            auxiliary_session_id,
            event_type,
            provider_id,
            summary,
            metadata_json,
            created_at
          ) VALUES (?, NULL, 'diagnostic', 'system', 'diagnostic row', '{}', ?)
        `).run("session-v6", "2026-06-28T00:00:00.000Z");
      } finally {
        db.close();
      }

      const storage = new AuditLogStorageV6(dbPath);
      try {
        assert.equal(storage.listSessionAuditLogSummaries("session-v6").length, 1);
        assert.equal(storage.getSessionAuditLogDetail("session-v6", 1)?.assistantText, "legacy source");
        storage.clearAuditLogs();
        assert.equal(storage.listSessionAuditLogSummaries("session-v6").length, 0);
      } finally {
        storage.close();
      }

      const verifyDb = new DatabaseSync(dbPath, { readOnly: true });
      try {
        assert.equal(
          (verifyDb.prepare(`
            SELECT COUNT(*) AS count
            FROM audit_events_v6
            WHERE event_type = 'session_turn'
          `).get() as { count: number }).count,
          0,
        );
        assert.equal(
          (verifyDb.prepare(`
            SELECT COUNT(*) AS count
            FROM audit_events_v6
            WHERE event_type = 'diagnostic'
          `).get() as { count: number }).count,
          1,
        );
      } finally {
        verifyDb.close();
      }
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("legacy fallback は auxiliary_session_id 列がない audit_events_v6 も読める", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-audit-log-v6-"));
    try {
      const { dbPath } = await createOrVerifyV6FreshDatabase(userDataPath);
      seedSession(dbPath);
      const db = new DatabaseSync(dbPath);
      try {
        db.exec(`
          DROP TABLE IF EXISTS audit_events_v6;
          CREATE TABLE audit_events_v6 (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT,
            event_type TEXT NOT NULL,
            provider_id TEXT NOT NULL,
            summary TEXT NOT NULL,
            metadata_json TEXT NOT NULL,
            created_at TEXT NOT NULL
          );
        `);
        for (const [summary, assistantText, createdAt] of [
          ["legacy first", "first", "2026-06-28T00:00:00.000Z"],
          ["legacy second", "second", "2026-06-28T00:01:00.000Z"],
        ] as const) {
          db.prepare(`
            INSERT INTO audit_events_v6 (
              session_id,
              event_type,
              provider_id,
              summary,
              metadata_json,
              created_at
            ) VALUES (?, 'session_turn', 'codex', ?, ?, ?)
          `).run(
            "session-v6",
            summary,
            JSON.stringify({
              phase: "completed",
              provider: "codex",
              model: "gpt-5.4",
              reasoningEffort: "medium",
              approvalMode: "untrusted",
              assistantText,
              operations: [],
              rawItemsJson: "",
              errorMessage: "",
            }),
            createdAt,
          );
        }
      } finally {
        db.close();
      }

      const storage = new AuditLogStorageV6(dbPath);
      try {
        const summaries = storage.listSessionAuditLogSummaries("session-v6");
        assert.equal(summaries.length, 2);
        assert.equal(summaries[0]?.assistantTextPreview, "second");
        assert.equal(storage.getSessionAuditLogDetail("session-v6", 2)?.assistantText, "second");

        const page = storage.listSessionAuditLogSummaryPage("session-v6", { limit: 1 });
        assert.equal(page.total, 2);
        assert.equal(page.entries.length, 1);
        assert.equal(page.entries[0]?.assistantTextPreview, "second");
        assert.equal(page.hasMore, true);
        assert.equal(page.nextCursor, 2);
      } finally {
        storage.close();
      }

      const cleanupDb = new DatabaseSync(dbPath);
      try {
        assert.doesNotThrow(() => {
          deleteAuditEventsForSessionTargets(cleanupDb, { auxiliarySessionIds: ["aux-session-v6"] });
        });
        assert.equal(
          (cleanupDb.prepare("SELECT COUNT(*) AS count FROM audit_events_v6").get() as { count: number }).count,
          2,
        );
        deleteAuditEventsForSessionTargets(cleanupDb, { sessionIds: ["session-v6"] });
        assert.equal(
          (cleanupDb.prepare("SELECT COUNT(*) AS count FROM audit_events_v6").get() as { count: number }).count,
          0,
        );
      } finally {
        cleanupDb.close();
      }
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("running assistantText は interim として保存し、response detail を開いた時だけ返す", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-audit-log-v6-"));
    try {
      const { dbPath } = await createOrVerifyV6FreshDatabase(userDataPath);
      seedSession(dbPath);
      const storage = new AuditLogStorageV6(dbPath);
      try {
        const service = new AuditLogService(storage);
        const created = await service.createAuditLog(baseAuditLog({
          phase: "running",
          assistantText: "処理中...",
        }));
        await service.updateAuditLog(created.id, baseAuditLog({
          phase: "running",
          createdAt: "2026-06-28T00:00:01.000Z",
          assistantText: "処理中... テスト完了",
        }));
        await service.updateAuditLog(created.id, baseAuditLog({
          phase: "running",
          createdAt: "2026-06-28T00:00:02.000Z",
          assistantText: "処理中... テスト完了",
        }));
        await service.updateAuditLog(created.id, baseAuditLog({
          phase: "completed",
          createdAt: "2026-06-28T00:00:03.000Z",
          assistantText: "完了したよ。",
        }));

        const summary = storage.listSessionAuditLogSummaries("session-v6")[0];
        assert.equal(summary?.assistantTextPreview, "完了したよ。");

        const response = storage.getSessionAuditLogDetailSection("session-v6", created.id, "response");
        assert.equal(response?.assistantText, "完了したよ。");
        assert.deepEqual(response?.interimMessages?.map((message) => message.body), [
          "処理中...",
          "処理中... テスト完了",
        ]);
        assert.deepEqual(response?.interimMessages?.map((message) => message.source), [
          "running_snapshot",
          "running_snapshot",
        ]);
      } finally {
        storage.close();
      }
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("optional context と provider metadata を保存し、raw detail でだけ返す", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-audit-log-v6-"));
    try {
      const { dbPath } = await createOrVerifyV6FreshDatabase(userDataPath);
      seedSession(dbPath);
      const storage = new AuditLogStorageV6(dbPath);
      try {
        const created = storage.createAuditLog(baseAuditLog({
          sandboxMode: "workspace-write",
          userMessageSeq: 4,
          providerMetadata: [{
            provider: "codex",
            kind: "unsupported_response",
            source: "codex.thread_item",
            responseType: "new_item",
            summary: "Unsupported Codex item: new_item",
            payload: { type: "new_item" },
          }],
        }));

        const summary = storage.listSessionAuditLogSummaries("session-v6")[0];
        assert.equal(summary?.sandboxMode, "workspace-write");
        assert.equal(summary?.userMessageSeq, 4);
        assert.equal("providerMetadata" in (summary ?? {}), false);

        const raw = storage.getSessionAuditLogDetailSection("session-v6", created.id, "raw");
        assert.deepEqual(raw?.providerMetadata, [{
          provider: "codex",
          kind: "unsupported_response",
          source: "codex.thread_item",
          responseType: "new_item",
          summary: "Unsupported Codex item: new_item",
          payload: { type: "new_item" },
        }]);
      } finally {
        storage.close();
      }
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("createAuditLog は child payload 保存に失敗した場合に turn header を残さない", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-audit-log-v6-"));
    try {
      const { dbPath } = await createOrVerifyV6FreshDatabase(userDataPath);
      seedSession(dbPath);
      const storage = new AuditLogStorageV6(dbPath);
      try {
        const circular: Record<string, unknown> = {};
        circular.self = circular;

        assert.throws(
          () => storage.createAuditLog(baseAuditLog({
            providerMetadata: [{
              provider: "codex",
              kind: "unsupported_response",
              source: "codex.thread_item",
              summary: "Unsupported circular item",
              payload: circular,
            }],
          })),
          /circular structure/i,
        );

        assert.equal(storage.listSessionAuditLogSummaries("session-v6").length, 0);
      } finally {
        storage.close();
      }
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("updateAuditLog は child payload 保存に失敗した場合に既存 outputs を保持する", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-audit-log-v6-"));
    try {
      const { dbPath } = await createOrVerifyV6FreshDatabase(userDataPath);
      seedSession(dbPath);
      const storage = new AuditLogStorageV6(dbPath);
      try {
        const created = storage.createAuditLog(baseAuditLog({
          assistantText: "before",
          operations: [{ type: "shell", summary: "before op", details: "before details" }],
        }));
        const circular: Record<string, unknown> = {};
        circular.self = circular;

        assert.throws(
          () => storage.updateAuditLog(created.id, baseAuditLog({
            assistantText: "after",
            operations: [{ type: "shell", summary: "after op", details: "after details" }],
            providerMetadata: [{
              provider: "codex",
              kind: "unsupported_response",
              source: "codex.thread_item",
              summary: "Unsupported circular item",
              payload: circular,
            }],
          })),
          /circular structure/i,
        );

        const summary = storage.listSessionAuditLogSummaries("session-v6")[0];
        assert.equal(summary?.assistantTextPreview, "before");
        assert.deepEqual(summary?.operations, [{ type: "shell", summary: "before op" }]);
        const db = new DatabaseSync(dbPath, { readOnly: true });
        try {
          assert.equal(
            (db.prepare("SELECT COUNT(*) AS count FROM session_turn_provider_outputs_v6 WHERE turn_id = ?").get(
              created.id,
            ) as { count: number }).count,
            3,
          );
        } finally {
          db.close();
        }
      } finally {
        storage.close();
      }
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("Auxiliary session id の audit log も保存して sessionId で取得できる", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-audit-log-v6-"));
    try {
      const { dbPath } = await createOrVerifyV6FreshDatabase(userDataPath);
      seedSession(dbPath);
      seedAuxiliarySession(dbPath);
      const storage = new AuditLogStorageV6(dbPath);
      try {
        const service = new AuditLogService(storage);
        const created = await service.createAuditLog(baseAuditLog({
          sessionId: "aux-session-v6",
          phase: "running",
          assistantText: "",
        }));
        await service.updateAuditLog(created.id, baseAuditLog({
          sessionId: "aux-session-v6",
          phase: "completed",
          assistantText: "aux done",
          operations: [{ type: "provider", summary: "aux completed", details: "aux details" }],
        }));

        const parentSummary = storage.listSessionAuditLogSummaries("session-v6")[0];
        assert.equal(parentSummary?.id, created.id);
        assert.equal(parentSummary?.sessionId, "aux-session-v6");
        assert.equal(parentSummary?.phase, "completed");
        assert.equal(parentSummary?.assistantTextPreview, "aux done");

        const summary = storage.listSessionAuditLogSummaries("aux-session-v6")[0];
        assert.equal(summary?.id, created.id);
        assert.equal(summary?.sessionId, "aux-session-v6");
        assert.equal(summary?.phase, "completed");
        assert.equal(summary?.assistantTextPreview, "aux done");

        const parentDetail = storage.getSessionAuditLogDetail("session-v6", created.id);
        assert.equal(parentDetail?.sessionId, "aux-session-v6");
        assert.equal(parentDetail?.assistantText, "aux done");

        const parentResponseDetail = storage.getSessionAuditLogDetailSection("session-v6", created.id, "response");
        assert.equal(parentResponseDetail?.sessionId, "aux-session-v6");
        assert.equal(parentResponseDetail?.assistantText, "aux done");

        const parentOperationDetail = storage.getSessionAuditLogOperationDetail("session-v6", created.id, 0);
        assert.equal(parentOperationDetail?.sessionId, "aux-session-v6");
        assert.equal(parentOperationDetail?.details, "aux details");
      } finally {
        storage.close();
      }
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("updateAuditLog は audit log owner の main / auxiliary を移動しない", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-audit-log-v6-"));
    try {
      const { dbPath } = await createOrVerifyV6FreshDatabase(userDataPath);
      seedSession(dbPath);
      seedAuxiliarySession(dbPath);
      const storage = new AuditLogStorageV6(dbPath);
      try {
        const service = new AuditLogService(storage);
        const created = await service.createAuditLog(baseAuditLog({
          sessionId: "session-v6",
          phase: "running",
        }));

        assert.throws(
          () => service.updateAuditLog(created.id, baseAuditLog({
            sessionId: "aux-session-v6",
            phase: "completed",
            assistantText: "moved",
          })),
          /target mismatch/,
        );

        assert.equal(storage.listSessionAuditLogSummaries("session-v6")[0]?.id, created.id);
        assert.equal(storage.listSessionAuditLogSummaries("aux-session-v6").length, 0);
      } finally {
        storage.close();
      }
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("summary page の cursor 0 は先頭ページとして扱う", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-audit-log-v6-"));
    try {
      const { dbPath } = await createOrVerifyV6FreshDatabase(userDataPath);
      seedSession(dbPath);
      const storage = new AuditLogStorageV6(dbPath);
      try {
        storage.createAuditLog(baseAuditLog({
          createdAt: "2026-06-28T00:00:00.000Z",
          assistantText: "first",
        }));
        const second = storage.createAuditLog(baseAuditLog({
          createdAt: "2026-06-28T00:01:00.000Z",
          assistantText: "second",
        }));

        const firstPage = storage.listSessionAuditLogSummaryPage("session-v6", {
          cursor: 0,
          limit: 1,
        });

        assert.equal(firstPage.total, 2);
        assert.equal(firstPage.entries.length, 1);
        assert.equal(firstPage.entries[0]?.id, second.id);
        assert.equal(firstPage.entries[0]?.assistantTextPreview, "second");
        assert.equal(firstPage.hasMore, true);
        assert.equal(firstPage.nextCursor, second.id);

        const secondPage = storage.listSessionAuditLogSummaryPage("session-v6", {
          cursor: firstPage.nextCursor,
          limit: 1,
        });

        assert.equal(secondPage.entries.length, 1);
        assert.equal(secondPage.entries[0]?.assistantTextPreview, "first");
        assert.equal(secondPage.hasMore, false);
        assert.equal(secondPage.nextCursor, null);
      } finally {
        storage.close();
      }
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });
});
