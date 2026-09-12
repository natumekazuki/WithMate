import assert from "node:assert/strict";
import test from "node:test";

import type { BrowserWindow, MenuItemConstructorOptions } from "electron";

import {
  SessionMonitorContextMenuService,
  type SessionMonitorContextMenuServiceDeps,
} from "../../src-electron/session-monitor-context-menu-service.js";
import { AuxWindowService } from "../../src-electron/aux-window-service.js";
import type {
  SessionMonitorContextMenuRequest,
  SessionMonitorContextMenuResult,
} from "../../src/withmate-window-types.js";

type PopupOptions = {
  x?: number;
  y?: number;
  callback?: () => void;
};

function createMenuHarness() {
  let template: MenuItemConstructorOptions[] = [];
  let popupOptions: PopupOptions | null = null;
  const menu = {
    popup(options: PopupOptions) {
      popupOptions = options;
    },
  };
  return {
    menu,
    getTemplate: () => template,
    getPopupOptions: () => popupOptions,
    buildMenu(nextTemplate: MenuItemConstructorOptions[]) {
      template = nextTemplate;
      return menu;
    },
  };
}

function invokeMenuItem(item: MenuItemConstructorOptions): void {
  item.click?.({} as never, {} as never, {} as never);
}

// @test-value v2
// kind = "contract"
// claim = "Session Monitor context menu はAgentとCompanionへ閉じる項目をそれぞれのWindow管理へ送り、未選択時はdismissedで終了する"
// oracle = { type = "contract", ref = "SessionMonitorContextMenuService close menu contract" }
// fault = "閉じる項目が別種別のWindowを閉じる、popup座標を失う、またはmenu取消時にrequestが未解決のまま残る"
// observable = "閉じる項目のlabel、popup座標、close delegateの呼出し、menu result"
// observation_boundary = "public-boundary"
// scope = "Session Monitor native context menu"
// lifecycle = "permanent"
// impact = "Monitorから対象外のSessionやMonitor自身を閉じず、通常のWindow close delegateへ到達させる"
// distinction = "rendererのrow event mappingやIPC request validationとは分離してnative menuのselection境界を検証する"
// @end-test-value
test("Session Monitor context menu は対象kindへ閉じる操作を送り、取消をdismissする", async () => {
  const cases: Array<{
    request: SessionMonitorContextMenuRequest;
    expectedTarget: string;
  }> = [
    {
      request: { kind: "agent", sessionId: "agent-1", point: { x: 24, y: 48 } },
      expectedTarget: "agent:agent-1",
    },
    {
      request: { kind: "companion", sessionId: "companion-1", point: { x: 72, y: 96 } },
      expectedTarget: "companion:companion-1",
    },
  ];

  for (const testCase of cases) {
    const harness = createMenuHarness();
    const closedTargets: string[] = [];
    const deps: SessionMonitorContextMenuServiceDeps = {
      requestCloseSessionWindow(sessionId) {
        closedTargets.push(`agent:${sessionId}`);
      },
      closeCompanionReviewWindow(sessionId) {
        closedTargets.push(`companion:${sessionId}`);
      },
      writeText() {},
      buildMenu: harness.buildMenu,
    };
    const service = new SessionMonitorContextMenuService(deps);

    const resultPromise = service.showContextMenu({} as BrowserWindow, testCase.request);
    const [menuItem] = harness.getTemplate();
    assert.equal(menuItem?.label, "閉じる");
    assert.deepEqual(harness.getPopupOptions(), {
      window: {} as BrowserWindow,
      x: testCase.request.point.x,
      y: testCase.request.point.y,
      callback: harness.getPopupOptions()?.callback,
    });

    invokeMenuItem(menuItem!);
    assert.deepEqual(await resultPromise, { status: "closed" } satisfies SessionMonitorContextMenuResult);
    assert.deepEqual(closedTargets, [testCase.expectedTarget]);
  }

  const harness = createMenuHarness();
  const service = new SessionMonitorContextMenuService({
    requestCloseSessionWindow() {},
    closeCompanionReviewWindow() {},
    writeText() {},
    buildMenu: harness.buildMenu,
  });
  const dismissedPromise = service.showContextMenu({} as BrowserWindow, {
    kind: "agent",
    sessionId: "dismissed",
    point: { x: 1, y: 2 },
  });
  harness.getPopupOptions()?.callback?.();
  assert.deepEqual(await dismissedPromise, { status: "dismissed" } satisfies SessionMonitorContextMenuResult);
});

