import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import type { Root } from "react-dom/client";
import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";
import { createDefaultAppSettings } from "../../src-shared/settings/provider-settings-state.js";
import { SessionWindowRestoreService } from "../../src-electron/windows/session-window-restore-service.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/** 呼び出し元の復元 API を接続した実際の Home をマウントし、復元操作とエラー表示を観測可能にする。 */
async function mountHome(
  restoreApi: Pick<
    WithMateWindowApi,
    | "getSessionWindowRestoreSet"
    | "subscribeSessionWindowRestoreSet"
    | "restoreSessionWindows"
  >,
) {
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
  const api: Partial<WithMateWindowApi> = {
    /** Mate は未作成として応答し、復元の検証に別の既存状態を持ち込まない。 */
    getMateState: async () => "not_created",
    /** Character 一覧を空にし、復元操作以外の選択を必要としない状態を作る。 */
    listCharacters: async () => [],
    /** Home 起動に必要な設定を、シナリオ間で共通の既定値から返す。 */
    getAppSettings: async () => createDefaultAppSettings(),
    /** 設定を固定し、この検証中に更新通知を発生させない。 */
    subscribeAppSettings: () => () => {},
    /** カタログの初期読込には、モデル未登録の Codex Provider を返す。 */
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
    /** カタログを固定し、復元時に Provider の更新を発生させない。 */
    subscribeModelCatalog: () => () => {},
    /** 利用枠は未取得とし、復元対象の読込と無関係な状態を持ち込まない。 */
    getProviderQuotaTelemetry: async () => null,
    /** 利用枠の更新は送らず、購読解除処理だけを返す。 */
    subscribeProviderQuotaTelemetry: () => () => {},
    /** 保存された復元候補とは独立に、通常の Session 一覧は空の最終ページにする。 */
    listSessionSummaryPage: async () => ({
      entries: [],
      hasMore: false,
      nextCursor: null,
    }),
    /** 監視一覧と Auxiliary のデータを空にし、画面の関心を復元操作に絞る。 */
    listSessionMonitorPage: async () => ({
      entries: [],
      auxiliarySessions: [],
      hasMore: false,
      nextCursor: null,
    }),
    /** Character 使用状況は空とし、特定の利用履歴に依存させない。 */
    listSessionCharacterUsage: async () => [],
    /** Session 一覧の再取得を誘発する無効化通知は流さない。 */
    subscribeSessionInvalidation: () => () => {},
    /** テスト中にターン更新を送らず、フォーカスや復元通知による更新だけを観測する。 */
    onSessionTurnUpdated: () => () => {},
    /** 起動時点では開いている Session Window がないものとする。 */
    listOpenSessionWindowIds: async () => [],
    /** 通常ウィンドウの状態変更は通知せず、復元候補専用の通知と切り離す。 */
    subscribeOpenSessionWindowIds: () => () => {},
    /** 稼働中の実行通知は流さず、復元候補の処理に影響させない。 */
    subscribeLiveSessionRunStatus: () => () => {},
    /** Coordination の取得は空リストで終え、追加のページ取得を発生させない。 */
    executeCoordination: async () => ({
      items: [],
      total: 0,
      nextOffset: null,
    }),
    /** 復元操作の検証では Coordination の変更を発生させない。 */
    subscribeCoordinationChanged: () => () => {},
    ...restoreApi,
  };
  dom.window.withmate = api as WithMateWindowApi;
  const container = dom.window.document.getElementById("root")!;
  let root: Root | null = null;
  const { createRoot } = await import("react-dom/client");
  const { default: HomeApp } = await import("../../src/home/HomeApp.js");
  await act(async () => {
    root = createRoot(container);
    root.render(<HomeApp />);
  });
  return {
    dom,
    container,
    /** 復元ボタンをラベルで取得し、復元操作自体が描画されていることを保証する。 */
    restoreButton() {
      const button = Array.from(
        container.querySelectorAll<HTMLButtonElement>("button"),
      ).find(
        (candidate) => candidate.textContent?.trim() === "Restore Sessions",
      );
      assert.ok(button);
      return button;
    },
    /** Home をアンマウントして購読を解除し、DOM と入れ替えたグローバルを元に戻す。 */
    async dispose() {
      await act(async () => root?.unmount());
      for (const [key, value] of Object.entries(previous))
        Object.defineProperty(globalThis, key, { value, configurable: true });
      dom.window.close();
    },
  };
}

