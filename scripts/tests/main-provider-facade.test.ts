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
    revokeSessionMemoryBindings(sessionId) {
      calls.push(`revoke-memory:${sessionId}`);
    },
    revokeAllMemoryBindings() {
      calls.push("revoke-memory:all");
    },
  });

  const resolved = facade.resolveProviderCatalog("copilot");
  facade.invalidateProviderSessionThread("copilot", "s-1");
  facade.invalidateProviderSessionThread("codex", "s-2");
  facade.invalidateAllProviderSessionThreads();

  assert.equal(resolved.provider.id, "copilot");
  assert.deepEqual(calls, [
    "copilot:s-1",
    "revoke-memory:s-1",
    "codex:s-2",
    "revoke-memory:s-2",
    "codex:all",
    "copilot:all",
    "revoke-memory:all",
  ]);
});

test("MainProviderFacade は未対応 provider の runtime capability を codex として誤報告しない", () => {
  const codexAdapter = {
    getBackgroundStructuredPromptPolicy() {
      return {
        allowsFileWrite: false,
        allowsShellWrite: false,
        allowsToolPermissionRequests: false,
        structuredOutputOnly: true,
        structuredOutputMode: "provider_schema",
      } as const;
    },
  };
  const copilotAdapter = {
    getBackgroundStructuredPromptPolicy() {
      return {
        allowsFileWrite: false,
        allowsShellWrite: false,
        allowsToolPermissionRequests: false,
        structuredOutputOnly: true,
        structuredOutputMode: "schema_submit_tool",
      } as const;
    },
  };
  const facade = new MainProviderFacade({
    getModelCatalog: () => null,
    ensureModelCatalogSeeded: () => {
      throw new Error("not used");
    },
    codexAdapter: codexAdapter as never,
    copilotAdapter: copilotAdapter as never,
  });

  const capabilities = facade.getProviderRuntimeCapabilities("custom");

  assert.equal(capabilities.providerId, "custom");
  assert.equal(capabilities.providerSupported, false);
  assert.equal(capabilities.instructionSyncSupported, false);
  assert.equal(capabilities.tokenUsageSupported, false);
});
