import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildNewSession } from "../../src-shared/session/session-state.js";
import type { Session } from "../../src-shared/session/session-state.js";
import { DEFAULT_APPROVAL_MODE } from "../../src-shared/settings/approval-mode.js";
import {
  SessionWindowBridge,
  type SessionWindowCloseEvent,
  type SessionWindowLike,
} from "../../src-electron/session-window-bridge.js";
import { DEFAULT_QUIT_DRAFT_FLUSH_TIMEOUT_MS } from "../../src-electron/draft-flush-coordinator.js";

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

function createDraftFlushBridge(options: {
  waitForPendingDraftSends?: () => Promise<boolean>;
  getWindowSender?: (window: StubWindow) => unknown;
} = {}) {
  const requests: Array<{ window: StubWindow; requestId: string; sessionId: string; reason: "close" | "quit" }> = [];
  const releases: StubWindow[] = [];
  const closedIds: string[] = [];
  const bridge = new SessionWindowBridge({
    createWindow: () => new StubWindow(),
    async loadChatEntry() {},
    getSession: (id) => createSession({ id }),
    isRunInFlight: () => false,
    confirmCloseWhileRunning: () => false,
    broadcastOpenSessionWindowIds() {},
    onSessionWindowClosed: (id) => { closedIds.push(id); },
    getWindowSender: options.getWindowSender ?? ((window) => window),
    sendDraftFlushRequest: (window, request) => { requests.push({ window, ...request }); },
    sendDraftFlushRelease: (window) => { releases.push(window); },
    waitForPendingDraftSends: options.waitForPendingDraftSends,
  });
  return { bridge, requests, releases, closedIds };
}

