import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createDefaultAppSettings,
  resolveProviderSkillRootPath,
  type AppSettings,
} from "../../src-shared/settings/provider-settings-state.js";
import type {
  ModelCatalogProvider,
  ModelCatalogSnapshot,
} from "../../src-shared/settings/model-catalog.js";
import {
  updateAutoCollapseActionDockOnSend,
  updateScrollToLatestOnSend,
  updateCodingProviderEnabled,
  updateCodingProviderEnabledDraft,
  updateCodingProviderInstructionRelativePath,
  updateCodingProviderInstructionRelativePathDraft,
  updateCodingProviderSkillRelativePath,
  updateCodingProviderSkillRelativePathDraft,
  updateCodingProviderSkillRootPath,
  updateCodingProviderSkillRootPathDraft,
  updateGlossaryProactiveCreateLimitDraft,
  updateSessionTurnNotificationEnabled,
  updateSessionTurnNotificationResponsePreviewEnabled,
} from "../../src/settings/settings-draft.js";
import {
  handleChangeAutoCollapseActionDockOnSend as handleChangeAutoCollapseActionDockOnSendAction,
  handleChangeProviderEnabled as handleChangeProviderEnabledAction,
  handleChangeProviderInstructionRelativePath as handleChangeProviderInstructionRelativePathAction,
  handleChangeProviderSkillRelativePath as handleChangeProviderSkillRelativePathAction,
  handleChangeProviderSkillRootPath as handleChangeProviderSkillRootPathAction,
  handleChangeSessionTurnNotificationEnabled as handleChangeSessionTurnNotificationEnabledAction,
  handleChangeSessionTurnNotificationResponsePreviewEnabled as handleChangeSessionTurnNotificationResponsePreviewEnabledAction,
} from "../../src/settings/settings-draft-actions.js";
import { buildSettingsDraftHandlers } from "../../src/settings/settings-draft-handlers.js";

const providerCatalog: ModelCatalogProvider = {
  id: "codex",
  label: "Codex",
  defaultModelId: "gpt-5.4",
  defaultReasoningEffort: "high",
  models: [
    {
      id: "gpt-5.4",
      label: "GPT-5.4",
      reasoningEfforts: ["medium", "high"],
    },
    {
      id: "gpt-5.4-mini",
      label: "GPT-5.4 Mini",
      defaultReasoningEffort: "low",
      reasoningEfforts: ["low", "medium"],
    },
  ],
};
const copilotProviderCatalog: ModelCatalogProvider = {
  id: "copilot",
  label: "Copilot",
  defaultModelId: "copilot-1",
  defaultReasoningEffort: "low",
  models: [
    {
      id: "copilot-1",
      label: "copilot-1",
      reasoningEfforts: ["low", "medium"],
    },
  ],
};

