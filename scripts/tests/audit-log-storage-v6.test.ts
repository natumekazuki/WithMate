import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import type { AuditLogEntry } from "../../src/runtime-state.js";
import { createOrVerifyV6FreshDatabase } from "../../src-electron/app-database-v6-bootstrap.js";
import { AuditLogStorageV6 } from "../../src-electron/audit-log-storage-v6.js";
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

describe("AuditLogStorageV6", () => {
  it("summary では operation details を落とし、detail では保持する", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-audit-log-v6-"));
    try {
      const { dbPath } = await createOrVerifyV6FreshDatabase(userDataPath);
      const sessionStorage = new SessionStorageV6(dbPath);
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
      sessionStorage.close();
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

        const detail = storage.getSessionAuditLogOperationDetail("session-v6", created.id, 0);
        assert.equal(detail?.details.includes("stdout"), true);
      } finally {
        storage.close();
      }
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });
});
