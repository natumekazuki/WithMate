import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { useSessionSidePanes } from "../../src/session-chat-layout-hooks.js";
import type { SessionSidePane } from "../../src/session-side-pane.js";

function dispatchPointerEvent(
  dom: JSDOM,
  target: EventTarget,
  type: "pointerdown" | "pointermove" | "pointerup",
  clientX: number,
): MouseEvent {
  const event = new dom.window.MouseEvent(type, {
    bubbles: true,
    button: 0,
    cancelable: true,
    clientX,
  });
  Object.defineProperty(event, "pointerId", { configurable: true, value: 1 });
  target.dispatchEvent(event);
  return event;
}

test("useSessionSidePanes は保存済み状態を一度だけ反映し、左右ペインを排他的に切り替える", async () => {
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
  const sidePaneChanges: SessionSidePane[] = [];

  function Harness({ initialSidePane }: { initialSidePane: SessionSidePane | null }) {
    const {
      sessionWorkbenchRef,
      sessionWorkbenchStyle,
      activeSidePane,
      isContextRailVisible,
      isContextRailResizing,
      handleStartContextRailResize,
      handleToggleContextRailVisibility,
      handleToggleFilesPaneVisibility,
    } = useSessionSidePanes({
      ownerKey: "session-1",
      initialSidePane,
      onSidePaneChange: (sidePane) => sidePaneChanges.push(sidePane),
    });

    return React.createElement(
      "div",
      {
        ref: sessionWorkbenchRef,
        style: sessionWorkbenchStyle,
        "data-testid": "workbench",
      },
      React.createElement(
        "button",
        {
          type: "button",
          onPointerDown: handleStartContextRailResize,
          onClick: handleToggleContextRailVisibility,
          "data-testid": "splitter",
        },
        "toggle",
      ),
      React.createElement(
        "button",
        {
          type: "button",
          onClick: handleToggleFilesPaneVisibility,
          "data-testid": "files-toggle",
        },
        "files",
      ),
      React.createElement(
        "output",
        { "data-testid": "visibility" },
        isContextRailVisible ? "visible" : "hidden",
      ),
      React.createElement("output", { "data-testid": "active-pane" }, activeSidePane),
      React.createElement(
        "output",
        { "data-testid": "resizing" },
        isContextRailResizing ? "resizing" : "idle",
      ),
    );
  }

  try {
    await act(async () => {
      root = createRoot(dom.window.document.getElementById("root") as HTMLElement);
      root.render(React.createElement(Harness, { initialSidePane: null }));
    });

    const workbench = dom.window.document.querySelector<HTMLElement>("[data-testid=\"workbench\"]");
    const splitter = dom.window.document.querySelector<HTMLButtonElement>("[data-testid=\"splitter\"]");
    const filesToggle = dom.window.document.querySelector<HTMLButtonElement>("[data-testid=\"files-toggle\"]");
    const visibility = dom.window.document.querySelector<HTMLOutputElement>("[data-testid=\"visibility\"]");
    const activePane = dom.window.document.querySelector<HTMLOutputElement>("[data-testid=\"active-pane\"]");
    const resizing = dom.window.document.querySelector<HTMLOutputElement>("[data-testid=\"resizing\"]");
    assert.ok(workbench);
    assert.ok(splitter);
    assert.ok(filesToggle);
    assert.ok(visibility);
    assert.ok(activePane);
    assert.ok(resizing);
    assert.equal(visibility.textContent, "hidden");

    await act(async () => {
      root?.render(React.createElement(Harness, { initialSidePane: "context" }));
    });
    assert.equal(visibility.textContent, "visible");

    let viewportWidth = 1600;
    let workbenchWidth = 1600;
    Object.defineProperty(dom.window, "innerWidth", {
      configurable: true,
      get: () => viewportWidth,
    });
    workbench.getBoundingClientRect = () => ({
      x: 0,
      y: 0,
      top: 0,
      right: workbenchWidth,
      bottom: 800,
      left: 0,
      width: workbenchWidth,
      height: 800,
      toJSON: () => ({}),
    });

    await act(async () => dispatchPointerEvent(dom, splitter, "pointerdown", 1180));
    await act(async () => dispatchPointerEvent(dom, dom.window, "pointerup", 1180));
    await act(async () => splitter.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
    assert.equal(visibility.textContent, "hidden");

    await act(async () => dispatchPointerEvent(dom, splitter, "pointerdown", 1180));
    await act(async () => dispatchPointerEvent(dom, dom.window, "pointerup", 1180));
    await act(async () => splitter.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
    assert.equal(visibility.textContent, "visible");

    await act(async () => {
      root?.render(React.createElement(Harness, { initialSidePane: "none" }));
    });
    assert.equal(visibility.textContent, "visible");

    await act(async () => filesToggle.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
    assert.equal(activePane.textContent, "files");
    assert.equal(visibility.textContent, "hidden");
    await act(async () => splitter.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
    assert.equal(activePane.textContent, "context");
    assert.equal(visibility.textContent, "visible");

    viewportWidth = 1200;
    workbenchWidth = 1200;
    let narrowPointerDown!: MouseEvent;
    await act(async () => {
      narrowPointerDown = dispatchPointerEvent(dom, splitter, "pointerdown", 780);
    });
    assert.equal(resizing.textContent, "idle");
    assert.equal(narrowPointerDown.defaultPrevented, false);
    assert.equal(dom.window.document.body.style.cursor, "");
    assert.equal(dom.window.document.body.style.userSelect, "");
    await act(async () => dispatchPointerEvent(dom, dom.window, "pointermove", 740));
    await act(async () => dispatchPointerEvent(dom, dom.window, "pointerup", 740));
    await act(async () => splitter.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
    assert.equal(visibility.textContent, "hidden");

    await act(async () => dispatchPointerEvent(dom, splitter, "pointerdown", 780));
    await act(async () => dispatchPointerEvent(dom, dom.window, "pointerup", 780));
    await act(async () => splitter.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
    assert.equal(visibility.textContent, "visible");

    viewportWidth = 1400;
    workbenchWidth = 1376;
    let boundaryPointerDown!: MouseEvent;
    await act(async () => {
      boundaryPointerDown = dispatchPointerEvent(dom, splitter, "pointerdown", 956);
    });
    assert.equal(resizing.textContent, "resizing");
    assert.equal(boundaryPointerDown.defaultPrevented, true);
    assert.equal(dom.window.document.body.style.cursor, "col-resize");
    assert.equal(dom.window.document.body.style.userSelect, "none");
    await act(async () => dispatchPointerEvent(dom, dom.window, "pointermove", 916));
    await act(async () => dispatchPointerEvent(dom, dom.window, "pointerup", 916));
    await act(async () => splitter.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
    assert.equal(visibility.textContent, "visible");
    assert.equal(workbench.style.getPropertyValue("--session-context-rail-width"), "460px");

    viewportWidth = 1600;
    workbenchWidth = 1600;
    await act(async () => dispatchPointerEvent(dom, splitter, "pointerdown", 1180));
    assert.equal(resizing.textContent, "resizing");
    await act(async () => dispatchPointerEvent(dom, dom.window, "pointermove", 1140));
    await act(async () => dispatchPointerEvent(dom, dom.window, "pointerup", 1140));
    await act(async () => splitter.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));

    assert.equal(visibility.textContent, "visible");
    assert.equal(workbench.style.getPropertyValue("--session-context-rail-width"), "460px");
    assert.deepEqual(sidePaneChanges, ["none", "context", "files", "context", "none", "context"]);
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
