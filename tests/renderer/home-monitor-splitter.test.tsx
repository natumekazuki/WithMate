import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { HomeMonitorContent } from "../../src/home/HomeMonitorContent.js";
import type { HomeMonitorEntry } from "../../src/home/home-session-projection.js";
import type { CoordinationSummary } from "../../src-shared/coordination/coordination-contract.js";

/** 指定Mainを起点とする未回答の保存相談を用意する。 */
function coordinationItem(
  id: string,
  mainSessionId: string,
): CoordinationSummary {
  return {
    id,
    initiatorMainSessionId: mainSessionId,
    crewRootSessionId: mainSessionId,
    initiator: {
      kind: "main",
      sessionId: mainSessionId,
      incarnationId: "incarnation",
    },
    initiatorTurnId: "turn",
    originReceiptId: null,
    caller: null,
    kind: "user_decision_required",
    respondent: { kind: "user" },
    state: "open",
    answerRevision: 0,
    bodyPreview: "Needs a response",
    createdAt: "2026-11-07T00:00:00Z",
    updatedAt: "2026-11-07T00:00:00Z",
  };
}

/** 他の分類へ組み替えられる待機中の監視カードを作る。 */
function entry(id: string): HomeMonitorEntry {
  return {
    kind: "agent",
    state: { kind: "neutral", label: "Idle" },
    mainState: { kind: "neutral", label: "Idle" },
    auxiliarySessions: [],
    session: {
      id,
      taskTitle: id,
      status: "idle",
      runState: "idle",
      updatedAt: "2026-10-12T00:00:00.000Z",
      isPinned: false,
      workspaceLabel: "workspace",
      workspacePath: "C:/workspace",
      sessionKind: "default",
      accessMode: "active",
      sourceSchemaVersion: 5,
      characterId: "mate",
      character: "Mate",
      characterIconPath: "",
      characterThemeColors: { main: "#223344", sub: "#88bbcc" },
    },
  };
}

