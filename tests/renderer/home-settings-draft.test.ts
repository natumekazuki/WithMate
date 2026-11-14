import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createDefaultAppSettings,
  resolveProviderSkillRootPath,
  type AppSettings,
} from "../../src-shared/settings/provider-settings-state.js";
import type { ModelCatalogProvider, ModelCatalogSnapshot } from "../../src-shared/settings/model-catalog.js";
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

describe("home-settings-draft", () => {
  const createDraftTracker = (initial: AppSettings = createDefaultAppSettings()) => {
    let draft = initial;
    return {
      get draft() {
        return draft;
      },
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
    assert.equal(instructionRelativePath.codex.skillRelativePath, "skills/codex");
    assert.equal(instructionRelativePath.codex.instructionRelativePath, "AGENTS.md");
  });

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
  it("draft wrapper は AppSettings 全体を更新する", () => {
    const draft = createDefaultAppSettings();

    const next = updateCodingProviderInstructionRelativePathDraft(
              updateCodingProviderSkillRelativePathDraft(
                updateCodingProviderSkillRootPathDraft(
                  updateCodingProviderEnabledDraft(
                    updateAutoCollapseActionDockOnSend(
                      draft,
                      false,
                    ),
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
    assert.equal(next.codingProviderSettings.codex.skillRelativePath, "skills/codex");
    assert.equal(next.codingProviderSettings.codex.instructionRelativePath, "AGENTS.md");
  });

  it("action dock auto close を toggle できる", () => {
    const draft = createDefaultAppSettings();

    const next = updateAutoCollapseActionDockOnSend(draft, false);

    assert.equal(next.autoCollapseActionDockOnSend, false);
  });

  it("send scroll を toggle できる", () => {
    const draft = createDefaultAppSettings();

    const next = updateScrollToLatestOnSend(draft, false);

    assert.equal(next.scrollToLatestOnSend, false);
  });

  it("Session turn notification を toggle できる", () => {
    const draft = createDefaultAppSettings();

    const next = updateSessionTurnNotificationEnabled(draft, false);

    assert.equal(next.sessionTurnNotificationEnabled, false);
  });

  it("Session turn notification response preview を toggle できる", () => {
    const draft = createDefaultAppSettings();

    const next = updateSessionTurnNotificationResponsePreviewEnabled(draft, true);

    assert.equal(next.sessionTurnNotificationResponsePreviewEnabled, true);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "Home Settings の foreground prompt context 3項目の handler は、他の2つのPrompt Context値を保持したまま対象draftだけを更新する"
  // oracle = { type = "contract", ref = "docs/design/settings-ui.md#current-scope" }
  // fault = "3つの checkbox handler が同じ state を更新するか、対象以外のPrompt Context値をdraftで巻き戻す"
  // observable = "buildSettingsDraftHandlers 経由で checkbox handler を適用した AppSettings"
  // observation_boundary = "component-behavior"
  // scope = "home-settings-prompt-context-draft"
  // lifecycle = "permanent"
  // impact = "Settings で個別に切り替えた値が保存 payload へ届かない"
  // distinction = "混在した初期draftに実配線のhandlerを通し、checkboxから保存draftへ値が届く境界を確認する"
  // @end-test-value
  it("foreground prompt context の handler を項目ごとに toggle できる", () => {
    const initialDraft = {
      ...createDefaultAppSettings(),
      characterDefinitionEnabled: true,
      conversationTimingEnabled: true,
      toolCallPresenceEnabled: false,
    };
    const scenarios = [
      {
        field: "characterDefinitionEnabled",
        value: false,
        apply: (handlers: ReturnType<typeof buildSettingsDraftHandlers>) =>
          handlers.onChangeCharacterDefinitionEnabled(false),
      },
      {
        field: "conversationTimingEnabled",
        value: false,
        apply: (handlers: ReturnType<typeof buildSettingsDraftHandlers>) =>
          handlers.onChangeConversationTimingEnabled(false),
      },
      {
        field: "toolCallPresenceEnabled",
        value: true,
        apply: (handlers: ReturnType<typeof buildSettingsDraftHandlers>) =>
          handlers.onChangeToolCallPresenceEnabled(true),
      },
    ] as const;

    for (const scenario of scenarios) {
      const state = createDraftTracker(initialDraft);
      const handlers = buildSettingsDraftHandlers({ setSettingsDraft: state.setSettingsDraft });
      scenario.apply(handlers);

      assert.equal(state.draft[scenario.field], scenario.value);
      for (const field of ["characterDefinitionEnabled", "conversationTimingEnabled", "toolCallPresenceEnabled"] as const) {
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
  it("現行の表示設定をhandler経由で続けて編集して他のdraftを保持する", () => {
    const initialDraft = createDefaultAppSettings();
    const state = createDraftTracker(initialDraft);
    const handlers = buildSettingsDraftHandlers({ setSettingsDraft: state.setSettingsDraft });

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
  it("OpenCodeを有効化しfile設定を他provider設定と独立して編集できる", () => {
    const initialDraft = createDefaultAppSettings();
    const state = createDraftTracker(initialDraft);
    const handlers = buildSettingsDraftHandlers({ setSettingsDraft: state.setSettingsDraft });
    handlers.onChangeProviderEnabled("opencode", true);
    handlers.onChangeProviderSkillRootPath("opencode", "C:/opencode-config");
    assert.equal(state.draft.codingProviderSettings.opencode?.enabled, true);
    assert.equal(state.draft.codingProviderSettings.opencode?.skillRootPath, "C:/opencode-config");
    assert.deepEqual(state.draft.codingProviderSettings.codex, initialDraft.codingProviderSettings.codex);
  });

  it("glossary proactive create limitは0から100へ収め、空入力を無効値として保持する", () => {
    const draft = createDefaultAppSettings();

    assert.equal(updateGlossaryProactiveCreateLimitDraft(draft, "0").glossaryProactiveCreateLimit, 0);
    assert.equal(updateGlossaryProactiveCreateLimitDraft(draft, "101").glossaryProactiveCreateLimit, 100);
    assert.equal(updateGlossaryProactiveCreateLimitDraft(draft, "").glossaryProactiveCreateLimit, null);
  });

  it("action: provider enabled を draft 更新で反映できる", () => {
    const state = createDraftTracker();

    handleChangeProviderEnabledAction({
      providerId: "codex",
      enabled: false,
      setSettingsDraft: state.setSettingsDraft,
    });

    assert.equal(state.draft.codingProviderSettings.codex.enabled, false);
  });

  it("action: provider skillRootPath を draft 更新で反映できる", () => {
    const state = createDraftTracker();

    handleChangeProviderSkillRootPathAction({
      providerId: "codex",
      skillRootPath: "C:/skills",
      setSettingsDraft: state.setSettingsDraft,
    });

    assert.equal(state.draft.codingProviderSettings.codex.skillRootPath, "C:/skills");
  });

  it("action: provider skillRelativePath を draft 更新で反映できる", () => {
    const state = createDraftTracker();

    handleChangeProviderSkillRelativePathAction({
      providerId: "codex",
      skillRelativePath: "skills/codex",
      setSettingsDraft: state.setSettingsDraft,
    });

    assert.equal(state.draft.codingProviderSettings.codex.skillRelativePath, "skills/codex");
  });

  it("action: provider instructionRelativePath を draft 更新で反映できる", () => {
    const state = createDraftTracker();

    handleChangeProviderInstructionRelativePathAction({
      providerId: "codex",
      instructionRelativePath: "AGENTS.md",
      setSettingsDraft: state.setSettingsDraft,
    });

    assert.equal(state.draft.codingProviderSettings.codex.instructionRelativePath, "AGENTS.md");
  });
});
