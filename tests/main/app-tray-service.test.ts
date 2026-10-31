import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AppTrayService,
  type AppTrayLike,
  type AppTrayMenuItem,
  type AppTrayWindowLike,
} from "../../src-electron/app/app-tray-service.js";

class FakeTray implements AppTrayLike {
  readonly listeners = new Map<string, () => void>();
  contextMenu: unknown = null;
  destroyed = false;
  toolTip = "";

  setToolTip(toolTip: string): void {
    this.toolTip = toolTip;
  }

  setContextMenu(menu: unknown): void {
    this.contextMenu = menu;
  }

  on(event: "click" | "double-click", listener: () => void): void {
    this.listeners.set(event, listener);
  }

  destroy(): void {
    this.destroyed = true;
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }
}

class FakeWindow implements AppTrayWindowLike {
  destroyed = false;
  minimized = false;
  restored = false;
  shown = false;
  focused = false;

  isDestroyed(): boolean {
    return this.destroyed;
  }

  isMinimized(): boolean {
    return this.minimized;
  }

  restore(): void {
    this.restored = true;
    this.minimized = false;
  }

  show(): void {
    this.shown = true;
  }

  focus(): void {
    this.focused = true;
  }
}

describe("AppTrayService", () => {
  it("does not create a tray outside Windows", () => {
    let createTrayCalled = false;
    const service = new AppTrayService({
      platform: "darwin",
      iconPath: "build/icon.ico",
      createTray: () => {
        createTrayCalled = true;
        return new FakeTray();
      },
      buildMenu: (items) => items,
      openHomeWindow: async () => null,
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
  it("creates a Windows tray with show and quit actions", async () => {
    const tray = new FakeTray();
    const window = new FakeWindow();
    window.minimized = true;
    let quitCalled = false;
    const service = new AppTrayService({
      platform: "win32",
      iconPath: "build/icon.ico",
      createTray: () => tray,
      buildMenu: (items) => items,
      openHomeWindow: async () => window,
      quitApp: () => {
        quitCalled = true;
      },
    });

    service.initialize();

    assert.equal(tray.toolTip, "WithMate");
    const menu = tray.contextMenu as AppTrayMenuItem[];
    assert.deepEqual(menu.map((item) => "label" in item ? item.label : item.type), [
      "Show WithMate",
      "separator",
      "Quit",
    ]);

    const showItem = menu.find((item): item is Extract<AppTrayMenuItem, { label: string }> =>
      "label" in item && item.label === "Show WithMate",
    );
    assert.ok(showItem);
    showItem.click();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(window.restored, true);
    assert.equal(window.shown, true);
    assert.equal(window.focused, true);

    const quitItem = menu.find((item): item is Extract<AppTrayMenuItem, { label: string }> =>
      "label" in item && item.label === "Quit",
    );
    quitItem?.click();

    assert.equal(quitCalled, true);
  });

  it("destroys the tray on dispose", () => {
    const tray = new FakeTray();
    const service = new AppTrayService({
      platform: "win32",
      iconPath: "build/icon.ico",
      createTray: () => tray,
      buildMenu: (items) => items,
      openHomeWindow: async () => null,
      quitApp: () => {},
    });

    service.initialize();
    service.dispose();

    assert.equal(tray.destroyed, true);
  });
});
