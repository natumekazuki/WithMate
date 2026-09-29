import assert from "node:assert/strict";
import test from "node:test";
import type { ModelCatalogProvider } from "../../src-shared/settings/model-catalog.js";

import type {
  ProviderCodingAdapter,
  ProviderTurnAdapter,
} from "../../src-electron/providers/provider-runtime.js";
import { createDefaultAppSettings, type AppSettings } from "../../src-shared/settings/provider-settings-state.js";
import {
  fetchProviderQuotaTelemetry,
  getProviderRuntimeCapabilities,
  resolveProviderCatalogOrThrow,
  resolveProviderBackgroundAdapter,
  resolveProviderCodingAdapter,
} from "../../src-electron/providers/provider-support.js";

// @test-value v2
// kind = "contract"
// claim = "指定されたproviderのcatalogを非同期storage経由で解決する"
// oracle = { type = "contract", ref = "src-electron/provider-support.ts#resolveProviderCatalogOrThrow" }
// fault = "非同期catalog取得を待たずにprovider解決してPromiseを誤って扱う"
// observable = "resolveProviderCatalogOrThrowの解決結果"
// observation_boundary = "public-boundary"
// scope = "provider-support"
// lifecycle = "permanent"
// impact = "非同期catalogを待たずに解決するとprovider選択が誤り、後続adapter dispatchが不正になる"
// distinction = "型だけでなく非同期getterを実際に待った解決結果を確認する"
// @end-test-value
test("resolveProviderCatalogOrThrow は指定 provider の catalog を返す", () => {
  return (async () => {
    const result = await resolveProviderCatalogOrThrow({
    providerId: "copilot",
    getModelCatalog: async () => ({
      revision: 2,
      providers: [
        {
          id: "codex",
          label: "Codex",
          defaultModelId: "gpt-5.4",
          defaultReasoningEffort: "high",
          models: [],
        },
        {
          id: "copilot",
          label: "Copilot",
          defaultModelId: "gpt-5",
          defaultReasoningEffort: "medium",
          models: [],
        },
      ],
    }),
    ensureSeeded() {
      throw new Error("not used");
    },
    });

    assert.equal(result.snapshot.revision, 2);
    assert.equal(result.provider.id, "copilot");
  })();
});

// @test-value v2
// kind = "contract"
// claim = "coding/backgroundは対応providerだけを返し、未知IDはcapabilityと一致して拒否する"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md#current-runtime" }
// fault = "provider adapterを取り違え、別providerの実行経路を呼び出す"
// observable = "coding/background adapter identity、未知IDの例外とproviderSupported"
// observation_boundary = "public-boundary"
// scope = "provider-adapter-resolution"
// lifecycle = "permanent"
// impact = "選択していないProviderへのprompt送信と利用枠消費を防ぐ"
// distinction = "adapter内部動作では検出できないprovider routingを確認する"
// @end-test-value
test("resolveProviderCodingAdapter と resolveProviderBackgroundAdapter は providerId に応じて adapter を返す", () => {
  const createStubAdapter = (): ProviderTurnAdapter => ({
    composePrompt: () => { throw new Error("not used"); },
    getProviderQuotaTelemetry: async () => null,
    invalidateSessionThread: async () => {},
    invalidateAllSessionThreads: async () => {},
    runSessionTurn: async () => { throw new Error("not used"); },
    getBackgroundStructuredPromptPolicy: () => ({
      allowsFileWrite: false,
      allowsShellWrite: false,
      allowsToolPermissionRequests: false,
      structuredOutputOnly: true,
      structuredOutputMode: "provider_schema",
    }),
    extractSessionMemoryDelta: async () => { throw new Error("not used"); },
    runBackgroundStructuredPrompt: async () => { throw new Error("not used"); },
  });
  const codexAdapter = createStubAdapter();
  const copilotAdapter = createStubAdapter();

  assert.equal(
    resolveProviderCodingAdapter({
      providerId: "codex",
      codexAdapter,
      copilotAdapter,
    }),
    codexAdapter,
  );
  assert.equal(
    resolveProviderCodingAdapter({
      providerId: "copilot",
      codexAdapter,
      copilotAdapter,
    }),
    copilotAdapter,
  );
  assert.equal(
    resolveProviderBackgroundAdapter({
      providerId: "codex",
      codexAdapter,
      copilotAdapter,
    }),
    codexAdapter,
  );
  assert.equal(
    resolveProviderBackgroundAdapter({
      providerId: "copilot",
      codexAdapter,
      copilotAdapter,
    }),
    copilotAdapter,
  );

  for (const resolve of [resolveProviderCodingAdapter, resolveProviderBackgroundAdapter]) {
    for (const providerId of [null, undefined]) {
      assert.equal(resolve({ providerId, codexAdapter, copilotAdapter }), codexAdapter);
    }
    for (const providerId of ["unknown", "claude", "", " codex ", "__proto__", "constructor"]) {
      assert.equal(getProviderRuntimeCapabilities({ providerId }).providerSupported, false);
      assert.throws(() => resolve({ providerId, codexAdapter, copilotAdapter }), /Unsupported provider:/);
    }
    for (const providerId of ["codex", "copilot"]) {
      assert.equal(getProviderRuntimeCapabilities({ providerId }).providerSupported, true);
    }
  }
});

