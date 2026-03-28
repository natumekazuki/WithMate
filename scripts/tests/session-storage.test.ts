import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { buildNewSession } from "../../src/app-state.js";
import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import { SessionStorage } from "../../src-electron/session-storage.js";

async function removeDirectoryWithRetry(targetPath: string, attempts = 5): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    try {
      await rm(targetPath, { recursive: true, force: true });
      return;
    } catch (error) {
      const isBusyError = typeof error === "object" && error !== null && "code" in error && error.code === "EBUSY";
      if (!isBusyError || index === attempts - 1) {
        throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, 50 * (index + 1)));
    }
  }
}

function createSession(taskTitle: string, workspaceLabel: string, characterId: string, character: string) {
  return buildNewSession({
    taskTitle,
    workspaceLabel,
    workspacePath: `C:/${workspaceLabel}`,
    branch: "main",
    characterId,
    character,
    characterIconPath: "",
    characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
    approvalMode: DEFAULT_APPROVAL_MODE,
  });
}

describe("SessionStorage", () => {
  it("replaceSessions で一覧をまとめて置き換えられる", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-session-storage-"));
    const dbPath = path.join(tempDirectory, "withmate.db");

    try {
      const storage = new SessionStorage(dbPath);
      const firstSession = createSession("first", "workspace-a", "char-a", "A");
      const secondSession = createSession("second", "workspace-b", "char-b", "B");

      storage.upsertSession(firstSession);
      storage.upsertSession(secondSession);

      const replacement = {
        ...secondSession,
        taskTitle: "second-updated",
        threadId: "",
      };
      storage.replaceSessions([replacement]);

      assert.deepEqual(
        storage.listSessions().map((session) => ({ id: session.id, taskTitle: session.taskTitle })),
        [{ id: replacement.id, taskTitle: "second-updated" }],
      );

      storage.close();
    } finally {
      await removeDirectoryWithRetry(tempDirectory);
    }
  });

  it("clearSessions で全 session を削除できる", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-session-storage-"));
    const dbPath = path.join(tempDirectory, "withmate.db");

    try {
      const storage = new SessionStorage(dbPath);
      storage.upsertSession(createSession("first", "workspace-a", "char-a", "A"));
      storage.upsertSession(createSession("second", "workspace-b", "char-b", "B"));

      storage.clearSessions();

      assert.deepEqual(storage.listSessions(), []);
      storage.close();
    } finally {
      await removeDirectoryWithRetry(tempDirectory);
    }
  });

  it("legacy approval 値も read-path normalize で provider-neutral に読める", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-session-storage-"));
    const dbPath = path.join(tempDirectory, "withmate.db");

    try {
      const storage = new SessionStorage(dbPath);
      const session = storage.upsertSession(createSession("legacy", "workspace-legacy", "char-a", "A"));
      storage.close();

      const db = new DatabaseSync(dbPath);
      db.prepare("UPDATE sessions SET approval_mode = ? WHERE id = ?").run("on-failure", session.id);
      db.close();

      const reopened = new SessionStorage(dbPath);
      const loaded = reopened.getSession(session.id);
      reopened.close();

      assert.ok(loaded);
      assert.equal(loaded.approvalMode, "provider-controlled");
    } finally {
      await removeDirectoryWithRetry(tempDirectory);
    }
  });

  it("customAgentName を保存して読み戻せる", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-session-storage-"));
    const dbPath = path.join(tempDirectory, "withmate.db");

    try {
      const storage = new SessionStorage(dbPath);
      const session = storage.upsertSession({
        ...createSession("agent", "workspace-agent", "char-a", "A"),
        provider: "copilot",
        customAgentName: "reviewer",
        allowedAdditionalDirectories: ["C:/shared/reference"],
      });

      const loaded = storage.getSession(session.id);
      storage.close();

      assert.ok(loaded);
      assert.equal(loaded.customAgentName, "reviewer");
      assert.deepEqual(loaded.allowedAdditionalDirectories, ["C:/shared/reference"]);
    } finally {
      await removeDirectoryWithRetry(tempDirectory);
    }
  });
});
