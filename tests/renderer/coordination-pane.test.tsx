import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { CoordinationPane } from "../../src/coordination/CoordinationPane.js";
import type {
  CoordinationIdentity,
  CoordinationRecord,
  CoordinationRequest,
  CoordinationSummary,
} from "../../src-shared/coordination/coordination-contract.js";
import type { CoordinationDisplayIdentity } from "../../src-shared/coordination/coordination-window-contract.js";
import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";

// @test-value v2
// kind = "contract"
// claim = "Coordinationは未解決のSession名だけをbusyとして示し、取得済みの相談と回答を待ち・欠損・失敗で隠さない"
// oracle = { type = "contract", ref = "docs/design/ui-design-guidelines.md 読込・空・失敗と操作とアクセシビリティ; docs/design/desktop-ui.md Coordination" }
// fault = "名前待ちを本文に表示する、取得失敗や欠損後もbusyにする、または名前だけの再取得で相談行を再マウントする"
// observable = "各対象名のstatus/busy、相談と回答の表示、確定した名前・欠損・失敗、一覧で保持されたfocus"
// observation_boundary = "component-behavior"
// scope = "CoordinationPaneの一覧・詳細・保存回答。記録とidentity APIはfixture"
// lifecycle = "permanent"
// impact = "相談の相手が確定していなくても本文と既存操作を利用でき、失敗を待ちと誤認しない"
// distinction = "identity hookの検査だけでは待ち表示の場所・accessible statusと本文・focusの保持を検出できない"
// @end-test-value
/** Session 名の取得だけを個別の busy とし、取得待ちや欠落・失敗時も相談本文と回答を保ち、一覧のフォーカスを失わないことを確認する。 */
test("Coordination scopes unresolved Session names to accessible busy indicators", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  const globals = [
    "window",
    "document",
    "HTMLElement",
    "Node",
    "navigator",
    "IS_REACT_ACT_ENVIRONMENT",
  ] as const;
  const saved = globals.map((name) =>
    Object.getOwnPropertyDescriptor(globalThis, name),
  );
  globals.forEach((name) =>
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: name === "IS_REACT_ACT_ENVIRONMENT" ? true : dom.window[name],
    }),
  );
  const doc = dom.window.document;
  const root = createRoot(doc.getElementById("root")!);
  /** 起票者・割当先・回答者を区別する Main Session の識別子を作る。 */
  const identity = (sessionId: string): CoordinationIdentity => ({
    kind: "main",
    sessionId,
    incarnationId: "inc",
  });
  const initiator = identity("origin");
  const respondent = identity("assigned");
  const actor = identity("answerer");
  const at = "2026-11-07T00:00:00Z";
  const record: CoordinationRecord = {
    id: "consultation",
    crewRootSessionId: "origin",
    kind: "blocker",
    initiator,
    initiatorTurnId: "turn",
    originReceiptId: null,
    caller: null,
    body: "Keep the consultation visible",
    choices: [],
    respondent,
    state: "open",
    answerRevision: 1,
    createdAt: at,
    updatedAt: at,
    answers: [
      {
        id: "answer",
        revision: 1,
        actor: { ...actor, turnId: "answer-turn" },
        body: "Keep the saved answer visible",
        selectedChoices: [],
        createdAt: at,
      },
    ],
  };
  const { body, choices, answers, ...fields } = record;
  const summary: CoordinationSummary = {
    ...fields,
    initiatorMainSessionId: "origin",
    bodyPreview: body,
  };
  const pending = new Map<
    string,
    {
      /** 対象の Session 名を取得済みまたは欠落として確定させる。 */ resolve(
        value: CoordinationDisplayIdentity | null,
      ): void;
      /** 対象の Session 名の取得だけを失敗させる。 */ reject(
        error: Error,
      ): void;
    }
  >();
  dom.window.withmate = {
    /** 識別子ごとの取得を保留し、各名前の状態を別々に切り替えられるようにする。 */
    getCoordinationIdentity: (value) =>
      new Promise((resolve, reject) =>
        pending.set(value.sessionId, { resolve, reject }),
      ),
    /** 名前が未解決でも同じ相談を一覧と詳細のどちらからも取得できるようにする。 */
    executeCoordination: async (request) =>
      request.operation === "get"
        ? { record, initiatorTarget: initiator }
        : { items: [summary], total: 1, nextOffset: null },
    /** 名前の完了だけを作用させ、外部の Session 無効化は通知しない。 */
    subscribeSessionInvalidation: () => () => {},
    /** 保存済みの相談は固定し、別の相談更新は配信しない。 */
    subscribeCoordinationChanged: () => () => {},
  } as Pick<
    WithMateWindowApi,
    | "getCoordinationIdentity"
    | "executeCoordination"
    | "subscribeSessionInvalidation"
    | "subscribeCoordinationChanged"
  > as WithMateWindowApi;
  const originLabel = "Loading Originating Session";
  const assignedLabel = "Loading Assigned Session";
  const answerLabel = "Loading Answering Session";
  /** 指定された名前に対応するアクセシブルな busy 表示を、対象箇所に限定して探す。 */
  const busy = (label: string, within: ParentNode = doc) =>
    within.querySelector(
      `[role="status"][aria-label="${label}"][aria-busy="true"]`,
    );
  try {
    await act(async () =>
      root.render(
        createElement(CoordinationPane, {
          sessionId: "origin",
          active: true,
          navigation: null,
        }),
      ),
    );
    const row = doc.querySelector<HTMLButtonElement>(".coordination-list-row")!;
    assert.ok(busy(originLabel, row));
    assert.match(
      row.getAttribute("aria-label")!,
      /Keep the consultation visible.*Loading Originating Session/,
    );
    assert.match(row.textContent!, /Keep the consultation visible/);
    assert.doesNotMatch(row.textContent!, /Loading/);
    row.focus();
    await act(async () =>
      pending.get("origin")!.resolve({
        title: "Origin Task",
        character: { name: "Origin", iconPath: "" },
      }),
    );
    assert.match(row.textContent!, /Origin Task/);
    assert.equal(busy(originLabel), null);
    assert.equal(doc.activeElement, row);
    await act(async () =>
      root.render(
        createElement(CoordinationPane, {
          key: "fresh-detail",
          sessionId: "origin",
          active: true,
          navigation: { ...initiator, id: record.id },
        }),
      ),
    );
    const origin = doc.querySelector<HTMLButtonElement>(
      ".coordination-detail-origin",
    )!;
    assert.ok(busy(originLabel, origin));
    assert.match(
      origin.getAttribute("aria-label")!,
      /^Open Origin: Loading Originating Session/,
    );
    assert.ok(busy(assignedLabel, doc.querySelector(".coordination-parties")!));
    assert.ok(
      busy(answerLabel, doc.querySelector('[aria-label="Saved answers"]')!),
    );
    assert.match(
      doc.body.textContent!,
      /Keep the consultation visible.*Keep the saved answer visible/s,
    );
    assert.doesNotMatch(doc.body.textContent!, /Loading/);
    await act(async () => {
      pending.get("origin")!.resolve({
        title: "Origin Task",
        character: { name: "Origin", iconPath: "" },
      });
      pending.get("assigned")!.resolve(null);
      pending.get("answerer")!.reject(new Error("Identity lookup failed"));
    });
    assert.equal(busy(assignedLabel), null);
    assert.equal(busy(answerLabel), null);
    assert.match(origin.getAttribute("aria-label")!, /Origin Task/);
    assert.match(
      doc.body.textContent!,
      /Assigned To: Session Unavailable.*Session Identity Unavailable.*Keep the saved answer visible/s,
    );
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    globals.forEach((name, index) => {
      const descriptor = saved[index];
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
});

// @test-value v2
// kind = "contract"
// claim = "回答中の取り下げとpane非表示で選択入力を保持し、結果不明の明示retryは同じoperationIdと回答先へ送る"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/839 回答・取り下げ・下書き" }
// fault = "更新でdraftを消す、取り下げ後回答を拒否する、またはretryで別operationIdを生成して重複回答を作る"
// observable = "再表示後checkbox状態、Withdrawn理由、executeCoordinationへ渡る2回の回答request"
// observation_boundary = "component-behavior"
// scope = "CoordinationPaneの更新・表示切替・回答retry"
// lifecycle = "permanent"
// impact = "相談への入力消失、誤配送、回答の重複保存を防ぐ"
// distinction = "保存coreの整合性や型検査ではrendererのdraftと送信identity保持を確認できない"
// @end-test-value
/** 回答にチェックを付けて非表示中に相談が取り下げられても選択を保ち、結果不明からの明示再試行が同じ要求を送ることを確認する。 */
test("Coordination keeps withdrawn answer draft and retries the same operation", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  const globals = [
    "window",
    "document",
    "HTMLElement",
    "Node",
    "navigator",
    "IS_REACT_ACT_ENVIRONMENT",
  ] as const;
  const saved = globals.map((name) =>
    Object.getOwnPropertyDescriptor(globalThis, name),
  );
  globals.forEach((name) =>
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: name === "IS_REACT_ACT_ENVIRONMENT" ? true : dom.window[name],
    }),
  );
  let record: CoordinationRecord = {
    id: "consultation",
    crewRootSessionId: "main",
    kind: "blocker",
    initiator: { kind: "main", sessionId: "main", incarnationId: "inc" },
    initiatorTurnId: "origin-turn",
    originReceiptId: null,
    caller: null,
    body: "Which implementation?",
    choices: ["Choice A"],
    respondent: { kind: "user" },
    state: "open",
    answerRevision: 0,
    answers: [],
    createdAt: "2026-11-07T00:00:00Z",
    updatedAt: "2026-11-07T00:00:00Z",
  };
  /** 購読開始前は取り下げを通知せず、登録後に試験から発火できるよう差し替える。 */
  let changed = () => {};
  const answers: CoordinationRequest[] = [];
  dom.window.withmate = {
    /** 取り下げと送信失敗を観察する間も起票元の名前は解決済みにする。 */
    async getCoordinationIdentity() {
      return {
        title: "Origin Session",
        character: { name: "Origin Character", iconPath: "" },
      };
    },
    /** 相談の変更通知とは無関係な Session 無効化を発生させない。 */
    subscribeSessionInvalidation() {
      return () => {};
    },
    /** 取り下げ後の再取得を発火できるよう、対象相談の変更通知を取り出す。 */
    subscribeCoordinationChanged(listener) {
      changed = () =>
        listener({
          id: record.id,
          crewRootSessionId: record.crewRootSessionId,
          initiator: record.initiator,
        });
      return () => {};
    },
    /** 現在の相談を返し、初回回答だけは要求を記録してから応答消失を再現する。 */
    async executeCoordination(request) {
      if (request.operation === "get") return { record };
      if (request.operation === "answer") {
        answers.push(request);
        if (answers.length === 1) throw new Error("Response lost");
        return { record };
      }
      return { items: [], total: 0, nextOffset: null };
    },
  } as Pick<
    WithMateWindowApi,
    | "executeCoordination"
    | "subscribeCoordinationChanged"
    | "getCoordinationIdentity"
    | "subscribeSessionInvalidation"
  > as WithMateWindowApi;
  const root = createRoot(dom.window.document.getElementById("root")!);
  const navigation = { ...record.initiator, id: record.id };
  /** 同じ相談詳細を維持したまま、ペインの表示だけを切り替える。 */
  const render = (active: boolean) =>
    root.render(
      createElement(CoordinationPane, {
        sessionId: "main",
        active,
        navigation,
      }),
    );
  try {
    await act(async () => render(true));
    /** 再表示後のダイアログから下書きの選択肢を取得する。 */
    const checkbox = () =>
      dom.window.document.querySelector<HTMLInputElement>(
        'input[type="checkbox"]',
      )!;
    await act(async () => checkbox().click());
    await act(async () => render(false));
    record = {
      ...record,
      state: "withdrawn",
      withdrawalReason: "Scope changed",
    };
    await act(async () => render(true));
    await act(async () => changed());
    assert.equal(checkbox().checked, true);
    assert.match(
      dom.window.document.body.textContent!,
      /Withdrawn.*Scope changed/s,
    );
    await act(async () =>
      dom.window.document
        .querySelector("form")!
        .dispatchEvent(
          new dom.window.Event("submit", { bubbles: true, cancelable: true }),
        ),
    );
    assert.equal(answers.length, 1);
    assert.equal(checkbox().checked, true);
    const retry = [...dom.window.document.querySelectorAll("button")].find(
      (button) => button.textContent === "Retry Same Operation",
    )!;
    await act(async () => retry.click());
    assert.equal(answers.length, 2);
    assert.deepEqual(answers[0], answers[1]);
    assert.equal(answers[0]!.operation, "answer");
    assert.equal("id" in answers[0]! && answers[0]!.id, "consultation");
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    globals.forEach((name, index) => {
      const descriptor = saved[index];
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
});

// @test-value v2
// kind = "contract"
// claim = "起票元と記録された回答を識別でき、補助操作からEscapeで戻れ、正確なAuxiliaryへ移動する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md Coordination" }
// fault = "起票者や記録された回答を取り違える、icon操作の名前を落とす、補助操作からkeyboardで戻れない、またはAuxiliaryの親を誤って開く"
// observable = "起票者名/role iconのaccessible name/回答表示、avatar画像、送信iconの操作名、補助操作のEscape後focus・選択値、openSession引数とfilter request"
// observation_boundary = "component-behavior"
// scope = "CoordinationPaneのidentity投影と明示origin移動。metadataとcoordination APIはfixture"
// lifecycle = "permanent"
// impact = "利用者が相談の起票元を取り違え、別会話を開くことを防ぐ"
// distinction = "IPC認可・型検査とidentity hook単体では実paneの表示・通常navigation API接続を確認できない"
// @end-test-value
/** 起票元の名前と操作名を表示し、補助操作から Escape で戻っても選択を保ち、正しい Main・Auxiliary の組で移動することを確認する。 */
test("Coordination shows originating identities and opens the exact Auxiliary route", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  const globals = [
    "window",
    "document",
    "HTMLElement",
    "Node",
    "navigator",
    "IS_REACT_ACT_ENVIRONMENT",
  ] as const;
  const saved = globals.map((name) =>
    Object.getOwnPropertyDescriptor(globalThis, name),
  );
  globals.forEach((name) =>
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: name === "IS_REACT_ACT_ENVIRONMENT" ? true : dom.window[name],
    }),
  );
  const initiator = {
    kind: "auxiliary" as const,
    sessionId: "origin-aux",
    incarnationId: "origin-inc",
  };
  const record: CoordinationRecord = {
    id: "identity-consultation",
    crewRootSessionId: "crew",
    kind: "user_decision_required",
    initiator,
    initiatorTurnId: "origin-turn",
    originReceiptId: null,
    caller: null,
    body: "Which approach?",
    choices: ["A", "B"],
    respondent: { kind: "user" },
    state: "open",
    answerRevision: 0,
    answers: [],
    createdAt: "2026-11-07T00:00:00Z",
    updatedAt: "2026-11-07T00:00:00Z",
  };
  const { body, choices, answers, ...summaryFields } = record;
  const summary: CoordinationSummary = {
    ...summaryFields,
    initiatorMainSessionId: "origin-main",
    bodyPreview: body,
  };
  const requests: CoordinationRequest[] = [];
  const opened: Array<[string, string | undefined]> = [];
  dom.window.withmate = {
    /** 表示と明示移動の確認では外部の相談変更を通知しない。 */
    subscribeCoordinationChanged: () => () => {},
    /** 起票元の取得を余計な Session 更新で繰り返さない。 */
    subscribeSessionInvalidation: () => () => {},
    /** 起票者の Auxiliary 識別子を受け取ったことを検査し、表示用の名前と画像を返す。 */
    getCoordinationIdentity: async (identity) => {
      assert.deepEqual(identity, initiator);
      return {
        title: "Origin Task",
        character: {
          name: "Origin Character",
          iconPath: "data:image/png;base64,AQ==",
        },
      };
    },
    /** 起票元ボタンが実際に指定した親 Main と Auxiliary を記録する。 */
    openSession: async (main, auxiliary) => {
      opened.push([main, auxiliary]);
    },
    /** 詳細では Auxiliary と親 Main の経路を返し、一覧ではフィルターの要求を検査できるよう保存する。 */
    executeCoordination: async (request) => {
      requests.push(request);
      return request.operation === "get"
        ? {
            record,
            initiatorTarget: {
              ...initiator,
              mainSessionId: "origin-main",
              mainIncarnationId: "main-inc",
            },
          }
        : {
            items: [summary, { ...summary, id: "answered", answerRevision: 1 }],
            total: 2,
            nextOffset: null,
          };
    },
  } as Pick<
    WithMateWindowApi,
    | "executeCoordination"
    | "subscribeCoordinationChanged"
    | "subscribeSessionInvalidation"
    | "getCoordinationIdentity"
    | "openSession"
  > as WithMateWindowApi;
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    await act(async () =>
      root.render(
        createElement(CoordinationPane, {
          sessionId: "viewer-main",
          active: true,
          navigation: null,
        }),
      ),
    );
    const row = dom.window.document.querySelector<HTMLButtonElement>(
      ".coordination-list-row",
    )!;
    assert.equal(
      row.querySelector(".coordination-session-title")?.textContent,
      "Origin Task",
    );
    assert.match(
      row.querySelector(".visually-hidden")!.textContent!,
      /Origin Character/,
    );
    assert.ok(row.querySelector('[role="img"][aria-label="Auxiliary"]'));
    assert.ok(
      dom.window.document
        .querySelectorAll(".coordination-list-row")[1]
        .querySelector('[role="img"][aria-label="Reply Recorded"]'),
    );
    assert.equal(
      row.querySelector("img")?.getAttribute("src"),
      "data:image/png;base64,AQ==",
    );
    const all = dom.window.document.querySelector<HTMLButtonElement>(
      'button[aria-label="All Records"]',
    )!;
    await act(async () => all.click());
    assert.equal(all.getAttribute("aria-pressed"), "true");
    assert.ok(
      requests.some(
        (request) =>
          request.operation === "list" &&
          request.mainSessionId === "viewer-main" &&
          request.userPending === false,
      ),
    );
    await act(async () =>
      dom.window.document
        .querySelector<HTMLButtonElement>(".coordination-list-row")!
        .click(),
    );
    const origin = dom.window.document.querySelector<HTMLButtonElement>(
      ".coordination-detail-origin",
    )!;
    assert.match(origin.textContent!, /Origin Task/);
    assert.match(
      origin.getAttribute("aria-label")!,
      /Origin Character.*Origin Task.*Auxiliary/,
    );
    assert.ok(origin.querySelector('[role="img"][aria-label="Auxiliary"]'));
    await act(async () => origin.click());
    assert.deepEqual(opened, [["origin-main", "origin-aux"]]);
    const checks = [
      ...dom.window.document.querySelectorAll<HTMLInputElement>(
        'input[type="checkbox"]',
      ),
    ];
    await act(async () => {
      checks[0].click();
      checks[1].click();
    });
    assert.ok(checks.every((checkbox) => checkbox.checked));
    assert.equal(
      requests.filter((request) => request.operation === "answer").length,
      0,
    );
    const submit = dom.window.document.querySelector<HTMLButtonElement>(
      'button[type="submit"]',
    )!;
    assert.equal(submit.getAttribute("aria-label"), "Save And Send Answer");
    assert.equal(submit.title, "Save And Send Answer");
    assert.ok(submit.querySelector('svg[aria-hidden="true"]'));
    const actions = dom.window.document.querySelector<HTMLDetailsElement>(
      ".coordination-actions",
    )!;
    const trigger = actions.querySelector<HTMLElement>("summary")!;
    actions.open = true;
    const resolve = actions.querySelector<HTMLButtonElement>("button")!;
    resolve.focus();
    await act(async () =>
      resolve.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
        }),
      ),
    );
    assert.equal(actions.open, false);
    assert.equal(dom.window.document.activeElement, trigger);
    assert.ok(checks.every((checkbox) => checkbox.checked));
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    globals.forEach((name, index) => {
      const descriptor = saved[index];
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
});

