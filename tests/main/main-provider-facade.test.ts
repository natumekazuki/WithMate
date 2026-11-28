import assert from "node:assert/strict";
import test from "node:test";

import { MainProviderFacade } from "../../src-electron/app/main-provider-facade.js";
import type {
  ModelCatalogRequest,
  ModelCatalogSnapshot,
} from "../../src-shared/settings/model-catalog.js";

// @test-value v2
// kind = "contract"
// claim = "MainProviderFacadeはproviderとworkspaceをcatalog取得へ渡し非同期解決を待ち、provider adapter無効化を委譲する"
// oracle = { type = "contract", ref = "src-electron/app/main-provider-facade.ts#resolveProviderCatalog; src-electron/app/main-provider-facade.ts#invalidateProviderSessionThread" }
// fault = "catalog取得へprovider/workspaceを渡さないか、解決Promiseを待たずにproviderへアクセスする"
// observable = "catalog取得request、resolveProviderCatalogのproviderとadapter無効化の呼び出し順"
// observation_boundary = "public-boundary"
// scope = "main-provider-facade"
// lifecycle = "permanent"
// impact = "catalog解決やrevoke順序を誤ると無効化前にadapterが実行され、旧provider実行が残る"
// distinction = "private実装順序ではなくpublic facadeのrevoke-before-adapter契約を実観測する"
// @end-test-value
/** 対象プロバイダーと作業場所をカタログへ渡し、スレッド無効化より先に実行権限を失効させる。 */
test("MainProviderFacade は provider catalog を解決し adapter 無効化を委譲する", async () => {
  const calls: string[] = [];
  let resolveCatalog!: (catalog: ModelCatalogSnapshot) => void;
  const catalogPromise = new Promise<ModelCatalogSnapshot>((resolve) => {
    resolveCatalog = resolve;
  });
  const catalogRequests: Array<ModelCatalogRequest | undefined> = [];
  const codexAdapter = {
    /** Codex の個別スレッド無効化を、再試行経路も含めて記録する。 */
    async invalidateSessionThread(sessionId: string) {
      calls.push(`codex:${sessionId}`);
    },
    /** Codex の全スレッド無効化時点を記録する。 */
    async invalidateAllSessionThreads() {
      calls.push("codex:all");
    },
  };
  const copilotAdapter = {
    /** Copilot のアダプターが選ばれたことをセッション ID とともに記録する。 */
    async invalidateSessionThread(sessionId: string) {
      calls.push(`copilot:${sessionId}`);
    },
    /** Copilot への一括無効化の委譲を記録する。 */
    async invalidateAllSessionThreads() {
      calls.push("copilot:all");
    },
  };
  const claudeAdapter = {
    /** Claude の個別無効化の順序を照合できるようにする。 */
    async invalidateSessionThread(sessionId: string) {
      calls.push(`claude:${sessionId}`);
    },
    /** Claude の一括無効化を別の記録として残す。 */
    async invalidateAllSessionThreads() {
      calls.push("claude:all");
    },
  };
  const facade = new MainProviderFacade({
    /** カタログ取得条件を保存し、テストが明示的に解決するまで応答を止める。 */
    getModelCatalog: (request) => {
      catalogRequests.push(request);
      return catalogPromise;
    },
    codexAdapter: codexAdapter as never,
    copilotAdapter: copilotAdapter as never,
    claudeAdapter: claudeAdapter as never,
    opencodeAdapter: {
      /** OpenCode の個別無効化を、対応する権限失効と時系列で比較できるよう記録する。 */
      invalidateSessionThread: async (sessionId: string) => {
        calls.push(`opencode:${sessionId}`);
      },
      /** OpenCode も一括無効化に含まれることを呼び出しで示す。 */
      invalidateAllSessionThreads: async () => {
        calls.push("opencode:all");
      },
    } as never,
    /** セッション単位の実行権限失効を対象プロバイダーとともに記録する。 */
    revokeProviderExecution(sessionId, providerId) {
      calls.push(`binding:${providerId}:${sessionId}`);
    },
    /** 全プロバイダー向けの実行権限失効を時系列の基準として記録する。 */
    revokeAllProviderExecutions() {
      calls.push("binding:all");
    },
  });

  const resolvedPromise = facade.resolveProviderCatalog(
    "copilot",
    "C:/workspace",
  );
  await Promise.resolve();
  assert.deepEqual(calls, []);
  assert.deepEqual(catalogRequests, [
    { providerId: "copilot", workspacePath: "C:/workspace" },
  ]);
  resolveCatalog({
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
  await facade.invalidateProviderSessionThread("claude", "s-claude");
  await facade.resetProviderSessionThread("codex", "s-retry");
  await facade.invalidateProviderSessionThread("codex", "s-2");
  await facade.invalidateProviderSessionThread("opencode", "s-opencode");
  await facade.invalidateAllProviderSessionThreads();

  assert.equal(resolved.provider.id, "copilot");
  assert.deepEqual(calls.slice(0, 2), ["binding:copilot:s-1", "copilot:s-1"]);
  assert.deepEqual(calls.slice(2, 4), [
    "binding:claude:s-claude",
    "claude:s-claude",
  ]);
  assert.deepEqual(calls.slice(4, 5), ["codex:s-retry"]);
  assert.deepEqual(calls.slice(5, 7), ["binding:codex:s-2", "codex:s-2"]);
  assert.deepEqual(calls.slice(7, 9), [
    "binding:opencode:s-opencode",
    "opencode:s-opencode",
  ]);
  /** 呼び出し履歴から一括失効と各アダプターの順番を比較する。 */
  const callIndex = (value: string) => (calls as string[]).indexOf(value);
  const revokeAllIndex = callIndex("binding:all");
  assert.ok(revokeAllIndex >= 0);
  assert.ok(revokeAllIndex < callIndex("codex:all"));
  assert.ok(revokeAllIndex < callIndex("copilot:all"));
  assert.ok(revokeAllIndex < callIndex("claude:all"));
  assert.ok(revokeAllIndex < callIndex("opencode:all"));
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
/** 再試行用のリセットが失敗したとき、元のエラーを包み直さず返す。 */
test("MainProviderFacade の reset は adapter の reject を伝播する", async () => {
  const error = new Error("reset failed");
  const facade = new MainProviderFacade({
    /** リセットの失敗に関係しないカタログには空の候補を返す。 */
    getModelCatalog: () => ({ providers: [] }),
    codexAdapter: {
      /** Codex の無効化から比較対象のエラーをそのまま送出する。 */ invalidateSessionThread:
        async () => {
          throw error;
        },
    } as never,
    copilotAdapter: {
      /** この検査では選ばない Copilot の無効化を処理なしで満たす。 */ invalidateSessionThread:
        async () => undefined,
    } as never,
    claudeAdapter: {
      /** Claude 側の無効化は失敗条件に含めない。 */ invalidateSessionThread:
        async () => undefined,
    } as never,
    opencodeAdapter: {
      /** OpenCode 側の無効化も空の処理にする。 */ invalidateSessionThread:
        async () => undefined,
    } as never,
  });

  await assert.rejects(
    () => facade.resetProviderSessionThread("codex", "s-retry"),
    (actual) => actual === error,
  );
});

// @test-value v2
// kind = "contract"
// claim = "MainProviderFacadeは未知providerをunsupportedと報告し、登録Claudeは実行とruntime binding capabilityを公開する"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md#current-runtime; src-electron/providers/provider-agent-runtime-binding.ts#getProviderAgentRuntimeBindingCapability" }
// fault = "未知providerをCodexとして誤報告するか、登録Claudeのruntime binding capabilityをunsupportedにする"
// observable = "getProviderRuntimeCapabilitiesのproviderSupported、agentRuntimeBindingSupported、transport"
// observation_boundary = "public-boundary"
// scope = "main-provider-facade-runtime-capabilities"
// lifecycle = "permanent"
// impact = "Claude sessionがagent runtime bindingなしで扱われるか、未知providerが別providerの契約を誤用する"
// distinction = "provider routing testではFacadeが返すruntime capability projectionを確認しない"
// @end-test-value
/** 未知のプロバイダーは未対応とし、登録済み Claude の環境変数経由の連携能力は公開する。 */
test("MainProviderFacade は未対応 provider の runtime capability を codex として誤報告しない", () => {
  const codexAdapter = {};
  const copilotAdapter = {};
  const facade = new MainProviderFacade({
    /** 能力判定を登録アダプターだけで検査するため、モデル候補を与えない。 */
    getModelCatalog: () => ({ providers: [] }),
    codexAdapter: codexAdapter as never,
    copilotAdapter: copilotAdapter as never,
    claudeAdapter: {} as never,
    opencodeAdapter: {} as never,
  });

  const capabilities = facade.getProviderRuntimeCapabilities("custom");

  assert.equal(capabilities.providerId, "custom");
  assert.equal(capabilities.providerSupported, false);
  assert.equal(capabilities.instructionSyncSupported, false);
  assert.equal(capabilities.tokenUsageSupported, false);
  assert.equal(capabilities.agentRuntimeBindingSupported, false);
  assert.equal(capabilities.agentRuntimeBindingTransport, "unsupported");
  const claudeCapabilities = facade.getProviderRuntimeCapabilities("claude");
  assert.equal(claudeCapabilities.providerSupported, true);
  assert.equal(claudeCapabilities.agentRuntimeBindingSupported, true);
  assert.equal(claudeCapabilities.agentRuntimeBindingTransport, "env");
});
