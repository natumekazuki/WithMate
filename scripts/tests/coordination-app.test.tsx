import assert from "node:assert/strict";
import test from "node:test";

import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import CoordinationApp from "../../src/CoordinationApp.js";
import type { HomeSessionSummary } from "../../src/session-state.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SESSION: HomeSessionSummary = {
  id: "session-1",
  taskTitle: "Coordination Event APIを設計する",
  status: "idle",
  updatedAt: "2026-08-22T12:00:00.000Z",
  isPinned: false,
  workspaceLabel: "WithMate",
  workspacePath: "C:\\workspace",
  sessionKind: "default",
  accessMode: "read-write",
  sourceSchemaVersion: 6,
  characterId: "character-1",
  character: "非表示のCharacter名",
  characterIconPath: "",
  characterThemeColors: { main: "#4f46e5", sub: "#818cf8" },
  runState: "idle",
};

test("Coordination Windowは全Session・全状態を既定にしてSession titleを主表示する", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
    pretendToBeVisual: true,
  });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousHTMLElement = globalThis.HTMLElement;
  const previousNode = globalThis.Node;
  Object.assign(dom.window.HTMLElement.prototype, {
    attachEvent() {},
    detachEvent() {},
  });
  const eventQueries: unknown[] = [];
  const sessionQueries: unknown[] = [];
  const api = {
    listCoordinationEvents(input: unknown) {
      eventQueries.push(input);
      return Promise.resolve({
        items: [{
          sequence: 2,
          eventId: "event-1",
          actorSessionId: SESSION.id,
          sessionRole: "standalone",
          kind: "progress",
          state: "recorded",
          summary: "設計を更新した",
          createdAt: "2026-08-22T12:00:00.000Z",
        }],
      });
    },
    listSessionSummaryPage(input: unknown) {
      sessionQueries.push(input);
      return Promise.resolve({ entries: [SESSION], nextCursor: null, hasMore: false });
    },
    subscribeCoordinationEventsChanged() { return () => undefined; },
    openHomeWindow() { return Promise.resolve(); },
  };
  Object.defineProperty(dom.window, "withmate", { value: api, configurable: true });
  Object.defineProperty(globalThis, "window", { value: dom.window, configurable: true });
  Object.defineProperty(globalThis, "document", { value: dom.window.document, configurable: true });
  Object.defineProperty(globalThis, "HTMLElement", { value: dom.window.HTMLElement, configurable: true });
  Object.defineProperty(globalThis, "Node", { value: dom.window.Node, configurable: true });
  const rootElement = dom.window.document.getElementById("root");
  assert.ok(rootElement);
  let root: Root | null = null;

  try {
    await act(async () => {
      root = createRoot(rootElement);
      root.render(<CoordinationApp />);
      await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
      await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
    });

    assert.deepEqual(eventQueries, [{ limit: 50 }]);
    assert.deepEqual(sessionQueries[0], { scope: "open", sessionIds: [SESSION.id], limit: 1 });
    assert.match(rootElement.textContent ?? "", /すべてのSession/);
    assert.match(rootElement.textContent ?? "", /Coordination Event APIを設計する/);
    assert.doesNotMatch(rootElement.textContent ?? "", /非表示のCharacter名/);

    const picker = rootElement.querySelector<HTMLButtonElement>(".coordination-session-trigger");
    assert.ok(picker);
    await act(async () => {
      picker.click();
      await new Promise((resolve) => dom.window.setTimeout(resolve, 180));
    });
    assert.deepEqual(sessionQueries.at(-1), { scope: "recent", searchText: "", limit: 50 });
  } finally {
    await act(async () => root?.unmount());
    Object.defineProperty(globalThis, "window", { value: previousWindow, configurable: true });
    Object.defineProperty(globalThis, "document", { value: previousDocument, configurable: true });
    Object.defineProperty(globalThis, "HTMLElement", { value: previousHTMLElement, configurable: true });
    Object.defineProperty(globalThis, "Node", { value: previousNode, configurable: true });
    dom.window.close();
  }
});