// @test-value v2
// kind = "contract"
// claim = "一覧から詳細を開いて戻ると元の行とスクロール位置へ戻り、filter変更では先頭から表示する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md right pane の本文scrollbarとCoordination一覧" }
// fault = "詳細への遷移で一覧位置を失う、戻った時に選択行へfocusを返さない、または別filterを途中から表示する"
// observable = "共有スクロール領域のscrollTopと、詳細から戻った後のactiveElement"
// observation_boundary = "component-behavior"
// scope = "CoordinationPaneと右ペインから渡される共有スクロール領域。取得APIとスクロール座標はJSDOMのfixture"
// lifecycle = "permanent"
// impact = "多件数の相談を確認するたびに読みかけの位置を探し直すことを防ぐ"
// distinction = "型検査や保存APIのtestでは一覧と詳細の往復時の位置・focusを確認できない"
// @end-test-value
/** 一覧から詳細に入ると先頭に移り、戻ると元のスクロール位置と選択行のフォーカスが復帰することを確認する。 */
test("Coordination restores its list position and focus after opening a detail", async () => {
  const dom = new JSDOM(
    '<!doctype html><div id="scroll"><div id="root"></div></div>',
  );
  const globals = [
    "window",
    "document",
    "HTMLElement",
    "Node",
    "navigator",
    "IS_REACT_ACT_ENVIRONMENT",
  ] as const;
  const saved = globals.map((name) =>
    Object.getOwnPropertyDescriptor(globalThis, name),
  );
  globals.forEach((name) =>
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: name === "IS_REACT_ACT_ENVIRONMENT" ? true : dom.window[name],
    }),
  );
  const initiator = {
    kind: "main" as const,
    sessionId: "main",
    incarnationId: "inc",
  };
  const record: CoordinationRecord = {
    id: "last",
    crewRootSessionId: "main",
    kind: "blocker",
    initiator,
    initiatorTurnId: "turn",
    originReceiptId: null,
    caller: null,
    body: "Last consultation",
    choices: [],
    respondent: { kind: "user" },
    state: "open",
    answerRevision: 0,
    answers: [],
    createdAt: "2026-11-07T00:00:00Z",
    updatedAt: "2026-11-07T00:00:00Z",
  };
  const { body, choices, answers, ...fields } = record;
  const item: CoordinationSummary = {
    ...fields,
    initiatorMainSessionId: "main",
    bodyPreview: body,
  };
  dom.window.withmate = {
    /** 一覧と詳細の移動中に外部の相談更新を発生させない。 */ subscribeCoordinationChanged:
      () => () => {},
    /** 戻る操作とは別経路の Session 変更は通知しない。 */ subscribeSessionInvalidation:
      () => () => {},
    /** 一覧と詳細で同じ解決済みの起票元を表示する。 */
    getCoordinationIdentity: async () => ({
      title: "Main",
      character: { name: "Character", iconPath: "" },
    }),
    /** 一覧で選んだ1件を、その詳細を開いた時も同じ識別子で返す。 */
    executeCoordination: async (request: CoordinationRequest) =>
      request.operation === "get"
        ? { record, initiatorTarget: initiator }
        : { items: [item], total: 1, nextOffset: null },
  } as unknown as WithMateWindowApi;
  const scroll = dom.window.document.getElementById("scroll") as HTMLDivElement;
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    await act(async () =>
      root.render(
        createElement(CoordinationPane, {
          sessionId: "main",
          active: true,
          navigation: null,
          scrollContainerRef: { current: scroll },
        }),
      ),
    );
    scroll.scrollTop = 420;
    await act(async () =>
      dom.window.document
        .querySelector<HTMLButtonElement>(".coordination-list-row")!
        .click(),
    );
    assert.equal(scroll.scrollTop, 0);
    await act(async () =>
      dom.window.document
        .querySelector<HTMLButtonElement>('button[aria-label="Back To List"]')!
        .click(),
    );
    assert.equal(scroll.scrollTop, 420);
    assert.equal(
      dom.window.document.activeElement,
      dom.window.document.querySelector(".coordination-list-row"),
    );
    await act(async () =>
      dom.window.document
        .querySelector<HTMLButtonElement>('button[aria-label="All Records"]')!
        .click(),
    );
    assert.equal(scroll.scrollTop, 0);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    globals.forEach((name, index) => {
      const descriptor = saved[index];
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
});

