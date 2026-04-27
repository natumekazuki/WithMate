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
  minimized = false;
  showCount = 0;
  focusCount = 0;
  restoreCount = 0;
  closeCount = 0;
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
    this.restoreCount += 1;
  }

  focus(): void {
    this.focusCount += 1;
  }

  show(): void {
    this.showCount += 1;
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
    for (const listener of this.closedListeners) {
      listener();
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
}

describe("SessionWindowBridge", () => {
  it("新規 open で registry 更新・entry load を行う", async () => {
    const session = createSession();
    const windows: StubWindow[] = [];
    const broadcasts: string[][] = [];
    const reflections: Array<{ sessionId: string; triggerReason: string }> = [];
    let loadedSessionId: string | null = null;

    const bridge = new SessionWindowBridge({
      createWindow() {
        const window = new StubWindow();
        windows.push(window);
        return window;
      },
      async loadSessionEntry(_window, sessionId) {
        loadedSessionId = sessionId;
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
      runCharacterReflection(nextSession, options) {
        reflections.push({ sessionId: nextSession.id, triggerReason: options.triggerReason });
      },
    });

    const window = await bridge.openSessionWindow(session.id);
    window.emitReady();

    assert.equal(loadedSessionId, session.id);
    assert.deepEqual(broadcasts.at(-1), [session.id]);
    assert.deepEqual(reflections, []);
    assert.equal(window.showCount, 1);
  });

  it("既存 window を再利用し、minimize されていれば restore して focus する", async () => {
    const session = createSession();
    const createdWindow = new StubWindow();
    createdWindow.minimized = true;
    let createCount = 0;

    const bridge = new SessionWindowBridge({
      createWindow() {
        createCount += 1;
        return createdWindow;
      },
      async loadSessionEntry() {},
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
      runCharacterReflection() {},
    });

    const first = await bridge.openSessionWindow(session.id);
    const second = await bridge.openSessionWindow(session.id);

    assert.equal(first, second);
    assert.equal(createCount, 1);
    assert.equal(createdWindow.restoreCount, 1);
    assert.equal(createdWindow.focusCount, 1);
  });

  it("running 中の close は確認ダイアログで継続可否を決める", async () => {
    const session = createSession();
    const window = new StubWindow();
    const confirms: boolean[] = [];

    const bridge = new SessionWindowBridge({
      createWindow() {
        return window;
      },
      async loadSessionEntry() {},
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
      runCharacterReflection() {},
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
      async loadSessionEntry() {},
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
      runCharacterReflection() {},
    });

    const window = await bridge.openSessionWindow(session.id);
    window.close();

    assert.deepEqual(broadcasts.at(-1), []);
  });
});
