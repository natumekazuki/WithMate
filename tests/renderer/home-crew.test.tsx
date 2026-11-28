import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

import type { AuxiliarySessionSummary } from "../../src-shared/auxiliary/auxiliary-session-state.js";
import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";
import {
  buildNewSession,
  projectHomeSessionSummary,
} from "../../src-shared/session/session-state.js";
import type {
  HomeCrewMember,
  HomeCrewPageResult,
} from "../../src-shared/window/home-crew-types.js";
import { HomeCrewPanel } from "../../src/home/HomeCrewPanel.js";
import { useHomeCrew } from "../../src/home/use-home-crew.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/** 指定IDを見出しにしたCrewメンバーを作り、親子関係や実行状態だけを試験ごとに上書きする。 */
function member(
  id: string,
  options: Partial<HomeCrewMember> = {},
): HomeCrewMember {
  const session = buildNewSession({
    id,
    taskTitle: id,
    character: "Mia",
    characterId: "mia",
    characterIconPath: "",
    characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
    workspaceLabel: "Workspace",
    workspacePath: "C:\\workspace",
    branch: "",
    approvalMode: "on-request",
  });
  return {
    ...projectHomeSessionSummary(session),
    status: "idle",
    runState: "idle",
    incarnationId: `inc-${id}`,
    rootSessionId: id,
    parentSessionId: null,
    createdAt: "2026-10-01T00:00:00Z",
    isWindowOpen: false,
    ...options,
  };
}

/** 同じ親に属する実行中のAuxiliaryを作り、二件目だけを未読にする。 */
function auxiliary(id: string, preview: string): AuxiliarySessionSummary {
  return {
    id,
    preview,
    parentSessionId: "middle",
    runState: "running",
    title: preview,
    provider: "codex",
    catalogRevision: 0,
    model: "",
    reasoningEffort: "",
    approvalMode: "on-request",
    codexSandboxMode: "workspace-write",
    codexSpeed: "standard",
    codexReviewer: "user",
    customAgentName: "",
    threadId: "",
    displayAfterMessageIndex: null,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    hasUnreadResult: id === "aux-b",
  };
}

/** 継続カーソルの有無に合わせて終端を宣言するCrewページを作る。 */
function page(
  entries: HomeCrewMember[],
  nextCursor: string | null = null,
): HomeCrewPageResult {
  return {
    entries,
    nextCursor,
    hasMore: nextCursor !== null,
    auxiliarySessions: [],
  };
}

/** 二ページ目の応答などを好きな時点まで保留できるようにする。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** 各ケース用のDOMとReactルートを用意する。 */
function setup() {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "https://withmate.local/",
  });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  Object.defineProperty(globalThis, "window", {
    value: dom.window,
    configurable: true,
  });
  Object.defineProperty(globalThis, "document", {
    value: dom.window.document,
    configurable: true,
  });
  const element = dom.window.document.getElementById("root")!;
  const root = createRoot(element);
  return {
    dom,
    element,
    root,
    /** Reactを先にアンマウントし、DOMと以前のグローバルを復元する。 */
    async dispose() {
      await act(async () => root.unmount());
      dom.window.close();
      Object.defineProperty(globalThis, "window", {
        value: previousWindow,
        configurable: true,
      });
      Object.defineProperty(globalThis, "document", {
        value: previousDocument,
        configurable: true,
      });
    },
  };
}

