import assert from "node:assert/strict";
import test from "node:test";

import type { BrowserWindow, MenuItemConstructorOptions } from "electron";

import {
  SessionMonitorContextMenuService,
  type SessionMonitorContextMenuServiceDeps,
} from "../../src-electron/session/session-monitor-context-menu-service.js";
import { AuxWindowService } from "../../src-electron/auxiliary/aux-window-service.js";
import type {
  SessionMonitorContextMenuRequest,
  SessionMonitorContextMenuResult,
} from "../../src-shared/window/withmate-window-types.js";

/** ポップアップ表示時の位置と終了通知を検査するためのオプションを表す。 */
type PopupOptions = {
  x?: number;
  y?: number;
  callback?: () => void;
};

// @test-value v2
// kind = "contract"
// claim = "閉じた監視対象はCloseを無効化し、Session IDのコピーは利用できる"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md#session-window-close" }
// fault = "Windowがない対象へ無効なClose操作を提示するかコピーを阻害する"
// observable = "menu enabled状態とcopy結果"
// observation_boundary = "public-boundary"
// scope = "monitor-closed-window-menu"
// lifecycle = "permanent"
// @end-test-value
/** 既に閉じたウィンドウは閉じられない一方、保存済みの識別子はコピーできることを確認する。 */
test("閉じた監視対象のCloseは無効でもSession IDをコピーできる", async () => {
  const harness = createMenuHarness();
  const copied: string[] = [];
  const service = new SessionMonitorContextMenuService({
    /** 対象セッションのウィンドウが既に閉じていると報告する。 */
    isSessionWindowOpen: () => false,
    /** 識別子のコピーにタイトル取得を使った場合は失敗させる。 */
    readSessionTitle: async () => {
      throw new Error("ID copy must not read the title");
    },
    /** 閉じたセッションを再度閉じようとした場合は検証を失敗させる。 */
    requestCloseSessionWindow: async () => {
      throw new Error("Window is not open");
    },
    /** 実際のクリップボードへ書かず、コピー対象を記録する。 */
    writeText: (value) => {
      copied.push(value);
    },
    buildMenu: harness.buildMenu,
  });
  const result = service.showContextMenu({} as BrowserWindow, {
    kind: "agent",
    sessionId: "closed",
    point: { x: 0, y: 0 },
  });
  assert.equal(harness.getTemplate()[0]!.enabled, false);
  invokeMenuItem(
    harness.getTemplate().find((item) => item.label === "Copy Session ID")!,
  );
  assert.deepEqual(await result, { status: "copied" });
  assert.deepEqual(copied, ["closed"]);
});

/** Electron のメニューを表示せず、項目の構成・表示位置・終了通知を観測できるようにする。 */
function createMenuHarness() {
  let template: MenuItemConstructorOptions[] = [];
  let popupOptions: PopupOptions | null = null;
  const menu = {
    /** ポップアップの引数を保持し、表示後の操作を手動で再現できるようにする。 */
    popup(options: PopupOptions) {
      popupOptions = options;
    },
  };
  return {
    menu,
    /** 最後に作られたメニューの項目を返す。 */
    getTemplate: () => template,
    /** 最後の表示位置と閉じる通知を検査できるようにする。 */
    getPopupOptions: () => popupOptions,
    /** 表示対象の項目を捕捉し、ポップアップの代替実装を返す。 */
    buildMenu(nextTemplate: MenuItemConstructorOptions[]) {
      template = nextTemplate;
      return menu;
    },
  };
}
/** メニュー項目に登録された選択処理だけを画面を開かずに起動する。 */
function invokeMenuItem(item: MenuItemConstructorOptions): void {
  item.click?.({} as never, {} as never, {} as never);
}

