import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import {
  SessionContextPane,
  type MessageNavigatorPage,
  type SessionContextPaneProps,
} from "../../src/chat/shell/session-context-pane.js";
import { buildContextPaneProjection } from "../../src/chat/runtime/session-ui-projection.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/** 仮想リストを実描画できる寸法とスクロールを持つ DOM を作り、ページの再描画とジャンプ先の記録を提供する。 */
async function withNavigator(
  run: (fixture: {
    dom: JSDOM;
    element: HTMLElement;
    render: (
      page: MessageNavigatorPage | undefined,
      entries?: SessionContextPaneProps["messageNavigatorEntries"],
    ) => void;
    jumps: string[];
  }) => Promise<void>,
) {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", {
    pretendToBeVisual: true,
  });
  const names = [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "Node",
    "DOMRect",
    "Event",
    "MouseEvent",
  ] as const;
  const descriptors = names.map(
    (name) =>
      [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
  );
  for (const name of names)
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: name === "window" ? dom.window : dom.window[name],
    });
  Object.defineProperties(dom.window.HTMLElement.prototype, {
    offsetWidth: {
      configurable: true,
      /** 仮想リストを横幅280ピクセルの領域として測らせる。 */ get: () => 280,
    },
    offsetHeight: {
      configurable: true,
      /** 仮想行とスクロール領域を異なる高さで測らせる。 */ get() {
        return (this as HTMLElement).classList.contains(
          "messages-navigator-virtual-row",
        )
          ? 54
          : 600;
      },
    },
    clientHeight: {
      configurable: true,
      /** 一度に表示できる領域を600ピクセルに固定する。 */ get: () => 600,
    },
    scrollHeight: {
      configurable: true,
      /** 仮想リストが設定した全体の高さをスクロール範囲として返す。 */ get() {
        return Number.parseFloat(
          (this as HTMLElement).querySelector<HTMLElement>(
            ".messages-navigator-virtual-list",
          )?.style.height ?? "600",
        );
      },
    },
    getBoundingClientRect: {
      configurable: true,
      /** スクロール位置を反映した仮想リストの矩形を返し、行を固定高で計測する。 */ value() {
        const element = this as HTMLElement;
        const scroll = element.closest(
          ".command-monitor-content",
        ) as HTMLElement | null;
        const top = element.classList.contains(
          "messages-navigator-virtual-list",
        )
          ? -(scroll?.scrollTop ?? 0)
          : 0;
        return new dom.window.DOMRect(
          0,
          top,
          280,
          element.classList.contains("messages-navigator-virtual-row")
            ? 54
            : 600,
        );
      },
    },
    scrollTo: {
      configurable: true,
      /** プログラムから移動した位置を保存し、仮想リストへスクロールを通知する。 */ value(
        options: ScrollToOptions,
      ) {
        this.scrollTop = options.top ?? 0;
        this.dispatchEvent(new dom.window.Event("scroll"));
      },
    },
  });
  const element = dom.window.document.getElementById("root")!;
  const root = createRoot(element);
  const jumps: string[] = [];
  const props: SessionContextPaneProps = {
    activeContextPaneTab: "messages",
    availableContextPaneTabs: ["messages"],
    contextPaneProjection: buildContextPaneProjection({
      activeContextPaneTab: "messages",
      latestCommandView: null,
      backgroundTasks: [],
    }),
    latestCommandView: null,
    runningDetailsEntries: [],
    liveRunReasoningText: "",
    backgroundTasks: [],
    selectedSessionLiveRunErrorMessage: "",
    isSelectedSessionRunning: false,
    isCopilotSession: false,
    selectedCopilotRemainingPercentLabel: "",
    selectedCopilotRemainingRequestsLabel: "",
    selectedCopilotQuotaResetLabel: "",
    selectedSessionContextTelemetry: null,
    selectedSessionContextTelemetryProjection: {
      summaryLabel: "",
      currentTokensLabel: "",
      tokenLimitLabel: "",
      messagesLengthLabel: "",
      systemTokensLabel: "",
      conversationTokensLabel: "",
    },
    messageNavigatorSessionId: "main",
    /** Messages タブのみの fixture では循環操作を行わない。 */ onCycleContextPaneTab() {},
    /** 選択または Enter から受け取ったメッセージキーを保存する。 */ onJumpToMessage:
      (key) => jumps.push(key),
  };
  try {
    await run({
      dom,
      element,
      jumps,
      /** 同じ Context Pane にページ結果かローカルの項目を渡して再描画する。 */ render:
        (page, entries) =>
          root.render(
            React.createElement(SessionContextPane, {
              ...props,
              messageNavigatorPage: page,
              messageNavigatorEntries: entries,
            }),
          ),
    });
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
}

