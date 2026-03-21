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
  it("legacy approval_mode=never を allow-all として読み出す", async () => {
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
          prompt_text,
          user_message,
          system_prompt_text,
          input_prompt_text,
          composed_prompt_text,
          assistant_text,
          operations_json,
          raw_items_json,
          usage_json,
          error_message
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        session.id,
        "2026/03/21 10:00",
        "completed",
        "codex",
        "gpt-5",
        "medium",
        "never",
        "thread-1",
        "",
        "",
        "# System Prompt",
        "# Input Prompt",
        "# System Prompt\n\n# Input Prompt",
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
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });
});
