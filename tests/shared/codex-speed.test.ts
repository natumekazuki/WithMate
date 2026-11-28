import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_CODEX_SPEED,
  getCodexSpeedOptions,
  mapCodexSpeedToServiceTier,
  normalizeCodexSpeed,
} from "../../src-shared/settings/codex-speed.js";
import { buildRuntimeSelectionOptions } from "../../src/settings/runtime-selection-options.js";

/** 保存された Speed、Codex の実行値、選択 UI の対応がプロバイダー別に整合することを確認する。 */
describe("Codex speed runtime option", () => {
  // @test-value v2
  // kind = "invariant"
  // claim = "speedの欠落・未知値はStandardへ閉じ、Codex／ClaudeへStandardとFastを提示する"
  // oracle = { type = "contract", ref = "accepted behavior: persisted selection / provider execution / shared UI" }
  // fault = "既存rowがFastへ昇格するか、ClaudeでFastを選べないか、Copilotへ未対応Speedが現れる"
  // observable = "speed正規化値、Codex tier写像、provider別候補一覧"
  // observation_boundary = "public-boundary"
  // scope = "codex-speed"
  // lifecycle = "permanent"
  // @end-test-value
  /** 未設定と未知の Speed を Standard として扱い、Codex のサービス階層に変換できることと、対応するプロバイダーだけに Speed 候補があることを確認する。 */
  it("normalizer・service tier写像・provider別optionsを一貫して返す", () => {
    assert.equal(DEFAULT_CODEX_SPEED, "standard");
    assert.equal(normalizeCodexSpeed(undefined), "standard");
    assert.equal(normalizeCodexSpeed("unexpected"), "standard");
    assert.equal(normalizeCodexSpeed("fast"), "fast");
    assert.equal(mapCodexSpeedToServiceTier("standard"), "default");
    assert.equal(mapCodexSpeedToServiceTier("fast"), "fast");
    assert.deepEqual(getCodexSpeedOptions("codex"), [
      { value: "standard", label: "Standard" },
      { value: "fast", label: "Fast" },
    ]);
    assert.deepEqual(getCodexSpeedOptions("copilot"), []);
    assert.deepEqual(getCodexSpeedOptions("claude"), [
      { value: "standard", label: "Standard" },
      { value: "fast", label: "Fast" },
    ]);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "shared runtime selection projectionはCodexとClaudeにSpeed選択肢を公開しCopilotには出さない"
  // oracle = { type = "contract", ref = "accepted behavior: shared UI" }
  // fault = "ClaudeのSpeed controlが欠落するかCopilotへ未対応Speedを表示する"
  // observable = "providerId別のspeedSelectOptions配列"
  // observation_boundary = "public-boundary"
  // scope = "runtime-selection-options"
  // lifecycle = "permanent"
  // @end-test-value
  /** 共有選択データでは Codex と Claude に Standard／Fast が並び、非対応の Copilot に候補が出ないことを確認する。 */
  it("shared runtime selectionではCodexとClaudeのSpeed optionsを公開する", () => {
    const common = {
      providerCatalog: null,
      models: [],
      selectedModel: "",
      reasoningEfforts: [],
      selectedCodexSandboxMode: "workspace-write" as const,
      selectedCodexSpeed: "fast" as const,
    };

    assert.deepEqual(
      buildRuntimeSelectionOptions({ ...common, providerId: "copilot" })
        .speedSelectOptions,
      [],
    );
    assert.deepEqual(
      buildRuntimeSelectionOptions({ ...common, providerId: "claude" })
        .speedSelectOptions,
      [
        { value: "standard", label: "Standard" },
        { value: "fast", label: "Fast" },
      ],
    );
    assert.deepEqual(
      buildRuntimeSelectionOptions({ ...common, providerId: "codex" })
        .speedSelectOptions,
      [
        { value: "standard", label: "Standard" },
        { value: "fast", label: "Fast" },
      ],
    );
  });
});
