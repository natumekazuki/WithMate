import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createDefaultAppSettings,
  DEFAULT_GLOSSARY_PROACTIVE_CREATE_LIMIT,
  normalizeAppSettings,
  isPreviewWheelZoomStep,
} from "../../src-shared/settings/provider-settings-state.js";

describe("provider-settings-state", () => {
  // @test-value v2
  // kind = "contract"
  // claim = "アプリ設定境界はmodel無効化の未設定だけを空へ補い、未知IDを保持して明示不正値を拒否する"
  // oracle = { type = "contract", ref = "docs/design/model-catalog.md" }
  // fault = "アプリ設定の正規化でmodel無効化を脱落させるか不正値を空へ置換する"
  // observable = "defaultとnormalizeAppSettingsのmodelAvailabilityおよび例外"
  // observation_boundary = "public-boundary"
  // scope = "app-settings-model-availability-validation"
  // lifecycle = "permanent"
  // impact = "IPC設定更新で無効化が解除される"
  // distinction = "無効化helper単体では全アプリ設定の正規化経路での脱落を検出できない"
  // @end-test-value
  it("model無効化設定をアプリ設定として検証し保持する", () => {
    assert.deepEqual(createDefaultAppSettings().modelAvailability, {});
    assert.deepEqual(normalizeAppSettings({}).modelAvailability, {});
    const modelAvailability = { future: { disabledServiceIds: ["unknown"], disabledModelIds: ["future/model"] } };
    assert.deepEqual(normalizeAppSettings({ modelAvailability }).modelAvailability, modelAvailability);
    assert.throws(() => normalizeAppSettings({ modelAvailability: null }), /Model availability/);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "preview wheelの刻みは既定5、欠落時のみ5を補い、1〜100の整数以外は拒否する"
  // oracle = { type = "contract", ref = "docs/design/settings-ui.md" }
  // fault = "不正値を丸めるか既定値に置換し、意図しないzoom刻みを成功扱いする"
  // observable = "defaultとnormalizeのpreviewWheelZoomStep、validatorのboolean、normalizeの例外"
  // observation_boundary = "public-boundary"
  // scope = "preview-wheel-zoom-step-settings-validation"
  // lifecycle = "permanent"
  // impact = "設定保存や全previewへ不正な刻みが伝わる"
  // distinction = "型検査では検出できないIPC等のunknown入力と欠落設定のruntime境界を小さな入力集合で確認する"
  // @end-test-value
  it("preview wheel zoom stepは欠落時5で、1〜100の整数だけを受け入れる", () => {
    assert.equal(createDefaultAppSettings().previewWheelZoomStep, 5);
    assert.equal(normalizeAppSettings({}).previewWheelZoomStep, 5);
    assert.equal(normalizeAppSettings({ previewWheelZoomStep: undefined }).previewWheelZoomStep, 5);
    for (const value of [1, 5, 100]) {
      assert.equal(isPreviewWheelZoomStep(value), true);
      assert.equal(normalizeAppSettings({ previewWheelZoomStep: value }).previewWheelZoomStep, value);
    }
    for (const value of [0, -1, 101, 1.5, NaN, Infinity, -Infinity, "5", "", null, true, {}]) {
      assert.equal(isPreviewWheelZoomStep(value), false);
      assert.throws(
        () => normalizeAppSettings({ previewWheelZoomStep: value }),
        /Preview wheel zoom step must be an integer between 1 and 100/,
      );
    }
  });

  it("glossary proactive create limitは0から100の整数だけを保持し、欠落・不正値をfallbackしない", () => {
    assert.equal(normalizeAppSettings({ glossaryProactiveCreateLimit: 0 }).glossaryProactiveCreateLimit, 0);
    assert.equal(normalizeAppSettings({ glossaryProactiveCreateLimit: 100 }).glossaryProactiveCreateLimit, 100);
    assert.equal(normalizeAppSettings({ glossaryProactiveCreateLimit: 5.5 }).glossaryProactiveCreateLimit, null);
    assert.equal(normalizeAppSettings({ glossaryProactiveCreateLimit: 101 }).glossaryProactiveCreateLimit, null);
    assert.equal(normalizeAppSettings({ glossaryProactiveCreateLimit: "5" }).glossaryProactiveCreateLimit, null);
    assert.equal(normalizeAppSettings({}).glossaryProactiveCreateLimit, null);
  });

  it("action dock auto close は normalize で boolean を保持し、未設定時は true に寄せる", () => {
    assert.equal(normalizeAppSettings({ autoCollapseActionDockOnSend: false }).autoCollapseActionDockOnSend, false);
    assert.equal(normalizeAppSettings({}).autoCollapseActionDockOnSend, true);
  });

  it("send scroll は normalize で boolean を保持し、未設定時は true に寄せる", () => {
    assert.equal(normalizeAppSettings({ scrollToLatestOnSend: false }).scrollToLatestOnSend, false);
    assert.equal(normalizeAppSettings({}).scrollToLatestOnSend, true);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "chat layout preference normalize は priority なしの canonical shape を返す"
  // oracle = { type = "contract", ref = "AppSettings normalization" }
  // fault = "入力の廃止済み priority が normalized settings に残る"
  // observable = "normalizeAppSettings の chatLayoutPreference"
  // observation_boundary = "public-boundary"
  // scope = "normalized-chat-layout-settings"
  // lifecycle = "permanent"
  // impact = "廃止設定が settings projection に混入する"
  // distinction = "valid/invalid side pane の normalize と field shape を確認する"
  // @end-test-value
  it("chat layout preference は項目ごとに canonical enum へ normalize する", () => {
    assert.deepEqual(normalizeAppSettings({
      chatLayoutPreference: {
        header: "visible",
        actionDock: "expanded",
        sidePane: "context",
      },
    }).chatLayoutPreference, {
      header: "visible",
      actionDock: "expanded",
      sidePane: "context",
    });
    assert.deepEqual(normalizeAppSettings({
      chatLayoutPreference: { header: "invalid", actionDock: false, sidePane: "left" },
    }).chatLayoutPreference, {
      header: "hidden",
      actionDock: "compact",
      sidePane: "none",
    });
  });

  it("launch at login は default false で boolean を保持する", () => {
    assert.equal(createDefaultAppSettings().launchAtLoginEnabled, false);
    assert.equal(normalizeAppSettings({ launchAtLoginEnabled: true }).launchAtLoginEnabled, true);
    assert.equal(normalizeAppSettings({ launchAtLoginEnabled: "true" }).launchAtLoginEnabled, false);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "承認通知設定は既定有効でbooleanのみを保持しturn通知の設定値に依存しない"
  // oracle = { type = "contract", ref = "docs/design/settings-ui.md#decision" }
  // fault = "承認通知の欠落・不正値を無効化するかturn通知の値で承認通知を上書きする"
  // observable = "createDefaultAppSettingsとnormalizeAppSettingsの承認通知boolean"
  // observation_boundary = "public-boundary"
  // scope = "approval-notification-settings-normalization"
  // lifecycle = "permanent"
  // distinction = "保存層ではなくIPC入力のboolean正規化を直接確認する"
  // @end-test-value
  it("承認通知設定は独立した既定trueのbooleanを保持する", () => {
    assert.equal(createDefaultAppSettings().sessionApprovalNotificationEnabled, true);
    assert.equal(normalizeAppSettings({ sessionApprovalNotificationEnabled: false }).sessionApprovalNotificationEnabled, false);
    assert.equal(normalizeAppSettings({ sessionApprovalNotificationEnabled: "false" }).sessionApprovalNotificationEnabled, true);
    assert.equal(normalizeAppSettings({ sessionTurnNotificationEnabled: false }).sessionApprovalNotificationEnabled, true);
  });

  it("Session turn notification は default true で boolean を保持する", () => {
    assert.equal(createDefaultAppSettings().sessionTurnNotificationEnabled, true);
    assert.equal(normalizeAppSettings({ sessionTurnNotificationEnabled: false }).sessionTurnNotificationEnabled, false);
    assert.equal(normalizeAppSettings({ sessionTurnNotificationEnabled: "false" }).sessionTurnNotificationEnabled, true);
  });

  it("Session turn notification response preview は default false で boolean を保持する", () => {
    assert.equal(createDefaultAppSettings().sessionTurnNotificationResponsePreviewEnabled, false);
    assert.equal(
      normalizeAppSettings({ sessionTurnNotificationResponsePreviewEnabled: true })
        .sessionTurnNotificationResponsePreviewEnabled,
      true,
    );
    assert.equal(
      normalizeAppSettings({ sessionTurnNotificationResponsePreviewEnabled: "true" })
        .sessionTurnNotificationResponsePreviewEnabled,
      false,
    );
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "foreground prompt context の個別設定は既定で有効になり、明示した boolean 値だけを保持する"
  // oracle = { type = "contract", ref = "Prompt context settings" }
  // fault = "既存利用者の prompt 注入が欠落するか、設定値の無効入力で意図しない注入状態になる"
  // observable = "createDefaultAppSettings と normalizeAppSettings の prompt context fields"
  // observation_boundary = "public-boundary"
  // scope = "prompt-context-settings-normalization"
  // lifecycle = "permanent"
  // impact = "設定保存・IPC・provider prompt 合成へ渡る toggle の既定状態が変わる"
  // distinction = "既存の boolean settings の normalize と異なる prompt context 3項目を一括で確認する"
  // @end-test-value
  it("foreground prompt context は既定有効で、false と無効値を正しく normalize する", () => {
    const defaults = createDefaultAppSettings();

    assert.equal(defaults.characterDefinitionEnabled, true);
    assert.equal(defaults.conversationTimingEnabled, true);
    assert.equal(defaults.toolCallPresenceEnabled, true);
    const normalizedOff = normalizeAppSettings({
      characterDefinitionEnabled: false,
      conversationTimingEnabled: false,
      toolCallPresenceEnabled: false,
    });
    assert.equal(normalizedOff.characterDefinitionEnabled, false);
    assert.equal(normalizedOff.conversationTimingEnabled, false);
    assert.equal(normalizedOff.toolCallPresenceEnabled, false);
    const normalizedMixed = normalizeAppSettings({
      characterDefinitionEnabled: true,
      conversationTimingEnabled: false,
      toolCallPresenceEnabled: true,
    });

    assert.equal(normalizedMixed.characterDefinitionEnabled, true);
    assert.equal(normalizedMixed.conversationTimingEnabled, false);
    assert.equal(normalizedMixed.toolCallPresenceEnabled, true);
    const normalizedInvalid = normalizeAppSettings({
      characterDefinitionEnabled: "false",
      conversationTimingEnabled: null,
      toolCallPresenceEnabled: 0,
    });

    assert.equal(normalizedInvalid.characterDefinitionEnabled, true);
    assert.equal(normalizedInvalid.conversationTimingEnabled, true);
    assert.equal(normalizedInvalid.toolCallPresenceEnabled, true);

    const normalizedMissing = normalizeAppSettings({});
    assert.equal(normalizedMissing.characterDefinitionEnabled, true);
    assert.equal(normalizedMissing.conversationTimingEnabled, true);
    assert.equal(normalizedMissing.toolCallPresenceEnabled, true);
  });

});
