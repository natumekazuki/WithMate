import assert from "node:assert/strict";
import test from "node:test";

import { MarkdownLinkContextMenuService } from "../../src-electron/markdown-link-context-menu-service.js";

function createHarness(writeText: (target: string) => void = () => undefined) {
  let menuTemplate: Array<{ label?: string; click?: () => void }> = [];
  let popupOptions: { callback?: () => void; x?: number; y?: number; window?: unknown } | undefined;
  const service = new MarkdownLinkContextMenuService({
    buildMenu(template) {
      menuTemplate = template as Array<{ label?: string; click?: () => void }>;
      return {
        popup(options) {
          popupOptions = options;
        },
      };
    },
    writeText,
  });
  return {
    service,
    getMenuTemplate: () => menuTemplate,
    getPopupOptions: () => popupOptions,
  };
}

test("Markdown link context menuは選択時だけtargetをそのままclipboardへ渡す", async () => {
  const copied: string[] = [];
  const harness = createHarness((target) => copied.push(target));
  const request = {
    target: "docs/candidate-source%20final.json",
    point: { x: 120, y: 240 },
  };
  const resultPromise = harness.service.showContextMenu({} as never, request);

  assert.equal(harness.getMenuTemplate()[0]?.label, "リンクをコピー");
  assert.deepEqual(harness.getPopupOptions(), {
    window: {},
    x: 120,
    y: 240,
    callback: harness.getPopupOptions()?.callback,
  });
  assert.deepEqual(copied, []);

  harness.getMenuTemplate()[0]?.click?.();
  assert.deepEqual(await resultPromise, { status: "copied" });
  assert.deepEqual(copied, [request.target]);
});

test("Markdown link context menuはdismissとcopy失敗を成功扱いしない", async () => {
  const dismissed = createHarness();
  const dismissResult = dismissed.service.showContextMenu({} as never, {
    target: "docs/review-brief.md",
    point: { x: 1, y: 2 },
  });
  dismissed.getPopupOptions()?.callback?.();
  assert.deepEqual(await dismissResult, { status: "dismissed" });

  const failed = createHarness(() => {
    throw new Error("clipboard unavailable");
  });
  const failedResult = failed.service.showContextMenu({} as never, {
    target: "docs/review-brief.md",
    point: { x: 1, y: 2 },
  });
  failed.getMenuTemplate()[0]?.click?.();
  assert.deepEqual(await failedResult, {
    status: "failed",
    message: "リンクをコピーできませんでした。",
  });
});