// @test-value v2
// kind = "contract"
// claim = "Homeは初期復元候補の取得errorを表示し、障害解消後のfocus再取得で同じserviceの通知・候補・復元操作を回復する"
// oracle = { type = "contract", ref = "docs/features/session-window-restore.md#失敗時の扱い" }
// fault = "読込失敗を0件へ隠すか、回復してもerrorと無効な復元操作を残すか、正常時もfocusごとに再読込する"
// observable = "実Home DOMのerrorとRestore button、serviceのstorage読込回数とopen対象"
// observation_boundary = "consumer"
// scope = "Home restore recovery subscription and focus"
// lifecycle = "permanent"
// impact = "一時障害後もRestore Sessionsが使用できない"
// distinction = "service単体ではHome effectの再取得・通知・feedback・button結線を確認できない"
// @end-test-value
/** 復元候補の取得失敗は操作を無効にして表示し、障害解消後のフォーカスで再取得する。正常になればフォーカスで再読込せず、同じサービスで対象を開く。 */
test("Homeは読込失敗後だけfocusで再取得し、同一serviceの復元操作を回復する", async () => {
  let available = false;
  let loads = 0;
  let onSnapshot: ((sessionIds: string[]) => void) | undefined;
  const opened: string[] = [];
  const service = new SessionWindowRestoreService({
    storage: {
      /** 読込回数を数え、利用可能になるまではストレージ障害を返し、その後は復元待ちの ID を返す。 */
      async loadSnapshot() {
        loads += 1;
        if (!available) throw new Error("Restore storage unavailable");
        return ["pending"];
      },
      /** 候補の読込と消費を検査するため、スナップショットを書き出さない。 */
      async saveSnapshot() {},
    },
    /** 保存済みの ID に対して、復元サービスが扱える Session があるものとする。 */
    getSession: () => ({}),
    /** 既存ウィンドウの復元状態を空にし、保存候補が新たに開かれるようにする。 */
    getSessionWindowRestoreStates: () => new Map(),
    /** サービスが復元できたウィンドウの Session ID を、実ウィンドウを開かず記録する。 */
    async openSessionWindow(sessionId) {
      opened.push(sessionId);
    },
    /** サービスが発行した候補の最新版をコピーして Home のリスナーへ通知する。 */
    onRestoreSetChanged: (sessionIds) => onSnapshot?.([...sessionIds]),
  });
  const home = await mountHome({
    /** Home での候補取得を、テスト用ストレージに接続した実際の復元サービスへ委譲する。 */
    getSessionWindowRestoreSet: () => service.getSnapshot(),
    /** 候補変更の通知先を保持し、Home の購読解除後は配信しない。 */
    subscribeSessionWindowRestoreSet(listener) {
      onSnapshot = listener;
      return () => {
        onSnapshot = undefined;
      };
    },
    /** Home の復元操作を実サービスのスナップショット復元へ委譲する。 */
    restoreSessionWindows: () => service.restoreSnapshot(),
  });
  try {
    assert.match(
      home.container.textContent ?? "",
      /Restore storage unavailable/,
    );
    assert.equal(home.restoreButton().disabled, true);
    assert.equal(loads, 1);
    available = true;
    await act(async () =>
      home.dom.window.dispatchEvent(new home.dom.window.Event("focus")),
    );
    assert.equal(
      home.container.textContent?.includes("Restore storage unavailable"),
      false,
    );
    assert.equal(home.restoreButton().disabled, false);
    assert.equal(loads, 2);
    await act(async () =>
      home.dom.window.dispatchEvent(new home.dom.window.Event("focus")),
    );
    assert.equal(loads, 2);
    await act(async () => home.restoreButton().click());
    assert.deepEqual(opened, ["pending"]);
    assert.equal(home.restoreButton().disabled, true);
  } finally {
    await home.dispose();
  }
});

// @test-value v2
// kind = "contract"
// claim = "Homeは回復通知後の古い初期取得errorを無視し、対象別復元失敗のfeedbackを通常の候補通知で消さない"
// oracle = { type = "contract", ref = "docs/features/session-window-restore.md#失敗時の扱い" }
// fault = "回復済み候補へ遅延errorを重ねるか、候補通知で対象別failureを隠す"
// observable = "Home DOMのfeedback、Restore button、復元API呼出し数"
// observation_boundary = "consumer"
// scope = "Home restore snapshot notification and stale initial failure"
// lifecycle = "permanent"
// @end-test-value
/** 候補通知で回復してから届いた旧取得エラーは表示せず、個別ウィンドウの復元失敗は、その後の通常の候補通知でも保持する。 */
test("回復通知より古い取得errorを表示せず、対象別復元失敗は候補通知後も残す", async () => {
  let rejectInitial!: (error: Error) => void;
  const initial = new Promise<string[]>((_resolve, reject) => {
    rejectInitial = reject;
  });
  let onSnapshot: ((sessionIds: string[]) => void) | undefined;
  let restores = 0;
  const home = await mountHome({
    /** 初回取得の応答を保留し、候補通知より後に古いエラーを返せるようにする。 */
    getSessionWindowRestoreSet: () => initial,
    /** 回復通知と後続の候補更新を送るリスナーを保持し、解除時に破棄する。 */
    subscribeSessionWindowRestoreSet(listener) {
      onSnapshot = listener;
      return () => {
        onSnapshot = undefined;
      };
    },
    /** 復元操作の回数を記録し、保存済み対象を開けなかった結果を返す。 */
    async restoreSessionWindows() {
      restores += 1;
      return {
        requestedSessionIds: ["saved"],
        openedSessionIds: [],
        failures: [{ sessionId: "saved", reason: "open-failed" }],
      };
    },
  });
  try {
    await act(async () => onSnapshot?.(["saved"]));
    await act(async () => rejectInitial(new Error("Stale initial error")));
    assert.equal(
      home.container.textContent?.includes("Stale initial error"),
      false,
    );
    assert.equal(home.restoreButton().disabled, false);
    await act(async () => home.restoreButton().click());
    assert.equal(restores, 1);
    assert.match(
      home.container.textContent ?? "",
      /saved \(Could not open window\)/,
    );
    await act(async () => onSnapshot?.(["saved", "other"]));
    assert.match(
      home.container.textContent ?? "",
      /saved \(Could not open window\)/,
    );
  } finally {
    await home.dispose();
  }
});
