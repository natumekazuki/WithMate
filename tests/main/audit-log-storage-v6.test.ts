import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import type { AuditLogEntry } from "../../src-shared/session/runtime-state.js";
import { createOrVerifyV6FreshDatabase } from "../../src-electron/storage/app-database-v6-bootstrap.js";
import { AuditLogStorageV6, deleteAuditEventsForSessionTargets } from "../../src-electron/session/audit-log-storage-v6.js";
import { AuditLogService } from "../../src-electron/session/audit-log-service.js";
import { AuxiliarySessionStorage } from "../../src-electron/auxiliary/auxiliary-session-storage.js";
import { CREATE_V6_AUDIT_EVENTS_TABLE_SQL } from "../../src-electron/storage/database-schema-v6.js";
import { SessionStorageV6 } from "../../src-electron/session/session-storage-v6.js";

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
      isPinned: false,
      codexSpeed: "standard",
      codexReviewer: "user",
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
      codexSpeed: "standard",
      codexReviewer: "user",
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
  // @test-value v2
  // kind = "invariant"
  // claim = "turnの途中更新は不変のprovider output行を保持し、変更した出力と終端情報を順序どおり取得できる"
  // oracle = { type = "contract", ref = "docs/design/audit-log.md#保存と所有" }
  // fault = "更新時に全output行を削除して再挿入するか、重複operationや追加された終端情報を誤対応させる"
  // observable = "provider outputのidとseq、およびaudit detailとoperation detailの値"
  // observation_boundary = "public-boundary"
  // scope = "AuditLogStorageV6のrunningからterminalへの保存と読み出し"
  // lifecycle = "permanent"
  // impact = "既存outputの識別子が失われ、表示対象のoperationや監査detailが欠落・入れ替わる"
  // distinction = "既存のdetail読取テストは更新をまたぐ行ID保持と重複操作の対応を確認しない"
  // @end-test-value
  it("incremental update は既存output行を保持して重複操作と終端detailを更新する", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-audit-incremental-"));
    try {
      const { dbPath } = await createOrVerifyV6FreshDatabase(userDataPath);
      seedSession(dbPath);
      const storage = new AuditLogStorageV6(dbPath);
      const db = new DatabaseSync(dbPath);
      try {
        const operation = { type: "shell", summary: "same", details: "running" };
        const initial = baseAuditLog({
          phase: "running",
          assistantText: "",
          operations: [operation, operation],
          rawItemsJson: "partial",
        });
        const created = storage.createAuditLog(initial);
        const rows = () => db.prepare(`
          SELECT id, seq, kind, payload_json FROM session_turn_provider_outputs_v6
          WHERE turn_id = ? ORDER BY seq
        `).all(created.id) as Array<{ id: number; seq: number; kind: string; payload_json: string }>;
        const before = rows();

        storage.updateAuditLog(created.id, { ...initial, rawItemsJson: "partial-2" });
        const streaming = rows();
        assert.deepEqual(streaming.filter((row) => row.kind !== "raw_items"), before.filter((row) => row.kind !== "raw_items"));
        assert.equal(streaming.find((row) => row.kind === "raw_items")?.id, before.find((row) => row.kind === "raw_items")?.id);

        db.prepare(`
          INSERT INTO session_turn_provider_outputs_v6
            (turn_id, seq, provider_id, kind, summary, payload_json, created_at)
          VALUES (?, ?, 'codex', 'context_telemetry', 'context', ?, ?)
        `).run(created.id, streaming.length, JSON.stringify({ value: "retained" }), initial.createdAt);
        const contextId = rows().find((row) => row.kind === "context_telemetry")?.id;
        storage.updateAuditLog(created.id, {
          ...initial,
          operations: [{ ...operation, details: "running-2" }, operation],
          rawItemsJson: "partial-2",
        });
        assert.deepEqual(rows().filter((row) => row.kind === "operation").map((row) => row.id), before.filter((row) => row.kind === "operation").map((row) => row.id));

        const terminal = { ...initial,
          phase: "completed" as const,
          assistantText: "done",
          transportPayload: { summary: "request", fields: [] },
          operations: [{ ...operation, details: "running-2" }, { ...operation, details: "completed" }],
          rawItemsJson: "final",
          usage: { inputTokens: 3, cachedInputTokens: 0, outputTokens: 4 },
          errorMessage: "provider failed",
        };
        storage.updateAuditLog(created.id, terminal);
        const after = rows();
        assert.equal(after.find((row) => row.kind === "logical_prompt")?.id, before.find((row) => row.kind === "logical_prompt")?.id);
        assert.deepEqual(after.filter((row) => row.kind === "operation").map((row) => row.id), before.filter((row) => row.kind === "operation").map((row) => row.id));
        assert.equal(after.find((row) => row.kind === "context_telemetry")?.id, contextId);
        assert.equal(after.find((row) => row.kind === "context_telemetry")?.payload_json, JSON.stringify({ value: "retained" }));
        assert.deepEqual(after.map((row) => row.seq), after.map((_, index) => index));
        assert.deepEqual(
          [0, 1].map((index) => storage.getSessionAuditLogOperationDetail("session-v6", created.id, index)?.details),
          ["running-2", "completed"],
        );
        const detail = storage.getSessionAuditLogDetail("session-v6", created.id);
        assert.equal(detail?.rawItemsJson, "final");
        assert.equal(detail?.assistantText, "done");
        assert.equal(detail?.errorMessage, "provider failed");
        assert.deepEqual(detail?.usage, terminal.usage);
      } finally {
        db.close();
        storage.close();
      }
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("atomic terminal markerをstaleなrunning audit更新で巻き戻さない", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-audit-terminal-marker-"));
    try {
      const { dbPath } = await createOrVerifyV6FreshDatabase(userDataPath);
      seedSession(dbPath);
      const auditStorage = new AuditLogStorageV6(dbPath);
      const runningEntry = baseAuditLog({
        phase: "running",
        createdAt: "2026-08-16T00:00:00.000Z",
        assistantText: "",
      });
      const created = auditStorage.createAuditLog(runningEntry);
      const sessionStorage = new SessionStorageV6(dbPath);
      try {
        const session = sessionStorage.getSession("session-v6");
        assert.ok(session);
        sessionStorage.upsertTerminalSession({
          ...session,
          messages: [
            { role: "user", text: "hello" },
            { role: "assistant", text: "done" },
          ],
        }, {
          auditLogId: created.id,
          sessionId: session.id,
          phase: "completed",
          assistantMessageSeq: 1,
          threadId: "thread-v6",
          errorMessage: "",
          completedAt: "2026-08-16T00:00:01.000Z",
        });

        assert.throws(
          () => auditStorage.updateAuditLog(created.id, runningEntry),
          /audit log not found or target mismatch/,
        );
        const completedEntry = baseAuditLog({
          phase: "completed",
          createdAt: "2026-08-16T00:00:01.000Z",
          assistantMessageSeq: 1,
        });
        auditStorage.updateAuditLog(created.id, completedEntry);
        assert.equal(auditStorage.listSessionAuditLogs("session-v6")[0]?.phase, "completed");
      } finally {
        sessionStorage.close();
        auditStorage.close();
      }
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

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
