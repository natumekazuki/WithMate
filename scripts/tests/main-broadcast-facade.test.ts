import assert from "node:assert/strict";
import test from "node:test";

import { MainBroadcastFacade } from "../../src-electron/main-broadcast-facade.js";

test("MainBroadcastFacade は payload を組み立てて WindowBroadcastService へ委譲する", () => {
  const calls: string[] = [];
  const facade = new MainBroadcastFacade({
    getWindowBroadcastService: () =>
      ({
        broadcastSessions(payload) {
          calls.push(`sessions:${payload.length}`);
        },
        broadcastCharacters(payload) {
          calls.push(`characters:${payload.length}`);
        },
        broadcastModelCatalog(payload) {
          calls.push(`catalog:${payload.revision}`);
        },
        broadcastAppSettings(_payload) {
          calls.push("settings");
        },
        broadcastOpenSessionWindowIds(payload) {
          calls.push(`windows:${payload.length}`);
        },
      }) as never,
    listSessions: () => [{ id: "s-1" }] as never,
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

  facade.broadcastSessions();
  facade.broadcastCharacters();
  facade.broadcastModelCatalog();
  facade.broadcastAppSettings();
  facade.broadcastOpenSessionWindowIds();

  assert.deepEqual(calls, ["sessions:1", "characters:1", "catalog:3", "settings", "windows:2"]);
});