/** 監視画面を試す独立DOMと既定APIを用意し、使用後に元のグローバルを復元する。 */
async function withMonitor(
  run: (context: {
    dom: JSDOM;
    root: ReturnType<typeof createRoot>;
  }) => Promise<void>,
) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  Object.defineProperty(dom.window, "withmate", {
    configurable: true,
    value: {
      /** 既定では未回答の相談がない検索結果を返す。 */
      executeCoordination: async () => ({
        items: [],
        total: 0,
        nextOffset: null,
      }),
      /** 試験が上書きしない場合は、保存相談の更新を通知しない。 */
      subscribeCoordinationChanged: () => () => {},
    },
  });
  const names = [
    "window",
    "document",
    "HTMLElement",
    "Node",
    "navigator",
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
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    await run({ dom, root });
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
// claim = "AttentionとCoordinationは同じ上段を共有し、上下境界は隣接する段のMain group件数が少ない側を閉じ、同数は前の段を残し、閉じた側の復帰を優先する。件数更新だけでは開閉しない"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#home-window" }
// fault = "AttentionとCoordinationを別の段にする、上段の片方だけを上下境界で閉じる、多い側を閉じる、同数で前の段を閉じる、両側closedから後の段を開く、または更新で自動開閉する"
// observable = "境界click前後と件数更新後のcontentのinert/aria-hidden、closed行指定、DOM同一性、scrollTop、focus"
// observation_boundary = "component-behavior"
// scope = "HomeMonitorContentの左右分割上段・三段構成と上下境界clickで保持する一覧状態"
// lifecycle = "permanent"
// impact = "限られた監視面積を必要な分類へ配分し、閉じた一覧へkeyboard focusが迷い込まず同じ位置へ復帰できる"
// distinction = "componentの利用操作と更新を跨ぐ状態保持はCSS検査や型checkでは確認できない"
// @end-test-value
/** 分類の件数が少ない側を閉じ、同数の優先順位と閉じた側の復帰を守りながらDOMとスクロール位置を保つ。 */
test("Monitor分類のclickは件数と優先度に従いDOMを保持して開閉する", async () => {
  await withMonitor(async ({ dom, root }) => {
    let coordinationCount = 0;
    /** マウントで購読するまでは相談一覧の更新を起こさない。 */
    let changed = () => {};
    Object.defineProperty(dom.window, "withmate", {
      value: {
        /** 現在の件数に合わせて、別々のMainに属する相談を返す。 */
        executeCoordination: async () => ({
          items: Array.from({ length: coordinationCount }, (_, i) =>
            coordinationItem(`item-${i}`, `coordination-${i}`),
          ),
          nextOffset: null,
        }),
        /** 件数変更後に相談の再取得をトリガーできるよう、購読先を控える。 */
        subscribeCoordinationChanged: (callback: () => void) => {
          changed = callback;
          return () => {};
        },
      },
    });
    /** 分類の件数を差し替えて描画し、相談件数の変更も通知する。 */
    const render = (counts: number[], key = "monitor") => {
      coordinationCount = counts[1]!;
      changed();
      root.render(
        createElement(HomeMonitorContent, {
          key,
          approvalEntries: Array.from({ length: counts[0]! }, (_, i) =>
            entry(`approval-${i}`),
          ),
          runningEntries: Array.from({ length: counts[2]! }, (_, i) =>
            entry(`running-${i}`),
          ),
          nonRunningEntries: [
            ...Array.from({ length: counts[1]! }, (_, i) =>
              entry(`coordination-${i}`),
            ),
            ...Array.from({ length: counts[3]! }, (_, i) =>
              entry(`stopped-${i}`),
            ),
          ],
          /** 開閉の試験なのでカードを別ウィンドウへ開かない。 */
          onOpenSession() {},
          /** 開閉の試験ではメニューを開かない。 */ onShowContextMenu() {},
        }),
      );
    };
    const doc = dom.window.document;
    /** 各分類の本文コンテナーをDOM順に取得する。 */
    const contents = () => [
      ...doc.querySelectorAll<HTMLElement>(".home-monitor-section-content"),
    ];
    /** 各本文が支援技術から非表示になっているかを分類順に読む。 */
    const closed = () =>
      contents().map(
        (content) => content.getAttribute("aria-hidden") === "true",
      );
    /** 指定の境界を押し、分類の開閉が反映されるまで待つ。 */
    const click = async (index: number) => {
      await act(async () =>
        doc
          .querySelectorAll<HTMLButtonElement>(".home-monitor-splitter")
          [index]!.click(),
      );
    };
    for (const [counts, boundary, target] of [
      [[1, 1, 3, 2], 0, 0],
      [[2, 3, 1, 2], 0, 1],
      [[1, 1, 2, 1], 0, 1],
      [[2, 2, 3, 1], 1, 2],
      [[2, 2, 1, 3], 1, 1],
      [[1, 1, 1, 1], 1, 2],
    ] as const) {
      await act(async () => render([...counts], `${counts}-${boundary}`));
      const groups = [[0, 1], [2], [3]];
      const indices = groups[target]!;
      const content = contents()[indices[0]!]!;
      const rows = doc.querySelectorAll(
        ":scope .home-monitor-sections > .home-monitor-row",
      );
      assert.equal(rows.length, 3);
      assert.deepEqual(
        [...rows[0]!.querySelectorAll("h3")].map(
          (heading) => heading.textContent,
        ),
        ["Attention", "Coordination"],
      );
      assert.equal(doc.querySelectorAll(".home-monitor-splitter").length, 2);
      const list = content.querySelector<HTMLElement>(".home-monitor-list")!;
      list.scrollTop = 42;
      list
        .querySelector<HTMLButtonElement>(".home-monitor-parent-button")!
        .focus();
      await click(boundary);
      assert.deepEqual(
        closed(),
        [0, 1, 2, 3].map((i) => indices.includes(i)),
      );
      assert.equal(content.hasAttribute("inert"), true);
      assert.equal(
        doc.activeElement,
        doc.querySelectorAll(".home-monitor-splitter")[indices[0]! < 2 ? 0 : 1],
      );
      assert.ok(
        doc
          .querySelector<HTMLElement>(".home-monitor-sections")!
          .style.gridTemplateRows.includes("max-content"),
      );
      await act(async () => render([5, 5, 5, 5], `${counts}-${boundary}`));
      assert.equal(contents()[indices[0]!], content);
      assert.equal(closed()[indices[0]!], true);
      await click(boundary);
      assert.deepEqual(closed(), [false, false, false, false]);
      assert.equal(list.scrollTop, 42);
      assert.equal(content.hasAttribute("inert"), false);
    }
    await act(async () => render([1, 1, 3, 4], "both-closed"));
    await click(0); // 共用の最上段は Running より Main のグループ数が少ない。
    await click(1); // Running は Stopped より Main のグループ数が少ない。
    assert.deepEqual(closed(), [true, true, true, false]);
    await click(0); // 両方の行が閉じていれば、共用の最上段を先に戻す。
    assert.deepEqual(closed(), [false, false, true, false]);
    await click(0); // 片方だけが閉じていれば、グループ数にかかわらず Running を戻す。
    assert.deepEqual(closed(), [false, false, false, false]);
  });
});

// @test-value v2
// kind = "contract"
// claim = "Monitorは通常の監視対象だけに保存相談を集約し、閉鎖後も監視中のMainとAuxiliaryを保持してグループ数と項目別の移動先を区別する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#home-window; user: 通常Monitorの対象集合へ統一しCoordination右ペインUI以外を修正" }
// fault = "保存相談だけで監視対象外Sessionを追加する、監視継続中の親を落とす、後続pageやAuxiliary相談を落とす、または複数項目を一件へ限定して開く"
// observable = "保存query引数、4分類の見出しと件数、相談open identity、共通Auxiliary開閉と子Session open引数"
// observation_boundary = "component-behavior"
// scope = "HomeMonitorContentから保存summary queryとCoordination navigation APIまで。実Window生成と保存coreは対象外"
// lifecycle = "permanent"
// impact = "Monitor全分類で同じ監視対象を扱い、監視継続中のMainとAuxiliaryの正しい相談へ到達できる"
// distinction = "splitter testは件数配分のみを扱い、queryの保存境界・ページングとidentity付き移動を検証しない"
// @end-test-value
/** 保存相談の件数はMain単位で数え、相談別の移動と閉じたMainのAuxiliary移動は分ける。 */
test("Monitorは保存済みCoordinationのグループ件数と項目別移動先を区別する", async () => {
  await withMonitor(async ({ dom, root }) => {
    const a = coordinationItem("a", "closed-main");
    const auxiliary = {
      ...coordinationItem("aux", "closed-main"),
      initiator: {
        kind: "auxiliary" as const,
        sessionId: "saved-aux",
        incarnationId: "aux-incarnation",
      },
    };
    const single = {
      ...coordinationItem("single", "other-main"),
      initiator: {
        kind: "auxiliary" as const,
        sessionId: "other-aux",
        incarnationId: "other-incarnation",
      },
    };
    const outside = coordinationItem("outside", "unmonitored-main");
    const queries: unknown[] = [],
      opened: unknown[] = [];
    const closed = entry("closed-main");
    closed.auxiliarySessions = [
      {
        id: "saved-aux",
        parentSessionId: "closed-main",
        runState: "idle",
        preview: "Saved child",
        title: "",
        provider: "codex",
        catalogRevision: 1,
        model: "model",
        reasoningEffort: "medium",
        approvalMode: "never",
        codexSandboxMode: "workspace-write",
        codexSpeed: "standard",
        codexReviewer: "user",
        customAgentName: "",
        threadId: "",
        displayAfterMessageIndex: null,
        createdAt: "aux-incarnation",
        updatedAt: "now",
      },
    ];
    const sessionsOpened: unknown[][] = [];
    Object.defineProperty(dom.window, "withmate", {
      value: {
        /** 要求のオフセットを控え、同じMainに属する複数の相談も含むページを返す。 */
        executeCoordination: async (request: { offset: number }) => {
          queries.push(request);
          return request.offset === 0
            ? { items: [a], total: 4, nextOffset: 1 }
            : {
                items: [auxiliary, single, outside],
                total: 4,
                nextOffset: null,
              };
        },
        /** この試験では初回の各ページだけを読み、更新通知は使わない。 */
        subscribeCoordinationChanged: () => () => {},
        /** どの相談または相談グループが移動先になったかを記録する。 */
        openCoordination: async (target: unknown) => {
          opened.push(target);
        },
      },
    });
    await act(async () =>
      root.render(
        createElement(HomeMonitorContent, {
          approvalEntries: [],
          runningEntries: [],
          nonRunningEntries: [closed, entry("other-main")],
          /** 親とAuxiliaryを開く引数の違いを記録する。 */ onOpenSession: (
            ...args
          ) => sessionsOpened.push(args),
          /** 相談やAuxiliaryへの移動を調べる間はコンテキストメニューを開かない。 */ onShowContextMenu() {},
        }),
      ),
    );
    assert.deepEqual(
      queries,
      [0, 1].map((offset) => ({
        operation: "list",
        allCrews: true,
        userPending: true,
        offset,
        limit: 100,
      })),
    );
    const doc = dom.window.document;
    assert.deepEqual(
      [...doc.querySelectorAll(".home-monitor-section-head h3")].map(
        (node) => node.textContent,
      ),
      ["Attention", "Coordination", "Running", "Stopped"],
    );
    assert.deepEqual(
      [
        ...doc.querySelectorAll(
          ".home-monitor-section-head .home-monitor-count",
        ),
      ].map((node) => node.textContent),
      ["0", "2", "0", "0"],
    );
    assert.deepEqual(
      [...doc.querySelectorAll(".home-monitor-parent-title")].map(
        (node) => node.textContent,
      ),
      ["closed-main", "other-main"],
    );
    assert.deepEqual(
      opened,
      [],
      "new saved summaries do not open a Window automatically",
    );
    await act(async () =>
      doc
        .querySelector<HTMLButtonElement>(
          '[aria-label="Open Coordination for closed-main"]',
        )!
        .click(),
    );
    await act(async () =>
      doc
        .querySelector<HTMLButtonElement>(
          '[aria-label="Open Coordination for other-main"]',
        )!
        .click(),
    );
    assert.deepEqual(opened, [
      a.initiator,
      { ...single.initiator, id: single.id },
    ]);
    const disclosure = doc.querySelector<HTMLButtonElement>(
      '[aria-label="Show Auxiliary sessions for closed-main"]',
    )!;
    await act(async () => disclosure.click());
    assert.equal(disclosure.getAttribute("aria-expanded"), "true");
    await act(async () =>
      doc
        .querySelector<HTMLButtonElement>(
          '[aria-label="Open Auxiliary: Saved child"]',
        )!
        .click(),
    );
    assert.deepEqual(sessionsOpened, [["closed-main", "saved-aux"]]);
  });
});

// @test-value v2
// kind = "contract"
// claim = "SessionカードはAttention→Coordination→Running→Stoppedの一か所へ分類され、Attentionの通常Session移動とCoordinationの相談移動、解消後の再分類を保持する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#home-window; user: 未相談のAttention配置追加を戻しCoordination右ペインUI以外を修正" }
// fault = "相談をStoppedやRunningにも重複表示する、AttentionのSession移動を相談移動へ替える、Coordinationの起票元を誤る、または相談解消後も分類が残る"
// observable = "更新ごとの4分類内のカード名、共通カードからのSession/相談open引数、解消・再発時の表示先"
// observation_boundary = "component-behavior"
// scope = "HomeMonitorContentの保存相談通知と既存分類入力を統合した投影と移動"
// lifecycle = "permanent"
// impact = "対応対象を二重に数えず、両方の要求を見落とさず、解消したSessionの現在状態を把握できる"
// distinction = "型検査や個別query testでは分類横断の一意性・通知による再分類・同時要求の操作接続を検出できない"
// @end-test-value
/** 一つのSessionを優先度に従い唯一の分類へ載せ、状態に応じた通常移動と相談移動を分ける。 */
test("MonitorはSessionを一か所に分類して分類に応じた移動先を保つ", async () => {
  await withMonitor(async ({ dom, root }) => {
    let pending = true;
    /** 購読登録されるまで相談の変更通知を無効にしておく。 */
    let changed = () => {};
    const opened: unknown[][] = [],
      consultations: unknown[] = [];
    Object.defineProperty(dom.window, "withmate", {
      value: {
        /** 未解消のときだけ同じMainに質問がある検索結果を返す。 */
        executeCoordination: async () => ({
          items: pending ? [coordinationItem("question", "same")] : [],
          nextOffset: null,
        }),
        /** 質問の解消と再発を通知できるよう、現在の購読先を取り出す。 */
        subscribeCoordinationChanged: (callback: () => void) => {
          changed = callback;
          return () => {};
        },
        /** 質問があるカードを開いたときの実際の相談対象を控える。 */
        openCoordination: async (target: unknown) => {
          consultations.push(target);
        },
      },
    });
    /** 同じSessionを承認待ち、実行中、停止のいずれかとして表示する。 */
    const render = (state: "approval" | "running" | "neutral") => {
      const current = entry("same");
      current.state = current.mainState = { kind: state, label: state };
      root.render(
        createElement(HomeMonitorContent, {
          approvalEntries: state === "approval" ? [current] : [],
          runningEntries: state === "running" ? [current] : [],
          nonRunningEntries: state === "neutral" ? [current] : [],
          /** 通常のSession移動で渡された引数を記録する。 */ onOpenSession: (
            ...args
          ) => opened.push(args),
          /** ここで比較するのは相談移動とSession移動だけに絞る。 */ onShowContextMenu() {},
        }),
      );
    };
    /** 各分類へ投影されたカードの見出しを分類別に読む。 */
    const sections = () =>
      [...dom.window.document.querySelectorAll(".home-monitor-section")].map(
        (section) =>
          [...section.querySelectorAll(".home-monitor-parent-title")].map(
            (title) => title.textContent,
          ),
      );
    await act(async () => render("approval"));
    assert.deepEqual(sections(), [["same"], [], [], []]);
    await act(async () =>
      dom.window.document
        .querySelector<HTMLButtonElement>('[aria-label="Open session: same"]')!
        .click(),
    );
    assert.deepEqual(opened, [["same"]]);
    assert.deepEqual(consultations, []);
    await act(async () => render("running"));
    assert.deepEqual(sections(), [[], ["same"], [], []]);
    await act(async () =>
      dom.window.document
        .querySelector<HTMLButtonElement>(
          '[aria-label="Open Coordination for same"]',
        )!
        .click(),
    );
    assert.deepEqual(consultations, [
      { ...coordinationItem("question", "same").initiator, id: "question" },
    ]);
    pending = false;
    await act(async () => changed());
    assert.deepEqual(sections(), [[], [], ["same"], []]);
    await act(async () => render("neutral"));
    assert.deepEqual(sections(), [[], [], [], ["same"]]);
    pending = true;
    await act(async () => changed());
    assert.deepEqual(sections(), [[], ["same"], [], []]);
  });
});

// @test-value v2
// kind = "contract"
// claim = "Monitorの相談件数は読込に成功するまで可視・読み上げとも未提示とし、確認済み0件は初回失敗および後続の更新失敗と区別する"
// oracle = { type = "contract", ref = "docs/design/ui-design-guidelines.md#読込・空・失敗; docs/design/desktop-ui.md: Home MonitorのCoordination初回取得と背景再取得" }
// fault = "未取得・初回失敗を0件と扱う、または0件の成功後に再取得・失敗で件数を隠す"
// observable = "Coordination見出しの件数のtextとaccessible名、初回loading status、失敗alertとRetry、確定0件の保持"
// observation_boundary = "component-behavior"
// scope = "HomeMonitorContentのCoordination件数の初回開始・失敗・再試行と0件取得後の更新"
// lifecycle = "permanent"
// distinction = "既存の分類・再取得テストは成功済みの件数しか観測せず、未取得と確定空snapshotを区別しない欠陥を検出しない"
// @end-test-value
/** 初回の取得成功まで未確定の件数を通知せず、確認済みのゼロ件と更新失敗を区別する。 */
test("Monitorの相談件数は初回の成功まで表示せず確定0件は後続の失敗でも保つ", async () => {
  await withMonitor(async ({ dom, root }) => {
    let complete:
      | ((result: {
          items: CoordinationSummary[];
          total: number;
          nextOffset: null;
        }) => void)
      | undefined;
    let fail: ((reason: Error) => void) | undefined;
    Object.defineProperty(dom.window, "withmate", {
      value: {
        /** 各取得要求を任意の時点で成功または失敗にできるよう保留する。 */
        executeCoordination: () =>
          new Promise((resolve, reject) => {
            complete = resolve;
            fail = reject;
          }),
        /** 再試行から取得を制御するため、購読では更新を発行しない。 */
        subscribeCoordinationChanged: () => () => {},
      },
    });
    await act(async () =>
      root.render(
        createElement(HomeMonitorContent, {
          approvalEntries: [],
          runningEntries: [],
          nonRunningEntries: [],
          /** このケースには移動先になるSessionがない。 */ onOpenSession() {},
          /** 件数の通知だけを扱うため、メニューを開かない。 */ onShowContextMenu() {},
        }),
      ),
    );
    const section = dom.window.document.querySelector(
      '[aria-labelledby="home-monitor-coordination"]',
    )!;
    /** 相談分類の件数表示要素を取得する。 */
    const count = () => section.querySelector(".home-monitor-count");
    /** 未確定の件数が目視でも読み上げでもゼロと告知されないことを確認する。 */
    const assertUnknown = () => {
      assert.equal(count()?.textContent?.trim() ?? "", "");
      assert.equal(count()?.hasAttribute("aria-label") ?? false, false);
    };
    /** 取得済みゼロ件を文字列と読み上げの両方で確認する。 */
    const assertZero = () => {
      assert.equal(count()?.textContent, "0");
      assert.equal(
        count()?.getAttribute("aria-label"),
        "0 Main session groups",
      );
      assert.notEqual(count()?.getAttribute("aria-hidden"), "true");
    };
    assertUnknown();
    assert.ok(
      section.querySelector(
        '[role="status"][aria-label="Loading Coordination"]',
      ),
    );
    await act(async () => fail!(new Error("First Coordination read failed")));
    assertUnknown();
    assert.match(
      section.querySelector('[role="alert"]')!.textContent!,
      /First Coordination read failed/,
    );
    await act(async () =>
      section
        .querySelector<HTMLButtonElement>('[role="alert"] button')!
        .click(),
    );
    assertUnknown();
    await act(async () => complete!({ items: [], total: 0, nextOffset: null }));
    assertZero();
    assert.equal(section.querySelector('[role="alert"]'), null);
    await act(async () =>
      dom.window.dispatchEvent(new dom.window.Event("focus")),
    );
    assertZero();
    await act(async () => fail!(new Error("Coordination refresh failed")));
    assertZero();
    assert.match(
      section.querySelector('[role="alert"]')!.textContent!,
      /Coordination refresh failed/,
    );
  });
});

// @test-value v2
// kind = "contract"
// claim = "Monitorの相談再取得は取得済み一覧と操作focusを保ちbusyを通知し、成功0件と更新失敗を区別して反映する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#home-window; user: focus再取得でカードが一瞬ずれる不具合を修正" }
// fault = "背景更新で初回読込へ戻す、取得済みカードを外す、成功0件を反映しない、または更新失敗を正常0件として扱う"
// observable = "focus更新中と完了後のaria-busy、card DOM identity、activeElement、分類件数、更新エラー"
// observation_boundary = "component-behavior"
// scope = "HomeMonitorContentとuseCoordinationMonitorのfocus再取得・直前成功snapshot・error反映。実寸法はbrowserで確認する"
// lifecycle = "permanent"
// impact = "他Windowへ移動するためのクリック中も対象とfocusを見失わず、相談解消や更新失敗を取り違えない"
// distinction = "既存分類通知testは再取得を保留せず、成功空snapshot後の背景更新や失敗を通らない。型検査では非同期中の表示保持を確認できない"
// @end-test-value
/** 背景で相談を更新しても一覧とフォーカスを保持し、空の成功と更新の失敗を区別する。 */
test("Monitorは相談の背景再取得で操作対象を保持し成功0件と失敗を分ける", async () => {
  await withMonitor(async ({ dom, root }) => {
    let hold = false,
      fail = false;
    let items = [coordinationItem("question", "same")];
    /** 背景取得が保留されるまでは解放する処理がない。 */
    let release = () => {};
    Object.defineProperty(dom.window, "withmate", {
      value: {
        /** 成功時の一覧、保留、失敗を操作順に切り替えられるようにする。 */
        executeCoordination: async () => {
          if (hold)
            await new Promise<void>((resolve) => {
              release = resolve;
            });
          if (fail) throw new Error("Saved consultations unavailable");
          return { items, total: items.length, nextOffset: null };
        },
        /** 背景更新はウィンドウのフォーカスで開始させ、購読通知は送らない。 */
        subscribeCoordinationChanged: () => () => {},
      },
    });
    await act(async () =>
      root.render(
        createElement(HomeMonitorContent, {
          approvalEntries: [],
          runningEntries: [],
          nonRunningEntries: [entry("same")],
          /** フォーカス保持を観測し、実際のSession移動は行わない。 */ onOpenSession() {},
          /** このケースではメニュー起動を無効にする。 */ onShowContextMenu() {},
        }),
      ),
    );
    const doc = dom.window.document;
    const card = doc.querySelector(".home-monitor-card")!;
    const button = card.querySelector<HTMLButtonElement>(
      ".home-monitor-parent-button",
    )!;
    button.focus();
    hold = true;
    await act(async () =>
      dom.window.dispatchEvent(new dom.window.Event("focus")),
    );
    assert.equal(
      doc.querySelector(".home-monitor-body")?.getAttribute("aria-busy"),
      "true",
    );
    assert.equal(doc.querySelector(".home-monitor-card"), card);
    assert.equal(doc.activeElement, button);
    assert.equal(
      doc.querySelector('[aria-label="Loading Coordination"]'),
      null,
    );
    fail = true;
    await act(async () => release());
    assert.equal(
      doc.querySelector(".home-monitor-body")?.getAttribute("aria-busy"),
      "false",
    );
    assert.equal(
      doc.querySelector(
        '[aria-labelledby="home-monitor-coordination"] .home-monitor-card',
      ),
      card,
    );
    assert.equal(
      doc.querySelector(
        '[aria-labelledby="home-monitor-coordination"] .home-monitor-count',
      )?.textContent,
      "1",
    );
    assert.ok(
      doc.body.textContent?.includes("Saved consultations unavailable"),
    );
    fail = false;
    await act(async () =>
      dom.window.dispatchEvent(new dom.window.Event("focus")),
    );
    items = [];
    await act(async () => release());
    assert.equal(
      doc.querySelector(".home-monitor-body")?.getAttribute("aria-busy"),
      "false",
    );
    assert.equal(
      doc.querySelector(
        '[aria-labelledby="home-monitor-coordination"] .home-monitor-count',
      )?.textContent,
      "0",
    );
    const stopped = doc.querySelector(
      '[aria-labelledby="home-monitor-inactive"] .home-monitor-card',
    )!;
    assert.equal(
      stopped.querySelector(".home-monitor-parent-title")?.textContent,
      "same",
    );
    await act(async () =>
      dom.window.dispatchEvent(new dom.window.Event("focus")),
    );
    assert.equal(
      doc.querySelector(".home-monitor-body")?.getAttribute("aria-busy"),
      "true",
    );
    assert.equal(
      doc.querySelector('[aria-label="Loading Coordination"]'),
      null,
    );
    assert.equal(
      doc.querySelector(
        '[aria-labelledby="home-monitor-inactive"] .home-monitor-card',
      ),
      stopped,
    );
    await act(async () => release());
    assert.equal(
      doc.querySelector(".home-monitor-body")?.getAttribute("aria-busy"),
      "false",
    );
    assert.equal(
      doc.querySelector(
        '[aria-labelledby="home-monitor-inactive"] .home-monitor-card',
      ),
      stopped,
    );
    assert.equal(
      doc.body.textContent?.includes("Saved consultations unavailable"),
      false,
    );
  });
});

// @test-value v2
// kind = "contract"
// claim = "Monitor境界は隣接領域だけをpointer移動量と24px矢印でresizeし、48px下限・Home/End・drag後click抑止・終了後move無視を維持する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#home-window" }
// fault = "非隣接領域も変える、deltaを累積する、下限を超える、dragを開閉と誤認する、またはpointer終了後もresizeする"
// observable = "操作後のgridTemplateRowsから得る領域高、separatorのaria-valuenow、contentのaria-hidden"
// observation_boundary = "component-behavior"
// scope = "HomeMonitorContentと共通ChatDockSplitterのresize入力"
// lifecycle = "permanent"
// impact = "分類の表示面積をpointerとkeyboardで安全に調整し、意図せず一覧を閉じない"
// distinction = "click契約testやCSS検査ではpointer lifecycleと数値的な配分を確認できない。実寸法はbrowser検証へ分担する"
// @end-test-value
/** 境界前後の高さだけを変更し、下限、キーボードの操作量、ドラッグ後のクリック抑止を確かめる。 */
test("Monitorは隣接分類の高さを調整しdrag後clickを開閉にしない", async () => {
  await withMonitor(async ({ dom, root }) => {
    dom.window.HTMLElement.prototype.getBoundingClientRect =
      function (): DOMRect {
        const height = this.classList.contains("home-monitor-sections")
          ? 1000
          : this.classList.contains("home-monitor-splitter")
            ? 20
            : 0;
        return {
          x: 0,
          y: 0,
          top: 0,
          left: 0,
          right: 300,
          bottom: height,
          width: 300,
          height,
          /** 試験用の外接矩形は数値だけ使い、JSON表現は不要とする。 */ toJSON:
            () => ({}),
        };
      };
    for (const boundary of [0, 1])
      for (const ending of [
        "pointerup",
        "pointercancel",
        "lostpointercapture",
      ]) {
        await act(async () =>
          root.render(
            createElement(HomeMonitorContent, {
              key: `${boundary}-${ending}`,
              approvalEntries: [],
              runningEntries: [],
              nonRunningEntries: [],
              /** 高さ変更試験ではSessionを開かない。 */ onOpenSession() {},
              /** 高さ変更試験ではメニューを使用しない。 */ onShowContextMenu() {},
            }),
          ),
        );
        const doc = dom.window.document;
        const sections = doc.querySelector<HTMLElement>(
          ".home-monitor-sections",
        )!;
        const splitter = doc.querySelectorAll<HTMLButtonElement>(
          ".home-monitor-splitter",
        )[boundary]!;
        /** グリッドの開いた行に設定された高さ係数を数値として取り出す。 */
        const heights = () =>
          [
            ...sections.style.gridTemplateRows.matchAll(
              /minmax\(48px, ([\d.]+)fr\)/g,
            ),
          ].map((match) => Number(match[1]));
        /** 丸め差を許容し、開いている行数と各行の高さを照合する。 */
        const assertHeights = (values: number[]) => {
          assert.equal(heights().length, values.length);
          heights().forEach((value, index) =>
            assert.ok(Math.abs(value - values[index]!) < 0.001),
          );
        };
        /** 指定の縦位置でポインター操作を合成して反映を待つ。 */
        const pointer = async (type: string, y: number) => {
          const event = new dom.window.MouseEvent(type, {
            bubbles: true,
            button: 0,
            clientY: y,
          });
          Object.defineProperty(event, "pointerId", { value: 1 });
          await act(async () => splitter.dispatchEvent(event));
        };
        /** 境界ボタンに指定のキー押下を渡す。 */
        const key = async (value: string) => {
          await act(async () =>
            splitter.dispatchEvent(
              new dom.window.KeyboardEvent("keydown", {
                key: value,
                bubbles: true,
              }),
            ),
          );
        };
        assert.deepEqual(heights(), [320, 320, 320]);
        await pointer("pointerdown", 400);
        await pointer("pointermove", 496);
        await pointer("pointermove", 592);
        const expected = [320, 320, 320];
        const pairHeight = expected[boundary]! + expected[boundary + 1]!;
        const delta = Math.min(192, expected[boundary + 1]! - 48);
        expected[boundary]! += delta;
        expected[boundary + 1]! -= delta;
        assertHeights(expected);
        assert.equal(
          splitter.getAttribute("aria-valuenow"),
          String(
            Math.round(
              (expected
                .slice(0, boundary + 1)
                .reduce((sum, value) => sum + value, 0) /
                960) *
                100,
            ),
          ),
        );
        await pointer(ending, 592);
        await pointer("pointermove", 700);
        assertHeights(expected);
        if (ending === "pointerup") {
          await act(async () => splitter.click());
          assert.ok(
            [...doc.querySelectorAll(".home-monitor-section-content")].every(
              (item) => item.getAttribute("aria-hidden") === "false",
            ),
          );
        }
        await key("ArrowUp");
        expected[boundary] -= 24;
        expected[boundary + 1] += 24;
        assertHeights(expected);
        await key("Home");
        expected[boundary] = 48;
        expected[boundary + 1] = pairHeight - 48;
        assertHeights(expected);
        await key("End");
        expected[boundary] = pairHeight - 48;
        expected[boundary + 1] = 48;
        assertHeights(expected);
      }
  });
});

// @test-value v2
// kind = "contract"
// claim = "Monitorは縮小時も開いた分類を48px以上へ配分し、親行が収まらない一覧をinertにしてfocusを境界へ戻し、拡大で同じDOMを復帰する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#home-window" }
// fault = "Window縮小で最小高を破る、隠れた一覧へfocusを残す、または拡大時に一覧を再mountしてscroll位置を失う"
// observable = "ResizeObserver通知後のgrid row配分、contentのinert/aria-hidden、document.activeElement、DOM同一性とscrollTop"
// observation_boundary = "component-behavior"
// scope = "HomeMonitorContentの寸法変更と小領域一覧の操作境界"
// lifecycle = "permanent"
// impact = "監視Windowの縮小後も隠れたcontrolを誤操作せず、拡大後に一覧位置を維持して監視を続けられる"
// distinction = "固定寸法のdrag testと別に外側resizeの通知経路を通す。JSDOMの仮想寸法で数値と操作状態を確認し実寸法はbrowserへ分担する"
// @end-test-value
/** ウィンドウ縮小で親行が収まらなくなったら一覧を不活性化し、拡大後も同じDOMとスクロール位置を保つ。 */
test("Monitorは外側resizeで最小高と小領域一覧のfocusを保つ", async () => {
  await withMonitor(async ({ dom, root }) => {
    /** 画面の境界監視が登録されるまではサイズ変更を通知しない。 */
    let notifyResize = () => {};
    let containerHeight = 1000;
    let contentHeight = 80;
    /** 任意の時点でサイズ監視の通知を起こせる代替Observer。 */
    class Observer implements ResizeObserver {
      /** Observeの通知先を試験から呼べるように控える。 */
      constructor(callback: ResizeObserverCallback) {
        notifyResize = () => callback([], this);
      }
      /** 要素のサイズ変更は試験が明示的に通知する。 */
      observe() {}
      /** 監視解除はこのスタブで追跡しない。 */ unobserve() {}
      /** サイズ条件の試験では実際の監視資源を確保しない。 */ disconnect() {}
    }
    dom.window.ResizeObserver = Observer;
    dom.window.HTMLElement.prototype.getBoundingClientRect =
      function (): DOMRect {
        const height = this.classList.contains("home-monitor-sections")
          ? containerHeight
          : this.classList.contains("home-monitor-splitter")
            ? 20
            : this.classList.contains("home-monitor-section-content")
              ? contentHeight
              : this.classList.contains("home-monitor-parent-row")
                ? 36
                : 0;
        return {
          x: 0,
          y: 0,
          top: 0,
          left: 0,
          right: 300,
          bottom: height,
          width: 300,
          height,
          /** 高さを指定した外接矩形を使い、JSON化は行わない。 */ toJSON:
            () => ({}),
        };
      };
    await act(async () =>
      root.render(
        createElement(HomeMonitorContent, {
          approvalEntries: [entry("a")],
          runningEntries: [entry("b")],
          nonRunningEntries: [entry("c")],
          /** 外側リサイズではカードの移動を行わない。 */ onOpenSession() {},
          /** 外側リサイズではメニューの表示を行わない。 */ onShowContextMenu() {},
        }),
      ),
    );
    const doc = dom.window.document;
    const splitter = doc.querySelectorAll<HTMLButtonElement>(
      ".home-monitor-splitter",
    )[0]!;
    await act(async () =>
      splitter.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", { key: "Home", bubbles: true }),
      ),
    );
    containerHeight = 340;
    const content = doc.querySelector<HTMLElement>(
      ".home-monitor-section-content",
    )!;
    const list = content.querySelector<HTMLElement>(".home-monitor-list")!;
    list.scrollTop = 42;
    list
      .querySelector<HTMLButtonElement>(".home-monitor-parent-button")!
      .focus();
    contentHeight = 35;
    await act(async () => notifyResize());
    const heights = [
      ...doc
        .querySelector<HTMLElement>(".home-monitor-sections")!
        .style.gridTemplateRows.matchAll(/minmax\(48px, ([\d.]+)fr\)/g),
    ].map((match) => Number(match[1]));
    assert.ok(heights.every((height) => height >= 48));
    assert.equal(heights.length, 3);
    assert.ok(
      Math.abs(heights.reduce((sum, height) => sum + height, 0) - 300) < 0.001,
    );
    assert.equal(content.hasAttribute("inert"), true);
    assert.equal(content.getAttribute("aria-hidden"), "true");
    assert.equal(doc.activeElement, splitter);
    contentHeight = 80;
    await act(async () => notifyResize());
    assert.equal(doc.querySelector(".home-monitor-section-content"), content);
    assert.equal(content.hasAttribute("inert"), false);
    assert.equal(list.scrollTop, 42);
    assert.equal(doc.activeElement, splitter);
  });
});