// @test-value v2
// kind = "contract"
// claim = "Messages一覧は同じuser roleのSession送信者と人間を識別し選択した発言へ移動する"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/958" }
// fault = "保存送信者をUserとして表示するか選択したmessage keyを取り違える"
// observable = "paged navigatorのaccessible nameとクリック時のjump key"
// observation_boundary = "component-behavior"
// scope = "Messages送信者表示とjump"
// lifecycle = "permanent"
// impact = "他Sessionからの発言をユーザー本人の入力と誤認する"
// distinction = "storageのspeaker testでは実際の一覧行の表示と選択先を検証できない"
// @end-test-value
/** user role が同じでも Session 送信者名と本人を区別し、選んだ行のメッセージキーで移動することを確認する。 */
test("paged navigator identifies incoming sender and preserves its jump", async () =>
  withNavigator(async ({ element, render, jumps }) => {
    const page: MessageNavigatorPage = {
      items: [
        {
          key: "sender-message",
          sourceKind: "session",
          role: "user",
          speaker: { kind: "agent", name: "Rika", iconPath: "" },
          preview: "hello",
          accent: false,
          isCollapsed: false,
          isBookmarked: false,
        },
        {
          key: "user-message",
          sourceKind: "session",
          role: "user",
          speaker: { kind: "user" },
          preview: "reply",
          accent: false,
          isCollapsed: false,
          isBookmarked: false,
        },
      ],
      offset: 0,
      totalCount: 2,
      filter: "all",
      loading: false,
      error: "",
      /** 送信者の表示確認では検索対象を切り替えない。 */ onFilterChange() {},
      /** 2件を一度に提供するため追加範囲は読み込まない。 */ onRequestRange() {},
      /** 取得済みページには失敗からの再試行を設けない。 */ onRetry() {},
    };
    await act(async () => render(page));
    const rows = element.querySelectorAll<HTMLButtonElement>(
      ".messages-navigator-row",
    );
    assert.match(rows[0].getAttribute("aria-label")!, /Rika.*hello/);
    assert.match(rows[1].getAttribute("aria-label")!, /Your message.*reply/);
    await act(async () => rows[0].click());
    assert.deepEqual(jumps, ["sender-message"]);
  }));

// @test-value v2
// kind = "contract"
// claim = "local/pagedのMessagesナビで、空要約は代替文や区切りを付けず、話者・Bookmark・Collapsedとジャンプを保持する。実在の本文は残す"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: Messages navigatorと全履歴query page" }
// fault = "空要約を見出しに足す、区切りだけ残す、または空行の名前/状態/ジャンプや実在要約を失う"
// observable = "空行のaria-label/title/実DOMとCollapsed、非空行の名前と実preview、キーボードで渡すkey"
// observation_boundary = "component-behavior"
// scope = "SessionContextPaneのlocal/paged各branch、取得済み投影を注入"
// lifecycle = "permanent"
// impact = "本文のない結果を実本文に見せたり、有効な一覧行へ移動できなくしたりしない"
// distinction = "保存projectionは空文字を返しても、一覧の文言・accessible name・操作は保証しない"
// @end-test-value
/** ローカル・ページ表示の両方で、空要約に代替文を出さず、話者・ブックマーク・折りたたみと Enter 移動を保つことを確認する。 */
test("Messages navigator keeps empty previews out of names and rows in both layouts", async () =>
  withNavigator(async ({ dom, element, render, jumps }) => {
    const items: MessageNavigatorPage["items"] = [
      {
        key: "literal",
        sourceKind: "session",
        role: "user",
        speaker: { kind: "user" },
        preview: "No content",
        accent: false,
        isCollapsed: false,
        isBookmarked: false,
      },
      {
        key: "empty",
        sourceKind: "session",
        role: "user",
        speaker: { kind: "user" },
        preview: "",
        accent: false,
        isCollapsed: true,
        isBookmarked: true,
      },
    ];
    const page: MessageNavigatorPage = {
      items,
      offset: 0,
      totalCount: 2,
      filter: "all",
      loading: false,
      error: "",
      /** 空要約と実在要約の比較ではフィルターを変えない。 */ onFilterChange() {},
      /** 両行を含むページを固定し、別範囲は取得しない。 */ onRequestRange() {},
      /** 正常な要約一覧では再試行処理を行わない。 */ onRetry() {},
    };
    for (const mode of ["local", "paged"] as const) {
      await act(async () => render(mode === "paged" ? page : undefined, items));
      const [literal, empty] = element.querySelectorAll<HTMLButtonElement>(
        ".messages-navigator-row",
      );
      assert.ok(literal && empty, mode);
      assert.equal(
        empty.getAttribute("aria-label"),
        "Your message, Bookmark saved",
        mode,
      );
      assert.equal(
        empty.getAttribute("title"),
        "Your message, Bookmark saved",
        mode,
      );
      assert.equal(
        empty.querySelector(".messages-navigator-preview"),
        null,
        mode,
      );
      assert.equal(
        empty.querySelector('[aria-label="Collapsed"]')?.textContent,
        "Collapsed",
        mode,
      );
      assert.equal(
        literal.getAttribute("aria-label"),
        "Your message: No content",
        mode,
      );
      assert.equal(
        literal.querySelector(".messages-navigator-preview")?.textContent,
        "No content",
        mode,
      );
      await act(async () => literal.focus());
      await act(async () =>
        literal.dispatchEvent(
          new dom.window.KeyboardEvent("keydown", {
            key: "ArrowDown",
            bubbles: true,
          }),
        ),
      );
      assert.equal(dom.window.document.activeElement, empty, mode);
      await act(async () =>
        empty.dispatchEvent(
          new dom.window.KeyboardEvent("keydown", {
            key: "Enter",
            bubbles: true,
          }),
        ),
      );
    }
    assert.deepEqual(jumps, ["empty", "empty"]);
  }));