// @test-value v2
// kind = "contract"
// claim = "Session Monitor context menu はAgentへ閉じる項目を通常のWindow管理へ送り、未選択時はdismissedで終了する"
// oracle = { type = "contract", ref = "SessionMonitorContextMenuService close menu contract" }
// fault = "閉じる項目が別種別のWindowを閉じる、popup座標を失う、またはmenu取消時にrequestが未解決のまま残る"
// observable = "閉じる項目のlabel、popup座標、close delegateの呼出し、menu result"
// observation_boundary = "public-boundary"
// scope = "Session Monitor native context menu"
// lifecycle = "permanent"
// impact = "Monitorから対象外のSessionやMonitor自身を閉じず、通常のWindow close delegateへ到達させる"
// distinction = "rendererのrow event mappingやIPC request validationとは分離してnative menuのselection境界を検証する"
// @end-test-value
/** セッションの種類に合った閉じる処理を選び、選択なしでメニューを閉じた場合は取り消しを返す。 */
test("Session Monitor context menu は対象kindへ閉じる操作を送り、取消をdismissする", async () => {
  const cases: Array<{
    request: SessionMonitorContextMenuRequest;
    expectedTarget: string;
  }> = [
    {
      request: { kind: "agent", sessionId: "agent-1", point: { x: 24, y: 48 } },
      expectedTarget: "agent:agent-1",
    },
  ];

  for (const testCase of cases) {
    const harness = createMenuHarness();
    const closedTargets: string[] = [];
    const deps: SessionMonitorContextMenuServiceDeps = {
      /** 閉じる項目が有効になるよう対象を開いていると報告する。 */
      isSessionWindowOpen: () => true,
      /** ウィンドウを閉じるために不要なタイトルの読み取りを拒否する。 */
      readSessionTitle: async () => {
        throw new Error("Close must not read the title");
      },
      /** 通常セッションを閉じる処理に渡された識別子を記録する。 */
      requestCloseSessionWindow(sessionId) {
        closedTargets.push(`agent:${sessionId}`);
        return Promise.resolve(true);
      },
      /** 閉じる操作ではクリップボードの実環境に書き込まない。 */
      writeText() {},
      buildMenu: harness.buildMenu,
    };
    const service = new SessionMonitorContextMenuService(deps);

    const resultPromise = service.showContextMenu(
      {} as BrowserWindow,
      testCase.request,
    );
    const [menuItem] = harness.getTemplate();
    assert.equal(menuItem?.label, "Close");
    assert.deepEqual(harness.getPopupOptions(), {
      window: {} as BrowserWindow,
      x: testCase.request.point.x,
      y: testCase.request.point.y,
      callback: harness.getPopupOptions()?.callback,
    });

    invokeMenuItem(menuItem!);
    assert.deepEqual(await resultPromise, {
      status: "closed",
    } satisfies SessionMonitorContextMenuResult);
    assert.deepEqual(closedTargets, [testCase.expectedTarget]);
  }

  const harness = createMenuHarness();
  const service = new SessionMonitorContextMenuService({
    /** 閉じる操作が選ばれた場合にだけ成功を返せるようにする。 */
    requestCloseSessionWindow() {
      return Promise.resolve(true);
    },
    /** 開いている対象でも何も選ばずメニューを閉じられる状況を作る。 */
    isSessionWindowOpen: () => true,
    /** 選択なしに閉じたメニューからタイトルを取得した場合は失敗させる。 */
    readSessionTitle: async () => {
      throw new Error("Dismiss must not read the title");
    },
    /** 取り消しの検証では実際のクリップボードを使わない。 */
    writeText() {},
    buildMenu: harness.buildMenu,
  });
  const dismissedPromise = service.showContextMenu({} as BrowserWindow, {
    kind: "agent",
    sessionId: "dismissed",
    point: { x: 1, y: 2 },
  });
  harness.getPopupOptions()?.callback?.();
  assert.deepEqual(await dismissedPromise, {
    status: "dismissed",
  } satisfies SessionMonitorContextMenuResult);
});