// @test-value v2
// kind = "contract"
// claim = "Monitorは縮小後の最初のkeyboardとdragを、現在の高さで補正した境界位置から動かす"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#home-window" }
// fault = "縮小前の高さを入力の起点に使い、最初の操作で境界を表示位置から跳ばす"
// observable = "2つの上下境界それぞれの操作後のgrid row配分とseparatorのaria-valuenow"
// observation_boundary = "component-behavior"
// scope = "HomeMonitorContentの外側resize直後のkeyboard・pointer入力"
// lifecycle = "permanent"
// impact = "Windowを縮めた後も仕切りが操作に追従し、支援技術へ現在の配分を伝える"
// distinction = "固定高での操作とresize通知だけのtestでは、通知前の最初の入力が旧寸法を使う欠陥を検出できない"
// @end-test-value
/** 縮小直後の操作が、以前の高さでなく補正後の境界を起点にすることを確認する。 */
test("Monitorは縮小直後の最初の入力を現在の高さへ合わせる", async () => {
  await withMonitor(async ({ dom, root }) => {
    let containerHeight = 1020;
    dom.window.HTMLElement.prototype.getBoundingClientRect =
      function (): DOMRect {
        const height = this.classList.contains("home-monitor-sections")
          ? containerHeight
          : this.classList.contains("home-monitor-splitter")
            ? 20
            : 0;
        return {
          x: 0,
          y: 0,
          top: 0,
          left: 0,
          right: 300,
          bottom: height,
          width: 300,
          height,
          /** 高さ変更後の矩形を返し、シリアライズは不要とする。 */ toJSON:
            () => ({}),
        };
      };
    for (const index of [0, 1])
      for (const direction of [1, -1])
        for (const input of ["keyboard", "pointer"]) {
          containerHeight = 1020;
          await act(async () =>
            root.render(
              createElement(HomeMonitorContent, {
                key: `${index}-${direction}-${input}`,
                approvalEntries: [],
                runningEntries: [],
                nonRunningEntries: [],
                /** サイズ補正試験にSession移動は含めない。 */ onOpenSession() {},
                /** サイズ補正試験でコンテキストメニューは開かない。 */ onShowContextMenu() {},
              }),
            ),
          );
          const sections = dom.window.document.querySelector<HTMLElement>(
            ".home-monitor-sections",
          )!;
          const splitters = [
            ...sections.querySelectorAll<HTMLButtonElement>(
              ".home-monitor-splitter",
            ),
          ];
          const splitter = splitters[index]!;
          /** 対象の境界にキーを渡し、レイアウト更新を待つ。 */
          const key = async (target: HTMLButtonElement, value: string) => {
            await act(async () =>
              target.dispatchEvent(
                new dom.window.KeyboardEvent("keydown", {
                  key: value,
                  bubbles: true,
                }),
              ),
            );
          };
          /** 指定された画面内の位置でドラッグのイベントを送る。 */
          const pointer = async (type: string, y: number) => {
            const event = new dom.window.MouseEvent(type, {
              bubbles: true,
              button: 0,
              clientY: y,
            });
            Object.defineProperty(event, "pointerId", { value: 1 });
            await act(async () => splitter.dispatchEvent(event));
          };
          containerHeight = 540;
          const start = [500 / 3, 1000 / 3][index]!;
          if (input === "keyboard")
            await key(splitter, direction === 1 ? "ArrowDown" : "ArrowUp");
          else {
            await pointer("pointerdown", 400);
            await pointer("pointermove", 400 + direction * 30);
          }
          const heights = [
            ...sections.style.gridTemplateRows.matchAll(
              /minmax\(48px, ([\d.]+)fr\)/g,
            ),
          ].map((match) => Number(match[1]));
          const boundary = heights
            .slice(0, index + 1)
            .reduce((sum, height) => sum + height, 0);
          const expected = start + direction * (input === "keyboard" ? 24 : 30);
          assert.ok(Math.abs(boundary - expected) < 0.001);
          assert.equal(
            splitter.getAttribute("aria-valuenow"),
            String(Math.round((expected / 500) * 100)),
          );
          if (input === "pointer")
            await pointer("pointerup", 400 + direction * 30);
        }
  });
});