// @test-value v2
// kind = "contract"
// claim = "回答の取得後に編集を止めても未送信draftを保持し、現在の引継ぎ理由と訂正先を確認できる"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md Coordinationの回答・引継ぎ・訂正" }
// fault = "取得後も回答を編集させる、編集中のdraftを消す、または現在の引継ぎ理由・訂正先を失う"
// observable = "queue通知後の回答の本文・日時・主体・取得状態、readonly draft、引継ぎ理由と訂正先への操作"
// observation_boundary = "component-behavior"
// scope = "CoordinationPaneの回答確定と現在の相談情報。保存と配送読取はfixture"
// lifecycle = "permanent"
// impact = "確定済み回答の再編集、入力消失、必要な引継ぎ情報への到達不能を防ぐ"
// distinction = "保存coreと型検査はrenderer上の編集制御・draft保持・現在の相談情報を確認しない"
// @end-test-value
/** 起票元が保存回答を取得したら編集を止める一方、未送信下書きと引継ぎ理由・訂正先への導線を保つことを確認する。 */
test("Coordination preserves the draft and current context when the answer is received", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  const globals = [
    "window",
    "document",
    "HTMLElement",
    "Node",
    "navigator",
    "IS_REACT_ACT_ENVIRONMENT",
  ] as const;
  const saved = globals.map((name) =>
    Object.getOwnPropertyDescriptor(globalThis, name),
  );
  globals.forEach((name) =>
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: name === "IS_REACT_ACT_ENVIRONMENT" ? true : dom.window[name],
    }),
  );
  const initiator = {
    kind: "main" as const,
    sessionId: "main",
    incarnationId: "inc",
  };
  const at = "2026-11-07T00:00:00Z";
  const answer = {
    id: "answer-1",
    revision: 1,
    actor: { kind: "user" as const },
    body: "First answer",
    selectedChoices: [],
    createdAt: at,
    receiptId: "receipt",
  };
  let record: CoordinationRecord = {
    id: "history",
    crewRootSessionId: "main",
    kind: "blocker",
    initiator,
    initiatorTurnId: "turn",
    originReceiptId: null,
    caller: null,
    body: "Question",
    choices: ["Choice A", "Choice B"],
    respondent: { kind: "user" },
    state: "open",
    answerRevision: 1,
    answers: [answer],
    escalationBody: "Please choose a direction",
    createdAt: at,
    updatedAt: at,
  };
  /** 受付通知の購読が登録されるまで更新を発火しない。 */
  let queueChanged = () => {};
  const getIds: string[] = [];
  dom.window.withmate = {
    /** 回答の受領は受付通知経由で扱い、Session 無効化は送らない。 */
    subscribeSessionInvalidation: () => () => {},
    /** 相談の更新通知を併用せず、受付通知から詳細を再取得する経路を検査する。 */
    subscribeCoordinationChanged: () => () => {},
    /** 起票元 Session の受付状態が変わったことを、任意の時点で通知できるようにする。 */
    onSessionTurnQueueChanged: (listener: (id: string) => void) => {
      queueChanged = () => listener(initiator.sessionId);
      return () => {};
    },
    /** Turn 進行の通知は使わず、受付の更新だけを発火する。 */
    onSessionTurnUpdated: () => () => {},
    /** 記録された回答の配送状態を受付済み・実行なしとして返す。 */
    readSessionExecution: async () => ({
      ok: true,
      receiptState: "queued",
      turnState: null,
    }),
    /** 相談の起票元を固定の名前で解決する。 */
    getCoordinationIdentity: async () => ({
      title: "Origin",
      character: { name: "Character", iconPath: "" },
    }),
    /** 現在の相談詳細を返し、訂正リンクが要求した相談 ID を記録する。 */
    executeCoordination: async (request: CoordinationRequest) => {
      if (request.operation === "get") {
        getIds.push(request.id);
        return { record, initiatorTarget: initiator };
      }
      return { items: [], total: 0, nextOffset: null };
    },
  } as unknown as WithMateWindowApi;
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    await act(async () =>
      root.render(
        createElement(CoordinationPane, {
          sessionId: "main",
          active: true,
          navigation: { ...initiator, id: record.id },
        }),
      ),
    );
    const latest = dom.window.document.querySelector(
      '[aria-label="Saved answers"]',
    )!;
    const timestamp = latest.querySelector("time")!;
    assert.equal(timestamp.dateTime, at);
    assert.match(timestamp.getAttribute("aria-label")!, /Your Answer/);
    assert.match(latest.textContent!, /First answer/);
    assert.match(latest.textContent!, /Delivery Queued/);
    assert.match(
      dom.window.document.body.textContent!,
      /Please choose a direction/,
    );
    await act(async () =>
      dom.window.document
        .querySelector<HTMLButtonElement>('button[aria-label="Change Answer"]')!
        .click(),
    );
    await act(async () =>
      dom.window.document
        .querySelector<HTMLInputElement>('input[type="checkbox"]')!
        .click(),
    );
    record = {
      ...record,
      state: "corrected",
      correctionId: "corrected",
      answers: [{ ...answer, acquiredAt: at }],
    };
    await act(async () => queueChanged());
    assert.match(
      dom.window.document.querySelector('[aria-label="Saved answers"]')!
        .textContent!,
      /Received/,
    );
    assert.equal(
      dom.window.document.querySelector('button[aria-label="Change Answer"]'),
      null,
    );
    const preserved = dom.window.document.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Unsent answer draft"]',
    )!;
    assert.equal(preserved.readOnly, true);
    assert.match(preserved.value, /Choice A/);
    const correction = [...dom.window.document.querySelectorAll("button")].find(
      (button) => button.textContent === "Open Correction",
    )!;
    await act(async () => correction.click());
    assert.equal(getIds.at(-1), "corrected");
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    globals.forEach((name, index) => {
      const descriptor = saved[index];
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
});

