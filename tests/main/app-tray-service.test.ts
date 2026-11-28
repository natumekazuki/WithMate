import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AppTrayService,
  type AppTrayLike,
  type AppTrayMenuItem,
  type AppTrayWindowLike,
} from "../../src-electron/app/app-tray-service.js";

/** OSのTrayを作らず、サービスが登録した表示内容・イベント・破棄を観測する。 */
class FakeTray implements AppTrayLike {
  readonly listeners = new Map<string, () => void>();
  contextMenu: unknown = null;
  destroyed = false;
  toolTip = "";

  /** 初期化時に指定されたツールチップを検証用に保存する。 */
  setToolTip(toolTip: string): void {
    this.toolTip = toolTip;
  }

  /** Electronのメニューへ変換する前の項目を、テストから読み取れるように保持する。 */
  setContextMenu(menu: unknown): void {
    this.contextMenu = menu;
  }

  /** クリック種別ごとに、サービスが接続したリスナーを保存する。 */
  on(event: "click" | "double-click", listener: () => void): void {
    this.listeners.set(event, listener);
  }

  /** 破棄を記録して、終了時のリソース解放を観測可能にする。 */
  destroy(): void {
    this.destroyed = true;
  }

  /** 破棄後にサービスが参照する状態を返す。 */
  isDestroyed(): boolean {
    return this.destroyed;
  }
}

/** 実ウィンドウを開かず、Homeの復元・表示・フォーカスを区別して記録する。 */
class FakeWindow implements AppTrayWindowLike {
  destroyed = false;
  minimized = false;
  restored = false;
  shown = false;
  focused = false;

  /** 閉じたHomeかどうかを模擬する。 */
  isDestroyed(): boolean {
    return this.destroyed;
  }

  /** 復元が必要な現在状態をサービスへ伝える。 */
  isMinimized(): boolean {
    return this.minimized;
  }

  /** 復元の呼び出しを記録し、最小化状態を解除する。 */
  restore(): void {
    this.restored = true;
    this.minimized = false;
  }

  /** ウィンドウが表示されたことを記録する。 */
  show(): void {
    this.shown = true;
  }

  /** 前面化のためのフォーカス呼び出しを記録する。 */
  focus(): void {
    this.focused = true;
  }
}

/** Windowsに限定したTrayの初期化、Home再表示、終了時の解放を検証する。 */
describe("AppTrayService", () => {
  /** macOSでは初期化しても、Trayを生成する依存を呼ばないことを確認する。 */
  it("does not create a tray outside Windows", () => {
    let createTrayCalled = false;
    const service = new AppTrayService({
      platform: "darwin",
      iconPath: "build/icon.ico",
      /** Windows以外で誤って生成された場合に呼び出しを記録する。 */
      createTray: () => {
        createTrayCalled = true;
        return new FakeTray();
      },
      /** プラットフォーム検査とは無関係なメニュー構築を恒等変換にする。 */
      buildMenu: (items) => items,
      /** 生成抑止の検証には開くべきHomeを用意しない。 */
      openHomeWindow: async () => null,
      /** Tray生成の検証からプロセス終了の副作用を除く。 */
      quitApp: () => {},
    });

    service.initialize();

    assert.equal(createTrayCalled, false);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "Windows trayはWithMate表示とQuit操作を提供し、表示操作は既存Home Windowを復元して前面化する"
  // oracle = { type = "contract", ref = "src-electron/app/app-tray-service.ts#AppTrayService" }
  // fault = "tray menuの表示・終了labelまたはclick処理が欠落し、Homeを復元できないかQuitを呼び出さない"
  // observable = "tray menu labels、window restore/show/focus state、quit callback"
  // observation_boundary = "public-boundary"
  // scope = "Windows tray menu actions"
  // lifecycle = "permanent"
  // impact = "trayからHomeを再表示またはアプリを終了できない"
  // distinction = "menu構成と各action後の外部callback結果を同じWindows harnessで確認する"
  // @end-test-value
  /** Windowsのメニュー構成と、表示から復元・前面化へ、終了からquitへ伝わる操作を確認する。 */
  it("creates a Windows tray with show and quit actions", async () => {
    const tray = new FakeTray();
    const window = new FakeWindow();
    window.minimized = true;
    let quitCalled = false;
    const service = new AppTrayService({
      platform: "win32",
      iconPath: "build/icon.ico",
      /** 後でメニューを読めるよう、準備済みのTrayを返す。 */
      createTray: () => tray,
      /** ラベルとアクションをそのままTrayへ渡し、クリックの検証に利用する。 */
      buildMenu: (items) => items,
      /** 表示アクションで、最小化中に設定したHomeを返す。 */
      openHomeWindow: async () => window,
      /** プロセスを終了せず、Quit項目の伝達だけを記録する。 */
      quitApp: () => {
        quitCalled = true;
      },
    });

    service.initialize();

    assert.equal(tray.toolTip, "WithMate");
    const menu = tray.contextMenu as AppTrayMenuItem[];
    assert.deepEqual(
      menu.map((item) => ("label" in item ? item.label : item.type)),
      ["Show WithMate", "separator", "Quit"],
    );

    const showItem = menu.find(
      (item): item is Extract<AppTrayMenuItem, { label: string }> =>
        "label" in item && item.label === "Show WithMate",
    );
    assert.ok(showItem);
    showItem.click();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(window.restored, true);
    assert.equal(window.shown, true);
    assert.equal(window.focused, true);

    const quitItem = menu.find(
      (item): item is Extract<AppTrayMenuItem, { label: string }> =>
        "label" in item && item.label === "Quit",
    );
    quitItem?.click();

    assert.equal(quitCalled, true);
  });

  /** サービスの破棄が、初期化時に作ったTrayの破棄に伝わることを確認する。 */
  it("destroys the tray on dispose", () => {
    const tray = new FakeTray();
    const service = new AppTrayService({
      platform: "win32",
      iconPath: "build/icon.ico",
      /** 破棄を観測する一つのTrayを、初期化時に返す。 */
      createTray: () => tray,
      /** ネイティブメニューに依存せず初期化できるよう項目を返す。 */
      buildMenu: (items) => items,
      /** Trayの寿命だけを検証するため、Homeは用意しない。 */
      openHomeWindow: async () => null,
      /** リソース解放からアプリ自体の終了を切り離す。 */
      quitApp: () => {},
    });

    service.initialize();
    service.dispose();

    assert.equal(tray.destroyed, true);
  });
});
