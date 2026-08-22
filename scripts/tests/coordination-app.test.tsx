import assert from "node:assert/strict";
import test from "node:test";

import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import CoordinationApp from "../../src/CoordinationApp.js";
import type { CoordinationEvent } from "../../src/coordination-event.js";
import type { HomeSessionSummary } from "../../src/session-state.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class TestIntersectionObserver implements IntersectionObserver {
  static instances: TestIntersectionObserver[] = [];

  readonly root: Element | Document | null;
  readonly rootMargin: string;
  readonly thresholds = [0];

  constructor(
    private readonly callback: IntersectionObserverCallback,
    options: IntersectionObserverInit = {},
  ) {
    this.root = options.root ?? null;
    this.rootMargin = options.rootMargin ?? "0px";
    TestIntersectionObserver.instances.push(this);
  }

  disconnect() {}
  observe() {}
  unobserve() {}
  takeRecords(): IntersectionObserverEntry[] { return []; }

  trigger() {
    this.callback([{ isIntersecting: true } as IntersectionObserverEntry], this);
  }
}

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

test("Coordination Windowは必要なfilterだけを置き、未使用の回答を変更できる", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
    pretendToBeVisual: true,
  });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousHTMLElement = globalThis.HTMLElement;
  const previousNode = globalThis.Node;
  const previousIntersectionObserver = globalThis.IntersectionObserver;
  Object.assign(dom.window.HTMLElement.prototype, {
    attachEvent() {},
    detachEvent() {},
  });
  const eventQueries: unknown[] = [];
  const sessionQueries: unknown[] = [];
  const decision: CoordinationEvent = {
    sequence: 2,
    eventId: "event-1",
    actorSessionId: SESSION.id,
    sessionRole: "standalone",
    roleContractRevision: 1,
    rootSessionId: SESSION.id,
    parentSessionId: null,
    delegationDepth: 0,
    kind: "user_decision_required",
    state: "resolved",
    summary: "本番切替の方式を選んでください",
    payload: { summary: "本番切替の方式を選んでください" },
    executionId: null,
    targetSessionId: null,
    correctedEventId: null,
    options: [{ id: "gradual", label: "段階切替" }, { id: "all", label: "一括切替" }],
    actions: [{
      sequence: 1,
      type: "resolved",
      actorType: "trusted_gui",
      actorSessionId: null,
      optionId: "gradual",
      note: null,
      relatedEventId: null,
      createdAt: "2026-08-22T12:00:00.000Z",
    }],
    createdAt: "2026-08-22T12:00:00.000Z",
  };
  const api = {
    listCoordinationEvents(input: unknown) {
      eventQueries.push(input);
      if ((input as { cursor?: string }).cursor) return Promise.resolve({ items: [] });
      return Promise.resolve({
        items: [{
          sequence: 2,
          eventId: "event-1",
          actorSessionId: SESSION.id,
          sessionRole: "standalone",
          kind: decision.kind,
          state: decision.state,
          summary: decision.summary,
          createdAt: "2026-08-22T12:00:00.000Z",
        }],
        nextCursor: "event-cursor",
      });
    },
    listSessionSummaryPage(input: unknown) {
      sessionQueries.push(input);
      const query = input as { scope?: string; cursor?: string };
      if (query.scope === "recent") {
        return Promise.resolve({
          entries: query.cursor ? [] : [SESSION],
          nextCursor: query.cursor ? null : "session-cursor",
          hasMore: !query.cursor,
        });
      }
      return Promise.resolve({ entries: [SESSION], nextCursor: null, hasMore: false });
    },
    getCoordinationEvent() { return Promise.resolve(decision); },
    resolveCoordinationEvent() { return Promise.resolve(decision); },
    subscribeCoordinationEventsChanged() { return () => undefined; },
  };
  Object.defineProperty(dom.window, "withmate", { value: api, configurable: true });
  Object.defineProperty(globalThis, "window", { value: dom.window, configurable: true });
  Object.defineProperty(globalThis, "document", { value: dom.window.document, configurable: true });
  Object.defineProperty(globalThis, "HTMLElement", { value: dom.window.HTMLElement, configurable: true });
  Object.defineProperty(globalThis, "Node", { value: dom.window.Node, configurable: true });
  Object.defineProperty(globalThis, "IntersectionObserver", { value: TestIntersectionObserver, configurable: true });
  TestIntersectionObserver.instances = [];
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
    assert.doesNotMatch(rootElement.textContent ?? "", /判断と進行状況|イベントを選択してください|Home/);

    const eventObserver = TestIntersectionObserver.instances.find(
      (observer) => observer.root instanceof dom.window.Element
        && observer.root.classList.contains("coordination-feed"),
    );
    assert.ok(eventObserver);
    await act(async () => {
      eventObserver.trigger();
      await Promise.resolve();
    });
    assert.deepEqual(eventQueries.at(-1), { limit: 50, cursor: "event-cursor" });

    const picker = rootElement.querySelector<HTMLButtonElement>(".coordination-session-trigger");
    assert.ok(picker);
    await act(async () => {
      picker.click();
      await new Promise((resolve) => dom.window.setTimeout(resolve, 180));
    });
    assert.deepEqual(sessionQueries.at(-1), { scope: "recent", searchText: "", limit: 50 });
    const sessionObserver = TestIntersectionObserver.instances.find(
      (observer) => observer.root instanceof dom.window.Element
        && observer.root.classList.contains("coordination-session-list"),
    );
    assert.ok(sessionObserver);
    await act(async () => {
      sessionObserver.trigger();
      await Promise.resolve();
    });
    assert.deepEqual(sessionQueries.at(-1), {
      scope: "recent", searchText: "", limit: 50, cursor: "session-cursor",
    });

    const eventRow = rootElement.querySelector<HTMLButtonElement>(".coordination-event-row");
    assert.ok(eventRow);
    await act(async () => {
      eventRow.click();
      await Promise.resolve();
    });
    assert.match(rootElement.textContent ?? "", /回答を変更/);
    assert.match(rootElement.textContent ?? "", /段階切替/);
    assert.doesNotMatch(rootElement.textContent ?? "", /使用済み/);

    decision.actions.push({
      sequence: 2,
      type: "consumed",
      actorType: "session",
      actorSessionId: SESSION.id,
      optionId: null,
      note: null,
      relatedEventId: null,
      createdAt: "2026-08-22T12:01:00.000Z",
    });
    await act(async () => {
      eventRow.click();
      await Promise.resolve();
    });
    assert.match(rootElement.textContent ?? "", /使用済み/);
    assert.equal(rootElement.querySelector(".coordination-decision-panel"), null);
  } finally {
    await act(async () => root?.unmount());
    Object.defineProperty(globalThis, "window", { value: previousWindow, configurable: true });
    Object.defineProperty(globalThis, "document", { value: previousDocument, configurable: true });
    Object.defineProperty(globalThis, "HTMLElement", { value: previousHTMLElement, configurable: true });
    Object.defineProperty(globalThis, "Node", { value: previousNode, configurable: true });
    Object.defineProperty(globalThis, "IntersectionObserver", {
      value: previousIntersectionObserver,
      configurable: true,
    });
    dom.window.close();
  }
});
