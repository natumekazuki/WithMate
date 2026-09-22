import assert from "node:assert/strict";
import test from "node:test";

import { MainProviderFacade } from "../../src-electron/app/main-provider-facade.js";
import type { ModelCatalogSnapshot } from "../../src-shared/settings/model-catalog.js";

// @test-value v2
// kind = "contract"
// claim = "MainProviderFacadeは非同期catalog解決とprovider adapter無効化を委譲する"
// oracle = { type = "contract", ref = "src-electron/app/main-provider-facade.ts#resolveProviderCatalog; src-electron/app/main-provider-facade.ts#invalidateProviderSessionThread" }
// fault = "catalog解決Promiseを待たずにproviderへアクセスする"
// observable = "resolveProviderCatalogのproviderとadapter無効化の呼び出し順"
// observation_boundary = "public-boundary"
// scope = "main-provider-facade"
// lifecycle = "permanent"
// impact = "catalog解決やrevoke順序を誤ると無効化前にadapterが実行され、旧provider実行が残る"
// distinction = "private実装順序ではなくpublic facadeのrevoke-before-adapter契約を実観測する"
// @end-test-value
test("MainProviderFacade は provider catalog を解決し adapter 無効化を委譲する", async () => {
  const calls: string[] = [];
  let resolveCatalog!: (catalog: ModelCatalogSnapshot | null) => void;
  const catalogPromise = new Promise<ModelCatalogSnapshot | null>((resolve) => { resolveCatalog = resolve; });
  const codexAdapter = {
    async invalidateSessionThread(sessionId: string) {
      calls.push(`codex:${sessionId}`);
    },
    async invalidateAllSessionThreads() {
      calls.push("codex:all");
    },
  };
  const copilotAdapter = {
    async invalidateSessionThread(sessionId: string) {
      calls.push(`copilot:${sessionId}`);
    },
    async invalidateAllSessionThreads() {
      calls.push("copilot:all");
    },
  };
  const facade = new MainProviderFacade({
    getModelCatalog: () => catalogPromise,
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

  const resolvedPromise = facade.resolveProviderCatalog("copilot");
  await Promise.resolve();
  assert.deepEqual(calls, []);
  resolveCatalog({
      revision: 1,
      providers: [
        {
          id: "codex",
          label: "Codex",
          defaultModelId: "gpt-5.4-mini",
          defaultReasoningEffort: "medium",
          models: [],
        },
        {
          id: "copilot",
          label: "Copilot",
          defaultModelId: "gpt-5.4-mini",
          defaultReasoningEffort: "medium",
          models: [],
        },
      ],
  });
  const resolved = await resolvedPromise;
  await facade.invalidateProviderSessionThread("copilot", "s-1");
  await facade.resetProviderSessionThread("codex", "s-retry");
  await facade.invalidateProviderSessionThread("codex", "s-2");
  await facade.invalidateAllProviderSessionThreads();

  assert.equal(resolved.provider.id, "copilot");
  assert.deepEqual(calls.slice(0, 2), ["binding:copilot:s-1", "copilot:s-1"]);
  assert.deepEqual(calls.slice(2, 3), ["codex:s-retry"]);
  assert.deepEqual(calls.slice(3, 5), ["binding:codex:s-2", "codex:s-2"]);
  const callIndex = (value: string) => (calls as string[]).indexOf(value);
  const revokeAllIndex = callIndex("binding:all");
  assert.ok(revokeAllIndex >= 0);
  assert.ok(revokeAllIndex < callIndex("codex:all"));
  assert.ok(revokeAllIndex < callIndex("copilot:all"));
});

// @test-value v2
// kind = "contract"
// claim = "MainProviderFacadeのresetはprovider adapterの非同期失敗を呼び出し元へ伝播する"
// oracle = { type = "contract", ref = "src-electron/app/main-provider-facade.ts#resetProviderSessionThread" }
// fault = "resetのadapter rejectを握り潰し、呼び出し元が無効化失敗を成功として扱う"
// observable = "resetProviderSessionThreadのreject identity"
// observation_boundary = "public-boundary"
// scope = "main-provider-facade-reset"
// lifecycle = "permanent"
// impact = "無効化失敗後も旧provider実行が残り、再試行や終了処理が誤って進む"
// distinction = "adapterの失敗がfacade境界を越えて伝播する契約を確認する"
// @end-test-value
test("MainProviderFacade の reset は adapter の reject を伝播する", async () => {
  const error = new Error("reset failed");
  const facade = new MainProviderFacade({
    getModelCatalog: () => null,
    ensureModelCatalogSeeded: () => { throw new Error("not used"); },
    codexAdapter: { invalidateSessionThread: async () => { throw error; } } as never,
    copilotAdapter: { invalidateSessionThread: async () => undefined } as never,
  });

  await assert.rejects(() => facade.resetProviderSessionThread("codex", "s-retry"), error);
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
