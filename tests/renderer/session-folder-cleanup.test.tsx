import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { SessionFolderCleanup, type SessionFolderCleanupApi } from "../../src/settings/SessionFolderCleanup.js";
import type { SessionFolderCleanupScan } from "../../src-shared/session/session-folder-cleanup.js";

const scan: SessionFolderCleanupScan = {
  scanId: "synthetic-scan", request: { fromDate: "", toDate: "", minimumFileSizeMiB: 0 },
  sessionCount: 12, totalFileCount: 80, totalBytes: 8192, matchedFileCount: 40, matchedBytes: 4096,
  skippedRunningSessionCount: 0, skippedWorkspaceSessionCount: 0, skippedLinkCount: 0, issues: [],
};

async function withCleanup(api: SessionFolderCleanupApi, run: (harness: {
  document: Document;
  click(text: string): Promise<void>;
  root: HTMLElement;
}) => Promise<void>) {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { pretendToBeVisual: true });
  const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
  const originals = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  dom.window.HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  const { createRoot } = await import("react-dom/client");
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  const click = async (text: string) => {
    const element = [...container.querySelectorAll<HTMLButtonElement | HTMLLabelElement>("button,label")]
      .find((item) => item.textContent?.trim() === text);
    assert.ok(element, `Missing control: ${text}`);
    if (element instanceof dom.window.HTMLButtonElement) assert.equal(element.disabled, false);
    await act(async () => { element.click(); });
  };
  try {
    await act(async () => { root.render(<SessionFolderCleanup api={api} />); });
    await run({ document: dom.window.document, root: container, click });
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

// @test-value v2
// kind = "contract"
// claim = "掃除は計算済み概要への確認取消では実行されず、確定時だけ計算IDを送り結果後は再計算を要求する"
// oracle = { type = "contract", ref = "docs/design/settings-ui.md#session-folder-cleanup" }
// fault = "確認前やCancel時に削除APIを呼ぶ、別の計算IDを送る、実行後に古い計算で再削除できる"
// observable = "削除APIへの要求、Cancel後の呼出回数、削除結果DOM、削除buttonのdisabled状態"
// observation_boundary = "component-behavior"
// scope = "SessionFolder cleanup confirmation"
// lifecycle = "permanent"
// impact = "利用者が確認していない削除や古い対象範囲の削除を実行する"
// distinction = "service testではrendererの確認取消と実行APIへの接続を検証できない"
// @end-test-value
test("概要確認のCancelでは削除せず、確定した計算IDだけを実行する", async () => {
  const requests: { scanId: string }[] = [];
  await withCleanup({
    async scanSessionFolderCleanup(request) { assert.deepEqual(request, scan.request); return scan; },
    async runSessionFolderCleanup(request) {
      requests.push(request);
      return { deletedFileCount: 40, deletedBytes: 4096, deletedDirectoryCount: 2, skippedFileCount: 0, failedFileCount: 0, issues: [] };
    },
  }, async ({ root, click }) => {
    await click("All Dates");
    await click("Calculate");
    await click("Delete Files…");
    assert.equal(requests.length, 0);
    assert.match(root.querySelector("dialog")!.textContent!, /40 Files · 4 KiB/);
    await click("Cancel");
    assert.equal(root.querySelector("dialog"), null);
    assert.equal(requests.length, 0);
    await click("Delete Files…");
    await click("Permanently Delete");
    assert.deepEqual(requests, [{ scanId: "synthetic-scan" }]);
    assert.match(root.textContent!, /40 Files Deleted · 4 KiB/);
    assert.equal([...root.querySelectorAll("button")].find((button) => button.textContent === "Delete Files…")!.disabled, true);
  });
});

// @test-value v2
// kind = "contract"
// claim = "計算失敗は0件と区別して再試行でき、条件変更は計算済み削除権限を失効させる"
// oracle = { type = "contract", ref = "docs/design/settings-ui.md#session-folder-cleanup" }
// fault = "計算例外を正常0件へ置換する、再試行が不能になる、条件変更後も旧計算結果を削除できる"
// observable = "失敗状態と再試行回数、再計算後の削除button状態、条件変更後のdisabled状態"
// observation_boundary = "component-behavior"
// scope = "SessionFolder cleanup scan lifecycle"
// lifecycle = "permanent"
// impact = "取得失敗を対象なしと誤認する、または表示条件と異なる削除が可能になる"
// distinction = "serviceと型検査では非同期エラーからのUI回復と入力変更の接続を確認できない"
// @end-test-value
test("計算失敗を再試行でき、入力変更で古い削除対象を失効させる", async () => {
  let calls = 0;
  await withCleanup({
    async scanSessionFolderCleanup() { if (++calls === 1) throw new Error("Synthetic read failure"); return scan; },
    async runSessionFolderCleanup() { assert.fail("No deletion expected"); },
  }, async ({ root, click }) => {
    await click("All Dates");
    await click("Calculate");
    assert.match(root.querySelector('[role="status"]')!.textContent!, /Calculate Session File Usage failed/);
    assert.match(root.querySelector('[popover]')!.textContent!, /Synthetic read failure/);
    await click("Calculate");
    const button = [...root.querySelectorAll("button")].find((item) => item.textContent === "Delete Files…")!;
    assert.equal(button.disabled, false);
    await click("All Dates");
    assert.equal(button.disabled, true);
    assert.equal(calls, 2);
  });
});

// @test-value v2
// kind = "contract"
// claim = "削除失敗は同じ操作から再計算でき、再計算失敗も再操作でき、新しい概要の確認後だけ新しい計算IDで削除する"
// oracle = { type = "contract", ref = "docs/design/settings-ui.md#session-folder-cleanup" }
// fault = "削除失敗後に元の操作を無効化する、再計算失敗で回復不能になる、確認前に削除する、古い計算IDを再使用する"
// observable = "元の削除buttonのenabled/busy状態、再計算回数、再確認の件数、削除APIの計算IDと呼出回数"
// observation_boundary = "component-behavior"
// scope = "SessionFolder cleanup deletion recovery"
// lifecycle = "permanent"
// impact = "失敗から回復できない、または再確認していない範囲のファイルを削除する"
// distinction = "serviceと型検査ではrendererの回復操作と再計算・確認・実行の接続を検証できない"
// @end-test-value
test("削除失敗の再操作は再計算と再確認を経て新しい計算IDを使う", async () => {
  let scans = 0;
  let resolveRetry!: (value: SessionFolderCleanupScan) => void;
  const requests: { scanId: string }[] = [];
  await withCleanup({
    async scanSessionFolderCleanup() {
      scans++;
      if (scans === 2) throw new Error("Synthetic recalculation failure");
      if (scans === 3) return new Promise((resolve) => { resolveRetry = resolve; });
      return scan;
    },
    async runSessionFolderCleanup(request) {
      requests.push(request);
      if (requests.length === 1) throw new Error("Synthetic deletion failure");
      return { deletedFileCount: 2, deletedBytes: 1024, deletedDirectoryCount: 0, skippedFileCount: 0, failedFileCount: 0, issues: [] };
    },
  }, async ({ root, click }) => {
    await click("All Dates");
    await click("Calculate");
    await click("Delete Files…");
    await click("Permanently Delete");
    const button = [...root.querySelectorAll("button")].find((item) => item.textContent === "Delete Files…")!;
    assert.equal(button.disabled, false);
    assert.match(button.parentElement!.querySelector('[popover]')!.textContent!, /Synthetic deletion failure/);
    await click("Delete Files…");
    assert.equal(button.disabled, false);
    assert.match(button.parentElement!.querySelector('[popover]')!.textContent!, /Synthetic recalculation failure/);
    assert.equal(root.querySelector("dialog"), null);
    assert.equal(requests.length, 1);
    await click("Delete Files…");
    assert.equal(button.disabled, true);
    assert.equal(button.getAttribute("aria-busy"), "true");
    await act(async () => button.click());
    assert.equal(scans, 3);
    await act(async () => resolveRetry({ ...scan, scanId: "fresh-scan", matchedFileCount: 2, matchedBytes: 1024 }));
    assert.match(root.querySelector("dialog")!.textContent!, /2 Files · 1 KiB/);
    assert.equal(requests.length, 1);
    await click("Cancel");
    assert.equal(requests.length, 1);
    await click("Delete Files…");
    await click("Permanently Delete");
    assert.deepEqual(requests, [{ scanId: "synthetic-scan" }, { scanId: "fresh-scan" }]);
  });
});

// @test-value v2
// kind = "contract"
// claim = "ファイル・directoryの部分失敗でも元の削除操作から回復でき、再計算で0件なら削除確認へ進まない"
// oracle = { type = "contract", ref = "docs/design/settings-ui.md#session-folder-cleanup" }
// fault = "例外だけを回復対象にして部分失敗を取り残す、失敗file数0のdirectory失敗を無視する、再計算0件で削除を許可する"
// observable = "部分削除結果、元の削除buttonのenabled状態、0件再計算後のdisabled状態と確認dialog、削除API呼出回数"
// observation_boundary = "component-behavior"
// scope = "SessionFolder cleanup partial failure recovery"
// lifecycle = "permanent"
// impact = "部分失敗から再操作できない、または削除対象のない確認・実行を許可する"
// distinction = "Main service testでは部分結果を受けた操作導線と確認抑止を検証できない"
// @end-test-value
test("ファイルとdirectoryの部分失敗は再操作でき、再計算0件では削除しない", async () => {
  for (const failedFileCount of [1, 0]) {
    let scans = 0;
    let runs = 0;
    await withCleanup({
      async scanSessionFolderCleanup() {
        return ++scans === 1 ? scan : { ...scan, scanId: "empty-scan", matchedFileCount: 0, matchedBytes: 0 };
      },
      async runSessionFolderCleanup() {
        runs++;
        return { deletedFileCount: 39, deletedBytes: 3072, deletedDirectoryCount: 0, skippedFileCount: 0, failedFileCount,
          issues: [{ sessionId: "synthetic", relativePath: "locked", kind: "failed", message: "Synthetic cleanup failure" }] };
      },
    }, async ({ root, click }) => {
      await click("All Dates");
      await click("Calculate");
      await click("Delete Files…");
      await click("Permanently Delete");
      assert.match(root.textContent!, /39 Files Deleted · 3 KiB/);
      if (failedFileCount) assert.match(root.textContent!, /1 Files Failed/);
      const button = [...root.querySelectorAll("button")].find((item) => item.textContent === "Delete Files…")!;
      assert.equal(button.disabled, false);
      await click("Delete Files…");
      assert.equal(scans, 2);
      assert.equal(runs, 1);
      assert.equal(button.disabled, true);
      assert.equal(root.querySelector("dialog"), null);
      assert.match(root.querySelector("dl")!.textContent!, /0 B/);
    });
  }
});

// @test-value v2
// kind = "contract"
// claim = "期間未選択は計算前に止め、計算中の多重実行を防ぎ、正常0件では削除を許可しない"
// oracle = { type = "contract", ref = "docs/design/settings-ui.md#session-folder-cleanup" }
// fault = "未選択を全期間として扱う、非同期計算を多重送信する、または正常0件で削除確認へ進む"
// observable = "期間エラー、計算API呼出回数、処理中busy状態、0件での削除button disabled"
// observation_boundary = "component-behavior"
// scope = "SessionFolder cleanup input and admission"
// lifecycle = "permanent"
// impact = "意図しない全期間対象化と重複操作を発生させる"
// distinction = "入力のUI上の明示選択と多重click制御はshared parserやservice testでは確認できない"
// @end-test-value
test("期間の明示指定と計算single-flight、正常0件の削除抑止を維持する", async () => {
  let resolve!: (value: SessionFolderCleanupScan) => void;
  let calls = 0;
  await withCleanup({
    scanSessionFolderCleanup() { calls++; return new Promise((accept) => { resolve = accept; }); },
    async runSessionFolderCleanup() { assert.fail("No deletion expected"); },
  }, async ({ root, click }) => {
    await click("Calculate");
    assert.match(root.textContent!, /Choose a date range or All Dates/);
    assert.equal(calls, 0);
    await click("All Dates");
    await click("Calculate");
    const calculate = [...root.querySelectorAll("button")].find((item) => item.textContent?.includes("Calculate"))!;
    assert.equal(calculate.disabled, true);
    assert.equal(calculate.getAttribute("aria-busy"), "true");
    await act(async () => calculate.click());
    assert.equal(calls, 1);
    await act(async () => resolve({ ...scan, sessionCount: 0, totalFileCount: 0, totalBytes: 0, matchedFileCount: 0, matchedBytes: 0 }));
    assert.match(root.textContent!, /0 B/);
    assert.equal([...root.querySelectorAll("button")].find((item) => item.textContent === "Delete Files…")!.disabled, true);
  });
});
