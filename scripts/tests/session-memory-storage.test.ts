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

const REMOVABLE_DIRECTORY_RETRY_ERROR_CODES = new Set(["EBUSY", "EPERM", "ENOTEMPTY"]);

async function removeDirectoryWithRetry(targetPath: string, attempts = 15): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    try {
      await rm(targetPath, { recursive: true, force: true });
      return;
    } catch (error) {
      const errorCode =
        typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
          ? error.code
          : null;
      const shouldRetry = errorCode !== null && REMOVABLE_DIRECTORY_RETRY_ERROR_CODES.has(errorCode);
      if (!shouldRetry || index === attempts - 1) {
        throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, Math.min(2_000, 100 * (index + 1))));
    }
  }
}

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

function closeStorage(storage: { close(): void } | null): void {
  storage?.close();
}

describe("SessionMemoryStorage", () => {
  it("session から default memory を生成して保存できる", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-session-memory-"));
    const dbPath = path.join(tempDirectory, "withmate.db");
    let sessionStorage: SessionStorage | null = null;
    let memoryStorage: SessionMemoryStorage | null = null;

    try {
      sessionStorage = new SessionStorage(dbPath);
      const session = sessionStorage.upsertSession(createSession());
      memoryStorage = new SessionMemoryStorage(dbPath);

      const stored = memoryStorage.ensureSessionMemory(session);

      assert.equal(stored.sessionId, session.id);
      assert.equal(stored.goal, session.taskTitle);
      assert.deepEqual(stored.decisions, []);
    } finally {
      closeStorage(memoryStorage);
      closeStorage(sessionStorage);
      await removeDirectoryWithRetry(tempDirectory);
    }
  });

  it("delta merge 後の memory を保存して読み戻せる", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-session-memory-"));
    const dbPath = path.join(tempDirectory, "withmate.db");
    let sessionStorage: SessionStorage | null = null;
    let memoryStorage: SessionMemoryStorage | null = null;

    try {
      sessionStorage = new SessionStorage(dbPath);
      const session = sessionStorage.upsertSession(createSession());
      memoryStorage = new SessionMemoryStorage(dbPath);

      const merged = mergeSessionMemory(createDefaultSessionMemory(session), {
        decisions: ["Project Memory を後続 slice に分離する"],
        nextActions: ["extraction plane の trigger を実装する"],
      });
      memoryStorage.upsertSessionMemory(merged);

      const loaded = memoryStorage.getSessionMemory(session.id);
      assert.ok(loaded);
      assert.deepEqual(loaded.decisions, ["Project Memory を後続 slice に分離する"]);
      assert.deepEqual(loaded.nextActions, ["extraction plane の trigger を実装する"]);
    } finally {
      closeStorage(memoryStorage);
      closeStorage(sessionStorage);
      await removeDirectoryWithRetry(tempDirectory);
    }
  });

  it("session 削除時に foreign key cascade で memory も消える", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-session-memory-"));
    const dbPath = path.join(tempDirectory, "withmate.db");
    let sessionStorage: SessionStorage | null = null;
    let memoryStorage: SessionMemoryStorage | null = null;

    try {
      sessionStorage = new SessionStorage(dbPath);
      const session = sessionStorage.upsertSession(createSession());
      memoryStorage = new SessionMemoryStorage(dbPath);
      memoryStorage.ensureSessionMemory(session);

      sessionStorage.deleteSession(session.id);

      assert.equal(memoryStorage.getSessionMemory(session.id), null);
    } finally {
      closeStorage(memoryStorage);
      closeStorage(sessionStorage);
      await removeDirectoryWithRetry(tempDirectory);
    }
  });

  it("list / delete で session memory を管理できる", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-session-memory-"));
    const dbPath = path.join(tempDirectory, "withmate.db");
    let sessionStorage: SessionStorage | null = null;
    let memoryStorage: SessionMemoryStorage | null = null;

    try {
      sessionStorage = new SessionStorage(dbPath);
      const firstSession = sessionStorage.upsertSession(createSession());
      const secondSession = sessionStorage.upsertSession({
        ...createSession(),
        id: `${firstSession.id}-follow-up`,
        taskTitle: "Memory follow-up",
      });
      memoryStorage = new SessionMemoryStorage(dbPath);
      memoryStorage.ensureSessionMemory(firstSession);
      memoryStorage.ensureSessionMemory(secondSession);

      assert.equal(memoryStorage.listSessionMemories().length, 2);

      memoryStorage.deleteSessionMemory(firstSession.id);

      assert.equal(memoryStorage.getSessionMemory(firstSession.id), null);
      assert.equal(memoryStorage.listSessionMemories().length, 1);
    } finally {
      closeStorage(memoryStorage);
      closeStorage(sessionStorage);
      await removeDirectoryWithRetry(tempDirectory);
    }
  });

  it("management page query は filter / sort / cursor / total を DB 側で適用する", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-session-memory-"));
    const dbPath = path.join(tempDirectory, "withmate.db");
    let sessionStorage: SessionStorage | null = null;
    let memoryStorage: SessionMemoryStorage | null = null;

    try {
      sessionStorage = new SessionStorage(dbPath);
      const firstSession = sessionStorage.upsertSession({
        ...createSession(),
        taskTitle: "Old task",
      });
      const secondSession = sessionStorage.upsertSession({
        ...createSession(),
        id: `${firstSession.id}-next`,
        taskTitle: "New target task",
      });
      const wildcardSession = sessionStorage.upsertSession({
        ...createSession(),
        id: `${firstSession.id}-wildcard`,
        taskTitle: "Wildcard task",
      });
      memoryStorage = new SessionMemoryStorage(dbPath);
      memoryStorage.upsertSessionMemory({
        ...createDefaultSessionMemory(firstSession),
        goal: "target",
        decisions: ["literal _needle%"],
        updatedAt: "2026-04-02T10:00:00.000Z",
      });
      memoryStorage.upsertSessionMemory({
        ...createDefaultSessionMemory(secondSession),
        goal: "target",
        decisions: ["literal _needle%"],
        updatedAt: "2026-04-02T10:00:00.000Z",
      });
      memoryStorage.upsertSessionMemory({
        ...createDefaultSessionMemory(wildcardSession),
        goal: "target",
        decisions: ["xneedle plus"],
        updatedAt: "2026-04-03T10:00:00.000Z",
      });

      const page = memoryStorage.listSessionMemoryPage({ searchText: "_needle%", limit: 1 });

      assert.equal(page.total, 2);
      assert.deepEqual(page.items.map((item) => item.sessionId), [firstSession.id]);
      assert.equal(page.items[0]?.taskTitle, "Old task");
    } finally {
      closeStorage(memoryStorage);
      closeStorage(sessionStorage);
      await removeDirectoryWithRetry(tempDirectory);
    }
  });
});
