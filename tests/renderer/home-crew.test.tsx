import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

import type { AuxiliarySessionSummary } from "../../src-shared/auxiliary/auxiliary-session-state.js";
import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";
import { buildNewSession, projectHomeSessionSummary } from "../../src-shared/session/session-state.js";
import type { HomeCrewMember, HomeCrewPageResult } from "../../src-shared/window/home-crew-types.js";
import { HomeCrewPanel } from "../../src/home/HomeCrewPanel.js";
import { useHomeCrew } from "../../src/home/use-home-crew.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function member(
  id: string,
  options: Partial<HomeCrewMember> = {},
): HomeCrewMember {
  const session = buildNewSession({
    id, taskTitle: id, character: "Mia", characterId: "mia", characterIconPath: "",
    characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
    workspaceLabel: "Workspace", workspacePath: "C:\\workspace", branch: "", approvalMode: "on-request",
  });
  return {
    ...projectHomeSessionSummary(session),
    status: "idle", runState: "idle", incarnationId: `inc-${id}`, rootSessionId: id,
    parentSessionId: null, createdAt: "2026-10-01T00:00:00Z", isWindowOpen: false, ...options,
  };
}

function auxiliary(id: string, preview: string): AuxiliarySessionSummary {
  return {
    id, preview, parentSessionId: "middle", runState: "running", title: preview,
    provider: "codex", catalogRevision: 0, model: "", reasoningEffort: "", approvalMode: "on-request",
    codexSandboxMode: "workspace-write", codexSpeed: "standard", codexReviewer: "user",
    customAgentName: "", threadId: "", displayAfterMessageIndex: null,
    createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", hasUnreadResult: id === "aux-b",
  };
}

