import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ModelCatalogSnapshot } from "../../src-shared/settings/model-catalog.js";
import { normalizeAppSettings } from "../../src-shared/settings/provider-settings-state.js";
import type { SessionSummary } from "../../src-shared/session/session-state.js";
import { SessionLaunchSelectionService } from "../../src-electron/session/session-launch-selection-service.js";

function createModelCatalogSnapshot(): ModelCatalogSnapshot {
  return {
    providers: [
      {
        id: "codex",
        label: "Codex",
        defaultModelId: "gpt-5.6",
        defaultReasoningEffort: "high",
        models: [
          {
            id: "gpt-5.6",
            label: "GPT-5.6",
            reasoningEfforts: ["high", "xhigh"],
          },
        ],
      },
      {
        id: "claude",
        label: "Claude Agent",
        defaultModelId: "claude-opus-5-5",
        defaultReasoningEffort: "high",
        models: [
          {
            id: "claude-opus-5-5",
            label: "Claude Opus 5.5",
            reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
          },
        ],
      },
      {
        id: "copilot",
        label: "Copilot",
        defaultModelId: "claude-sonnet",
        defaultReasoningEffort: "medium",
        models: [
          {
            id: "claude-sonnet",
            label: "Claude Sonnet",
            reasoningEfforts: ["medium", "high"],
          },
        ],
      },
    ],
  };
}

function createLatestSessionSummary(
  overrides: Partial<SessionSummary> = {},
): SessionSummary {
  return {
    provider: "copilot",
    model: "claude-sonnet",
    reasoningEffort: "high",
    approvalMode: "never",
    codexSandboxMode: "danger-full-access",
    codexSpeed: "fast",
    codexReviewer: "auto-review",
    customAgentName: "reviewer",
    ...overrides,
  } as SessionSummary;
}

