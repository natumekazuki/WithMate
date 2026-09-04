import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, it } from "node:test";

import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import { buildNewSession } from "../../src/app-state.js";
import { CREATE_V2_SCHEMA_SQL } from "../../src-electron/database-schema-v2.js";
import { SessionStorageV2 } from "../../src-electron/session-storage-v2.js";

type V2SessionHeaderInput = {
  id?: string;
  taskTitle?: string;
  provider?: string;
  approvalMode?: string;
  codexSandboxMode?: string;
  model?: string;
  reasoningEffort?: string;
  customAgentName?: string;
  allowedAdditionalDirectoriesJson?: string;
  messageCount?: number;
  lastActiveAt?: number;
};

async function withTempV2Database<T>(fn: (dbPath: string) => T | Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "withmate-session-v2-read-"));
  const dbPath = path.join(dir, "withmate-v2.db");
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA foreign_keys = ON;");
    for (const statement of CREATE_V2_SCHEMA_SQL) {
      db.exec(statement);
    }
  } finally {
    db.close();
  }

  try {
    return await fn(dbPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function insertSessionHeader(db: DatabaseSync, input: V2SessionHeaderInput = {}): string {
  const id = input.id ?? "session-1";
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
      message_count,
      audit_log_count,
      last_active_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.taskTitle ?? "Runtime task",
    "idle",
    "2026-04-27T00:00:00.000Z",
    input.provider ?? "codex",
    1,
    "workspace-a",
    "workspace-a",
    "main",
    "default",
    "char-a",
    "A",
    "",
    "#6f8cff",
    "#6fb8c7",
    "idle",
    input.approvalMode ?? "never",
    input.codexSandboxMode ?? "workspace-write",
    input.model ?? "gpt-5.4-mini",
    input.reasoningEffort ?? "medium",
    input.customAgentName ?? "",
    input.allowedAdditionalDirectoriesJson ?? JSON.stringify(["shared/reference"]),
    "thread-1",
    input.messageCount ?? 0,
    0,
    input.lastActiveAt ?? 1,
  );
  return id;
}

function insertMessage(db: DatabaseSync, input: {
  sessionId: string;
  seq: number;
  role: "user" | "assistant";
  text: string;
  accent?: number;
  artifactAvailable?: number;
}): number {
  const result = db.prepare(`
    INSERT INTO session_messages (
      session_id,
      seq,
      role,
      text,
      accent,
      artifact_available,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.sessionId,
    input.seq,
    input.role,
    input.text,
    input.accent ?? 0,
    input.artifactAvailable ?? 0,
    "2026-04-27T00:00:00.000Z",
  );
  return Number(result.lastInsertRowid);
}

function insertArtifact(db: DatabaseSync, messageId: number, artifact: object): void {
  db.prepare("INSERT INTO session_message_artifacts (message_id, artifact_json) VALUES (?, ?)").run(
    messageId,
    JSON.stringify(artifact),
  );
}

function readCount(db: DatabaseSync, sql: string, ...params: SQLInputValue[]): number {
  const row = db.prepare(sql).get(...params) as { count: number };
  return Number(row.count);
}

function insertAuditLogForSession(db: DatabaseSync, sessionId: string, summary: string): number {
  const result = db.prepare(`
    INSERT INTO audit_logs (
      session_id,
      created_at,
      phase,
      provider,
      model,
      reasoning_effort,
      approval_mode,
      thread_id,
      assistant_text_preview,
      operation_count,
      raw_item_count,
      input_tokens,
      cached_input_tokens,
      output_tokens,
      has_error,
      error_message,
      detail_available
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sessionId,
    "2026-04-27T10:00:00.000Z",
    "completed",
    "codex",
    "gpt-5.4-mini",
    "medium",
    "never",
    `thread-${sessionId}`,
    summary,
    1,
    1,
    10,
    1,
    2,
    0,
    "",
    1,
  );
  const auditLogId = Number(result.lastInsertRowid);

  db.prepare(`
    INSERT INTO audit_log_details (
      audit_log_id,
      logical_prompt_json,
      transport_payload_json,
      assistant_text,
      raw_items_json,
      usage_json
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    auditLogId,
    "{}",
    "",
    summary,
    "[]",
    JSON.stringify({ inputTokens: 10, cachedInputTokens: 1, outputTokens: 2 }),
  );
  db.prepare(`
    INSERT INTO audit_log_operations (
      audit_log_id,
      seq,
      operation_type,
      summary,
      details
    ) VALUES (?, ?, ?, ?, ?)
  `).run(auditLogId, 0, "analysis", summary, "details");
  db.prepare("UPDATE sessions SET audit_log_count = audit_log_count + 1 WHERE id = ?").run(sessionId);

  return auditLogId;
}

function createSession(taskTitle: string, workspaceLabel: string, characterId: string, character: string) {
  return buildNewSession({
    id: `session-${workspaceLabel}-${taskTitle}`,
    taskTitle,
    workspaceLabel,
    workspacePath: `/${workspaceLabel}`,
    branch: "main",
    characterId,
    character,
    characterIconPath: "",
    characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
    approvalMode: DEFAULT_APPROVAL_MODE,
  });
}

describe("SessionStorageV2", () => {
  it("legacy V2 DBでもHome summaryをbounded pageで取得できる", async () => {
    await withTempV2Database(async (dbPath) => {
      const db = new DatabaseSync(dbPath);
      try {
        insertSessionHeader(db, { id: "new", lastActiveAt: 200 });
        insertSessionHeader(db, { id: "old", lastActiveAt: 100 });
      } finally {
        db.close();
      }

      const storage = new SessionStorageV2(dbPath);
      const first = storage.listHomeSessionSummaryPage({ scope: "recent", limit: 1 });
      const second = storage.listHomeSessionSummaryPage({ scope: "recent", limit: 1, cursor: first.nextCursor });
      assert.deepEqual(first.entries.map((entry) => entry.id), ["new"]);
      assert.deepEqual(second.entries.map((entry) => entry.id), ["old"]);
      assert.equal("provider" in (first.entries[0] ?? {}), false);
      assert.equal("threadId" in (first.entries[0] ?? {}), false);
      assert.deepEqual(storage.listSessionCharacterUsage(), [{ characterId: "char-a", sessionKind: "default" }]);
      storage.close();
    });
  });

  it("listSessionSummaries は V2 sessions header から summary を復元する", async () => {
    await withTempV2Database((dbPath) => {
      const db = new DatabaseSync(dbPath);
      try {
        insertSessionHeader(db, {
          id: "session-summary",
          taskTitle: "Task title",
          allowedAdditionalDirectoriesJson: JSON.stringify(["shared/reference"]),
        });
      } finally {
        db.close();
      }

      const storage = new SessionStorageV2(dbPath);
      try {
        const summaries = storage.listSessionSummaries();
        assert.equal(summaries.length, 1);
        assert.equal(summaries[0].id, "session-summary");
        assert.equal(summaries[0].taskTitle, "Task title");
        assert.deepEqual(summaries[0].allowedAdditionalDirectories, ["shared/reference"]);
        assert.equal(summaries[0].workspacePath, "workspace-a");
      } finally {
        storage.close();
      }
    });
  });

  it("getLatestSessionSummaryForProvider は legacy provider 表記を正規化して最新一件だけを返す", async () => {
    await withTempV2Database((dbPath) => {
      const db = new DatabaseSync(dbPath);
      try {
        insertSessionHeader(db, {
          id: "codex-old",
          provider: "codex",
          model: "gpt-old",
          lastActiveAt: 100,
        });
        insertSessionHeader(db, {
          id: "copilot-newest",
          provider: "copilot",
          model: "copilot-model",
          lastActiveAt: 300,
        });
        insertSessionHeader(db, {
          id: "codex-before",
          provider: "\tcodex\t",
          model: "gpt-before",
          lastActiveAt: 200,
        });
        insertSessionHeader(db, {
          id: "codex-latest",
          provider: "\nCodex\u00a0",
          model: "gpt-latest",
          reasoningEffort: "xhigh",
          approvalMode: "never",
          codexSandboxMode: "danger-full-access",
          customAgentName: "reviewer",
          lastActiveAt: 200,
        });
      } finally {
        db.close();
      }

      const storage = new SessionStorageV2(dbPath);
      try {
        const latest = storage.getLatestSessionSummaryForProvider("codex");
        assert.equal(latest?.id, "codex-latest");
        assert.equal(latest?.provider, "codex");
        assert.equal(latest?.model, "gpt-latest");
        assert.equal(latest?.reasoningEffort, "xhigh");
        assert.equal(latest?.approvalMode, "never");
        assert.equal(latest?.codexSandboxMode, "danger-full-access");
        assert.equal(latest?.customAgentName, "reviewer");
        assert.equal(storage.getLatestSessionSummaryForProvider("missing"), null);
      } finally {
        storage.close();
      }
    });
  });

  it("getSession は messages を seq 順で復元し artifact と stream: [] を返す", async () => {
    await withTempV2Database((dbPath) => {
      const db = new DatabaseSync(dbPath);
      try {
        const sessionId = insertSessionHeader(db, {
          id: "session-with-messages",
          messageCount: 2,
        });
        insertMessage(db, {
          sessionId,
          seq: 2,
          role: "assistant",
          text: "second",
        });
        const userMessageId = insertMessage(db, {
          sessionId,
          seq: 0,
          role: "user",
          text: "first",
          accent: 1,
          artifactAvailable: 1,
        });
        insertArtifact(db, userMessageId, {
          title: "Result artifact",
          activitySummary: ["done"],
          changedFiles: [],
          runChecks: [],
        });
      } finally {
        db.close();
      }

      const storage = new SessionStorageV2(dbPath);
      try {
        const session = storage.getSession("session-with-messages");
        assert.ok(session);
        assert.deepEqual(session.stream, []);
        assert.deepEqual(session.messages.map((message) => message.text), ["first", "second"]);
        assert.equal(session.messages[0].role, "user");
        assert.equal(session.messages[0].accent, true);
        assert.deepEqual(session.messages[0].artifact, {
          title: "Result artifact",
          activitySummary: ["done"],
          changedFiles: [],
          runChecks: [],
        });
        assert.equal(session.messages[1].role, "assistant");
        assert.equal(session.messages[1].artifact, undefined);
      } finally {
        storage.close();
      }
    });
  });

  it("getSession は存在しない id で null を返す", async () => {
    await withTempV2Database((dbPath) => {
      const storage = new SessionStorageV2(dbPath);
      try {
        assert.equal(storage.getSession("missing-session-id"), null);
      } finally {
        storage.close();
      }
    });
  });

  // @test-value v1
  // kind = "compatibility"
  // claim = "V2の壊れたadditional-directories JSONはsummary一覧から除外しdetail取得では明示errorにする"
  // oracle = { type = "contract", ref = "docs/features/home-session-pagination.md" }
  // failure_mode = "壊れたdetailをHomeへ投影する、またはdetail取得で破損を正常値として扱う"
  // scope = "session-storage-v2-summary-detail-failure-boundary"
  // lifecycle = "permanent"
  // @end-test-value
  it("壊れた allowed_additional_directories_json は summary で skip し detail で throw する", async () => {
    await withTempV2Database((dbPath) => {
      const db = new DatabaseSync(dbPath);
      try {
        insertSessionHeader(db, {
          id: "session-valid",
          taskTitle: "Good session",
          allowedAdditionalDirectoriesJson: JSON.stringify(["shared/valid"]),
        });
        insertSessionHeader(db, {
          id: "session-bad-directories",
          taskTitle: "Bad session",
          allowedAdditionalDirectoriesJson: "{invalid",
        });
      } finally {
        db.close();
      }

      const storage = new SessionStorageV2(dbPath);
      try {
        assert.deepEqual(storage.listSessionSummaries().map((session) => session.id), ["session-valid"]);
        const pageIds = storage.listSessionSummaryPage({ scope: "recent", limit: 10 }).entries.map((session) => session.id);
        assert.deepEqual(new Set(pageIds), new Set(["session-valid", "session-bad-directories"]));
        const openPage = storage.listSessionSummaryPage({
          scope: "open",
          sessionIds: ["session-valid", "session-bad-directories", "missing", "session-valid"],
          searchText: "",
        });
        assert.deepEqual(openPage.entries.map((session) => session.id).sort(), ["session-bad-directories", "session-valid"]);
        assert.equal(openPage.entries.length, 2);
        assert.equal(openPage.hasMore, false);
        assert.equal(openPage.nextCursor, null);
        assert.equal("provider" in openPage.entries[0]!, false);
        assert.throws(() => {
          storage.getSession("session-bad-directories");
        });
      } finally {
        storage.close();
      }
    });
  });

  it("upsertSession は getSession で messages と artifact を復元できる", async () => {
    await withTempV2Database((dbPath) => {
      const storage = new SessionStorageV2(dbPath);
      try {
        const session = createSession("Upsert session", "workspace-upsert", "char-up", "U");

        storage.upsertSession({
          ...session,
          messages: [
            {
              role: "user",
              text: "まずはメッセージ",
              accent: true,
              artifact: {
                title: "Upsert artifact",
                activitySummary: ["done"],
                changedFiles: [
                  {
                    kind: "edit",
                    path: "src/app.ts",
                    summary: "updated",
                    diffRows: [],
                  },
                ],
                runChecks: [
                  {
                    label: "test",
                    value: "pass",
                  },
                ],
              },
            },
            {
              role: "assistant",
              text: "了解、実行します。",
            },
          ],
        });

        const loaded = storage.getSession(session.id);
        assert.ok(loaded);
        assert.deepEqual(loaded.messages.map((message) => message.text), ["まずはメッセージ", "了解、実行します。"]);
        assert.equal(loaded.messages[0].role, "user");
        assert.equal(loaded.messages[0].accent, true);
        assert.deepEqual(loaded.messages[0].artifact, {
          title: "Upsert artifact",
          activitySummary: ["done"],
          changedFiles: [
            {
              kind: "edit",
              path: "src/app.ts",
              summary: "updated",
              diffRows: [],
            },
          ],
          runChecks: [
            {
              label: "test",
              value: "pass",
            },
          ],
        });
        assert.equal(loaded.messages[1].role, "assistant");
        assert.equal(loaded.messages[1].artifact, undefined);
        assert.deepEqual(loaded.stream, []);
      } finally {
        storage.close();
      }
    });
  });

  it("replaceSessions は既存 session/message/artifact を置換する", async () => {
    await withTempV2Database((dbPath) => {
      const storage = new SessionStorageV2(dbPath);
      try {
        const keepSession = createSession("Keep session", "workspace-keep", "char-k", "K");
        const targetSession = createSession("Target session", "workspace-target", "char-t", "T");

        storage.upsertSession({
          ...targetSession,
          messages: [
            {
              role: "user",
              text: "old target message",
              accent: true,
              artifact: {
                title: "Old artifact",
                activitySummary: ["old"],
                changedFiles: [
                  {
                    kind: "edit",
                    path: "old.ts",
                    summary: "old",
                    diffRows: [],
                  },
                ],
                runChecks: [
                  {
                    label: "old-check",
                    value: "pass",
                  },
                ],
              },
            },
          ],
        });
        storage.upsertSession({
          ...keepSession,
          messages: [
            {
              role: "assistant",
              text: "old keep message",
            },
          ],
        });

        storage.replaceSessions([
          {
            ...targetSession,
            taskTitle: "Target replaced",
            messages: [
              {
                role: "assistant",
                text: "new target message",
                artifact: {
                  title: "New artifact",
                  activitySummary: ["new"],
                  changedFiles: [
                    {
                      kind: "add",
                      path: "new.ts",
                      summary: "new",
                      diffRows: [],
                    },
                  ],
                  runChecks: [
                    {
                      label: "new-check",
                      value: "pass",
                    },
                  ],
                },
              },
            ],
          },
        ]);

        assert.deepEqual(
          storage.listSessions().map((session) => ({ id: session.id, taskTitle: session.taskTitle })),
          [{ id: targetSession.id, taskTitle: "Target replaced" }],
        );

        const loaded = storage.getSession(targetSession.id);
        assert.ok(loaded);
        assert.deepEqual(loaded.messages.map((message) => message.text), ["new target message"]);
        assert.deepEqual(loaded.messages[0].artifact, {
          title: "New artifact",
          activitySummary: ["new"],
          changedFiles: [
            {
              kind: "add",
              path: "new.ts",
              summary: "new",
              diffRows: [],
            },
          ],
          runChecks: [
            {
              label: "new-check",
              value: "pass",
            },
          ],
        });
        assert.equal(storage.getSession(keepSession.id), null);

        const db = new DatabaseSync(dbPath);
        try {
          assert.equal(
            readCount(db, "SELECT COUNT(*) AS count FROM session_messages WHERE session_id = ?", keepSession.id),
            0,
          );
          assert.equal(
            readCount(
              db,
              "SELECT COUNT(*) AS count FROM session_message_artifacts AS a JOIN session_messages AS m ON m.id = a.message_id WHERE m.session_id = ?",
              keepSession.id,
            ),
            0,
          );
        } finally {
          db.close();
        }
      } finally {
        storage.close();
      }
    });
  });

  it("replaceSessions は保持対象 session の audit logs を残し、除外 session の audit logs だけ削除する", async () => {
    await withTempV2Database((dbPath) => {
      const storage = new SessionStorageV2(dbPath);
      try {
        const targetSession = createSession("Target session", "workspace-target-audit", "char-ta", "T");
        const removedSession = createSession("Removed session", "workspace-removed-audit", "char-ra", "R");

        storage.upsertSession({
          ...targetSession,
          messages: [
            {
              role: "assistant",
              text: "target before replace",
            },
          ],
        });
        storage.upsertSession({
          ...removedSession,
          messages: [
            {
              role: "assistant",
              text: "removed before replace",
            },
          ],
        });

        const db = new DatabaseSync(dbPath);
        try {
          const keptAuditLogId = insertAuditLogForSession(db, targetSession.id, "kept audit log");
          const removedAuditLogId = insertAuditLogForSession(db, removedSession.id, "removed audit log");

          storage.replaceSessions([
            {
              ...targetSession,
              taskTitle: "Target replaced with audit",
              messages: [
                {
                  role: "assistant",
                  text: "target after replace",
                },
              ],
            },
          ]);

          assert.equal(readCount(db, "SELECT COUNT(*) AS count FROM audit_logs WHERE id = ?", keptAuditLogId), 1);
          assert.equal(readCount(db, "SELECT COUNT(*) AS count FROM audit_log_details WHERE audit_log_id = ?", keptAuditLogId), 1);
          assert.equal(readCount(db, "SELECT COUNT(*) AS count FROM audit_log_operations WHERE audit_log_id = ?", keptAuditLogId), 1);
          assert.equal(readCount(db, "SELECT COUNT(*) AS count FROM audit_logs WHERE id = ?", removedAuditLogId), 0);
          assert.equal(
            readCount(db, "SELECT COUNT(*) AS count FROM audit_log_details WHERE audit_log_id = ?", removedAuditLogId),
            0,
          );
          assert.equal(
            readCount(
              db,
              "SELECT COUNT(*) AS count FROM audit_log_operations WHERE audit_log_id = ?",
              removedAuditLogId,
            ),
            0,
          );

          const countRow = db.prepare("SELECT audit_log_count FROM sessions WHERE id = ?").get(targetSession.id) as {
            audit_log_count: number;
          };
          assert.equal(countRow.audit_log_count, 1);
        } finally {
          db.close();
        }
      } finally {
        storage.close();
      }
    });
  });

  it("deleteSession は child rows を残さず session を削除する", async () => {
    await withTempV2Database((dbPath) => {
      const storage = new SessionStorageV2(dbPath);
      try {
        const targetSession = createSession("Delete target", "workspace-delete", "char-d", "D");
        const keepSession = createSession("Keep session", "workspace-keep-2", "char-k2", "K");

        storage.upsertSession({
          ...targetSession,
          messages: [
            {
              role: "user",
              text: "delete target message",
              accent: true,
              artifact: {
                title: "Delete artifact",
                activitySummary: ["delete"],
                changedFiles: [
                  {
                    kind: "delete",
                    path: "delete.ts",
                    summary: "delete",
                    diffRows: [],
                  },
                ],
                runChecks: [
                  {
                    label: "delete-check",
                    value: "pass",
                  },
                ],
              },
            },
          ],
        });
        storage.upsertSession({
          ...keepSession,
          messages: [
            {
              role: "assistant",
              text: "keep session message",
            },
          ],
        });

        storage.deleteSession(targetSession.id);

        assert.equal(storage.getSession(targetSession.id), null);
        assert.ok(storage.getSession(keepSession.id));

        const db = new DatabaseSync(dbPath);
        try {
          assert.equal(
            readCount(db, "SELECT COUNT(*) AS count FROM session_messages WHERE session_id = ?", targetSession.id),
            0,
          );
          assert.equal(
            readCount(
              db,
              "SELECT COUNT(*) AS count FROM session_message_artifacts AS a JOIN session_messages AS m ON m.id = a.message_id WHERE m.session_id = ?",
              targetSession.id,
            ),
            0,
          );
          assert.equal(readCount(db, "SELECT COUNT(*) AS count FROM session_messages"), 1);
          assert.equal(readCount(db, "SELECT COUNT(*) AS count FROM session_message_artifacts"), 0);
        } finally {
          db.close();
        }
      } finally {
        storage.close();
      }
    });
  });

  it("clearSessions は child rows を残さず session を全削除する", async () => {
    await withTempV2Database((dbPath) => {
      const storage = new SessionStorageV2(dbPath);
      try {
        const firstSession = createSession("Clear first", "workspace-clear-1", "char-c1", "C");
        const secondSession = createSession("Clear second", "workspace-clear-2", "char-c2", "C");

        storage.upsertSession({
          ...firstSession,
          messages: [
            {
              role: "user",
              text: "first message",
              accent: true,
              artifact: {
                title: "Clear artifact",
                activitySummary: ["clear"],
                changedFiles: [
                  {
                    kind: "edit",
                    path: "clear.ts",
                    summary: "clear",
                    diffRows: [],
                  },
                ],
                runChecks: [
                  {
                    label: "clear-check",
                    value: "pass",
                  },
                ],
              },
            },
          ],
        });
        storage.upsertSession({
          ...secondSession,
          messages: [
            {
              role: "assistant",
              text: "second message",
            },
          ],
        });

        storage.clearSessions();

        assert.deepEqual(storage.listSessions(), []);

        const db = new DatabaseSync(dbPath);
        try {
          assert.equal(readCount(db, "SELECT COUNT(*) AS count FROM sessions"), 0);
          assert.equal(readCount(db, "SELECT COUNT(*) AS count FROM session_messages"), 0);
          assert.equal(readCount(db, "SELECT COUNT(*) AS count FROM session_message_artifacts"), 0);
        } finally {
          db.close();
        }
      } finally {
        storage.close();
      }
    });
  });
});
