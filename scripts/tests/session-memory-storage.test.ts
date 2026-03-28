import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { buildNewSession } from "../../src/app-state.js";
import { createDefaultSessionMemory, mergeSessionMemory } from "../../src/memory-state.js";
import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import { SessionMemoryStorage } from "../../src-electron/session-memory-storage.js";
import { SessionStorage } from "../../src-electron/session-storage.js";

function createSession() {
  return buildNewSession({
    taskTitle: "Memory foundation",
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

describe("SessionMemoryStorage", () => {
  it("session から default memory を生成して保存できる", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-session-memory-"));
    const dbPath = path.join(tempDirectory, "withmate.db");

    try {
      const sessionStorage = new SessionStorage(dbPath);
      const session = sessionStorage.upsertSession(createSession());
      const memoryStorage = new SessionMemoryStorage(dbPath);

      const stored = memoryStorage.ensureSessionMemory(session);

      assert.equal(stored.sessionId, session.id);
      assert.equal(stored.goal, session.taskTitle);
      assert.deepEqual(stored.decisions, []);

      memoryStorage.close();
      sessionStorage.close();
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("delta merge 後の memory を保存して読み戻せる", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-session-memory-"));
    const dbPath = path.join(tempDirectory, "withmate.db");

    try {
      const sessionStorage = new SessionStorage(dbPath);
      const session = sessionStorage.upsertSession(createSession());
      const memoryStorage = new SessionMemoryStorage(dbPath);

      const merged = mergeSessionMemory(createDefaultSessionMemory(session), {
        decisions: ["Project Memory を後続 slice に分離する"],
        nextActions: ["extraction plane の trigger を実装する"],
      });
      memoryStorage.upsertSessionMemory(merged);

      const loaded = memoryStorage.getSessionMemory(session.id);
      assert.ok(loaded);
      assert.deepEqual(loaded.decisions, ["Project Memory を後続 slice に分離する"]);
      assert.deepEqual(loaded.nextActions, ["extraction plane の trigger を実装する"]);

      memoryStorage.close();
      sessionStorage.close();
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("session 削除時に foreign key cascade で memory も消える", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-session-memory-"));
    const dbPath = path.join(tempDirectory, "withmate.db");

    try {
      const sessionStorage = new SessionStorage(dbPath);
      const session = sessionStorage.upsertSession(createSession());
      const memoryStorage = new SessionMemoryStorage(dbPath);
      memoryStorage.ensureSessionMemory(session);

      sessionStorage.deleteSession(session.id);

      assert.equal(memoryStorage.getSessionMemory(session.id), null);

      memoryStorage.close();
      sessionStorage.close();
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });
});
