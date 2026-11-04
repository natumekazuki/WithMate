import assert from "node:assert/strict";
import { it } from "node:test";

import {
  assertModelEnabled,
  getModelDisabledReason,
  getModelServiceId,
  normalizeModelAvailability,
} from "../../src-shared/settings/model-availability.js";

// @test-value v2
// kind = "contract"
// claim = "OpenCode配信元OFFは新規modelにも優先適用され、再ON後も個別OFFを保持し、未設定modelは利用できる"
// oracle = { type = "contract", ref = "docs/design/model-catalog.md" }
// fault = "一覧にないmodelを無効にするか配信元OFFを既知modelだけに適用し、再ONで個別OFFを失う"
// observable = "配信元ID、無効理由、assertModelEnabledの成功または例外"
// observation_boundary = "public-boundary"
// scope = "model-availability-precedence"
// lifecycle = "permanent"
// impact = "利用者が無効化した配信元やmodelへ実行を送る"
// distinction = "SDKやUIに依存せず新規IDを含む判定の継続契約を検証する"
// @end-test-value
it("配信元OFFを優先し個別OFFと未設定modelの有効状態を保持する", () => {
  const settings = normalizeModelAvailability({
    opencode: { disabledServiceIds: ["openai"], disabledModelIds: ["openai/model/nested"] },
    codex: { disabledServiceIds: ["openai"], disabledModelIds: ["specific"] },
  });
  assert.equal(getModelServiceId("opencode", "openai/model/nested"), "openai");
  assert.equal(getModelServiceId("codex", "openai/model"), null);
  assert.equal(getModelServiceId("opencode", "model"), null);
  assert.equal(getModelDisabledReason(settings, "opencode", "openai/model/nested"), "service");
  assert.equal(getModelDisabledReason(settings, "opencode", "openai/new-model"), "service");
  assert.throws(() => assertModelEnabled(settings, "opencode", "openai/new-model"), /disabled by service/);
  settings.opencode.disabledServiceIds = [];
  assert.equal(getModelDisabledReason(settings, "opencode", "openai/model/nested"), "model");
  assert.throws(() => assertModelEnabled(settings, "opencode", "openai/model/nested"), /disabled by model/);
  assert.doesNotThrow(() => assertModelEnabled(settings, "opencode", "openai/new-model"));
  assert.doesNotThrow(() => assertModelEnabled(settings, "codex", "openai/model"));
  assert.doesNotThrow(() => assertModelEnabled(settings, "unknown", "unlisted-model"));
  assert.equal(getModelDisabledReason(settings, "codex", "specific"), "model");
});

// @test-value v2
// kind = "contract"
// claim = "無効化設定は未設定時だけ空となり、不正な明示入力を拒否して未知のproviderとIDを保持する"
// oracle = { type = "contract", ref = "docs/design/model-catalog.md" }
// fault = "不正入力を空設定へ救済し無効化が解除されるか、未知IDを削除する"
// observable = "normalizeModelAvailabilityの返値と例外"
// observation_boundary = "public-boundary"
// scope = "model-availability-input-validation"
// lifecycle = "permanent"
// impact = "設定保存や読込によって利用者の無効化指定を失う"
// distinction = "型だけでは保護できないJSONやIPC由来の入力を検証する"
// @end-test-value
it("未設定だけを補い不正値を拒否し未知のIDを保持する", () => {
  assert.deepEqual(normalizeModelAvailability(undefined), {});
  const unknown = { future: { disabledServiceIds: ["future-service"], disabledModelIds: ["future/model"] } };
  const normalized = normalizeModelAvailability(unknown);
  assert.deepEqual(normalized, unknown);
  normalized.future.disabledModelIds.push("other");
  assert.deepEqual(unknown.future.disabledModelIds, ["future/model"]);
  for (const value of [null, [], false, "", { opencode: null }, { opencode: {} },
    { opencode: { disabledServiceIds: [], disabledModelIds: [42] } },
    { opencode: { disabledServiceIds: [" "], disabledModelIds: [] } }]) {
    assert.throws(() => normalizeModelAvailability(value), /Model availability/);
  }
});
