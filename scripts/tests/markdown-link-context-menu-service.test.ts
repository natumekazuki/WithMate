import assert from "node:assert/strict";
import test from "node:test";

import { MarkdownLinkContextMenuService } from "../../src-electron/markdown-link-context-menu-service.js";

function createHarness(
  writeText: (target: string) => void = () => undefined,
  copyableFile: { sessionId: string; rootId: string; relativePath: string } | null = null,
) {
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
    resolveCopyableFile: async () => copyableFile,
    copyFile: async () => ({ status: "copied", message: "File copied." }),
  });
  return {
    service,
    getMenuTemplate: () => menuTemplate,
    getPopupOptions: () => popupOptions,
  };
}

test("Markdown link context menuは選択時だけ解決したtargetをclipboardへ渡す", async () => {
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
  assert.deepEqual(await resultPromise, { status: "link-copied" });
  assert.deepEqual(copied, ["docs/candidate-source final.json"]);
});

test("Markdown link context menuはpercent-encodedされたWindows pathをfilesystem pathとしてcopyする", async () => {
  const copied: string[] = [];
  const harness = createHarness((target) => copied.push(target));
  const resultPromise = harness.service.showContextMenu({} as never, {
    target: "C:%5Cworkspace%5Csession-files%5Creport%20仕様.md#intro",
    point: { x: 120, y: 240 },
  });

  harness.getMenuTemplate()[0]?.click?.();

  assert.deepEqual(await resultPromise, { status: "link-copied" });
  assert.deepEqual(copied, ["C:\\workspace\\session-files\\report 仕様.md"]);
});

test("Markdown link context menuはdecode後に制御文字を含むlocal pathをcopyしない", async () => {
  const copied: string[] = [];
  const harness = createHarness((target) => copied.push(target));
  const resultPromise = harness.service.showContextMenu({} as never, {
    target: "docs/report%0D%0Apowershell.exe",
    point: { x: 120, y: 240 },
  });

  harness.getMenuTemplate()[0]?.click?.();

  assert.deepEqual(await resultPromise, {
    status: "failed",
    message: "リンクをコピーできませんでした。",
  });
  assert.deepEqual(copied, []);
});

test("Markdown link context menuはraw制御文字を含む外部URLをcopyしない", async () => {
  const copied: string[] = [];
  const harness = createHarness((target) => copied.push(target));
  const resultPromise = harness.service.showContextMenu({} as never, {
    target: "https://example.test/report\r\npowershell.exe",
    point: { x: 120, y: 240 },
  });

  harness.getMenuTemplate()[0]?.click?.();

  assert.deepEqual(await resultPromise, {
    status: "failed",
    message: "リンクをコピーできませんでした。",
  });
  assert.deepEqual(copied, []);
});

test("Markdown link context menuはdismiss後のclickと選択後の再clickでclipboardを更新しない", async () => {
  const dismissedCopies: string[] = [];
  const dismissed = createHarness((target) => dismissedCopies.push(target));
  const dismissedResult = dismissed.service.showContextMenu({} as never, {
    target: "docs/dismissed.md",
    point: { x: 1, y: 2 },
  });
  dismissed.getPopupOptions()?.callback?.();
  dismissed.getMenuTemplate()[0]?.click?.();
  assert.deepEqual(await dismissedResult, { status: "dismissed" });
  assert.deepEqual(dismissedCopies, []);

  const selectedCopies: string[] = [];
  const selected = createHarness((target) => selectedCopies.push(target));
  const selectedResult = selected.service.showContextMenu({} as never, {
    target: "docs/selected.md",
    point: { x: 1, y: 2 },
  });
  selected.getMenuTemplate()[0]?.click?.();
  selected.getMenuTemplate()[0]?.click?.();
  assert.deepEqual(await selectedResult, { status: "link-copied" });
  assert.deepEqual(selectedCopies, ["docs/selected.md"]);
});

test("Markdown link context menuは解決済みregular fileだけに別のfile copy操作を出す", async () => {
  const resource = { sessionId: "session-1", rootId: "workspace", relativePath: "docs/report.txt" };
  const harness = createHarness(undefined, resource);
  const resultPromise = harness.service.showContextMenu({} as never, {
    target: "docs/report.txt",
    point: { x: 10, y: 20 },
    fileContext: { sessionId: "session-1" },
  });
  await Promise.resolve();

  assert.deepEqual(harness.getMenuTemplate().map((item) => item.label), [
    "リンクをコピー",
    "ファイルをコピー",
  ]);
  harness.getMenuTemplate()[1]?.click?.();
  harness.getPopupOptions()?.callback?.();
  assert.deepEqual(await resultPromise, {
    status: "file-copy",
    result: { status: "copied", message: "File copied." },
  });

  const unresolved = createHarness();
  const unresolvedResult = unresolved.service.showContextMenu({} as never, {
    target: "missing.txt",
    point: { x: 1, y: 2 },
    fileContext: { sessionId: "session-1" },
  });
  await Promise.resolve();
  assert.deepEqual(unresolved.getMenuTemplate().map((item) => item.label), ["リンクをコピー"]);
  unresolved.getPopupOptions()?.callback?.();
  assert.deepEqual(await unresolvedResult, { status: "dismissed" });
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
