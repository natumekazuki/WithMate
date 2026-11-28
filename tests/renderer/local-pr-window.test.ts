import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { createServer } from "vite";
import type { LocalPrDetail, LocalPrWindowApi } from "../../src-shared/local-pr/local-pr-contract.js";

/** Both windows preserve reads on failure; owned labels and local dates do not rewrite source content. */
test("local PR labels, dates, and independent window refreshes retain their boundaries", async () => {
  const vite = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true },
    server: { middlewareMode: true },
    appType: "custom",
  });
  const dom = new JSDOM("<!doctype html><div id='first'></div><div id='second'></div>", {
    url: "http://localhost",
  });
  Object.assign(dom.window.HTMLDialogElement.prototype, {
    showModal(this: HTMLDialogElement) { this.setAttribute("open", ""); },
    close(this: HTMLDialogElement) { this.removeAttribute("open"); },
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
  } as const;
  const sha = "a".repeat(40);
  const detail: LocalPrDetail = {
    id: "pr",
    title: "Review me",
    description: "### Review notes\n\n**lowercase USER text**",
    targetBranch: "refs/heads/main",
    sourceBranch: "refs/heads/my-feature",
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
  const merges: unknown[] = [];
  let finishMerge: (() => void) | undefined;
  let finishLog: (() => void) | undefined;
  const execute = async (operation: string, input: unknown) => {
    if (operation === "pr_merge") {
      merges.push(input);
      await new Promise<void>((resolve) => { finishMerge = resolve; });
      return { ok: true, data: detail };
    }
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
    if (operation === "pr_diff")
      return {
        ok: true,
        data: {
          beforeCommit: sha,
          afterCommit: sha,
          patch: null,
          files: [
            { path: "src/my-file.ts", previousPath: null, kind: "modified" },
          ],
        },
      };
    if (operation === "pr_ci_validate")
      return {
        ok: true,
        data: {
          headCommit: sha,
          path: ".withmate/ci.yml",
          state: "not_configured",
          source: null,
          error: null,
        },
      };
    if (operation === "pr_ci_list")
      return {
        ok: true,
        data: {
          runs: [
            "running",
            "succeeded",
            "failed",
            "canceled",
            "interrupted",
          ].map((state) => ({
            id: state,
            version: 1,
            headCommit: sha,
            targetCommit: sha,
            state,
            startedAt: "2026-11-27T19:00:00.000Z",
            finishedAt: null,
            exitCode: null,
            error: null,
          })),
        },
      };
    if (operation === "pr_ci_log") {
      if ((input as { runId?: string }).runId === "failed") {
        await new Promise<void>((resolve) => { finishLog = resolve; });
        return { ok: true, data: { log: "failed run log", nextOffset: 14, hasMore: false } };
      }
      return {
        ok: true,
        data: { log: "mixed CASE log", nextOffset: 14, hasMore: false },
      };
    }
    if (operation === "pr_branches")
      return { ok: true, data: { branches: [], head: null, headBranch: null } };
    return { ok: true, data: { sessions: [], hasMore: false } };
  };
  const api: LocalPrWindowApi = {
    execute: execute as unknown as LocalPrWindowApi["execute"],
    pickImage: async () => null,
    inspectImage: async () => { throw new Error("No image in this fixture."); },
    readImageChunk: async () => { throw new Error("No image in this fixture."); },
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
    assert.equal(first.querySelector(".local-pr-pr-meta .local-pr-status")?.textContent, "Open");
    assert.equal(first.querySelector(".local-pr-pr-meta code")?.textContent, "my-feature → main");
    assert.ok(first.querySelector("[title='refs/heads/my-feature → refs/heads/main']"));
    assert.equal(first.querySelector(".local-pr-description h3")?.textContent, "Review notes");
    assert.equal(first.querySelector(".local-pr-description strong")?.textContent, "lowercase USER text");
    assert.match(first.textContent ?? "", /lowercase USER text/);
    const splitter = first.querySelector<HTMLButtonElement>("button[aria-label='Collapse Pull Request List']");
    assert.ok(splitter);
    assert.equal(splitter.getAttribute("aria-expanded"), "true");
    await act(async () => splitter.click());
    assert.equal(splitter.getAttribute("aria-expanded"), "false");
    assert.equal(splitter.getAttribute("aria-label"), "Expand Pull Request List");
    assert.equal(first.querySelector<HTMLElement>("#local-pr-list")?.hidden, true);
    assert.match(first.querySelector("main")?.textContent ?? "", /lowercase USER text/);
    await act(async () => splitter.click());
    assert.equal(first.querySelector<HTMLElement>("#local-pr-list")?.hidden, false);
    assert.equal(first.querySelector(".local-pr-list-item[aria-current='true'] strong")?.textContent, "Review me");
    const button = (name: string) => {
      const found = Array.from(first.querySelectorAll("button")).find(
        (item) => item.textContent?.trim() === name,
      );
      assert.ok(found, name);
      return found;
    };
    await act(async () => {
      button("Changes").click();
    });
    assert.match(first.textContent ?? "", /src\/my-file\.ts\s*Modified/);
    await act(async () => button("Send to Agent").click());
    assert.equal(first.querySelectorAll("dialog[open]").length, 1);
    await act(async () => button("Cancel").click());
    assert.equal(first.querySelectorAll("dialog").length, 0);
    await act(async () => {
      button("Checks").click();
    });
    assert.match(first.textContent ?? "", /Definition: Not Configured/);
    const formatted = new Intl.DateTimeFormat("en", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date("2026-11-27T19:00:00.000Z"));
    const runButton = Array.from(first.querySelectorAll("button")).find(
      (item) => item.textContent?.includes("Succeeded"),
    );
    assert.ok(runButton);
    for (const status of [
      "Running",
      "Succeeded",
      "Failed",
      "Canceled",
      "Interrupted",
    ]) {
      assert.ok(
        Array.from(first.querySelectorAll("button")).some((item) =>
          item.textContent?.includes(status),
        ),
        status,
      );
    }
    assert.ok(runButton.textContent?.includes(formatted));
    await act(async () => {
      runButton.click();
    });
    assert.equal(
      first.querySelector("pre[aria-label='CI Log']")?.textContent?.trim(),
      "mixed CASE log",
    );
    const failedRun = Array.from(first.querySelectorAll("button")).find((item) => item.textContent?.includes("Failed"));
    assert.ok(failedRun);
    await act(async () => failedRun.click());
    const log = first.querySelector("pre[aria-label='CI Log']");
    assert.equal(log?.textContent, "");
    assert.equal(log?.getAttribute("aria-busy"), "true");
    assert.ok(finishLog);
    await act(async () => finishLog?.());
    assert.equal(log?.textContent, "failed run log");
    assert.equal(log?.getAttribute("aria-busy"), "false");
    fail = true;
    await act(async () => {
      listeners.forEach((listener) => listener());
    });
    assert.equal(reads, 4);
    for (const container of [first, second]) {
      assert.ok(
        container.querySelector("h2")?.textContent?.includes("Review me"),
      );
      assert.ok(container.querySelector("button[aria-label='Read Error Details']"));
      assert.ok(Array.from(container.querySelectorAll("button")).some((item) => item.textContent === "Retry"));
    }
    await act(async () => first.querySelector<HTMLButtonElement>("button[aria-label='Read Error Details']")?.click());
    assert.match(dom.window.document.querySelector("[role='dialog']")?.textContent ?? "", /Read failed/);
    await act(async () => {
      dom.window.document.querySelector("[role='dialog']")?.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    assert.equal(dom.window.document.querySelector("[role='dialog']"), null);
    assert.equal(dom.window.document.activeElement?.getAttribute("aria-label"), "Read Error Details");
    fail = false;
    await act(async () => {
      dom.window.dispatchEvent(new dom.window.Event("focus"));
    });
    assert.equal(reads, 6);
    assert.doesNotMatch(first.textContent ?? "", /Read failed/);
    const reload = first.querySelector<HTMLButtonElement>("button[aria-label='Reload Pull Requests']");
    assert.ok(reload);
    await act(async () => {
      reload.click();
    });
    assert.equal(reads, 7);

    await act(async () => button("Overview").click());
    assert.equal(button("Merge").disabled, true);
    detail.approval = {
      prId: detail.id,
      version: 1,
      headCommit: sha,
      targetCommit: sha,
      approvedAt: "2026-11-27T19:00:00.000Z",
    };
    await act(async () => {
      listeners.forEach((listener) => listener());
    });
    assert.equal(button("Merge").disabled, false);
    const merge = button("Merge");
    await act(async () => merge.click());
    assert.equal(merge.getAttribute("aria-busy"), "true");
    assert.ok(merge.disabled);
    assert.ok(merge.querySelector(".button-content-spinner"));
    assert.equal(button("Approve").getAttribute("aria-busy"), "false");
    assert.ok(finishMerge);
    await act(async () => finishMerge?.());
    assert.equal(merge.getAttribute("aria-busy"), "false");
    assert.deepEqual(merges, [{ prId: detail.id, version: 1, headCommit: sha, targetCommit: sha }]);
    assert.doesNotMatch(first.textContent ?? "", /Confirm Merge/);
    detail.state = "merged";
    detail.currentTargetCommit = detail.mergedCommit = "b".repeat(40);
    await act(async () => {
      listeners.forEach((listener) => listener());
    });
    assert.match(first.textContent ?? "", /Merged/);
    assert.doesNotMatch(first.textContent ?? "", /Target Branch Has Changed/);
  } finally {
    await act(async () => roots.forEach((root) => root.unmount()));
    await vite.close();
    dom.window.close();
    Object.assign(globalThis, previous);
  }
});
