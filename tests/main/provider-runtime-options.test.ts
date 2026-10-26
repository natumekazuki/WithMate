import assert from "node:assert/strict";
import test from "node:test";

import {
  getApprovalOptionsForProvider,
  getDefaultApprovalModeForProvider,
  getSandboxOptionsForProvider,
  getSandboxOptionsForProviderSelection,
} from "../../src-shared/settings/provider-runtime-options.js";

// @test-value v2
// kind = "contract"
// claim = "Claudeの実行設定はon-requestだけを提示し、新規Claude Sessionのapproval既定値もon-requestにする"
// oracle = { type = "contract", ref = "accepted behavior: Claude Agent SDK approval mode" }
// fault = "未対応の承認modeをClaude UIで選択できるか、Claudeの新規Sessionをuntrustedで開始する"
// observable = "承認optionのvalue一覧とprovider別既定mode"
// observation_boundary = "public-boundary"
// scope = "claude-approval-options"
// lifecycle = "permanent"
// impact = "Claude SDKでサポートされない実行modeの選択・既定利用を防ぐ"
// distinction = "型は全provider共通のapproval unionを許すため、provider別option/defaultの実値を確認する"
// @end-test-value
test("Claude は承認待ちのみを選択でき、新規Sessionの既定値もon-requestになる", () => {
  assert.deepEqual(getApprovalOptionsForProvider("claude").map((option) => option.value), ["on-request"]);
  assert.equal(getDefaultApprovalModeForProvider("claude"), "on-request");
  assert.equal(getDefaultApprovalModeForProvider("codex"), "untrusted");
});

// @test-value v2
// kind = "contract"
// claim = "OpenCodeの承認選択肢はon-requestとneverで、既定値はon-requestになる"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/879" }
// fault = "native API非対応のmodeを選べるか、未承認で自動実行を既定にする"
// observable = "approval option value一覧とprovider既定mode"
// observation_boundary = "public-boundary"
// scope = "opencode-approval-options"
// lifecycle = "permanent"
// impact = "承認の意味がnative runtimeと一致せず、意図しない自動実行または実行失敗になる"
// distinction = "共通approval型は全providerのmodeを許すためprovider固有の許可集合を検出できない"
// @end-test-value
test("OpenCode はProvider ControlledとAuto Runを提供し承認待ちを既定にする", () => {
  assert.deepEqual(getApprovalOptionsForProvider("opencode").map((option) => option.value), ["never", "on-request"]);
  assert.equal(getDefaultApprovalModeForProvider("opencode"), "on-request");
});

test("getSandboxOptionsForProvider は Codex provider に Sandbox 選択肢を返す", () => {
  const codexOptions = getSandboxOptionsForProvider("codex");

  assert.ok(codexOptions.some((option) => option.value === "workspace-write"));
});

test("getSandboxOptionsForProvider は非 Codex provider では Sandbox 選択肢を返さない", () => {
  assert.deepEqual(getSandboxOptionsForProvider("copilot"), []);
  assert.deepEqual(getSandboxOptionsForProvider(null), []);
});

test("getSandboxOptionsForProviderSelection は非 Codex provider で保存済み値を補完しない", () => {
  assert.deepEqual(getSandboxOptionsForProviderSelection("copilot", "workspace-write"), []);
});

test("getSandboxOptionsForProviderSelection は Codex provider で保存済み値を選択肢に含める", () => {
  const options = getSandboxOptionsForProviderSelection("codex", "workspace-write");

  assert.ok(options.some((option) => option.value === "workspace-write"));
});
