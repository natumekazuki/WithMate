import assert from "node:assert/strict";
import test from "node:test";
import type {
  BrowserWindow,
  MenuItemConstructorOptions,
  PopupOptions,
} from "electron";
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
/** Scope ごとの閉じる項目と表示位置を照合し、先に発生した選択・取消が後続イベントで変わらず、表示自体の失敗は reject になることを確かめる。 */
test("Preview native menuは選択と取消を返し表示失敗をrejectする", async () => {
  const window = {} as BrowserWindow;
  for (const scope of ["preview", "session"] as const) {
    let template: MenuItemConstructorOptions[] = [];
    let popup: PopupOptions | undefined;
    const service = new SessionFilePreviewContextMenuService({
      /** 項目の生成と実際の表示を分け、テスト側で native イベントを起こせるようにする。 */
      buildMenu(items) {
        template = items;
        return {
          /** 対象 Window・座標・閉じたときのコールバックを捕捉する。 */
          popup(options) {
            popup = options;
          },
        };
      },
    });
    const selection = service.showContextMenu(window, {
      scope,
      point: { x: 12, y: 34 },
    });
    assert.deepEqual(
      template.map((item) => item.label),
      [scope === "preview" ? "Close" : "Close All"],
    );
    assert.equal(popup?.window, window);
    assert.deepEqual([popup?.x, popup?.y], [12, 34]);
    template[0]!.click?.({} as never, window, {} as never);
    popup?.callback?.();
    assert.equal(await selection, "close");
    const cancellation = service.showContextMenu(window, {
      scope,
      point: { x: 0, y: 0 },
    });
    popup?.callback?.();
    template[0]!.click?.({} as never, window, {} as never);
    assert.equal(await cancellation, "dismissed");
  }
  const failed = new SessionFilePreviewContextMenuService({
    /** メニュー生成段階の native 例外を再現する。 */
    buildMenu() {
      throw new Error("native failed");
    },
  });
  await assert.rejects(
    failed.showContextMenu(window, { scope: "preview", point: { x: 0, y: 0 } }),
    /native failed/,
  );
  await assert.rejects(
    failed.showContextMenu(null, { scope: "preview", point: { x: 0, y: 0 } }),
    /unavailable/,
  );
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
/** 実 Home と一致する送信元の健全な要求だけを delegate に渡し、他 Window と範囲外の座標や余分なキーをその前に拒否する。 */
test("Preview menu IPCはHomeのみを認可しstrict requestを検証する", async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const home = {};
  const calls: unknown[] = [];
  const deps = {
    /** 送信元のオブジェクトを、そのまま解決済み Window の代わりに使う。 */
    resolveEventWindow: (event: { sender: unknown }) => event.sender,
    /** 認可で同一性を照合する Home を返す。 */
    resolveHomeWindow: () => home,
    /** 検査を通った引数を記録し、IPC が閉じる選択をそのまま返すか確認させる。 */
    showSessionFilePreviewContextMenu: async (
      event: unknown,
      request: unknown,
    ) => {
      calls.push([event, request]);
      return "close";
    },
  } as unknown as MainIpcWindowDeps;
  registerWindowHandlers(
    {
      /** Electron の代わりに登録先を保存し、対象チャネルだけを直接呼び出せるようにする。 */
      handle(channel, handler) {
        handlers.set(channel, handler as (...args: unknown[]) => unknown);
      },
    },
    deps,
  );
  const handler = handlers.get(
    WITHMATE_SHOW_SESSION_FILE_PREVIEW_CONTEXT_MENU_CHANNEL,
  )!;
  const event = { sender: home };
  for (const scope of ["preview", "session"]) {
    const request = { scope, point: { x: 12, y: 34 } };
    assert.equal(await handler(event, request), "close");
    assert.deepEqual(calls.at(-1), [event, request]);
  }
  assert.throws(
    () => handler({ sender: {} }, { scope: "preview", point: { x: 0, y: 0 } }),
    /Home window/,
  );
  const valid = { scope: "preview", point: { x: 0, y: 0 } };
  for (const invalid of [
    null,
    [],
    {},
    { ...valid, scope: "other" },
    { ...valid, extra: true },
    { ...valid, point: null },
    { ...valid, point: [] },
    { ...valid, point: { x: 0, y: 0, extra: true } },
    ...[-1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, "1"].flatMap(
      (coordinate) => [
        { ...valid, point: { x: coordinate, y: 0 } },
        { ...valid, point: { x: 0, y: coordinate } },
      ],
    ),
  ])
    assert.throws(
      () => handler(event, invalid),
      /context menu request is invalid/,
    );
  assert.equal(calls.length, 2);
});
