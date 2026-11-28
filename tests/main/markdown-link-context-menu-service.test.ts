import assert from "node:assert/strict";
import test from "node:test";

import { MarkdownLinkContextMenuService } from "../../src-electron/windows/markdown-link-context-menu-service.js";

/** Electron のメニューとクリップボードを置き換え、表示内容と選択の結果を観測できるようにする。 */
function createHarness(
  writeText: (target: string) => void = () => undefined,
  copyableFile: {
    sessionId: string;
    rootId: string;
    relativePath: string;
  } | null = null,
) {
  let menuTemplate: Array<{ label?: string; click?: () => void }> = [];
  let popupOptions:
    | { callback?: () => void; x?: number; y?: number; window?: unknown }
    | undefined;
  const service = new MarkdownLinkContextMenuService({
    /** メニュー項目を記録し、個々の選択を再現できるようにする。 */
    buildMenu(template) {
      menuTemplate = template as Array<{ label?: string; click?: () => void }>;
      return {
        /** 表示位置と閉じるコールバックを保存する。 */
        popup(options) {
          popupOptions = options;
        },
      };
    },
    writeText,
    /** リンクが実ファイルに解決された場合に使う試験用リソースを返す。 */
    resolveCopyableFile: async () => copyableFile,
    /** 選択されたファイルをコピーできた場合の結果を返す。 */
    copyFile: async () => ({ status: "copied", message: "File copied." }),
  });
  return {
    service,
    /** 最後に構築されたメニュー項目のラベルと選択処理を返す。 */
    getMenuTemplate: () => menuTemplate,
    /** ポップアップの最新の位置指定と終了処理を返す。 */
    getPopupOptions: () => popupOptions,
  };
}

// @test-value v2
// kind = "contract"
// claim = "Markdown link menuは選択されたときだけdecode済みtargetをclipboardへ1回渡す"
// oracle = { type = "contract", ref = "src-electron/windows/markdown-link-context-menu-service.ts#MarkdownLinkContextMenuService" }
// fault = "menu表示だけでclipboardを書き込む、未decodeのtargetを渡す、または選択後に重複書込みする"
// observable = "menu label、popup result、clipboard write targets"
// observation_boundary = "public-boundary"
// scope = "Markdown link copy action"
// lifecycle = "permanent"
// impact = "ユーザーが意図しないpathをclipboardへ受け取るか、link copy操作が重複する"
// distinction = "menu表示時と選択action後を分けてclipboard side effectと結果を確認する"
// @end-test-value
/** 表示だけではクリップボードを変更せず、Copy Link の選択後にだけ空白を復号したパスを一度書き込むことを確かめる。 */
test("Markdown link context menuは選択時だけ解決したtargetをclipboardへ渡す", async () => {
  const copied: string[] = [];
  const harness = createHarness((target) => copied.push(target));
  const request = {
    target: "docs/candidate-source%20final.json",
    point: { x: 120, y: 240 },
  };
  const resultPromise = harness.service.showContextMenu({} as never, request);

  assert.equal(harness.getMenuTemplate()[0]?.label, "Copy Link");
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

/** Windows のドライブと区切りを持つリンクをファイルシステムのパスに戻し、見出しの fragment を含めずにコピーすることを確認する。 */
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

// @test-value v2
// kind = "security"
// claim = "decode後に制御文字を含むlocal pathはlink copy対象として扱わず失敗を返す"
// oracle = { type = "contract", ref = "src-electron/windows/markdown-link-context-menu-service.ts#MarkdownLinkContextMenuService" }
// fault = "decode後の制御文字を含むpathをclipboardへ書き込み、path injectionの入力を通す"
// observable = "copy result status/message and clipboard writes"
// observation_boundary = "public-boundary"
// scope = "decoded local path control-character rejection"
// lifecycle = "permanent"
// impact = "制御文字を含むpathが外部操作へ渡り、意図しないclipboard内容になる"
// distinction = "percent-encoded control characterをdecodeした後の拒否とclipboard無副作用を確認する"
// risk_tags = ["security"]
// @end-test-value
/** ローカルパスの復号結果に制御文字がある場合は、コピー失敗を返しクリップボードを変更しないことを確認する。 */
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
    message: "Link could not be copied.",
  });
  assert.deepEqual(copied, []);
});