// @test-value v2
// kind = "contract"
// claim = "実行用catalog解決は未知Providerとcatalogにない対応Providerを別Providerへ置き換えない"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md#current-runtime" }
// fault = "catalog共通helperのdefault fallbackで指定とは異なるProviderを返す"
// observable = "resolveProviderCatalogOrThrowのrejectと指定省略時のProvider ID"
// observation_boundary = "public-boundary"
// scope = "provider-runtime-catalog"
// lifecycle = "permanent"
// impact = "保存Sessionと実行Providerの不一致による誤送信を防ぐ"
// distinction = "同じstring型のIDを扱うため型検査では検出できず、adapter単独のtestはcatalogでの置換を通らない"
// @end-test-value
test("実行用catalogは指定Providerが見つからなければ拒否する", async () => {
  const providers: ModelCatalogProvider[] = [{ id: "codex", label: "Codex", defaultModelId: "gpt-5.4", defaultReasoningEffort: "high", models: [] }];
  for (const includeCustomProvider of [false, true]) {
    const catalog = { revision: 1, providers: includeCustomProvider ? [...providers, { ...providers[0]!, id: "custom" }] : providers };
    const deps = {
      getModelCatalog: () => catalog,
      ensureSeeded: () => catalog,
    };
    await assert.rejects(resolveProviderCatalogOrThrow({ ...deps, providerId: "custom" }), /Unsupported provider: custom/);
    await assert.rejects(resolveProviderCatalogOrThrow({ ...deps, providerId: "copilot" }), /Provider copilot is not available/);
    assert.equal((await resolveProviderCatalogOrThrow({ ...deps, providerId: undefined })).provider.id, "codex");
  }
});

// @test-value v2
// kind = "contract"
// claim = "provider quota telemetryは選択providerのadapterとapp settingsを使って取得する"
// oracle = { type = "contract", ref = "src/provider-support.ts: fetchProviderQuotaTelemetry" }
// fault = "別providerまたは誤ったsettingsをadapterへ渡し、quota表示を誤る"
// observable = "adapter input providerId/settingsと返却telemetry"
// observation_boundary = "public-boundary"
// scope = "provider-quota-telemetry"
// lifecycle = "permanent"
// distinction = "adapter routing testでは検出できないquota input propagationを確認する"
// @end-test-value
test("fetchProviderQuotaTelemetry は adapter と app settings を使って quota を取得する", async () => {
  let receivedProviderId = "";
  let receivedSettings: AppSettings | undefined;
  const telemetry = { provider: "codex", remainingPercentage: 50 } as never;
  const adapter = {
    composePrompt() {
      throw new Error("not used");
    },
    async getProviderQuotaTelemetry(input) {
      receivedProviderId = input.providerId;
      receivedSettings = input.appSettings;
      return telemetry;
    },
    async invalidateSessionThread() {},
    async invalidateAllSessionThreads() {},
    async runSessionTurn() {
      throw new Error("not used");
    },
  } satisfies ProviderCodingAdapter;
  const appSettings = createDefaultAppSettings();

  const result = await fetchProviderQuotaTelemetry({
    providerId: "codex",
    getAppSettings: () => appSettings,
    getProviderCodingAdapter() {
      return adapter;
    },
  });

  assert.equal(result, telemetry);
  assert.equal(receivedProviderId, "codex");
  assert.equal(receivedSettings, appSettings);
});

test("getProviderRuntimeCapabilities は provider と background policy から対応状況を返す", () => {
  const capabilities = getProviderRuntimeCapabilities({ providerId: "copilot" });

  assert.equal(capabilities.providerId, "copilot");
  assert.equal(capabilities.providerSupported, true);
  assert.equal(capabilities.instructionSyncSupported, true);
  assert.equal(capabilities.tokenUsageSupported, true);
  assert.equal(capabilities.agentRuntimeBindingSupported, true);
  assert.equal(capabilities.agentRuntimeBindingTransport, "env");
});

test("getProviderRuntimeCapabilities は MVP 対象外 provider の support flag を false にする", () => {
  const capabilities = getProviderRuntimeCapabilities({ providerId: "unknown" });

  assert.equal(capabilities.instructionSyncSupported, false);
  assert.equal(capabilities.tokenUsageSupported, false);
  assert.equal(capabilities.providerSupported, false);
  assert.equal(capabilities.agentRuntimeBindingSupported, false);
  assert.equal(capabilities.agentRuntimeBindingTransport, "unsupported");
});

test("getProviderRuntimeCapabilities は確認済みproviderへruntime binding capabilityを公開する", () => {
  for (const providerId of ["codex", "copilot"]) {
    const capabilities = getProviderRuntimeCapabilities({ providerId });
    assert.equal(capabilities.agentRuntimeBindingSupported, true);
    assert.equal(capabilities.agentRuntimeBindingTransport, "env");
  }
});
