import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { buildNewSession } from "../../src/app-state.js";
import { SessionStorage } from "../../src-electron/session-storage.js";

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
    approvalMode: "on-request",
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
      await rm(tempDirectory, { recursive: true, force: true });
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
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });
});
