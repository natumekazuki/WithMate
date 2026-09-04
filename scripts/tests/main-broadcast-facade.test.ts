import assert from "node:assert/strict";
import test from "node:test";

import type { SessionSummaryInvalidation } from "../../src/app-state.js";
import type { ModelCatalogSnapshot } from "../../src/model-catalog.js";
import type { AppSettings } from "../../src/provider-settings-state.js";
import { MainBroadcastFacade } from "../../src-electron/main-broadcast-facade.js";

// @test-value v1
// kind = "contract"
// claim = "MainBroadcastFacadeがsession、catalog、settings、template、windowの各payloadを対応するbroadcastへ渡す"
// oracle = { type = "contract", ref = "MainBroadcastFacade broadcast contract" }
// failure_mode = "broadcast対象のpayloadまたは委譲先が取り違えられ、各windowへ更新が届かない"
// scope = "MainBroadcastFacade broadcast delegation"
// lifecycle = "permanent"
// distinction = "複数broadcast種別を一回のfacade操作列で対応付ける"
// @end-test-value
test("MainBroadcastFacade は payload を組み立てて WindowBroadcastService へ委譲する", () => {
  const calls: string[] = [];
  const facade = new MainBroadcastFacade({
    getWindowBroadcastService: () =>
      ({
        broadcastSessionInvalidation(payload: SessionSummaryInvalidation) {
          calls.push(`invalidated:${payload.scope}:${payload.scope === "ids" ? payload.sessionIds.join(",") : "all"}`);
        },
        broadcastModelCatalog(payload: ModelCatalogSnapshot) {
          calls.push(`catalog:${payload.revision}`);
        },
        broadcastAppSettings(_payload: AppSettings) {
          calls.push("settings");
        },
        broadcastPromptTemplates(payload: unknown[]) {
          calls.push(`templates:${payload.length}`);
        },
        broadcastOpenSessionWindowIds(payload: string[]) {
          calls.push(`windows:${payload.length}`);
        },
        broadcastOpenCompanionReviewWindowIds(payload: string[]) {
          calls.push(`reviews:${payload.length}`);
        },
      }) as never,
    getModelCatalog: () => ({ revision: 3, providers: [] }),
    getAppSettings: () => ({}) as never,
    listPromptTemplates: () => [{ id: "template-1" }] as never,
    listOpenSessionWindowIds: () => ["s-1", "s-2"],
    listOpenCompanionReviewWindowIds: () => ["review-1"],
  });
  facade.broadcastSessions(["s-1"]);
  facade.broadcastModelCatalog();
  facade.broadcastAppSettings();
  facade.broadcastPromptTemplates();
  facade.broadcastOpenSessionWindowIds();
  facade.broadcastOpenCompanionReviewWindowIds();
  assert.deepEqual(calls, ["invalidated:ids:s-1", "catalog:3", "settings", "templates:1", "windows:2", "reviews:1"]);
});

// @test-value v1
// kind = "invariant"
// claim = "invalidation IDが上限超過または空の場合、個別IDを送らずallへ収束する"
// oracle = { type = "contract", ref = "Session invalidation normalization" }
// failure_mode = "過大なinvalidation payloadが切り捨てられ、HomeやSession UIが更新漏れになる"
// scope = "MainBroadcastFacade session invalidation"
// lifecycle = "permanent"
// distinction = "上限超過と空配列の双方をall payloadとして確認する"
// @end-test-value
test("MainBroadcastFacade は invalidation ID の上限超過を all に収束させる", () => {
  const payloads: SessionSummaryInvalidation[] = [];
  const facade = new MainBroadcastFacade({
    getWindowBroadcastService: () => ({
      broadcastSessionInvalidation: (payload: SessionSummaryInvalidation) => payloads.push(payload),
    }) as never,
    getModelCatalog: () => null,
    getAppSettings: () => ({}) as never,
    listPromptTemplates: () => [],
    listOpenSessionWindowIds: () => [],
    listOpenCompanionReviewWindowIds: () => [],
  });
  facade.broadcastSessions(Array.from({ length: 257 }, (_, index) => `session-${index}`));
  facade.broadcastSessions([]);
  assert.deepEqual(payloads, [{ scope: "all" }, { scope: "all" }]);
});
