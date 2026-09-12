import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import {
  clampSessionVerticalDockHeight,
  measureSessionHorizontalLayoutBounds,
  measureSessionVerticalDockLayoutBounds,
  useChatLayoutPresentation,
  useSessionMessageListFollowing,
  useSessionSidePanes,
  useSessionVerticalDockResize,
} from "../../src/session-chat-layout-hooks.js";
import type {
  ChatActionDockMode,
  ChatHeaderVisibility,
  ChatLayoutPriority,
} from "../../src/chat/chat-layout-preference.js";
import type { SessionSidePane } from "../../src/session-side-pane.js";

// @test-value v2
// kind = "invariant"
// claim = "高さclamp helperは、中央領域5%とHeader・splitterを残す残余高を上限にする"
// oracle = { type = "contract", ref = "ActionDock layout height bounds" }
// fault = "中央領域5%・Header・splitterを残す残余高上限を使わず、要求値をそのまま返す"
// observable = "clampSessionVerticalDockHeightが返すActionDock高さ"
// observation_boundary = "component-behavior"
// scope = "session-action-dock-height-clamp-helper"
// lifecycle = "permanent"
// impact = "高さ計算が上限を越え、中央surfaceまたはsplitterの操作領域を圧迫する"
// distinction = "CSS宣言やpointer経路とは分け、helperへHeader・splitterを含む中央5%残余境界を渡して直接検証する"
// @end-test-value
test("vertical dock height は比率上限と中央領域の最小高を優先する", () => {
  assert.equal(clampSessionVerticalDockHeight({
    requestedHeight: 500,
    layoutHeight: 420,
    minHeight: 180,
    maxHeightRatio: 0.95,
    oppositeDockHeight: 64,
  }), 295);
});

// @test-value v2
// kind = "invariant"
// claim = "ActionDockの利用可能高はlayoutのpaddingとborderを除いたcontent高から計算する"
// oracle = { type = "contract", ref = "ActionDock content layout bounds" }
// fault = "border-box全体をlayout高として扱い、paddingやborderの分だけActionDockが画面外へ出るか中央領域を圧迫する"
// observable = "measureSessionVerticalDockLayoutBoundsの返却値"
// observation_boundary = "component-behavior"
// scope = "session-action-dock-layout-bounds"
// lifecycle = "permanent"
// impact = "Window resizeや小さいWindowでdockと中央surfaceの境界がずれる"
// distinction = "高さclamp helperの上限計算とは分け、実DOMのbox modelからcontent高を測定する境界だけを検証する"
// @end-test-value
test("vertical dock layout は border-box から padding と border を除いた高さを使う", () => {
  const previousWindow = globalThis.window;
  const dom = new JSDOM("<!doctype html><html><body><div id=\"layout\"></div></body></html>");
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });

  try {
    const layout = dom.window.document.getElementById("layout") as HTMLElement;
    layout.style.paddingTop = "10px";
    layout.style.paddingBottom = "12px";
    layout.style.borderTop = "1px solid transparent";
    layout.style.borderBottom = "2px solid transparent";
    layout.getBoundingClientRect = () => ({
      x: 0,
      y: 20,
      top: 20,
      right: 1000,
      bottom: 620,
      left: 0,
      width: 1000,
      height: 600,
      toJSON: () => ({}),
    });

    const bounds = measureSessionVerticalDockLayoutBounds(layout);
    assert.deepEqual(bounds, { top: 31, bottom: 606, height: 575 });
  } finally {
    dom.window.close();
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
  }
});

test("side pane layout は border-box から padding と border を除いた幅を使う", () => {
  const previousWindow = globalThis.window;
  const dom = new JSDOM("<!doctype html><html><body><div id=\"layout\"></div></body></html>");
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });

  try {
    const layout = dom.window.document.getElementById("layout") as HTMLElement;
    layout.style.paddingLeft = "12px";
    layout.style.paddingRight = "14px";
    layout.style.borderLeft = "1px solid transparent";
    layout.style.borderRight = "2px solid transparent";
    layout.getBoundingClientRect = () => ({
      x: 20,
      y: 0,
      top: 0,
      right: 1020,
      bottom: 600,
      left: 20,
      width: 1000,
      height: 600,
      toJSON: () => ({}),
    });

    assert.deepEqual(measureSessionHorizontalLayoutBounds(layout), {
      left: 33,
      right: 1004,
      width: 971,
    });
  } finally {
    dom.window.close();
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
  }
});

