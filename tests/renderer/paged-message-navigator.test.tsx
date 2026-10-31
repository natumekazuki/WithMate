import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { SessionContextPane, type MessageNavigatorPage, type SessionContextPaneProps } from "../../src/chat/shell/session-context-pane.js";
import { buildContextPaneProjection } from "../../src/chat/runtime/session-ui-projection.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function withNavigator(run: (fixture: {
  dom: JSDOM;
  element: HTMLElement;
  render: (page: MessageNavigatorPage) => void;
  jumps: string[];
}) => Promise<void>) {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { pretendToBeVisual: true });
  const names = ["window", "document", "navigator", "HTMLElement", "Node", "DOMRect", "Event", "MouseEvent"] as const;
  const descriptors = names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, value: name === "window" ? dom.window : dom.window[name] });
  Object.defineProperties(dom.window.HTMLElement.prototype, {
    offsetWidth: { configurable: true, get: () => 280 },
    offsetHeight: { configurable: true, get() { return (this as HTMLElement).classList.contains("messages-navigator-virtual-row") ? 54 : 600; } },
    clientHeight: { configurable: true, get: () => 600 },
    scrollHeight: { configurable: true, get() { return Number.parseFloat((this as HTMLElement).querySelector<HTMLElement>(".messages-navigator-virtual-list")?.style.height ?? "600"); } },
    getBoundingClientRect: { configurable: true, value() {
      const element = this as HTMLElement;
      const scroll = element.closest(".command-monitor-content") as HTMLElement | null;
      const top = element.classList.contains("messages-navigator-virtual-list") ? -(scroll?.scrollTop ?? 0) : 0;
      return new dom.window.DOMRect(0, top, 280, element.classList.contains("messages-navigator-virtual-row") ? 54 : 600);
    } },
    scrollTo: { configurable: true, value(options: ScrollToOptions) { this.scrollTop = options.top ?? 0; this.dispatchEvent(new dom.window.Event("scroll")); } },
  });
  const element = dom.window.document.getElementById("root")!;
  const root = createRoot(element);
  const jumps: string[] = [];
  const props: SessionContextPaneProps = {
    activeContextPaneTab: "messages", availableContextPaneTabs: ["messages"],
    contextPaneProjection: buildContextPaneProjection({ activeContextPaneTab: "messages", latestCommandView: null, backgroundTasks: [] }),
    latestCommandView: null, runningDetailsEntries: [], liveRunReasoningText: "", backgroundTasks: [],
    selectedSessionLiveRunErrorMessage: "", isSelectedSessionRunning: false, isCopilotSession: false,
    selectedCopilotRemainingPercentLabel: "", selectedCopilotRemainingRequestsLabel: "", selectedCopilotQuotaResetLabel: "",
    selectedSessionContextTelemetry: null,
    selectedSessionContextTelemetryProjection: { summaryLabel: "", currentTokensLabel: "", tokenLimitLabel: "", messagesLengthLabel: "", systemTokensLabel: "", conversationTokensLabel: "" },
    messageNavigatorSessionId: "main", onCycleContextPaneTab() {}, onJumpToMessage: (key) => jumps.push(key),
  };
  try {
    await run({ dom, element, jumps, render: (page) => root.render(React.createElement(SessionContextPane, { ...props, messageNavigatorPage: page })) });
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
}

