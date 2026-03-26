import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { buildNewSession } from "../../src/app-state.js";
import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import { AuditLogStorage } from "../../src-electron/audit-log-storage.js";
import { SessionStorage } from "../../src-electron/session-storage.js";

function createSession() {
  return buildNewSession({
    taskTitle: "audit session",
    workspaceLabel: "workspace",
    workspacePath: "C:/workspace",
    branch: "main",
    characterId: "char-a",
    character: "A",
    characterIconPath: "",
    characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
    approvalMode: DEFAULT_APPROVAL_MODE,
  });
}

describe("AuditLogStorage", () => {
  it("approval_mode を normalize しつつ新 schema の audit log を読み出せる", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-audit-log-storage-"));
    const dbPath = path.join(tempDirectory, "withmate.db");

    try {
      const sessionStorage = new SessionStorage(dbPath);
      const session = sessionStorage.upsertSession(createSession());
      sessionStorage.close();

      const bootstrapAuditStorage = new AuditLogStorage(dbPath);
      bootstrapAuditStorage.close();

      const db = new DatabaseSync(dbPath);
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
        session.id,
        "2026/03/21 10:00",
        "completed",
        "codex",
        "gpt-5",
        "medium",
        "never",
        "thread-1",
        JSON.stringify({
          systemText: "# System Prompt",
          inputText: "# Input Prompt",
          composedText: "# System Prompt\n\n# Input Prompt",
        }),
        JSON.stringify({
          summary: "Codex thread.runStreamed payload",
          fields: [
            { label: "thread.runStreamed.text", value: "# System Prompt\n\n# Input Prompt" },
          ],
        }),
        "done",
        "[]",
        "[]",
        "",
        "",
      );
      db.close();

      const storage = new AuditLogStorage(dbPath);
      const entries = storage.listSessionAuditLogs(session.id);
      storage.close();

      assert.equal(entries.length, 1);
      assert.equal(entries[0]?.approvalMode, "allow-all");
      assert.equal(entries[0]?.logicalPrompt.systemText, "# System Prompt");
      assert.equal(entries[0]?.transportPayload?.summary, "Codex thread.runStreamed payload");
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("clearAuditLogs で audit log を空にできる", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-audit-log-storage-"));
    const dbPath = path.join(tempDirectory, "withmate.db");

    try {
      const sessionStorage = new SessionStorage(dbPath);
      const session = sessionStorage.upsertSession(createSession());
      sessionStorage.close();

      const storage = new AuditLogStorage(dbPath);
      storage.createAuditLog({
        sessionId: session.id,
        createdAt: "2026/03/24 23:00",
        phase: "completed",
        provider: "codex",
        model: "gpt-5",
        reasoningEffort: "medium",
        approvalMode: DEFAULT_APPROVAL_MODE,
        threadId: "thread-1",
        logicalPrompt: {
          systemText: "system",
          inputText: "input",
          composedText: "system\n\ninput",
        },
        transportPayload: null,
        assistantText: "done",
        operations: [],
        rawItemsJson: "[]",
        usage: null,
        errorMessage: "",
      });

      storage.clearAuditLogs();

      assert.deepEqual(storage.listSessionAuditLogs(session.id), []);
      storage.close();
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("background phase の audit log を roundtrip できる", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-audit-log-storage-"));
    const dbPath = path.join(tempDirectory, "withmate.db");

    try {
      const sessionStorage = new SessionStorage(dbPath);
      const session = sessionStorage.upsertSession(createSession());
      sessionStorage.close();

      const storage = new AuditLogStorage(dbPath);
      const created = storage.createAuditLog({
        sessionId: session.id,
        createdAt: "2026/03/26 23:00",
        phase: "background-running",
        provider: "codex",
        model: "gpt-5.4-mini",
        reasoningEffort: "low",
        approvalMode: DEFAULT_APPROVAL_MODE,
        threadId: "thread-memory",
        logicalPrompt: {
          systemText: "memory extractor",
          inputText: "recent messages",
          composedText: "memory extractor\n\nrecent messages",
        },
        transportPayload: {
          summary: "Session Memory extraction payload",
          fields: [
            { label: "trigger", value: "outputTokensThreshold" },
          ],
        },
        assistantText: "",
        operations: [],
        rawItemsJson: "[]",
        usage: null,
        errorMessage: "",
      });

      const updated = storage.updateAuditLog(created.id, {
        ...created,
        phase: "background-completed",
        assistantText: "{\"nextActions\":[\"memory を保存する\"]}",
        usage: {
          inputTokens: 120,
          cachedInputTokens: 0,
          outputTokens: 48,
        },
      });

      assert.equal(updated.phase, "background-completed");
      assert.equal(updated.transportPayload?.fields[0]?.value, "outputTokensThreshold");

      const [entry] = storage.listSessionAuditLogs(session.id);
      assert.equal(entry?.phase, "background-completed");
      assert.equal(entry?.assistantText, "{\"nextActions\":[\"memory を保存する\"]}");
      assert.equal(entry?.usage?.outputTokens, 48);

      storage.close();
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });
});
