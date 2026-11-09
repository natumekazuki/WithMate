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
// claim = "起票元と回答状態を識別でき、icon操作の名前と詳細情報の開閉・Escape復帰を保ち、正確なAuxiliaryへ移動する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md Coordination; Session Graph v7-ui-v64-authority" }
// fault = "起票者や保存済み回答を取り違える、icon操作の名前を落とす、詳細からkeyboardで戻れない、またはAuxiliaryの親を誤って開く"
// observable = "起票者名/role iconのaccessible name/回答状態、avatar画像、送信iconの操作名、詳細のhidden/expandedとEscape後focus・選択値、openSession引数とfilter request"
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
    assert.match(row.textContent!, /Which approach\?.*Origin Character.*Origin Task/s);
    assert.ok(row.querySelector('[role="img"][aria-label="Auxiliary"]'));
    assert.match(row.textContent!, /Needs Answer/);
    assert.match(dom.window.document.querySelectorAll(".coordination-list-row")[1].textContent!, /Answer Saved/);
    assert.equal(row.querySelector("img")?.getAttribute("src"), "data:image/png;base64,AQ==");
    const all = dom.window.document.querySelector<HTMLButtonElement>('button[aria-label="All Records"]')!;
    await act(async () => all.click());
    assert.equal(all.getAttribute("aria-pressed"), "true");
    assert.ok(requests.some((request) => request.operation === "list" && request.mainSessionId === "viewer-main" && request.userPending === false));
    await act(async () => dom.window.document.querySelector<HTMLButtonElement>(".coordination-list-row")!.click());
    const origin = dom.window.document.querySelector<HTMLButtonElement>(".coordination-detail-origin")!;
    assert.match(origin.textContent!, /Origin Character.*Origin Task/s);
    assert.match(origin.getAttribute("aria-label")!, /Origin Task.*Auxiliary/);
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
    const info = dom.window.document.querySelector<HTMLButtonElement>('button[aria-label="Consultation Details"]')!;
    const metadata = dom.window.document.getElementById(info.getAttribute("aria-controls")!)!;
    assert.equal(info.getAttribute("aria-expanded"), "false");
    assert.equal(metadata.hidden, true);
    await act(async () => info.click());
    assert.equal(info.getAttribute("aria-expanded"), "true");
    assert.equal(metadata.hidden, false);
    assert.equal(metadata.querySelector("time")?.getAttribute("datetime"), record.updatedAt);
    info.blur();
    await act(async () => metadata.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    assert.equal(metadata.hidden, true);
    assert.equal(info.getAttribute("aria-expanded"), "false");
    assert.equal(dom.window.document.activeElement, info);
    assert.ok(checks.every((checkbox) => checkbox.checked));
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
