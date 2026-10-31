import assert from "node:assert/strict";
import test from "node:test";

import type { MenuItemConstructorOptions } from "electron";

import { SessionFilePreviewImageCopyService, type SessionFilePreviewImageCopyServiceDeps } from "../../src-electron/files/session-file-preview-image-copy-service.js";

function createHarness(overrides: Partial<SessionFilePreviewImageCopyServiceDeps> = {}) {
  let template: MenuItemConstructorOptions[] = [];
  let popupOptions: {
    callback?: () => void;
    x?: number;
    y?: number;
    window?: unknown;
  } | undefined;
  const createMenu = () => ({
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
    inspectImage: async () => ({ kind: "image", absoluteFilePath: "C:\\images\\resolved.png" }),
    writeText: () => assert.fail("Path copy must be configured by the test"),
    buildMenu(nextTemplate) {
      template = nextTemplate;
      return createMenu() as never;
    },
    ...overrides,
  });
  return {
    service,
    getTemplate: () => template,
    getPopupOptions: () => popupOptions,
  };
}

test("画像copyは指定座標を同じwebContentsへ渡し、破棄済みtargetでは副作用を起こさない", () => {
  const { service } = createHarness();
  const copiedPoints: Array<[number, number]> = [];
  const activeTarget = {
    isDestroyed: () => false,
    copyImageAt: (x: number, y: number) => copiedPoints.push([x, y]),
  };

  assert.deepEqual(service.copyImage(activeTarget as never, { x: 12, y: 34 }), { status: "copied" });
  assert.deepEqual(copiedPoints, [[12, 34]]);
  assert.deepEqual(service.copyImage({
    isDestroyed: () => true,
    copyImageAt: () => assert.fail("destroyed target must not be copied"),
  } as never, { x: 1, y: 2 }), {
    status: "failed",
    message: "Image could not be copied.",
  });
  assert.deepEqual(service.copyImage({
    isDestroyed: () => false,
    copyImageAt: () => {
      throw new Error("copy failed");
    },
  } as never, { x: 5, y: 6 }), {
    status: "failed",
    message: "Image could not be copied.",
  });
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
test("画像menuは元sourceを再解決してpathを一度copyし、選択中のdismissでは結果を捨てない", async () => {
  const request = { sessionId: "session-1", target: "../images/sample.png", baseResource: {
    sessionId: "session-1", absolutePath: "C:\\docs\\message.md",
  } };
  const inspected: unknown[] = [];
  const copiedPaths: string[] = [];
  let finishInspection!: () => void;
  let senderChecks = 0;
  const harness = createHarness({
    inspectImage: async (input) => {
      inspected.push(input);
      await new Promise<void>((resolve) => { finishInspection = resolve; });
      return { kind: "image", absoluteFilePath: "C:\\images\\sample.png" };
    },
    writeText: (target) => { copiedPaths.push(target); },
  });
  const result = harness.service.showContextMenu({} as never, {
    isDestroyed: () => false,
    copyImageAt: () => assert.fail("Copy Path must not copy a bitmap"),
  } as never, { x: 7, y: 9 }, { request, assertSender: async () => { senderChecks += 1; } });
  assert.deepEqual(harness.getTemplate().map((item) => item.label), ["Copy Image", "Copy Path"]);
  assert.deepEqual(inspected, []);
  assert.deepEqual(copiedPaths, []);
  harness.getTemplate()[1].click?.({} as never, {} as never, {} as never);
  harness.getPopupOptions()?.callback?.();
  await Promise.resolve();
  assert.deepEqual(inspected, [request]);
  assert.deepEqual(copiedPaths, []);
  harness.getTemplate()[1].click?.({} as never, {} as never, {} as never);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(senderChecks, 1, "selection in progress must not start a second path copy");
  assert.deepEqual(inspected, [request]);
  finishInspection();
  assert.deepEqual(await result, { status: "copied-path" });
  assert.equal(senderChecks, 2);
  assert.deepEqual(copiedPaths, ["C:\\images\\sample.png"]);
  harness.getTemplate()[1].click?.({} as never, {} as never, {} as never);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(senderChecks, 2, "settled selection must not start a second path copy");
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
test("画像path copyは取消と無効なtarget・senderでclipboardを変更しない", async () => {
  for (const failure of ["dismiss", "missing", "kind", "control", "sender", "destroyed"] as const) {
    let inspected = false;
    let writes = 0;
    const harness = createHarness({
      inspectImage: async () => {
        inspected = true;
        if (failure === "missing") throw new Error("file removed");
        return { kind: failure === "kind" ? "binary" : "image",
          absoluteFilePath: failure === "control" ? "C:\\images\\bad\n.png" : "C:\\images\\sample.png" };
      },
      writeText: () => { writes += 1; },
    });
    const result = harness.service.showContextMenu({} as never, {
      isDestroyed: () => failure === "destroyed" && inspected,
      copyImageAt: () => assert.fail("Path copy must not copy a bitmap"),
    } as never, { x: 1, y: 2 }, {
      request: { sessionId: "session-1", target: "sample.png" },
      assertSender: async () => { if (failure === "sender" && inspected) throw new Error("owner changed"); },
    });
    if (failure === "dismiss") harness.getPopupOptions()?.callback?.();
    harness.getTemplate()[1].click?.({} as never, {} as never, {} as never);
    assert.deepEqual(await result, failure === "dismiss" ? { status: "dismissed" }
      : { status: "failed", message: "Image path could not be copied." });
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
test("画像context menuは選択時だけcopyし、dismissを成功扱いしない", async () => {
  const first = createHarness();
  const copiedPoints: Array<[number, number]> = [];
  const target = {
    isDestroyed: () => false,
    copyImageAt: (x: number, y: number) => copiedPoints.push([x, y]),
  };
  const copyResultPromise = first.service.showContextMenu({} as never, target as never, { x: 7, y: 9 });
  assert.equal(first.getTemplate()[0]?.label, "Copy Image");
  assert.deepEqual(
    { x: first.getPopupOptions()?.x, y: first.getPopupOptions()?.y },
    { x: 7, y: 9 },
  );
  first.getTemplate()[0]?.click?.({} as never, {} as never, {} as never);
  assert.deepEqual(await copyResultPromise, { status: "copied" });
  assert.deepEqual(copiedPoints, [[7, 9]]);

  const second = createHarness();
  const dismissResultPromise = second.service.showContextMenu({} as never, target as never, { x: 3, y: 4 });
  second.getPopupOptions()?.callback?.();
  assert.deepEqual(await dismissResultPromise, { status: "dismissed" });
  assert.deepEqual(copiedPoints, [[7, 9]]);
});
