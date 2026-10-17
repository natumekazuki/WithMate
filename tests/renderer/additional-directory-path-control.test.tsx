import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import type { Root } from "react-dom/client";

import { AdditionalDirectoryPathControl } from "../../src/chat/composer/additional-directory-path-control.js";
import type { WorkspaceDirectoryValidationResult } from "../../src-shared/window/workspace-directory-validation.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// @test-value v2
// kind = "contract"
// claim = "Add Directory By Pathは入力を事前検証し、空欄・検証待ち・無効pathを送信せず、検証失敗を入力保持とalertで示す。処理中の二重送信と閉鎖を止め、保存失敗から再試行できる。取消・成功時はfocusを戻し、閉鎖前の遅い検証結果やdisabled後のdialogを復活させない"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: Add Directory By Path; docs/manual-test-checklist.md: MT-023D4" }
// fault = "未検証・無効pathや二重送信を通す、検証/保存失敗で入力を消す、busy中に閉じる、focusを失う、閉じたdialogの検証結果が再open後の追加可否やerrorを上書きする"
// observable = "描画dialogの見出し・inputのaria-labelと値・alert・Add disabled/busy・callback回数とpath・閉鎖後のdocument.activeElement"
// observation_boundary = "component-behavior"
// scope = "AdditionalDirectoryPathControlの入力・保存・失敗・取消・編集制約"
// lifecycle = "permanent"
// impact = "directory追加時の入力喪失と二重操作を防ぎ、失敗から再試行できる"
// distinction = "選択adapterと静的DOM testでは観測しない非同期React状態とcallbackの接続を、制御したPromiseとJSDOMで低コストに確認する。実browserのTab移動・IME・見た目は別途確認する"
// @end-test-value
test("Add Directory By Pathは入力・busy・失敗からの再試行とfocus復帰を維持する", async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "https://withmate.local/" });
  const previous = { window: globalThis.window, document: globalThis.document, HTMLElement: globalThis.HTMLElement };
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement })) {
    Object.defineProperty(globalThis, key, { value, configurable: true });
  }
  let root: Root | null = null;
  const container = dom.window.document.getElementById("root")!;
  const button = (text: string) => {
    const value = Array.from(container.querySelectorAll("button")).find((candidate) => candidate.textContent?.trim() === text);
    assert.ok(value, text);
    return value;
  };
  const input = () => container.querySelector<HTMLInputElement>("input")!;
  const requests: string[] = [];
  let complete!: () => void;
  let fail!: (error: Error) => void;
  let finishValidation!: (result: WorkspaceDirectoryValidationResult) => void;
  const validationRequests: string[] = [];
  const onValidate = async (directoryPath: string): Promise<WorkspaceDirectoryValidationResult> => {
    validationRequests.push(directoryPath);
    if (directoryPath === "C:/slow") return new Promise((resolve) => { finishValidation = resolve; });
    return directoryPath === "C:/missing" ? { valid: false, reason: "missing" } : { valid: true };
  };
  const onAdd = (directoryPath: string) => {
    requests.push(directoryPath);
    return new Promise<void>((resolve, reject) => { complete = resolve; fail = reject; });
  };
  const render = async (disabled = false) => {
    await act(async () => root!.render(<AdditionalDirectoryPathControl disabled={disabled} onAdd={onAdd} onValidate={onValidate} />));
  };
  const open = async () => {
    button("Add Directory By Path").focus();
    await act(async () => button("Add Directory By Path").click());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  };
  const fill = async (value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input(), value);
      input().dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
  };
  const settleValidation = async () => {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 340)); });
  };
  try {
    const { createRoot } = await import("react-dom/client");
    root = createRoot(container);
    await render();
    await open();
    assert.equal(container.querySelector("h2")?.textContent, "Add Directory By Path");
    assert.equal(input().getAttribute("aria-label"), "Directory path");
    assert.equal(dom.window.document.activeElement, input());
    assert.equal(button("Add").disabled, true);
    await fill("  ");
    assert.equal(button("Add").disabled, true);
    await fill("C:/missing");
    assert.equal(button("Add").disabled, true);
    assert.ok(container.querySelector('[aria-busy="true"]'));
    await act(async () => container.querySelector("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })));
    assert.deepEqual(requests, []);
    await settleValidation();
    assert.equal(input().value, "C:/missing");
    assert.equal(input().getAttribute("aria-invalid"), "true");
    assert.equal(container.querySelector('[role="alert"]')?.textContent, "Path not found.");
    assert.equal(button("Add").disabled, true);
    await fill("  C:/shared folder  ");
    assert.equal(button("Add").disabled, true);
    assert.equal(container.querySelector('[role="alert"]'), null);
    await settleValidation();
    assert.deepEqual(validationRequests, ["C:/missing", "C:/shared folder"]);
    assert.equal(button("Add").disabled, false);
    button("Add").focus();
    await act(async () => { button("Add").click(); button("Add").click(); });
    assert.deepEqual(requests, ["C:/shared folder"]);
    assert.equal(button("Add").getAttribute("aria-busy"), "true");
    assert.equal(input().readOnly, true);
    assert.equal(dom.window.document.activeElement, input());
    assert.equal(button("Cancel").disabled, true);
    await act(async () => input().dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    assert.ok(container.querySelector('[role="dialog"]'));
    await act(async () => fail(new Error("Could not save directory.")));
    assert.equal(input().readOnly, false);
    assert.equal(dom.window.document.activeElement, input());
    assert.equal(input().value, "  C:/shared folder  ");
    assert.equal(container.querySelector('[role="alert"]')?.textContent, "Could not save directory.");
    assert.equal(input().getAttribute("aria-invalid"), "true");
    await fill("C:/retry");
    assert.equal(container.querySelector('[role="alert"]'), null);
    await settleValidation();
    await act(async () => container.querySelector("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })));
    await act(async () => complete());
    assert.deepEqual(requests, ["C:/shared folder", "C:/retry"]);
    assert.equal(container.querySelector('[role="dialog"]'), null);
    assert.equal(dom.window.document.activeElement, button("Add Directory By Path"));
    await open();
    await fill("C:/slow");
    await settleValidation();
    await act(async () => button("Cancel").click());
    assert.equal(dom.window.document.activeElement, button("Add Directory By Path"));
    await open();
    await act(async () => finishValidation({ valid: false, reason: "missing" }));
    assert.equal(input().value, "");
    assert.equal(button("Add").disabled, true);
    assert.equal(container.querySelector('[role="alert"]'), null);
    await act(async () => input().dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    assert.equal(container.querySelector('[role="dialog"]'), null);
    assert.equal(dom.window.document.activeElement, button("Add Directory By Path"));
    await open();
    await render(true);
    assert.equal(button("Add Directory By Path").disabled, true);
    assert.equal(container.querySelector('[role="dialog"]'), null);
    await render(false);
    assert.equal(container.querySelector('[role="dialog"]'), null);
  } finally {
    await act(async () => root?.unmount());
    dom.window.close();
    for (const [key, value] of Object.entries(previous)) Object.defineProperty(globalThis, key, { value, configurable: true });
  }
});
