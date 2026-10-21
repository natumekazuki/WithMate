import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

import type { SessionFilePreviewWindowGroup } from "../../src-shared/file-explorer/file-explorer-contract.js";
import { HomePreviewsPanel } from "../../src/home/HomePreviewsPanel.js";
import type { HomePreviewsApi } from "../../src/home/use-home-previews.js";

function group(ownerSessionId: string, token = ownerSessionId): SessionFilePreviewWindowGroup {
  return { ownerSessionId, session: null, previews: [{ token, title: "report.md", path: `C:/work/${ownerSessionId}/report.md` }] };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function withPreviews(api: HomePreviewsApi, run: (doc: Document) => Promise<void>) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  const names = ["window", "document", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const descriptors = names.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
  for (const name of names) Object.defineProperty(globalThis, name, {
    configurable: true, value: name === "IS_REACT_ACT_ENVIRONMENT" ? true : dom.window[name],
  });
  Object.defineProperty(dom.window, "withmate", { value: api });
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    await act(async () => root.render(<HomePreviewsPanel />));
    await run(dom.window.document);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    names.forEach((name, index) => {
      const descriptor = descriptors[index];
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
    });
  }
}

// @test-value v2
// kind = "contract"
// claim = "Previewsの開閉とfocusは選択したtokenまたは親ownerだけを操作し、失敗したcloseを表示して再操作できる"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#home-window" }
// fault = "別groupのownerや同名fileのtokenをdispatchする、またはclose失敗を隠して操作不能にする"
// observable = "展開後の識別path、APIに渡るtokenとowner、close失敗alertと再操作可能なbutton"
// observation_boundary = "component-behavior"
// scope = "Home Previews panelの親展開・子focus・個別close・親close-all"
// lifecycle = "permanent"
// impact = "同名fileでも意図したWindowだけへ復帰し、他Sessionのpreviewを閉じない"
// distinction = "DOM操作から実際のAPI境界への対象選択と非同期失敗の回復は型checkでは確認できない"
// @end-test-value
test("Previews dispatches the selected preview token and owning group independently", async () => {
  const calls: string[][] = [];
  const api: HomePreviewsApi = {
    listSessionFilePreviewWindows: async () => [group("parent-a", "main-preview"), group("parent-b", "aux-preview")],
    subscribeSessionFilePreviewWindowsChanged: () => () => {},
    focusSessionFilePreviewWindow: async (token) => { calls.push(["focus", token]); },
    closeSessionFilePreviewWindow: async (token) => { calls.push(["close", token]); throw new Error("Window close failed"); },
    closeSessionFilePreviewWindows: async (owner) => { calls.push(["group", owner]); },
  };
  await withPreviews(api, async (doc) => {
    const cards = [...doc.querySelectorAll(".home-monitor-card")];
    assert.equal(cards.length, 2);
    assert.equal(cards[1]!.querySelector(".home-previews-children")!.hasAttribute("hidden"), true);
    await act(async () => cards[1]!.querySelector<HTMLButtonElement>(".home-previews-disclosure")!.click());
    assert.equal(cards[1]!.querySelector(".home-previews-disclosure")!.getAttribute("aria-expanded"), "true");
    assert.equal(cards[1]!.querySelector(".home-previews-children")!.hasAttribute("hidden"), false);
    assert.match(cards[1]!.textContent!, /C:\/work\/parent-b\/report.md/);
    await act(async () => cards[1]!.querySelector<HTMLButtonElement>(".home-previews-file")!.click());
    const close = cards[1]!.querySelector<HTMLButtonElement>(".home-previews-file-row .home-previews-close")!;
    await act(async () => close.click());
    assert.match(doc.querySelector('[role="alert"]')!.textContent!, /Could not close preview: Window close failed/);
    assert.equal(close.disabled, false);
    await act(async () => cards[0]!.querySelector<HTMLButtonElement>(".home-previews-parent-row .home-previews-close")!.click());
    assert.deepEqual(calls, [["focus", "aux-preview"], ["close", "aux-preview"], ["group", "parent-a"]]);
  });
});

// @test-value v2
// kind = "invariant"
// claim = "Previewsの変更通知後は最新取得だけを反映し、読込失敗時は取得済み内容とRetryを保持し、正常0件へ復帰できる"
// oracle = { type = "contract", ref = "docs/design/ui-design-guidelines.md#読込・空・失敗" }
// fault = "遅れた取得が最新一覧を上書きする、取得失敗を0件扱いする、またはRetryで復帰できない"
// observable = "読込busy、最新path、失敗alertと保持中のpath、Retry後の正常0件、購読解除"
// observation_boundary = "component-behavior"
// scope = "Home Previews panelの初回取得と変更通知による並行取得・再試行"
// lifecycle = "permanent"
// impact = "閉じたWindowの古い一覧で操作させず、一覧取得失敗から回復できる"
// distinction = "取得完了順と通知・再試行を跨ぐ表示状態は型checkや静的renderでは確認できない"
// @end-test-value
test("Previews keeps the latest refresh and recovers a failed refresh without discarding its list", async () => {
  const requests: ReturnType<typeof deferred<SessionFilePreviewWindowGroup[]>>[] = [];
  let emit = () => {};
  let unsubscribed = false;
  const api: HomePreviewsApi = {
    listSessionFilePreviewWindows: () => { const request = deferred<SessionFilePreviewWindowGroup[]>(); requests.push(request); return request.promise; },
    subscribeSessionFilePreviewWindowsChanged: (listener) => { emit = listener; return () => { unsubscribed = true; }; },
    focusSessionFilePreviewWindow: async () => {}, closeSessionFilePreviewWindow: async () => {}, closeSessionFilePreviewWindows: async () => {},
  };
  await withPreviews(api, async (doc) => {
    assert.equal(doc.querySelector(".home-previews-body")!.getAttribute("aria-busy"), "true");
    await act(async () => emit());
    await act(async () => requests[1]!.resolve([group("latest")]));
    await act(async () => requests[0]!.resolve([group("stale")]));
    assert.equal(doc.querySelectorAll(".home-monitor-card").length, 1);
    assert.match(doc.querySelector(".home-previews-file")!.getAttribute("title")!, /latest/);
    await act(async () => emit());
    await act(async () => requests[2]!.reject(new Error("Registry unavailable")));
    assert.match(doc.querySelector('[role="alert"]')!.textContent!, /Registry unavailable/);
    assert.match(doc.querySelector(".home-previews-file")!.getAttribute("title")!, /latest/);
    await act(async () => doc.querySelector<HTMLButtonElement>('[role="alert"] button')!.click());
    await act(async () => requests[3]!.resolve([]));
    assert.equal(doc.querySelector(".home-previews-body")!.getAttribute("aria-busy"), "false");
    assert.equal(doc.querySelectorAll(".home-monitor-card").length, 0);
    assert.equal(doc.querySelectorAll('[role="alert"]').length, 0);
  });
  assert.equal(unsubscribed, true);
});
