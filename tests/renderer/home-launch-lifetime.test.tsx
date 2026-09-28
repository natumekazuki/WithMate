import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import type { Root } from "react-dom/client";

import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";
import { buildNewSession, projectHomeSessionSummary, type CreateSessionRequest, type Session } from "../../src-shared/session/session-state.js";
import { createDefaultAppSettings } from "../../src-shared/settings/provider-settings-state.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function button(container: Element, label: string) {
  const result = Array.from(container.querySelectorAll("button")).find((entry) =>
    entry.textContent?.trim() === label || (label === "Start" && entry.getAttribute("aria-label") === "Starting session")
  );
  assert.ok(result, `${label} button`);
  return result;
}

// @test-value v2
// kind = "invariant"
// claim = "Cancelした開始要求の成功・失敗は再表示した入力とfocus、新しい試行のfeedbackとbusyを保持し、保存結果はHomeから再開できる"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md New Session dialog / GitHub Issue #753" }
// fault = "古い完了が新しいdialogを閉じる、feedbackやbusyを書き換える、二重作成を許す、作成済みSessionを失うか無断でWindowを開く"
// observable = "HomeAppのtitle・選択・focus・dialog表示、Startのdisabled/busy、作成要求数、結果通知とRecent Sessionsから開くID"
// observation_boundary = "component-behavior"
// scope = "HomeApp Start→Cancel→再表示と遅延したSession作成の完了"
// lifecycle = "permanent"
// impact = "入力喪失、別試行の誤通知、二重Session作成とfocusの横取りを防ぎ、作成済みデータへの導線を保つ"
// distinction = "同期的なaction testや型検査では検出できないReact再描画をまたぐ要求の所属とUI配線を、制御したPromiseだけで低コストに確認する"
// @end-test-value
test("閉じた開始試行の完了を次のNew Sessionから分離する", async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "https://withmate.local/" });
  const previous = { window: globalThis.window, document: globalThis.document, HTMLElement: globalThis.HTMLElement };
  Object.defineProperty(globalThis, "window", { value: dom.window, configurable: true });
  Object.defineProperty(globalThis, "document", { value: dom.window.document, configurable: true });
  Object.defineProperty(globalThis, "HTMLElement", { value: dom.window.HTMLElement, configurable: true });

  const requests: Array<{ input: CreateSessionRequest; response: ReturnType<typeof deferred<Session>> }> = [];
  const saved: Session[] = [];
  const opened: string[] = [];
  let windowResponse: Promise<void> = Promise.resolve();
  const api: Partial<WithMateWindowApi> = {
    listCharacters: async () => [{
      id: "mia", name: "Mia", description: "", iconFilePath: "", state: "active",
      theme: { main: "#6f8cff", sub: "#6fb8c7" }, createdAt: "", updatedAt: "", archivedAt: null,
    }],
    getMateState: async () => "not_created",
    getAppSettings: async () => createDefaultAppSettings(),
    subscribeAppSettings: () => () => {},
    getModelCatalog: async () => ({ revision: 1, providers: [{
      id: "codex", label: "Codex", defaultModelId: "gpt-5.4", defaultReasoningEffort: "high",
      models: [{ id: "gpt-5.4", label: "GPT-5.4", reasoningEfforts: ["high"] }],
    }] }),
    listSessionSummaryPage: async () => ({ entries: saved.map(projectHomeSessionSummary), hasMore: false, nextCursor: null }),
    listSessionCharacterUsage: async () => [],
    subscribeSessionInvalidation: () => () => {},
    listOpenSessionWindowIds: async () => [],
    subscribeOpenSessionWindowIds: () => () => {},
    getSessionWindowRestoreSet: async () => [],
    subscribeSessionWindowRestoreSet: () => () => {},
    listOpenAuxiliarySessionSummaries: async () => [],
    subscribeLiveSessionRun: () => () => {},
    createSession: (input) => {
      const response = deferred<Session>();
      requests.push({ input, response });
      return response.promise;
    },
    openSession: async (id) => { opened.push(id); await windowResponse; },
  };
  dom.window.withmate = api as WithMateWindowApi;
  const container = dom.window.document.getElementById("root")!;
  let root: Root | null = null;
  const dialog = () => {
    const element = container.querySelector('[role="dialog"][aria-label="New Session"]');
    assert.ok(element);
    return element;
  };
  const newSession = () => container.querySelector<HTMLButtonElement>('[aria-label="New session"]')!;
  const mia = () => dialog().querySelector<HTMLButtonElement>('[role="radiogroup"][aria-label="Character"] button:last-child')!;
  const openDraft = async (title: string) => {
    newSession().focus();
    await act(async () => newSession().click());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const input = dialog().querySelector<HTMLInputElement>("#launch-session-title")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, title);
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      button(dialog(), "Session Folder").click();
      mia().click();
    });
    input.focus();
    return input;
  };
  const start = async () => {
    await act(async () => {
      const startButton = button(dialog(), "Start");
      startButton.click();
      startButton.click();
    });
    return requests.at(-1)!;
  };
  const succeed = (request: typeof requests[number]) => {
    const session = buildNewSession({
      ...request.input, id: `saved-${saved.length}`, workspaceLabel: "Session Folder",
      workspacePath: "C:/sessions/test", branch: "", approvalMode: "on-request",
    });
    saved.push(session);
    request.response.resolve(session);
    return session;
  };

  try {
    const { createRoot } = await import("react-dom/client");
    const { default: HomeApp } = await import("../../src/home/HomeApp.js");
    await act(async () => { root = createRoot(container); root.render(<HomeApp />); });

    for (const outcome of ["success", "error"] as const) {
      for (const nextState of ["editing", "starting", "failed"] as const) {
        const label = `${outcome}/${nextState}`;
        const requestCount = requests.length;
        await openDraft(`Old ${label}`);
        const oldRequest = await start();
        assert.equal(requests.length, requestCount + 1, "同じ描画内の二重Startを拒否する");
        assert.equal(button(dialog(), "Start").getAttribute("aria-busy"), "true");
        await act(async () => button(dialog(), "Cancel").click());
        assert.ok(dom.window.document.activeElement === newSession(), "Cancel後に起点へfocusを戻す");
        const title = await openDraft(`New ${label}`);
        const nextRequest = nextState === "editing" ? null : await start();
        if (nextState === "failed") {
          await act(async () => nextRequest!.response.reject(new Error("New attempt failed")));
        }
        title.focus();
        const newDialog = dialog();
        const beforeText = newDialog.textContent;
        const beforeRequests = requests.length;
        await act(async () => {
          if (outcome === "success") succeed(oldRequest);
          else oldRequest.response.reject(new Error("Old attempt failed"));
        });
        assert.ok(dialog() === newDialog, label);
        assert.equal(title.value, `New ${label}`, label);
        assert.equal(dialog().textContent, beforeText, label);
        assert.ok(dom.window.document.activeElement === title, label);
        assert.equal(mia().getAttribute("aria-checked"), "true", label);
        assert.equal(button(dialog(), "Session Folder").getAttribute("aria-pressed"), "true", label);
        assert.equal(button(dialog(), "Codex").getAttribute("aria-selected"), "true", label);
        assert.equal(opened.length, 0, label);
        assert.equal(requests.length, beforeRequests, label);
        assert.equal(button(dialog(), "Start").disabled, nextState === "starting", label);
        if (nextState === "starting") {
          assert.equal(button(dialog(), "Start").getAttribute("aria-busy"), "true", label);
          await act(async () => button(dialog(), "Start").click());
          assert.equal(requests.length, beforeRequests, "古いfinallyで二重開始防止を解除しない");
          await act(async () => nextRequest!.response.reject(new Error("New attempt failed")));
        }
        if (nextState !== "editing") assert.match(dialog().textContent ?? "", /New attempt failed/);
        await act(async () => button(dialog(), "Cancel").click());
        const result = Array.from(container.querySelectorAll(".home-session-list-feedback")).find((entry) =>
          entry.textContent?.includes(`Old ${label}`)
        );
        assert.ok(result, label);
        assert.match(result.textContent ?? "", outcome === "success" ? /Session created/ : /Could not confirm session creation/);
        if (outcome === "error") assert.match(result.textContent ?? "", /Old attempt failed/);
        assert.ok(result.querySelector('[role="status"]'));
        await act(async () => button(result, "Dismiss").click());
        assert.equal(result.isConnected, false);
      }
    }

    const savedSession = saved[0]!;
    const row = Array.from(container.querySelectorAll<HTMLButtonElement>(".home-session-card-open"))
      .find((entry) => entry.textContent?.includes(savedSession.taskTitle));
    assert.ok(row, "閉じた要求で作成したSessionもRecent Sessionsから再開できる");
    await act(async () => row.click());
    assert.deepEqual(opened, [savedSession.id]);

    const delayedWindow = deferred<void>();
    windowResponse = delayedWindow.promise;
    await openDraft("Saved before window failure");
    const opening = await start();
    await act(async () => { succeed(opening); });
    assert.equal(container.querySelector('[role="dialog"]'), null);
    const nextTitle = await openDraft("New draft after success");
    await act(async () => delayedWindow.reject(new Error("Window unavailable")));
    assert.equal(nextTitle.value, "New draft after success");
    assert.ok(dom.window.document.activeElement === nextTitle);
    assert.doesNotMatch(dialog().textContent ?? "", /Window unavailable/);
    await act(async () => button(dialog(), "Cancel").click());
    assert.match(container.textContent ?? "", /Session created, but its window could not be opened/);
    assert.match(container.textContent ?? "", /Window unavailable/);
  } finally {
    await act(async () => root?.unmount());
    dom.window.close();
    for (const [key, value] of Object.entries(previous)) Object.defineProperty(globalThis, key, { value, configurable: true });
  }
});
