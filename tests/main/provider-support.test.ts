import assert from "node:assert/strict";
import test from "node:test";
import type { ModelCatalogProvider } from "../../src-shared/settings/model-catalog.js";

import type {
  ProviderCodingAdapter,
  ProviderTurnAdapter,
} from "../../src-electron/providers/provider-runtime.js";
import {
  createDefaultAppSettings,
  type AppSettings,
} from "../../src-shared/settings/provider-settings-state.js";
import {
  fetchProviderQuotaTelemetry,
  getProviderRuntimeCapabilities,
  resolveProviderCatalogOrThrow,
  resolveProviderCodingAdapter,
} from "../../src-electron/providers/provider-support.js";

// @test-value v2
// kind = "contract"
// claim = "指定されたproviderのcatalogを非同期storage経由で解決する"
// oracle = { type = "contract", ref = "src-electron/providers/provider-support.ts#resolveProviderCatalogOrThrow" }
// fault = "非同期catalog取得を待たずにprovider解決してPromiseを誤って扱う"
// observable = "resolveProviderCatalogOrThrowの解決結果"
// observation_boundary = "public-boundary"
// scope = "provider-support"
// lifecycle = "permanent"
// impact = "非同期catalogを待たずに解決するとprovider選択が誤り、後続adapter dispatchが不正になる"
// distinction = "型だけでなく非同期getterを実際に待った解決結果を確認する"
// @end-test-value
/** 非同期に取得した一覧から指定 ID を選び、スナップショットも保持することを確認する。 */
test("resolveProviderCatalogOrThrow は指定 provider の catalog を返す", () => {
  return (async () => {
    const result = await resolveProviderCatalogOrThrow({
      providerId: "copilot",
      /** 指定した Copilot を先頭以外に含むカタログを非同期で返す。 */
      getModelCatalog: async () => ({
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
    });

    assert.equal(result.snapshot.providers.length, 2);
    assert.equal(result.provider.id, "copilot");
  })();
});

// @test-value v2
// kind = "contract"
// claim = "codingはCodex・Copilot・Claude・OpenCodeを区別して返し、未知IDはcapabilityと一致して拒否する"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md#current-runtime" }
// fault = "provider adapterを取り違え、別providerの実行経路を呼び出す"
// observable = "coding adapter identity、未知IDの例外とproviderSupported"
// observation_boundary = "public-boundary"
// scope = "provider-adapter-resolution"
// lifecycle = "permanent"
// impact = "選択していないProviderへのprompt送信と利用枠消費を防ぐ"
// distinction = "adapter内部動作では検出できないprovider routingを確認する"
// @end-test-value
/** 登録済み ID を個々のアダプターに結び、指定なしと未対応の指定を区別する。 */
test("resolveProviderCodingAdapter は providerId に応じて adapter を返す", () => {
  /** 実装を実行せず、返されたオブジェクトの同一性を検証するためのアダプターを作る。 */
  const createStubAdapter = (): ProviderTurnAdapter => ({
    /** ルーティングの解決中にプロンプト組み立てが起きたら失敗させる。 */
    composePrompt: () => {
      throw new Error("not used");
    },
    /** このアダプターは利用枠情報を持たない。 */
    getProviderQuotaTelemetry: async () => null,
    /** 分岐検査に不要な個別スレッド操作は行わない。 */
    invalidateSessionThread: async () => {},
    /** 全体への無効化にも副作用を持たせない。 */
    invalidateAllSessionThreads: async () => {},
    /** アダプター選択だけでは Turn を開始してはならない。 */
    runSessionTurn: async () => {
      throw new Error("not used");
    },
  });
  const codexAdapter = createStubAdapter();
  const copilotAdapter = createStubAdapter();
  const claudeAdapter = createStubAdapter();
  const opencodeAdapter = createStubAdapter();

  assert.equal(
    resolveProviderCodingAdapter({
      providerId: "codex",
      codexAdapter,
      copilotAdapter,
      claudeAdapter,
      opencodeAdapter,
    }),
    codexAdapter,
  );
  assert.equal(
    resolveProviderCodingAdapter({
      providerId: "copilot",
      codexAdapter,
      copilotAdapter,
      claudeAdapter,
      opencodeAdapter,
    }),
    copilotAdapter,
  );
  assert.equal(
    resolveProviderCodingAdapter({
      providerId: "claude",
      codexAdapter,
      copilotAdapter,
      claudeAdapter,
      opencodeAdapter,
    }),
    claudeAdapter,
  );
  assert.equal(
    resolveProviderCodingAdapter({
      providerId: "opencode",
      codexAdapter,
      copilotAdapter,
      claudeAdapter,
      opencodeAdapter,
    }),
    opencodeAdapter,
  );

  for (const resolve of [resolveProviderCodingAdapter]) {
    for (const providerId of [null, undefined]) {
      assert.equal(
        resolve({
          providerId,
          codexAdapter,
          copilotAdapter,
          claudeAdapter,
          opencodeAdapter,
        }),
        codexAdapter,
      );
    }
    for (const providerId of [
      "unknown",
      "custom",
      "",
      " codex ",
      "__proto__",
      "constructor",
    ]) {
      assert.equal(
        getProviderRuntimeCapabilities({ providerId }).providerSupported,
        false,
      );
      assert.throws(
        () =>
          resolve({
            providerId,
            codexAdapter,
            copilotAdapter,
            claudeAdapter,
            opencodeAdapter,
          }),
        /Unsupported provider:/,
      );
    }
    for (const providerId of ["codex", "copilot", "claude", "opencode"]) {
      assert.equal(
        getProviderRuntimeCapabilities({ providerId }).providerSupported,
        true,
      );
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
/** 未対応 ID と利用できない登録済み ID を区別し、指定なしの場合だけ既定へ解決する。 */
test("実行用catalogは指定Providerが見つからなければ拒否する", async () => {
  const providers: ModelCatalogProvider[] = [
    {
      id: "codex",
      label: "Codex",
      defaultModelId: "gpt-5.4",
      defaultReasoningEffort: "high",
      models: [],
    },
  ];
  for (const includeCustomProvider of [false, true]) {
    const catalog = {
      revision: 1,
      providers: includeCustomProvider
        ? [...providers, { ...providers[0]!, id: "custom" }]
        : providers,
    };
    const deps = {
      /** 未対応の候補を含むかどうかだけが異なるスナップショットを渡す。 */
      getModelCatalog: () => catalog,
    };
    await assert.rejects(
      resolveProviderCatalogOrThrow({ ...deps, providerId: "custom" }),
      /Unsupported provider: custom/,
    );
    await assert.rejects(
      resolveProviderCatalogOrThrow({ ...deps, providerId: "copilot" }),
      /Provider copilot is not available/,
    );
    assert.equal(
      (await resolveProviderCatalogOrThrow({ ...deps, providerId: undefined }))
        .provider.id,
      "codex",
    );
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
/** 指定 ID とアプリ設定を利用枠の取得先へそのまま伝え、返された応答を利用する。 */
test("fetchProviderQuotaTelemetry は adapter と app settings を使って quota を取得する", async () => {
  let receivedProviderId = "";
  let receivedSettings: AppSettings | undefined;
  const telemetry = { provider: "codex", remainingPercentage: 50 } as never;
  const adapter = {
    /** 利用枠の問い合わせでプロンプトを作成しないことを保証する。 */
    composePrompt() {
      throw new Error("not used");
    },
    /** アダプターへ伝わった ID と設定を記録し、比較用の利用枠応答を返す。 */
    async getProviderQuotaTelemetry(input) {
      receivedProviderId = input.providerId;
      receivedSettings = input.appSettings;
      return telemetry;
    },
    /** 利用枠の観測には個別スレッドの後片付けを必要としない。 */
    async invalidateSessionThread() {},
    /** 利用枠の観測に全体のスレッド状態を持ち込まない。 */
    async invalidateAllSessionThreads() {},
    /** 利用枠取得のために実際の Turn を実行したら失敗させる。 */
    async runSessionTurn() {
      throw new Error("not used");
    },
  } satisfies ProviderCodingAdapter;
  const appSettings = createDefaultAppSettings();

  const result = await fetchProviderQuotaTelemetry({
    providerId: "codex",
    /** アダプターまで同じ参照で伝わるかを調べる設定を返す。 */
    getAppSettings: () => appSettings,
    /** 実プロバイダーではなく入力を観測するスタブを選ぶ。 */
    getProviderCodingAdapter() {
      return adapter;
    },
  });

  assert.equal(result, telemetry);
  assert.equal(receivedProviderId, "codex");
  assert.equal(receivedSettings, appSettings);
});

// @test-value v2
// kind = "contract"
// claim = "Copilotのruntime capabilityは指定IDを保ち、instruction sync・token usage・env bindingの対応を公開する"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md#current-runtime; src-electron/providers/provider-support.ts#getProviderRuntimeCapabilities" }
// fault = "対応providerのcapabilityを未対応として返すか、異なるprovider IDへ置き換える"
// observable = "providerId、providerSupported、instructionSyncSupported、tokenUsageSupported、agentRuntimeBindingSupported、agentRuntimeBindingTransport"
// observation_boundary = "public-boundary"
// scope = "provider-runtime-capability-projection"
// lifecycle = "permanent"
// impact = "利用可能なprovider機能が無効として扱われるか、別providerの対応状況を利用者へ表示する"
// distinction = "adapter routingやbinding mapping単体ではruntime capabilityの全fieldへの投影を確認できない。外部process不要の小さな公開境界testである"
// @end-test-value
/** Copilot の識別子を保ったまま、指示同期・使用量・環境変数バインディングの対応を示す。 */
test("getProviderRuntimeCapabilities は provider から対応状況を返す", () => {
  const capabilities = getProviderRuntimeCapabilities({
    providerId: "copilot",
  });

  assert.equal(capabilities.providerId, "copilot");
  assert.equal(capabilities.providerSupported, true);
  assert.equal(capabilities.instructionSyncSupported, true);
  assert.equal(capabilities.tokenUsageSupported, true);
  assert.equal(capabilities.agentRuntimeBindingSupported, true);
  assert.equal(capabilities.agentRuntimeBindingTransport, "env");
});

/** 未登録 ID ではプロバイダーおよび各実行機能を利用可能と報告しない。 */
test("getProviderRuntimeCapabilities は MVP 対象外 provider の support flag を false にする", () => {
  const capabilities = getProviderRuntimeCapabilities({
    providerId: "unknown",
  });

  assert.equal(capabilities.instructionSyncSupported, false);
  assert.equal(capabilities.tokenUsageSupported, false);
  assert.equal(capabilities.providerSupported, false);
  assert.equal(capabilities.agentRuntimeBindingSupported, false);
  assert.equal(capabilities.agentRuntimeBindingTransport, "unsupported");
});

// @test-value v2
// kind = "contract"
// claim = "登録済みproviderはagent runtime binding capabilityをenv transportとして公開する"
// oracle = { type = "contract", ref = "src-electron/providers/provider-agent-runtime-binding.ts#getProviderAgentRuntimeBindingCapability" }
// fault = "登録providerのruntime bindingをunsupportedと報告し、agent機能のcontextを渡さない"
// observable = "providerごとのagentRuntimeBindingSupportedとagentRuntimeBindingTransport"
// observation_boundary = "public-boundary"
// scope = "provider-agent-runtime-binding-capabilities"
// lifecycle = "permanent"
// impact = "登録providerのsessionでagent runtime bindingを利用できず、session contextに基づく機能が失われる"
// distinction = "Provider ID型はruntime transport mappingを表現せず、adapter routing testではcapability出力を検出しない"
// @end-test-value
/** 四つの登録済みプロバイダーすべてが、環境変数経由の実行時バインディングを公開する。 */
test("getProviderRuntimeCapabilities は確認済みproviderへruntime binding capabilityを公開する", () => {
  for (const providerId of ["codex", "copilot", "claude", "opencode"]) {
    const capabilities = getProviderRuntimeCapabilities({ providerId });
    assert.equal(capabilities.agentRuntimeBindingSupported, true);
    assert.equal(capabilities.agentRuntimeBindingTransport, "env");
  }
});
