import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createDefaultAppSettings,
  DEFAULT_GLOSSARY_PROACTIVE_CREATE_LIMIT,
  normalizeAppSettings,
  isPreviewWheelZoomStep,
} from "../../src-shared/settings/provider-settings-state.js";

/** 実行時に受け取った設定の欠落・不正値・有効な明示値を、各項目固有の規則で扱うことを確認する。 */
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
  /** Model 無効化は未指定だけ空になり、未発見の ID を保ったまま正規化し、明示された null を拒む。 */
  it("model無効化設定をアプリ設定として検証し保持する", () => {
    assert.deepEqual(createDefaultAppSettings().modelAvailability, {});
    assert.deepEqual(normalizeAppSettings({}).modelAvailability, {});
    const modelAvailability = {
      future: {
        disabledServiceIds: ["unknown"],
        disabledModelIds: ["future/model"],
      },
    };
    assert.deepEqual(
      normalizeAppSettings({ modelAvailability }).modelAvailability,
      modelAvailability,
    );
    assert.throws(
      () => normalizeAppSettings({ modelAvailability: null }),
      /Model availability/,
    );
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
  /** ホイールズームは省略時だけ 5 を補い、整数の両端を保持しつつ数値文字列や範囲外を例外にする。 */
  it("preview wheel zoom stepは欠落時5で、1〜100の整数だけを受け入れる", () => {
    assert.equal(createDefaultAppSettings().previewWheelZoomStep, 5);
    assert.equal(normalizeAppSettings({}).previewWheelZoomStep, 5);
    assert.equal(
      normalizeAppSettings({ previewWheelZoomStep: undefined })
        .previewWheelZoomStep,
      5,
    );
    for (const value of [1, 5, 100]) {
      assert.equal(isPreviewWheelZoomStep(value), true);
      assert.equal(
        normalizeAppSettings({ previewWheelZoomStep: value })
          .previewWheelZoomStep,
        value,
      );
    }
    for (const value of [
      0,
      -1,
      101,
      1.5,
      NaN,
      Infinity,
      -Infinity,
      "5",
      "",
      null,
      true,
      {},
    ]) {
      assert.equal(isPreviewWheelZoomStep(value), false);
      assert.throws(
        () => normalizeAppSettings({ previewWheelZoomStep: value }),
        /Preview wheel zoom step must be an integer between 1 and 100/,
      );
    }
  });

  /** Glossary の提案上限は明示した 0 と 100 を保持し、小数・範囲外・文字列・欠落を既定数ではなく null にする。 */
  it("glossary proactive create limitは0から100の整数だけを保持し、欠落・不正値をfallbackしない", () => {
    assert.equal(
      normalizeAppSettings({ glossaryProactiveCreateLimit: 0 })
        .glossaryProactiveCreateLimit,
      0,
    );
    assert.equal(
      normalizeAppSettings({ glossaryProactiveCreateLimit: 100 })
        .glossaryProactiveCreateLimit,
      100,
    );
    assert.equal(
      normalizeAppSettings({ glossaryProactiveCreateLimit: 5.5 })
        .glossaryProactiveCreateLimit,
      null,
    );
    assert.equal(
      normalizeAppSettings({ glossaryProactiveCreateLimit: 101 })
        .glossaryProactiveCreateLimit,
      null,
    );
    assert.equal(
      normalizeAppSettings({ glossaryProactiveCreateLimit: "5" })
        .glossaryProactiveCreateLimit,
      null,
    );
    assert.equal(normalizeAppSettings({}).glossaryProactiveCreateLimit, null);
  });

  /** 送信時の Action Dock 自動折り畳みは未設定なら有効になり、利用者の明示した false は上書きしない。 */
  it("action dock auto close は normalize で boolean を保持し、未設定時は true に寄せる", () => {
    assert.equal(
      normalizeAppSettings({ autoCollapseActionDockOnSend: false })
        .autoCollapseActionDockOnSend,
      false,
    );
    assert.equal(normalizeAppSettings({}).autoCollapseActionDockOnSend, true);
  });

  /** 送信時に末尾へ移動する設定は既存利用者向けに既定有効とし、無効化を指定した入力は保持する。 */
  it("send scroll は normalize で boolean を保持し、未設定時は true に寄せる", () => {
    assert.equal(
      normalizeAppSettings({ scrollToLatestOnSend: false })
        .scrollToLatestOnSend,
      false,
    );
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
  /** チャット配置の三項目は個々の有効な列挙値を保持し、不正な指定は項目ごとの既定値へ戻す。 */
  it("chat layout preference は項目ごとに canonical enum へ normalize する", () => {
    assert.deepEqual(
      normalizeAppSettings({
        chatLayoutPreference: {
          header: "visible",
          actionDock: "expanded",
          sidePane: "context",
        },
      }).chatLayoutPreference,
      {
        header: "visible",
        actionDock: "expanded",
        sidePane: "context",
      },
    );
    assert.deepEqual(
      normalizeAppSettings({
        chatLayoutPreference: {
          header: "invalid",
          actionDock: false,
          sidePane: "left",
        },
      }).chatLayoutPreference,
      {
        header: "hidden",
        actionDock: "compact",
        sidePane: "none",
      },
    );
  });

  /** ログイン時起動は boolean の true で有効になるが、同じ綴りの文字列では起動を有効にしない。 */
  it("launch at login は default false で boolean を保持する", () => {
    assert.equal(createDefaultAppSettings().launchAtLoginEnabled, false);
    assert.equal(
      normalizeAppSettings({ launchAtLoginEnabled: true }).launchAtLoginEnabled,
      true,
    );
    assert.equal(
      normalizeAppSettings({ launchAtLoginEnabled: "true" })
        .launchAtLoginEnabled,
      false,
    );
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
  /** 承認通知では明示 false だけが無効化され、文字列の false や turn 通知の無効化は承認通知に波及しない。 */
  it("承認通知設定は独立した既定trueのbooleanを保持する", () => {
    assert.equal(
      createDefaultAppSettings().sessionApprovalNotificationEnabled,
      true,
    );
    assert.equal(
      normalizeAppSettings({ sessionApprovalNotificationEnabled: false })
        .sessionApprovalNotificationEnabled,
      false,
    );
    assert.equal(
      normalizeAppSettings({ sessionApprovalNotificationEnabled: "false" })
        .sessionApprovalNotificationEnabled,
      true,
    );
    assert.equal(
      normalizeAppSettings({ sessionTurnNotificationEnabled: false })
        .sessionApprovalNotificationEnabled,
      true,
    );
  });

  /** Turn 通知は既定で有効になり、文字列ではなく boolean で無効化した場合だけ false が残る。 */
  it("Session turn notification は default true で boolean を保持する", () => {
    assert.equal(
      createDefaultAppSettings().sessionTurnNotificationEnabled,
      true,
    );
    assert.equal(
      normalizeAppSettings({ sessionTurnNotificationEnabled: false })
        .sessionTurnNotificationEnabled,
      false,
    );
    assert.equal(
      normalizeAppSettings({ sessionTurnNotificationEnabled: "false" })
        .sessionTurnNotificationEnabled,
      true,
    );
  });

  /** Turn 通知の応答プレビューは明示 true を保持する一方、文字列の true で本文を表示する設定にはしない。 */
  it("Session turn notification response preview は default false で boolean を保持する", () => {
    assert.equal(
      createDefaultAppSettings().sessionTurnNotificationResponsePreviewEnabled,
      false,
    );
    assert.equal(
      normalizeAppSettings({
        sessionTurnNotificationResponsePreviewEnabled: true,
      }).sessionTurnNotificationResponsePreviewEnabled,
      true,
    );
    assert.equal(
      normalizeAppSettings({
        sessionTurnNotificationResponsePreviewEnabled: "true",
      }).sessionTurnNotificationResponsePreviewEnabled,
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
  // distinction = "既存の boolean settings の normalize と異なる prompt context 2項目を一括で確認する"
  // @end-test-value
  /** Character 定義と現在日付の注入を個別に無効化でき、欠落や非 boolean の入力は両項目とも既定有効に戻る。 */
  it("foreground prompt context は既定有効で、false と無効値を正しく normalize する", () => {
    const defaults = createDefaultAppSettings();

    assert.equal(defaults.characterDefinitionEnabled, true);
    assert.equal(defaults.currentDateEnabled, true);
    const normalizedOff = normalizeAppSettings({
      characterDefinitionEnabled: false,
      currentDateEnabled: false,
    });
    assert.equal(normalizedOff.characterDefinitionEnabled, false);
    assert.equal(normalizedOff.currentDateEnabled, false);
    const normalizedMixed = normalizeAppSettings({
      characterDefinitionEnabled: true,
      currentDateEnabled: false,
    });

    assert.equal(normalizedMixed.characterDefinitionEnabled, true);
    assert.equal(normalizedMixed.currentDateEnabled, false);
    const normalizedInvalid = normalizeAppSettings({
      characterDefinitionEnabled: "false",
      currentDateEnabled: null,
    });

    assert.equal(normalizedInvalid.characterDefinitionEnabled, true);
    assert.equal(normalizedInvalid.currentDateEnabled, true);

    const normalizedMissing = normalizeAppSettings({});
    assert.equal(normalizedMissing.characterDefinitionEnabled, true);
    assert.equal(normalizedMissing.currentDateEnabled, true);
  });
});
