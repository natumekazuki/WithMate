import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { CoordinationPane } from "../../src/coordination/CoordinationPane.js";
import type {
  CoordinationRecord,
  CoordinationRequest,
  CoordinationSummary,
} from "../../src-shared/coordination/coordination-contract.js";
import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";

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
    history: [],
    createdAt: "2026-11-07T00:00:00Z",
    updatedAt: "2026-11-07T00:00:00Z",
  };
  let changed = () => {};
  const answers: CoordinationRequest[] = [];
  dom.window.withmate = {
    async getCoordinationIdentity() { return { title: "Origin Session", character: { name: "Origin Character", iconPath: "" } }; },
    subscribeSessionInvalidation() { return () => {}; },
    subscribeCoordinationChanged(listener) {
      changed = () =>
        listener({
          id: record.id,
          crewRootSessionId: record.crewRootSessionId,
          initiator: record.initiator,
        });
      return () => {};
    },
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
    "executeCoordination" | "subscribeCoordinationChanged" | "getCoordinationIdentity" | "subscribeSessionInvalidation"
  > as WithMateWindowApi;
  const root = createRoot(dom.window.document.getElementById("root")!);
  const navigation = { ...record.initiator, id: record.id };
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
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md Coordination; Session Graph v7-ui-v64-authority" }
// fault = "起票者や記録された回答を取り違える、icon操作の名前を落とす、補助操作からkeyboardで戻れない、またはAuxiliaryの親を誤って開く"
// observable = "起票者名/role iconのaccessible name/回答表示、avatar画像、送信iconの操作名、補助操作のEscape後focus・選択値、openSession引数とfilter request"
// observation_boundary = "component-behavior"
// scope = "CoordinationPaneのidentity投影と明示origin移動。metadataとcoordination APIはfixture"
// lifecycle = "permanent"
// impact = "利用者が相談の起票元を取り違え、別会話を開くことを防ぐ"
// distinction = "IPC認可・型検査とidentity hook単体では実paneの表示・通常navigation API接続を確認できない"
// @end-test-value
test("Coordination shows originating identities and opens the exact Auxiliary route", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  const globals = ["window", "document", "HTMLElement", "Node", "navigator", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const saved = globals.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
  globals.forEach((name) => Object.defineProperty(globalThis, name, { configurable: true, value: name === "IS_REACT_ACT_ENVIRONMENT" ? true : dom.window[name] }));
  const initiator = { kind: "auxiliary" as const, sessionId: "origin-aux", incarnationId: "origin-inc" };
  const record: CoordinationRecord = {
    id: "identity-consultation", crewRootSessionId: "crew", kind: "user_decision_required", initiator,
    initiatorTurnId: "origin-turn", originReceiptId: null, caller: null, body: "Which approach?", choices: ["A", "B"],
    respondent: { kind: "user" }, state: "open", answerRevision: 0, answers: [], history: [],
    createdAt: "2026-11-07T00:00:00Z", updatedAt: "2026-11-07T00:00:00Z",
  };
  const { body, choices, answers, history, ...summaryFields } = record;
  const summary: CoordinationSummary = { ...summaryFields, initiatorMainSessionId: "origin-main", bodyPreview: body };
  const requests: CoordinationRequest[] = [];
  const opened: Array<[string, string | undefined]> = [];
  dom.window.withmate = {
    subscribeCoordinationChanged: () => () => {},
    subscribeSessionInvalidation: () => () => {},
    getCoordinationIdentity: async (identity) => {
      assert.deepEqual(identity, initiator);
      return { title: "Origin Task", character: { name: "Origin Character", iconPath: "data:image/png;base64,AQ==" } };
    },
    openSession: async (main, auxiliary) => { opened.push([main, auxiliary]); },
    executeCoordination: async (request) => {
      requests.push(request);
      return request.operation === "get"
        ? { record, initiatorTarget: { ...initiator, mainSessionId: "origin-main", mainIncarnationId: "main-inc" } }
        : { items: [summary, { ...summary, id: "answered", answerRevision: 1 }], total: 2, nextOffset: null };
    },
  } as Pick<WithMateWindowApi, "executeCoordination" | "subscribeCoordinationChanged" | "subscribeSessionInvalidation" | "getCoordinationIdentity" | "openSession"> as WithMateWindowApi;
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    await act(async () => root.render(createElement(CoordinationPane, { sessionId: "viewer-main", active: true, navigation: null })));
    const row = dom.window.document.querySelector<HTMLButtonElement>(".coordination-list-row")!;
    assert.equal(row.querySelector(".coordination-session-title")?.textContent, "Origin Task");
    assert.match(row.querySelector(".visually-hidden")!.textContent!, /Origin Character/);
    assert.ok(row.querySelector('[role="img"][aria-label="Auxiliary"]'));
    assert.ok(dom.window.document.querySelectorAll(".coordination-list-row")[1].querySelector('[role="img"][aria-label="Reply Recorded"]'));
    assert.equal(row.querySelector("img")?.getAttribute("src"), "data:image/png;base64,AQ==");
    const all = dom.window.document.querySelector<HTMLButtonElement>('button[aria-label="All Records"]')!;
    await act(async () => all.click());
    assert.equal(all.getAttribute("aria-pressed"), "true");
    assert.ok(requests.some((request) => request.operation === "list" && request.mainSessionId === "viewer-main" && request.userPending === false));
    await act(async () => dom.window.document.querySelector<HTMLButtonElement>(".coordination-list-row")!.click());
    const origin = dom.window.document.querySelector<HTMLButtonElement>(".coordination-detail-origin")!;
    assert.match(origin.textContent!, /Origin Task/);
    assert.match(origin.getAttribute("aria-label")!, /Origin Character.*Origin Task.*Auxiliary/);
    assert.ok(origin.querySelector('[role="img"][aria-label="Auxiliary"]'));
    await act(async () => origin.click());
    assert.deepEqual(opened, [["origin-main", "origin-aux"]]);
    const checks = [...dom.window.document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    await act(async () => { checks[0].click(); checks[1].click(); });
    assert.ok(checks.every((checkbox) => checkbox.checked));
    assert.equal(requests.filter((request) => request.operation === "answer").length, 0);
    const submit = dom.window.document.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    assert.equal(submit.getAttribute("aria-label"), "Save And Send Answer");
    assert.equal(submit.title, "Save And Send Answer");
    assert.ok(submit.querySelector('svg[aria-hidden="true"]'));
    const actions = dom.window.document.querySelector<HTMLDetailsElement>(".coordination-actions")!;
    const trigger = actions.querySelector<HTMLElement>("summary")!;
    actions.open = true;
    const resolve = actions.querySelector<HTMLButtonElement>("button")!;
    resolve.focus();
    await act(async () => resolve.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    assert.equal(actions.open, false);
    assert.equal(dom.window.document.activeElement, trigger);
    assert.ok(checks.every((checkbox) => checkbox.checked));
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    globals.forEach((name, index) => { const descriptor = saved[index]; if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); });
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
test("Coordination restores its list position and focus after opening a detail", async () => {
  const dom = new JSDOM('<!doctype html><div id="scroll"><div id="root"></div></div>');
  const globals = ["window", "document", "HTMLElement", "Node", "navigator", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const saved = globals.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
  globals.forEach((name) => Object.defineProperty(globalThis, name, { configurable: true, value: name === "IS_REACT_ACT_ENVIRONMENT" ? true : dom.window[name] }));
  const initiator = { kind: "main" as const, sessionId: "main", incarnationId: "inc" };
  const record: CoordinationRecord = {
    id: "last", crewRootSessionId: "main", kind: "blocker", initiator, initiatorTurnId: "turn", originReceiptId: null, caller: null,
    body: "Last consultation", choices: [], respondent: { kind: "user" }, state: "open", answerRevision: 0, answers: [], history: [],
    createdAt: "2026-11-07T00:00:00Z", updatedAt: "2026-11-07T00:00:00Z",
  };
  const { body, choices, answers, history, ...fields } = record;
  const item: CoordinationSummary = { ...fields, initiatorMainSessionId: "main", bodyPreview: body };
  dom.window.withmate = {
    subscribeCoordinationChanged: () => () => {}, subscribeSessionInvalidation: () => () => {},
    getCoordinationIdentity: async () => ({ title: "Main", character: { name: "Character", iconPath: "" } }),
    executeCoordination: async (request: CoordinationRequest) => request.operation === "get" ? { record, initiatorTarget: initiator } : { items: [item], total: 1, nextOffset: null },
  } as unknown as WithMateWindowApi;
  const scroll = dom.window.document.getElementById("scroll") as HTMLDivElement;
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    await act(async () => root.render(createElement(CoordinationPane, { sessionId: "main", active: true, navigation: null, scrollContainerRef: { current: scroll } })));
    scroll.scrollTop = 420;
    await act(async () => dom.window.document.querySelector<HTMLButtonElement>(".coordination-list-row")!.click());
    assert.equal(scroll.scrollTop, 0);
    await act(async () => dom.window.document.querySelector<HTMLButtonElement>('button[aria-label="Back To List"]')!.click());
    assert.equal(scroll.scrollTop, 420);
    assert.equal(dom.window.document.activeElement, dom.window.document.querySelector(".coordination-list-row"));
    await act(async () => dom.window.document.querySelector<HTMLButtonElement>('button[aria-label="All Records"]')!.click());
    assert.equal(scroll.scrollTop, 0);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    globals.forEach((name, index) => { const descriptor = saved[index]; if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); });
  }
});

// @test-value v2
// kind = "contract"
// claim = "最新回答の主体・時刻と配送を確認でき、過去の回答や訂正も履歴から読める"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md Coordinationの回答・操作日時・訂正履歴" }
// fault = "ユーザー回答を識別できなくする、回答日時を失う、または過去回答と訂正を履歴から隠す"
// observable = "最新回答の本文・日時・主体・配送状態と、過去回答・訂正先への操作"
// observation_boundary = "component-behavior"
// scope = "CoordinationPaneの保存回答と履歴。保存と配送読取はfixture"
// lifecycle = "permanent"
// impact = "利用者が自分の回答と経緯を区別できず、確認や訂正先への移動を誤る"
// distinction = "保存coreと型検査はrenderer上の主体・履歴への到達性を確認しない"
// @end-test-value
test("Coordination keeps answer identity and meaningful history available", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  const globals = ["window", "document", "HTMLElement", "Node", "navigator", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const saved = globals.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
  globals.forEach((name) => Object.defineProperty(globalThis, name, { configurable: true, value: name === "IS_REACT_ACT_ENVIRONMENT" ? true : dom.window[name] }));
  const initiator = { kind: "main" as const, sessionId: "main", incarnationId: "inc" };
  const at = "2026-11-07T00:00:00Z";
  const answer = { id: "answer-1", revision: 1, actor: { kind: "user" as const }, body: "First answer", selectedChoices: [], createdAt: at };
  let record: CoordinationRecord = {
    id: "history", crewRootSessionId: "main", kind: "blocker", initiator, initiatorTurnId: "turn", originReceiptId: null, caller: null,
    body: "Question", choices: [], respondent: { kind: "user" }, state: "open", answerRevision: 1, answers: [answer],
    history: [{ operationId: answer.id, operation: "answer", actor: answer.actor, at }], createdAt: at, updatedAt: at,
  };
  let changed = () => {};
  const getIds: string[] = [];
  dom.window.withmate = {
    subscribeSessionInvalidation: () => () => {},
    subscribeCoordinationChanged: (listener: (summary: unknown) => void) => { changed = () => listener({ id: record.id, crewRootSessionId: "main", initiator }); return () => {}; },
    getCoordinationIdentity: async () => ({ title: "Origin", character: { name: "Character", iconPath: "" } }),
    executeCoordination: async (request: CoordinationRequest) => {
      if (request.operation === "get") { getIds.push(request.id); return { record, initiatorTarget: initiator }; }
      return { items: [], total: 0, nextOffset: null };
    },
  } as unknown as WithMateWindowApi;
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    await act(async () => root.render(createElement(CoordinationPane, { sessionId: "main", active: true, navigation: { ...initiator, id: record.id } })));
    const latest = dom.window.document.querySelector('[aria-label="Saved answers"]')!;
    const timestamp = latest.querySelector("time")!;
    assert.equal(timestamp.dateTime, at);
    assert.match(timestamp.getAttribute("aria-label")!, /Your Answer/);
    assert.match(latest.textContent!, /First answer/);
    assert.match(latest.textContent!, /Saved · Not Sent/);
    record = { ...record, state: "corrected", answerRevision: 2,
      answers: [answer, { ...answer, id: "answer-2", revision: 2, body: "Revised answer" }],
      history: [...record.history, { operationId: "answer-2", operation: "answer", actor: answer.actor, at }, { operationId: "correct", operation: "correct", actor: answer.actor, at, correctionId: "corrected" }],
    };
    await act(async () => changed());
    const history = dom.window.document.querySelector<HTMLDetailsElement>("details.artifact-fold")!;
    history.open = true;
    assert.match(history.textContent!, /First answer/);
    const correctionEvent = [...history.querySelectorAll("li")].find((item) => item.textContent?.includes("Corrected"))!;
    assert.ok(correctionEvent.textContent!.includes(new Date(at).toLocaleString("en-US")));
    const correction = [...history.querySelectorAll("button")].find((button) => button.textContent === "Open Correction")!;
    await act(async () => correction.click());
    assert.equal(getIds.at(-1), "corrected");
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    globals.forEach((name, index) => { const descriptor = saved[index]; if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); });
  }
});

// @test-value v2
// kind = "contract"
// claim = "通信失敗は取得済み詳細とdraftを保持し、typed削除済みでは古いrecordを除去してdraftを保ち、遅い取得成功で復活させない"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/839 閉じたWindow・再起動・更新の整合/Crew全体の削除条件" }
// fault = "一時失敗で入力を失う、削除済みrecordを現行として描画する、または削除確認後の遅い成功を適用して古い本文を復活させる"
// observable = "Refresh前後の本文・checkbox状態、削除済みstatusとreadonly draft、古いpromise解決後の本文不在"
// observation_boundary = "component-behavior"
// scope = "CoordinationPaneのtransient/terminal読取結果と世代の整合"
// lifecycle = "permanent"
// impact = "一時障害から入力を守り、削除済み情報を現行状態や送信先として誤表示しない"
// distinction = "backendの削除判定ではrendererの保持方針と遅延応答の描画順を検出できない"
// @end-test-value
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
    history: [],
    createdAt: "2026-11-07T00:00:00Z",
    updatedAt: "2026-11-07T00:00:00Z",
  };
  let mode: "ready" | "transient" | "pending" | "deleted" = "ready";
  let changed = () => {};
  let resolveOld!: (value: { record: CoordinationRecord }) => void;
  const oldRead = new Promise<{ record: CoordinationRecord }>((resolve) => {
    resolveOld = resolve;
  });
  dom.window.withmate = {
    async getCoordinationIdentity() { return { title: "Origin Session", character: { name: "Origin Character", iconPath: "" } }; },
    subscribeSessionInvalidation() { return () => {}; },
    subscribeCoordinationChanged(listener) {
      changed = () => listener({ id: record.id, crewRootSessionId: record.crewRootSessionId, initiator: record.initiator });
      return () => {};
    },
    async executeCoordination(request) {
      if (request.operation !== "get")
        return { items: [], total: 0, nextOffset: null };
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
    "executeCoordination" | "subscribeCoordinationChanged" | "getCoordinationIdentity" | "subscribeSessionInvalidation"
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
    const checkbox = () =>
      dom.window.document.querySelector<HTMLInputElement>(
        'input[type="checkbox"]',
      );
    await act(async () => checkbox()!.click());
    const refresh = () =>
      dom.window.document.querySelector<HTMLButtonElement>('button[aria-label="Refresh Coordination"]')!.click();
    mode = "transient";
    await act(async () => refresh());
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
    await act(async () => refresh());
    mode = "deleted";
    assert.equal(dom.window.document.querySelector<HTMLButtonElement>('button[aria-label="Refresh Coordination"]')!.disabled, true);
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
// fault = "Agent回答のturnIdをidentity IPCへ渡す、Agent回答revisionをユーザー回答済みと扱う、または背景更新で回答変更の入力を隠す"
// observable = "identity request、回答formの表示、送信request、保存回答、背景更新と再編集後の選択値・focus"
// observation_boundary = "component-behavior"
// scope = "CoordinationPaneの回答前・保存後・変更中の遷移。保存と配送読取はfixture"
// lifecycle = "permanent"
// impact = "ユーザーが相談に答えられない、または編集中の判断を失う"
// distinction = "保存coreのrevision検証や型検査ではpaneの編集状態と表示の保持を確認できない"
// @end-test-value
test("Coordination preserves answer editing across saved and background states", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  const globals = ["window", "document", "HTMLElement", "Node", "navigator", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const saved = globals.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
  globals.forEach((name) => Object.defineProperty(globalThis, name, { configurable: true, value: name === "IS_REACT_ACT_ENVIRONMENT" ? true : dom.window[name] }));
  const initiator = { kind: "main" as const, sessionId: "main", incarnationId: "inc" };
  let record: CoordinationRecord = {
    id: "escalated", crewRootSessionId: "main", kind: "blocker", initiator, initiatorTurnId: "turn", originReceiptId: null, caller: null,
    body: "Choose a direction", choices: ["Choice A", "Choice B"], respondent: { kind: "user" }, state: "open", answerRevision: 1,
    answers: [{ id: "agent-answer", revision: 1, actor: { ...initiator, turnId: "agent-turn" }, body: "Agent recommendation", selectedChoices: [], createdAt: "2026-11-07T00:00:00Z" }],
    history: [], createdAt: "2026-11-07T00:00:00Z", updatedAt: "2026-11-07T00:00:00Z",
  };
  let changed = () => {};
  const sent: CoordinationRequest[] = [];
  const identityRequests: unknown[] = [];
  dom.window.withmate = {
    getCoordinationIdentity: async (value: unknown) => { identityRequests.push(value); return { title: "Origin Session", character: { name: "Origin Character", iconPath: "" } }; },
    subscribeSessionInvalidation: () => () => {},
    subscribeCoordinationChanged: (listener: (summary: unknown) => void) => { changed = () => listener({ id: record.id, crewRootSessionId: "main", initiator }); return () => {}; },
    readSessionExecution: async () => ({ ok: true, receiptState: "queued", turnState: null }),
    executeCoordination: async (request: CoordinationRequest) => {
      if (request.operation === "get") return { record, initiatorTarget: initiator };
      if (request.operation === "answer") {
        sent.push(request);
        record = { ...record, answerRevision: 2, answers: [...record.answers, { id: request.operationId, revision: 2, actor: { kind: "user" }, body: request.body, selectedChoices: request.selectedChoices, receiptId: "receipt", createdAt: "2026-11-07T00:01:00Z" }] };
        return { record };
      }
      return { items: [], total: 0, nextOffset: null };
    },
  } as unknown as WithMateWindowApi;
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    await act(async () => root.render(createElement(CoordinationPane, { sessionId: "main", active: true, navigation: { ...initiator, id: record.id } })));
    assert.deepEqual(identityRequests[0], initiator);
    assert.ok(dom.window.document.querySelector('fieldset[aria-label="Your Answer"]'));
    await act(async () => dom.window.document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    await act(async () => dom.window.document.querySelector("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].operation === "answer" && sent[0].expectedAnswerRevision, 1);
    assert.equal(dom.window.document.querySelector("form"), null);
    const answerText = dom.window.document.querySelector('[aria-label="Saved answers"]')!.textContent!;
    assert.equal(answerText.split("Choice A").length - 1, 1);
    assert.match(answerText, /Delivery Queued/);
    const edit = () => dom.window.document.querySelector<HTMLButtonElement>('button[aria-label="Change Answer"]')!;
    await act(async () => edit().click());
    const checks = [...dom.window.document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    assert.equal(checks[0].checked, true);
    await act(async () => checks[1].click());
    checks[1].focus();
    record = { ...record, answerRevision: 3, answers: [...record.answers, { id: "external-answer", revision: 3, actor: { kind: "user" }, body: "Another saved answer", selectedChoices: [], createdAt: "2026-11-07T00:02:00Z" }] };
    await act(async () => changed());
    assert.equal(checks[1].checked, true);
    assert.equal(dom.window.document.activeElement, checks[1]);
    await act(async () => [...dom.window.document.querySelectorAll("button")].find((button) => button.textContent === "Cancel")!.click());
    await act(async () => edit().click());
    assert.equal(dom.window.document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1].checked, true);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    globals.forEach((name, index) => { const descriptor = saved[index]; if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); });
  }
});
