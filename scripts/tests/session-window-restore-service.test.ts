import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  SessionWindowBridge,
  type SessionWindowCloseEvent,
  type SessionWindowLike,
} from "../../src-electron/session-window-bridge.js";
import { SessionWindowRestoreService } from "../../src-electron/session-window-restore-service.js";
import { SessionWindowRestoreStorage } from "../../src-electron/session-window-restore-storage.js";
import { SESSION_WINDOW_RESTORE_SET_MAX } from "../../src/session-window-restore.js";

class StubWindow implements SessionWindowLike {
  destroyed = false;
  private readonly closeListeners: Array<(event: SessionWindowCloseEvent) => void> = [];
  private readonly closedListeners: Array<() => void> = [];

  isDestroyed() { return this.destroyed; }
  isMinimized() { return false; }
  restore() {}
  focus() {}
  show() {}
  destroy() { this.finishClose(); }
  close() {
    let prevented = false;
    for (const listener of this.closeListeners) {
      listener({ preventDefault: () => { prevented = true; } });
    }
    if (!prevented) {
      this.finishClose();
    }
  }
  once(_event: "ready-to-show", _listener: () => void) {}
  on(event: "close", listener: (event: SessionWindowCloseEvent) => void): void;
  on(event: "closed", listener: () => void): void;
  on(event: "close" | "closed", listener: ((event: SessionWindowCloseEvent) => void) | (() => void)) {
    if (event === "close") {
      this.closeListeners.push(listener as (event: SessionWindowCloseEvent) => void);
    } else {
      this.closedListeners.push(listener as () => void);
    }
  }

  private finishClose() {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    for (const listener of this.closedListeners.splice(0)) {
      listener();
    }
  }
}

function createBridge(input: {
  persist(sessionIds: readonly string[]): Promise<void>;
  created: Map<string, StubWindow[]>;
}) {
  return new SessionWindowBridge<StubWindow>({
    createWindow(sessionId) {
      const window = new StubWindow();
      input.created.set(sessionId, [...input.created.get(sessionId) ?? [], window]);
      return window;
    },
    async loadChatEntry() {},
    getSession: () => null,
    isRunInFlight: () => false,
    getAllowQuitWithInFlightRuns: () => false,
    confirmCloseWhileRunning: () => false,
    broadcastOpenSessionWindowIds() {},
    persistOpenSessionWindowIds: input.persist,
  });
}

describe("SessionWindowRestoreService", () => {
  it("A/B snapshotをruntime再生成後に各1Windowとして一括復元し、closeを次回snapshotへ反映する", async () => {
    const root = await mkdtemp(join(tmpdir(), "withmate-session-window-restore-"));
    try {
      const firstStorage = new SessionWindowRestoreStorage(root);
      const firstService = new SessionWindowRestoreService({
        storage: firstStorage,
        getSession: () => ({}),
        openSessionWindow: async () => undefined,
      });
      const firstCreated = new Map<string, StubWindow[]>();
      const firstBridge = createBridge({
        persist: (sessionIds) => firstService.saveSnapshot(sessionIds),
        created: firstCreated,
      });

      await firstBridge.openSessionWindow("session-a");
      await firstBridge.openSessionWindow("session-b");
      await firstBridge.openSessionWindow("session-a");
      assert.deepEqual(await firstService.getSnapshot(), ["session-a", "session-b"]);

      const secondStorage = new SessionWindowRestoreStorage(root);
      const secondCreated = new Map<string, StubWindow[]>();
      let secondBridge: SessionWindowBridge<StubWindow>;
      const secondService = new SessionWindowRestoreService({
        storage: secondStorage,
        getSession: (sessionId) => ({ id: sessionId }),
        openSessionWindow: (sessionId) => secondBridge.openSessionWindow(sessionId),
      });
      secondBridge = createBridge({
        persist: (sessionIds) => secondService.saveSnapshot(sessionIds),
        created: secondCreated,
      });

      const result = await secondService.restoreSnapshot();

      assert.deepEqual(result, {
        requestedSessionIds: ["session-a", "session-b"],
        openedSessionIds: ["session-a", "session-b"],
        failures: [],
      });
      assert.equal(secondCreated.get("session-a")?.length, 1);
      assert.equal(secondCreated.get("session-b")?.length, 1);
      assert.deepEqual(secondBridge.listOpenSessionWindowIds(), ["session-a", "session-b"]);

      secondBridge.closeSessionWindow("session-a");
      assert.deepEqual(await secondService.getSnapshot(), ["session-b"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("missing・読込不能・open失敗を対象別にskipし、残りの復元を続ける", async () => {
    const opened: string[] = [];
    const service = new SessionWindowRestoreService({
      storage: {
        async loadSnapshot() {
          return ["missing", "unreadable", "open-failed", "valid"];
        },
        async saveSnapshot() {},
      },
      getSession(sessionId) {
        if (sessionId === "missing") {
          return null;
        }
        if (sessionId === "unreadable") {
          throw new Error("read failed");
        }
        return { id: sessionId };
      },
      async openSessionWindow(sessionId) {
        if (sessionId === "open-failed") {
          throw new Error("open failed");
        }
        opened.push(sessionId);
      },
    });

    const result = await service.restoreSnapshot();

    assert.deepEqual(opened, ["valid"]);
    assert.deepEqual(result.failures, [
      { sessionId: "missing", reason: "missing" },
      { sessionId: "unreadable", reason: "unreadable" },
      { sessionId: "open-failed", reason: "open-failed" },
    ]);
    assert.deepEqual(result.openedSessionIds, ["valid"]);
  });

  it("snapshot保存時にopen順のduplicateを除去し、100件へ制限する", async () => {
    const root = await mkdtemp(join(tmpdir(), "withmate-session-window-limit-"));
    try {
      const storage = new SessionWindowRestoreStorage(root);
      const sessionIds = ["session-0", "session-0", ...Array.from(
        { length: SESSION_WINDOW_RESTORE_SET_MAX + 5 },
        (_, index) => `session-${index + 1}`,
      )];

      await storage.saveSnapshot(sessionIds);
      const saved = await storage.loadSnapshot();

      assert.equal(saved.length, SESSION_WINDOW_RESTORE_SET_MAX);
      assert.deepEqual(saved.slice(0, 3), ["session-0", "session-1", "session-2"]);
      assert.equal(saved.at(-1), "session-99");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
