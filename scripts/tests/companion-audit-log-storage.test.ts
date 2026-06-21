import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import { DEFAULT_CODEX_SANDBOX_MODE } from "../../src/codex-sandbox-mode.js";
import type { CompanionGroup, CompanionSession } from "../../src/companion-state.js";
import { DEFAULT_CATALOG_REVISION, DEFAULT_MODEL_ID, DEFAULT_REASONING_EFFORT } from "../../src/model-catalog.js";
import { CompanionAuditLogStorage } from "../../src-electron/companion-audit-log-storage.js";
import { CompanionStorage } from "../../src-electron/companion-storage.js";

function createGroup(): CompanionGroup {
  return {
    id: "group-1",
    repoRoot: "F:/work/demo",
    displayName: "demo",
    createdAt: "2026-04-26 10:00",
    updatedAt: "2026-04-26 10:00",
  };
}

function createSession(groupId: string): CompanionSession {
  return {
    id: "session-1",
    groupId,
    taskTitle: "Companion task",
    status: "active",
    repoRoot: "F:/work/demo",
    focusPath: "src",
    targetBranch: "main",
    baseSnapshotRef: "refs/withmate/companion/session-1/base",
    baseSnapshotCommit: "abc123",
    companionBranch: "withmate/companion/session-1",
    worktreePath: "F:/app/companion-worktrees/group-1/session-1",
    selectedPaths: [],
    changedFiles: [],
    siblingWarnings: [],
    allowedAdditionalDirectories: [],
    runState: "idle",
    threadId: "",
    provider: "codex",
    catalogRevision: DEFAULT_CATALOG_REVISION,
    model: DEFAULT_MODEL_ID,
    reasoningEffort: DEFAULT_REASONING_EFFORT,
    customAgentName: "",
    approvalMode: DEFAULT_APPROVAL_MODE,
    codexSandboxMode: DEFAULT_CODEX_SANDBOX_MODE,
    characterId: "char-1",
    character: "Mia",
    characterRoleMarkdown: "落ち着いて伴走する。",
    characterIconPath: "icon.png",
    characterThemeColors: {
      main: "#6f8cff",
      sub: "#6fb8c7",
    },
    createdAt: "2026-04-26 10:01",
    updatedAt: "2026-04-26 10:01",
    messages: [],
  };
}

describe("CompanionAuditLogStorage", () => {
  it("V4 CompanionStorage schema で audit log を更新できる", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-companion-audit-log-"));
    const dbPath = path.join(tempDirectory, "withmate-v4.db");
    const blobRootPath = path.join(tempDirectory, "blobs", "v3");
    let companionStorage: CompanionStorage | null = null;
    let auditStorage: CompanionAuditLogStorage | null = null;

    try {
      companionStorage = new CompanionStorage(dbPath);
      const group = companionStorage.ensureGroup(createGroup());
      companionStorage.createSession(createSession(group.id));

      const db = new DatabaseSync(dbPath);
      try {
        const columns = (db.prepare("PRAGMA table_info(companion_sessions)").all() as Array<{ name: string }>)
          .map((column) => column.name);
        assert.equal(columns.includes("character_role_markdown"), true);
        assert.equal(columns.includes("character_role_blob_id"), false);
      } finally {
        db.close();
      }

      auditStorage = new CompanionAuditLogStorage(dbPath, blobRootPath);
      const created = await auditStorage.createAuditLog({
        sessionId: "session-1",
        createdAt: "2026-04-27T10:00:00.000Z",
        phase: "running",
        provider: "codex",
        model: "gpt-5.4-mini",
        reasoningEffort: "medium",
        approvalMode: DEFAULT_APPROVAL_MODE,
        threadId: "thread-v4",
        logicalPrompt: {
          systemText: "system",
          inputText: "input",
          composedText: "system\ninput",
        },
        transportPayload: null,
        assistantText: "",
        operations: [],
        rawItemsJson: "[]",
        usage: null,
        errorMessage: "",
      });

      const updated = await auditStorage.updateAuditLog(created.id, {
        ...created,
        phase: "completed",
        assistantText: "完了したよ。",
      });

      assert.equal(updated.phase, "completed");
      assert.equal(updated.assistantText, "完了したよ。");
      assert.equal((await auditStorage.listSessionAuditLogs("session-1"))[0]?.phase, "completed");
    } finally {
      auditStorage?.close();
      companionStorage?.close();
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });
});
