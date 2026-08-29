import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildNewSession, type Session } from "../../src/app-state.js";
import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import {
  SessionWindowBridge,
  type SessionWindowCloseEvent,
  type SessionWindowLike,
} from "../../src-electron/session-window-bridge.js";

function createSession(overrides?: Partial<Session>): Session {
  return {
    ...buildNewSession({
      taskTitle: "Window Test",
      workspaceLabel: "workspace",
      workspacePath: "C:/workspace",
      branch: "main",
      characterId: "char-a",
      character: "A",
      characterIconPath: "",
      characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
      approvalMode: DEFAULT_APPROVAL_MODE,
    }),
    ...overrides,
  };
}

class StubWindow implements SessionWindowLike {
  destroyed = false;
  delayClosedEvent = false;
  minimized = false;
  visible = false;
  focused = false;
  showCount = 0;
  focusCount = 0;
  restoreCount = 0;
  closeCount = 0;
  destroyCount = 0;
  readonly activationOperations: string[] = [];
  private readonly readyListeners: Array<() => void> = [];
  private readonly closeListeners: Array<(event: SessionWindowCloseEvent) => void> = [];
  private readonly closedListeners: Array<() => void> = [];

  isDestroyed(): boolean {
    return this.destroyed;
  }

  isMinimized(): boolean {
    return this.minimized;
  }

  restore(): void {
    this.minimized = false;
    this.visible = true;
    this.restoreCount += 1;
    this.activationOperations.push("restore");
  }

  focus(): void {
    this.focused = true;
    this.focusCount += 1;
    this.activationOperations.push("focus");
  }

  show(): void {
    this.visible = true;
    this.focused = true;
    this.showCount += 1;
    this.activationOperations.push("show");
  }

  close(): void {
    this.closeCount += 1;
    if (this.destroyed) {
      return;
    }

    let prevented = false;
    const event: SessionWindowCloseEvent = {
      preventDefault() {
        prevented = true;
      },
    };
    for (const listener of this.closeListeners) {
      listener(event);
    }
    if (prevented) {
      return;
    }

    this.destroyed = true;
    if (!this.delayClosedEvent) {
      this.emitClosed();
    }
  }

  destroy(): void {
    this.destroyCount += 1;
    if (this.destroyed) {
      return;
    }

    this.destroyed = true;
    if (!this.delayClosedEvent) {
      this.emitClosed();
    }
  }

  once(event: "ready-to-show", listener: () => void): void {
    if (event === "ready-to-show") {
      this.readyListeners.push(listener);
    }
  }

  on(event: "close", listener: (event: SessionWindowCloseEvent) => void): void;
  on(event: "closed", listener: () => void): void;
  on(
    event: "close" | "closed",
    listener: ((event: SessionWindowCloseEvent) => void) | (() => void),
  ): void {
    if (event === "close") {
      this.closeListeners.push(listener as (event: SessionWindowCloseEvent) => void);
      return;
    }

    this.closedListeners.push(listener as () => void);
  }

  emitReady(): void {
    for (const listener of this.readyListeners.splice(0)) {
      listener();
    }
  }

  emitClosed(): void {
    for (const listener of this.closedListeners.splice(0)) {
      listener();
    }
  }

  resetActivation(options: { minimized: boolean; visible: boolean }): void {
    this.minimized = options.minimized;
    this.visible = options.visible;
    this.focused = false;
    this.showCount = 0;
    this.focusCount = 0;
    this.restoreCount = 0;
    this.activationOperations.splice(0);
  }
}