function dispatchPointerEvent(
  dom: JSDOM,
  target: EventTarget,
  type: "pointerdown" | "pointermove" | "pointerup",
  clientX: number,
  clientY = clientX,
): MouseEvent {
  const event = new dom.window.MouseEvent(type, {
    bubbles: true,
    button: 0,
    cancelable: true,
    clientX,
    clientY,
  });
  Object.defineProperty(event, "pointerId", { configurable: true, value: 1 });
  target.dispatchEvent(event);
  return event;
}

// @test-value v2
// kind = "invariant"
// claim = "ActionDockのpointer resizeは設定された最大・最小高さを越えず、layoutのCSS custom propertyへclamp済みの高さを反映する"
// oracle = { type = "contract", ref = "ActionDock drag resize contract" }
// fault = "ドラッグ中に要求値をそのまま反映し、ActionDockが設定された最大高さを越えるか最小高さを下回る"
// observable = "layoutの--session-action-dock-height CSS custom property"
// observation_boundary = "component-behavior"
// scope = "session-action-dock-pointer-resize"
// lifecycle = "permanent"
// impact = "expanded ActionDockが画面外へはみ出すか、縮小操作で操作可能な最小高さへ戻れない"
// distinction = "pointer gestureからhookの高さ反映までの経路を、上下両方向のclampで検証する"
// @end-test-value
test("ActionDock resize は固定 Header と中央領域の高さを残す", async () => {
  const previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT;
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousHTMLElement = globalThis.HTMLElement;
  const previousNode = globalThis.Node;
  const previousNavigator = globalThis.navigator;
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
    pretendToBeVisual: true,
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: dom.window.HTMLElement });
  Object.defineProperty(globalThis, "Node", { configurable: true, value: dom.window.Node });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });

  let root: Root | null = null;

  function Harness() {
    const {
      sessionDockLayoutRef,
      sessionDockLayoutStyle,
      handleStartActionDockResize,
    } = useSessionVerticalDockResize({
      ownerKey: "session-1",
      isHeaderExpanded: true,
      isActionDockExpanded: true,
    });
    return React.createElement(
      "div",
      {
        ref: sessionDockLayoutRef,
        style: {
          ...sessionDockLayoutStyle,
          paddingTop: "10px",
          paddingBottom: "12px",
          borderTop: "1px solid transparent",
          borderBottom: "2px solid transparent",
        },
        "data-testid": "layout",
      },
      React.createElement("div", { className: "session-action-dock-slot", style: { "--session-region-min-height": "260px" } }),
      React.createElement("button", {
        type: "button",
        onPointerDown: handleStartActionDockResize,
        "data-testid": "splitter",
      }),
    );
  }

  try {
    await act(async () => {
      root = createRoot(dom.window.document.getElementById("root") as HTMLElement);
      root.render(React.createElement(Harness));
    });
    const layout = dom.window.document.querySelector<HTMLElement>("[data-testid=\"layout\"]");
    const splitter = dom.window.document.querySelector<HTMLButtonElement>("[data-testid=\"splitter\"]");
    assert.ok(layout);
    assert.ok(splitter);
    layout.getBoundingClientRect = () => ({
      x: 0,
      y: 20,
      top: 20,
      right: 1000,
      bottom: 2020,
      left: 0,
      width: 1000,
      height: 2000,
      toJSON: () => ({}),
    });

    await act(async () => dom.window.dispatchEvent(new dom.window.Event("resize")));
    assert.equal(layout.style.getPropertyValue("--session-action-dock-height"), "320px");

    await act(async () => dispatchPointerEvent(dom, splitter, "pointerdown", 0, 1686));
    await act(async () => dispatchPointerEvent(dom, dom.window, "pointermove", 0, 31));
    assert.equal(layout.style.getPropertyValue("--session-action-dock-height"), "1772.25px");
    await act(async () => dispatchPointerEvent(dom, dom.window, "pointermove", 0, 1800));
    assert.equal(layout.style.getPropertyValue("--session-action-dock-height"), "260px");
    await act(async () => dispatchPointerEvent(dom, dom.window, "pointerup", 0, 1800));
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    dom.window.close();
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
    Object.defineProperty(globalThis, "document", { configurable: true, value: previousDocument });
    Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: previousHTMLElement });
    Object.defineProperty(globalThis, "Node", { configurable: true, value: previousNode });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: previousNavigator });
  }
});

