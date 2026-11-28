import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildNewSession,
  normalizeSession,
} from "../../src-shared/session/session-state.js";
import {
  approvalModeLabel,
  DEFAULT_APPROVAL_MODE,
  mapApprovalModeToCodexPolicy,
  normalizeApprovalMode,
} from "../../src-shared/settings/approval-mode.js";
import {
  createDefaultAppSettings,
  getProviderAppSettings,
  normalizeAppSettings,
} from "../../src-shared/settings/provider-settings-state.js";

/** 承認方針の保存値、Codex 向けの変換、設定読込と画面表示の境界を確認する。 */
describe("approval mode helpers", () => {
  // @test-value v1
  // kind = "contract"
  // claim = "現行approval値とlegacy aliasは共有normalizerでprovider-neutral modeへ変換される"
  // oracle = { type = "contract", ref = "docs/design/provider-adapter.md#approval-modes" }
  // failure_mode = "保存値やlegacy aliasが未正規化のままprovider adapterへ渡る"
  // scope = "approval-mode"
  // lifecycle = "permanent"
  // @end-test-value
  /** 現行の承認方針はそのまま扱い、旧別名は対応するプロバイダー非依存の値へ置き換える。 */
  it("legacy/native approval 値を provider-neutral mode へ normalize できる", () => {
    assert.equal(normalizeApprovalMode("never"), "never");
    assert.equal(normalizeApprovalMode("untrusted"), "untrusted");
    assert.equal(normalizeApprovalMode("on-request"), "on-request");
    assert.equal(normalizeApprovalMode("allow-all"), "never");
    assert.equal(normalizeApprovalMode("safety"), "untrusted");
    assert.equal(normalizeApprovalMode("provider-controlled"), "on-request");
  });

  /** 現行の三つの共通方針が、Codex の承認ポリシーでも同じ値として扱われることを確認する。 */
  it("provider-neutral approval mode を Codex native policy へ変換できる", () => {
    assert.equal(mapApprovalModeToCodexPolicy("never"), "never");
    assert.equal(mapApprovalModeToCodexPolicy("untrusted"), "untrusted");
    assert.equal(mapApprovalModeToCodexPolicy("on-request"), "on-request");
  });

  // @test-value v1
  // kind = "contract"
  // claim = "session読込時にlegacy approval aliasだけを正規化し、artifactの実行記録は変更しない"
  // oracle = { type = "contract", ref = "docs/design/provider-adapter.md#approval-modes" }
  // failure_mode = "session metadataの正規化がartifactの過去記録まで書き換えるか、legacy aliasを残す"
  // scope = "session-normalization"
  // lifecycle = "permanent"
  // @end-test-value
  /** 保存 Session の旧承認値を読み替えても、過去の成果物に記録された承認・モデル情報は変更しない。 */
  it("session normalize で approval と artifact run checks を provider-neutral に戻す", () => {
    const normalized = normalizeSession({
      ...buildNewSession({
        taskTitle: "approval normalize",
        workspaceLabel: "workspace",
        workspacePath: "C:/workspace",
        branch: "main",
        characterId: "char-a",
        character: "A",
        characterIconPath: "",
        characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
        approvalMode: DEFAULT_APPROVAL_MODE,
      }),
      approvalMode: "provider-controlled",
      messages: [
        {
          role: "assistant",
          text: "done",
          artifact: {
            title: "artifact",
            activitySummary: [],
            changedFiles: [],
            runChecks: [
              { label: "approval", value: "never" },
              { label: "model", value: "gpt-5" },
            ],
          },
        },
      ],
    });

    assert.ok(normalized);
    assert.equal(normalized.approvalMode, "on-request");
    assert.deepEqual(normalized.messages[0]?.artifact?.runChecks, [
      { label: "approval", value: "never" },
      { label: "model", value: "gpt-5" },
    ]);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "default approval modeは保存enumを維持してprovider-neutralなTitle Caseの英語表示labelを返す"
  // oracle = { type = "contract", ref = "docs/design/ui-design-guidelines.md#表示言語と文言" }
  // fault = "保存用approval enumやprovider固有literalをそのまま表示し、利用者向けlabelを提供しない"
  // observable = "approvalModeLabel(DEFAULT_APPROVAL_MODE)"
  // observation_boundary = "public-boundary"
  // scope = "approval mode display label"
  // lifecycle = "permanent"
  // impact = "Settingsや確認UIでapprovalの意味がprovider固有値のまま表示される"
  // distinction = "保存enumがuntrustedのまま保持されることと、表示labelがSafety Focusedへ投影されることを分けて確認する"
  // @end-test-value
  /** 既定の保存値 untrusted に対して、利用者向けには Safety Focused と表示することを確認する。 */
  it("default approval label は provider-neutral な英語表示を返す", () => {
    assert.equal(DEFAULT_APPROVAL_MODE, "untrusted");
    assert.equal(approvalModeLabel(DEFAULT_APPROVAL_MODE), "Safety Focused");
  });

  /** プロバイダーの Skill ルートは既定では空だが、明示したパスは設定の正規化後にも保持する。 */
  it("provider settings は skill root path を保持できる", () => {
    const defaults = createDefaultAppSettings();
    assert.equal(getProviderAppSettings(defaults, "codex").skillRootPath, "");

    const normalized = normalizeAppSettings({
      ...defaults,
      codingProviderSettings: {
        codex: {
          enabled: true,
          apiKey: "test-key",
          skillRootPath: "C:/skills/codex",
        },
      },
    });

    assert.equal(
      getProviderAppSettings(normalized, "codex").skillRootPath,
      "C:/skills/codex",
    );
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "session side pane は canonical enum と既定値へ normalize される"
  // oracle = { type = "contract", ref = "Session side pane normalization" }
  // fault = "削除済み priority または不正 pane 値が設定へ残る"
  // observable = "normalized chatLayoutPreference"
  // observation_boundary = "public-boundary"
  // scope = "session-side-pane-settings"
  // lifecycle = "permanent"
  // impact = "session window の pane 初期状態が不正になる"
  // distinction = "side pane enum と layout preference 形状を確認する"
  // @end-test-value
  /** サイドペインは既定で none とし、正規の表示設定を維持しながら無効なヘッダー・ドック・ペイン設定を既定値へ戻す。 */
  it("session side pane は初期値を none とし、列挙値だけを受け入れる", () => {
    assert.deepEqual(createDefaultAppSettings().chatLayoutPreference, {
      header: "hidden",
      actionDock: "compact",
      sidePane: "none",
    });
    assert.deepEqual(
      normalizeAppSettings({
        chatLayoutPreference: {
          header: "visible",
          actionDock: "expanded",
          sidePane: "files",
        },
      }).chatLayoutPreference,
      {
        header: "visible",
        actionDock: "expanded",
        sidePane: "files",
      },
    );
    assert.deepEqual(
      normalizeAppSettings({
        chatLayoutPreference: {
          header: "shown",
          actionDock: "open",
          sidePane: true,
        },
      }).chatLayoutPreference,
      {
        header: "hidden",
        actionDock: "compact",
        sidePane: "none",
      },
    );
  });
});
