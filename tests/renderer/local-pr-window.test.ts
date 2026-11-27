import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { createServer } from "vite";
import type { LocalPrWindowApi } from "../../src-shared/local-pr/local-pr-contract.js";

/** Each window refreshes independently and retains its selected PR on a read failure. */
test("changed notification refreshes both windows without discarding failed reads", async () => {
  const vite = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true },
    server: { middlewareMode: true },
    appType: "custom",
  });
  const dom = new JSDOM("<div id='first'></div><div id='second'></div>", {
    url: "http://localhost",
  });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
  };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const author = {
    kind: "main",
    sessionId: "fixture",
    incarnationId: "fixture",
  };
  const sha = "a".repeat(40);
  const detail = {
    id: "pr",
    title: "Review me",
    description: "",
    targetBranch: "refs/heads/main",
    sourceBranch: null,
    createdBy: author,
    createdAt: "",
    updatedAt: "",
    state: "open",
    latestVersion: 1,
    mergedCommit: null,
    currentTargetCommit: sha,
    approval: null,
    comments: [],
    versions: [
      {
        version: 1,
        headCommit: sha,
        targetCommit: sha,
        mergeBaseCommit: sha,
        submittedAt: "",
        submittedBy: author,
      },
    ],
  };
  const listeners = new Set<() => void>();
  let fail = false;
  let reads = 0;
  const execute = async (operation: string) => {
    if (operation === "pr_get") reads += 1;
    if (operation === "pr_get" && fail)
      return {
        ok: false,
        code: "READ",
        message: "Read failed",
        effect: "none",
      };
    if (operation === "pr_list")
      return { ok: true, data: { entries: [detail], hasMore: false } };
    if (operation === "pr_get") return { ok: true, data: detail };
    if (operation === "pr_branches")
      return { ok: true, data: { branches: [], head: null, headBranch: null } };
    return { ok: true, data: { sessions: [], hasMore: false } };
  };
  const api: LocalPrWindowApi = {
    execute: execute as unknown as LocalPrWindowApi["execute"],
    subscribeChanged(callback) {
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    },
  };
  const first = dom.window.document.getElementById("first");
  const second = dom.window.document.getElementById("second");
  assert.ok(first);
  assert.ok(second);
  const roots = [createRoot(first), createRoot(second)];
  try {
    const { default: App } = await vite.ssrLoadModule(
      "/src/local-pr/LocalPrWindowApp.tsx",
    );
    await act(async () => {
      roots.forEach((root) => root.render(React.createElement(App, { api })));
    });
    const items = Array.from(
      dom.window.document.querySelectorAll("button"),
    ).filter((button) => button.textContent?.includes("Review me"));
    assert.equal(items.length, 2);
    await act(async () => {
      items.forEach((item) => item.click());
    });
    assert.equal(reads, 2);
    fail = true;
    await act(async () => {
      listeners.forEach((listener) => listener());
    });
    assert.equal(reads, 4);
    for (const container of [first, second]) {
      assert.ok(
        container.querySelector("h2")?.textContent?.includes("Review me"),
      );
      assert.match(container.textContent ?? "", /Read failed/);
    }
    fail = false;
    await act(async () => {
      dom.window.dispatchEvent(new dom.window.Event("focus"));
    });
    assert.equal(reads, 6);
    assert.doesNotMatch(first.textContent ?? "", /Read failed/);
    const reload = Array.from(first.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Reload"),
    );
    assert.ok(reload);
    await act(async () => {
      reload.click();
    });
    assert.equal(reads, 7);
  } finally {
    await act(async () => roots.forEach((root) => root.unmount()));
    await vite.close();
    dom.window.close();
    Object.assign(globalThis, previous);
  }
});
