import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { CrewDeletionDialog } from "../../src/coordination/CrewDeletionDialog.js";
import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";
import type { CrewDeletionStatus } from "../../src-shared/session/session-crew-deletion.js";

// @test-value v2
// kind = "contract"
// claim = "Crew削除確認は対象名を含む可視の問いを読み上げ名に使う。初期focusはCancel、Tabはdialog内で循環し、CancelとEscapeは削除せず起点へfocusを戻す。相談解決後もqueueの拒否を示し、許可後の明示Deleteだけで削除する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md 通常Sessionの起点headerのDelete Crew" }
// fault = "読み上げ名から対象名が落ちる、危険側に初期focusを置く、Tabでdialog外に出る、取消で削除するかfocusが戻らない、相談表示の消失でqueueの拒否を見落とす、または可否更新だけで自動削除する"
// observable = "可視見出しの対象名とdialogの参照先、初期・Tab循環・取消後のactiveElement、端点でのTab既定動作の抑止、取消callbackと削除呼出数、各blocker表示とDelete Crewのdisabled、明示削除後の完了callback"
// observation_boundary = "component-behavior"
// scope = "CrewDeletionDialogの保存statusと削除操作"
// lifecycle = "permanent"
// impact = "未対応相談や受理済み入力を保持したCrewの削除を誤って促さず、core再検証と明示操作を維持する"
// distinction = "storage guardのtestと異なり、状態更新がGUI操作可否へ投影される境界を確認する"
// @end-test-value
/** 削除確認のフォーカス管理と取消、相談解決後のキューによる削除禁止、許可後の明示削除を確認する。 */
test("Crew deletion keeps remaining queue blockers after Coordination resolves", async () => {
  const dom = new JSDOM(
    '<!doctype html><button id="opener">Delete Crew</button><div id="root"></div>',
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
  let status: CrewDeletionStatus = {
    allowed: false,
    blockers: [
      {
        kind: "coordination",
        id: "consult",
        sessionId: "other-branch",
        message: "Unresolved consultation in another branch.",
      },
      { kind: "queue", id: "receipt", message: "Accepted input remains." },
    ],
  };
  /** 相談購読が設定されるまでは状態変更の通知先がない。 */
  let changed = () => {};
  let deletes = 0;
  let closes = 0;
  let completed = 0;
  const api = {
    /** 削除対象とその版を確認したうえで、その時点の削除可否を返す。 */
    async getCrewDeletionStatus(id: string, incarnation: string) {
      assert.equal(id, "root");
      assert.equal(incarnation, "inc");
      return status;
    },
    /** 相談の解決をテストから通知できるよう購読先を保持する。 */
    subscribeCoordinationChanged(listener: () => void) {
      changed = listener;
      return () => {};
    },
    /** 削除可否の切替は相談通知で行うため、実行状態の通知は発行しない。 */
    subscribeLiveSessionRunStatus() {
      return () => {};
    },
    /** 削除要求の対象がルートかを確認し、実行回数を記録する。 */
    async deleteSession(id: string) {
      assert.equal(id, "root");
      deletes += 1;
      return true;
    },
  } as unknown as WithMateWindowApi;
  const root = createRoot(dom.window.document.getElementById("root")!);
  const opener = dom.window.document.getElementById("opener")!;
  /** 取消後も同一の起点からダイアログを開き直せるようにする。 */
  const render = () =>
    root.render(
      createElement(CrewDeletionDialog, {
        api,
        sessionId: "root",
        incarnationId: "inc",
        title: "Root",
        /** 取消回数を記録し、実際に閉じて起点へのフォーカス復帰を観測できるようにする。 */
        onClose() {
          closes += 1;
          root.render(null);
        },
        /** 削除成功後にのみ完了が通知されたことを数える。 */
        onDeleted() {
          completed += 1;
        },
      }),
    );
  /** ダイアログ内の可視ラベルで操作ボタンを探す。 */
  const action = (name: string) =>
    [
      ...dom.window.document.querySelectorAll<HTMLButtonElement>(
        "[role=dialog] button",
      ),
    ].find((button) => button.textContent?.trim() === name)!;
  /** 有効・無効やフォーカスを確認する対象の削除ボタンを取得する。 */
  const deleteButton = () => action("Delete Crew");
  /** 現在のフォーカスにキー操作を送り、ブラウザー既定動作の抑止を観測する。 */
  const pressKey = (key: string, shiftKey = false) => {
    const event = new dom.window.KeyboardEvent("keydown", {
      key,
      shiftKey,
      bubbles: true,
      cancelable: true,
    });
    dom.window.document.activeElement!.dispatchEvent(event);
    return event.defaultPrevented;
  };
  try {
    opener.focus();
    const originalSetTimeout = dom.window.setTimeout;
    const zeroDelayCallbacks: Array<() => void> = [];
    dom.window.setTimeout = (handler, delay, ...args) => {
      if (delay === 0 && typeof handler === "function") {
        zeroDelayCallbacks.push(() => handler(...args));
        return 0;
      }
      return originalSetTimeout.call(dom.window, handler, delay, ...args);
    };
    try {
      await act(async () => render());
      assert.equal(action("Open Coordination").disabled, false);
      // 状態の取得がフォーカス処理より先に完了しても、復旧操作よりキャンセルを優先する。
      zeroDelayCallbacks.forEach((callback) => callback());
    } finally {
      dom.window.setTimeout = originalSetTimeout;
    }
    assert.equal(dom.window.document.activeElement, action("Cancel"));
    assert.equal(deleteButton().disabled, true);
    assert.match(
      dom.window.document.body.textContent!,
      /Unresolved consultation in another branch/,
    );
    status = {
      allowed: false,
      blockers: [
        { kind: "queue", id: "receipt", message: "Accepted input remains." },
      ],
    };
    await act(async () => changed());
    assert.equal(deleteButton().disabled, true);
    assert.match(
      dom.window.document.body.textContent!,
      /Accepted input remains/,
    );
    assert.equal(deletes, 0);
    status = { allowed: true, blockers: [] };
    await act(async () => changed());
    assert.equal(deleteButton().disabled, false);
    assert.equal(deletes, 0);
    const dialog = dom.window.document.querySelector("[role=dialog]")!;
    const question = dialog.querySelector(
      "h1, h2, h3, h4, h5, h6, [role=heading]",
    )!;
    assert.match(question.textContent ?? "", /\bRoot\b/);
    assert.equal(
      dom.window.document.getElementById(
        dialog.getAttribute("aria-labelledby")!,
      ),
      question,
    );
    await act(async () => {
      assert.equal(pressKey("Tab", true), true);
    });
    assert.equal(dom.window.document.activeElement, deleteButton());
    await act(async () => {
      assert.equal(pressKey("Tab"), true);
    });
    assert.equal(dom.window.document.activeElement, action("Cancel"));
    await act(async () => pressKey("Escape"));
    assert.equal(closes, 1);
    assert.equal(deletes, 0);
    assert.equal(dom.window.document.querySelector("[role=dialog]"), null);
    assert.equal(dom.window.document.activeElement, opener);
    await act(async () => render());
    await act(async () => action("Cancel").click());
    assert.equal(closes, 2);
    assert.equal(deletes, 0);
    assert.equal(dom.window.document.querySelector("[role=dialog]"), null);
    assert.equal(dom.window.document.activeElement, opener);
    await act(async () => render());
    await act(async () => deleteButton().click());
    assert.equal(deletes, 1);
    assert.equal(completed, 1);
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