test("ActionDock compact height は展開時の外枠高ではなく compact row から算出する", async () => {
  const previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT;
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousHTMLElement = globalThis.HTMLElement;
  const previousNode = globalThis.Node;
  const previousNavigator = globalThis.navigator;
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
    pretendToBeVisual: true,
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: dom.window.HTMLElement });
  Object.defineProperty(globalThis, "Node", { configurable: true, value: dom.window.Node });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });

  const previousScrollHeight = Object.getOwnPropertyDescriptor(dom.window.HTMLElement.prototype, "scrollHeight");
  Object.defineProperty(dom.window.HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get() {
      return (this as HTMLElement).classList.contains("session-action-dock") ? 320 : 40;
    },
  });

  let root: Root | null = null;

  function Harness() {
    const {
      actionDockRef,
      sessionDockLayoutStyle,
    } = useSessionVerticalDockResize({
      ownerKey: "session-1",
      isHeaderExpanded: true,
      isActionDockExpanded: false,
    });
    return React.createElement(
      "div",
      { style: sessionDockLayoutStyle, "data-testid": "layout" },
      React.createElement(
        "div",
        { ref: actionDockRef },
        React.createElement(
          "div",
          {
            className: "session-action-dock",
            style: { borderTop: "1px solid transparent", borderBottom: "1px solid transparent" },
          },
          React.createElement(
            "div",
            {
              className: "session-action-dock-compact-content",
              style: { paddingTop: "6px", paddingBottom: "6px" },
            },
            React.createElement("div", { className: "session-action-dock-compact-row" }),
          ),
        ),
      ),
    );
  }

  try {
    await act(async () => {
      root = createRoot(dom.window.document.getElementById("root") as HTMLElement);
      root.render(React.createElement(Harness));
    });
    const layout = dom.window.document.querySelector<HTMLElement>("[data-testid=\"layout\"]");
    assert.ok(layout);
    assert.equal(layout.style.getPropertyValue("--session-action-dock-compact-height"), "54px");
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    if (previousScrollHeight) {
      Object.defineProperty(dom.window.HTMLElement.prototype, "scrollHeight", previousScrollHeight);
    } else {
      delete (dom.window.HTMLElement.prototype as Partial<HTMLElement>).scrollHeight;
    }
    dom.window.close();
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
    Object.defineProperty(globalThis, "document", { configurable: true, value: previousDocument });
    Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: previousHTMLElement });
    Object.defineProperty(globalThis, "Node", { configurable: true, value: previousNode });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: previousNavigator });
  }
});

