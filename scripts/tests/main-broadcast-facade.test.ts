import assert from "node:assert/strict";
import test from "node:test";

import type { CharacterProfile, SessionSummary } from "../../src/app-state.js";
import type { ModelCatalogSnapshot } from "../../src/model-catalog.js";
import type { AppSettings } from "../../src/provider-settings-state.js";
import { MainBroadcastFacade } from "../../src-electron/main-broadcast-facade.js";

test("MainBroadcastFacade は payload を組み立てて WindowBroadcastService へ委譲する", () => {
  const calls: string[] = [];
  const facade = new MainBroadcastFacade({
    getWindowBroadcastService: () =>
      ({
        broadcastSessionSummaries(payload: SessionSummary[]) {
          calls.push(`summaries:${payload.length}`);
        },
        broadcastSessionInvalidation(payload: string[]) {
          calls.push(`invalidated:${payload.join(",")}`);
        },
        broadcastCharacters(payload: CharacterProfile[]) {
          calls.push(`characters:${payload.length}`);
        },
        broadcastModelCatalog(payload: ModelCatalogSnapshot) {
          calls.push(`catalog:${payload.revision}`);
        },
        broadcastAppSettings(_payload: AppSettings) {
          calls.push("settings");
        },
        broadcastOpenSessionWindowIds(payload: string[]) {
          calls.push(`windows:${payload.length}`);
        },
      }) as never,
    listSessionSummaries: () => [{ id: "s-1" }] as never,
    listCharacters: () => [{ id: "c-1" }] as never,
    getModelCatalog: () => ({ revision: 3, providers: [] }),
    getAppSettings: () =>
      ({
        providers: {},
        codingProviderSettings: {},
        memoryExtractionProviderSettings: {},
        characterReflectionProviderSettings: {},
      }) as never,
    listOpenSessionWindowIds: () => ["s-1", "s-2"],
  });

  facade.broadcastSessions(["s-1"]);
  facade.broadcastCharacters();
  facade.broadcastModelCatalog();
  facade.broadcastAppSettings();
  facade.broadcastOpenSessionWindowIds();

  assert.deepEqual(calls, ["summaries:1", "invalidated:s-1", "characters:1", "catalog:3", "settings", "windows:2"]);
});
