import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ModelCatalogSnapshot } from "../../src/model-catalog.js";
import { normalizeAppSettings } from "../../src/provider-settings-state.js";
import type { SessionSummary } from "../../src/session-state.js";
import { SessionLaunchSelectionService } from "../../src-electron/session-launch-selection-service.js";

function createModelCatalogSnapshot(): ModelCatalogSnapshot {
  return {
    revision: 7,
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
  // @test-value v1
  // kind = "contract"
  // claim = "新規Sessionは直近SessionがFastかつAuto-reviewでもCodex speedをStandard、ReviewerをUserから開始する"
  // oracle = { type = "contract", ref = "accepted behavior: new Session default" }
  // failure_mode = "新規Sessionが直近SessionのFastまたはAuto-reviewを暗黙継承する"
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
      catalogRevision: 7,
      model: "claude-sonnet",
      reasoningEffort: "high",
      approvalMode: "never",
      codexSandboxMode: "danger-full-access",
      codexSpeed: "standard",
      codexReviewer: "user",
      customAgentName: "reviewer",
    });
  });

  // @test-value v1
  // kind = "contract"
  // claim = "履歴のない新規SessionはCodex speedをStandard、ReviewerをUserで初期化する"
  // oracle = { type = "contract", ref = "accepted behavior: new Session default" }
  // failure_mode = "履歴のない新規SessionがFastまたはAuto-reviewで作成される"
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
      catalogRevision: 7,
      model: "gpt-5.6",
      reasoningEffort: "high",
      approvalMode: "untrusted",
      codexSandboxMode: "workspace-write",
      codexSpeed: "standard",
      codexReviewer: "user",
      customAgentName: "",
    });
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