test("useSessionMessageListFollowing は末尾表示中だけ更新とresizeへ追従する", async () => {
  const previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT;
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousHTMLElement = globalThis.HTMLElement;
  const previousNode = globalThis.Node;
  const previousNavigator = globalThis.navigator;
  const previousResizeObserver = globalThis.ResizeObserver;
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
    pretendToBeVisual: true,
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: dom.window.HTMLElement });
  Object.defineProperty(globalThis, "Node", { configurable: true, value: dom.window.Node });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });

  let root: Root | null = null;
  let scrollToBottomCount = 0;
  let scrollHeight = 1_000;
  let clientHeight = 200;
  const resizeObservers: TestResizeObserver[] = [];

  class TestResizeObserver {
    readonly targets = new Set<Element>();

    constructor(readonly callback: ResizeObserverCallback) {
      resizeObservers.push(this);
    }

    observe(target: Element): void {
      this.targets.add(target);
    }

    disconnect(): void {
      this.targets.clear();
    }

    unobserve(target: Element): void {
      this.targets.delete(target);
    }
  }

  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: TestResizeObserver,
  });
  Object.defineProperty(dom.window, "ResizeObserver", {
    configurable: true,
    value: TestResizeObserver,
  });

  function Harness({ enabled, scrollSignature }: { enabled: boolean; scrollSignature: string }) {
    const {
      messageListRef,
      isMessageListFollowing,
      handleMessageListScroll,
      handleMessageListSend,
      followMessageListLatest,
    } = useSessionMessageListFollowing({
      ownerKey: "session-1",
      scrollSignature,
      enabled,
    });

    return React.createElement(
      React.Fragment,
      null,
      React.createElement(
        "div",
        {
          ref: messageListRef,
          onScroll: handleMessageListScroll,
          hidden: !enabled,
          "data-testid": "message-list",
        },
        React.createElement("div", {
          className: "session-message-list-window",
        }, React.createElement("div", {
          className: "message-list-bottom-anchor",
          ref: (element: HTMLDivElement | null) => {
            if (element) {
              element.scrollIntoView = () => {
                scrollToBottomCount += 1;
                const owner = element.closest<HTMLElement>("[data-testid=\"message-list\"]");
                if (owner) {
                  owner.scrollTop = Math.max(0, owner.scrollHeight - owner.clientHeight);
                }
              };
            }
          },
        })),
        React.createElement("input", { "data-testid": "elicitation-input" }),
        React.createElement("textarea", { "data-testid": "elicitation-textarea" }),
        React.createElement(
          "select",
          { "data-testid": "elicitation-select" },
          React.createElement("option", null, "option"),
        ),
        React.createElement("output", { "data-testid": "following" }, String(isMessageListFollowing)),
        React.createElement("button", {
          type: "button",
          onClick: followMessageListLatest,
          "data-testid": "jump",
        }),
      ),
      React.createElement("button", { type: "button", "data-testid": "outside-action" }),
      React.createElement("button", {
        type: "button",
        onClick: () => handleMessageListSend(false),
        "data-testid": "send-with-scroll-disabled",
      }),
      React.createElement("button", {
        type: "button",
        onClick: () => handleMessageListSend(true),
        "data-testid": "send-with-scroll-enabled",
      }),
    );
  }

  try {
    await act(async () => {
      root = createRoot(dom.window.document.getElementById("root") as HTMLElement);
      root.render(React.createElement(Harness, { enabled: true, scrollSignature: "initial" }));
    });

    const messageList = dom.window.document.querySelector<HTMLElement>("[data-testid=\"message-list\"]");
    const following = dom.window.document.querySelector<HTMLOutputElement>("[data-testid=\"following\"]");
    assert.ok(messageList);
    assert.ok(following);
    assert.equal(scrollToBottomCount, 1);

    Object.defineProperty(messageList, "scrollHeight", { configurable: true, get: () => scrollHeight });
    Object.defineProperty(messageList, "clientHeight", { configurable: true, get: () => clientHeight });
    messageList.scrollTop = scrollHeight - clientHeight;
    messageList.addEventListener("keydown", (event) => event.stopPropagation());
    for (const [testId, key, shiftKey] of [
      ["elicitation-input", "ArrowUp", false],
      ["elicitation-textarea", "Home", false],
      ["elicitation-select", " ", true],
    ] as const) {
      const formControl = dom.window.document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
      assert.ok(formControl);
      await act(async () => {
        formControl.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
          bubbles: true,
          key,
          shiftKey,
        }));
      });
      assert.equal(following.textContent, "true", `${key} のフォーム操作では追従を止めない`);
    }

    await act(async () => {
      messageList.dispatchEvent(new dom.window.WheelEvent("wheel", { bubbles: true, deltaY: -120 }));
      messageList.scrollTop -= 2;
      messageList.dispatchEvent(new dom.window.Event("scroll", { bubbles: true }));
      await new Promise<void>((resolve) => dom.window.requestAnimationFrame(() => resolve()));
    });
    assert.equal(following.textContent, "false");
    assert.equal(messageList.scrollTop, 798, "停止後は予約済みの末尾補正でも読書位置を動かさない");

    await act(async () => {
      root?.render(React.createElement(Harness, { enabled: true, scrollSignature: "stream-while-reading" }));
    });
    assert.equal(messageList.scrollTop, 798, "stream更新で読書位置を動かさない");

    await act(async () => {
      dom.window.document.querySelector<HTMLButtonElement>("[data-testid=\"send-with-scroll-disabled\"]")?.click();
    });
    assert.equal(following.textContent, "false", "設定OFFの送信では追随を再開しない");
    assert.equal(messageList.scrollTop, 798, "設定OFFの送信では読書位置を動かさない");

    await act(async () => {
      dom.window.document.querySelector<HTMLButtonElement>("[data-testid=\"send-with-scroll-enabled\"]")?.click();
    });
    assert.equal(following.textContent, "true", "設定ONの送信では追随を再開する");
    assert.equal(messageList.scrollTop, scrollHeight - clientHeight, "設定ONの送信では末尾へ移動する");

    scrollHeight = 1_120;
    await act(async () => {
      messageList.dispatchEvent(new dom.window.Event("scroll", { bubbles: true }));
      root?.render(React.createElement(Harness, { enabled: true, scrollSignature: "pending-after-send" }));
    });
    assert.equal(following.textContent, "true", "送信後の待機表示が遅れて追加されても追随を維持する");
    assert.equal(messageList.scrollTop, scrollHeight - clientHeight, "送信後の待機表示を含む末尾へ移動する");

    await act(async () => {
      dom.window.document.querySelector<HTMLButtonElement>("[data-testid=\"send-with-scroll-enabled\"]")?.click();
      messageList.dispatchEvent(new dom.window.WheelEvent("wheel", { bubbles: true, deltaY: -120 }));
      messageList.scrollTop -= 2;
      messageList.dispatchEvent(new dom.window.Event("scroll", { bubbles: true }));
    });
    assert.equal(following.textContent, "false");

    const readingPositionAfterSend = messageList.scrollTop;
    scrollHeight = 1_240;
    await act(async () => {
      root?.render(React.createElement(Harness, {
        enabled: true,
        scrollSignature: "pending-after-user-scroll",
      }));
    });
    assert.equal(following.textContent, "false", "送信後でも利用者が上へ戻ったら追随予約を破棄する");
    assert.equal(messageList.scrollTop, readingPositionAfterSend, "破棄後の待機表示で読書位置を動かさない");

    const outsideAction = dom.window.document.querySelector<HTMLButtonElement>(
      "[data-testid=\"outside-action\"]",
    );
    assert.ok(outsideAction);
    await act(async () => {
      const pointerDown = new dom.window.Event("pointerdown", { bubbles: true });
      Object.defineProperty(pointerDown, "pointerId", { value: 7 });
      outsideAction.dispatchEvent(pointerDown);
      const pointerUp = new dom.window.Event("pointerup");
      Object.defineProperty(pointerUp, "pointerId", { value: 7 });
      dom.window.dispatchEvent(pointerUp);
      messageList.scrollTop = scrollHeight - clientHeight;
      messageList.dispatchEvent(new dom.window.Event("scroll", { bubbles: true }));
    });
    assert.equal(following.textContent, "false", "message list外のpointer操作では追従を再開しない");

    await act(async () => {
      const pointerDown = new dom.window.Event("pointerdown", { bubbles: true });
      Object.defineProperty(pointerDown, "pointerId", { value: 8 });
      messageList.dispatchEvent(pointerDown);
      const pointerUp = new dom.window.Event("pointerup");
      Object.defineProperty(pointerUp, "pointerId", { value: 8 });
      dom.window.dispatchEvent(pointerUp);
      messageList.dispatchEvent(new dom.window.Event("scroll", { bubbles: true }));
    });
    assert.equal(following.textContent, "true", "message list内で開始したpointer操作は追従を再開できる");

    await act(async () => {
      messageList.dispatchEvent(new dom.window.WheelEvent("wheel", { bubbles: true, deltaY: -120 }));
      messageList.scrollTop = scrollHeight - clientHeight - 2;
      messageList.dispatchEvent(new dom.window.Event("scroll", { bubbles: true }));
    });
    assert.equal(following.textContent, "false");

    await act(async () => {
      messageList.dispatchEvent(new dom.window.WheelEvent("wheel", { bubbles: true, deltaY: 120 }));
      messageList.scrollTop = scrollHeight - clientHeight - 1;
      messageList.dispatchEvent(new dom.window.Event("scroll", { bubbles: true }));
    });
    assert.equal(following.textContent, "true", "1pxのlayout誤差は末尾として許容する");

    scrollHeight = 1_120;
    await act(async () => {
      root?.render(React.createElement(Harness, { enabled: true, scrollSignature: "stream-growing" }));
    });
    assert.equal(messageList.scrollTop, 920, "stream本文の伸長へ追従する");

    scrollHeight = 1_260;
    await act(async () => {
      for (const observer of resizeObservers) {
        observer.callback([], observer as unknown as ResizeObserver);
      }
    });
    assert.equal(messageList.scrollTop, 1_060, "message高さの非同期変化へ追従する");

    clientHeight = 140;
    await act(async () => {
      for (const observer of resizeObservers) {
        observer.callback([], observer as unknown as ResizeObserver);
      }
    });
    assert.equal(messageList.scrollTop, 1_120, "ActionDock resize後のviewport末尾へ追従する");

    await act(async () => {
      messageList.scrollTop = scrollHeight - clientHeight - 2;
      messageList.dispatchEvent(new dom.window.Event("scroll", { bubbles: true }));
    });
    assert.equal(following.textContent, "false");

    await act(async () => {
      dom.window.document.querySelector<HTMLButtonElement>("[data-testid=\"jump\"]")?.click();
    });
    assert.equal(following.textContent, "true");
    assert.equal(messageList.scrollTop, scrollHeight - clientHeight);

    await act(async () => {
      root?.render(React.createElement(Harness, { enabled: false, scrollSignature: "preview-update" }));
    });
    await act(async () => {
      root?.render(React.createElement(Harness, { enabled: true, scrollSignature: "preview-update" }));
    });
    assert.equal(following.textContent, "true");
    assert.equal(messageList.scrollTop, scrollHeight - clientHeight);
  } finally {
    await act(async () => root?.unmount());
    dom.window.close();
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
    Object.defineProperty(globalThis, "document", { configurable: true, value: previousDocument });
    Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: previousHTMLElement });
    Object.defineProperty(globalThis, "Node", { configurable: true, value: previousNode });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: previousNavigator });
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      value: previousResizeObserver,
    });
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      previousActEnvironment;
  }
});