// @test-value v2
// kind = "contract"
// claim = "Session Monitor context menuのSession IDをコピーはAgentとCompanionのrequest.sessionIdだけをclipboard writerへ渡し、失敗を成功扱いしない"
// oracle = { type = "contract", ref = "SessionMonitorContextMenuService Session ID copy contract" }
// fault = "コピー項目が別の値をclipboardへ渡す、対象Windowを閉じる、またはclipboard writerの例外をcopiedとして返す"
// observable = "clipboard writerへ渡された値、close delegateの呼出し、copy result"
// observation_boundary = "public-boundary"
// scope = "Session Monitor Session ID copy menu action"
// lifecycle = "permanent"
// impact = "Monitorから共有しやすいSession IDを安全に取得でき、コピー失敗を利用者に成功と誤認させない"
// distinction = "閉じる項目のWindow dispatchやrendererのrow event mappingとは分離してclipboard actionのeffectを検証する"
// @end-test-value
test("Session Monitor context menuのSession IDをコピーは対象IDだけをclipboardへ渡す", async () => {
  const requests: SessionMonitorContextMenuRequest[] = [
    { kind: "agent", sessionId: "agent-copy", point: { x: 1, y: 2 } },
    { kind: "companion", sessionId: "companion-copy", point: { x: 3, y: 4 } },
  ];

  for (const request of requests) {
    const harness = createMenuHarness();
    const copiedTexts: string[] = [];
    const closedTargets: string[] = [];
    const service = new SessionMonitorContextMenuService({
      requestCloseSessionWindow(sessionId) {
        closedTargets.push(`agent:${sessionId}`);
      },
      closeCompanionReviewWindow(sessionId) {
        closedTargets.push(`companion:${sessionId}`);
      },
      writeText(value) {
        copiedTexts.push(value);
      },
      buildMenu: harness.buildMenu,
    });

    const resultPromise = service.showContextMenu({} as BrowserWindow, request);
    const copyItem = harness.getTemplate().find((item) => item.label === "Session IDをコピー");
    assert.ok(copyItem);
    invokeMenuItem(copyItem);
    assert.deepEqual(await resultPromise, { status: "copied" } satisfies SessionMonitorContextMenuResult);
    assert.deepEqual(copiedTexts, [request.sessionId]);
    assert.deepEqual(closedTargets, []);
  }

  for (const kind of ["agent", "companion"] as const) {
    const harness = createMenuHarness();
    let copyAttempts = 0;
    const closedTargets: string[] = [];
    const service = new SessionMonitorContextMenuService({
      requestCloseSessionWindow() {
        closedTargets.push("agent");
      },
      closeCompanionReviewWindow() {
        closedTargets.push("companion");
      },
      writeText() {
        copyAttempts += 1;
        throw new Error("clipboard unavailable");
      },
      buildMenu: harness.buildMenu,
    });
    const resultPromise = service.showContextMenu({} as BrowserWindow, {
      kind,
      sessionId: `${kind}-copy-failed`,
      point: { x: 5, y: 6 },
    });
    const copyItem = harness.getTemplate().find((item) => item.label === "Session IDをコピー");
    assert.ok(copyItem);
    invokeMenuItem(copyItem);
    assert.deepEqual(await resultPromise, {
      status: "failed",
      message: "Session IDをコピーできませんでした。",
    } satisfies SessionMonitorContextMenuResult);
    assert.equal(copyAttempts, 1);
    assert.deepEqual(closedTargets, []);
  }
});

function createAuxWindowStub() {
  let destroyed = false;
  const closedListeners: Array<() => void> = [];
  return {
    async loadURL() {},
    async loadFile() {},
    isDestroyed: () => destroyed,
    isMinimized: () => false,
    restore() {},
    focus() {},
    show() {},
    close() {
      if (destroyed) {
        return;
      }
      destroyed = true;
      for (const listener of closedListeners) {
        listener();
      }
    },
    setAlwaysOnTop() {},
    once() {},
    on(event: "closed", listener: () => void) {
      if (event === "closed") {
        closedListeners.push(listener);
      }
    },
    destroyExternally() {
      destroyed = true;
    },
  };
}

// @test-value v2
// kind = "invariant"
// claim = "Companion review windowをMonitorから閉じると対象registryだけを更新し、既に消滅したtargetは安全に無視する"
// oracle = { type = "contract", ref = "AuxWindowService companion review window lifecycle" }
// fault = "別Companionのwindowやsession recordへ作用するか、closed競合時に例外またはstale registryを残す"
// observable = "対象windowのdestroyed state、open companion window IDs、window change通知数"
// observation_boundary = "public-boundary"
// scope = "AuxWindowService companion review close"
// lifecycle = "permanent"
// impact = "Monitorの閉じる操作で別Companionを閉じず、一覧更新がstale targetで止まらない"
// distinction = "native menuのselection dispatchとは分離してCompanion window registryのcloseと競合を検証する"
// @end-test-value
test("AuxWindowService は対象Companion review windowだけを閉じ、消滅済みtargetを無視する", async () => {
  const windows: Array<ReturnType<typeof createAuxWindowStub>> = [];
  let changeCount = 0;
  const service = new AuxWindowService({
    createWindow() {
      const window = createAuxWindowStub();
      windows.push(window);
      return window;
    },
    async loadHomeEntry() {},
    async loadDiffEntry() {},
    async loadFilePreviewEntry() {},
    async loadChatEntry() {},
    async loadCompanionMergeReviewEntry() {},
    async loadCharacterEditorEntry() {},
    onCompanionReviewWindowsChanged() {
      changeCount += 1;
    },
    generateDiffToken() {
      return "diff-token";
    },
  });

  const first = await service.openCompanionReviewWindow("companion-1");
  const second = await service.openCompanionReviewWindow("companion-2");
  service.closeCompanionReviewWindow("companion-1");

  assert.equal(first.isDestroyed(), true);
  assert.equal(second.isDestroyed(), false);
  assert.deepEqual(service.listOpenCompanionReviewWindowIds(), ["companion-2"]);
  assert.equal(changeCount, 3);

  service.closeCompanionReviewWindow("companion-1");
  assert.deepEqual(service.listOpenCompanionReviewWindowIds(), ["companion-2"]);

  const stale = await service.openCompanionReviewWindow("companion-3");
  windows.at(-1)?.destroyExternally();
  service.closeCompanionReviewWindow("companion-3");
  assert.equal(stale.isDestroyed(), true);
  assert.deepEqual(service.listOpenCompanionReviewWindowIds(), ["companion-2"]);
  assert.equal(changeCount, 5);
});
