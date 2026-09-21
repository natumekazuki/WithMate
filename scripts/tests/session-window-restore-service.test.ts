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
import { SESSION_WINDOW_RESTORE_SET_MAX } from "../../src-shared/window/session-window-restore.js";

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
        getSessionWindowRestoreStates: () => new Map(),
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
      assert.deepEqual(await firstStorage.loadSnapshot(), ["session-a", "session-b"]);

      const secondStorage = new SessionWindowRestoreStorage(root);
      const secondCreated = new Map<string, StubWindow[]>();
      let secondBridge: SessionWindowBridge<StubWindow>;
      const secondService = new SessionWindowRestoreService({
        storage: secondStorage,
        getSession: (sessionId) => ({ id: sessionId }),
        getSessionWindowRestoreStates: () => secondBridge.getSessionWindowRestoreStates(),
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
      assert.deepEqual(await secondService.getSnapshot(), []);

      secondBridge.closeSessionWindow("session-a");
      await secondService.getSnapshot();
      assert.deepEqual(await secondStorage.loadSnapshot(), ["session-b"]);
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
      getSessionWindowRestoreStates: () => new Map(),
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

  // @test-value v2
  // kind = "invariant"
  // claim = "起動時snapshotの読み込み完了前に現在集合の保存で復元集合を上書きしない"
  // oracle = { type = "contract", ref = "src-electron/session-window-restore-service.ts" }
  // fault = "初期loadとsaveが競合し、次回起動の復元対象を失う"
  // observable = "永続化snapshotとrestore後のrequestedSessionIds"
  // observation_boundary = "public-boundary"
  // scope = "session-window-restore"
  // lifecycle = "permanent"
  // @end-test-value
  it("起動時の復元集合を先に読み込み、現在集合の保存では上書きしない", async () => {
    const initialSnapshotControl = { resolve: undefined as ((sessionIds: string[]) => void) | undefined };
    const durableSnapshots: string[][] = [];
    const opened: string[] = [];
    const service = new SessionWindowRestoreService({
      storage: {
        loadSnapshot: () => new Promise<string[]>((resolve) => {
          initialSnapshotControl.resolve = resolve;
        }),
        async saveSnapshot(sessionIds) {
          durableSnapshots.push([...sessionIds]);
        },
      },
      getSession: (sessionId) => ({ id: sessionId }),
      getSessionWindowRestoreStates: () => new Map(),
      async openSessionWindow(sessionId) {
        opened.push(sessionId);
      },
    });

    const saveCurrentSnapshot = service.saveSnapshot(["session-c"]);
    await Promise.resolve();
    assert.deepEqual(durableSnapshots, []);

    assert.ok(initialSnapshotControl.resolve);
    initialSnapshotControl.resolve(["session-a", "session-b"]);
    await saveCurrentSnapshot;

    assert.deepEqual(durableSnapshots, [["session-c"]]);
    assert.deepEqual(await service.getSnapshot(), ["session-a", "session-b"]);
    assert.deepEqual((await service.restoreSnapshot()).requestedSessionIds, ["session-a", "session-b"]);
    assert.deepEqual(opened, ["session-a", "session-b"]);
  });

  it("保存失敗をsettleして復元集合のreadと後続保存を維持する", async () => {
    let shouldFailSave = true;
    let durableSnapshot = ["session-a", "session-b"];
    const service = new SessionWindowRestoreService({
      storage: {
        async loadSnapshot() {
          return [...durableSnapshot];
        },
        async saveSnapshot(sessionIds) {
          if (shouldFailSave) {
            throw new Error("save failed");
          }
          durableSnapshot = [...sessionIds];
        },
      },
      getSession: () => ({}),
      getSessionWindowRestoreStates: () => new Map(),
      openSessionWindow: async () => undefined,
    });

    await assert.rejects(service.saveSnapshot(["session-c"]), /save failed/);
    assert.deepEqual(await service.getSnapshot(), ["session-a", "session-b"]);

    shouldFailSave = false;
    await service.saveSnapshot(["session-d"]);
    assert.deepEqual(durableSnapshot, ["session-d"]);
    assert.deepEqual(await service.getSnapshot(), ["session-a", "session-b"]);
  });

  it("復元後通知の失敗で復元結果と未復元集合を失敗させない", async () => {
    const service = new SessionWindowRestoreService({
      storage: {
        async loadSnapshot() {
          return ["session-a"];
        },
        async saveSnapshot() {},
      },
      getSession: () => ({}),
      getSessionWindowRestoreStates: () => new Map(),
      openSessionWindow: async () => undefined,
      onRestoreSetChanged() {
        throw new Error("broadcast failed");
      },
    });

    const result = await service.restoreSnapshot();

    assert.deepEqual(result.openedSessionIds, ["session-a"]);
    assert.deepEqual(await service.getSnapshot(), []);
  });

  it("すでにopenのSessionを消費し、未openのSessionだけを復元結果へ含める", async () => {
    const opened: string[] = [];
    const restoreSetChanges: string[][] = [];
    const service = new SessionWindowRestoreService({
      storage: {
        async loadSnapshot() {
          return ["session-a", "session-b"];
        },
        async saveSnapshot() {},
      },
      getSession: (sessionId) => ({ id: sessionId }),
      getSessionWindowRestoreStates: () => new Map([
        ["session-a", { kind: "settled-open" as const }],
      ]),
      async openSessionWindow(sessionId) {
        opened.push(sessionId);
      },
      onRestoreSetChanged(sessionIds) {
        restoreSetChanges.push([...sessionIds]);
      },
    });

    const result = await service.restoreSnapshot();

    assert.deepEqual(result, {
      requestedSessionIds: ["session-b"],
      openedSessionIds: ["session-b"],
      failures: [],
    });
    assert.deepEqual(opened, ["session-b"]);
    assert.deepEqual(restoreSetChanges, [[]]);
    assert.deepEqual(await service.getSnapshot(), []);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "手動open中のsessionのload失敗を復元失敗として扱い、後続対象を継続する"
  // oracle = { type = "contract", ref = "src-electron/session-window-restore-service.ts" }
  // fault = "失敗対象を成功扱いするか、後続window復元を中断する"
  // observable = "openedSessionIds、failures、未復元snapshot集合"
  // observation_boundary = "public-boundary"
  // scope = "session-window-restore"
  // lifecycle = "permanent"
  // @end-test-value
  it("手動open中の対象へ合流し、load失敗を再試行集合へ残して後続対象を復元する", async () => {
    const rejectSessionAControl = { reject: undefined as ((error: Error) => void) | undefined };
    const sessionBControl = { resolve: undefined as ((session: { id: string }) => void) | undefined };
    const created = new Map<string, StubWindow[]>();
    const restoreOpenCalls: string[] = [];
    const restoreSetChanges: string[][] = [];
    let bridge: SessionWindowBridge<StubWindow>;
    const service = new SessionWindowRestoreService({
      storage: {
        async loadSnapshot() {
          return ["session-b", "session-a"];
        },
        async saveSnapshot() {},
      },
      getSession: (sessionId) => {
        if (sessionId === "session-b") {
          return new Promise<{ id: string }>((resolve) => {
            sessionBControl.resolve = resolve;
          });
        }
        return { id: sessionId };
      },
      getSessionWindowRestoreStates: () => bridge.getSessionWindowRestoreStates(),
      openSessionWindow: (sessionId) => {
        restoreOpenCalls.push(sessionId);
        return bridge.openSessionWindow(sessionId);
      },
      onRestoreSetChanged(sessionIds) {
        restoreSetChanges.push([...sessionIds]);
      },
    });
    bridge = new SessionWindowBridge({
      createWindow(sessionId) {
        const window = new StubWindow();
        created.set(sessionId, [...created.get(sessionId) ?? [], window]);
        return window;
      },
      loadChatEntry(_window, mode) {
        if (mode.sessionId === "session-a") {
          return new Promise<void>((_resolve, reject) => {
            rejectSessionAControl.reject = reject;
          });
        }
        return Promise.resolve();
      },
      getSession: () => null,
      isRunInFlight: () => false,
      confirmCloseWhileRunning: () => false,
      broadcastOpenSessionWindowIds() {},
      persistOpenSessionWindowIds: (sessionIds) => service.saveSnapshot(sessionIds),
    });

    const manualOpen = bridge.openSessionWindow("session-a");
    const restoring = service.restoreSnapshot();
    const outcomes = Promise.allSettled([manualOpen, restoring]);
    let restoreSettled = false;
    void restoring.then(() => {
      restoreSettled = true;
    }, () => {
      restoreSettled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(created.get("session-a")?.length, 1);
    assert.equal(created.get("session-b")?.length ?? 0, 0);
    assert.deepEqual(restoreOpenCalls, ["session-a"]);
    assert.equal(restoreSettled, false);
    assert.ok(rejectSessionAControl.reject);
    rejectSessionAControl.reject(new Error("load failed"));
    assert.ok(sessionBControl.resolve);
    sessionBControl.resolve({ id: "session-b" });

    const [manualResult, restoreResult] = await outcomes;

    assert.equal(manualResult.status, "rejected");
    assert.equal(restoreResult.status, "fulfilled");
    if (restoreResult.status !== "fulfilled") {
      assert.fail("restore result should be fulfilled");
    }
    assert.deepEqual(restoreResult.value, {
      requestedSessionIds: ["session-b", "session-a"],
      openedSessionIds: ["session-b"],
      failures: [{ sessionId: "session-a", reason: "open-failed" }],
    });
    assert.equal(created.get("session-a")?.length, 1);
    assert.equal(created.get("session-b")?.length, 1);
    assert.deepEqual(restoreOpenCalls, ["session-a", "session-b"]);
    assert.deepEqual(await service.getSnapshot(), ["session-a"]);
    assert.deepEqual(restoreSetChanges, [["session-a"]]);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "手動open中のsessionへ復元処理が合流し、windowを重複生成しない"
  // oracle = { type = "contract", ref = "src-electron/session-window-restore-service.ts" }
  // fault = "同一sessionのrestoreで二重windowを作成し、復元結果を誤分類する"
  // observable = "生成window数とopenedSessionIds"
  // observation_boundary = "public-boundary"
  // scope = "session-window-restore"
  // lifecycle = "permanent"
  // @end-test-value
  it("手動open中の対象へ合流し、load成功を重複生成せず復元成功に分類する", async () => {
    const sessionAControl = { resolve: undefined as (() => void) | undefined };
    const created = new Map<string, StubWindow[]>();
    let bridge: SessionWindowBridge<StubWindow>;
    const service = new SessionWindowRestoreService({
      storage: {
        async loadSnapshot() {
          return ["session-a", "session-b"];
        },
        async saveSnapshot() {},
      },
      getSession: (sessionId) => ({ id: sessionId }),
      getSessionWindowRestoreStates: () => bridge.getSessionWindowRestoreStates(),
      openSessionWindow: (sessionId) => bridge.openSessionWindow(sessionId),
    });
    bridge = new SessionWindowBridge({
      createWindow(sessionId) {
        const window = new StubWindow();
        created.set(sessionId, [...created.get(sessionId) ?? [], window]);
        return window;
      },
      loadChatEntry(_window, mode) {
        if (mode.sessionId === "session-a") {
          return new Promise<void>((resolve) => {
            sessionAControl.resolve = resolve;
          });
        }
        return Promise.resolve();
      },
      getSession: () => null,
      isRunInFlight: () => false,
      confirmCloseWhileRunning: () => false,
      broadcastOpenSessionWindowIds() {},
      persistOpenSessionWindowIds: (sessionIds) => service.saveSnapshot(sessionIds),
    });

    const manualOpen = bridge.openSessionWindow("session-a");
    const restoring = service.restoreSnapshot();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(created.get("session-a")?.length, 1);
    assert.ok(sessionAControl.resolve);
    sessionAControl.resolve();

    const [, result] = await Promise.all([manualOpen, restoring]);

    assert.deepEqual(result, {
      requestedSessionIds: ["session-a", "session-b"],
      openedSessionIds: ["session-a", "session-b"],
      failures: [],
    });
    assert.equal(created.get("session-a")?.length, 1);
    assert.equal(created.get("session-b")?.length, 1);
    assert.deepEqual(await service.getSnapshot(), []);
  });
});
