import assert from "node:assert/strict";
import test from "node:test";

import type { MenuItemConstructorOptions } from "electron";

import {
  SessionFilePreviewImageCopyService,
  type SessionFilePreviewImageCopyServiceDeps,
} from "../../src-electron/files/session-file-preview-image-copy-service.js";

/** Electronのメニューやクリップボードを開かず、構築された項目・表示引数・差し替えた依存先を観測する。 */
function createHarness(
  overrides: Partial<SessionFilePreviewImageCopyServiceDeps> = {},
) {
  let template: MenuItemConstructorOptions[] = [];
  let popupOptions:
    | {
        callback?: () => void;
        x?: number;
        y?: number;
        window?: unknown;
      }
    | undefined;
  /** ポップアップ呼び出しを記録するだけのメニューを作る。 */
  const createMenu = () => ({
    /** 実表示の代わりに座標・対象Window・終了コールバックを保持する。 */
    popup(options: {
      callback?: () => void;
      x?: number;
      y?: number;
      window?: unknown;
    }) {
      popupOptions = options as never;
    },
  });
  const service = new SessionFilePreviewImageCopyService({
    /** 画像の調査を個別指定しないケースでは固定の解決済みパスを返す。 */
    inspectImage: async () => ({
      kind: "image",
      absoluteFilePath: "C:\\images\\resolved.png",
    }),
    /** パス書き込みを明示していないテストでクリップボード処理に進んだら失敗させる。 */
    writeText: () => assert.fail("Path copy must be configured by the test"),
    /** サービスが構築した項目を保持し、テストがメニュー選択を発火できるようにする。 */
    buildMenu(nextTemplate) {
      template = nextTemplate;
      return createMenu() as never;
    },
    ...overrides,
  });
  return {
    service,
    /** 最後に構築されたメニュー項目を選択やラベルの照合に使う。 */
    getTemplate: () => template,
    /** 最後の表示引数から座標とdismissコールバックを取り出せるようにする。 */
    getPopupOptions: () => popupOptions,
  };
}

/** 生きた同じwebContentsへ指定座標を渡し、破棄済みまたはコピー失敗の対象は失敗として返す。 */
test("画像copyは指定座標を同じwebContentsへ渡し、破棄済みtargetでは副作用を起こさない", () => {
  const { service } = createHarness();
  const copiedPoints: Array<[number, number]> = [];
  const activeTarget = {
    /** 正常系では描画対象を利用可能なままにする。 */
    isDestroyed: () => false,
    /** 正常系の画像コピーに渡った座標を記録する。 */
    copyImageAt: (x: number, y: number) => copiedPoints.push([x, y]),
  };

  assert.deepEqual(service.copyImage(activeTarget as never, { x: 12, y: 34 }), {
    status: "copied",
  });
  assert.deepEqual(copiedPoints, [[12, 34]]);
  assert.deepEqual(
    service.copyImage(
      {
        /** 使用できないwebContentsとして扱うため、最初から破棄済みにする。 */
        isDestroyed: () => true,
        /** 破棄済みでも描画コピーに進む回帰があれば失敗させる。 */
        copyImageAt: () => assert.fail("destroyed target must not be copied"),
      } as never,
      { x: 1, y: 2 },
    ),
    {
      status: "failed",
      message: "Image could not be copied.",
    },
  );
  assert.deepEqual(
    service.copyImage(
      {
        /** 破棄判定ではなく描画コピー自体の失敗を通るよう対象を生存させる。 */
        isDestroyed: () => false,
        /** webContents側の画像コピー例外を模擬する。 */
        copyImageAt: () => {
          throw new Error("copy failed");
        },
      } as never,
      { x: 5, y: 6 },
    ),
    {
      status: "failed",
      message: "Image could not be copied.",
    },
  );
});