// @test-value v2
// kind = "security"
// claim = "raw制御文字を含む外部URLはlink copy対象として扱わず失敗を返す"
// oracle = { type = "contract", ref = "src-electron/windows/markdown-link-context-menu-service.ts#MarkdownLinkContextMenuService" }
// fault = "raw URL中の制御文字を検証せずclipboardへ渡す"
// observable = "copy result status/message and clipboard writes"
// observation_boundary = "public-boundary"
// scope = "raw external URL control-character rejection"
// lifecycle = "permanent"
// impact = "不正なURL文字列がclipboardへ渡り、外部リンク操作の安全境界を破る"
// distinction = "percent decodeを経ないraw URLでも制御文字拒否と無副作用を確認する"
// risk_tags = ["security"]
// @end-test-value
/** 外部 URL の入力に制御文字がある場合も、コピー失敗を返しクリップボードに渡さないことを確かめる。 */
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
    message: "Link could not be copied.",
  });
  assert.deepEqual(copied, []);
});

/** メニューを閉じた後の選択は無視し、すでに選択した項目を再実行しても書込みは一回であることを確認する。 */
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

// @test-value v2
// kind = "contract"
// claim = "解決済みregular fileだけがlink copyと独立したfile copy menu actionを持つ"
// oracle = { type = "contract", ref = "src-electron/windows/markdown-link-context-menu-service.ts#MarkdownLinkContextMenuService" }
// fault = "未解決pathにもfile copyを表示する、またはregular fileのcopy actionがtargetを渡さない"
// observable = "menu labels and file-copy result"
// observation_boundary = "public-boundary"
// scope = "Markdown link regular-file context menu"
// lifecycle = "permanent"
// impact = "ユーザーが存在しないpathをfile objectとしてcopyするか、file copy導線を失う"
// distinction = "解決済みregular fileと未解決pathを同じmenu APIで比較する"
// @end-test-value
/** ファイルに解決できた場合にだけ Copy File が独立して表示され、その選択はリンクコピーとは別の結果になることを確かめる。 */
test("Markdown link context menuは解決済みregular fileだけに別のfile copy操作を出す", async () => {
  const resource = {
    sessionId: "session-1",
    rootId: "workspace",
    relativePath: "docs/report.txt",
  };
  const harness = createHarness(undefined, resource);
  const resultPromise = harness.service.showContextMenu({} as never, {
    target: "docs/report.txt",
    point: { x: 10, y: 20 },
    fileContext: { sessionId: "session-1" },
  });
  await Promise.resolve();

  assert.deepEqual(
    harness.getMenuTemplate().map((item) => item.label),
    ["Copy Link", "Copy File"],
  );
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
  assert.deepEqual(
    unresolved.getMenuTemplate().map((item) => item.label),
    ["Copy Link"],
  );
  unresolved.getPopupOptions()?.callback?.();
  assert.deepEqual(await unresolvedResult, { status: "dismissed" });
});

// @test-value v2
// kind = "contract"
// claim = "Markdown link menuのdismissとclipboard failureは成功statusへ変換されない"
// oracle = { type = "contract", ref = "src-electron/windows/markdown-link-context-menu-service.ts#MarkdownLinkContextMenuService" }
// fault = "popup dismissまたはclipboard例外をlink-copiedとして返し、呼び出し元が成功扱いする"
// observable = "dismiss/failure result status and clipboard writes"
// observation_boundary = "public-boundary"
// scope = "Markdown link menu terminal outcomes"
// lifecycle = "permanent"
// impact = "ユーザーがcopyできていない操作を成功と誤認する"
// distinction = "dismiss経路とclipboard例外経路の両方をterminal resultで確認する"
// @end-test-value
/** メニューを閉じた場合とクリップボードが例外を返す場合を、成功に置き換えずそれぞれ終了と失敗として返すことを確かめる。 */
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
    message: "Link could not be copied.",
  });
});
