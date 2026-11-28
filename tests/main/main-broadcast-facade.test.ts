import assert from "node:assert/strict";
import test from "node:test";

import type { SessionSummaryInvalidation } from "../../src-shared/session/session-state.js";
import type { ModelCatalogSnapshot } from "../../src-shared/settings/model-catalog.js";
import type { AppSettings } from "../../src-shared/settings/provider-settings-state.js";
import { MainBroadcastFacade } from "../../src-electron/app/main-broadcast-facade.js";

// @test-value v2
// kind = "contract"
// claim = "MainBroadcastFacade は payload を組み立てて WindowBroadcastService へ委譲する"
// oracle = { type = "contract", ref = "src-electron/app/main-broadcast-facade.ts" }
// fault = "現行catalogや設定を取得せず、Session更新やWindow一覧のbroadcastを欠落させる"
// observable = "broadcast先に渡されたSession ID、catalog全体、設定全体、template配列、Window ID配列"
// observation_boundary = "public-boundary"
// scope = "tests/main/main-broadcast-facade.test.ts"
// lifecycle = "permanent"
// @end-test-value
/** ファサードが現行カタログや設定を取得し、各ウィンドウ通知へ正しい内容を渡すことを確かめる。 */
test("MainBroadcastFacade は payload を組み立てて WindowBroadcastService へ委譲する", () => {
  return (async () => {
    const calls: string[] = [];
    const payloads: {
      catalog?: ModelCatalogSnapshot;
      settings?: AppSettings;
      templates?: unknown[];
      windows?: string[];
    } = {};
    const facade = new MainBroadcastFacade({
      /** 各通知の呼び出しと内容を記録する配信先を用意する。 */
      getWindowBroadcastService: () =>
        ({
          /** 無効化の範囲と対象セッション ID を呼び出し履歴に残す。 */
          broadcastSessionInvalidation(payload: SessionSummaryInvalidation) {
            calls.push(
              `invalidated:${payload.scope}:${payload.scope === "ids" ? payload.sessionIds.join(",") : "all"}`,
            );
          },
          /** 取得したモデルカタログがそのまま渡されたか確認できるようにする。 */
          broadcastModelCatalog(payload: ModelCatalogSnapshot) {
            payloads.catalog = payload;
            calls.push("catalog");
          },
          /** アプリ設定の全体と通知順を保存する。 */
          broadcastAppSettings(payload: AppSettings) {
            payloads.settings = payload;
            calls.push("settings");
          },
          /** テンプレートの一覧と件数を記録する。 */
          broadcastPromptTemplates(payload: unknown[]) {
            payloads.templates = payload;
            calls.push(`templates:${payload.length}`);
          },
          /** 開いているウィンドウ ID の一覧と通知件数を記録する。 */
          broadcastOpenSessionWindowIds(payload: string[]) {
            payloads.windows = payload;
            calls.push(`windows:${payload.length}`);
          },
        }) as never,
      /** 取得結果としてプロバイダーのないカタログを返す。 */
      getModelCatalog: async () => ({ providers: [] }),
      /** 配信内容と照合する四つのプロバイダー設定区分を用意する。 */
      getAppSettings: async () =>
        ({
          providers: {},
          codingProviderSettings: {},
          memoryExtractionProviderSettings: {},
          characterReflectionProviderSettings: {},
        }) as never,
      /** 一つのテンプレートを返し、通知先への引き渡しを確認できるようにする。 */
      listPromptTemplates: async () => [{ id: "template-1" }] as never,
      /** 配信に含める二つのウィンドウ ID を返す。 */
      listOpenSessionWindowIds: () => ["s-1", "s-2"],
    });

    facade.broadcastSessions(["s-1"]);
    await facade.broadcastModelCatalog();
    await facade.broadcastAppSettings();
    await facade.broadcastPromptTemplates();
    facade.broadcastOpenSessionWindowIds();

    assert.deepEqual(calls, [
      "invalidated:ids:s-1",
      "catalog",
      "settings",
      "templates:1",
      "windows:2",
    ]);
    assert.deepEqual(payloads.catalog, { providers: [] });
    assert.deepEqual(payloads.settings, {
      providers: {},
      codingProviderSettings: {},
      memoryExtractionProviderSettings: {},
      characterReflectionProviderSettings: {},
    });
    assert.deepEqual(payloads.templates, [{ id: "template-1" }]);
    assert.deepEqual(payloads.windows, ["s-1", "s-2"]);
  })();
});

// @test-value v2
// kind = "contract"
// claim = "MainBroadcastFacade は invalidation ID の上限超過を all に収束させる"
// oracle = { type = "contract", ref = "src-electron/app/main-broadcast-facade.ts" }
// fault = "多数IDを途中で切り詰めて更新通知を失うか、空指定で全体更新を通知しない"
// observable = "257 IDおよび空配列から生成されたscope=allの通知payload"
// observation_boundary = "public-boundary"
// scope = "tests/main/main-broadcast-facade.test.ts"
// lifecycle = "permanent"
// @end-test-value
/** 通知上限を超える ID 群と空の指定を、どちらも全体無効化として配信する。 */
test("MainBroadcastFacade は invalidation ID の上限超過を all に収束させる", () => {
  const payloads: SessionSummaryInvalidation[] = [];
  const facade = new MainBroadcastFacade({
    /** 無効化の内容だけを受け取る配信先を供給する。 */
    getWindowBroadcastService: () =>
      ({
        /** 二回の無効化通知を到着順に蓄積する。 */
        broadcastSessionInvalidation: (payload: SessionSummaryInvalidation) =>
          payloads.push(payload),
      }) as never,
    /** 無効化では使わないカタログ取得を空データで満たす。 */
    getModelCatalog: () => ({ providers: [] }),
    /** セッション通知と無関係な設定取得には空オブジェクトを返す。 */
    getAppSettings: () => ({}) as never,
    /** テンプレート一覧を通知対象に含めないため、空一覧を用意する。 */
    listPromptTemplates: () => [],
    /** 個別ウィンドウ通知に依存しないよう、一覧は空にする。 */
    listOpenSessionWindowIds: () => [],
  });

  facade.broadcastSessions(
    Array.from({ length: 257 }, (_, index) => `session-${index}`),
  );
  facade.broadcastSessions([]);

  assert.deepEqual(payloads, [{ scope: "all" }, { scope: "all" }]);
});
