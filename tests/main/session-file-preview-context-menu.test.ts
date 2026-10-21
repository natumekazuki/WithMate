import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserWindow, MenuItemConstructorOptions, PopupOptions } from "electron";
import { SessionFilePreviewContextMenuService } from "../../src-electron/files/session-file-preview-context-menu-service.js";
import { registerWindowHandlers } from "../../src-electron/ipc/window.js";
import type { MainIpcWindowDeps } from "../../src-electron/ipc/contracts.js";
import { WITHMATE_SHOW_SESSION_FILE_PREVIEW_CONTEXT_MENU_CHANNEL } from "../../src-shared/ipc/withmate-ipc-channels.js";

// @test-value v2
// kind = "contract"
// claim = "Preview native menuはscopeに合うClose/Close Allの選択だけを返し、取消・表示失敗を区別する"
// oracle = { type = "contract", ref = "src-shared/file-explorer/file-explorer-contract.ts SessionFilePreviewContextMenuRequest/Result" }
// fault = "scopeとlabelを取り違える、未選択をcloseとして返す、選択後のpopup callbackでdismissedへ上書きする、表示失敗を取消に偽装する"
// observable = "native menu項目・popup座標とWindow・選択結果・取消結果・表示失敗reject"
// observation_boundary = "public-boundary"
// scope = "Preview native menu selection boundary"
// lifecycle = "permanent"
// impact = "menu選択を実close成功と混同せずrendererが捕捉対象へ既存close APIを適用できる"
// distinction = "renderer fixtureや型検査はnative popup callbackと項目clickの結果接続を保証しない"
// @end-test-value
test("Preview native menuは選択と取消を返し表示失敗をrejectする", async () => {
  const window = {} as BrowserWindow;
  for (const scope of ["preview", "session"] as const) {
    let template: MenuItemConstructorOptions[] = [];
    let popup: PopupOptions | undefined;
    const service = new SessionFilePreviewContextMenuService({
      buildMenu(items) { template = items; return { popup(options) { popup = options; } }; },
    });
    const selection = service.showContextMenu(window, { scope, point: { x: 12, y: 34 } });
    assert.deepEqual(template.map((item) => item.label), [scope === "preview" ? "Close" : "Close All"]);
    assert.equal(popup?.window, window);
    assert.deepEqual([popup?.x, popup?.y], [12, 34]);
    template[0]!.click?.({} as never, window, {} as never);
    popup?.callback?.();
    assert.equal(await selection, "close");
    const cancellation = service.showContextMenu(window, { scope, point: { x: 0, y: 0 } });
    popup?.callback?.();
    template[0]!.click?.({} as never, window, {} as never);
    assert.equal(await cancellation, "dismissed");
  }
  const failed = new SessionFilePreviewContextMenuService({ buildMenu() { throw new Error("native failed"); } });
  await assert.rejects(failed.showContextMenu(window, { scope: "preview", point: { x: 0, y: 0 } }), /native failed/);
  await assert.rejects(failed.showContextMenu(null, { scope: "preview", point: { x: 0, y: 0 } }), /unavailable/);
});

// @test-value v2
// kind = "contract"
// claim = "Preview menu IPCはHome実Windowだけを認可しscopeと非負整数座標のstrict requestのみdelegateへ渡す"
// oracle = { type = "contract", ref = "src-electron/ipc/window.ts Home-only Preview management IPC" }
// fault = "Monitor等のWindowにもmenuを許可する、不正scope/座標/余分fieldがnative menuへ届く、選択返却を変更する"
// observable = "登録handlerの返却値とdelegate引数、許可外senderと不正requestの例外、delegate呼出し数"
// observation_boundary = "public-boundary"
// scope = "Preview context menu IPC authorization and validation"
// lifecycle = "permanent"
// risk_tags = ["authorization"]
// impact = "別rendererからHomeのnative menuを操作せず異常座標でnative popupを呼ばない"
// distinction = "service testやpreload型ではMainのsender identityとunknown入力境界を保証できない"
// @end-test-value
test("Preview menu IPCはHomeのみを認可しstrict requestを検証する", async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const home = {};
  const calls: unknown[] = [];
  const deps = {
    resolveEventWindow: (event: { sender: unknown }) => event.sender,
    resolveHomeWindow: () => home,
    showSessionFilePreviewContextMenu: async (event: unknown, request: unknown) => { calls.push([event, request]); return "close"; },
  } as unknown as MainIpcWindowDeps;
  registerWindowHandlers({ handle(channel, handler) { handlers.set(channel, handler as (...args: unknown[]) => unknown); } }, deps);
  const handler = handlers.get(WITHMATE_SHOW_SESSION_FILE_PREVIEW_CONTEXT_MENU_CHANNEL)!;
  const event = { sender: home };
  for (const scope of ["preview", "session"]) {
    const request = { scope, point: { x: 12, y: 34 } };
    assert.equal(await handler(event, request), "close");
    assert.deepEqual(calls.at(-1), [event, request]);
  }
  assert.throws(() => handler({ sender: {} }, { scope: "preview", point: { x: 0, y: 0 } }), /Home window/);
  const valid = { scope: "preview", point: { x: 0, y: 0 } };
  for (const invalid of [null, [], {}, { ...valid, scope: "other" }, { ...valid, extra: true },
    { ...valid, point: null }, { ...valid, point: [] }, { ...valid, point: { x: 0, y: 0, extra: true } },
    ...[-1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, "1"].flatMap((coordinate) => [
      { ...valid, point: { x: coordinate, y: 0 } }, { ...valid, point: { x: 0, y: coordinate } },
    ]),
  ]) assert.throws(() => handler(event, invalid), /context menu request is invalid/);
  assert.equal(calls.length, 2);
});