// @test-value v2
// kind = "contract"
// claim = "Session MonitorのAgent close resultは実際のWindow close完了後だけclosedになり、確認取消はdismissedになる"
// oracle = { type = "contract", ref = "SessionMonitorContextMenuService close completion result" }
// fault = "close delegateのpreventDefaultや確認取消をclosedとして返し、Monitorに誤った成功表示を出す"
// observable = "close delegateのresultとmenu result"
// observation_boundary = "public-boundary"
// scope = "Session Monitor native context menu close completion"
// lifecycle = "permanent"
// impact = "確認取消を利用者に閉じたと誤認させず、Windowの実状態を反映する"
// distinction = "delegate dispatchの対象kind検証とは分離してclose完了結果を検証する"
// @end-test-value
/** 閉じる処理が取り消しを返したとき、メニューの結果も閉鎖成功としない。 */
test("Session Monitor context menu はclose delegateの取消をclosedとして返さない", async () => {
  const harness = createMenuHarness();
  const service = new SessionMonitorContextMenuService({
    /** ウィンドウを閉じる処理側での取り消しを再現する。 */
    requestCloseSessionWindow: async () => false,
    /** 閉じる処理の成否に不要なタイトル取得を拒否する。 */
    readSessionTitle: async () => {
      throw new Error("Close must not read the title");
    },
    /** 開いている対象に対して閉じる処理を選べるようにする。 */
    isSessionWindowOpen: () => true,
    /** 閉鎖の取り消しとクリップボード処理を分離する。 */
    writeText() {},
    buildMenu: harness.buildMenu,
  });
  const resultPromise = service.showContextMenu({} as BrowserWindow, {
    kind: "agent",
    sessionId: "cancelled-close",
    point: { x: 1, y: 2 },
  });
  invokeMenuItem(harness.getTemplate()[0]!);
  assert.deepEqual(await resultPromise, {
    status: "dismissed",
  } satisfies SessionMonitorContextMenuResult);
});