// @test-value v2
// kind = "invariant"
// claim = "左右ペインはクリックで排他的に開閉し、展開中のドラッグ・キー操作は領域の最小サイズを守る"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: Session dock layout" }
// fault = "閉じたペインのドラッグで意図せず復帰する、左右を同時表示する、または領域の最小サイズを下回る"
// observable = "active paneとside pane width style"
// observation_boundary = "component-behavior"
// scope = "useSessionSidePanes"
// lifecycle = "permanent"
// impact = "排他表示と開いているペインだけの操作契約を維持する"
// distinction = "閉じたペインの操作無効化と反対側の自動クローズを確認する"
// @end-test-value
test("useSessionSidePanes は左右ペインを排他表示し、閉じたペインを操作対象にしない", async () => {
  const previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  const previousWindow = globalThis.window, previousDocument = globalThis.document;
  const previousHTMLElement = globalThis.HTMLElement, previousNode = globalThis.Node, previousNavigator = globalThis.navigator;
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", { pretendToBeVisual: true });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: dom.window.HTMLElement });
  Object.defineProperty(globalThis, "Node", { configurable: true, value: dom.window.Node });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  let root: Root | null = null;
  const changes: SessionSidePane[] = [];
  function Harness({ initialSidePane }: { initialSidePane: SessionSidePane | null }) {
    const state = useSessionSidePanes({ ownerKey: "session-1", initialSidePane, onSidePaneChange: (value) => changes.push(value) });
    return React.createElement("div", { ref: state.sessionWorkbenchRef, style: state.sessionWorkbenchStyle, "data-testid": "workbench" },
      React.createElement("div", { className: "session-left-pane-slot", style: { "--session-region-min-width": "260px", "--session-region-min-height": "200px" } }),
      React.createElement("div", { className: "session-message-stack", style: { "--session-region-min-width": "360px", "--session-region-min-height": "160px" } }),
      React.createElement("div", { className: "session-right-pane-slot", style: { "--session-region-min-width": "360px", "--session-region-min-height": "200px" } }),
      React.createElement("button", { onPointerDown: state.handleStartContextRailResize, onClick: state.handleToggleContextRailVisibility, onKeyDown: state.handleKeyDownContextRailResize, "data-testid": "context-splitter" }),
      React.createElement("button", { onPointerDown: state.handleStartFilesPaneResize, onClick: state.handleToggleFilesPaneVisibility, onKeyDown: state.handleKeyDownFilesPaneResize, "data-testid": "files-splitter" }),
      React.createElement("button", { onClick: state.handleToggleFilesPaneVisibility, "data-testid": "files-toggle" }),
      React.createElement("button", { onClick: state.handleToggleContextRailVisibility, "data-testid": "context-toggle" }),
      React.createElement("output", { "data-testid": "active-pane" }, state.activeSidePane),
      React.createElement("output", { "data-testid": "resizing" }, state.isContextRailResizing ? "context" : state.isFilesPaneResizing ? "files" : "idle"),
    );
  }
  const pointer = (target: EventTarget, type: string, clientX: number) => {
    const event = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX, clientY: clientX });
    Object.defineProperty(event, "pointerId", { value: 1 });
    target.dispatchEvent(event);
    return event;
  };
  try {
    await act(async () => { root = createRoot(dom.window.document.getElementById("root") as HTMLElement); root.render(React.createElement(Harness, { initialSidePane: "context" })); });
    const workbench = dom.window.document.querySelector<HTMLElement>("[data-testid=\"workbench\"]")!;
    const contextSplitter = dom.window.document.querySelector<HTMLButtonElement>("[data-testid=\"context-splitter\"]")!;
    const filesSplitter = dom.window.document.querySelector<HTMLButtonElement>("[data-testid=\"files-splitter\"]")!;
    const filesToggle = dom.window.document.querySelector<HTMLButtonElement>("[data-testid=\"files-toggle\"]")!;
    const contextToggle = dom.window.document.querySelector<HTMLButtonElement>("[data-testid=\"context-toggle\"]")!;
    const active = dom.window.document.querySelector<HTMLOutputElement>("[data-testid=\"active-pane\"]")!;
    const resizing = dom.window.document.querySelector<HTMLOutputElement>("[data-testid=\"resizing\"]")!;
    let viewportWidth = 1600, workbenchWidth = 1600;
    Object.defineProperty(dom.window, "innerWidth", { configurable: true, get: () => viewportWidth });
    workbench.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, right: workbenchWidth, bottom: 800, left: 0, width: workbenchWidth, height: 800, toJSON: () => ({}) });
    assert.equal(active.textContent, "context");
    await act(async () => contextSplitter.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
    assert.equal(active.textContent, "none");
    const closed = pointer(filesSplitter, "pointerdown", 500);
    assert.equal(closed.defaultPrevented, false);
    assert.equal(resizing.textContent, "idle");
    await act(async () => contextToggle.click());
    assert.equal(active.textContent, "context");
    await act(async () => pointer(contextSplitter, "pointerdown", 420));
    await act(async () => pointer(dom.window, "pointermove", 1000));
    await act(async () => pointer(dom.window, "pointerup", 1000));
    assert.equal(workbench.style.getPropertyValue("--session-context-rail-width"), "360px");
    await act(async () => filesToggle.click());
    assert.equal(active.textContent, "files");
    assert.equal(workbench.style.getPropertyValue("--session-context-rail-width"), "0px");
    await act(async () => pointer(filesSplitter, "pointerdown", 320));
    assert.equal(resizing.textContent, "files");
    await act(async () => pointer(dom.window, "pointermove", 500));
    await act(async () => pointer(dom.window, "pointerup", 500));
    assert.equal(active.textContent, "files");
    assert.equal(workbench.style.getPropertyValue("--session-file-explorer-width"), "500px");
    await act(async () => pointer(filesSplitter, "pointerdown", 500));
    await act(async () => pointer(dom.window, "pointermove", -500));
    await act(async () => pointer(dom.window, "pointerup", -500));
    assert.equal(workbench.style.getPropertyValue("--session-file-explorer-width"), "260px");
    await act(async () => filesSplitter.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true })));
    assert.equal(workbench.style.getPropertyValue("--session-file-explorer-width"), "260px");
    await new Promise((resolve) => setTimeout(resolve, 120));
    await act(async () => filesToggle.click());
    assert.equal(active.textContent, "none");
    viewportWidth = 1200;
    const narrowClosed = pointer(contextSplitter, "pointerdown", 400);
    assert.equal(narrowClosed.defaultPrevented, false);
    await act(async () => contextToggle.click());
    assert.equal(active.textContent, "context");
    await act(async () => pointer(contextSplitter, "pointerdown", 400));
    assert.equal(resizing.textContent, "context");
    await act(async () => pointer(dom.window, "pointermove", 1000));
    await act(async () => pointer(dom.window, "pointerup", 1000));
    assert.equal(workbench.style.getPropertyValue("--session-context-rail-width"), "200px");
    assert.deepEqual(changes, ["none", "context", "files", "none", "context"]);
  } finally {
    await act(async () => root?.unmount()); dom.window.close();
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
    Object.defineProperty(globalThis, "document", { configurable: true, value: previousDocument });
    Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: previousHTMLElement });
    Object.defineProperty(globalThis, "Node", { configurable: true, value: previousNode });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: previousNavigator });
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }
});

