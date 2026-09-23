import assert from "node:assert/strict";
import test from "node:test";

import type { MenuItemConstructorOptions } from "electron";

import { SessionFilePreviewImageCopyService } from "../../src-electron/files/session-file-preview-image-copy-service.js";

function createHarness() {
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
    buildMenu(nextTemplate) {
      template = nextTemplate;
      return createMenu() as never;
    },
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