// @test-value v2
// kind = "contract"
// claim = "有限pageのMessages navigatorでもHome/End/Arrow/Enterは全件の位置へ移動し、Bookmarkは読込済みpage外を含む対象へ切り替える"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: Messages navigatorと全履歴query page" }
// fault = "keyboard移動が手元pageに限定される、未取得末尾へのfocusを失う、またはBookmark切替を現在pageだけに適用する"
// observable = "1000件の先頭/末尾focus、wrap移動後のEnter jump key、別総件数200件のBookmark末尾jump"
// observation_boundary = "component-behavior"
// scope = "Messages navigatorのpageを跨ぐkeyboard操作とfilter変更"
// lifecycle = "permanent"
// impact = "長い会話やBookmark結果の一部へkeyboardで到達できなくなる"
// distinction = "local array navigatorの既存testは全件数と未取得pageを持たず、type/buildはmounted focusとjumpを観測しない"
// @end-test-value
/** Home・End と矢印が未取得範囲をまたいで先頭・末尾へ移動し、ブックマークだけに切り替えた後も全結果の末尾へジャンプすることを確認する。 */
test("paged navigator moves across the whole result and bookmark pages", async () =>
  withNavigator(async ({ dom, element, render, jumps }) => {
    let filter: "all" | "bookmarks" = "all";
    const ranges: number[] = [];
    /** 現在のフィルターの総数を返し、指定インデックスを含む有限のページだけを描画する。 */
    const show = (index = 0) => {
      const totalCount = filter === "all" ? 1000 : 200;
      const offset = Math.max(0, Math.floor(index / 64) * 64 - 64);
      render({
        filter,
        offset,
        totalCount,
        loading: false,
        error: "",
        items: Array.from(
          { length: Math.min(192, totalCount - offset) },
          (_, i) => ({
            key: `${filter}-${offset + i}`,
            sourceKind: "session",
            role: "user",
            preview: `Message ${offset + i + 1}`,
            accent: false,
            isCollapsed: false,
            isBookmarked: filter === "bookmarks",
          }),
        ),
        /** 仮想一覧から要求された位置を記録し、その位置を含む範囲を返す。 */
        onRequestRange: (index) => {
          ranges.push(index);
          show(index);
        },
        /** フィルターを切り替え、旧ページではなく新しい集合の先頭を読み込む。 */ onFilterChange:
          (next) => {
            filter = next;
            show();
          },
        /** 常に成功する範囲応答に再試行処理は不要。 */ onRetry() {},
      });
    };
    /** その時点でフォーカスされた行へキーを送り、仮想リストの再描画まで待つ。 */
    const key = async (key: string) =>
      act(async () => {
        dom.window.document.activeElement?.dispatchEvent(
          new dom.window.KeyboardEvent("keydown", {
            key,
            bubbles: true,
            cancelable: true,
          }),
        );
      });
    await act(async () => show());
    await act(async () =>
      element
        .querySelector<HTMLButtonElement>(".messages-navigator-row")!
        .focus(),
    );
    await key("End");
    assert.match(
      dom.window.document.activeElement?.getAttribute("aria-label") ?? "",
      /Message 1000$/,
    );
    assert.ok(ranges.includes(999));
    await key("Enter");
    assert.equal(jumps.at(-1), "all-999");
    await key("ArrowDown");
    assert.match(
      dom.window.document.activeElement?.getAttribute("aria-label") ?? "",
      /Message 1$/,
    );
    await key("ArrowUp");
    assert.match(
      dom.window.document.activeElement?.getAttribute("aria-label") ?? "",
      /Message 1000$/,
    );
    await key("Home");
    assert.match(
      dom.window.document.activeElement?.getAttribute("aria-label") ?? "",
      /Message 1$/,
    );
    await act(async () =>
      element
        .querySelector<HTMLButtonElement>(
          ".messages-navigator-filter:nth-of-type(2)",
        )!
        .click(),
    );
    assert.equal(
      element
        .querySelector(".messages-navigator-filter:nth-of-type(2)")
        ?.getAttribute("aria-pressed"),
      "true",
    );
    await act(async () =>
      element
        .querySelector<HTMLButtonElement>(".messages-navigator-row")!
        .focus(),
    );
    await key("End");
    assert.match(
      dom.window.document.activeElement?.getAttribute("aria-label") ?? "",
      /Bookmark saved: Message 200$/,
    );
    await key("Enter");
    assert.equal(jumps.at(-1), "bookmarks-199");
    assert.ok(element.querySelectorAll(".messages-navigator-row").length < 64);
  }));