// @test-value v2
// kind = "contract"
// claim = "Session Monitor context menuのSession IDをコピーはAgentのrequest.sessionIdだけをclipboard writerへ渡し、失敗を成功扱いしない"
// oracle = { type = "contract", ref = "SessionMonitorContextMenuService Session ID copy contract" }
// fault = "コピー項目が別の値をclipboardへ渡す、対象Windowを閉じる、またはclipboard writerの例外をcopiedとして返す"
// observable = "clipboard writerへ渡された値、close delegateの呼出し、copy result"
// observation_boundary = "public-boundary"
// scope = "Session Monitor Session ID copy menu action"
// lifecycle = "permanent"
// impact = "Monitorから共有しやすいSession IDを安全に取得でき、コピー失敗を利用者に成功と誤認させない"
// distinction = "閉じる項目のWindow dispatchやrendererのrow event mappingとは分離してclipboard actionのeffectを検証する"
// @end-test-value
/** 対象の種類によらず指定済みの識別子だけをクリップボードに渡すことを確認する。 */
test("Session Monitor context menuのSession IDをコピーは対象IDだけをclipboardへ渡す", async () => {
  const requests: SessionMonitorContextMenuRequest[] = [
    { kind: "agent", sessionId: "agent-copy", point: { x: 1, y: 2 } },
  ];

  for (const request of requests) {
    const harness = createMenuHarness();
    const copiedTexts: string[] = [];
    const closedTargets: string[] = [];
    const service = new SessionMonitorContextMenuService({
      /** コピー時に通常セッションの閉鎖も起きていないかを記録する。 */
      requestCloseSessionWindow(sessionId) {
        closedTargets.push(`agent:${sessionId}`);
        return Promise.resolve(true);
      },
      /** 開いているセッションでも識別子のコピーを実行するための状態を返す。 */
      isSessionWindowOpen: () => true,
      /** 識別子のコピーに保存済みタイトルを使用していないことを検証する。 */
      readSessionTitle: async () => {
        throw new Error("ID copy must not read the title");
      },
      /** 識別子コピーがクリップボードに渡した値を保存する。 */
      writeText(value) {
        copiedTexts.push(value);
      },
      buildMenu: harness.buildMenu,
    });

    const resultPromise = service.showContextMenu({} as BrowserWindow, request);
    const copyItem = harness
      .getTemplate()
      .find((item) => item.label === "Copy Session ID");
    assert.ok(copyItem);
    invokeMenuItem(copyItem);
    assert.deepEqual(await resultPromise, {
      status: "copied",
    } satisfies SessionMonitorContextMenuResult);
    assert.deepEqual(copiedTexts, [request.sessionId]);
    assert.deepEqual(closedTargets, []);
  }

  for (const kind of ["agent"] as const) {
    const harness = createMenuHarness();
    let copyAttempts = 0;
    const closedTargets: string[] = [];
    const service = new SessionMonitorContextMenuService({
      /** クリップボードが失敗した際に、対象を閉じていないかを記録する。 */
      requestCloseSessionWindow() {
        closedTargets.push("agent");
        return Promise.resolve(true);
      },
      /** クリップボード失敗のケースでもウィンドウは開いているとする。 */
      isSessionWindowOpen: () => true,
      /** 識別子のコピーが失敗してもタイトル取得へ退避させない。 */
      readSessionTitle: async () => {
        throw new Error("ID copy must not read the title");
      },
      /** クリップボード書き込みの試行を計数し、書き込み失敗を再現する。 */
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
    const copyItem = harness
      .getTemplate()
      .find((item) => item.label === "Copy Session ID");
    assert.ok(copyItem);
    invokeMenuItem(copyItem);
    assert.deepEqual(await resultPromise, {
      status: "failed",
      message: "Session ID could not be copied.",
    } satisfies SessionMonitorContextMenuResult);
    assert.equal(copyAttempts, 1);
    assert.deepEqual(closedTargets, []);
  }
});

// @test-value v2
// kind = "contract"
// claim = "タイトルコピーはメニュー選択時に対象Sessionの現在の全文を取得し、Windowを閉じずに一度だけコピーする"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#home-window" }
// fault = "表示用に省略された値や古いタイトル・別Sessionをコピーする、取得中のmenu終了を取消にする、または二重実行する"
// observable = "タイトル取得先、clipboard writerへ渡す全文、close呼出し回数、menu result"
// observation_boundary = "public-boundary"
// scope = "Session Monitor title copy selection"
// lifecycle = "permanent"
// impact = "長いタイトルや更新したタイトルを正確に共有できる"
// distinction = "IDコピーやrenderer event testでは観測しない、選択時の非同期タイトル取得とclipboard effectを検証する"
// @end-test-value
/** メニュー表示後の最新タイトルを選択時に読み、全文を一度だけコピーすることを確認する。 */
test("Session Monitorは選択時の更新済みタイトル全文を一度だけコピーする", async () => {
  const harness = createMenuHarness();
  let title = "Before Rename";
  const reads: string[] = [];
  const copied: string[] = [];
  let closeCalls = 0;
  const service = new SessionMonitorContextMenuService({
    /** 対象のウィンドウが閉じていても保存済みタイトルをコピーできる状況を作る。 */
    isSessionWindowOpen: () => false,
    /** タイトルのコピー時に閉じる処理が呼ばれていないかを計数する。 */
    requestCloseSessionWindow: async () => {
      closeCalls += 1;
      return true;
    },
    /** 参照した識別子を保存した上で、選択時の最新タイトルを返す。 */
    readSessionTitle: async (sessionId) => {
      reads.push(sessionId);
      return title;
    },
    /** クリップボードへ渡ったタイトル全文を記録する。 */
    writeText: (value) => {
      copied.push(value);
    },
    buildMenu: harness.buildMenu,
  });
  const result = service.showContextMenu({} as BrowserWindow, {
    kind: "agent",
    sessionId: "title-target",
    point: { x: 12, y: 34 },
  });
  assert.deepEqual(reads, []);
  title = `更新済みタイトル ${"省略されても全文をコピー / ".repeat(30)}末尾`;
  const copyItem = harness
    .getTemplate()
    .find((item) => item.label === "Copy Session Title");
  assert.ok(copyItem);
  invokeMenuItem(copyItem);
  harness.getPopupOptions()?.callback?.();
  invokeMenuItem(copyItem);
  assert.deepEqual(await result, { status: "copied" });
  assert.deepEqual(reads, ["title-target"]);
  assert.deepEqual(copied, [title]);
  assert.equal(closeCalls, 0);
});

// @test-value v2
// kind = "contract"
// claim = "タイトルの取得不能・対象消失・clipboard書込失敗はcopiedではなくタイトルコピーの失敗になる"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#home-window" }
// fault = "取得失敗時にIDや空文字を代用してclipboardを上書きする、または失敗をcopiedとして返す"
// observable = "menu resultとclipboard writerへ渡された値"
// observation_boundary = "public-boundary"
// scope = "Session Monitor title copy failure"
// lifecycle = "permanent"
// @end-test-value
/** タイトルが存在しない場合、保存先の読み取りエラー、クリップボードの書き込みエラーを成功にしない。 */
test("Session Monitorはタイトル取得とコピーの失敗を成功扱いしない", async () => {
  for (const failure of ["missing", "read", "write"] as const) {
    const harness = createMenuHarness();
    const written: string[] = [];
    const service = new SessionMonitorContextMenuService({
      /** タイトルコピーの失敗がウィンドウの閉鎖状態に依存しないようにする。 */
      isSessionWindowOpen: () => true,
      /** タイトルコピー中にウィンドウを閉じようとした場合は失敗させる。 */
      requestCloseSessionWindow: async () => {
        throw new Error("Copy must not close");
      },
      /** タイトルが取得できない場合と保存ストレージが失敗する場合を切り替える。 */
      readSessionTitle: async () => {
        if (failure === "read") throw new Error("storage unavailable");
        return failure === "missing" ? null : "Current Title";
      },
      /** 書き込もうとしたタイトルを捕捉してからクリップボードの失敗を発生させる。 */
      writeText: (value) => {
        written.push(value);
        throw new Error("clipboard unavailable");
      },
      buildMenu: harness.buildMenu,
    });
    const result = service.showContextMenu({} as BrowserWindow, {
      kind: "agent",
      sessionId: "failed-title",
      point: { x: 0, y: 0 },
    });
    invokeMenuItem(
      harness
        .getTemplate()
        .find((item) => item.label === "Copy Session Title")!,
    );
    assert.deepEqual(await result, {
      status: "failed",
      message: "Session title could not be copied.",
    });
    assert.deepEqual(written, failure === "write" ? ["Current Title"] : []);
  }
});

/** 外からの破棄と通常の閉鎖を区別できる Auxiliary ウィンドウの代替を作る。 */
function createAuxWindowStub() {
  let destroyed = false;
  const closedListeners: Array<() => void> = [];
  return {
    /** テスト中は開発用 URL を実際に読み込まない。 */
    async loadURL() {},
    /** テスト中は配布用の画面ファイルを読み込まない。 */
    async loadFile() {},
    /** ウィンドウの閉鎖・破棄に応じた状態を返す。 */
    isDestroyed: () => destroyed,
    /** 常に最小化していないウィンドウとして動作させる。 */
    isMinimized: () => false,
    /** 最小化からの復帰に伴うウィンドウ操作を発生させない。 */
    restore() {},
    /** ネイティブウィンドウのフォーカス移動を行わない。 */
    focus() {},
    /** 検証中に実ウィンドウを表示しない。 */
    show() {},
    /** 生存中のウィンドウを破棄済みへ遷移させ、閉鎖時のリスナーを起動する。 */
    close() {
      if (destroyed) {
        return;
      }
      destroyed = true;
      for (const listener of closedListeners) {
        listener();
      }
    },
    /** 常に手前に表示する設定を実際の画面には反映しない。 */
    setAlwaysOnTop() {},
    /** この代替では一回限りのネイティブ通知を扱わない。 */
    once() {},
    /** 閉鎖通知をテストから起動できるようにリスナーを保持する。 */
    on(event: "closed", listener: () => void) {
      if (event === "closed") {
        closedListeners.push(listener);
      }
    },
    /** サービスを経由せずウィンドウだけが破棄された状態を作る。 */
    destroyExternally() {
      destroyed = true;
    },
  };
}
