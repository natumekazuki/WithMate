import assert from "node:assert/strict";
import test from "node:test";
import { validateSessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";

import {
  getApprovalOptionsForProvider,
  getDefaultApprovalModeForProvider,
  getSandboxOptionsForProvider,
  getSandboxOptionsForProviderSelection,
} from "../../src-shared/settings/provider-runtime-options.js";

// @test-value v2
// kind = "contract"
// claim = "ClaudeはSDKの全6 permission modeに対応する選択肢を提示し、既定値はon-requestを維持する"
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
    { value: "accept-edits", label: "Accept Edits" },
    { value: "dont-ask", label: "Preapproved Only" },
    { value: "plan", label: "Plan" },
    { value: "auto", label: "Auto Review" },
  ]);
  assert.equal(getDefaultApprovalModeForProvider("claude"), "on-request");
  assert.equal(getDefaultApprovalModeForProvider("codex"), "untrusted");
});

// @test-value v2
// kind = "contract"
// claim = "送信時検証はClaudeの全6 approval値とSpeedを保持し、Claude固有modeをCodex／Copilotへ渡さない"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md#approval-modes; docs/design/electron-session-store.md" }
// fault = "Claude固有modeが共通validationで拒否されるか、別providerへ漏れる"
// observable = "validateSessionExecutionOptionsの返却値とprovider別拒否error、公開候補"
// observation_boundary = "public-boundary"
// scope = "provider execution options validation"
// lifecycle = "permanent"
// impact = "選択できても送信できない状態や別providerへの未対応mode送信を防ぐ"
// distinction = "selector一覧とSDK callback testは送信要求の信頼境界を通らない"
// @end-test-value
test("Claude permission options pass execution validation only for their supported provider", () => {
  const catalog = { id: "claude", label: "Claude", defaultModelId: "model", defaultReasoningEffort: "high" as const,
    models: [{ id: "model", label: "Model", reasoningEfforts: ["high" as const] }] };
  const options = { catalogRevision: 1, model: "model", reasoningEffort: "high", approvalMode: "on-request",
    codexSandboxMode: "workspace-write", codexSpeed: "fast", codexReviewer: "user", customAgentName: "" };
  for (const approvalMode of ["never", "on-request", "accept-edits", "dont-ask", "plan", "auto"]) {
    assert.deepEqual(validateSessionExecutionOptions({ ...options, approvalMode }, catalog, 1), { ...options, approvalMode });
  }
  assert.throws(() => validateSessionExecutionOptions({ ...options, approvalMode: "untrusted" }, catalog, 1), /not supported by this provider/);
  for (const provider of ["codex", "copilot"]) {
    assert.deepEqual(getApprovalOptionsForProvider(provider).map(({ value }) => value), ["never", "on-request", "untrusted"]);
    for (const approvalMode of ["accept-edits", "dont-ask", "plan", "auto"]) {
      assert.throws(() => validateSessionExecutionOptions({ ...options, approvalMode }, { ...catalog, id: provider }, 1), /not supported by this provider/);
    }
  }
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
