import assert from "node:assert/strict";
import test from "node:test";

import { MainProviderFacade } from "../../src-electron/main-provider-facade.js";

test("MainProviderFacade は provider catalog を解決し adapter 無効化を委譲する", async () => {
  const calls: string[] = [];
  const codexAdapter = {
    invalidateSessionThread(sessionId: string) {
      calls.push(`codex:${sessionId}`);
    },
    async invalidateAllSessionThreads() {
      calls.push("codex:all");
    },
  };
  const copilotAdapter = {
    invalidateSessionThread(sessionId: string) {
      calls.push(`copilot:${sessionId}`);
    },
    async invalidateAllSessionThreads() {
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
    revokeProviderExecution(sessionId, providerId) {
      calls.push(`binding:${providerId}:${sessionId}`);
    },
    revokeAllProviderExecutions() {
      calls.push("binding:all");
    },
  });

  const resolved = facade.resolveProviderCatalog("copilot");
  await facade.invalidateProviderSessionThread("copilot", "s-1");
  facade.resetProviderSessionThread("codex", "s-retry");
  await facade.invalidateProviderSessionThread("codex", "s-2");
  await facade.invalidateAllProviderSessionThreads();

  assert.equal(resolved.provider.id, "copilot");
  assert.deepEqual(calls, [
    "binding:copilot:s-1",
    "copilot:s-1",
    "codex:s-retry",
    "binding:codex:s-2",
    "codex:s-2",
    "binding:all",
    "codex:all",
    "copilot:all",
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
  assert.equal(capabilities.agentRuntimeBindingSupported, false);
  assert.equal(capabilities.agentRuntimeBindingTransport, "unsupported");
});