// @test-value v2
// kind = "contract"
// claim = "Monitorの分類開閉とWindow resizeは保存した分類比率を変えず、閉じた分類を除いた高さ調整でも復帰後に各分類の配分を保つ"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#home-window" }
// fault = "閉じた分類の比率が開閉ごとに減衰する、resizeによる最小高補正を保存比率へ混入する、または閉じた分類の比率をdragで変える"
// observable = "反復開閉・縮小拡大・閉じた状態でのキー調整後のgrid row配分とcontentのaria-hidden"
// observation_boundary = "component-behavior"
// scope = "HomeMonitorContentの比率保持と一時的な高さ配分"
// lifecycle = "permanent"
// impact = "監視領域を繰り返し開閉しても一覧が意図せず縮小・非表示にならず、調整した配分へ復帰できる"
// distinction = "既存の単発clickと固定寸法dragでは、開閉・resizeを跨いだ比率の累積変化を検出できない"
// @end-test-value
/** 反復開閉とウィンドウ寸法変更を経ても保存した配分を維持し、閉じた行を除いた調整も扱う。 */
test("Monitorは反復開閉と縮小拡大で分類比率を失わない", async () => {
  await withMonitor(async ({ dom, root }) => {
    let height = 1000;
    /** 代替Observerが登録されるまで寸法変更の通知を起こさない。 */
    let notifyResize = () => {};
    /** 外側の高さを変えた後の通知を試験が明示的に送るためのObserver。 */
    class Observer implements ResizeObserver {
      /** 縮小や拡大の直後に呼べる通知コールバックを保存する。 */
      constructor(callback: ResizeObserverCallback) {
        notifyResize = () => callback([], this);
      }
      /** 寸法計測はObserver内で行わず、差し替えた外接矩形を使う。 */
      observe() {}
      /** このスタブは観測対象の個別解除を記録しない。 */ unobserve() {}
      /** このスタブにはObserver自身が解放する資源はない。 */ disconnect() {}
    }
    dom.window.ResizeObserver = Observer;
    dom.window.HTMLElement.prototype.getBoundingClientRect =
      function (): DOMRect {
        const h = this.classList.contains("home-monitor-sections")
          ? height
          : this.classList.contains("home-monitor-splitter")
            ? 20
            : this.classList.contains("is-closed")
              ? 28
              : 0;
        return {
          x: 0,
          y: 0,
          top: 0,
          left: 0,
          right: 300,
          bottom: h,
          width: 300,
          height: h,
          /** 高さと幅だけを使う合成矩形のため、JSON表現は空にする。 */ toJSON:
            () => ({}),
        };
      };
    await act(async () =>
      root.render(
        createElement(HomeMonitorContent, {
          approvalEntries: [entry("a")],
          runningEntries: [entry("b")],
          nonRunningEntries: [entry("c")],
          /** 分類比率の確認中にSessionを開かない。 */ onOpenSession() {},
          /** 分類比率の確認中にコンテキストメニューを開かない。 */ onShowContextMenu() {},
        }),
      ),
    );
    const doc = dom.window.document;
    const splitters = [
      ...doc.querySelectorAll<HTMLButtonElement>(".home-monitor-splitter"),
    ];
    /** 現在表示されている分類トラックの高さ配分を取り出す。 */
    const heights = () =>
      [
        ...doc
          .querySelector<HTMLElement>(".home-monitor-sections")!
          .style.gridTemplateRows.matchAll(/minmax\(48px, ([\d.]+)fr\)/g),
      ].map((match) => Number(match[1]));
    /** 指定の境界ボタンを押して分類を開閉する。 */
    const click = async (index: number) => {
      await act(async () => splitters[index]!.click());
    };
    /** 指定の境界へ矢印キーを送り、高さ配分を変更する。 */
    const key = async (index: number, key: string) => {
      await act(async () =>
        splitters[index]!.dispatchEvent(
          new dom.window.KeyboardEvent("keydown", { key, bubbles: true }),
        ),
      );
    };
    await key(0, "ArrowDown");
    const expected = heights();
    /** 端数を許容して、計算された高さを期待する配分と比較する。 */
    const assertHeights = (values: number[]) =>
      heights().forEach((value, index) =>
        assert.ok(Math.abs(value - values[index]!) < 0.001),
      );
    for (let i = 0; i < 12; i++)
      for (const boundary of [0, 1]) {
        await click(boundary);
        await act(async () => notifyResize());
        await click(boundary);
        assertHeights(expected);
        assert.ok(
          [...doc.querySelectorAll(".home-monitor-section-content")].every(
            (content) => content.getAttribute("aria-hidden") === "false",
          ),
        );
      }
    height = 252;
    await act(async () => notifyResize());
    assert.ok(heights().every((value) => value >= 48));
    height = 1000;
    await act(async () => notifyResize());
    assertHeights(expected);
    await click(1);
    await key(0, "ArrowDown");
    await click(1);
    const openHeight = 960 - 28;
    const openWeight = expected[0]! + expected[1]!;
    const restoredDelta = (24 * openWeight) / openHeight;
    assertHeights([
      expected[0]! + restoredDelta,
      expected[1]! - restoredDelta,
      expected[2]!,
    ]);
  });
});