function page(entries: HomeCrewMember[], nextCursor: string | null = null): HomeCrewPageResult {
  return { entries, nextCursor, hasMore: nextCursor !== null, auxiliarySessions: [] };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function setup() {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://withmate.local/" });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  Object.defineProperty(globalThis, "window", { value: dom.window, configurable: true });
  Object.defineProperty(globalThis, "document", { value: dom.window.document, configurable: true });
  const element = dom.window.document.getElementById("root")!;
  const root = createRoot(element);
  return {
    dom, element, root,
    async dispose() {
      await act(async () => root.unmount());
      dom.window.close();
      Object.defineProperty(globalThis, "window", { value: previousWindow, configurable: true });
      Object.defineProperty(globalThis, "document", { value: previousDocument, configurable: true });
    },
  };
}

// @test-value v2
// kind = "contract"
// claim = "Crewは開いたMainを含むrootを保存順に載せ、closed Mainの枝・検索経路と独立したAux操作を保持し、状態集計とメニュー対象を本人またはAuxと混同しない"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#home-window の Crew（掲載、検索、集計、個別操作）" }
// fault = "閉じた祖先・葉を省く、検索展開が手動展開を上書きする、本人・Auxを子孫件数に足す、または操作を違う会話へ送る"
// observable = "表示titleと順序、展開の開閉、集計の内訳と合算数、open先とmenuのidentity、操作失敗のalert"
// observation_boundary = "component-behavior"
// scope = "HomeCrewPanelの保存階層・集計・検索・独立操作。実Window生成とnative menuは対象外"
// lifecycle = "permanent"
// impact = "閉じた枝を含め必要な会話に辿り、正しいMain/Auxiliaryを選択できる"
// distinction = "Monitorの状態別一覧や純粋projectionの検査では、検索解除・独立disclosure・incarnation付きmenu配送を観測できない"
// @end-test-value
test("Crewは閉じた階層と検索解除後の展開を保ち、対象別にMain/Auxとmenuを操作する", async () => {
  const { dom, element, root, dispose } = setup();
  const entries = [
    member("closed-leaf", { rootSessionId: "origin", parentSessionId: "middle", character: "Kite" }),
    member("origin", { runState: "running" }),
    member("new-root", { isWindowOpen: true, createdAt: "2026-11-01T00:00:00Z" }),
    member("last", { rootSessionId: "origin", parentSessionId: "origin", createdAt: "2026-10-03T00:00:00Z", cancellationState: "requested" }),
    member("middle", { rootSessionId: "origin", parentSessionId: "origin", createdAt: "2026-10-02T00:00:00Z", cancellationState: "terminating" }),
    member("open-leaf", { rootSessionId: "origin", parentSessionId: "middle", isWindowOpen: true, runState: "running", hasUnreadResult: true }),
    member("excluded", { runState: "running" }),
  ];
  const opens: Array<[string, string?]> = [];
  const menus: Parameters<WithMateWindowApi["showHomeCrewContextMenu"]>[0][] = [];
  const api: Partial<WithMateWindowApi> = {
    listHomeCrewPage: async () => ({ ...page(entries), auxiliarySessions: [auxiliary("aux-a", "First review"), auxiliary("aux-b", "Second review")] }),
    subscribeLiveSessionRunStatus: () => () => {},
    subscribeSessionInvalidation: () => () => {},
    subscribeOpenSessionWindowIds: () => () => {},
    onSessionTurnUpdated: () => () => {},
    openSession: async (...args) => { opens.push(args); },
    showHomeCrewContextMenu: async (request) => {
      menus.push(request);
      return menus.length === 1 ? { status: "dismissed" } : { status: "failed", message: "Closed 1; 1 left; 1 not attempted." };
    },
  };
  dom.window.withmate = api as WithMateWindowApi;
  const render = (searchText = "") => act(async () => root.render(<HomeCrewPanel active searchText={searchText} />));
  const titles = () => [...element.querySelectorAll(".home-monitor-parent-title")].map((title) => title.textContent);
  const button = (name: string) => {
    const match = [...element.querySelectorAll("button")].find((entry) => entry.getAttribute("aria-label")?.startsWith(name));
    assert.ok(match, name);
    return match;
  };
  const click = (name: string) => act(async () => button(name).click());
  try {
    await render();
    assert.deepEqual(titles(), ["new-root", "origin"]);
    const descendants = button("Show Children of origin");
    assert.match(descendants.getAttribute("aria-label")!, /1 descendant window open; Running: 1; Canceling: 1; Waiting For Stop: 1; Idle: 1; Unread Result/);
    const spinner = descendants.querySelector('[role="img"][aria-label="Running: 1, Canceling: 1, Waiting For Stop: 1"]');
    assert.equal(spinner?.textContent, ": 3");
    await click("Show Children of origin");
    assert.deepEqual(titles(), ["new-root", "origin", "middle", "last"]);
    await click("Show Auxiliary sessions for middle");
    assert.deepEqual(titles(), ["new-root", "origin", "middle", "last"]);
    await click("Open Auxiliary: First review");
    await click("Open Auxiliary: Second review; Unread Result");
    await render("  KITE  ");
    assert.deepEqual(titles(), ["origin", "middle", "closed-leaf"]);
    await click("Open Session: closed-leaf; Window Closed");
    await render();
    assert.deepEqual(titles(), ["new-root", "origin", "middle", "last"]);
    assert.ok(button("Hide Auxiliary sessions for middle"));
    await click("Show Children of middle");
    assert.deepEqual(titles(), ["new-root", "origin", "middle", "closed-leaf", "open-leaf", "last"]);
    await click("Focus Session: open-leaf; Window Open; Main Running; Unread Result");
    assert.deepEqual(opens, [["middle", "aux-a"], ["middle", "aux-b"], ["closed-leaf"], ["open-leaf"]]);

    await act(async () => button("Open Session: closed-leaf").dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true, clientX: 100, clientY: 200 })));
    await act(async () => button("Open Session: middle").dispatchEvent(new dom.window.KeyboardEvent("keydown", { bubbles: true, key: "F10", shiftKey: true })));
    assert.deepEqual(menus, [
      { sessionId: "closed-leaf", incarnationId: "inc-closed-leaf", point: { x: 100, y: 200 } },
      { sessionId: "middle", incarnationId: "inc-middle", point: { x: 0, y: 0 } },
    ]);
    assert.equal(element.querySelector('[role="alert"]')?.textContent, "Closed 1; 1 left; 1 not attempted.");
  } finally {
    await dispose();
  }
});