test("useChatLayoutPresentation は項目ごとの先行操作を遅い初期設定で巻き戻さず、後続snapshotへ追従しない", async () => {
  const previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT;
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousHTMLElement = globalThis.HTMLElement;
  const previousNode = globalThis.Node;
  const previousNavigator = globalThis.navigator;
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
    pretendToBeVisual: true,
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: dom.window.HTMLElement });
  Object.defineProperty(globalThis, "Node", { configurable: true, value: dom.window.Node });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });

  let root: Root | null = null;
  const headerChanges: ChatHeaderVisibility[] = [];
  const actionDockChanges: ChatActionDockMode[] = [];
  const priorityChanges: ChatLayoutPriority[] = [];

  function Harness({
    initialHeader,
    initialActionDock,
    initialPriority,
  }: {
    initialHeader: ChatHeaderVisibility | null;
    initialActionDock: ChatActionDockMode | null;
    initialPriority: ChatLayoutPriority | null;
  }) {
    const state = useChatLayoutPresentation({
      initialHeader,
      initialActionDock,
      initialPriority,
      onHeaderChange: (value) => headerChanges.push(value),
      onActionDockChange: (value) => actionDockChanges.push(value),
      onPriorityChange: (value) => priorityChanges.push(value),
    });
    return React.createElement(
      "div",
      null,
      React.createElement("button", {
        type: "button",
        "data-testid": "header-toggle",
        onClick: () => state.setIsHeaderExpanded((current) => !current),
      }),
      React.createElement("button", {
        type: "button",
        "data-testid": "priority-toggle",
        onClick: () => state.setLayoutPriority("dock-first"),
      }),
      React.createElement("button", {
        type: "button",
        "data-testid": "dock-toggle",
        onClick: () => state.setIsActionDockPinnedExpanded((current) => !current),
      }),
      React.createElement("output", { "data-testid": "header" }, state.isHeaderExpanded ? "visible" : "hidden"),
      React.createElement(
        "output",
        { "data-testid": "dock" },
        state.isActionDockPinnedExpanded ? "expanded" : "compact",
      ),
      React.createElement("output", { "data-testid": "priority" }, state.layoutPriority),
    );
  }

  try {
    await act(async () => {
      root = createRoot(dom.window.document.getElementById("root") as HTMLElement);
      root.render(React.createElement(Harness, {
        initialHeader: null,
        initialActionDock: null,
        initialPriority: null,
      }));
    });
    const headerToggle = dom.window.document.querySelector<HTMLButtonElement>("[data-testid=\"header-toggle\"]");
    const dockToggle = dom.window.document.querySelector<HTMLButtonElement>("[data-testid=\"dock-toggle\"]");
    const priorityToggle = dom.window.document.querySelector<HTMLButtonElement>("[data-testid=\"priority-toggle\"]");
    const header = dom.window.document.querySelector<HTMLOutputElement>("[data-testid=\"header\"]");
    const dock = dom.window.document.querySelector<HTMLOutputElement>("[data-testid=\"dock\"]");
    const priority = dom.window.document.querySelector<HTMLOutputElement>("[data-testid=\"priority\"]");
    assert.ok(headerToggle);
    assert.ok(dockToggle);
    assert.ok(priorityToggle);
    assert.ok(header);
    assert.ok(dock);
    assert.ok(priority);

    assert.equal(priority.textContent, "side-pane-first");
    await act(async () => priorityToggle.click());
    assert.equal(priority.textContent, "dock-first");

    await act(async () => headerToggle.click());
    assert.equal(header.textContent, "visible");

    await act(async () => {
      root?.render(React.createElement(Harness, {
        initialHeader: "hidden",
        initialActionDock: "expanded",
        initialPriority: "side-pane-first",
      }));
    });
    assert.equal(header.textContent, "visible");
    assert.equal(dock.textContent, "expanded");

    await act(async () => {
      root?.render(React.createElement(Harness, {
        initialHeader: "hidden",
        initialActionDock: "compact",
        initialPriority: "side-pane-first",
      }));
    });
    assert.equal(header.textContent, "visible");
    assert.equal(dock.textContent, "expanded");
    assert.equal(priority.textContent, "dock-first");

    await act(async () => dockToggle.click());
    assert.equal(dock.textContent, "compact");
    assert.equal(priority.textContent, "side-pane-first");
    assert.deepEqual(headerChanges, ["visible"]);
    assert.deepEqual(actionDockChanges, ["compact"]);
    assert.deepEqual(priorityChanges, ["dock-first", "side-pane-first"]);
  } finally {
    await act(async () => root?.unmount());
    dom.window.close();
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
    Object.defineProperty(globalThis, "document", { configurable: true, value: previousDocument });
    Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: previousHTMLElement });
    Object.defineProperty(globalThis, "Node", { configurable: true, value: previousNode });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: previousNavigator });
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      previousActEnvironment;
  }
});