// @test-value v2
// kind = "contract"
// claim = "同じ分類に残るSessionは、他Sessionの追加・除去・再分類で列境界を跨いでもDOM・操作focus・Auxiliary scrollと展開を保持する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#home-window" }
// fault = "件数による列再配置で操作中の行を再mountし、disclosureやAuxiliaryのfocusと一覧scrollを失う"
// observable = "他Session更新前後の親行・Auxiliary一覧のDOM identity、activeElement、scrollTop、aria-expanded、親と子のopen引数"
// observation_boundary = "component-behavior"
// scope = "HomeMonitorContentの同分類更新と列再配置時の操作状態"
// lifecycle = "permanent"
// impact = "他Sessionの実行状態が変わっても操作中の会話と閲覧位置を見失わず、対象Auxiliaryを開ける"
// distinction = "分類移動時の展開保持testは同分類の列境界変化を通らない。DOM所有関係とfocus・scrollは型検査や静的CSSだけでは検知できない"
// @end-test-value
/** 他のSessionの変更で列をまたいでも、操作中の同じカードやAuxiliary一覧を再マウントしない。 */
test("Monitorは他Sessionの更新で操作中の行を再mountしない", async () => {
  await withMonitor(async ({ dom, root }) => {
    const doc = dom.window.document;
    const style = doc.createElement("style");
    style.textContent =
      ".home-monitor-list-items { --home-monitor-columns: 2; }";
    doc.head.append(style);
    const a = entry("A"),
      b = entry("B"),
      d = entry("D"),
      e = entry("E");
    const c: HomeMonitorEntry = {
      ...entry("C"),
      auxiliarySessions: Array.from({ length: 12 }, (_, index) => ({
        id: `aux-C-${index}`,
        parentSessionId: "C",
        runState: "idle",
        preview: `Child ${index}`,
        title: "",
        provider: "codex",
        catalogRevision: 1,
        model: "gpt-6.1-sol",
        reasoningEffort: "medium",
        approvalMode: "never",
        codexSandboxMode: "workspace-write",
        codexSpeed: "standard",
        codexReviewer: "user",
        customAgentName: "",
        threadId: "",
        displayAfterMessageIndex: null,
        createdAt: "2026-10-12T00:00:00.000Z",
        updatedAt: "2026-10-12T00:00:00.000Z",
      })),
    };
    const opened: unknown[][] = [];
    /** 実行中・停止の項目とキーを切り替え、対象カードの列を動かす。 */
    const render = (
      running: HomeMonitorEntry[],
      stopped: HomeMonitorEntry[],
      key: string,
    ) =>
      root.render(
        createElement(HomeMonitorContent, {
          key,
          approvalEntries: [],
          runningEntries: running,
          nonRunningEntries: stopped,
          /** 親とAuxiliaryの操作で渡された実際の移動引数を保存する。 */
          onOpenSession: (...args) => opened.push(args),
          /** 他セッション更新による行の同一性を調べる間はメニューを開かない。 */ onShowContextMenu() {},
        }),
      );
    for (const focusTarget of ["disclosure", "auxiliary"]) {
      await act(async () => render([a, b, c, d], [], focusTarget));
      const parent = doc.querySelector<HTMLButtonElement>(
        '[aria-label="Open session: C"]',
      )!;
      const card = parent.closest<HTMLElement>(".home-monitor-card")!;
      const rightColumn = "calc((100% + var(--home-monitor-column-gap)) / 2)";
      assert.equal(
        dom.window
          .getComputedStyle(card.parentElement!)
          .getPropertyValue("--home-monitor-columns")
          .trim(),
        "2",
      );
      assert.equal(card.style.left, rightColumn);
      const disclosure = card.querySelector<HTMLButtonElement>(
        ".home-monitor-disclosure",
      )!;
      await act(async () => disclosure.click());
      const list = card.querySelector<HTMLElement>(
        ".home-monitor-auxiliary-list",
      )!;
      const child = list.querySelectorAll<HTMLButtonElement>("button")[11]!;
      const focused = focusTarget === "disclosure" ? disclosure : child;
      list.scrollTop = 80;
      focused.focus();
      const updates = [
        { running: [b, c, d], stopped: [a], left: "0px" },
        { running: [e, b, c, d], stopped: [a], left: rightColumn },
        { running: [c, d], stopped: [a], left: "0px" },
        { running: [a, b, c, d], stopped: [], left: rightColumn },
      ];
      for (const { running, stopped, left } of updates) {
        await act(async () => render(running, stopped, focusTarget));
        assert.equal(
          card.style.left,
          left,
          "session crosses the column boundary",
        );
        assert.ok(
          doc
            .querySelector('[aria-label="Open session: C"]')
            ?.closest(".home-monitor-card") === card,
          "same session card DOM",
        );
        assert.ok(
          card.querySelector(".home-monitor-auxiliary-list") === list,
          "same auxiliary list DOM",
        );
        assert.ok(
          doc.activeElement === focused,
          "active control retains focus",
        );
        assert.equal(list.scrollTop, 80);
        assert.equal(disclosure.getAttribute("aria-expanded"), "true");
      }
      await act(async () => parent.click());
      await act(async () => child.click());
    }
    assert.deepEqual(opened, [
      ["C"],
      ["C", "aux-C-11"],
      ["C"],
      ["C", "aux-C-11"],
    ]);
  });
});

