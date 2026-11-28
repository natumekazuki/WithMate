import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { CoordinationNotice } from "../../src/chat/conversation/coordination-notice.js";
import type { CoordinationRecord } from "../../src-shared/coordination/coordination-contract.js";
import type { CoordinationInvalidation } from "../../src-shared/coordination/coordination-window-contract.js";

// @test-value v2
// kind = "contract"
// claim = "表示範囲の相談だけ正確なIDで状態を取得し、現行回答と解決を区別し、通知・再表示・失敗回復・削除と対象変更を反映する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#turn-input-details: 相談状態の取得・状態文言・失敗・消去" }
// fault = "非表示/無関係通知で取得する、改訂番号を回答と誤認する、別IDの遅い応答を表示する、または失敗を解決済みとして扱う"
// observable = "status request列、詳細buttonの状態説明、回答待ち/回答あり/解決/削除の異なる描画形状、loading、再試行、詳細操作のexact identity/ID"
// observation_boundary = "consumer"
// scope = "CoordinationNoticeとuseCoordinationStatus、IPCはfixture"
// lifecycle = "permanent"
// impact = "相談の現在状態を誤認し別の相談へ操作する、または長い履歴で不要な取得を増やす"
// distinction = "storage testや型検査では可視範囲・非同期通知からbuttonと状態への接続を保証できない。小さなDOMで状態遷移を確認する"
// @end-test-value
/** 可視の相談だけを厳密な ID で読み、現行回答・解決・取得不能・削除を区別し、相談切替後に古い応答で表示が戻らないことを確認する。 */
test("consultation notices read visible IDs and distinguish live answer, resolution and unavailable state", async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
  const intersections = new Map<Element, (visible: boolean) => void>();
  /** 要素の表示領域への出入りをテストから通知できる IntersectionObserver の代替。 */
  class Observer {
    /** 監視中の要素へ可視性を渡すコールバックを受け取る。 */
    constructor(
      private callback: (entries: { isIntersecting: boolean }[]) => void,
    ) {}
    private element: Element | null = null;
    /** 要素ごとの可視性通知を登録する。 */
    observe(element: Element) {
      this.element = element;
      intersections.set(element, (visible) =>
        this.callback([{ isIntersecting: visible }]),
      );
    }
    /** 監視を終えた要素の通知を外す。 */
    disconnect() {
      if (this.element) intersections.delete(this.element);
    }
  }
  const globals = {
    window: dom.window,
    document: dom.window.document,
    IntersectionObserver: Observer,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(
    Object.keys(globals).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  const target = {
    kind: "auxiliary" as const,
    sessionId: "aux",
    incarnationId: "exact-inc",
  };
  let record: CoordinationRecord = {
    id: "first",
    crewRootSessionId: "crew",
    kind: "blocker",
    initiator: target,
    initiatorTurnId: "42",
    originReceiptId: null,
    caller: null,
    body: "First question",
    choices: [],
    respondent: { kind: "user" },
    state: "open",
    answerRevision: 2,
    answers: [],
    createdAt: "now",
    updatedAt: "now",
  };
  const requests: unknown[] = [],
    opened: unknown[] = [];
  const listeners = new Set<(summary: CoordinationInvalidation) => void>();
  let failure = false,
    deleted = false;
  let deferred: Promise<unknown> | null = null;
  Object.defineProperty(dom.window, "withmate", {
    value: {
      /** 照会引数を記録し、保留・取得失敗・削除・現在状態を切り替えて返す。 */
      getCoordinationStatus: async (request: unknown) => {
        requests.push(request);
        if (deferred) return deferred;
        if (failure) throw new Error("Read failed");
        if (deleted)
          return {
            error: { code: "COORDINATION_DELETED", message: "Deleted" },
          };
        return {
          state: record.state,
          respondentKind: record.respondent.kind,
          hasAnswer: record.answers.length > 0,
        };
      },
      /** 相談の無効化通知を登録し、解除時は通知先から取り除く。 */
      subscribeCoordinationChanged: (
        listener: (summary: CoordinationInvalidation) => void,
      ) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      /** 詳細操作で渡された相談 ID と起票元を検査用に記録する。 */
      openCoordination: async (request: unknown) => {
        opened.push(request);
      },
    },
  });
  const root = createRoot(dom.window.document.getElementById("root")!);
  /** 指定 ID の無効化を購読先へ送り、React の反映を待つ。 */
  const notify = async (id = record.id) =>
    act(async () => {
      for (const listener of [...listeners])
        listener({ id, crewRootSessionId: "crew", initiator: target });
    });
  /** 監視中の要素すべてに同じ可視性を与え、表示切替後の照会を観察する。 */
  const visible = async (value: boolean) =>
    act(async () => {
      for (const callback of intersections.values()) callback(value);
    });
  const document = dom.window.document;
  /** 詳細ボタンが支援技術に伝える現在の相談状態を読み取る。 */
  const state = () => {
    const description = document
      .querySelector(".coordination-notice-link")
      ?.getAttribute("aria-describedby");
    return description
      ? document.getElementById(description)?.textContent
      : null;
  };
  const shapes = new Set<string>();
  /** 状態アイコンに固有の形があり、支援技術には読み上げ処理を重ねないことを確認する。 */
  const checkShape = () => {
    const icon = document.querySelector(".coordination-notice-state");
    const path = icon?.querySelector("path")?.getAttribute("d");
    assert.ok(
      path && !shapes.has(path),
      `Missing or reused state shape: ${state()}`,
    );
    assert.equal(icon?.getAttribute("aria-hidden"), "true");
    shapes.add(path);
  };
  try {
    await act(async () =>
      root.render(
        <CoordinationNotice
          id="first"
          consultation="First **question**"
          target={target}
        />,
      ),
    );
    assert.equal(requests.length, 0);
    await visible(true);
    assert.deepEqual(requests, [{ id: "first" }]);
    assert.equal(state(), "Awaiting Your Reply"); // 回答を取り下げると、回答がなくても正のリビジョンが残る場合がある。
    checkShape();
    const count = requests.length;
    await notify("unrelated");
    assert.equal(requests.length, count);
    record = { ...record, respondent: { ...target, sessionId: "respondent" } };
    await notify();
    assert.equal(state(), "Awaiting Reply");
    checkShape();
    record = {
      ...record,
      answers: [
        {
          id: "answer",
          revision: 3,
          actor: { kind: "user" },
          body: "Answer",
          selectedChoices: [],
          createdAt: "now",
        },
      ],
    };
    await notify();
    assert.equal(state(), "Reply Recorded");
    checkShape();
    record = { ...record, state: "resolved" };
    await notify();
    assert.equal(state(), "Resolved");
    checkShape();
    record = { ...record, state: "withdrawn" };
    await notify();
    assert.equal(state(), "Withdrawn");
    checkShape();
    record = { ...record, state: "corrected" };
    await notify();
    assert.equal(state(), "Corrected");
    checkShape();
    failure = true;
    await notify();
    assert.equal(state(), "State Unavailable");
    assert.ok(
      dom.window.document.querySelector(
        '[aria-label="Consultation State Error"]',
      ),
    );
    const link = dom.window.document.querySelector<HTMLButtonElement>(
      ".coordination-notice-link",
    )!;
    assert.equal(
      link.getAttribute("aria-label"),
      "Open Consultation: First question",
    );
    assert.equal(
      dom.window.document.getElementById(link.getAttribute("aria-describedby")!)
        ?.textContent,
      "State Unavailable",
    );
    await act(async () => link.click());
    assert.deepEqual(opened, [{ id: "first", ...target }]);
    failure = false;
    record = { ...record, state: "open", answers: [] };
    await act(async () =>
      [...dom.window.document.querySelectorAll("button")]
        .find((button) => button.textContent === "Retry")!
        .click(),
    );
    assert.equal(state(), "Awaiting Reply");
    assert.equal(
      dom.window.document.getElementById(link.getAttribute("aria-describedby")!)
        ?.textContent,
      "Awaiting Reply",
    );
    await visible(false);
    const hiddenCount = requests.length;
    await notify();
    assert.equal(requests.length, hiddenCount);
    record = { ...record, state: "resolved" };
    await visible(true);
    assert.equal(state(), "Resolved");
    let resolveOld!: (value: unknown) => void;
    deferred = new Promise((resolve) => {
      resolveOld = resolve;
    });
    await notify();
    assert.equal(
      dom.window.document
        .querySelector('[aria-label="Loading Consultation State"]')
        ?.getAttribute("aria-busy"),
      "true",
    );
    deferred = null;
    record = { ...record, id: "second", state: "open", answers: [] };
    await act(async () =>
      root.render(
        <CoordinationNotice
          id="second"
          consultation="Second question"
          target={target}
        />,
      ),
    );
    await act(async () =>
      resolveOld({
        state: "withdrawn",
        respondentKind: "user",
        hasAnswer: false,
      }),
    );
    assert.equal(state(), "Awaiting Reply");
    await act(async () =>
      dom.window.document
        .querySelector<HTMLButtonElement>(".coordination-notice-link")!
        .click(),
    );
    assert.deepEqual(opened.at(-1), { id: "second", ...target });
    deleted = true;
    await notify();
    assert.equal(state(), "Deleted");
    checkShape();
    assert.equal(
      dom.window.document.querySelector(
        ".coordination-notice-link .related-session-title",
      )?.textContent,
      "Second question",
    );
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