describe("SessionWindowBridge", () => {
  it("新規 open で registry 更新・entry load を行う", async () => {
    const session = createSession();
    const windows: StubWindow[] = [];
    const broadcasts: string[][] = [];
    let loadedChatMode: unknown = null;

    const bridge = new SessionWindowBridge({
      createWindow() {
        const window = new StubWindow();
        windows.push(window);
        return window;
      },
      async loadChatEntry(_window, mode) {
        loadedChatMode = mode;
      },
      getSession(sessionId) {
        return sessionId === session.id ? session : null;
      },
      isRunInFlight() {
        return false;
      },
      getAllowQuitWithInFlightRuns() {
        return false;
      },
      confirmCloseWhileRunning() {
        return false;
      },
      broadcastOpenSessionWindowIds(openIds) {
        broadcasts.push([...openIds]);
      },
    });

    const window = await bridge.openSessionWindow(session.id);
    window.emitReady();

    assert.deepEqual(loadedChatMode, { kind: "agent", sessionId: session.id });
    assert.deepEqual(broadcasts.at(-1), [session.id]);
    assert.equal(window.showCount, 1);
  });

  it("既存 window は通常・最小化・非表示の各状態から可視化して focus する", async (t) => {
    const cases = [
      {
        name: "通常",
        minimized: false,
        visible: true,
        expectedOperations: ["show", "focus"],
      },
      {
        name: "最小化",
        minimized: true,
        visible: false,
        expectedOperations: ["restore", "show", "focus"],
      },
      {
        name: "非表示",
        minimized: false,
        visible: false,
        expectedOperations: ["show", "focus"],
      },
    ] as const;

    for (const testCase of cases) {
      await t.test(testCase.name, async () => {
        const session = createSession();
        const createdWindow = new StubWindow();
        let createCount = 0;
        const bridge = new SessionWindowBridge({
          createWindow() {
            createCount += 1;
            return createdWindow;
          },
          async loadChatEntry() {},
          getSession() {
            return session;
          },
          isRunInFlight() {
            return false;
          },
          getAllowQuitWithInFlightRuns() {
            return false;
          },
          confirmCloseWhileRunning() {
            return false;
          },
          broadcastOpenSessionWindowIds() {},
        });

        const first = await bridge.openSessionWindow(session.id);
        first.emitReady();
        first.resetActivation(testCase);
        const second = await bridge.openSessionWindow(session.id);

        assert.equal(first, second);
        assert.equal(createCount, 1);
        assert.equal(createdWindow.visible, true);
        assert.equal(createdWindow.focused, true);
        assert.deepEqual(createdWindow.activationOperations, testCase.expectedOperations);
      });
    }
  });

  it("V4 以前の session でも履歴閲覧用に window を開ける", async () => {
    const legacySession = createSession({ sourceSchemaVersion: 4 });
    let createCount = 0;
    let loadedChatMode: unknown = null;

    const bridge = new SessionWindowBridge({
      createWindow() {
        createCount += 1;
        return new StubWindow();
      },
      async loadChatEntry(_window, mode) {
        loadedChatMode = mode;
      },
      getSession() {
        return legacySession;
      },
      isRunInFlight() {
        return false;
      },
      getAllowQuitWithInFlightRuns() {
        return false;
      },
      confirmCloseWhileRunning() {
        return false;
      },
      broadcastOpenSessionWindowIds() {},
    });

    await bridge.openSessionWindow(legacySession.id);

    assert.equal(createCount, 1);
    assert.deepEqual(loadedChatMode, { kind: "agent", sessionId: legacySession.id });
  });

  it("entry load 失敗時は失敗した window の claim を破棄し、次回 open で作り直す", async () => {
    const session = createSession();
    const windows: StubWindow[] = [];
    let loadCount = 0;
    const bridge = new SessionWindowBridge({
      createWindow() {
        const window = new StubWindow();
        windows.push(window);
        return window;
      },
      async loadChatEntry() {
        loadCount += 1;
        if (loadCount === 1) {
          throw new Error("load failed");
        }
      },
      getSession() {
        return session;
      },
      isRunInFlight() {
        return false;
      },
      getAllowQuitWithInFlightRuns() {
        return false;
      },
      confirmCloseWhileRunning() {
        return false;
      },
      broadcastOpenSessionWindowIds() {},
    });

    await assert.rejects(bridge.openSessionWindow(session.id), /load failed/);
    assert.equal(bridge.getWindow(session.id), null);
    assert.equal(windows[0]?.destroyCount, 1);

    const recoveredWindow = await bridge.openSessionWindow(session.id);

    assert.equal(windows.length, 2);
    assert.equal(loadCount, 2);
    assert.equal(recoveredWindow, windows[1]);
  });

  it("entry load 中に重なった open は同じ load 結果を共有する", async () => {
    const session = createSession();
    let createCount = 0;
    let rejectLoad: ((error: Error) => void) | null = null;
    const bridge = new SessionWindowBridge({
      createWindow() {
        createCount += 1;
        return new StubWindow();
      },
      loadChatEntry() {
        return new Promise<void>((_resolve, reject) => {
          rejectLoad = reject;
        });
      },
      getSession() {
        return session;
      },
      isRunInFlight() {
        return false;
      },
      getAllowQuitWithInFlightRuns() {
        return false;
      },
      confirmCloseWhileRunning() {
        return false;
      },
      broadcastOpenSessionWindowIds() {},
    });

    const firstOpen = bridge.openSessionWindow(session.id);
    const secondOpen = bridge.openSessionWindow(session.id);
    assert.ok(rejectLoad);
    rejectLoad(new Error("load failed"));

    const results = await Promise.allSettled([firstOpen, secondOpen]);

    assert.equal(createCount, 1);
    assert.deepEqual(results.map(({ status }) => status), ["rejected", "rejected"]);
    assert.equal(bridge.getWindow(session.id), null);
  });

  it("別Sessionのopen完了時に読込中のWindowをsnapshotへ混ぜず、読込失敗後も残さない", async () => {
    const sessionA = createSession({ id: "session-a" });
    const sessionB = createSession({ id: "session-b" });
    let rejectSessionA: ((error: Error) => void) | null = null;
    const savedSnapshots: string[][] = [];
    const bridge = new SessionWindowBridge({
      createWindow: () => new StubWindow(),
      loadChatEntry(_window, mode) {
        if (mode.sessionId === sessionA.id) {
          return new Promise<void>((_resolve, reject) => {
            rejectSessionA = reject;
          });
        }
        return Promise.resolve();
      },
      getSession: (sessionId) => sessionId === sessionA.id ? sessionA : sessionB,
      isRunInFlight: () => false,
      getAllowQuitWithInFlightRuns: () => false,
      confirmCloseWhileRunning: () => false,
      broadcastOpenSessionWindowIds() {},
      async persistOpenSessionWindowIds(sessionIds) {
        savedSnapshots.push([...sessionIds]);
      },
    });

    const openingA = bridge.openSessionWindow(sessionA.id);
    await bridge.openSessionWindow(sessionB.id);
    assert.deepEqual(savedSnapshots, [[sessionB.id]]);

    assert.ok(rejectSessionA);
    rejectSessionA(new Error("load failed"));
    await assert.rejects(openingA, /load failed/);

    assert.deepEqual(savedSnapshots, [[sessionB.id]]);
  });

  it("古い window の遅延 closed は同じ Session の新しい window claim を解放しない", async () => {
    const session = createSession();
    const windows: StubWindow[] = [];
    const bridge = new SessionWindowBridge({
      createWindow() {
        const window = new StubWindow();
        windows.push(window);
        return window;
      },
      async loadChatEntry() {},
      getSession() {
        return session;
      },
      isRunInFlight() {
        return false;
      },
      getAllowQuitWithInFlightRuns() {
        return false;
      },
      confirmCloseWhileRunning() {
        return false;
      },
      broadcastOpenSessionWindowIds() {},
    });

    const oldWindow = await bridge.openSessionWindow(session.id);
    oldWindow.delayClosedEvent = true;
    oldWindow.close();
    const currentWindow = await bridge.openSessionWindow(session.id);

    oldWindow.emitClosed();
    const reopenedWindow = await bridge.openSessionWindow(session.id);

    assert.equal(windows.length, 2);
    assert.equal(reopenedWindow, currentWindow);
    assert.equal(bridge.getWindow(session.id), currentWindow);
  });

  it("running 中の close は確認ダイアログで継続可否を決める", async () => {
    const session = createSession();
    const window = new StubWindow();
    const confirms: boolean[] = [];

    const bridge = new SessionWindowBridge({
      createWindow() {
        return window;
      },
      async loadChatEntry() {},
      getSession() {
        return session;
      },
      isRunInFlight() {
        return true;
      },
      getAllowQuitWithInFlightRuns() {
        return false;
      },
      confirmCloseWhileRunning() {
        confirms.push(true);
        return true;
      },
      broadcastOpenSessionWindowIds() {},
    });

    await bridge.openSessionWindow(session.id);
    window.close();

    assert.equal(confirms.length, 1);
    assert.equal(window.destroyed, true);
    assert.equal(window.closeCount, 2);
  });

  it("idle の window close では Memory hook を起動せず window registry だけ更新する", async () => {
    const session = createSession();
    const broadcasts: string[][] = [];

    const bridge = new SessionWindowBridge({
      createWindow() {
        return new StubWindow();
      },
      async loadChatEntry() {},
      getSession(sessionId) {
        return sessionId === session.id ? session : null;
      },
      isRunInFlight() {
        return false;
      },
      getAllowQuitWithInFlightRuns() {
        return false;
      },
      confirmCloseWhileRunning() {
        return false;
      },
      broadcastOpenSessionWindowIds(openIds) {
        broadcasts.push([...openIds]);
      },
    });

    const window = await bridge.openSessionWindow(session.id);
    window.close();

    assert.deepEqual(broadcasts.at(-1), []);
  });

  it("snapshot保存失敗でもopenとcloseを維持する", async () => {
    const session = createSession();
    const errors: unknown[] = [];
    const bridge = new SessionWindowBridge({
      createWindow: () => new StubWindow(),
      async loadChatEntry() {},
      getSession: () => session,
      isRunInFlight: () => false,
      getAllowQuitWithInFlightRuns: () => false,
      confirmCloseWhileRunning: () => false,
      broadcastOpenSessionWindowIds() {},
      async persistOpenSessionWindowIds() {
        throw new Error("save failed");
      },
      onSnapshotPersistenceError(error) {
        errors.push(error);
      },
    });

    const window = await bridge.openSessionWindow(session.id);
    assert.equal(bridge.getWindow(session.id), window);
    window.close();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(bridge.getWindow(session.id), null);
    assert.equal(errors.length, 2);
  });

  it("quit前に現在集合を保存し、その後のWindow closeではsnapshotを空にしない", async () => {
    const session = createSession();
    const savedSnapshots: string[][] = [];
    const bridge = new SessionWindowBridge({
      createWindow: () => new StubWindow(),
      async loadChatEntry() {},
      getSession: () => session,
      isRunInFlight: () => false,
      getAllowQuitWithInFlightRuns: () => true,
      confirmCloseWhileRunning: () => false,
      broadcastOpenSessionWindowIds() {},
      async persistOpenSessionWindowIds(sessionIds) {
        savedSnapshots.push([...sessionIds]);
      },
    });

    const window = await bridge.openSessionWindow(session.id);
    savedSnapshots.splice(0);
    await bridge.prepareSnapshotForQuit();
    window.close();
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(savedSnapshots, [[session.id]]);
  });
});
