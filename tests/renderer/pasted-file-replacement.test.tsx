import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { usePastedFileReplacement } from "../../src/chat/use-pasted-file-replacement.js";

// @test-value v2
// kind = "contract"
// claim = "添付先が切り替わるか入力欄が消えた後の遅い衝突結果は確認待ちを作らず、既存の確認待ちも取消として完了する"
// oracle = { type = "contract", ref = "docs/design/session-local-files.md: 添付先の切替と入力欄の終了" }
// fault = "古いcallbackが表示されないdialogのpromiseを未解決にするか、別の添付先で置換を承認する"
// observable = "切替前callback・pending確認・unmount後callbackのcancel解決"
// observation_boundary = "component-behavior"
// scope = "paste conflict dialog owner lifecycle"
// lifecycle = "permanent"
// impact = "遅いhash判定が別会話の確認や無期限の添付待ちを作ることを防ぐ"
// distinction = "型・storage testや即時mockではReactのowner切替と遅延callbackの組合せを検証できない"
// @end-test-value
test("paste replacement cancels stale owners and settles on unmount", { timeout: 3000 }, async () => {
  const dom = new JSDOM("<!doctype html><div id='root'></div>");
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const previousAct = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(dom.window.document.getElementById("root")!);
  let controller: ReturnType<typeof usePastedFileReplacement> | undefined;
  function Harness({ owner }: { owner: string }) { controller = usePastedFileReplacement(owner, true); return null; }
  const conflict = { status: "conflict" as const, fileName: "note.txt", existingHash: "existing" };
  try {
    await act(async () => root.render(<Harness owner="main" />));
    const main = controller!.confirmReplacement;
    await act(async () => root.render(<Harness owner="auxiliary" />));
    assert.equal(await main(conflict), "cancel");
    const auxiliary = controller!.confirmReplacement;
    let waiting: ReturnType<typeof auxiliary>;
    await act(async () => { waiting = auxiliary(conflict); });
    await act(async () => root.unmount());
    assert.equal(await waiting!, "cancel");
    assert.equal(await auxiliary(conflict), "cancel");
  } finally {
    await act(async () => root.unmount());
    if (previous) Object.defineProperty(globalThis, "window", previous); else Reflect.deleteProperty(globalThis, "window");
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument); else Reflect.deleteProperty(globalThis, "document");
    if (previousAct) Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct); else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    dom.window.close();
  }
});