// @test-value v2
// kind = "contract"
// claim = "通信失敗と再取得は取得済み詳細とdraftを保つ。更新中の操作はfocusを保ち重複起動せず、typed削除済みではdraftを残し遅い取得成功で古いrecordを復活させない"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md Coordinationの詳細・削除通知; docs/design/ui-design-guidelines.md 操作とアクセシビリティ、ボタン" }
// fault = "一時失敗や再取得で入力を失う、更新操作でfocus喪失または重複読取、削除確認後に遅い成功を適用する"
// observable = "Refreshのbusy・focusと読取回数、本文・checkbox状態、削除済みstatusとreadonly draft、古いpromise解決後の本文不在"
// observation_boundary = "component-behavior"
// scope = "CoordinationPaneのtransient/terminal読取結果と世代の整合"
// lifecycle = "permanent"
// impact = "一時障害から入力を守り、削除済み情報を現行状態や送信先として誤表示しない"
// distinction = "backendの削除判定ではrendererの保持方針と遅延応答の描画順を検出できない"
// @end-test-value
/** 一時的な読込失敗と更新中は本文・入力・フォーカスを保ち、削除確定後は下書きだけを残して古い成功を適用しないことを確認する。 */
test("Coordination distinguishes transient reads from terminal deletion without stale revival", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  const globals = [
    "window",
    "document",
    "HTMLElement",
    "Node",
    "navigator",
    "IS_REACT_ACT_ENVIRONMENT",
  ] as const;
  const saved = globals.map((name) =>
    Object.getOwnPropertyDescriptor(globalThis, name),
  );
  globals.forEach((name) =>
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: name === "IS_REACT_ACT_ENVIRONMENT" ? true : dom.window[name],
    }),
  );
  const record: CoordinationRecord = {
    id: "deleted-consultation",
    crewRootSessionId: "main",
    kind: "blocker",
    initiator: { kind: "main", sessionId: "main", incarnationId: "inc" },
    initiatorTurnId: "origin-turn",
    originReceiptId: null,
    caller: null,
    body: "Saved consultation body",
    choices: ["Keep this draft"],
    respondent: { kind: "user" },
    state: "open",
    answerRevision: 0,
    answers: [],
    createdAt: "2026-11-07T00:00:00Z",
    updatedAt: "2026-11-07T00:00:00Z",
  };
  let mode: "ready" | "transient" | "pending" | "deleted" = "ready";
  let detailReads = 0;
  /** 購読前は通知せず、登録後は削除の確認を発火できるようにする。 */
  let changed = () => {};
  let resolveOld!: (value: { record: CoordinationRecord }) => void;
  const oldRead = new Promise<{ record: CoordinationRecord }>((resolve) => {
    resolveOld = resolve;
  });
  dom.window.withmate = {
    /** 相談が読めている間の起票元表示を固定し、記録の取得失敗と切り離す。 */
    async getCoordinationIdentity() {
      return {
        title: "Origin Session",
        character: { name: "Origin Character", iconPath: "" },
      };
    },
    /** 削除結果以外の Session 無効化を起こさない。 */
    subscribeSessionInvalidation() {
      return () => {};
    },
    /** 対象相談に変更があったことを手動で発火できるようにする。 */
    subscribeCoordinationChanged(listener) {
      changed = () =>
        listener({
          id: record.id,
          crewRootSessionId: record.crewRootSessionId,
          initiator: record.initiator,
        });
      return () => {};
    },
    /** 詳細読込の回数を数え、成功・一時失敗・保留・確定削除を指定した順で返す。 */
    async executeCoordination(request) {
      if (request.operation !== "get")
        return { items: [], total: 0, nextOffset: null };
      detailReads += 1;
      if (mode === "transient") throw new Error("Connection unavailable");
      if (mode === "pending") return oldRead;
      if (mode === "deleted")
        return {
          error: {
            code: "COORDINATION_DELETED",
            message: "Coordination was deleted.",
          },
        };
      return { record };
    },
  } as Pick<
    WithMateWindowApi,
    | "executeCoordination"
    | "subscribeCoordinationChanged"
    | "getCoordinationIdentity"
    | "subscribeSessionInvalidation"
  > as WithMateWindowApi;
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    await act(async () =>
      root.render(
        createElement(CoordinationPane, {
          sessionId: "main",
          active: true,
          navigation: { ...record.initiator, id: record.id },
        }),
      ),
    );
    /** 更新前後で選択を照合し、削除でフォームが外れた場合は null を許す。 */
    const checkbox = () =>
      dom.window.document.querySelector<HTMLInputElement>(
        'input[type="checkbox"]',
      );
    await act(async () => checkbox()!.click());
    const refresh = dom.window.document.querySelector<HTMLButtonElement>(
      'button[aria-label="Refresh Coordination"]',
    )!;
    mode = "transient";
    await act(async () => refresh.click());
    assert.match(
      dom.window.document.body.textContent!,
      /Saved consultation body/,
    );
    assert.equal(checkbox()!.checked, true);
    assert.equal(
      dom.window.document.querySelector('[aria-label="Deleted Coordination"]'),
      null,
    );
    mode = "pending";
    const beforeRefresh = detailReads;
    refresh.focus();
    await act(async () => refresh.click());
    assert.equal(detailReads, beforeRefresh + 1);
    assert.equal(refresh.getAttribute("aria-disabled"), "true");
    assert.equal(dom.window.document.activeElement, refresh);
    assert.equal(checkbox()!.checked, true);
    assert.match(
      dom.window.document.body.textContent!,
      /Saved consultation body/,
    );
    await act(async () => refresh.click());
    assert.equal(detailReads, beforeRefresh + 1);
    mode = "deleted";
    await act(async () => changed());
    assert.ok(
      dom.window.document.querySelector('[aria-label="Deleted Coordination"]'),
    );
    assert.doesNotMatch(
      dom.window.document.body.textContent!,
      /Saved consultation body/,
    );
    assert.equal(dom.window.document.querySelector("form"), null);
    const draft = dom.window.document.querySelector<HTMLTextAreaElement>(
      '[aria-label="Unsent answer draft"]',
    )!;
    assert.equal(draft.value, "Keep this draft");
    assert.equal(draft.readOnly, true);
    await act(async () => resolveOld({ record }));
    assert.doesNotMatch(
      dom.window.document.body.textContent!,
      /Saved consultation body/,
    );
    assert.ok(
      dom.window.document.querySelector('[aria-label="Deleted Coordination"]'),
    );
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    globals.forEach((name, index) => {
      const descriptor = saved[index];
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
});

