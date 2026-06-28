import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { MemoryV6ReviewScreen } from "../../src/memory-v6/MemoryV6ReviewScreen.js";
import type {
  MemoryV6ReviewApi,
  MemoryV6ReviewSearchHit,
  MemoryV6ReviewSearchResult,
} from "../../src/memory-v6/memory-review-state.js";
import type { MemoryV6ReviewSearchRequest } from "../../src/memory-v6/memory-contract.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function createHit(id: string, title: string): MemoryV6ReviewSearchHit {
  return {
    id,
    kind: "note",
    title,
    preview: `${title} preview`,
    owner: { type: "project", id: "WithMate" },
    scope: { type: "project", id: "WithMate" },
    tags: [],
    sourceSessionId: null,
    sourceProviderId: "codex",
    updatedAt: "2026-06-27T00:00:00.000Z",
  };
}

async function flushEffects() {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

test("MemoryV6ReviewScreen は nextCursor がある場合に Load more で次 page を append する", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
    url: "https://withmate.local/?mode=memory-review",
  });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousHTMLElement = globalThis.HTMLElement;

  Object.defineProperty(globalThis, "window", { value: dom.window, configurable: true });
  Object.defineProperty(globalThis, "document", { value: dom.window.document, configurable: true });
  Object.defineProperty(globalThis, "HTMLElement", { value: dom.window.HTMLElement, configurable: true });

  const rootElement = dom.window.document.getElementById("root");
  assert.ok(rootElement);
  let root: Root | null = null;
  const requests: MemoryV6ReviewSearchRequest[] = [];
  const pages: MemoryV6ReviewSearchResult[] = [
    { items: [createHit("entry-1", "First entry")], nextCursor: "cursor-1" },
    { items: [createHit("entry-2", "Second entry")] },
  ];

  const api: MemoryV6ReviewApi = {
    async searchMemoryV6Entries(request) {
      requests.push(request);
      return pages.shift() ?? { items: [] };
    },
    async getMemoryV6Entry() {
      return null;
    },
    async forgetMemoryV6Entry() {
      return { entryId: "entry-1", status: "forgotten", reason: "user_request" };
    },
  };

  try {
    await act(async () => {
      root = createRoot(rootElement);
      root.render(<MemoryV6ReviewScreen homePageClassName="home-page" getApi={() => api} />);
    });
    await flushEffects();

    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.cursor, undefined);
    assert.match(rootElement.textContent ?? "", /First entry/);
    assert.doesNotMatch(rootElement.textContent ?? "", /Second entry/);

    const loadMoreButton = Array.from(rootElement.querySelectorAll("button")).find((button) =>
      button.textContent?.trim() === "Load more"
    );
    assert.ok(loadMoreButton);

    await act(async () => {
      loadMoreButton.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
    await flushEffects();

    assert.equal(requests.length, 2);
    assert.equal(requests[1]?.cursor, "cursor-1");
    assert.match(rootElement.textContent ?? "", /First entry/);
    assert.match(rootElement.textContent ?? "", /Second entry/);
    assert.equal(
      Array.from(rootElement.querySelectorAll("button")).some((button) => button.textContent?.trim() === "Load more"),
      false,
    );
  } finally {
    await act(async () => {
      root?.unmount();
    });
    Object.defineProperty(globalThis, "window", { value: previousWindow, configurable: true });
    Object.defineProperty(globalThis, "document", { value: previousDocument, configurable: true });
    Object.defineProperty(globalThis, "HTMLElement", { value: previousHTMLElement, configurable: true });
  }
});