// @test-value v2
// kind = "contract"
// claim = "Messages navigatorのloading/errorは成功した0件結果と区別され、errorからRetryを実行できる"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: Messages navigatorと全履歴query page" }
// fault = "pendingまたは失敗を空の成功結果として表示する、または再試行できない"
// observable = "aria-busy、loading表示、error alertとRetry callback、成功0件ではそれらがない状態"
// observation_boundary = "component-behavior"
// scope = "Messages navigator queryのloading/error/empty状態"
// lifecycle = "permanent"
// impact = "利用者がまだ読込中の履歴や失敗を存在しない履歴と誤認する"
// distinction = "backend query testsと型検査はmounted UIの状態表示とRetry操作を観測しない"
// @end-test-value
/** 同じ0件でも読込中・失敗・正常な空結果を区別し、失敗の再試行ボタンが1回通知することを確認する。 */
test("paged navigator distinguishes loading and errors from an empty result", async () =>
  withNavigator(async ({ element, render }) => {
    let retries = 0;
    const page: MessageNavigatorPage = {
      items: [],
      offset: 0,
      totalCount: 0,
      filter: "all",
      loading: true,
      error: "",
      /** 状態表示の比較ではフィルターを固定する。 */ onFilterChange() {},
      /** 項目がないため追加範囲の取得は行わない。 */ onRequestRange() {},
      /** 失敗表示の Retry が通知した回数を数える。 */ onRetry: () => retries++,
    };
    await act(async () => render(page));
    assert.equal(
      element.querySelector(".messages-navigator")?.getAttribute("aria-busy"),
      "true",
    );
    assert.ok(
      element.querySelector("[role='status'][aria-label='Loading Messages']"),
    );
    await act(async () =>
      render({ ...page, loading: false, error: "Query failed" }),
    );
    assert.match(
      element.querySelector("[role='alert']")?.textContent ?? "",
      /Query failed/,
    );
    await act(async () =>
      Array.from(element.querySelectorAll("button"))
        .find((button) => button.textContent === "Retry")!
        .click(),
    );
    assert.equal(retries, 1);
    await act(async () => render({ ...page, loading: false }));
    assert.equal(element.querySelector("[role='alert']"), null);
    assert.equal(
      element.querySelector(".messages-navigator")?.getAttribute("aria-busy"),
      "false",
    );
    assert.equal(
      element.querySelector("[role='status'][aria-label='Loading Messages']"),
      null,
    );
  }));