/** Settings 上の編集値が対象フィールドに届き、同じ draft の別の設定を失わないことを検証する。 */
describe("home-settings-draft", () => {
  /** 画面側の state setter と同じ更新関数を受け取り、現在の AppSettings draft を保存する。 */
  const createDraftTracker = (
    initial: AppSettings = createDefaultAppSettings(),
  ) => {
    let draft = initial;
    return {
      /** 一連の操作を適用した後の最新 draft を返す。 */
      get draft() {
        return draft;
      },
      /** 保存済みの draft に updater を適用して、次の操作へ引き継ぐ。 */
      setSettingsDraft: (updater: (current: AppSettings) => AppSettings) => {
        draft = updater(draft);
      },
    };
  };

  const modelCatalogSnapshot: ModelCatalogSnapshot = {
    providers: [providerCatalog, copilotProviderCatalog],
  };

  // @test-value v2
  // kind = "contract"
  // claim = "provider draftの有効化とfile設定を変更しても既存keyを保持する"
  // oracle = { type = "contract", ref = "docs/design/settings-ui.md#current-scope" }
  // fault = "file設定更新時に他のprovider設定を初期化する"
  // observable = "更新後のenabled、apiKey、rootとrelative path"
  // observation_boundary = "component-behavior"
  // scope = "coding-provider-settings-draft"
  // lifecycle = "permanent"
  // @end-test-value
  /** Codex の有効状態とファイル設定を順に編集し、設定済みのキーと全編集値が共存することを確認する。 */
  it("coding provider draft を更新できる", () => {
    const draft = createDefaultAppSettings();
    draft.codingProviderSettings.codex.apiKey = "existing-key";

    const enabled = updateCodingProviderEnabled(draft, "codex", false);
    const skillRootPath = updateCodingProviderSkillRootPath(
      { ...draft, codingProviderSettings: enabled },
      "codex",
      "C:/skills",
    );
    const skillRelativePath = updateCodingProviderSkillRelativePath(
      { ...draft, codingProviderSettings: skillRootPath },
      "codex",
      "skills/codex",
    );
    const instructionRelativePath = updateCodingProviderInstructionRelativePath(
      { ...draft, codingProviderSettings: skillRelativePath },
      "codex",
      "AGENTS.md",
    );

    assert.equal(instructionRelativePath.codex.enabled, false);
    assert.equal(instructionRelativePath.codex.apiKey, "existing-key");
    assert.equal(instructionRelativePath.codex.skillRootPath, "C:/skills");
    assert.equal(
      instructionRelativePath.codex.skillRelativePath,
      "skills/codex",
    );
    assert.equal(
      instructionRelativePath.codex.instructionRelativePath,
      "AGENTS.md",
    );
  });

  /** ルートと相対パスの境界にある余分なスラッシュを除き、相対パスが空ならルート自体を返すことを確認する。 */
  it("provider skill root は Root Directory と Skill Relative Path から解決する", () => {
    assert.equal(
      resolveProviderSkillRootPath({
        enabled: true,
        apiKey: "",
        skillRootPath: "C:/workspace/",
        skillRelativePath: "/.codex/skills/",
      }),
      "C:/workspace/.codex/skills",
    );
    assert.equal(
      resolveProviderSkillRootPath({
        enabled: true,
        apiKey: "",
        skillRootPath: "C:/workspace",
        skillRelativePath: "",
      }),
      "C:/workspace",
    );
  });

  // @test-value v2
  // kind = "contract"
  // claim = "providerのdraft更新はapp設定の変更を累積して保持する"
  // oracle = { type = "contract", ref = "docs/design/settings-ui.md#settings-runtime" }
  // fault = "更新wrapperが以前のdraftへ戻して他の変更を失う"
  // observable = "更新後のappとprovider設定の値"
  // observation_boundary = "component-behavior"
  // scope = "settings-draft-wrappers"
  // lifecycle = "permanent"
  // @end-test-value
  /** provider 編集用 wrapper を連続適用しても、先に選んだ Action Dock 設定を含む AppSettings 全体を保つことを確認する。 */
  it("draft wrapper は AppSettings 全体を更新する", () => {
    const draft = createDefaultAppSettings();

    const next = updateCodingProviderInstructionRelativePathDraft(
      updateCodingProviderSkillRelativePathDraft(
        updateCodingProviderSkillRootPathDraft(
          updateCodingProviderEnabledDraft(
            updateAutoCollapseActionDockOnSend(draft, false),
            "codex",
            false,
          ),
          "codex",
          "C:/skills",
        ),
        "codex",
        "skills/codex",
      ),
      "codex",
      "AGENTS.md",
    );
    assert.equal(next.autoCollapseActionDockOnSend, false);
    assert.equal(next.codingProviderSettings.codex.enabled, false);
    assert.equal(next.codingProviderSettings.codex.skillRootPath, "C:/skills");
    assert.equal(
      next.codingProviderSettings.codex.skillRelativePath,
      "skills/codex",
    );
    assert.equal(
      next.codingProviderSettings.codex.instructionRelativePath,
      "AGENTS.md",
    );
  });

  /** 送信時の Action Dock 自動折りたたみを無効へ変更できることを確認する。 */
  it("action dock auto close を toggle できる", () => {
    const draft = createDefaultAppSettings();

    const next = updateAutoCollapseActionDockOnSend(draft, false);

    assert.equal(next.autoCollapseActionDockOnSend, false);
  });

  /** 送信時の末尾スクロールを draft 上で無効にできることを確認する。 */
  it("send scroll を toggle できる", () => {
    const draft = createDefaultAppSettings();

    const next = updateScrollToLatestOnSend(draft, false);

    assert.equal(next.scrollToLatestOnSend, false);
  });

  /** Turn 通知を無効化した値が AppSettings に反映されることを確認する。 */
  it("Session turn notification を toggle できる", () => {
    const draft = createDefaultAppSettings();

    const next = updateSessionTurnNotificationEnabled(draft, false);

    assert.equal(next.sessionTurnNotificationEnabled, false);
  });

  /** 応答プレビューの設定を有効へ更新し、通知本体の設定とは別の値として観測する。 */
  it("Session turn notification response preview を toggle できる", () => {
    const draft = createDefaultAppSettings();

    const next = updateSessionTurnNotificationResponsePreviewEnabled(
      draft,
      true,
    );

    assert.equal(next.sessionTurnNotificationResponsePreviewEnabled, true);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "Home Settings の foreground prompt context 2項目の handler は、他の1つのPrompt Context値を保持したまま対象draftだけを更新する"
  // oracle = { type = "contract", ref = "docs/design/settings-ui.md#current-scope" }
  // fault = "2つの checkbox handler が同じ state を更新するか、対象以外のPrompt Context値をdraftで巻き戻す"
  // observable = "buildSettingsDraftHandlers 経由で checkbox handler を適用した AppSettings"
  // observation_boundary = "component-behavior"
  // scope = "home-settings-prompt-context-draft"
  // lifecycle = "permanent"
  // impact = "Settings で個別に切り替えた値が保存 payload へ届かない"
  // distinction = "混在した初期draftに実配線のhandlerを通し、checkboxから保存draftへ値が届く境界を確認する"
  // @end-test-value
  /** Character 定義と現在日付の context チェックボックスを一つずつ操作し、他方の値を変えないことを確認する。 */
  it("foreground prompt context の handler を項目ごとに toggle できる", () => {
    const initialDraft = {
      ...createDefaultAppSettings(),
      characterDefinitionEnabled: true,
      currentDateEnabled: true,
    };
    const scenarios = [
      {
        field: "characterDefinitionEnabled",
        value: false,
        /** Character 定義を停止する画面向けハンドラーだけを実行する。 */
        apply: (handlers: ReturnType<typeof buildSettingsDraftHandlers>) =>
          handlers.onChangeCharacterDefinitionEnabled(false),
      },
      {
        field: "currentDateEnabled",
        value: false,
        /** 現在日付の付与を停止する画面向けハンドラーだけを実行する。 */
        apply: (handlers: ReturnType<typeof buildSettingsDraftHandlers>) =>
          handlers.onChangeCurrentDateEnabled(false),
      },
    ] as const;

    for (const scenario of scenarios) {
      const state = createDraftTracker(initialDraft);
      const handlers = buildSettingsDraftHandlers({
        setSettingsDraft: state.setSettingsDraft,
      });
      scenario.apply(handlers);

      assert.equal(state.draft[scenario.field], scenario.value);
      for (const field of [
        "characterDefinitionEnabled",
        "currentDateEnabled",
      ] as const) {
        if (field !== scenario.field) {
          assert.equal(state.draft[field], initialDraft[field]);
        }
      }
    }
  });

  // @test-value v2
  // kind = "contract"
  // claim = "Settingsのaction dock、turn通知、response preview、承認通知の4handlerを順に操作しても先行変更と対象外draftを保持する"
  // oracle = { type = "contract", ref = "docs/design/settings-ui.md#runtime-policy" }
  // fault = "画面handlerが別設定のupdaterを呼ぶか、後続操作で先行変更や対象外fieldを巻き戻す"
  // observable = "buildSettingsDraftHandlers経由の4操作後のAppSettings draft全体"
  // observation_boundary = "component-behavior"
  // scope = "settings-current-draft-handler-composition"
  // lifecycle = "permanent"
  // distinction = "個別pure functionの値変換でなく、画面向け4handlerの結線と同一draftへの累積更新を確認する"
  // @end-test-value
  /** Action Dock・Turn 通知・応答プレビュー・承認通知の編集を順に適用し、先行変更と対象外設定を全体比較で確認する。 */
  it("現行の表示設定をhandler経由で続けて編集して他のdraftを保持する", () => {
    const initialDraft = createDefaultAppSettings();
    const state = createDraftTracker(initialDraft);
    const handlers = buildSettingsDraftHandlers({
      setSettingsDraft: state.setSettingsDraft,
    });

    handlers.onChangeAutoCollapseActionDockOnSend(false);
    handlers.onChangeSessionTurnNotificationEnabled(false);
    handlers.onChangeSessionTurnNotificationResponsePreviewEnabled(true);
    handlers.onChangeSessionApprovalNotificationEnabled(false);

    assert.deepEqual(state.draft, {
      ...initialDraft,
      autoCollapseActionDockOnSend: false,
      sessionTurnNotificationEnabled: false,
      sessionTurnNotificationResponsePreviewEnabled: true,
      sessionApprovalNotificationEnabled: false,
    });
  });

  // @test-value v2
  // kind = "contract"
  // claim = "OpenCodeのenableとfile設定編集handlerは同じdraftへ累積し他providerの設定を保持する"
  // oracle = { type = "contract", ref = "docs/design/settings-ui.md#current-scope" }
  // fault = "file設定を別providerへ保存するかenableや既存設定を巻き戻す"
  // observable = "Settings画面向けhandler適用後のcodingProviderSettings"
  // observation_boundary = "component-behavior"
  // scope = "settings-opencode-provider-draft"
  // lifecycle = "permanent"
  // impact = "OpenCodeの有効化やfile設定を保存できない"
  // distinction = "pure updaterでは画面handlerから適切なproviderと最新draftへ接続されることを確認できない"
  // @end-test-value
  /** OpenCode を有効にした後のルート変更が同じ draft に累積し、Codex 設定に波及しないことを確認する。 */
  it("OpenCodeを有効化しfile設定を他provider設定と独立して編集できる", () => {
    const initialDraft = createDefaultAppSettings();
    const state = createDraftTracker(initialDraft);
    const handlers = buildSettingsDraftHandlers({
      setSettingsDraft: state.setSettingsDraft,
    });
    handlers.onChangeProviderEnabled("opencode", true);
    handlers.onChangeProviderSkillRootPath("opencode", "C:/opencode-config");
    assert.equal(state.draft.codingProviderSettings.opencode?.enabled, true);
    assert.equal(
      state.draft.codingProviderSettings.opencode?.skillRootPath,
      "C:/opencode-config",
    );
    assert.deepEqual(
      state.draft.codingProviderSettings.codex,
      initialDraft.codingProviderSettings.codex,
    );
  });

  /** Glossary の自発作成上限にゼロを指定でき、上限超過は100へ丸め、空欄は null のまま保存することを確認する。 */
  it("glossary proactive create limitは0から100へ収め、空入力を無効値として保持する", () => {
    const draft = createDefaultAppSettings();

    assert.equal(
      updateGlossaryProactiveCreateLimitDraft(draft, "0")
        .glossaryProactiveCreateLimit,
      0,
    );
    assert.equal(
      updateGlossaryProactiveCreateLimitDraft(draft, "101")
        .glossaryProactiveCreateLimit,
      100,
    );
    assert.equal(
      updateGlossaryProactiveCreateLimitDraft(draft, "")
        .glossaryProactiveCreateLimit,
      null,
    );
  });

  /** 画面 action から Codex の有効フラグを無効へ更新できることを確認する。 */
  it("action: provider enabled を draft 更新で反映できる", () => {
    const state = createDraftTracker();

    handleChangeProviderEnabledAction({
      providerId: "codex",
      enabled: false,
      setSettingsDraft: state.setSettingsDraft,
    });

    assert.equal(state.draft.codingProviderSettings.codex.enabled, false);
  });

  /** provider のルートディレクトリ入力が Codex のルート設定へ届くことを確認する。 */
  it("action: provider skillRootPath を draft 更新で反映できる", () => {
    const state = createDraftTracker();

    handleChangeProviderSkillRootPathAction({
      providerId: "codex",
      skillRootPath: "C:/skills",
      setSettingsDraft: state.setSettingsDraft,
    });

    assert.equal(
      state.draft.codingProviderSettings.codex.skillRootPath,
      "C:/skills",
    );
  });

  /** Skill の相対パス入力を Codex 設定の専用項目へ保存できることを確認する。 */
  it("action: provider skillRelativePath を draft 更新で反映できる", () => {
    const state = createDraftTracker();

    handleChangeProviderSkillRelativePathAction({
      providerId: "codex",
      skillRelativePath: "skills/codex",
      setSettingsDraft: state.setSettingsDraft,
    });

    assert.equal(
      state.draft.codingProviderSettings.codex.skillRelativePath,
      "skills/codex",
    );
  });

  /** 指示ファイルの相対パス入力を Codex の指示ファイル設定へ反映できることを確認する。 */
  it("action: provider instructionRelativePath を draft 更新で反映できる", () => {
    const state = createDraftTracker();

    handleChangeProviderInstructionRelativePathAction({
      providerId: "codex",
      instructionRelativePath: "AGENTS.md",
      setSettingsDraft: state.setSettingsDraft,
    });

    assert.equal(
      state.draft.codingProviderSettings.codex.instructionRelativePath,
      "AGENTS.md",
    );
  });
});