// @test-value v2
// kind = "contract"
// claim = "Agent回答の起票元を正しく読み、引き継がれた相談へユーザーが回答でき、回答変更中の背景更新でもdraftを失わない"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md Coordinationの回答・下書き" }
// fault = "Agent回答のturnIdをidentity IPCへ渡す、引継ぎ後のrevisionでユーザーが回答できない、または背景更新で回答変更の入力を隠す"
// observable = "identity request、回答formの表示、送信request、保存回答、背景更新と再編集後の選択値・focus"
// observation_boundary = "component-behavior"
// scope = "CoordinationPaneの回答前・保存後・変更中の遷移。保存と配送読取はfixture"
// lifecycle = "permanent"
// impact = "ユーザーが相談に答えられない、または編集中の判断を失う"
// distinction = "保存coreのrevision検証や型検査ではpaneの編集状態と表示の保持を確認できない"
// @end-test-value
/** Agent 回答の主体を Session として照会し、引継ぎ後に現行 revision で回答でき、背景更新で再編集の入力やフォーカスを失わないことを確認する。 */
test("Coordination preserves answer editing across saved and background states", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  const globals = [
    "window",
    "document",
    "HTMLElement",
    "Node",
    "navigator",
    "IS_REACT_ACT_ENVIRONMENT",
  ] as const;
  const saved = globals.map((name) =>
    Object.getOwnPropertyDescriptor(globalThis, name),
  );
  globals.forEach((name) =>
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: name === "IS_REACT_ACT_ENVIRONMENT" ? true : dom.window[name],
    }),
  );
  const initiator = {
    kind: "main" as const,
    sessionId: "main",
    incarnationId: "inc",
  };
  const respondent = {
    kind: "auxiliary" as const,
    sessionId: "respondent",
    incarnationId: "respondent-inc",
  };
  let record: CoordinationRecord = {
    id: "escalated",
    crewRootSessionId: "main",
    kind: "blocker",
    initiator,
    initiatorTurnId: "turn",
    originReceiptId: null,
    caller: null,
    body: "Choose a direction",
    choices: ["Choice A", "Choice B"],
    respondent,
    state: "open",
    answerRevision: 1,
    answers: [
      {
        id: "agent-answer",
        revision: 1,
        actor: { ...respondent, turnId: "agent-turn" },
        body: "Agent recommendation",
        selectedChoices: [],
        createdAt: "2026-11-07T00:00:00Z",
      },
    ],
    createdAt: "2026-11-07T00:00:00Z",
    updatedAt: "2026-11-07T00:00:00Z",
  };
  /** 購読が設定されたら、引継ぎや背景保存を試験から通知できるようにする。 */
  let changed = () => {};
  const sent: CoordinationRequest[] = [];
  const identityRequests: unknown[] = [];
  dom.window.withmate = {
    /** 起票元と回答者の識別照会を記録し、Turn ID が混ざっていないか検査できるようにする。 */
    getCoordinationIdentity: async (value: unknown) => {
      identityRequests.push(value);
      return {
        title: "Origin Session",
        character: { name: "Origin Character", iconPath: "" },
      };
    },
    /** 相談だけの背景更新と区別するため Session 無効化は通知しない。 */
    subscribeSessionInvalidation: () => () => {},
    /** 現行の相談を読み直す変更通知を、引継ぎ時と再編集中に発火できるようにする。 */
    subscribeCoordinationChanged: (listener: (summary: unknown) => void) => {
      changed = () =>
        listener({ id: record.id, crewRootSessionId: "main", initiator });
      return () => {};
    },
    /** 保存済みユーザー回答の配送はまだ受付待ちとして扱う。 */
    readSessionExecution: async () => ({
      ok: true,
      receiptState: "queued",
      turnState: null,
    }),
    /** 詳細は現時点の記録を返し、回答受付時は要求を保存して新しい revision の回答を返す。 */
    executeCoordination: async (request: CoordinationRequest) => {
      if (request.operation === "get")
        return { record, initiatorTarget: initiator };
      if (request.operation === "answer") {
        sent.push(request);
        record = {
          ...record,
          answerRevision: 3,
          answers: [
            {
              id: request.operationId,
              revision: 3,
              actor: { kind: "user" },
              body: request.body,
              selectedChoices: request.selectedChoices,
              receiptId: "receipt",
              createdAt: "2026-11-07T00:01:00Z",
            },
          ],
        };
        return { record };
      }
      return { items: [], total: 0, nextOffset: null };
    },
  } as unknown as WithMateWindowApi;
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    await act(async () =>
      root.render(
        createElement(CoordinationPane, {
          sessionId: "main",
          active: true,
          navigation: { ...initiator, id: record.id },
        }),
      ),
    );
    assert.ok(
      identityRequests.some(
        (value) => JSON.stringify(value) === JSON.stringify(initiator),
      ),
    );
    assert.ok(
      identityRequests.some(
        (value) => JSON.stringify(value) === JSON.stringify(respondent),
      ),
    );
    assert.ok(
      identityRequests.every((value) => !("turnId" in (value as object))),
    );
    assert.equal(
      dom.window.document.querySelector('fieldset[aria-label="Your Answer"]'),
      null,
    );
    record = {
      ...record,
      respondent: { kind: "user" },
      answerRevision: 2,
      answers: [],
      escalationBody: "Please decide",
    };
    await act(async () => changed());
    assert.ok(
      dom.window.document.querySelector('fieldset[aria-label="Your Answer"]'),
    );
    await act(async () =>
      dom.window.document
        .querySelector<HTMLInputElement>('input[type="checkbox"]')!
        .click(),
    );
    await act(async () =>
      dom.window.document
        .querySelector("form")!
        .dispatchEvent(
          new dom.window.Event("submit", { bubbles: true, cancelable: true }),
        ),
    );
    assert.equal(sent.length, 1);
    assert.equal(
      sent[0].operation === "answer" && sent[0].expectedAnswerRevision,
      2,
    );
    assert.equal(dom.window.document.querySelector("form"), null);
    const answerText = dom.window.document.querySelector(
      '[aria-label="Saved answers"]',
    )!.textContent!;
    assert.equal(answerText.split("Choice A").length - 1, 1);
    assert.match(answerText, /Delivery Queued/);
    /** 保存後や変更のキャンセル後に、回答を再び開く操作を探す。 */
    const edit = () =>
      dom.window.document.querySelector<HTMLButtonElement>(
        'button[aria-label="Change Answer"]',
      )!;
    await act(async () => edit().click());
    const checks = [
      ...dom.window.document.querySelectorAll<HTMLInputElement>(
        'input[type="checkbox"]',
      ),
    ];
    assert.equal(checks[0].checked, true);
    await act(async () => checks[1].click());
    checks[1].focus();
    record = {
      ...record,
      answerRevision: 4,
      answers: [
        {
          id: "external-answer",
          revision: 4,
          actor: { kind: "user" },
          body: "Another saved answer",
          selectedChoices: [],
          createdAt: "2026-11-07T00:02:00Z",
        },
      ],
    };
    await act(async () => changed());
    assert.equal(checks[1].checked, true);
    assert.equal(dom.window.document.activeElement, checks[1]);
    await act(async () =>
      [...dom.window.document.querySelectorAll("button")]
        .find((button) => button.textContent === "Cancel")!
        .click(),
    );
    await act(async () => edit().click());
    assert.equal(
      dom.window.document.querySelectorAll<HTMLInputElement>(
        'input[type="checkbox"]',
      )[1].checked,
      true,
    );
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    globals.forEach((name, index) => {
      const descriptor = saved[index];
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
});