// @test-value v2
// kind = "contract"
// claim = "Monitorは分類更新後もAuxiliary展開を維持し、親focus操作・stable child IDでの移動・keyboard context menuを区別する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#session-monitor-window" }
// fault = "分類移動で展開を失う、Auxiliary選択を親だけの移動へ変える、またはkeyboard menuで別親IDを渡す"
// observable = "更新前後のdisclosure aria-expandedとAuxiliary button、およびopen/context menu callback引数"
// observation_boundary = "component-behavior"
// scope = "HomeMonitorContentの一覧更新・展開・navigation"
// lifecycle = "permanent"
// impact = "状態が頻繁に変わる監視中も選択中のAuxiliaryへ到達でき、親と子を誤って開かない"
// distinction = "静的markupやprojection testでは検出できないcomponentの更新を跨ぐ操作状態とcallback境界を確認する"
// @end-test-value
/** 分類を変更した後も、展開状態、安定した子IDによる移動、親行のキーボードメニュー操作を区別する。 */
test("Monitorは分類更新を跨いでAuxiliary展開と移動先を維持する", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  const names = [
    "window",
    "document",
    "HTMLElement",
    "Node",
    "navigator",
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
  const entry: HomeMonitorEntry = {
    kind: "agent",
    state: { kind: "running", label: "Running" },
    mainState: { kind: "neutral", label: "Idle" },
    session: {
      id: "parent-1",
      taskTitle: "Task",
      status: "idle",
      runState: "idle",
      updatedAt: "2026-10-12T00:00:00.000Z",
      isPinned: false,
      workspaceLabel: "workspace",
      workspacePath: "C:/workspace",
      sessionKind: "default",
      accessMode: "active",
      sourceSchemaVersion: 5,
      characterId: "mate",
      character: "Mate",
      characterIconPath: "",
      characterThemeColors: { main: "#223344", sub: "#88bbcc" },
    },
    auxiliarySessions: [
      {
        id: "stable-child",
        parentSessionId: "parent-1",
        runState: "running",
        preview: "Child work",
        title: "",
        provider: "codex",
        catalogRevision: 1,
        model: "gpt-6.1-sol",
        reasoningEffort: "medium",
        approvalMode: "never",
        codexSandboxMode: "workspace-write",
        codexSpeed: "standard",
        codexReviewer: "user",
        customAgentName: "",
        threadId: "",
        displayAfterMessageIndex: null,
        createdAt: "2026-10-12T00:00:00.000Z",
        updatedAt: "2026-10-12T00:00:00.000Z",
      },
    ],
  };
  const opened: unknown[][] = [];
  const menus: unknown[][] = [];
  const root = createRoot(dom.window.document.getElementById("root")!);
  /** 同じ親を承認待ちの分類へ移せるよう、分類の入力だけを替える。 */
  const render = (approval: boolean) =>
    root.render(
      createElement(HomeMonitorContent, {
        approvalEntries: approval ? [entry] : [],
        runningEntries: approval ? [] : [entry],
        nonRunningEntries: [],
        /** 親と子を操作したときにそれぞれ渡る識別子を控える。 */
        onOpenSession: (...args) => opened.push(args),
        /** キーボードで開いたメニューの種類・対象・位置を記録する。 */ onShowContextMenu:
          (...args) => menus.push(args),
      }),
    );
  try {
    await act(async () => render(false));
    const document = dom.window.document;
    assert.ok(document.querySelector('[aria-label="Main Idle"]'));
    assert.ok(document.querySelector('[aria-label="Auxiliary Running: 1"]'));
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>(".home-monitor-disclosure")!
        .click(),
    );
    await act(async () => render(true));
    assert.equal(
      document
        .querySelector(".home-monitor-disclosure")
        ?.getAttribute("aria-expanded"),
      "true",
    );
    const parent = document.querySelector<HTMLButtonElement>(
      ".home-monitor-parent-button",
    )!;
    await act(async () => parent.click());
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>(".home-monitor-auxiliary-row")!
        .click(),
    );
    assert.deepEqual(opened, [["parent-1"], ["parent-1", "stable-child"]]);
    await act(async () =>
      parent.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          key: "F10",
          shiftKey: true,
          bubbles: true,
        }),
      ),
    );
    assert.deepEqual(menus, [["agent", "parent-1", { x: 0, y: 0 }]]);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    names.forEach((name, index) => {
      const descriptor = descriptors[index];
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
});
