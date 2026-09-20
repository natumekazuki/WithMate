import assert from "node:assert/strict";
import test from "node:test";

import type { SessionSummaryInvalidation } from "../../src/app-state.js";
import type { ModelCatalogSnapshot } from "../../src/model-catalog.js";
import type { AppSettings } from "../../src/provider-settings-state.js";
import { MainBroadcastFacade } from "../../src-electron/main-broadcast-facade.js";

// @test-value v2
// kind = "contract"
// claim = "MainBroadcastFacade は payload を組み立てて WindowBroadcastService へ委譲する"
// oracle = { type = "contract", ref = "src-electron/main-broadcast-facade.ts" }
// fault = "現行catalogや設定を取得せず、Session更新やWindow一覧のbroadcastを欠落させる"
// observable = "broadcast先に渡されたSession ID、catalog revision、設定、template件数、Window件数"
// observation_boundary = "public-boundary"
// scope = "scripts/tests/main-broadcast-facade.test.ts"
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
    });

    facade.broadcastSessions(["s-1"]);
    await facade.broadcastModelCatalog();
    await facade.broadcastAppSettings();
    await facade.broadcastPromptTemplates();
    facade.broadcastOpenSessionWindowIds();

    assert.deepEqual(calls, ["invalidated:ids:s-1", "catalog:3", "settings", "templates:1", "windows:2"]);
  })();
});

// @test-value v2
// kind = "contract"
// claim = "MainBroadcastFacade は invalidation ID の上限超過を all に収束させる"
// oracle = { type = "contract", ref = "src-electron/main-broadcast-facade.ts" }
// fault = "多数IDを途中で切り詰めて更新通知を失うか、空指定で全体更新を通知しない"
// observable = "257 IDおよび空配列から生成されたscope=allの通知payload"
// observation_boundary = "public-boundary"
// scope = "scripts/tests/main-broadcast-facade.test.ts"
// lifecycle = "permanent"
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
  });

  facade.broadcastSessions(Array.from({ length: 257 }, (_, index) => `session-${index}`));
  facade.broadcastSessions([]);

  assert.deepEqual(payloads, [{ scope: "all" }, { scope: "all" }]);
});