// @test-value v2
// kind = "contract"
// claim = "Crew保有snapshotは現在世代の全page成功後だけ置き換わり、遅延応答・後続page失敗・進まないcursorでは前回の完全な一覧と再試行を維持する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#home-window の Crew（再取得と全pageの反映）" }
// fault = "最初のpageや無効化済みsnapshotを表示する、同じcursorでループする、または部分失敗で前回表示を消す"
// observable = "hook consumerの表示IDとerror、再取得のcursor列、retry後の一覧"
// observation_boundary = "consumer"
// scope = "useHomeCrewの複数page、購読による世代失効、tab再表示、失敗からの復旧"
// lifecycle = "permanent"
// impact = "読み込み途中の枝を全件と誤認せず、失敗中も前回の一覧から会話を探せる"
// distinction = "Mainのpage単体や純粋projectionではRenderer側の世代・集約・retry境界を検査できない"
// @end-test-value
test("Crewは全pageが揃ってから更新し、部分失敗や旧世代の結果を表示しない", async () => {
  const { dom, element, root, dispose } = setup();
  const cursors: (string | null | undefined)[] = [];
  const live = new Set<Parameters<WithMateWindowApi["subscribeLiveSessionRunStatus"]>[0]>();
  const turns = new Set<Parameters<WithMateWindowApi["onSessionTurnUpdated"]>[0]>();
  const invalidations = new Set<Parameters<WithMateWindowApi["subscribeSessionInvalidation"]>[0]>();
  const windows = new Set<Parameters<WithMateWindowApi["subscribeOpenSessionWindowIds"]>[0]>();
  function subscribe<T>(listeners: Set<T>) {
    return (listener: T) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
  }
  const secondPage = deferred<HomeCrewPageResult>();
  let read = async (cursor?: string | null) => cursor ? secondPage.promise : page([member("first")], "g:a");
  const api = {
    listHomeCrewPage: async (request?: { cursor?: string | null } | null) => {
      cursors.push(request?.cursor);
      return read(request?.cursor);
    },
    subscribeLiveSessionRunStatus: subscribe(live), subscribeSessionInvalidation: subscribe(invalidations),
    onSessionTurnUpdated: subscribe(turns), subscribeOpenSessionWindowIds: subscribe(windows),
  };
  let state!: ReturnType<typeof useHomeCrew>;
  function Probe({ active }: { active: boolean }) {
    state = useHomeCrew(api, active);
    return <div>{state.snapshot?.entries.map(({ id }) => id).join(",")}</div>;
  }
  const render = (active: boolean) => act(async () => root.render(<Probe active={active} />));
  try {
    await render(false);
    assert.deepEqual(cursors, []);
    await render(true);
    assert.deepEqual(cursors, [null, "g:a"]);
    assert.equal(state.pending, true);
    assert.equal(Object.is(state.snapshot, null), true);
    await act(async () => secondPage.resolve(page([member("second")])));
    assert.equal(element.textContent, "first,second");

    const late = deferred<HomeCrewPageResult>();
    read = () => late.promise;
    await act(async () => { for (const update of turns) update("first"); });
    assert.equal(element.textContent, "first,second");
    assert.equal(state.pending, true);
    await act(async () => {
      for (const update of windows) update(["latest"]);
      for (const update of invalidations) update({ scope: "all" });
      dom.window.dispatchEvent(new dom.window.Event("focus"));
    });
    assert.deepEqual(cursors, [null, "g:a", null]);
    read = async () => page([member("latest")]);
    await act(async () => late.resolve(page([member("obsolete")], "g:b")));
    assert.deepEqual(cursors, [null, "g:a", null, null]);
    assert.equal(element.textContent, "latest");

    read = async (cursor) => {
      if (cursor) throw new Error("Second page unavailable");
      return page([member("partial")], "g:c");
    };
    await act(async () => { for (const update of live) update("latest", { runState: "running" }); });
    assert.equal(state.error, "Second page unavailable");
    assert.equal(element.textContent, "latest");
    read = async () => page([member("partial")], "g:c");
    await act(async () => state.refresh());
    assert.match(state.error, /Could not advance/);
    assert.equal(element.textContent, "latest");
    read = async () => page([]);
    await act(async () => state.refresh());
    assert.equal(state.error, "");
    assert.deepEqual(state.snapshot?.entries, []);

    const previousTab = deferred<HomeCrewPageResult>();
    read = () => previousTab.promise;
    await act(async () => state.refresh());
    await render(false);
    assert.deepEqual([live.size, turns.size, invalidations.size, windows.size], [0, 0, 0, 0]);
    read = async () => page([member("new-tab")]);
    await render(true);
    await act(async () => previousTab.resolve(page([member("previous-tab")])));
    assert.equal(element.textContent, "new-tab");
  } finally {
    await dispose();
  }
});
