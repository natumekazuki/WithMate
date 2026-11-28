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
/** 非 Codex の親で有効ではない書込み権限を引き継がず、Codex の子の Sandbox が Read Only になることを確認する。 */
test("非CodexのProvider ControlledはCodexの子でRead Onlyを選ぶ", () => {
  for (const provider of ["claude", "copilot", "opencode"]) {
    const inherited = resolveChildSessionPermissions(
      provider,
      {
        approvalMode: "on-request",
        customAgentName: "",
        codexSandboxMode: "danger-full-access",
        codexReviewer: "user",
      },
      "codex",
    );
    assert.equal(inherited.codexSandboxMode, "read-only", provider);
  }
});

// @test-value v2
// kind = "contract"
// claim = "公開4択に対応しない旧固有Approvalは異種へ写像しない"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md#bound-session-api の create_child" }
// fault = "同名のApprovalをそのまま渡すか、等価でないApprovalを別の方針へ変換する"
// observable = "子の権限変換が返すApproval継承拒否エラー"
// observation_boundary = "component-behavior"
// scope = "Claude固有のApproval、Codex/Copilotの旧untrustedの異種変換"
// lifecycle = "permanent"
// impact = "子のProviderで表現できない親の承認制限を失う作成が通ることを防ぐ"
// distinction = "送信時の実行値検証は宛先で同名のApprovalが使えても意味の違いを検出しない"
// risk_tags = ["authorization"]
// @end-test-value
/** 承認の意味が等価でない旧固有モードは、別 Provider の子へ変換せず継承エラーにすることを確認する。 */
test("異種の子は旧固有Approvalの継承を拒否する", () => {
  for (const [source, target, approvalMode] of [
    ["claude", "codex", "accept-edits"],
    ["claude", "codex", "dont-ask"],
    ["claude", "codex", "plan"],
    ["codex", "copilot", "untrusted"],
    ["copilot", "codex", "untrusted"],
  ] as const) {
    assert.throws(
      () =>
        resolveChildSessionPermissions(
          source,
          {
            approvalMode,
            customAgentName: "",
            codexSandboxMode: "danger-full-access",
            codexReviewer: "user",
          },
          target,
        ),
      /Cannot inherit .* approval mode/,
      `${source} → ${target}: ${approvalMode}`,
    );
  }
});

// @test-value v2
// kind = "contract"
// claim = "Claudeの内部承認値の互換集合とProvider別の既定値を維持する"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md#approval-modes" }
// fault = "保存済みClaudeの固有権限を失うか、Claudeの新規Sessionをuntrustedで開始する"
// observable = "承認optionのvalue一覧とprovider別既定mode"
// observation_boundary = "public-boundary"
// scope = "claude-approval-options"
// lifecycle = "permanent"
// impact = "Claude SDKでサポートされない実行modeの選択・既定利用を防ぐ"
// distinction = "型は全provider共通のapproval unionを許すため、provider別option/defaultの実値を確認する"
// @end-test-value
/** Claude の固有モードが選択肢から漏れず、Claude と Codex がそれぞれの既定の承認方式を維持することを確かめる。 */
test("Claude preserves accepted internal approval values and the on-request default", () => {
  assert.deepEqual(
    new Set(getApprovalOptionsForProvider("claude").map(({ value }) => value)),
    new Set([
      "never",
      "on-request",
      "accept-edits",
      "dont-ask",
      "plan",
      "safety-focused",
    ]),
  );
  assert.equal(getDefaultApprovalModeForProvider("claude"), "on-request");
  assert.equal(getDefaultApprovalModeForProvider("codex"), "untrusted");
});

