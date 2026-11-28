import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

import type {
  SessionFilePreviewContextMenuRequest,
  SessionFilePreviewWindowGroup,
} from "../../src-shared/file-explorer/file-explorer-contract.js";
import { normalizeSessionSummary } from "../../src-shared/session/session-state.js";
import { HomePreviewsPanel } from "../../src/home/HomePreviewsPanel.js";
import type { HomePreviewsApi } from "../../src/home/use-home-previews.js";

/** 所有セッションとプレビューのトークンを別々に指定し、同名ファイルの操作先を区別できるグループを作る。 */
function group(
  ownerSessionId: string,
  token = ownerSessionId,
): SessionFilePreviewWindowGroup {
  return {
    ownerSessionId,
    session: normalizeSessionSummary({
      id: ownerSessionId,
      taskTitle: ownerSessionId,
    }),
    previews: [
      {
        token,
        title: "report.md",
        path: `C:/work/${ownerSessionId}/report.md`,
      },
    ],
  };
}

/** 一覧取得を任意の順番で成功または失敗させるため、Promise の確定関数を公開する。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

/** 実 Home プレビューパネルに指定したウィンドウ API を接続し、終了時に DOM 環境を戻す。 */
async function withPreviews(
  api: HomePreviewsApi,
  run: (doc: Document) => Promise<void>,
) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  const names = [
    "window",
    "document",
    "HTMLElement",
    "IS_REACT_ACT_ENVIRONMENT",
  ] as const;
  const descriptors = names.map((name) =>
    Object.getOwnPropertyDescriptor(globalThis, name),
  );
  for (const name of names)
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: name === "IS_REACT_ACT_ENVIRONMENT" ? true : dom.window[name],
    });
  Object.defineProperty(dom.window, "withmate", { value: api });
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    await act(async () => root.render(<HomePreviewsPanel />));
    await run(dom.window.document);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    names.forEach((name, index) => {
      const descriptor = descriptors[index];
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
}

// @test-value v2
// kind = "contract"
// claim = "Previewsは選択したtoken/ownerだけを操作し、menu取消では閉じず、右クリックとkeyboardでCloseでき、失敗後も再操作できる"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#home-window" }
// fault = "別groupや同名fileを操作する、menuをキャンセルしても閉じる、親Windowを開けない、または操作失敗を隠す"
// observable = "tooltipのpath、menu requestとClose/Focus/Open API引数、取消後の呼出し不在、失敗alertと再操作可能なbutton"
// observation_boundary = "component-behavior"
// scope = "Home Previews panelの親展開・親Session open・子focus・右クリックとkeyboard menuによる個別/親close"
// lifecycle = "permanent"
// impact = "同名fileでも意図したWindowだけへ復帰し、他Sessionのpreviewを閉じない"
// distinction = "DOM操作から実際のAPI境界への対象選択と非同期失敗の回復は型checkでは確認できない"
// @end-test-value
/** 同名プレビューでも個別操作は選択トークン、親操作は所有セッションにだけ届き、メニュー取消では閉じず失敗後も再操作できることを確認する。 */
test("Previews dispatches the selected preview token and owning group independently", async () => {
  const calls: string[][] = [];
  const menus: SessionFilePreviewContextMenuRequest[] = [];
  let selection: "close" | "dismissed" = "dismissed";
  let closeFailure = true;
  let sessionFailure = false;
  const api: HomePreviewsApi = {
    /** 同じファイル名でも所有者とトークンが異なる二組を返す。 */
    listSessionFilePreviewWindows: async () => [
      group("parent-a", "main-preview"),
      group("parent-b", "aux-preview"),
    ],
    /** 個別操作の試験ではプレビュー一覧の更新を通知しない。 */
    subscribeSessionFilePreviewWindowsChanged: () => () => {},
    /** 個別操作中の Session Window 一覧は変更しない。 */
    subscribeOpenSessionWindowIds: () => () => {},
    /** セッション名などの無効化はこの fixture では発火しない。 */
    subscribeSessionInvalidation: () => () => {},
    /** フォーカス要求の対象トークンを記録する。 */
    focusSessionFilePreviewWindow: async (token) => {
      calls.push(["focus", token]);
    },
    /** 個別閉鎖のトークンを記録し、必要に応じて再操作できるエラーを返す。 */
    closeSessionFilePreviewWindow: async (token) => {
      calls.push(["close", token]);
      if (closeFailure) throw new Error("Window close failed");
    },
    /** 一括閉鎖に渡された所有セッションを記録する。 */
    closeSessionFilePreviewWindows: async (owner) => {
      calls.push(["group", owner]);
    },
    /** メニューを開いた対象と位置を記録し、閉鎖または取消の選択を返す。 */
    showSessionFilePreviewContextMenu: async (request) => {
      menus.push(request);
      return selection;
    },
    /** 親の表示操作の宛先を記録し、必要に応じて失敗させる。 */
    openSession: async (owner) => {
      calls.push(["session", owner]);
      if (sessionFailure) throw new Error("Session open failed");
    },
  };
  await withPreviews(api, async (doc) => {
    const cards = [...doc.querySelectorAll(".home-monitor-card")];
    assert.equal(cards.length, 2);
    assert.equal(
      cards[1]!
        .querySelector(".home-previews-children")!
        .hasAttribute("hidden"),
      true,
    );
    await act(async () =>
      cards[1]!
        .querySelector<HTMLButtonElement>(".home-previews-disclosure")!
        .click(),
    );
    assert.equal(
      cards[1]!
        .querySelector(".home-previews-disclosure")!
        .getAttribute("aria-expanded"),
      "true",
    );
    assert.equal(
      cards[1]!
        .querySelector(".home-previews-children")!
        .hasAttribute("hidden"),
      false,
    );
    const file = cards[1]!.querySelector<HTMLButtonElement>(
      ".home-previews-file",
    )!;
    assert.equal(file.title, "C:/work/parent-b/report.md");
    await act(async () => file.click());
    const parent = cards[0]!.querySelector<HTMLButtonElement>(
      ".home-previews-session",
    )!;
    await act(async () => parent.click());
    /** 固定座標のコンテキストメニューイベントを対象の要素に送る。 */
    const rightClick = async (element: HTMLElement) => {
      const event = new doc.defaultView!.MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 12,
        clientY: 34,
      });
      await act(async () => {
        element.dispatchEvent(event);
      });
      assert.equal(event.defaultPrevented, true);
    };
    await rightClick(file);
    assert.deepEqual(calls, [
      ["focus", "aux-preview"],
      ["session", "parent-a"],
    ]);
    selection = "close";
    await rightClick(file);
    assert.match(
      doc.querySelector('[role="alert"]')!.textContent!,
      /Could not close preview: Window close failed/,
    );
    assert.equal(file.disabled, false);
    closeFailure = false;
    await act(async () => {
      file.dispatchEvent(
        new doc.defaultView!.KeyboardEvent("keydown", {
          key: "ContextMenu",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    assert.equal(doc.querySelector('[role="alert"]'), null);
    await act(async () => {
      parent.dispatchEvent(
        new doc.defaultView!.KeyboardEvent("keydown", {
          key: "F10",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    assert.deepEqual(menus, [
      { scope: "preview", point: { x: 12, y: 34 } },
      { scope: "preview", point: { x: 12, y: 34 } },
      { scope: "preview", point: { x: 0, y: 0 } },
      { scope: "session", point: { x: 0, y: 0 } },
    ]);
    assert.deepEqual(calls, [
      ["focus", "aux-preview"],
      ["session", "parent-a"],
      ["close", "aux-preview"],
      ["close", "aux-preview"],
      ["group", "parent-a"],
    ]);
    sessionFailure = true;
    await act(async () => parent.click());
    assert.match(
      doc.querySelector('[role="alert"]')!.textContent!,
      /Could not open session: Session open failed/,
    );
    assert.equal(parent.disabled, false);
    sessionFailure = false;
    await act(async () => parent.click());
    assert.equal(doc.querySelector('[role="alert"]'), null);
  });
});

// @test-value v2
// kind = "invariant"
// claim = "PreviewsはSession名変更通知で親title・tooltip・accessible nameを更新し、最新取得だけを反映して失敗時の一覧保持とRetryを維持する"
// oracle = { type = "contract", ref = "docs/design/ui-design-guidelines.md#読込・空・失敗" }
// fault = "Session名変更を反映しない、遅れた取得が最新名を上書きする、取得失敗を0件扱いする、またはRetryで復帰できない"
// observable = "読込busy、親title・tooltip・accessible name、失敗alertと保持中のtitle、Retry後の正常0件、PreviewとSession通知の購読解除"
// observation_boundary = "component-behavior"
// scope = "Home Previews panelの初回取得とPreview/Session変更通知による並行取得・再試行"
// lifecycle = "permanent"
// impact = "現在のSession名でPreviewを識別し、遅延した取得や読込失敗でも一覧と回復操作を保つ"
// distinction = "取得完了順と通知・再試行を跨ぐ表示状態は型checkや静的renderでは確認できない"
// @end-test-value
/** 古い取得が遅れても新しいセッション名を保ち、再取得失敗では直近一覧とエラーを併記し、再試行で空の最新結果を反映することを確認する。 */
test("Previews keeps the latest refresh and recovers a failed refresh without discarding its list", async () => {
  const requests: ReturnType<
    typeof deferred<SessionFilePreviewWindowGroup[]>
  >[] = [];
  /** 一覧の購読が登録されるまで通知を何も行わない。 */
  let emit = () => {};
  /** セッション無効化の購読が登録されるまで通知を何も行わない。 */
  let emitSession: Parameters<
    HomePreviewsApi["subscribeSessionInvalidation"]
  >[0] = () => {};
  let unsubscribed = false;
  let sessionUnsubscribed = false;
  const api: HomePreviewsApi = {
    /** 一覧要求を別々に保留して、通知後の応答順を制御する。 */
    listSessionFilePreviewWindows: () => {
      const request = deferred<SessionFilePreviewWindowGroup[]>();
      requests.push(request);
      return request.promise;
    },
    /** プレビュー更新の通知先を保持して解除を記録する。 */
    subscribeSessionFilePreviewWindowsChanged: (listener) => {
      emit = listener;
      return () => {
        unsubscribed = true;
      };
    },
    /** ウィンドウ開閉通知を使わず二つの再取得トリガーを観察する。 */
    subscribeOpenSessionWindowIds: () => () => {},
    /** セッション変更の通知先を保持して解除を記録する。 */
    subscribeSessionInvalidation: (listener) => {
      emitSession = listener;
      return () => {
        sessionUnsubscribed = true;
      };
    },
    /** 再取得の試験では子ウィンドウへフォーカスしない。 */
    focusSessionFilePreviewWindow: async () => {},
    /** 再取得失敗を調べる間、個別のウィンドウは閉じない。 */
    closeSessionFilePreviewWindow: async () => {},
    /** 一覧更新の挙動に一括閉鎖の副作用を入れない。 */
    closeSessionFilePreviewWindows: async () => {},
    /** 文脈メニューから一覧を変える操作はしない。 */
    showSessionFilePreviewContextMenu: async () => "dismissed",
    /** 親ウィンドウを開かず一覧だけを検査する。 */
    openSession: async () => {},
  };
  await withPreviews(api, async (doc) => {
    /** 同じ親 ID のタイトルだけを更新し、取得の新旧を見分けられるようにする。 */
    const renamedGroup = (title: string) => ({
      ...group("parent"),
      session: normalizeSessionSummary({ id: "parent", taskTitle: title }),
    });
    /** 表示名・ツールチップ・操作のアクセシブル名がすべて指定タイトルを使うことを確かめる。 */
    const assertTitle = (title: string) => {
      const parent = doc.querySelector<HTMLButtonElement>(
        ".home-previews-session",
      )!;
      assert.equal(parent.querySelector("strong")!.textContent, title);
      assert.equal(parent.title, title);
      assert.equal(parent.getAttribute("aria-label"), `Open session: ${title}`);
      assert.equal(
        doc
          .querySelector(".home-previews-disclosure")!
          .getAttribute("aria-label"),
        `Show previews for ${title}`,
      );
    };
    assert.equal(
      doc.querySelector(".home-previews-body")!.getAttribute("aria-busy"),
      "true",
    );
    await act(async () =>
      requests[0]!.resolve([renamedGroup("Original Session")]),
    );
    assertTitle("Original Session");
    await act(async () => emit());
    await act(async () =>
      emitSession({
        scope: "ids",
        sessionIds: ["parent"],
        detailChanged: false,
      }),
    );
    assert.equal(requests.length, 3);
    await act(async () =>
      requests[2]!.resolve([renamedGroup("Renamed Session")]),
    );
    await act(async () =>
      requests[1]!.resolve([renamedGroup("Original Session")]),
    );
    assert.equal(doc.querySelectorAll(".home-monitor-card").length, 1);
    assertTitle("Renamed Session");
    await act(async () => emitSession({ scope: "all" }));
    await act(async () =>
      requests[3]!.reject(new Error("Registry unavailable")),
    );
    assert.match(
      doc.querySelector('[role="alert"]')!.textContent!,
      /Registry unavailable/,
    );
    assertTitle("Renamed Session");
    await act(async () =>
      doc.querySelector<HTMLButtonElement>('[role="alert"] button')!.click(),
    );
    await act(async () => requests[4]!.resolve([]));
    assert.equal(
      doc.querySelector(".home-previews-body")!.getAttribute("aria-busy"),
      "false",
    );
    assert.equal(doc.querySelectorAll(".home-monitor-card").length, 0);
    assert.equal(doc.querySelectorAll('[role="alert"]').length, 0);
  });
  assert.equal(unsubscribed, true);
  assert.equal(sessionUnsubscribed, true);
});

// @test-value v2
// kind = "contract"
// claim = "Previewsは現在のWindow数の降順・同数は取得順に並び、開閉通知で順序と件数を更新して0件の親行と操作対象を保つ"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#home-window" }
// fault = "件数順に並ばない、同数で取得順を失う、並べ替えで展開対象が変わる、Close Allで親を除く、または0件で展開やClose Allを実行する"
// observable = "初回・Preview追加・Close All・Session Window変更後の親順と件数、同一cardと展開状態、0件のdisabled disclosure、Session open引数と購読解除"
// observation_boundary = "component-behavior"
// scope = "Home Previewsの件数順表示とSession/Preview変更通知、0件親表示とClose All"
// lifecycle = "permanent"
// impact = "Previewが多いSessionを先に見つけられ、件数変化で移動しても展開・Close All・復帰の対象を取り違えない"
// distinction = "型checkやMain投影のtestでは通知後の表示順と操作対象を検出できず、一つの小さなDOM testで継続的に確認する"
// @end-test-value
/** プレビュー数で並べ替えても展開中の親行を保ち、全閉鎖でゼロ件の親を消さず、Session Window 通知から新しい一覧に更新することを確認する。 */
test("Previews retains open sessions after Close All and reacts to Session Window changes", async () => {
  const detached = group("detached");
  detached.previews.push({
    token: "detached-second",
    title: "notes.md",
    path: "C:/work/detached/notes.md",
  });
  let groups = [group("open"), { ...group("empty"), previews: [] }, detached];
  /** プレビュー購読が始まる前は一覧の変更通知を行わない。 */
  let emitPreviews = () => {};
  /** 開いている Session Window の購読前は ID 変更を通知しない。 */
  let emitSessions = (_ids: string[]) => {};
  let previewUnsubscribed = false;
  let sessionUnsubscribed = false;
  const opened: string[] = [];
  const closed: string[] = [];
  let menus = 0;
  const api: HomePreviewsApi = {
    /** その時点で開いているプレビューのグループを返す。 */
    listSessionFilePreviewWindows: async () => groups,
    /** プレビューの増減と全閉鎖を通知できるようコールバックを保持する。 */
    subscribeSessionFilePreviewWindowsChanged: (listener) => {
      emitPreviews = listener;
      return () => {
        previewUnsubscribed = true;
      };
    },
    /** Session Window の一覧を明示的に更新し、購読解除も観察できるようにする。 */
    subscribeOpenSessionWindowIds: (listener) => {
      emitSessions = listener;
      return () => {
        sessionUnsubscribed = true;
      };
    },
    /** 一般的なセッション無効化は発火させず、ウィンドウ通知を観察する。 */
    subscribeSessionInvalidation: () => () => {},
    /** このケースでは個別プレビューを前面に出さない。 */
    focusSessionFilePreviewWindow: async () => {},
    /** 個別プレビューを閉じず親単位の一括閉鎖だけを検査する。 */
    closeSessionFilePreviewWindow: async () => {},
    /** 指定した所有者の子だけを空にして、親は一覧に残したまま通知する。 */
    closeSessionFilePreviewWindows: async (owner) => {
      closed.push(owner);
      groups = groups.map((entry) =>
        entry.ownerSessionId === owner ? { ...entry, previews: [] } : entry,
      );
      emitPreviews();
    },
    /** 有効な親メニューが開かれた回数を記録して閉鎖を選ぶ。 */
    showSessionFilePreviewContextMenu: async () => {
      menus++;
      return "close";
    },
    /** ゼロ件の親からセッションを開くときの宛先を記録する。 */
    openSession: async (owner) => {
      opened.push(owner);
    },
  };
  await withPreviews(api, async (doc) => {
    /** 描画順を保ったまま各親のタイトルとプレビュー数を読む。 */
    const displayed = () =>
      [...doc.querySelectorAll(".home-monitor-card")].map((card) => [
        card.querySelector(".home-previews-session")!.getAttribute("title"),
        card.querySelector(".home-monitor-status-icon-count")!.textContent,
      ]);
    assert.deepEqual(displayed(), [
      ["detached", "2"],
      ["open", "1"],
      ["empty", "0"],
    ]);
    const card = doc
      .querySelector('[title="open"]')!
      .closest<HTMLElement>(".home-monitor-card")!;
    const parent = card.querySelector<HTMLButtonElement>(
      ".home-previews-session",
    )!;
    const disclosure = card.querySelector<HTMLButtonElement>(
      ".home-previews-disclosure",
    )!;
    await act(async () => disclosure.click());
    assert.equal(disclosure.getAttribute("aria-expanded"), "true");
    groups = groups.map((entry) =>
      entry.ownerSessionId === "open"
        ? {
            ...entry,
            previews: [
              ...entry.previews,
              {
                token: "open-second",
                title: "notes.md",
                path: "C:/work/open/notes.md",
              },
            ],
          }
        : entry,
    );
    await act(async () => emitPreviews());
    assert.deepEqual(displayed(), [
      ["open", "2"],
      ["detached", "2"],
      ["empty", "0"],
    ]);
    assert.equal(doc.querySelector(".home-monitor-card"), card);
    assert.equal(disclosure.getAttribute("aria-expanded"), "true");
    assert.equal(
      card.querySelector(".home-previews-children")!.hasAttribute("hidden"),
      false,
    );
    await act(async () => emitPreviews());
    assert.deepEqual(displayed(), [
      ["open", "2"],
      ["detached", "2"],
      ["empty", "0"],
    ]);
    await act(async () => {
      parent.dispatchEvent(
        new doc.defaultView!.MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    assert.deepEqual(closed, ["open"]);
    assert.deepEqual(displayed(), [
      ["detached", "2"],
      ["open", "0"],
      ["empty", "0"],
    ]);
    assert.equal(
      doc.querySelector('[title="open"]')!.closest(".home-monitor-card"),
      card,
    );
    assert.equal(disclosure.disabled, true);
    assert.equal(disclosure.getAttribute("aria-expanded"), "false");
    assert.equal(disclosure.title, "Previews: 0");
    assert.equal(
      card.querySelector(".home-previews-children")!.hasAttribute("hidden"),
      true,
    );
    await act(async () => {
      parent.click();
      parent.dispatchEvent(
        new doc.defaultView!.MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
        }),
      );
      parent.dispatchEvent(
        new doc.defaultView!.KeyboardEvent("keydown", {
          key: "ContextMenu",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    assert.deepEqual(opened, ["open"]);
    assert.equal(menus, 1);
    groups = [groups[0]!, { ...group("new"), previews: [] }, groups[2]!];
    await act(async () => emitSessions(["open", "new"]));
    assert.deepEqual(displayed(), [
      ["detached", "2"],
      ["open", "0"],
      ["new", "0"],
    ]);
  });
  assert.equal(previewUnsubscribed, true);
  assert.equal(sessionUnsubscribed, true);
});
