import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import type { AuditLogEntry } from "../../src/runtime-state.js";
import { createOrVerifyV6FreshDatabase } from "../../src-electron/app-database-v6-bootstrap.js";
import { AuditLogStorageV6 } from "../../src-electron/audit-log-storage-v6.js";
import { AuditLogService } from "../../src-electron/audit-log-service.js";
import { AuxiliarySessionStorage } from "../../src-electron/auxiliary-session-storage.js";
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
        }));

        assert.equal(storage.listSessionAuditLogSummaries("session-v6").length, 0);
        const summary = storage.listSessionAuditLogSummaries("aux-session-v6")[0];
        assert.equal(summary?.id, created.id);
        assert.equal(summary?.sessionId, "aux-session-v6");
        assert.equal(summary?.phase, "completed");
        assert.equal(summary?.assistantTextPreview, "aux done");
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
