import assert from "node:assert/strict";
import test from "node:test";
import { validateSessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";

import {
  getApprovalOptionsForProvider,
  getDefaultApprovalModeForProvider,
  getSandboxOptionsForProvider,
  getSandboxOptionsForProviderSelection,
  resolveChildSessionPermissions,
} from "../../src-shared/settings/provider-runtime-options.js";

// @test-value v2
// kind = "contract"
// claim = "非CodexのProvider ControlledからCodexへ子を作るとRead Onlyが選ばれる"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md#bound-session-api の create_child" }
// fault = "非Codexでは効いていないSandbox値を引き継ぐか、CodexのSandboxを未指定にする"
// observable = "子の権限変換が返すCodex Sandbox"
// observation_boundary = "component-behavior"
// scope = "非CodexのProvider ControlledからCodexへの新規子の権限変換"
// lifecycle = "permanent"
// impact = "親で確認対象だった書込みを子の初期Sandboxで許可することを防ぐ"
// distinction = "Provider設定の候補や実行値の型は変換時に選んだSandboxを検証しない"
// risk_tags = ["authorization"]
// @end-test-value
test("非CodexのProvider ControlledはCodexの子でRead Onlyを選ぶ", () => {
  for (const provider of ["claude", "copilot", "opencode"]) {
    const inherited = resolveChildSessionPermissions(provider, {
      approvalMode: "on-request",
      codexSandboxMode: "danger-full-access",
      codexReviewer: "user",
    }, "codex");
    assert.equal(inherited.codexSandboxMode, "read-only", provider);
  }
});

// @test-value v2
// kind = "contract"
// claim = "異種の子ではAuto RunやProvider固有のApprovalを移さない"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md#bound-session-api の create_child" }
// fault = "同名のApprovalをそのまま渡すか、等価でないApprovalを別の方針へ変換する"
// observable = "子の権限変換が返すApproval継承拒否エラー"
// observation_boundary = "component-behavior"
// scope = "Auto Run、Claude固有のApproval、Codex/CopilotのSafety Focusedの異種変換"
// lifecycle = "permanent"
// impact = "子のProviderで表現できない親の承認制限を失う作成が通ることを防ぐ"
// distinction = "送信時の実行値検証は宛先で同名のApprovalが使えても意味の違いを検出しない"
// risk_tags = ["authorization"]
// @end-test-value
test("異種の子はAuto Runと非等価なApprovalの継承を拒否する", () => {
  for (const [source, target, approvalMode] of [
    ["claude", "codex", "never"],
    ["claude", "codex", "accept-edits"],
    ["claude", "codex", "dont-ask"],
    ["claude", "codex", "plan"],
    ["codex", "copilot", "untrusted"],
    ["copilot", "codex", "untrusted"],
  ] as const) {
    assert.throws(() => resolveChildSessionPermissions(source, {
      approvalMode,
      codexSandboxMode: "danger-full-access",
      codexReviewer: "user",
    }, target), /Cannot inherit .* approval mode/, `${source} → ${target}: ${approvalMode}`);
  }
});

// @test-value v2
// kind = "contract"
// claim = "ClaudeはWithMateの5つの承認方針を提示し、既定値はon-requestを維持する"
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
  ]);
  assert.equal(getDefaultApprovalModeForProvider("claude"), "on-request");
  assert.equal(getDefaultApprovalModeForProvider("codex"), "untrusted");
});

// @test-value v2
// kind = "contract"
// claim = "送信時検証はClaudeの承認方針・Reviewerの有効な組合せとSpeedを保持し、不正な組合せと他provider向け固有modeを拒否する"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md#approval-modes; docs/design/electron-session-store.md" }
// fault = "対応するClaude設定が拒否されるか、Auto Reviewと固有方針の不正な組合せや別providerへの固有mode送信を許す"
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
  const options = { model: "model", reasoningEffort: "high", approvalMode: "on-request",
    codexSandboxMode: "workspace-write", codexSpeed: "fast", codexReviewer: "user", customAgentName: "" };
  for (const approvalMode of ["never", "on-request", "accept-edits", "dont-ask", "plan"]) {
    assert.deepEqual(validateSessionExecutionOptions({ ...options, approvalMode }, catalog), { ...options, approvalMode });
  }
  assert.throws(() => validateSessionExecutionOptions({ ...options, approvalMode: "untrusted" }, catalog), /not supported by this provider/);
  for (const approvalMode of ["never", "on-request"]) {
    const selected = { ...options, approvalMode, codexReviewer: "auto-review" };
    assert.deepEqual(validateSessionExecutionOptions(selected, catalog), selected);
  }
  for (const approvalMode of ["accept-edits", "dont-ask", "plan"]) {
    assert.throws(() => validateSessionExecutionOptions({ ...options, approvalMode, codexReviewer: "auto-review" }, catalog), /reviewer is not supported with this approval mode/);
  }
  for (const provider of ["codex", "copilot"]) {
    assert.deepEqual(getApprovalOptionsForProvider(provider).map(({ value }) => value), ["never", "on-request", "untrusted"]);
    for (const approvalMode of ["accept-edits", "dont-ask", "plan"]) {
      assert.throws(() => validateSessionExecutionOptions({ ...options, approvalMode }, { ...catalog, id: provider }), /not supported by this provider/);
    }
  }
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
