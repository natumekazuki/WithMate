import assert from "node:assert/strict";
import test from "node:test";

import type { SessionSummaryInvalidation } from "../../src/app-state.js";
import type { ModelCatalogSnapshot } from "../../src/model-catalog.js";
import type { AppSettings } from "../../src/provider-settings-state.js";
import { MainBroadcastFacade } from "../../src-electron/main-broadcast-facade.js";

// @test-value v2
// kind = "contract"
// claim = "MainBroadcastFacadeは非同期のcatalog/settings/prompt取得を待って各broadcastへ委譲する"
// oracle = { type = "contract", ref = "src-electron/main-broadcast-facade.ts#broadcastModelCatalog" }
// fault = "非同期storageのPromiseをpayloadとして送信するかprompt broadcastを取りこぼす"
// observable = "各WindowBroadcastService呼び出しのpayloadと順序"
// observation_boundary = "public-boundary"
// scope = "main-broadcast-facade"
// lifecycle = "permanent"
// @end-test-value
test("MainBroadcastFacade は payload を組み立てて WindowBroadcastService へ委譲する", () => {
  return (async () => {
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
    getModelCatalog: async () => ({ revision: 3, providers: [] }),
    getAppSettings: async () =>
      ({
        providers: {},
        codingProviderSettings: {},
        memoryExtractionProviderSettings: {},
        characterReflectionProviderSettings: {},
      }) as never,
    listPromptTemplates: async () => [{ id: "template-1" }] as never,
    listOpenSessionWindowIds: () => ["s-1", "s-2"],
    listOpenCompanionReviewWindowIds: () => ["review-1"],
    });

    facade.broadcastSessions(["s-1"]);
    await facade.broadcastModelCatalog();
    await facade.broadcastAppSettings();
    await facade.broadcastPromptTemplates();
    facade.broadcastOpenSessionWindowIds();
    facade.broadcastOpenCompanionReviewWindowIds();

    assert.deepEqual(calls, ["invalidated:ids:s-1", "catalog:3", "settings", "templates:1", "windows:2", "reviews:1"]);
  })();
});

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
