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
// claim = "Claudeの実行設定はneverとon-requestを提示し、新規Claude Sessionのapproval既定値はon-requestを維持する"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md#approval-modes" }
// fault = "未対応の承認modeをClaude UIで選択できるか、Claudeの新規Sessionをuntrustedで開始する"
// observable = "承認optionのvalue一覧とprovider別既定mode"
// observation_boundary = "public-boundary"
// scope = "claude-approval-options"
// lifecycle = "permanent"
// impact = "Claude SDKでサポートされない実行modeの選択・既定利用を防ぐ"
// distinction = "型は全provider共通のapproval unionを許すため、provider別option/defaultの実値を確認する"
// @end-test-value
test("Claude は自動実行と承認待ちを選択でき、新規Sessionの既定値はon-requestを維持する", () => {
  assert.deepEqual(getApprovalOptionsForProvider("claude"), [
    { value: "never", label: "Auto Run" },
    { value: "on-request", label: "Provider Controlled" },
  ]);
  assert.equal(getDefaultApprovalModeForProvider("claude"), "on-request");
  assert.equal(getDefaultApprovalModeForProvider("codex"), "untrusted");
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
