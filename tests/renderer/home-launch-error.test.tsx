import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import type { Root } from "react-dom/client";
import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";
import {
  buildNewSession,
  type CreateSessionRequest,
} from "../../src-shared/session/session-state.js";
import { createDefaultAppSettings } from "../../src-shared/settings/provider-settings-state.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// @test-value v2
// kind = "contract"
// claim = "New SessionのModel取得失敗は入力と成否不明の注意を保持し、診断を非modal詳細へ分けて同じ入力で明示再試行できる"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#home-window; docs/design/ui-design-guidelines.md#読込・空・失敗" }
// fault = "取得失敗で入力を消すか、診断全文を通常面へ出すか、詳細の終了でfocusを失うか、再試行を自動送信/二重送信する"
// observable = "実HomeAppのdialog入力、注意、error詳細の本文とfocus/開閉、Retry busyとcreateSession要求列、成功後のWindow起動"
// observation_boundary = "component-behavior"
// scope = "HomeApp New Session create rejection and explicit retry"
// lifecycle = "permanent"
// impact = "一時的な取得障害で入力を失い、長い診断が操作を押し出し、成否不明の無確認再送で会話を重複作成する"
// distinction = "action単体や型検査ではHome stateからdialogへの失敗分類、実詳細surfaceと再試行入力の接続を検出できない"
// @end-test-value
/** 作成の成否が不明なら入力を残し、詳細を閉じてもフォーカスを失わず、同じ要求を明示的に再試行できる。 */
test("New SessionのModel取得失敗は入力を保持し詳細と明示Retryで回復する", async () => {
  const dom = new JSDOM(
    '<!doctype html><html><body><div id="root"></div></body></html>',
    { url: "https://withmate.local/" },
  );
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
  };
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
  })) {
    Object.defineProperty(globalThis, key, { value, configurable: true });
  }
  let rejectFirst!: (error: Error) => void;
  let resolveRetry!: (value: ReturnType<typeof buildNewSession>) => void;
  const first = new Promise<ReturnType<typeof buildNewSession>>(
    (_resolve, reject) => {
      rejectFirst = reject;
    },
  );
  const retry = new Promise<ReturnType<typeof buildNewSession>>((resolve) => {
    resolveRetry = resolve;
  });
  const requests: CreateSessionRequest[] = [];
  const opened: string[] = [];
  const api: Partial<WithMateWindowApi> = {
    /** 調整一覧には該当する項目も続きのページもない状態にする。 */
    executeCoordination: async () => ({
      items: [],
      total: 0,
      nextOffset: null,
    }),
    /** 調整データは変化しないため、購読の破棄に処理を要しない。 */
    subscribeCoordinationChanged: () => () => {},
    /** 起動前に読み込む既存 Session の要約は提供しない。 */
    getSessionSummary: async () => null,
    /** Mate 未作成の Home として起動する。 */
    getMateState: async () => "not_created",
    /** 保存済み Character 一覧は空にする。 */
    listCharacters: async () => [],
    /** 起動時のプロバイダー設定には標準値を使う。 */
    getAppSettings: async () => createDefaultAppSettings(),
    /** 設定を変更しないため、更新を配信しない。 */
    subscribeAppSettings: () => () => {},
    /** 起動先を Codex に固定し、モデル項目はこのケースで選ばない。 */
    getModelCatalog: async () => ({
      providers: [
        {
          id: "codex",
          label: "Codex",
          defaultModelId: "",
          defaultReasoningEffort: "",
          models: [],
        },
      ],
    }),
    /** 起動中のモデル変更通知を配信しない。 */
    subscribeModelCatalog: () => () => {},
    /** クォータ表示のデータは提供しない。 */
    getProviderQuotaTelemetry: async () => null,
    /** クォータ通知を介さずに起動画面を操作する。 */
    subscribeProviderQuotaTelemetry: () => () => {},
    /** 最近・ピン留めともに空のページを返す。 */
    listSessionSummaryPage: async () => ({
      entries: [],
      hasMore: false,
      nextCursor: null,
    }),
    /** Main と Auxiliary がともに存在しない Monitor 一覧を返す。 */
    listSessionMonitorPage: async () => ({
      entries: [],
      auxiliarySessions: [],
      hasMore: false,
      nextCursor: null,
    }),
    /** 起動前の Character 使用履歴を空にする。 */
    listSessionCharacterUsage: async () => [],
    /** 一覧を失効させる通知を配信しない。 */
    subscribeSessionInvalidation: () => () => {},
    /** 進行中のターンの更新は発生させない。 */
    onSessionTurnUpdated: () => () => {},
    /** 作成前に開いている会話はない状態にする。 */
    listOpenSessionWindowIds: async () => [],
    /** 既存ウィンドウの開閉通知は配信しない。 */
    subscribeOpenSessionWindowIds: () => () => {},
    /** 復元するウィンドウの対象はない状態にする。 */
    getSessionWindowRestoreSet: async () => [],
    /** 復元対象は変わらないため、通知を配信しない。 */
    subscribeSessionWindowRestoreSet: () => () => {},
    /** 進行中の実行はなく、実行状態の通知も配信しない。 */
    subscribeLiveSessionRunStatus: () => () => {},
    /** 作成要求を順番に記録し、初回と再試行の完了を別々に制御する。 */
    createSession: async (input) => {
      requests.push(input);
      return requests.length === 1 ? first : retry;
    },
    /** 成功後に開こうとした Session ID を記録する。 */
    openSession: async (id) => {
      opened.push(id);
    },
  };
  dom.window.withmate = api as WithMateWindowApi;
  const container = dom.window.document.getElementById("root")!;
  /** 指定範囲のボタンを表示ラベルで探し、存在しなければ失敗とする。 */
  const button = (root: ParentNode, label: string) => {
    const found = Array.from(
      root.querySelectorAll<HTMLButtonElement>("button"),
    ).find((entry) => entry.textContent?.trim() === label);
    assert.ok(found, label);
    return found;
  };
  let root: Root | null = null;
  try {
    const { createRoot } = await import("react-dom/client");
    const { default: HomeApp } = await import("../../src/home/HomeApp.js");
    await act(async () => {
      root = createRoot(container);
      root.render(<HomeApp />);
    });
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="New session"]')!
        .click(),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const dialog = container.querySelector<HTMLElement>(
      '[role="dialog"][aria-label="New Session"]',
    )!;
    const title = dialog.querySelector<HTMLInputElement>(
      "#launch-session-title",
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLInputElement.prototype,
        "value",
      )!.set!.call(title, "Keep My Task");
      title.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      button(dialog, "Session Folder").click();
    });
    for (
      let attempt = 0;
      button(dialog, "Start").disabled && attempt < 20;
      attempt += 1
    ) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    }
    assert.equal(button(dialog, "Start").disabled, false);
    await act(async () => button(dialog, "Start").click());
    assert.equal(requests.length, 1);
    assert.ok(
      dialog.querySelector('[aria-busy="true"] .button-content-spinner'),
    );
    assert.equal(button(dialog, "Cancel").disabled, false);
    const detail =
      "Error invoking session:createSession: Model discovery failed. Check the provider connection and try again.";
    await act(async () => rejectFirst(new Error(detail)));
    assert.equal(title.value, "Keep My Task");
    assert.equal(
      button(dialog, "Session Folder").getAttribute("aria-pressed"),
      "true",
    );
    assert.match(
      dialog.querySelector('[role="alert"]')?.textContent ?? "",
      /Check Recent Sessions before trying again/,
    );
    assert.equal(dialog.textContent?.includes(detail), false);
    assert.equal(button(dialog, "Retry").disabled, false);
    const trigger = dialog.querySelector<HTMLButtonElement>(
      '[aria-label="Session Creation Error Details"]',
    )!;
    assert.equal(trigger.getAttribute("aria-expanded"), "false");
    await act(async () => trigger.click());
    const panel = dom.window.document.querySelector<HTMLElement>(
      '[role="dialog"][aria-label="Session Creation Error Details"]',
    )!;
    assert.equal(
      panel.querySelector("p")?.textContent,
      `Could not confirm session creation. Check Recent Sessions before trying again. ${detail}`,
    );
    assert.equal(dom.window.document.activeElement, panel);
    await act(async () =>
      panel.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
        }),
      ),
    );
    assert.equal(dom.window.document.getElementById(panel.id), null);
    assert.equal(dom.window.document.activeElement, trigger);
    await act(async () => trigger.click());
    await act(async () =>
      dom.window.document
        .querySelector<HTMLButtonElement>('[aria-label="Close Error Details"]')!
        .click(),
    );
    assert.equal(dom.window.document.activeElement, trigger);
    await act(async () => trigger.click());
    await act(async () => {
      title.focus();
      title.dispatchEvent(
        new dom.window.MouseEvent("pointerdown", { bubbles: true }),
      );
    });
    assert.equal(trigger.getAttribute("aria-expanded"), "false");
    assert.equal(dom.window.document.activeElement, title);
    await act(async () => button(dialog, "Retry").click());
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1], requests[0]);
    assert.equal(button(dialog, "Retry").disabled, true);
    assert.equal(
      dialog.querySelector('[aria-label="Session Creation Error Details"]'),
      null,
    );
    assert.equal(title.value, "Keep My Task");
    await act(async () => button(dialog, "Retry").click());
    assert.equal(requests.length, 2);
    await act(async () =>
      resolveRetry(
        buildNewSession({
          ...requests[1]!,
          id: "created",
          workspacePath: "C:/sessions/created",
          workspaceLabel: "Session Folder",
          branch: "",
          approvalMode: "on-request",
        }),
      ),
    );
    assert.deepEqual(opened, ["created"]);
    assert.equal(
      container.querySelector('[aria-label="New Session"][role="dialog"]'),
      null,
    );
  } finally {
    await act(async () => root?.unmount());
    dom.window.close();
    for (const [key, value] of Object.entries(previous))
      Object.defineProperty(globalThis, key, { value, configurable: true });
  }
});
