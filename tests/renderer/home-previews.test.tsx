import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

import type { SessionFilePreviewContextMenuRequest, SessionFilePreviewWindowGroup } from "../../src-shared/file-explorer/file-explorer-contract.js";
import { normalizeSessionSummary } from "../../src-shared/session/session-state.js";
import { HomePreviewsPanel } from "../../src/home/HomePreviewsPanel.js";
import type { HomePreviewsApi } from "../../src/home/use-home-previews.js";

function group(ownerSessionId: string, token = ownerSessionId): SessionFilePreviewWindowGroup {
  return { ownerSessionId, session: normalizeSessionSummary({ id: ownerSessionId, taskTitle: ownerSessionId }), previews: [{ token, title: "report.md", path: `C:/work/${ownerSessionId}/report.md` }] };
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
// claim = "Previewsは選択したtoken/ownerだけを操作し、menu取消では閉じず、右クリックとkeyboardでCloseでき、失敗後も再操作できる"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#home-window" }
// fault = "別groupや同名fileを操作する、menuをキャンセルしても閉じる、親Windowを開けない、または操作失敗を隠す"
// observable = "tooltipのpath、menu requestとClose/Focus/Open API引数、取消後の呼出し不在、失敗alertと再操作可能なbutton"
// observation_boundary = "component-behavior"
// scope = "Home Previews panelの親展開・親Session open・子focus・右クリックとkeyboard menuによる個別/親close"
// lifecycle = "permanent"
// impact = "同名fileでも意図したWindowだけへ復帰し、他Sessionのpreviewを閉じない"
// distinction = "DOM操作から実際のAPI境界への対象選択と非同期失敗の回復は型checkでは確認できない"
// @end-test-value
test("Previews dispatches the selected preview token and owning group independently", async () => {
  const calls: string[][] = [];
  const menus: SessionFilePreviewContextMenuRequest[] = [];
  let selection: "close" | "dismissed" = "dismissed";
  let closeFailure = true;
  let sessionFailure = false;
  const api: HomePreviewsApi = {
    listSessionFilePreviewWindows: async () => [group("parent-a", "main-preview"), group("parent-b", "aux-preview")],
    subscribeSessionFilePreviewWindowsChanged: () => () => {},
    focusSessionFilePreviewWindow: async (token) => { calls.push(["focus", token]); },
    closeSessionFilePreviewWindow: async (token) => { calls.push(["close", token]); if (closeFailure) throw new Error("Window close failed"); },
    closeSessionFilePreviewWindows: async (owner) => { calls.push(["group", owner]); },
    showSessionFilePreviewContextMenu: async (request) => { menus.push(request); return selection; },
    openSession: async (owner) => { calls.push(["session", owner]); if (sessionFailure) throw new Error("Session open failed"); },
  };
  await withPreviews(api, async (doc) => {
    const cards = [...doc.querySelectorAll(".home-monitor-card")];
    assert.equal(cards.length, 2);
    assert.equal(cards[1]!.querySelector(".home-previews-children")!.hasAttribute("hidden"), true);
    await act(async () => cards[1]!.querySelector<HTMLButtonElement>(".home-previews-disclosure")!.click());
    assert.equal(cards[1]!.querySelector(".home-previews-disclosure")!.getAttribute("aria-expanded"), "true");
    assert.equal(cards[1]!.querySelector(".home-previews-children")!.hasAttribute("hidden"), false);
    const file = cards[1]!.querySelector<HTMLButtonElement>(".home-previews-file")!;
    assert.equal(file.title, "C:/work/parent-b/report.md");
    await act(async () => file.click());
    const parent = cards[0]!.querySelector<HTMLButtonElement>(".home-previews-session")!;
    await act(async () => parent.click());
    const rightClick = async (element: HTMLElement) => {
      const event = new doc.defaultView!.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 12, clientY: 34 });
      await act(async () => { element.dispatchEvent(event); });
      assert.equal(event.defaultPrevented, true);
    };
    await rightClick(file);
    assert.deepEqual(calls, [["focus", "aux-preview"], ["session", "parent-a"]]);
    selection = "close";
    await rightClick(file);
    assert.match(doc.querySelector('[role="alert"]')!.textContent!, /Could not close preview: Window close failed/);
    assert.equal(file.disabled, false);
    closeFailure = false;
    await act(async () => { file.dispatchEvent(new doc.defaultView!.KeyboardEvent("keydown", { key: "ContextMenu", bubbles: true, cancelable: true })); });
    assert.equal(doc.querySelector('[role="alert"]'), null);
    await act(async () => { parent.dispatchEvent(new doc.defaultView!.KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true, cancelable: true })); });
    assert.deepEqual(menus, [
      { scope: "preview", point: { x: 12, y: 34 } }, { scope: "preview", point: { x: 12, y: 34 } },
      { scope: "preview", point: { x: 0, y: 0 } }, { scope: "session", point: { x: 0, y: 0 } },
    ]);
    assert.deepEqual(calls, [["focus", "aux-preview"], ["session", "parent-a"], ["close", "aux-preview"], ["close", "aux-preview"], ["group", "parent-a"]]);
    sessionFailure = true;
    await act(async () => parent.click());
    assert.match(doc.querySelector('[role="alert"]')!.textContent!, /Could not open session: Session open failed/);
    assert.equal(parent.disabled, false);
    sessionFailure = false;
    await act(async () => parent.click());
    assert.equal(doc.querySelector('[role="alert"]'), null);
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
    showSessionFilePreviewContextMenu: async () => "dismissed", openSession: async () => {},
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