describe("SessionLaunchSelectionService", () => {
  // @test-value v2
  // kind = "contract"
  // claim = "保存modelと作成開始時のSDK既定値を保持し、未選択の作成だけ対象workspaceとproviderのdiscoveryを待つ"
  // oracle = { type = "contract", ref = "accepted behavior: saved selections survive discovery changes; new selections use SDK defaults" }
  // fault = "保存選択を既定値へ置換するか、未選択の作成で別workspaceの候補を使う"
  // observable = "resolve結果のmodel/depthと対象discovery要求"
  // observation_boundary = "public-boundary"
  // scope = "session-launch-discovery-selection"
  // lifecycle = "permanent"
  // impact = "既存会話の利用modelを変えず、workspace固有のnative設定で新規会話を作る"
  // distinction = "helper単独testでは履歴選択と初回discovery待機の分岐を確認できない"
  // @end-test-value
  it("保存選択は未取得catalogから保持し未選択だけ対象discoveryを待つ", async () => {
    let latest: SessionSummary | null = createLatestSessionSummary({ provider: "codex", model: "saved-model", reasoningEffort: "native-depth" });
    const requests: Array<[string | undefined, string | undefined]> = [];
    let discoveredDefault = "gpt-5.6";
    const service = new SessionLaunchSelectionService({
      getAppSettings: () => normalizeAppSettings({}),
      getLatestSessionSummaryForProvider: () => latest,
      getModelCatalogSnapshot: (workspace, providerId) => {
        requests.push([workspace, providerId]);
        const snapshot = createModelCatalogSnapshot();
        snapshot.providers[0]!.defaultModelId = discoveredDefault;
        if (!providerId) snapshot.providers[0] = { ...snapshot.providers[0]!, models: [], defaultModelId: "", defaultReasoningEffort: "" };
        return snapshot;
      },
    });
    const saved = await service.resolve("codex", "C:/selected-workspace");
    assert.equal(saved.model, "saved-model");
    assert.equal(saved.reasoningEffort, "native-depth");
    assert.deepEqual(requests, [["C:/selected-workspace", undefined]]);
    latest = null;
    requests.length = 0;
    const initial = await service.resolve("codex", "C:/selected-workspace");
    assert.equal(initial.model, "gpt-5.6");
    assert.deepEqual(requests, [["C:/selected-workspace", undefined], ["C:/selected-workspace", "codex"]]);
    discoveredDefault = "updated-sdk-default";
    requests.length = 0;
    assert.equal((await service.resolve("codex", "C:/selected-workspace", initial)).model, "gpt-5.6");
    assert.deepEqual(requests, [["C:/selected-workspace", undefined]]);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "明示した未対応ProviderやcatalogにないProviderのlaunchを別Providerへ置き換えない"
  // oracle = { type = "contract", ref = "docs/design/provider-adapter.md#current-runtime" }
  // fault = "catalog fallbackまたはenabled判定だけで未知Providerのlaunchを許可する"
  // observable = "resolveのrejectと履歴取得回数"
  // observation_boundary = "public-boundary"
  // scope = "session-launch-provider-identity"
  // lifecycle = "permanent"
  // impact = "Codexでも有効なmodelを持つcustom Providerを誤って起動し、別契約を消費することを防ぐ"
  // distinction = "resolver単独testではlaunch時の既定選択や履歴継承への進入を検出できない"
  // @end-test-value
  it("未対応Providerの明示指定をcatalog登録の有無にかかわらず拒否する", async () => {
    const catalog = createModelCatalogSnapshot();
    const codex = catalog.providers[0]!;
    catalog.providers.push({ ...codex, id: "custom", label: "Custom" });
    let historyReads = 0;
    const service = new SessionLaunchSelectionService({
      getAppSettings: () => normalizeAppSettings({ codingProviderSettings: { codex: { enabled: true }, custom: { enabled: true } } }),
      getModelCatalogSnapshot: () => catalog,
      getLatestSessionSummaryForProvider: () => { historyReads += 1; return null; },
    });
    for (const providerId of ["custom", "unknown", "", "__proto__"]) {
      await assert.rejects(service.resolve(providerId), /Unsupported provider:/);
    }
    catalog.providers = [codex];
    await assert.rejects(service.resolve("copilot"), /Provider copilot model discovery is unavailable/);
    assert.equal(historyReads, 0);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "Provider未指定時はCodexを選び、無効なら別Providerに切り替えず失敗する"
  // oracle = { type = "contract", ref = "docs/design/provider-adapter.md#current-runtime" }
  // fault = "無効なCodexを実行するか別Providerへ切り替える"
  // observable = "resolveのProvider IDと対応Provider不在時のreject"
  // observation_boundary = "public-boundary"
  // scope = "session-launch-default-provider"
  // lifecycle = "permanent"
  // impact = "未対応Providerだけが有効なcatalogで別Providerを実行しない"
  // distinction = "明示指定の拒否とは別の未指定時探索分岐を、外部runtimeなしで短時間に検証する"
  // @end-test-value
  it("未指定時はCodexを選び無効なら拒否する", async () => {
    const catalog = createModelCatalogSnapshot();
    catalog.providers.unshift({ ...catalog.providers[0]!, id: "custom", label: "Custom" });
    const settings = normalizeAppSettings({ codingProviderSettings: { codex: { enabled: false }, copilot: { enabled: true }, custom: { enabled: true } } });
    const service = new SessionLaunchSelectionService({
      getAppSettings: () => settings,
      getModelCatalogSnapshot: () => catalog,
      getLatestSessionSummaryForProvider: () => null,
    });
    await assert.rejects(service.resolve(), /Provider codex is disabled/);
    settings.codingProviderSettings.codex!.enabled = true;
    assert.equal((await service.resolve()).provider, "codex");
    settings.codingProviderSettings.codex!.enabled = false;
    settings.codingProviderSettings.copilot!.enabled = false;
    await assert.rejects(service.resolve(), /Provider codex is disabled/);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "新規Sessionの初期設定は保存完了前でも同providerの現在選択を優先する"
  // oracle = { type = "contract", ref = "docs/design/electron-session-store.md#実行設定と-send" }
  // fault = "現在選択があるのにDBの古い値を初期値に使う"
  // observable = "resolveが返すmodel、reasoningEffort、speed、reviewer"
  // observation_boundary = "public-boundary"
  // scope = "session-launch-selection"
  // lifecycle = "permanent"
  // @end-test-value
  it("checkpoint未完了でも現在選択から新規会話を開始する", async () => {
    const service = new SessionLaunchSelectionService({
      getAppSettings: () => normalizeAppSettings({ codingProviderSettings: { codex: { enabled: true } } }),
      getModelCatalogSnapshot: createModelCatalogSnapshot,
      getCurrentExecutionOptions: () => ({ model: "gpt-5.6", reasoningEffort: "xhigh", approvalMode: "untrusted", codexSandboxMode: "workspace-write", codexSpeed: "fast", codexReviewer: "auto-review", customAgentName: "" }),
      getLatestSessionSummaryForProvider: () => createLatestSessionSummary({ provider: "codex", model: "gpt-5.6", reasoningEffort: "high", codexSpeed: "standard", codexReviewer: "user" }),
    });
    const selection = await service.resolve("codex");
    assert.equal(selection.model, "gpt-5.6");
    assert.equal(selection.reasoningEffort, "xhigh");
    assert.equal(selection.codexSpeed, "fast");
    assert.equal(selection.codexReviewer, "auto-review");
  });

  // @test-value v2
  // kind = "contract"
  // claim = "同じproviderの新規Sessionは直近SessionのFastとAuto-reviewをCodex speedとReviewerとして継承する"
  // oracle = { type = "contract", ref = "accepted behavior: new Session runtime selection inheritance" }
  // fault = "Session launch selection serviceが直近SessionのcodexSpeedまたはcodexReviewerを破棄して既定値を返す"
  // observable = "resolve()が返すSessionLaunchSelectionのcodexSpeedとcodexReviewer"
  // observation_boundary = "public-boundary"
  // scope = "session-launch-selection"
  // lifecycle = "permanent"
  // @end-test-value
  it("選択した provider の直近 Session から実行設定をまとめて解決する", async () => {
    const queriedProviderIds: string[] = [];
    const service = new SessionLaunchSelectionService({
      getAppSettings: () => normalizeAppSettings({
        codingProviderSettings: {
          codex: { enabled: true },
          copilot: { enabled: true },
        },
      }),
      getModelCatalogSnapshot: createModelCatalogSnapshot,
      getLatestSessionSummaryForProvider(providerId) {
        queriedProviderIds.push(providerId);
        return createLatestSessionSummary();
      },
    });

    const selection = await service.resolve("copilot");

    assert.deepEqual(queriedProviderIds, ["copilot"]);
    assert.deepEqual(selection, {
      provider: "copilot",
      model: "claude-sonnet",
      reasoningEffort: "high",
      approvalMode: "never",
      codexSandboxMode: "danger-full-access",
      codexSpeed: "fast",
      codexReviewer: "auto-review",
      customAgentName: "reviewer",
    });
  });

  // @test-value v2
  // kind = "contract"
  // claim = "履歴のない新規SessionはCodex speedをStandard、ReviewerをUserで初期化する"
  // oracle = { type = "contract", ref = "accepted behavior: new Session default" }
  // fault = "履歴のない新規SessionがFastまたはAuto-reviewで作成される"
  // observable = "resolveが返すspeedとreviewer"
  // observation_boundary = "public-boundary"
  // scope = "session-launch-selection"
  // lifecycle = "permanent"
  // @end-test-value
  it("対象 provider の履歴がなければ catalog と安全側の既定値を使う", async () => {
    const service = new SessionLaunchSelectionService({
      getAppSettings: () => normalizeAppSettings({
        codingProviderSettings: {
          codex: { enabled: true },
        },
      }),
      getModelCatalogSnapshot: createModelCatalogSnapshot,
      getLatestSessionSummaryForProvider: () => null,
    });

    const selection = await service.resolve("codex");

    assert.deepEqual(selection, {
      provider: "codex",
      model: "gpt-5.6",
      reasoningEffort: "high",
      approvalMode: "untrusted",
      codexSandboxMode: "workspace-write",
      codexSpeed: "standard",
      codexReviewer: "user",
      customAgentName: "",
    });
  });

  // @test-value v2
  // kind = "contract"
  // claim = "履歴のないClaude Agent Sessionはcatalogのmodelを使いon-requestで開始する"
  // oracle = { type = "contract", ref = "accepted behavior: Claude Agent SDK approval mode" }
  // fault = "Claudeの新規Sessionに共通approval既定値のuntrustedを適用する"
  // observable = "resolve()が返すProvider、model、approvalMode"
  // observation_boundary = "public-boundary"
  // scope = "claude-session-launch-defaults"
  // lifecycle = "permanent"
  // impact = "Claude Agent SDKが要求する承認modeと異なる設定でsessionを開始しない"
  // distinction = "runtime option helperのtestではlaunchが実際に選ぶ既定値とcatalog selectionを検出できない"
  // @end-test-value
  it("履歴のないClaude Agent Sessionはon-requestとcatalog既定modelを使う", async () => {
    const service = new SessionLaunchSelectionService({
      getAppSettings: () => normalizeAppSettings({ codingProviderSettings: { claude: { enabled: true } } }),
      getModelCatalogSnapshot: createModelCatalogSnapshot,
      getLatestSessionSummaryForProvider: () => null,
    });

    const selection = await service.resolve("claude");

    assert.equal(selection.provider, "claude");
    assert.equal(selection.model, "claude-opus-5-5");
    assert.equal(selection.approvalMode, "on-request");
  });

  it("直近設定の取得失敗を既定値で隠さない", async () => {
    const service = new SessionLaunchSelectionService({
      getAppSettings: () => normalizeAppSettings({
        codingProviderSettings: {
          codex: { enabled: true },
        },
      }),
      getModelCatalogSnapshot: createModelCatalogSnapshot,
      getLatestSessionSummaryForProvider: () => {
        throw new Error("storage read failed");
      },
    });

    await assert.rejects(service.resolve("codex"), /storage read failed/);
  });
});