// @test-value v2
// kind = "contract"
// claim = "有限pageのMessages navigatorでもHome/End/Arrow/Enterは全件の位置へ移動し、Bookmarkは読込済みpage外を含む対象へ切り替える"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: Messages navigatorと全履歴query page" }
// fault = "keyboard移動が手元pageに限定される、未取得末尾へのfocusを失う、またはBookmark切替を現在pageだけに適用する"
// observable = "1000件の先頭/末尾focus、wrap移動後のEnter jump key、別総件数200件のBookmark末尾jump"
// observation_boundary = "component-behavior"
// scope = "Messages navigatorのpageを跨ぐkeyboard操作とfilter変更"
// lifecycle = "permanent"
// impact = "長い会話やBookmark結果の一部へkeyboardで到達できなくなる"
// distinction = "local array navigatorの既存testは全件数と未取得pageを持たず、type/buildはmounted focusとjumpを観測しない"
// @end-test-value
test("paged navigator moves across the whole result and bookmark pages", async () => withNavigator(async ({ dom, element, render, jumps }) => {
  let filter: "all" | "bookmarks" = "all";
  const ranges: number[] = [];
  const show = (index = 0) => {
    const totalCount = filter === "all" ? 1000 : 200;
    const offset = Math.max(0, Math.floor(index / 64) * 64 - 64);
    render({ filter, offset, totalCount, loading: false, error: "",
      items: Array.from({ length: Math.min(192, totalCount - offset) }, (_, i) => ({
        key: `${filter}-${offset + i}`, sourceKind: "session", role: "user", preview: `Message ${offset + i + 1}`,
        accent: false, isCollapsed: false, isBookmarked: filter === "bookmarks",
      })),
      onRequestRange: (index) => { ranges.push(index); show(index); },
      onFilterChange: (next) => { filter = next; show(); }, onRetry() {},
    });
  };
  const key = async (key: string) => act(async () => {
    dom.window.document.activeElement?.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
  await act(async () => show());
  await act(async () => element.querySelector<HTMLButtonElement>(".messages-navigator-row")!.focus());
  await key("End");
  assert.match(dom.window.document.activeElement?.getAttribute("aria-label") ?? "", /Message 1000$/);
  assert.ok(ranges.includes(999));
  await key("Enter");
  assert.equal(jumps.at(-1), "all-999");
  await key("ArrowDown");
  assert.match(dom.window.document.activeElement?.getAttribute("aria-label") ?? "", /Message 1$/);
  await key("ArrowUp");
  assert.match(dom.window.document.activeElement?.getAttribute("aria-label") ?? "", /Message 1000$/);
  await key("Home");
  assert.match(dom.window.document.activeElement?.getAttribute("aria-label") ?? "", /Message 1$/);
  await act(async () => element.querySelector<HTMLButtonElement>(".messages-navigator-filter:nth-of-type(2)")!.click());
  assert.equal(element.querySelector(".messages-navigator-filter:nth-of-type(2)")?.getAttribute("aria-pressed"), "true");
  await act(async () => element.querySelector<HTMLButtonElement>(".messages-navigator-row")!.focus());
  await key("End");
  assert.match(dom.window.document.activeElement?.getAttribute("aria-label") ?? "", /Bookmark saved: Message 200$/);
  await key("Enter");
  assert.equal(jumps.at(-1), "bookmarks-199");
  assert.ok(element.querySelectorAll(".messages-navigator-row").length < 64);
}));

// @test-value v2
// kind = "contract"
// claim = "Messages navigatorのloading/errorは成功した0件結果と区別され、errorからRetryを実行できる"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: Messages navigatorと全履歴query page" }
// fault = "pendingまたは失敗を空の成功結果として表示する、または再試行できない"
// observable = "aria-busy、loading表示、error alertとRetry callback、成功0件ではそれらがない状態"
// observation_boundary = "component-behavior"
// scope = "Messages navigator queryのloading/error/empty状態"
// lifecycle = "permanent"
// impact = "利用者がまだ読込中の履歴や失敗を存在しない履歴と誤認する"
// distinction = "backend query testsと型検査はmounted UIの状態表示とRetry操作を観測しない"
// @end-test-value
test("paged navigator distinguishes loading and errors from an empty result", async () => withNavigator(async ({ element, render }) => {
  let retries = 0;
  const page: MessageNavigatorPage = { items: [], offset: 0, totalCount: 0, filter: "all", loading: true, error: "", onFilterChange() {}, onRequestRange() {}, onRetry: () => retries++ };
  await act(async () => render(page));
  assert.equal(element.querySelector(".messages-navigator")?.getAttribute("aria-busy"), "true");
  assert.ok(element.querySelector("[role='status'][aria-label='Loading Messages']"));
  await act(async () => render({ ...page, loading: false, error: "Query failed" }));
  assert.match(element.querySelector("[role='alert']")?.textContent ?? "", /Query failed/);
  await act(async () => Array.from(element.querySelectorAll("button")).find((button) => button.textContent === "Retry")!.click());
  assert.equal(retries, 1);
  await act(async () => render({ ...page, loading: false }));
  assert.equal(element.querySelector("[role='alert']"), null);
  assert.equal(element.querySelector(".messages-navigator")?.getAttribute("aria-busy"), "false");
  assert.equal(element.querySelector("[role='status'][aria-label='Loading Messages']"), null);
}));
