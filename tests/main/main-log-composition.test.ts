import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { registerHooks } from "node:module";
import test from "node:test";

import type { BrowserWindow } from "electron";

// @test-value v2
// kind = "contract"
// claim = "各Windowの主要lifecycle・renderer異常イベントは数値windowIdで相関でき、payload本文やraw errorは含まれない"
// oracle = { type = "contract", ref = "docs/design/app-log-base.md#log-format" }
// fault = "WindowイベントがwindowIdを欠落または別WindowのIDで記録する、あるいは診断用にURLやraw error本文を記録する"
// observable = "2つのWindowから実callbackで生成した7種のlog recordにあるwindowIdとserialized record"
// observation_boundary = "component-behavior"
// scope = "main-window-log-correlation"
// lifecycle = "permanent"
// impact = "複数Window稼働中にcrash/freeze/load異常の発生Windowを特定でき、診断ログに不要なユーザー由来情報を含めない"
// distinction = "型検査ではoptionalなwindowIdの欠落も実event callbackのWindow間混同も検出できず、既存testにMainLogCompositionのevent出力を確認するものがない"
// @end-test-value
test("MainLogComposition は7種のWindow eventを数値windowIdで相関し、payloadを記録しない", async () => {
  Object.assign(globalThis, {
    __withmateElectronMock: {
      app: {},
      BrowserWindow: class BrowserWindow {},
      crashReporter: {},
    },
  });
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "electron")
        return { url: "withmate:test-electron", shortCircuit: true };
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (url === "withmate:test-electron")
        return {
          format: "module",
          shortCircuit: true,
          source:
            "const electron = globalThis.__withmateElectronMock;\n" +
            "export const app = electron.app;\n" +
            "export const BrowserWindow = electron.BrowserWindow;\n" +
            "export const crashReporter = electron.crashReporter;\n",
        };
      return nextLoad(url, context);
    },
  });

  const { MainLogComposition } = await import(
    "../../src-electron/app/main-log-composition.js"
  );
  const logs: Array<Record<string, unknown>> = [];
  const sourceWindowIds: number[] = [];
  let sourceWindowId = 0;
  const composition = new MainLogComposition(
    (entry) => { logs.push(entry); sourceWindowIds.push(sourceWindowId); },
    (error) => ({ name: "Error", message: String(error) }),
  );
  const windows = [12, 34].map((id) => {
    sourceWindowId = id;
    const window = Object.assign(new EventEmitter(), {
      id,
      title: `private-window-title-${id}`,
      isDestroyed: () => false,
      webContents: new EventEmitter(),
    });
    composition.attachWindowLogHandlers(window as unknown as BrowserWindow);
    return window;
  });

  for (const window of windows) {
    sourceWindowId = window.id;
    window.emit("closed");
    window.webContents.emit("render-process-gone", {}, {
      reason: "crashed",
      exitCode: 1,
    });
    window.webContents.emit("unresponsive");
    window.webContents.emit("responsive");
    window.webContents.emit(
      "did-fail-load",
      {},
      -105,
      `raw-error-body-secret-${window.id}`,
      `https://private.invalid/${window.id}`,
      true,
    );
    window.webContents.emit(
      "did-start-navigation",
      {},
      `https://private.invalid/navigation/${window.id}`,
      false,
      true,
    );
  }

  const expectedKinds = [
    "app.window.created",
    "app.window.closed",
    "renderer.process-gone",
    "webcontents.unresponsive",
    "webcontents.responsive",
    "renderer.did-fail-load",
    "renderer.navigation-started",
  ];
  for (const kind of expectedKinds) {
    const entries = logs.filter((entry) => entry.kind === kind);
    assert.deepEqual(
      new Set(entries.map((entry) => entry.windowId)),
      new Set([12, 34]),
      `${kind} should be attributable to both Window instances`,
    );
    assert.ok(entries.every((entry) => typeof entry.windowId === "number"));
  }
  logs.forEach((entry, index) => {
    assert.equal(entry.windowId, sourceWindowIds[index], `${String(entry.kind)} must identify its source Window`);
  });

  const serializedLogs = JSON.stringify(logs);
  assert.doesNotMatch(serializedLogs, /private-window-title|private\.invalid/);
  assert.doesNotMatch(serializedLogs, /raw-error-body-secret/);
});
