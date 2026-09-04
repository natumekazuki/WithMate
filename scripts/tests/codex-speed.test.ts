import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_CODEX_SPEED,
  getCodexSpeedOptions,
  mapCodexSpeedToServiceTier,
  normalizeCodexSpeed,
} from "../../src/codex-speed.js";
import { buildRuntimeSelectionOptions } from "../../src/runtime-selection-options.js";

describe("Codex speed runtime option", () => {
  // @test-value v1
  // kind = "invariant"
  // claim = "Codex speedの欠落・未知値はStandardへ閉じ、tierとprovider別表示をcanonical ownerから決定する"
  // oracle = { type = "contract", ref = "accepted behavior: persisted selection / provider execution / shared UI" }
  // failure_mode = "既存rowがFastへ昇格する、Standardがglobal Fastを継承する、またはCodex以外へSpeed controlが現れる"
  // scope = "codex-speed"
  // lifecycle = "permanent"
  // @end-test-value
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
  });

  // @test-value v1
  // kind = "contract"
  // claim = "shared runtime selection projectionはCodexだけにSpeed選択肢を公開する"
  // oracle = { type = "contract", ref = "accepted behavior: shared UI" }
  // failure_mode = "CopilotなどCodex以外のshared composerにSpeed controlが表示される"
  // scope = "runtime-selection-options"
  // lifecycle = "permanent"
  // @end-test-value
  it("shared runtime selectionではCodex以外のSpeed optionsを空にする", () => {
    const common = {
      providerCatalog: null,
      models: [],
      selectedModel: "",
      reasoningEfforts: [],
      selectedApprovalMode: "untrusted" as const,
      selectedCodexSandboxMode: "workspace-write" as const,
      selectedCodexSpeed: "fast" as const,
    };

    assert.deepEqual(buildRuntimeSelectionOptions({ ...common, providerId: "copilot" }).speedSelectOptions, []);
    assert.deepEqual(buildRuntimeSelectionOptions({ ...common, providerId: "codex" }).speedSelectOptions, [
      { value: "standard", label: "Standard" },
      { value: "fast", label: "Fast" },
    ]);
  });
});
