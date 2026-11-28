import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { JSDOM } from "jsdom";
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";

import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";
import type {
  HomeSessionSummary,
  SessionSummaryInvalidation,
  SessionSummaryPageRequest,
} from "../../src-shared/session/session-state.js";
import {
  buildHomeSessionQueryKey,
  HomeSessionQueryGeneration,
} from "../../src/home/home-session-query-generation.js";
import { createEmptyHomeSessionSummariesState } from "../../src/home/home-session-summaries-state.js";
import { useHomeSessionSummaryRefresh } from "../../src/home/use-home-session-summary-refresh.js";

/** 取得スコープ間で比較できるよう、IDと表示名を揃えた最小のSession要約を作る。 */
function summary(id: string): HomeSessionSummary {
  return {
    id,
    taskTitle: id,
    status: "idle",
    updatedAt: "2026-10-01T00:00:00.000Z",
    isPinned: false,
    workspaceLabel: "Session Folder",
    workspacePath: "",
    sessionKind: "default",
    accessMode: "active",
    sourceSchemaVersion: 6,
    characterId: "character",
    character: "Character",
    characterIconPath: "",
    characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
    runState: "idle",
  };
}

/** 検索・通知・フォーカスの操作を仮想タイマーと記録可能なAPIに接続し、要約hookをJSDOMへマウントする。 */
async function mount(t: TestContext) {
  const dom = new JSDOM("<div id='root'></div>", {
    url: "https://withmate.local/",
  });
  const properties = {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const originals = Object.keys(properties).map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  for (const [key, value] of Object.entries(properties))
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pageRequests: SessionSummaryPageRequest[] = [];
  let usageRequests = 0;
  /** 通常は取得を待たせず、競合ケースでだけ待機処理を設定できるようにする。 */
  let beforeRead = async () => {};
  /** hookが登録した通知先へ差し替えるまで通知を受け流す。 */
  let invalidationListener: (
    payload: SessionSummaryInvalidation,
  ) => void = () => {};
  const api: Partial<WithMateWindowApi> = {
    /** 一覧要求のscopeと検索語を記録し、openなら指定IDの要約、それ以外なら検索語を反映した要約を返す。 */
    listSessionSummaryPage: async (input) => {
      const request = input ?? {};
      pageRequests.push(request);
      await beforeRead();
      return {
        entries:
          request.scope === "open"
            ? (request.sessionIds ?? []).map(summary)
            : [summary(request.searchText || "initial")],
        hasMore: false,
        nextCursor: null,
      };
    },
    /** Character利用履歴への要求回数を記録し、必要ならページ取得と同じ時点まで応答を保留する。 */
    listSessionCharacterUsage: async () => {
      usageRequests += 1;
      await beforeRead();
      return [{ characterId: "character", sessionKind: "default" }];
    },
    /** hookの通知リスナーを捕捉し、選んだSession IDをテストから送れるようにする。 */
    subscribeSessionInvalidation: (listener) => {
      invalidationListener = listener;
      return () => {};
    },
  };
  dom.window.withmate = api as WithMateWindowApi;
  const root = createRoot(dom.window.document.getElementById("root")!);
  const initialOpenIds = ["first", "second", "third"];
  const generation = new HomeSessionQueryGeneration(
    buildHomeSessionQueryKey("", initialOpenIds),
  );
  let state = createEmptyHomeSessionSummariesState();
  /** 検索語とopen ID、有効フラグをhookへ渡し、適用後の要約stateを観測する。 */
  function Harness({
    search,
    openIds,
    enabled,
  }: {
    search: string;
    openIds: string[];
    enabled: boolean;
  }) {
    const [current, setCurrent] = useState(
      createEmptyHomeSessionSummariesState,
    );
    state = current;
    useHomeSessionSummaryRefresh({
      enabled,
      sessionSearchText: search,
      openSessionWindowIds: openIds,
      sessionSummariesState: current,
      setSessionSummariesState: setCurrent,
      sessionQueryGeneration: generation,
    });
    return null;
  }
  /** 各ケースの後にrootとDOMを破棄し、仮想タイマーとグローバル設定を元に戻す。 */
  t.after(async () => {
    await act(async () => root.unmount());
    t.mock.timers.reset();
    dom.window.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  return {
    pageRequests,
    /** Character利用履歴の現在までの取得回数を返す。 */
    get usageRequests() {
      return usageRequests;
    },
    /** 最後の描画で得た要約stateを返す。 */
    get state() {
      return state;
    },
    /** 新しいページと利用履歴の応答前に実行する処理を差し替える。 */
    setBeforeRead(handler: () => Promise<void>) {
      beforeRead = handler;
    },
    /** 同じrootへ検索条件と有効状態を反映する。 */
    render: async (search = "", openIds = initialOpenIds, enabled = true) => {
      await act(async () =>
        root.render(
          <Harness search={search} openIds={openIds} enabled={enabled} />,
        ),
      );
    },
    /** 仮想タイマーを120ms進めて遅延要求を発火させる。 */
    tick: async () => {
      await act(async () => {
        t.mock.timers.tick(120);
      });
    },
    /** 指定IDの無効化通知を購読先へ発行する。 */
    notify: async (sessionIds: string[]) => {
      await act(async () => invalidationListener({ scope: "ids", sessionIds }));
    },
    /** ウィンドウのフォーカスイベントを発火させ、全scopeの取得契機を再現する。 */
    focus: async () => {
      await act(async () => {
        dom.window.dispatchEvent(new dom.window.Event("focus"));
      });
    },
  };
}

// @test-value v2
// kind = "contract"
// claim = "適用済み検索には追加待機せずRecent/Pinnedを置換し、初回待機中なら全scopeを初期化する。以降の検索はopenと利用履歴を保持し、focus・open ID変更・再有効化は全scopeを更新する"
// oracle = { type = "contract", ref = "docs/features/home-session-pagination.md 再取得時の状態維持" }
// fault = "適用済み検索に二重待機を加える、初回全scope要求を検索で取消す、検索ごとに検索非依存のreadを発行する、またはfull更新契機を検索専用へ縮小する"
// observable = "hook経由のAPI要求scope・検索語・回数とopen/利用履歴の取得status・保持値"
// observation_boundary = "component-behavior"
// scope = "Home summary hookのdebounceと取得scope選択"
// lifecycle = "permanent"
// impact = "共通検索の入力ごとにCharacter利用履歴とopen Sessionのreadが増え、Random開始とMonitorの取得済み状態が不要に失われる"
// distinction = "pure refresherや型検査では検出できないReact effectと実API境界のscope選択を仮想timerで低負担に確認する"
// @end-test-value
/** 初回とフォーカス・open ID変更・再有効化では全scopeを取得し、以降の検索だけならRecentとPinnedだけを直ちに置換してopenと利用履歴を保持する。 */
test("検索は一覧pageだけを置換し、初回とfull更新契機は独立情報も取得する", async (t) => {
  const home = await mount(t);
  await home.render();
  await home.render("before-initial");
  assert.deepEqual(
    home.pageRequests.map((request) => request.scope),
    ["recent", "pinned", "open"],
  );
  assert.equal(home.usageRequests, 1);
  const open = home.state.openSummaries;
  const usage = home.state.characterUsage;

  await home.render("latest");
  assert.equal(home.state.openStatus, "loaded");
  assert.equal(home.state.characterUsageStatus, "loaded");
  assert.deepEqual(
    home.pageRequests
      .slice(3)
      .map((request) => [request.scope, request.searchText]),
    [
      ["recent", "latest"],
      ["pinned", "latest"],
    ],
  );
  await home.tick();
  assert.equal(home.pageRequests.length, 5);
  assert.equal(home.usageRequests, 1);
  assert.equal(home.state.openSummaries, open);
  assert.equal(home.state.characterUsage, usage);
  assert.equal(home.state.recentPages.length, 1);
  assert.equal(home.state.recentPages[0]?.page.entries[0]?.id, "latest");

  await home.focus();
  assert.equal(home.usageRequests, 2);
  await home.render("latest", ["new"]);
  await home.render("new-query", ["new"]);
  await home.tick();
  assert.equal(home.usageRequests, 3);
  assert.deepEqual(
    home.state.openSummaries.map((entry) => entry.id),
    ["new"],
  );
  await home.render("new-query", ["new"], false);
  await home.render("new-query", ["new"]);
  await home.tick();
  assert.equal(home.usageRequests, 4);
});

// @test-value v2
// kind = "invariant"
// claim = "検索変更前後に届いた通知は失効中のread完了後に最新検索へ反映し、検索変更で独立情報の更新を落とさず重複取得もしない"
// oracle = { type = "contract", ref = "docs/features/home-session-pagination.md 再取得時の状態維持" }
// fault = "query変更時に実行中またはpendingの通知IDを失うか、後続検索要求が独立情報のstatusをloadingのまま残す"
// observable = "open APIへ渡す通知ID集合、利用履歴取得数、最新検索pageと各scopeのloaded状態"
// observation_boundary = "component-behavior"
// scope = "Home summary hookの検索適用とSession通知の競合"
// lifecycle = "permanent"
// impact = "検索中に更新されたopen Sessionの表示やRandomの利用履歴が古いまま残る"
// distinction = "pure admissionのtestでは通らないlayout effect失効・subscription・検索適用の先後をdeferredで制御する"
// @end-test-value
/** 検索変更の前後に届いた通知IDを最終要求へ統合し、新規検索と独立scopeをloadedに戻した後、タイマーが余分な取得を起こさないことを確認する。 */
test("検索変更前後の通知scopeを最新の再取得へ引き継ぐ", async (t) => {
  const home = await mount(t);
  await home.render();
  await home.tick();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  home.setBeforeRead(() => gate);
  await home.notify(["first"]);
  await home.notify(["second"]);
  await home.render("latest");
  await home.notify(["third"]);
  home.setBeforeRead(async () => {});
  await act(async () => release());
  assert.deepEqual(
    home.pageRequests.filter((request) => request.scope === "open").at(-1)
      ?.sessionIds,
    ["first", "second", "third"],
  );
  assert.equal(home.usageRequests, 3);
  assert.equal(home.state.recentPages[0]?.page.entries[0]?.id, "latest");
  assert.equal(home.state.openStatus, "loaded");
  assert.equal(home.state.characterUsageStatus, "loaded");
  await home.tick();
  assert.equal(home.usageRequests, 3);
  assert.equal(
    home.pageRequests.filter((request) => request.scope === "open").length,
    3,
  );
});