// @test-value v2
// kind = "contract"
// claim = "Crewは通常失敗と旧interruptedの子SessionをFailedとして一つに集計し、各Sessionへの移動を保つ"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#home-window の Crewの集計と MonitorのFailed状態" }
// fault = "再起動の失敗を別集計にするか、同じ失敗状態の別Sessionを一つの操作対象にする"
// observable = "子孫のaccessible件数と展開後の個別状態、選んだSessionのopen先"
// observation_boundary = "component-behavior"
// scope = "HomeCrewPanelでの混在する失敗の投影・展開・移動"
// lifecycle = "permanent"
// distinction = "projection単体の状態名だけでなく別Sessionのgroupと個別操作を観測する"
// @end-test-value
/** 通常失敗と旧形式の中断を同じ失敗件数に数えても、各Sessionへ個別に移動できることを確かめる。 */
test("Crew groups legacy interrupted and ordinary failures without merging their navigation", async () => {
  const { dom, element, root, dispose } = setup();
  const entries = [
    member("origin", { isWindowOpen: true }),
    member("legacy", {
      rootSessionId: "origin",
      parentSessionId: "origin",
      runState: "interrupted",
    }),
    member("ordinary", {
      rootSessionId: "origin",
      parentSessionId: "origin",
      runState: "error",
    }),
  ];
  const opens: string[] = [];
  const api: Partial<WithMateWindowApi> = {
    /** 通常失敗と中断が同居する固定の一覧ページを返す。 */
    listHomeCrewPage: async () => page(entries),
    /** 一覧の失敗集計には実行状態の追加通知を送らない。 */
    subscribeLiveSessionRunStatus: () => () => {},
    /** 一覧の途中で保存済みデータの無効化を送らない。 */
    subscribeSessionInvalidation: () => () => {},
    /** ウィンドウ開閉の追加通知を発行しない。 */
    subscribeOpenSessionWindowIds: () => () => {},
    /** この試験ではターンの更新を発行しない。 */
    onSessionTurnUpdated: () => () => {},
    /** 選んだ子SessionのIDを呼出し順に記録する。 */
    openSession: async (id) => {
      opens.push(id);
    },
  };
  dom.window.withmate = api as WithMateWindowApi;
  try {
    await act(async () => root.render(<HomeCrewPanel active searchText="" />));
    const descendants = element.querySelector<HTMLButtonElement>(
      'button[aria-label^="Show Children of origin"]',
    )!;
    assert.deepEqual(
      [...descendants.querySelectorAll('[role="img"][aria-label]')].map(
        (item) => item.getAttribute("aria-label"),
      ),
      ["Failed: 2"],
    );
    await act(async () => descendants.click());
    for (const id of ["legacy", "ordinary"]) {
      const open = element.querySelector<HTMLButtonElement>(
        `button[aria-label="Open Session: ${id}; Window Closed; Main Failed"]`,
      )!;
      assert.ok(open);
      await act(async () => open.click());
    }
    assert.deepEqual(opens, ["legacy", "ordinary"]);
  } finally {
    await dispose();
  }
});

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
/** 階層の開閉と検索前後の展開を保ち、MainとAuxiliaryを別々に開き、メニューと集計の対象を区別する。 */
test("Crewは閉じた階層と検索解除後の展開を保ち、対象別にMain/Auxとmenuを操作する", async () => {
  const { dom, element, root, dispose } = setup();
  const entries = [
    member("closed-leaf", {
      rootSessionId: "origin",
      parentSessionId: "middle",
      character: "Kite",
    }),
    member("origin", { runState: "running" }),
    member("new-root", {
      isWindowOpen: true,
      createdAt: "2026-11-01T00:00:00Z",
    }),
    member("last", {
      rootSessionId: "origin",
      parentSessionId: "origin",
      createdAt: "2026-10-03T00:00:00Z",
      cancellationState: "requested",
    }),
    member("middle", {
      rootSessionId: "origin",
      parentSessionId: "origin",
      createdAt: "2026-10-02T00:00:00Z",
      cancellationState: "terminating",
    }),
    member("open-leaf", {
      rootSessionId: "origin",
      parentSessionId: "middle",
      isWindowOpen: true,
      runState: "running",
      hasUnreadResult: true,
    }),
    member("excluded", { runState: "running" }),
  ];
  const opens: Array<[string, string?]> = [];
  const menus: Parameters<WithMateWindowApi["showHomeCrewContextMenu"]>[0][] =
    [];
  const api: Partial<WithMateWindowApi> = {
    /** 保存順のCrewと同じ親にぶら下がる二つのAuxiliaryを一緒に返す。 */
    listHomeCrewPage: async () => ({
      ...page(entries),
      auxiliarySessions: [
        auxiliary("aux-a", "First review"),
        auxiliary("aux-b", "Second review"),
      ],
    }),
    /** 実行状態はページ内の固定値で扱い、実行通知は送信しない。 */
    subscribeLiveSessionRunStatus: () => () => {},
    /** この操作試験では保存データの再読込を発生させない。 */
    subscribeSessionInvalidation: () => () => {},
    /** ウィンドウの開閉状態はページに含め、追加配信しない。 */
    subscribeOpenSessionWindowIds: () => () => {},
    /** ターン更新は送らず、ページの状態とユーザー操作に限定する。 */
    onSessionTurnUpdated: () => () => {},
    /** MainとAuxiliaryで異なる引数の組を記録する。 */
    openSession: async (...args) => {
      opens.push(args);
    },
    /** メニューの対象を控え、部分成功を含む応答を返す。 */
    showHomeCrewContextMenu: async (request) => {
      menus.push(request);
      return menus.length === 1
        ? { status: "dismissed" }
        : { status: "failed", message: "Closed 1; 1 left; 1 not attempted." };
    },
  };
  dom.window.withmate = api as WithMateWindowApi;
  /** 検索文字列を更新し、Crewの表示変更を待つ。 */
  const render = (searchText = "") =>
    act(async () =>
      root.render(<HomeCrewPanel active searchText={searchText} />),
    );
  /** いま出ている親Sessionの見出しをDOM順に読む。 */
  const titles = () =>
    [...element.querySelectorAll(".home-monitor-parent-title")].map(
      (title) => title.textContent,
    );
  /** アクセシブル名で押す対象を探し、見つからない場合はテストを失敗させる。 */
  const button = (name: string) => {
    const match = [...element.querySelectorAll("button")].find((entry) =>
      entry.getAttribute("aria-label")?.startsWith(name),
    );
    assert.ok(match, name);
    return match;
  };
  /** 対象ボタンをクリックして反映を待つ。 */
  const click = (name: string) => act(async () => button(name).click());
  try {
    await render();
    assert.deepEqual(titles(), ["new-root", "origin"]);
    const descendants = button("Show Children of origin");
    assert.match(
      descendants.getAttribute("aria-label")!,
      /1 descendant window open; Running: 1; Canceling: 1; Waiting For Stop: 1; Idle: 1; Unread Result/,
    );
    const spinner = descendants.querySelector(
      '[role="img"][aria-label="Running: 1, Canceling: 1, Waiting For Stop: 1"]',
    );
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
    assert.deepEqual(titles(), [
      "new-root",
      "origin",
      "middle",
      "closed-leaf",
      "open-leaf",
      "last",
    ]);
    await click(
      "Focus Session: open-leaf; Window Open; Main Running; Unread Result",
    );
    assert.deepEqual(opens, [
      ["middle", "aux-a"],
      ["middle", "aux-b"],
      ["closed-leaf"],
      ["open-leaf"],
    ]);

    await act(async () =>
      button("Open Session: closed-leaf").dispatchEvent(
        new dom.window.MouseEvent("contextmenu", {
          bubbles: true,
          clientX: 100,
          clientY: 200,
        }),
      ),
    );
    await act(async () =>
      button("Open Session: middle").dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          bubbles: true,
          key: "F10",
          shiftKey: true,
        }),
      ),
    );
    assert.deepEqual(menus, [
      {
        sessionId: "closed-leaf",
        incarnationId: "inc-closed-leaf",
        point: { x: 100, y: 200 },
      },
      {
        sessionId: "middle",
        incarnationId: "inc-middle",
        point: { x: 0, y: 0 },
      },
    ]);
    assert.equal(
      element.querySelector('[role="alert"]')?.textContent,
      "Closed 1; 1 left; 1 not attempted.",
    );
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
/** 全ページが揃うまで旧一覧を保持し、遅延応答・失敗・停止カーソルを回復可能に扱う。 */
test("Crewは全pageが揃ってから更新し、部分失敗や旧世代の結果を表示しない", async () => {
  const { dom, element, root, dispose } = setup();
  const cursors: (string | null | undefined)[] = [];
  const live = new Set<
    Parameters<WithMateWindowApi["subscribeLiveSessionRunStatus"]>[0]
  >();
  const turns = new Set<
    Parameters<WithMateWindowApi["onSessionTurnUpdated"]>[0]
  >();
  const invalidations = new Set<
    Parameters<WithMateWindowApi["subscribeSessionInvalidation"]>[0]
  >();
  const windows = new Set<
    Parameters<WithMateWindowApi["subscribeOpenSessionWindowIds"]>[0]
  >();
  /** 通知購読を記録し、タブを閉じる際に解除されたかを調べられるようにする。 */
  function subscribe<T>(listeners: Set<T>) {
    return (listener: T) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    };
  }
  const secondPage = deferred<HomeCrewPageResult>();
  /** 最初のページはすぐ返し、継続ページは試験が解放するまで保留する。 */
  let read = async (cursor?: string | null) =>
    cursor ? secondPage.promise : page([member("first")], "g:a");
  const api = {
    /** 発行されたカーソルを記録してから、その時点のページ取得処理へ渡す。 */
    listHomeCrewPage: async (request?: { cursor?: string | null } | null) => {
      cursors.push(request?.cursor);
      return read(request?.cursor);
    },
    subscribeLiveSessionRunStatus: subscribe(live),
    subscribeSessionInvalidation: subscribe(invalidations),
    onSessionTurnUpdated: subscribe(turns),
    subscribeOpenSessionWindowIds: subscribe(windows),
  };
  let state!: ReturnType<typeof useHomeCrew>;
  /** アクティブなCrewフックから現在の完全な一覧だけを読み取る。 */
  function Probe({ active }: { active: boolean }) {
    state = useHomeCrew(api, active);
    return <div>{state.snapshot?.entries.map(({ id }) => id).join(",")}</div>;
  }
  /** タブのアクティブ状態を差し替えて購読と取得の反映を待つ。 */
  const render = (active: boolean) =>
    act(async () => root.render(<Probe active={active} />));
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
    await act(async () => {
      for (const update of turns) update("first");
    });
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
    await act(async () => {
      for (const update of live) update("latest", { runState: "running" });
    });
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
    assert.deepEqual(
      [live.size, turns.size, invalidations.size, windows.size],
      [0, 0, 0, 0],
    );
    read = async () => page([member("new-tab")]);
    await render(true);
    await act(async () => previousTab.resolve(page([member("previous-tab")])));
    assert.equal(element.textContent, "new-tab");
  } finally {
    await dispose();
  }
});