// @test-value v2
// kind = "contract"
// claim = "画像menuのCopy Pathは選択後に元resourceを再解決しsenderを前後確認してcanonical pathだけを一度copyする"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md: Image Handling" }
// fault = "表示用blobや未解決相対pathをcopyする、解決前にclipboardを変更する、またはnative dismiss callbackで選択中の結果を捨てる"
// observable = "menu項目、inspect入力、sender確認回数、clipboard文字列、返却status"
// observation_boundary = "public-boundary"
// scope = "画像native menuからMainのpath clipboard境界"
// lifecycle = "permanent"
// distinction = "画像座標copy testはpath解決と非同期menu選択を通らず、IPC認可testは実際のclipboard入力を観測しない"
// @end-test-value
/** パスの選択後に元の要求を再解決し、送信元を前後で確認して正規パスを1回だけ書き込む。 */
test("画像menuは元sourceを再解決してpathを一度copyし、選択中のdismissでは結果を捨てない", async () => {
  const request = {
    sessionId: "session-1",
    target: "../images/sample.png",
    baseResource: {
      sessionId: "session-1",
      absolutePath: "C:\\docs\\message.md",
    },
  };
  const inspected: unknown[] = [];
  const copiedPaths: string[] = [];
  let finishInspection!: () => void;
  let senderChecks = 0;
  const harness = createHarness({
    /** 元リソース付きの調査要求を記録し、メニューが閉じる時点と調査完了を分離する。 */
    inspectImage: async (input) => {
      inspected.push(input);
      await new Promise<void>((resolve) => {
        finishInspection = resolve;
      });
      return { kind: "image", absoluteFilePath: "C:\\images\\sample.png" };
    },
    /** クリップボードへ渡されるパスを実際の書き込みなしに捕捉する。 */
    writeText: (target) => {
      copiedPaths.push(target);
    },
  });
  const result = harness.service.showContextMenu(
    {} as never,
    {
      /** 調査が終わるまで送信元の描画対象が生存するケースを作る。 */
      isDestroyed: () => false,
      /** パス選択を画像ビットマップのコピーと取り違えたら失敗させる。 */
      copyImageAt: () => assert.fail("Copy Path must not copy a bitmap"),
    } as never,
    { x: 7, y: 9 },
    {
      request,
      /** 調査の前後で送信元が再確認されたかを数える。 */
      assertSender: async () => {
        senderChecks += 1;
      },
    },
  );
  assert.deepEqual(
    harness.getTemplate().map((item) => item.label),
    ["Copy Image", "Copy Path"],
  );
  assert.deepEqual(inspected, []);
  assert.deepEqual(copiedPaths, []);
  harness.getTemplate()[1].click?.({} as never, {} as never, {} as never);
  harness.getPopupOptions()?.callback?.();
  await Promise.resolve();
  assert.deepEqual(inspected, [request]);
  assert.deepEqual(copiedPaths, []);
  harness.getTemplate()[1].click?.({} as never, {} as never, {} as never);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    senderChecks,
    1,
    "selection in progress must not start a second path copy",
  );
  assert.deepEqual(inspected, [request]);
  finishInspection();
  assert.deepEqual(await result, { status: "copied-path" });
  assert.equal(senderChecks, 2);
  assert.deepEqual(copiedPaths, ["C:\\images\\sample.png"]);
  harness.getTemplate()[1].click?.({} as never, {} as never, {} as never);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    senderChecks,
    2,
    "settled selection must not start a second path copy",
  );
  assert.deepEqual(inspected, [request]);
  assert.deepEqual(copiedPaths, ["C:\\images\\sample.png"]);
});