describe("SessionWindowBridge", () => {
  // @test-value v2
  // kind = "contract"
  // claim = "新規Session WindowをopenするとWindowを作成し、registryへ登録してopen通知を行う"
  // oracle = { type = "contract", ref = "SessionWindowBridge#openSessionWindow" }
  // fault = "新規Windowが作成されない、registryへ登録されない、またはopen通知が行われない"
  // observable = "作成Window、loadされたchat mode、registryとopen Session ID通知"
  // observation_boundary = "public-boundary"
  // scope = "session-window-open"
  // lifecycle = "permanent"
  // impact = "Session画面を開けず、復元対象のWindow集合が不整合になる"
  // distinction = "open処理のregistryとentry load結果を確認し、既存Window再利用や失敗時claim破棄とは分ける"
  // @end-test-value
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
      confirmCloseWhileRunning() {
        return false;
      },
      broadcastOpenSessionWindowIds(openIds) {
        broadcasts.push([...openIds]);
      },
    });

    const window = await bridge.openSessionWindow(session.id);
    window.emitReady();

    assert.equal(bridge.getWindow(session.id), window);
    assert.deepEqual(loadedChatMode, { kind: "agent", sessionId: session.id });
    assert.deepEqual(broadcasts.at(-1), [session.id]);
    assert.equal(window.showCount, 1);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "既存Session WindowへのAuxiliary navigationは親Windowを再利用して対象Auxiliaryの識別情報だけをrendererへ渡す"
  // oracle = { type = "adr", ref = "docs/adr/006-windows-session-turn-notifications.md" }
  // fault = "Auxiliary通知のclickで別Windowを作る、親Windowをfocusしない、または対象AuxiliaryのIDを失う"
  // observable = "作成Window数、Windowのactivation操作、renderer navigation payload"
  // observation_boundary = "public-boundary"
  // scope = "session-window-auxiliary-navigation"
  // lifecycle = "permanent"
  // distinction = "通常のSession Window open testでは検証できない、既存Window再利用時のAuxiliary navigationを専用に検証する"
  // @end-test-value
  it("既存Session WindowへのAuxiliary openはWindowを再利用して対象を通知する", async () => {
    const session = createSession();
    const window = new StubWindow();
    const navigationPayloads: unknown[] = [];
    let createCount = 0;
    const bridge = new SessionWindowBridge({
      createWindow() {
        createCount += 1;
        return window;
      },
      async loadChatEntry() {},
      sendAuxiliarySessionNavigation(_window, payload) {
        navigationPayloads.push(payload);
      },
      getSession(sessionId) {
        return sessionId === session.id ? session : null;
      },
      isRunInFlight() {
        return false;
      },
      confirmCloseWhileRunning() {
        return false;
      },
      broadcastOpenSessionWindowIds() {},
    });

    await bridge.openSessionWindow(session.id);
    window.resetActivation({ minimized: false, visible: true });
    await bridge.openAuxiliarySessionWindow(session.id, "auxiliary-1");

    assert.equal(createCount, 1);
    assert.deepEqual(window.activationOperations, ["show", "focus"]);
    assert.deepEqual(navigationPayloads, [{
      parentSessionId: session.id,
      auxiliarySessionId: "auxiliary-1",
    }]);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "新規Session WindowへのAuxiliary openはentry loadへ対象Auxiliary IDを渡す"
  // oracle = { type = "adr", ref = "docs/adr/006-windows-session-turn-notifications.md" }
  // fault = "Auxiliary通知のclickで新規に親Windowを開くとき、対象Auxiliary IDをqueryへ渡さずMain会話を表示する"
  // observable = "作成Window数とentry loadへ渡されたChatEntryMode"
  // observation_boundary = "public-boundary"
  // scope = "session-window-auxiliary-navigation"
  // lifecycle = "permanent"
  // distinction = "既存Window再利用時のrenderer event通知とは分離して、新規Windowのentry query経路を専用に検証する"
  // @end-test-value
  it("新規Session WindowへのAuxiliary openはentry loadへ対象を渡す", async () => {
    const session = createSession();
    let loadedChatMode: unknown = null;
    let createCount = 0;
    const bridge = new SessionWindowBridge({
      createWindow() {
        createCount += 1;
        return new StubWindow();
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
      confirmCloseWhileRunning() {
        return false;
      },
      broadcastOpenSessionWindowIds() {},
    });

    await bridge.openAuxiliarySessionWindow(session.id, "auxiliary-1");

    assert.equal(createCount, 1);
    assert.deepEqual(loadedChatMode, {
      kind: "agent",
      sessionId: session.id,
      auxiliarySessionId: "auxiliary-1",
    });
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "親Session Windowのentry load中にAuxiliary openが重なっても、Window作成とentry loadを重複させずnavigationを保持する"
  // oracle = { type = "adr", ref = "docs/adr/006-windows-session-turn-notifications.md" }
  // fault = "通知clickが親Windowのload中に発生した時、別Windowを作る、Auxiliary navigationを失う、またはentry loadを二重実行する"
  // observable = "作成Window数、entry load回数、navigation payload、open結果のWindow同一性"
  // observation_boundary = "public-boundary"
  // scope = "session-window-auxiliary-navigation"
  // lifecycle = "permanent"
  // distinction = "settledな既存Window・新規Windowのquery経路とは分離して、opening中の共有promise経路を専用に検証する"
  // @end-test-value
  it("entry load中のAuxiliary openは親Windowの共有結果へnavigationする", async () => {
    const session = createSession();
    let resolveLoad: () => void = () => undefined;
    let createCount = 0;
    let loadCount = 0;
    const navigationPayloads: unknown[] = [];
    const bridge = new SessionWindowBridge({
      createWindow() {
        createCount += 1;
        return new StubWindow();
      },
      loadChatEntry() {
        loadCount += 1;
        return new Promise<void>((resolve) => {
          resolveLoad = resolve;
        });
      },
      sendAuxiliarySessionNavigation(_window, payload) {
        navigationPayloads.push(payload);
      },
      getSession(sessionId) {
        return sessionId === session.id ? session : null;
      },
      isRunInFlight() {
        return false;
      },
      confirmCloseWhileRunning() {
        return false;
      },
      broadcastOpenSessionWindowIds() {},
    });

    const mainOpen = bridge.openSessionWindow(session.id);
    const auxiliaryOpen = bridge.openAuxiliarySessionWindow(session.id, "auxiliary-1");
    assert.equal(createCount, 1);
    assert.equal(loadCount, 1);
    assert.ok(resolveLoad);
resolveLoad!();

    const [mainWindow, auxiliaryWindow] = await Promise.all([mainOpen, auxiliaryOpen]);
    assert.equal(mainWindow, auxiliaryWindow);
    assert.deepEqual(navigationPayloads, [{
      parentSessionId: session.id,
      auxiliarySessionId: "auxiliary-1",
    }]);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "既存Session Windowをopenすると通常・最小化・非表示の状態にかかわらず可視化してfocusする"
  // oracle = { type = "contract", ref = "SessionWindowBridge#openSessionWindow" }
  // fault = "既存Windowが可視化またはfocusされず、ユーザー操作の対象にならない"
  // observable = "各Window状態後のvisible、restore、focusの結果"
  // observation_boundary = "public-boundary"
  // scope = "session-window-reuse-visibility"
  // lifecycle = "permanent"
  // impact = "既存Sessionへ戻れず、重複Windowを開く誘因になる"
  // distinction = "既存Windowの状態遷移だけを確認し、新規openやentry loadとは分ける"
  // @end-test-value
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

  // @test-value v2
  // kind = "compatibility"
  // claim = "旧schema versionのSessionでも履歴閲覧用Windowをopenできる"
  // oracle = { type = "contract", ref = "SessionWindowBridge#openSessionWindow" }
  // fault = "旧Sessionのsource schemaを理由に履歴閲覧用Windowの作成またはloadを拒否する"
  // observable = "作成回数、entry load mode、open後のWindow状態"
  // observation_boundary = "public-boundary"
  // scope = "legacy-session-window-open"
  // lifecycle = "permanent"
  // impact = "維持対象の旧Sessionを閲覧できない"
  // distinction = "旧schema互換のopenだけを確認し、通常の新規Session openとは分ける"
  // @end-test-value
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
      confirmCloseWhileRunning() {
        return false;
      },
      broadcastOpenSessionWindowIds() {},
    });

    await bridge.openSessionWindow(legacySession.id);

    assert.equal(createCount, 1);
    assert.deepEqual(loadedChatMode, { kind: "agent", sessionId: legacySession.id });
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "entry load失敗時は失敗Windowのclaimを破棄し、次回openで再作成できる"
  // oracle = { type = "contract", ref = "SessionWindowBridge#openSessionWindow" }
  // fault = "失敗Windowのclaimが残り、次回openが壊れたWindowを再利用する"
  // observable = "load失敗後のregistryと次回openのWindow作成回数"
  // observation_boundary = "public-boundary"
  // scope = "session-window-load-failure-recovery"
  // lifecycle = "permanent"
  // impact = "一時的なload失敗からSession Windowを復旧できない"
  // distinction = "失敗claimの破棄と再作成を確認し、同時openの共有とは分ける"
  // @end-test-value
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

  // @test-value v2
  // kind = "invariant"
  // claim = "entry load中に同一Sessionのopenが重なっても一つのload結果を共有する"
  // oracle = { type = "contract", ref = "SessionWindowBridge#openSessionWindow" }
  // fault = "同一Sessionの重複openが複数Windowまたは複数entry loadを開始する"
  // observable = "Window作成数、load呼出数、重複openの結果と失敗後registry"
  // observation_boundary = "public-boundary"
  // scope = "session-window-open-coalescing"
  // lifecycle = "permanent"
  // impact = "重複Windowや競合するnavigationが発生する"
  // distinction = "load中の同一Sessionだけを確認し、既存Window再利用とは分ける"
  // @end-test-value
  it("entry load 中に重なった open は同じ load 結果を共有する", async () => {
    const session = createSession();
    let createCount = 0;
    let loadCount = 0;
    let rejectLoad: (error: Error) => void = () => undefined;
    const bridge = new SessionWindowBridge({
      createWindow() {
        createCount += 1;
        return new StubWindow();
      },
      loadChatEntry() {
        loadCount += 1;
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
      confirmCloseWhileRunning() {
        return false;
      },
      broadcastOpenSessionWindowIds() {},
    });

    const firstOpen = bridge.openSessionWindow(session.id);
    const secondOpen = bridge.openSessionWindow(session.id);
    assert.ok(rejectLoad);
rejectLoad!(new Error("load failed"));

    const results = await Promise.allSettled([firstOpen, secondOpen]);

    assert.equal(createCount, 1);
    assert.equal(loadCount, 1);
    assert.deepEqual(results.map(({ status }) => status), ["rejected", "rejected"]);
    assert.equal(bridge.getWindow(session.id), null);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "opening中のWindowを公開open Session ID集合へ含め、settled集合とrestore stateはload完了後だけ確定する"
  // oracle = { type = "contract", ref = "SessionWindowBridge#listOpenSessionWindowIds / listSettledOpenSessionWindowIds / getSessionWindowRestoreStates" }
  // fault = "opening中のWindowが公開open集合から欠落する、またはsettled/restore stateがload完了前に確定する"
  // observable = "公開open集合、settled集合、restore stateのload前後"
  // observation_boundary = "public-boundary"
  // scope = "session-window-opening-state"
  // lifecycle = "permanent"
  // impact = "Window復元やHome表示の対象が不整合になる"
  // distinction = "openingとsettledの集合境界を確認し、load失敗時のclaim破棄とは分ける"
  // @end-test-value
  it("open通知の集合にはopening中を含め、復元除外用の集合にはload完了後だけ含める", async () => {
    const session = createSession();
    let resolveLoad: () => void = () => undefined;
    const bridge = new SessionWindowBridge({
      createWindow: () => new StubWindow(),
      loadChatEntry: () => new Promise<void>((resolve) => {
        resolveLoad = resolve;
      }),
      getSession: () => session,
      isRunInFlight: () => false,

      confirmCloseWhileRunning: () => false,
      broadcastOpenSessionWindowIds() {},
    });

    const opening = bridge.openSessionWindow(session.id);

    assert.deepEqual(bridge.listOpenSessionWindowIds(), [session.id]);
    assert.deepEqual(bridge.listSettledOpenSessionWindowIds(), []);
    assert.equal(bridge.getSessionWindowRestoreStates().get(session.id)?.kind, "opening");

    assert.ok(resolveLoad);
    resolveLoad!();
    await opening;

    assert.deepEqual(bridge.listSettledOpenSessionWindowIds(), [session.id]);
    assert.equal(bridge.getSessionWindowRestoreStates().get(session.id)?.kind, "settled-open");
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "別Sessionのopen完了時に読込中Windowをsnapshotへ混ぜず、load失敗後に失敗claimを残さない"
  // oracle = { type = "contract", ref = "SessionWindowBridge#openSessionWindow" }
  // fault = "別Sessionの完了処理が読込中Windowを復元snapshotへ混入させる、または失敗claimを残す"
  // observable = "保存されたsnapshotとload失敗後の対象Session registry"
  // observation_boundary = "public-boundary"
  // scope = "session-window-cross-session-open"
  // lifecycle = "permanent"
  // impact = "再起動時に未完成または失敗したSession Windowを復元する"
  // distinction = "別Sessionの同時open境界を確認し、単一Sessionのload失敗とは分ける"
  // @end-test-value
  it("別Sessionのopen完了時に読込中のWindowをsnapshotへ混ぜず、読込失敗後も残さない", async () => {
    const sessionA = createSession({ id: "session-a" });
    const sessionB = createSession({ id: "session-b" });
    let rejectSessionA: (error: Error) => void = () => undefined;
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
rejectSessionA!(new Error("load failed"));
    await assert.rejects(openingA, /load failed/);

    assert.deepEqual(savedSnapshots, [[sessionB.id]]);
    assert.equal(bridge.getWindow(sessionA.id), null);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "同一Sessionの古いWindowから遅れて届くclosed通知は新しいWindowのclaimを解放しない"
  // oracle = { type = "contract", ref = "SessionWindowBridge#releaseWindowClaim" }
  // fault = "古いWindowの遅延closedが新しいWindowのregistry claimを削除する"
  // observable = "遅延closed後の新しいWindowのregistry claim"
  // observation_boundary = "public-boundary"
  // scope = "session-window-stale-close"
  // lifecycle = "permanent"
  // impact = "利用中のSession Windowが復元・close管理から外れる"
  // distinction = "古いWindowと新しいWindowのclaim世代だけを確認し、通常closeとは分ける"
  // @end-test-value
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

  // @test-value v2
  // kind = "contract"
  // claim = "実行中Sessionの通常closeは確認ダイアログで承認された場合にWindowを閉じる"
  // oracle = { type = "contract", ref = "SessionWindowBridge#handleWindowClose" }
  // fault = "実行中のSessionを確認なしに閉じる、または確認承認後にWindowを閉じない"
  // observable = "確認ダイアログ呼出しとWindowの破棄状態"
  // observation_boundary = "public-boundary"
  // scope = "session-window-running-close"
  // lifecycle = "permanent"
  // impact = "実行中Sessionの利用者操作と実行継続確認が壊れる"
  // distinction = "実行中closeの承認経路を確認し、確認拒否やdraft flush失敗時のclose拒否とは分ける"
  // @end-test-value
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

  // @test-value v2
  // kind = "contract"
  // claim = "Session MonitorからのSession Window close requestも通常closeと同じrunning確認を経て、承認時だけ閉じる"
  // oracle = { type = "contract", ref = "SessionWindowBridge requestCloseSessionWindow and running close contract" }
  // fault = "Monitorからのclose requestが実行中確認を飛ばす、確認後のcloseを二重化する、または対象Windowを閉じない"
  // observable = "確認回数、Windowのdestroyed state、close呼出し回数"
  // observation_boundary = "public-boundary"
  // scope = "Session Window normal close request"
  // lifecycle = "permanent"
  // impact = "Monitorの閉じる操作が削除用force closeにならず、既存の実行中確認を維持する"
  // distinction = "削除用closeSessionWindowのforce close経路やrenderer/native menu dispatchとは分離してbridgeの通常close契約を検証する"
  // @end-test-value
  it("requestCloseSessionWindow は通常closeの確認経路を使う", async () => {
    const session = createSession();
    const window = new StubWindow();
    let confirmCount = 0;
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
      confirmCloseWhileRunning() {
        confirmCount += 1;
        return true;
      },
      broadcastOpenSessionWindowIds() {},
    });

    await bridge.openSessionWindow(session.id);
    const closeResult = bridge.requestCloseSessionWindow(session.id);

    assert.equal(confirmCount, 1);
    assert.equal(window.destroyed, true);
    assert.equal(window.closeCount, 2);
    assert.deepEqual(bridge.listOpenSessionWindowIds(), []);
    assert.equal(await closeResult, true);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "Session MonitorからのSession Window close requestを実行中確認で取消すると、対象Windowとregistryを維持する"
  // oracle = { type = "contract", ref = "SessionWindowBridge requestCloseSessionWindow cancellation contract" }
  // fault = "確認取消後にWindowが閉じる、registryから消える、または確認が重複する"
  // observable = "確認回数、Windowのdestroyed state、close呼出し回数、open session IDs"
  // observation_boundary = "public-boundary"
  // scope = "Session Window normal close cancellation"
  // lifecycle = "permanent"
  // impact = "実行中SessionをMonitorの誤操作で失わず、既存の通常close取消を維持する"
  // distinction = "menu取消とは分離して、閉じる項目選択後のWindowClose確認取消を検証する"
  // @end-test-value
  it("running 中の close request取消ではWindowとregistryを維持する", async () => {
    const session = createSession();
    const window = new StubWindow();
    let confirmCount = 0;

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

      confirmCloseWhileRunning() {
        confirmCount += 1;
        return false;
      },
      broadcastOpenSessionWindowIds() {},
    });

    await bridge.openSessionWindow(session.id);
    const closeResult = bridge.requestCloseSessionWindow(session.id);

    assert.equal(confirmCount, 1);
    assert.equal(window.destroyed, false);
    assert.equal(window.closeCount, 1);
    assert.deepEqual(bridge.listOpenSessionWindowIds(), [session.id]);
    assert.equal(await closeResult, false);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "idle Sessionのcloseでは確認経路を起動せず、Window registry通知を更新する"
  // oracle = { type = "contract", ref = "SessionWindowBridge#handleWindowClose" }
  // fault = "idle closeで不要な確認を起動する、またはregistry通知を失う"
  // observable = "確認呼出し回数とclose後のregistry通知"
  // observation_boundary = "public-boundary"
  // scope = "session-window-idle-close"
  // lifecycle = "permanent"
  // impact = "不要な副作用やWindow一覧の不整合が発生する"
  // distinction = "idle closeの副作用境界を確認し、running closeやsnapshot persistenceとは分ける"
  // @end-test-value
  it("idle の window close では Memory hook を起動せず window registry だけ更新する", async () => {
    const session = createSession();
    const broadcasts: string[][] = [];
    let confirmCount = 0;

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

      confirmCloseWhileRunning() {
        confirmCount += 1;
        return false;
      },
      broadcastOpenSessionWindowIds(openIds) {
        broadcasts.push([...openIds]);
      },
    });

    const window = await bridge.openSessionWindow(session.id);
    window.close();

    assert.equal(confirmCount, 0);
    assert.deepEqual(broadcasts.at(-1), []);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "Session windowが閉じたときAuxiliary creation owner release hookを一度だけ通知する"
  // oracle = { type = "contract", ref = "src-electron/session-window-bridge.ts" }
  // fault = "window close後も作成ownerが保持され、遅延commitが旧scopeへ保存される"
  // observable = "close後のsession ID通知"
  // observation_boundary = "public-boundary"
  // scope = "session-window-creation-owner-release"
  // lifecycle = "permanent"
  // impact = "window closeで未完了Auxiliary作成を失効させる"
  // distinction = "registry更新だけを確認する既存close testではowner release通知を観測しない"
  // @end-test-value
  it("idle の window close ではAuxiliary creation ownerを解放する", async () => {
    const session = createSession();
    const closedSessionIds: string[] = [];
    const bridge = new SessionWindowBridge({
      createWindow: () => new StubWindow(),
      async loadChatEntry() {},
      getSession: () => session,
      isRunInFlight: () => false,

      confirmCloseWhileRunning: () => false,
      broadcastOpenSessionWindowIds() {},
      onSessionWindowClosed: (sessionId) => closedSessionIds.push(sessionId),
    });

    const window = await bridge.openSessionWindow(session.id);
    window.close();
    window.close();

    assert.deepEqual(closedSessionIds, [session.id]);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "Window snapshot保存が失敗してもopenとcloseのregistry処理を維持する"
  // oracle = { type = "contract", ref = "SessionWindowBridge#handleWindowClose" }
  // fault = "snapshot保存エラーでWindow registryのclose処理を中断し、閉じたWindowを残す"
  // observable = "保存エラー通知、close後のregistry、Window破棄状態"
  // observation_boundary = "public-boundary"
  // scope = "session-window-snapshot-failure"
  // lifecycle = "permanent"
  // impact = "Windowを閉じられず、open Window一覧が実態とずれる"
  // distinction = "snapshot persistence failure時のclose継続だけを確認し、draft flush failureとは分ける"
  // @end-test-value
  it("snapshot保存失敗でもopenとcloseを維持する", async () => {
    const session = createSession();
    const errors: unknown[] = [];
    const bridge = new SessionWindowBridge({
      createWindow: () => new StubWindow(),
      async loadChatEntry() {},
      getSession: () => session,
      isRunInFlight: () => false,

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

  // @test-value v2
  // kind = "invariant"
  // claim = "quit準備後のWindow closeでもsettled open snapshotを破棄しない"
  // oracle = { type = "contract", ref = "SessionWindowBridge#prepareSnapshotForQuit" }
  // fault = "quit準備中の遅延closeでrestore snapshotを空にして再起動時のWindowを失う"
  // observable = "保存されたopen Session Window ID"
  // observation_boundary = "public-boundary"
  // scope = "session-window-restore"
  // lifecycle = "permanent"
  // @end-test-value
  it("quit前に現在集合を保存し、その後のWindow closeではsnapshotを空にしない", async () => {
    const session = createSession();
    const savedSnapshots: string[][] = [];
    const bridge = new SessionWindowBridge({
      createWindow: () => new StubWindow(),
      async loadChatEntry() {},
      getSession: () => session,
      isRunInFlight: () => false,

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

  // @test-value v2
  // kind = "invariant"
  // claim = "通常closeのdraft flush失敗ではWindowを閉じず、再試行成功時は破棄済みWindowのsenderへ再アクセスせずcloseを完了する"
  // oracle = { type = "contract", ref = "SessionWindowBridge#requestCloseSessionWindow" }
  // fault = "flush失敗を成功扱いして入力を失う、または破棄済みWindowのsender取得で例外になりcloseが未完了になる"
  // observable = "close結果とWindowの破棄状態"
  // observation_boundary = "public-boundary"
  // scope = "session-window-draft-flush"
  // lifecycle = "permanent"
  // impact = "未保存入力を失うか、通常のWindow終了でmain process例外が発生する"
  // distinction = "破棄後のsender取得を拒否するfixtureで保存失敗から成功へのcloseを検証する。型検査や常時senderを返すstubでは検出できず、追加の実プロセス起動は不要"
  // @end-test-value
  it("draft flush失敗後のclose retryを成功時だけ完了する", async () => {
    const session = createSession({ id: "draft-close" });
    let bridge!: SessionWindowBridge<StubWindow>;
    let attempt = 0;
    const window = new StubWindow();
    bridge = new SessionWindowBridge({
      createWindow: () => window,
      async loadChatEntry() {},
      getSession: () => session,
      isRunInFlight: () => false,

      confirmCloseWhileRunning: () => false,
      broadcastOpenSessionWindowIds() {},
      getWindowSender: (candidate) => {
        if (candidate.isDestroyed()) throw new TypeError("Object has been destroyed");
        return "sender";
      },
      sendDraftFlushRequest: (_window, request) => {
        queueMicrotask(() => bridge.acknowledgeDraftFlush(request.requestId, "sender", attempt++ > 0));
      },
    });
    await bridge.openSessionWindow(session.id);
    assert.equal(await bridge.requestCloseSessionWindow(session.id), false);
    assert.equal(window.destroyed, false);
    assert.equal(await bridge.requestCloseSessionWindow(session.id), true);
    assert.equal(window.destroyed, true);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "quitは全renderer ACK後にMainの送信確定待ちを開始し、成功後だけ終了を許可し、失敗・例外・timeoutでは解凍する"
  // oracle = { type = "contract", ref = "SessionWindowBridge#flushSessionWindowDrafts" }
  // fault = "draft保存ACKだけでDB closeへ進み、送信失敗後の復元保存を待たない"
  // observable = "ACK前後のMain待機呼出し回数、送信確定前後のquit結果、Window closeと失敗release"
  // observation_boundary = "public-boundary"
  // scope = "session-window-pending-send-settlement"
  // lifecycle = "permanent"
  // @end-test-value
  it("quitはrenderer ACK後の送信確定まで待ち、失敗やtimeoutでは解凍する", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    for (const outcome of ["success", "failure", "timeout", "throw"]) {
      let releasePending!: (success: boolean) => void;
      const pendingSend = new Promise<boolean>((resolve) => { releasePending = resolve; });
      let waitCalls = 0;
      let quitCompleted = false;
      const { bridge, requests, releases } = createDraftFlushBridge({
        waitForPendingDraftSends: () => {
          waitCalls += 1;
          if (outcome === "throw") throw new Error("send settlement failed");
          return pendingSend;
        },
      });
      const window = await bridge.openSessionWindow("pending-send");
      const quitting = bridge.flushSessionWindowDrafts().then((result) => { quitCompleted = true; return result; });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(waitCalls, 0, "Main must snapshot pending sends only after renderer send/recovery ACKs");
      assert.equal(requests[0].reason, "quit");
      bridge.acknowledgeDraftFlush(requests[0].requestId, window, true);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(waitCalls, 1);
      if (outcome !== "throw") {
        assert.equal(quitCompleted, false);
        assert.deepEqual(releases, []);
        if (outcome === "timeout") t.mock.timers.tick(DEFAULT_QUIT_DRAFT_FLUSH_TIMEOUT_MS);
        else releasePending(outcome === "success");
      }
      assert.equal(await quitting, outcome === "success");
      assert.deepEqual(releases, outcome === "success" ? [] : [window]);
      assert.equal(window.isDestroyed(), false);
      if (outcome === "success") {
        window.close();
        assert.equal(window.isDestroyed(), true);
      }
      releasePending(true);
      window.destroy();
    }
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "app quitの全Window flushは全ackを待ち、1件失敗なら全Windowへreleaseする"
  // oracle = { type = "contract", ref = "SessionWindowBridge#flushSessionWindowDrafts" }
  // fault = "先に失敗したWindowだけで終了し、別Windowの未完了flushやfreeze解除を取りこぼす"
  // observable = "flush結果、release対象、完了までの待機"
  // observation_boundary = "public-boundary"
  // scope = "session-window-draft-flush"
  // lifecycle = "permanent"
  // @end-test-value
  it("全Window flushの完了を待って失敗releaseを全Windowへ送る", async () => {
    const sessions = [createSession({ id: "flush-a" }), createSession({ id: "flush-b" })];
    const windows = new Map<string, StubWindow>();
    const releases: string[] = [];
    let bridge!: SessionWindowBridge<StubWindow>;
    const bridgeWindows = new Map<StubWindow, string>();
    const requests = new Map<string, { requestId: string; sessionId: string }>();
    bridge = new SessionWindowBridge({
      createWindow: (id) => {
        const window = new StubWindow();
        windows.set(id, window);
        bridgeWindows.set(window, id);
        return window;
      },
      async loadChatEntry() {},
      getSession: (id) => sessions.find((session) => session.id === id) ?? null,
      isRunInFlight: () => false,

      confirmCloseWhileRunning: () => false,
      broadcastOpenSessionWindowIds() {},
      getWindowSender: () => "sender",
      sendDraftFlushRequest: (_window, request) => {
        requests.set(request.sessionId, request);
      },
      sendDraftFlushRelease: (window, payload) => {
        if (!payload.success) releases.push(bridgeWindows.get(window)!);
      },
    });
    await bridge.openSessionWindow("flush-a");
    await bridge.openSessionWindow("flush-b");
    const flushing = bridge.flushSessionWindowDrafts();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    assert.deepEqual(releases, []);
    bridge.acknowledgeDraftFlush(requests.get("flush-a")!.requestId, "sender", false);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    assert.deepEqual(releases, []);
    bridge.acknowledgeDraftFlush(requests.get("flush-b")!.requestId, "sender", true);
    assert.equal(await flushing, false);
    assert.deepEqual(releases.sort(), ["flush-a", "flush-b"]);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "明示的DBリセットの一括closeは保存ACKを待たずWindowを破棄し、closedに合わせて管理とownerを解放する"
  // oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md#session-window-close" }
  // fault = "通常closeのflush失敗で実Windowが残り、registryだけ空になる"
  // observable = "Window破棄状態、公開registry、closed通知、進行中closeの結果"
  // observation_boundary = "public-boundary"
  // scope = "session-window-reset-discard"
  // lifecycle = "permanent"
  // impact = "削除済みSessionのWindowが管理外で残り、終了や対象解決が壊れる"
  // distinction = "DBを書き換えずreset consumerの一括closeと遅延closedを検証する。通常close単独のtestでは検出できない"
  // @end-test-value
  it("resetの一括closeは未応答のdraft保存を待たず実Windowと管理を解放する", async () => {
    const { bridge, requests, closedIds } = createDraftFlushBridge();
    const first = await bridge.openSessionWindow("reset-a");
    const second = await bridge.openSessionWindow("reset-b");
    second.delayClosedEvent = true;
    const closing = bridge.requestCloseSessionWindow("reset-a");
    try {
      bridge.closeAllSessionWindows();
      assert.equal(first.isDestroyed(), true);
      assert.equal(second.isDestroyed(), true);
      assert.equal(await closing, true);
      assert.deepEqual(bridge.listOpenSessionWindowIds(), []);
      assert.deepEqual(closedIds, ["reset-a"]);
      second.emitClosed();
      assert.deepEqual(closedIds, ["reset-a", "reset-b"]);
      assert.equal(bridge.getWindow("reset-b"), null);
      for (const request of requests) {
        assert.equal(bridge.acknowledgeDraftFlush(request.requestId, request.window, false), false);
      }
    } finally {
      first.destroy();
      second.destroy();
      second.emitClosed();
    }
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "通常closeとquitが重なってもquitの強いflushを待ち、保存済みcloseだけでrendererを先に破棄しない"
  // oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md" }
  // fault = "close ACKだけでrendererを破棄し、quitの強いflushやpending sendのsettlementを取りこぼす"
  // observable = "closeとquitの結果、Window破棄状態、rendererへの保存要求数"
  // observation_boundary = "public-boundary"
  // scope = "session-window-close-quit-overlap"
  // lifecycle = "permanent"
  // impact = "送信結果が未確定の下書きを失ったままDBを閉じる"
  // distinction = "両方の開始順序を制御し、単独closeやquitでは観測できない競合を小さいメモリWindowで検証する"
  // @end-test-value
  it("close先行とquit先行のどちらでも保存成功を共有する", async () => {
    for (const closeFirst of [true, false]) {
      const { bridge, requests } = createDraftFlushBridge();
      const window = await bridge.openSessionWindow("overlap");
      const first = closeFirst ? bridge.requestCloseSessionWindow("overlap") : bridge.flushSessionWindowDrafts();
      const second = closeFirst ? bridge.flushSessionWindowDrafts() : bridge.requestCloseSessionWindow("overlap");
      const quitting = closeFirst ? second : first;
      try {
        assert.deepEqual(
          requests.map((request) => request.reason),
          closeFirst ? ["close", "quit"] : ["quit"],
        );
        bridge.acknowledgeDraftFlush(requests[0].requestId, window, true);
        await new Promise((resolve) => setImmediate(resolve));
        for (const request of requests.slice(1)) bridge.acknowledgeDraftFlush(request.requestId, window, true);
        assert.equal(await quitting, true);
        assert.equal(window.isDestroyed(), false);
        window.close();
        assert.equal(window.isDestroyed(), true);
        assert.deepEqual(await Promise.all([first, second]), [true, true]);
        assert.equal(requests.length, closeFirst ? 2 : 1);
      } finally {
        window.destroy();
      }
    }
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "quit失敗後の新しいclose retryは、失敗した旧close ACKに破棄や失敗を汚染されない"
  // oracle = { type = "contract", ref = "SessionWindowBridge#requestCloseSessionWindow" }
  // fault = "quit failure後に到着した旧close ACKがWindowを閉じる、または新しいclose flushを失敗扱いにする"
  // observable = "旧ACK前後のWindow破棄状態、新retryの結果、flush release対象"
  // observation_boundary = "public-boundary"
  // scope = "session-window-close-quit-stale-ack"
  // lifecycle = "permanent"
  // @end-test-value
  it("quit失敗後の旧close ACKを無視して新しいclose retryを完了する", async () => {
    const { bridge, requests, releases } = createDraftFlushBridge();
    const window = await bridge.openSessionWindow("stale-close");
    const closing = bridge.requestCloseSessionWindow("stale-close");
    const quitting = bridge.flushSessionWindowDrafts();
    assert.deepEqual(requests.map((request) => request.reason), ["close", "quit"]);
    bridge.acknowledgeDraftFlush(requests[1].requestId, window, false);
    assert.equal(await quitting, false);
    assert.deepEqual(releases, [window]);
    const retry = bridge.requestCloseSessionWindow("stale-close");
    const retryRequest = requests.at(-1)!;
    assert.equal(retryRequest.reason, "close");
    bridge.acknowledgeDraftFlush(requests[0].requestId, window, true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(window.isDestroyed(), false);
    assert.deepEqual(releases, [window], "a late close ACK must not release the retry's freeze");
    bridge.acknowledgeDraftFlush(retryRequest.requestId, window, true);
    assert.equal(await retry, true);
    assert.equal(await closing, false);
    assert.equal(window.isDestroyed(), true);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "close失敗またはclose timeoutがquitと重なっても、quitの強いflush結果を優先する"
  // oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md" }
  // fault = "弱いclose timeoutをquitの失敗と誤認し、強いquit ACK前にWindowを破棄する"
  // observable = "close timeout後のquit結果、release通知、Window生存状態"
  // observation_boundary = "public-boundary"
  // scope = "session-window-close-quit-failure"
  // lifecycle = "permanent"
  // impact = "送信settlement待ちを省略し、未保存本文を失う"
  // distinction = "closeの弱い失敗とquitの強いflush結果を分離して確認する"
  // @end-test-value
  it("closeの失敗とtimeoutではquit全体が終わるまで解凍しない", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    for (const failure of ["ack", "timeout"]) {
      const { bridge, requests, releases } = createDraftFlushBridge();
      const first = await bridge.openSessionWindow("failure-a");
      const second = await bridge.openSessionWindow("failure-b");
      const closing = bridge.requestCloseSessionWindow("failure-a");
      t.mock.timers.tick(5_000);
      const quitting = bridge.flushSessionWindowDrafts();
      try {
        if (failure === "ack") bridge.acknowledgeDraftFlush(requests[0].requestId, first, false);
        else t.mock.timers.tick(5_000);
        assert.equal(first.isDestroyed(), false);
        assert.deepEqual(releases, []);
        for (const request of requests.slice(1)) bridge.acknowledgeDraftFlush(request.requestId, request.window, true);
        assert.equal(await quitting, true);
        assert.deepEqual(releases, []);
        assert.equal(first.isDestroyed(), false);
        assert.deepEqual(requests.map((request) => request.reason), ["close", "quit", "quit"]);
        first.close();
        second.close();
        assert.equal(await closing, true);
      } finally {
        first.destroy();
        second.destroy();
      }
    }
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "quitのACK後も通常closeはquit gate中にWindowを破棄せず、quitの結果を優先する"
  // oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md" }
  // fault = "quit gate中の通常closeでrendererを先に破棄し、pending sendのsettlementを迂回する"
  // observable = "quit完了前後のWindow生存、close要求の保留、release対象"
  // observation_boundary = "public-boundary"
  // scope = "session-window-quit-ack-close"
  // lifecycle = "permanent"
  // impact = "送信結果が未確定のままWindowを閉じ、復元対象の本文を失う"
  // distinction = "quit gate中のcloseが追加flushや破棄へ進まず、quitの強いACK境界を守ることを確認する"
  // @end-test-value
  it("quit中のACK後closeはWindowを破棄せずquit結果を待つ", async () => {
    let releasePending!: () => void;
    const pendingSend = new Promise<boolean>((resolve) => { releasePending = () => resolve(true); });
    const { bridge, requests, releases } = createDraftFlushBridge({ waitForPendingDraftSends: () => pendingSend });
    const first = await bridge.openSessionWindow("saved-a");
    const second = await bridge.openSessionWindow("saved-b");
    let quitCompleted = false;
    const quitting = bridge.flushSessionWindowDrafts().then((result) => { quitCompleted = true; return result; });
    try {
      bridge.acknowledgeDraftFlush(requests[0].requestId, first, true);
      await new Promise((resolve) => setImmediate(resolve));
      let closeCompleted = false;
      const closing = bridge.requestCloseSessionWindow("saved-a").then((result) => { closeCompleted = true; return result; });
      assert.equal(first.isDestroyed(), false);
      assert.equal(requests.length, 2);
      bridge.acknowledgeDraftFlush(requests[1].requestId, second, true);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(quitCompleted, false, "renderer ACKs alone must not bypass Main's pending sends");
      assert.equal(closeCompleted, false);
      assert.deepEqual(releases, []);
      assert.equal(first.isDestroyed(), false);
      first.close();
      assert.equal(first.isDestroyed(), false, "close remains deferred during Main send settlement");
      releasePending();
      assert.equal(await quitting, true);
      first.close();
      assert.equal(first.isDestroyed(), true);
      assert.equal(await closing, true);
      assert.equal(await quitting, true);
    } finally {
      first.destroy();
      second.destroy();
    }
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "共有flushのACK前にWindowが消滅した場合は破棄済みsenderへアクセスせずそのWindowの要求だけ失効させ、quit失敗後に生存Windowで再試行できる"
  // oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md" }
  // fault = "破棄済みWindowへのアクセスで例外となる、消滅を保存成功扱いする、または別Windowの未完了flushまで失効させる"
  // observable = "破棄時の例外の不在、破棄済み・生存WindowのACK受理結果、quitの失敗、生存Windowへのrelease、再試行の成功"
  // observation_boundary = "public-boundary"
  // scope = "session-window-close-quit-destroy"
  // lifecycle = "permanent"
  // impact = "保存成否不明なのに全体終了するか、残ったWindowを編集できなくなる"
  // distinction = "Windowとsenderを別identityにし破棄後の取得を拒否して、ACK前destroyの失敗と別Windowの要求保持を確認する。型検査・正常closeだけでは代替できず実プロセス起動も不要"
  // @end-test-value
  it("共有flushのACK前destroyはquit失敗となり生存Windowで再試行できる", async () => {
    const senders = new Map<StubWindow, object>();
    const { bridge, requests, releases } = createDraftFlushBridge({
      getWindowSender: (window) => {
        if (window.isDestroyed()) throw new TypeError("Object has been destroyed");
        let sender = senders.get(window);
        if (!sender) {
          sender = {};
          senders.set(window, sender);
        }
        return sender;
      },
    });
    const first = await bridge.openSessionWindow("destroy-a");
    const second = await bridge.openSessionWindow("destroy-b");
    void bridge.requestCloseSessionWindow("destroy-a");
    const quitting = bridge.flushSessionWindowDrafts();
    assert.doesNotThrow(() => first.destroy());
    for (const request of requests) {
      assert.equal(
        bridge.acknowledgeDraftFlush(request.requestId, senders.get(request.window), true),
        request.window === second,
      );
    }
    assert.equal(await quitting, false);
    assert.deepEqual(releases, [second]);
    const retry = bridge.flushSessionWindowDrafts();
    const latest = requests.at(-1)!;
    assert.equal(bridge.acknowledgeDraftFlush(latest.requestId, senders.get(second), true), true);
    assert.equal(await retry, true);
    second.close();
    assert.equal(second.isDestroyed(), true);
  });
});