test("useChatLayoutPresentation は初期設定前の同値 priority 操作も一度だけ保存する", async () => {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>");
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;

  const priorityChanges: ChatLayoutPriority[] = [];
  let latestState: ReturnType<typeof useChatLayoutPresentation> | null = null;
  const Harness = ({ initialPriority }: { initialPriority: ChatLayoutPriority | null }) => {
    latestState = useChatLayoutPresentation({
      initialHeader: "hidden",
      initialActionDock: "compact",
      initialPriority,
      onPriorityChange: (value) => priorityChanges.push(value),
    });
    return React.createElement("output", null, latestState.layoutPriority);
  };
  const root = createRoot(dom.window.document.getElementById("root") as HTMLElement);

  try {
    await act(async () => root.render(React.createElement(Harness, { initialPriority: null })));
    await act(async () => latestState?.setLayoutPriority("side-pane-first"));
    await act(async () => latestState?.setLayoutPriority("side-pane-first"));
    await act(async () => root.render(React.createElement(Harness, { initialPriority: "dock-first" })));

    assert.equal(latestState?.layoutPriority, "side-pane-first");
    assert.deepEqual(priorityChanges, ["side-pane-first"]);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
    Object.defineProperty(globalThis, "document", { configurable: true, value: previousDocument });
    globalThis.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }
});