// @test-value v2
// kind = "security"
// claim = "画像path copyは取消・認可失効・対象消失・非画像・制御文字・破棄済みwindowでclipboardを変更せず失敗またはdismissを返す"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md: Image Handling" }
// fault = "取消後も選択を実行するか、解決後のsender失効や不正な画像pathを無視してclipboardへ書く"
// observable = "返却statusとclipboard書込件数"
// observation_boundary = "public-boundary"
// scope = "画像path copyの失敗と取消の副作用境界"
// lifecycle = "permanent"
// risk_tags = ["authorization", "privacy"]
// distinction = "正常系menu testや型検査では解決中の失効と実行時に変化するfile種別・window寿命を確認できない"
// @end-test-value
/** 取消・解決失敗・非画像・不正パス・送信元の失効では、dismissまたは失敗を返しパスを書き込まない。 */
test("画像path copyは取消と無効なtarget・senderでclipboardを変更しない", async () => {
  for (const failure of [
    "dismiss",
    "missing",
    "kind",
    "control",
    "sender",
    "destroyed",
  ] as const) {
    let inspected = false;
    let writes = 0;
    const harness = createHarness({
      /** ケースに応じて画像消失、非画像、または制御文字を含むパスを再現する。 */
      inspectImage: async () => {
        inspected = true;
        if (failure === "missing") throw new Error("file removed");
        return {
          kind: failure === "kind" ? "binary" : "image",
          absoluteFilePath:
            failure === "control"
              ? "C:\\images\\bad\n.png"
              : "C:\\images\\sample.png",
        };
      },
      /** 無効なケースでパスの書き込みまで進んだ回数を計測する。 */
      writeText: () => {
        writes += 1;
      },
    });
    const result = harness.service.showContextMenu(
      {} as never,
      {
        /** 調査で画像を解決した後にWindowが破棄されるケースを再現する。 */
        isDestroyed: () => failure === "destroyed" && inspected,
        /** パス取得の失敗をビットマップへのフォールバックで隠させない。 */
        copyImageAt: () => assert.fail("Path copy must not copy a bitmap"),
      } as never,
      { x: 1, y: 2 },
      {
        request: { sessionId: "session-1", target: "sample.png" },
        /** 調査前には通過し、調査後にだけ所有者の変更を通知する。 */
        assertSender: async () => {
          if (failure === "sender" && inspected)
            throw new Error("owner changed");
        },
      },
    );
    if (failure === "dismiss") harness.getPopupOptions()?.callback?.();
    harness.getTemplate()[1].click?.({} as never, {} as never, {} as never);
    assert.deepEqual(
      await result,
      failure === "dismiss"
        ? { status: "dismissed" }
        : { status: "failed", message: "Image path could not be copied." },
    );
    assert.equal(writes, 0, failure);
  }
});

// @test-value v2
// kind = "contract"
// claim = "画像context menuは選択時だけ同じtargetへcopyし、dismissでは成功扱いしない"
// oracle = { type = "contract", ref = "src-electron/files/session-file-preview-image-copy-service.ts#SessionFilePreviewImageCopyService" }
// fault = "menu表示時にcopyする、dismiss後もcopyする、または選択結果をcopied以外へ誤変換する"
// observable = "menu label、popup coordinates、copy result status、copy coordinates"
// observation_boundary = "public-boundary"
// scope = "Session file preview image context menu"
// lifecycle = "permanent"
// impact = "ユーザーの選択前またはdismiss後に画像がclipboardへ書き込まれる"
// distinction = "menu表示・選択・dismissの順序を分けてclipboard副作用と結果を確認する"
// @end-test-value
/** Copy Imageを選択した場合だけ表示座標でコピーし、メニューを閉じただけなら追加コピーも成功通知も行わない。 */
test("画像context menuは選択時だけcopyし、dismissを成功扱いしない", async () => {
  const first = createHarness();
  const copiedPoints: Array<[number, number]> = [];
  const target = {
    /** 実Windowではなく、メニュー選択まで生存する描画先を使う。 */
    isDestroyed: () => false,
    /** 各選択後に画像コピーが何回どの座標で行われたかを比較できるようにする。 */
    copyImageAt: (x: number, y: number) => copiedPoints.push([x, y]),
  };
  const copyResultPromise = first.service.showContextMenu(
    {} as never,
    target as never,
    { x: 7, y: 9 },
  );
  assert.equal(first.getTemplate()[0]?.label, "Copy Image");
  assert.deepEqual(
    { x: first.getPopupOptions()?.x, y: first.getPopupOptions()?.y },
    { x: 7, y: 9 },
  );
  first.getTemplate()[0]?.click?.({} as never, {} as never, {} as never);
  assert.deepEqual(await copyResultPromise, { status: "copied" });
  assert.deepEqual(copiedPoints, [[7, 9]]);

  const second = createHarness();
  const dismissResultPromise = second.service.showContextMenu(
    {} as never,
    target as never,
    { x: 3, y: 4 },
  );
  second.getPopupOptions()?.callback?.();
  assert.deepEqual(await dismissResultPromise, { status: "dismissed" });
  assert.deepEqual(copiedPoints, [[7, 9]]);
});