// @test-value v2
// kind = "contract"
// claim = "送信時検証はClaudeの承認方針・Reviewerの有効な組合せとSpeedを保持し、不正な組合せと他provider向け固有modeを拒否する"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md#approval-modes; docs/design/electron-session-store.md" }
// fault = "対応するClaude設定が拒否されるか、Auto Reviewと固有方針の不正な組合せや別providerへの固有mode送信を許す"
// observable = "validateSessionExecutionOptionsの返却値とprovider別拒否error、内部候補"
// observation_boundary = "public-boundary"
// scope = "provider execution options validation"
// lifecycle = "permanent"
// impact = "選択できても送信できない状態や別providerへの未対応mode送信を防ぐ"
// distinction = "selector一覧とSDK callback testは送信要求の信頼境界を通らない"
// @end-test-value
/** Claude の有効な承認・Reviewer・Speed の指定は送信時に保持し、非対応の組合せや他 Provider 向け固有モードは拒否することを確認する。 */
test("Claude permission options pass execution validation only for their supported provider", () => {
  const catalog = {
    id: "claude",
    label: "Claude",
    defaultModelId: "model",
    defaultReasoningEffort: "high" as const,
    models: [
      { id: "model", label: "Model", reasoningEfforts: ["high" as const] },
    ],
  };
  const options = {
    model: "model",
    reasoningEffort: "high",
    approvalMode: "on-request",
    codexSandboxMode: "workspace-write",
    codexSpeed: "fast",
    codexReviewer: "user",
    customAgentName: "",
  };
  for (const approvalMode of [
    "never",
    "on-request",
    "accept-edits",
    "dont-ask",
    "plan",
    "safety-focused",
  ]) {
    assert.deepEqual(
      validateSessionExecutionOptions({ ...options, approvalMode }, catalog),
      { ...options, approvalMode },
    );
  }
  assert.throws(
    () =>
      validateSessionExecutionOptions(
        { ...options, approvalMode: "untrusted" },
        catalog,
      ),
    /not supported by this provider/,
  );
  for (const approvalMode of ["never", "on-request"]) {
    const selected = { ...options, approvalMode, codexReviewer: "auto-review" };
    assert.deepEqual(
      validateSessionExecutionOptions(selected, catalog),
      selected,
    );
  }
  for (const approvalMode of ["accept-edits", "dont-ask", "plan"]) {
    assert.throws(
      () =>
        validateSessionExecutionOptions(
          { ...options, approvalMode, codexReviewer: "auto-review" },
          catalog,
        ),
      /reviewer is not supported with this approval mode/,
    );
  }
  for (const provider of ["codex", "copilot"]) {
    assert.deepEqual(
      getApprovalOptionsForProvider(provider).map(({ value }) => value),
      ["never", "on-request", "untrusted", "safety-focused"],
    );
    for (const approvalMode of ["accept-edits", "dont-ask", "plan"]) {
      assert.throws(
        () =>
          validateSessionExecutionOptions(
            { ...options, approvalMode },
            { ...catalog, id: provider },
          ),
        /not supported by this provider/,
      );
    }
  }
});

// @test-value v2
// kind = "contract"
// claim = "OpenCodeの内部Approvalはon-request、never、safety-focusedだけを受け付け、既定はon-requestを保つ"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md#approval-modes" }
// fault = "native API非対応のmodeを選べるか、未承認で自動実行を既定にする"
// observable = "approval option value一覧とprovider既定mode"
// observation_boundary = "public-boundary"
// scope = "opencode-approval-options"
// lifecycle = "permanent"
// impact = "承認の意味がnative runtimeと一致せず、意図しない自動実行または実行失敗になる"
// distinction = "共通approval型は全providerのmodeを許すためprovider固有の許可集合を検出できない"
// @end-test-value
/** OpenCode の承認候補に Safety Focused を含めても、既定値は on-request のままであることを確認する。 */
test("OpenCode accepts Safety Focused without changing the existing approval default", () => {
  assert.deepEqual(
    getApprovalOptionsForProvider("opencode").map((option) => option.value),
    ["never", "on-request", "safety-focused"],
  );
  assert.equal(getDefaultApprovalModeForProvider("opencode"), "on-request");
});

/** Codex 向けの候補に Workspace への書込みを許す Sandbox が含まれることを確認する。 */
test("getSandboxOptionsForProvider は Codex provider に Sandbox 選択肢を返す", () => {
  const codexOptions = getSandboxOptionsForProvider("codex");

  assert.ok(codexOptions.some((option) => option.value === "workspace-write"));
});

/** Copilot または Provider 未選択の状態には Codex 専用の Sandbox 候補を返さないことを確認する。 */
test("getSandboxOptionsForProvider は非 Codex provider では Sandbox 選択肢を返さない", () => {
  assert.deepEqual(getSandboxOptionsForProvider("copilot"), []);
  assert.deepEqual(getSandboxOptionsForProvider(null), []);
});

/** Workspace Write が保存済みでも、Copilot 選択時には Sandbox 候補が空のままであることを確かめる。 */
test("getSandboxOptionsForProviderSelection は非 Codex provider で保存済み値を補完しない", () => {
  assert.deepEqual(
    getSandboxOptionsForProviderSelection("copilot", "workspace-write"),
    [],
  );
});

/** Codex の選択肢から保存済みの Workspace Write が欠落しないことを確認する。 */
test("getSandboxOptionsForProviderSelection は Codex provider で保存済み値を選択肢に含める", () => {
  const options = getSandboxOptionsForProviderSelection(
    "codex",
    "workspace-write",
  );

  assert.ok(options.some((option) => option.value === "workspace-write"));
});
