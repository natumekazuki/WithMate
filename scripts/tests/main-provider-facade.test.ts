import assert from "node:assert/strict";
import test from "node:test";

import { MainProviderFacade } from "../../src-electron/main-provider-facade.js";

test("MainProviderFacade は provider catalog を解決し adapter 無効化を委譲する", () => {
  const calls: string[] = [];
  const codexAdapter = {
    invalidateSessionThread(sessionId: string) {
      calls.push(`codex:${sessionId}`);
    },
    invalidateAllSessionThreads() {
      calls.push("codex:all");
    },
  };
  const copilotAdapter = {
    invalidateSessionThread(sessionId: string) {
      calls.push(`copilot:${sessionId}`);
    },
    invalidateAllSessionThreads() {
      calls.push("copilot:all");
    },
  };
  const facade = new MainProviderFacade({
    getModelCatalog: () => ({
      revision: 1,
      providers: [
        {
          id: "codex",
          name: "Codex",
          defaultModelId: "gpt-5.4-mini",
          defaultReasoningEffort: "medium",
          models: [],
        },
        {
          id: "copilot",
          name: "Copilot",
          defaultModelId: "gpt-5.4-mini",
          defaultReasoningEffort: "medium",
          models: [],
        },
      ],
    }),
    ensureModelCatalogSeeded: () => {
      throw new Error("should not seed");
    },
    codexAdapter: codexAdapter as never,
    copilotAdapter: copilotAdapter as never,
  });

  const resolved = facade.resolveProviderCatalog("copilot");
  facade.invalidateProviderSessionThread("copilot", "s-1");
  facade.invalidateProviderSessionThread("codex", "s-2");
  facade.invalidateAllProviderSessionThreads();

  assert.equal(resolved.provider.id, "copilot");
  assert.deepEqual(calls, ["copilot:s-1", "codex:s-2", "codex:all", "copilot:all"]);
});
