import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { buildNewSession } from "../../src/app-state.js";
import { SessionStorage } from "../../src-electron/session-storage.js";

describe("SessionStorage", () => {
  it("replaceSessions で一覧をまとめて置き換えられる", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-session-storage-"));
    const dbPath = path.join(tempDirectory, "withmate.db");

    try {
      const storage = new SessionStorage(dbPath);
      const firstSession = buildNewSession({
        taskTitle: "first",
        workspaceLabel: "workspace-a",
        workspacePath: "C:/workspace-a",
        branch: "main",
        characterId: "char-a",
        character: "A",
        characterIconPath: "",
        characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
        approvalMode: "on-request",
      });
      const secondSession = buildNewSession({
        taskTitle: "second",
        workspaceLabel: "workspace-b",
        workspacePath: "C:/workspace-b",
        branch: "main",
        characterId: "char-b",
        character: "B",
        characterIconPath: "",
        characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
        approvalMode: "on-request",
      });

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
});
