import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createDefaultAppSettings, type AppSettings } from "../../src/provider-settings-state.js";
import type { ModelCatalogProvider, ModelCatalogSnapshot } from "../../src/model-catalog.js";
import {
  updateAutoCollapseActionDockOnSend,
  updateCharacterReflectionCharDeltaThreshold,
  updateCharacterReflectionCooldownSeconds,
  updateCharacterReflectionModel,
  updateCharacterReflectionModelDraft,
  updateCharacterReflectionMessageDeltaThreshold,
  updateCharacterReflectionReasoningEffort,
  updateCharacterReflectionReasoningEffortDraft,
  updateCharacterReflectionTimeoutSeconds,
  updateCharacterReflectionTimeoutSecondsDraft,
  updateCodingProviderApiKey,
  updateCodingProviderApiKeyDraft,
  updateCodingProviderEnabled,
  updateCodingProviderEnabledDraft,
  updateCodingProviderSkillRootPath,
  updateCodingProviderSkillRootPathDraft,
  updateMemoryExtractionModel,
  updateMemoryExtractionModelDraft,
  updateMemoryExtractionReasoningEffort,
  updateMemoryExtractionReasoningEffortDraft,
  updateMemoryExtractionThreshold,
  updateMemoryExtractionThresholdDraft,
  updateMemoryExtractionTimeoutSeconds,
  updateMemoryExtractionTimeoutSecondsDraft,
  updateMemoryGenerationEnabled,
  updateMateMemoryGenerationTriggerIntervalMinutesDraft,
  updateMateMemoryGenerationPriorityProviderDraft,
  updateMateMemoryGenerationPriorityModelDraft,
  updateMateMemoryGenerationPriorityReasoningEffortDraft,
  updateMateMemoryGenerationPriorityTimeoutSecondsDraft,
  addMateMemoryGenerationPriorityDraft,
  removeMateMemoryGenerationPriorityDraft,
} from "../../src/settings/settings-draft.js";
import {
  handleChangeAutoCollapseActionDockOnSend as handleChangeAutoCollapseActionDockOnSendAction,
  handleChangeCharacterReflectionCharDeltaThreshold as handleChangeCharacterReflectionCharDeltaThresholdAction,
  handleChangeCharacterReflectionCooldownSeconds as handleChangeCharacterReflectionCooldownSecondsAction,
  handleChangeCharacterReflectionMessageDeltaThreshold as handleChangeCharacterReflectionMessageDeltaThresholdAction,
  handleChangeCharacterReflectionModel as handleChangeCharacterReflectionModelAction,
  handleChangeCharacterReflectionReasoningEffort as handleChangeCharacterReflectionReasoningEffortAction,
  handleChangeCharacterReflectionTimeoutSeconds as handleChangeCharacterReflectionTimeoutSecondsAction,
  handleChangeMateMemoryGenerationPriorityModel as handleChangeMateMemoryGenerationPriorityModelAction,
  handleChangeMateMemoryGenerationPriorityProvider as handleChangeMateMemoryGenerationPriorityProviderAction,
  handleChangeMateMemoryGenerationPriorityReasoningEffort as handleChangeMateMemoryGenerationPriorityReasoningEffortAction,
  handleChangeMateMemoryGenerationPriorityTimeoutSeconds as handleChangeMateMemoryGenerationPriorityTimeoutSecondsAction,
  handleChangeMateMemoryGenerationTriggerIntervalMinutes as handleChangeMateMemoryGenerationTriggerIntervalMinutesAction,
  handleChangeMemoryGenerationEnabled as handleChangeMemoryGenerationEnabledAction,
  handleChangeMemoryExtractionModel as handleChangeMemoryExtractionModelAction,
  handleChangeMemoryExtractionReasoningEffort as handleChangeMemoryExtractionReasoningEffortAction,
  handleChangeMemoryExtractionThreshold as handleChangeMemoryExtractionThresholdAction,
  handleChangeMemoryExtractionTimeoutSeconds as handleChangeMemoryExtractionTimeoutSecondsAction,
  handleChangeProviderEnabled as handleChangeProviderEnabledAction,
  handleChangeProviderSkillRootPath as handleChangeProviderSkillRootPathAction,
  handleAddMateMemoryGenerationPriority as handleAddMateMemoryGenerationPriorityAction,
  handleRemoveMateMemoryGenerationPriority as handleRemoveMateMemoryGenerationPriorityAction,
} from "../../src/settings/settings-draft-actions.js";

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
    revision: 1,
    providers: [providerCatalog, copilotProviderCatalog],
  };

  it("coding provider draft を更新できる", () => {
    const draft = createDefaultAppSettings();

    const enabled = updateCodingProviderEnabled(draft, "codex", false);
    const apiKey = updateCodingProviderApiKey(
      { ...draft, codingProviderSettings: enabled },
      "codex",
      "next-key",
    );
    const skillRootPath = updateCodingProviderSkillRootPath(
      { ...draft, codingProviderSettings: apiKey },
      "codex",
      "C:/skills",
    );

    assert.equal(skillRootPath.codex.enabled, false);
    assert.equal(skillRootPath.codex.apiKey, "next-key");
    assert.equal(skillRootPath.codex.skillRootPath, "C:/skills");
  });

  it("memory extraction model 更新時に resolved selection を返す", () => {
    const draft = createDefaultAppSettings();
    draft.memoryExtractionProviderSettings.codex = {
      model: "gpt-5.4",
      reasoningEffort: "high",
      outputTokensThreshold: 300000,
      timeoutSeconds: 180,
    };

    const next = updateMemoryExtractionModel(draft, providerCatalog, "codex", "gpt-5.4-mini");

    assert.equal(next.codex.model, "gpt-5.4-mini");
    assert.equal(next.codex.reasoningEffort, "low");
  });

  it("memory extraction threshold は 1 未満を 1 に丸める", () => {
    const draft = createDefaultAppSettings();

    const nextReasoning = updateMemoryExtractionReasoningEffort(draft, "codex", "medium");
    const nextThreshold = updateMemoryExtractionThreshold(
      { ...draft, memoryExtractionProviderSettings: nextReasoning },
      "codex",
      "0",
    );

    assert.equal(nextThreshold.codex.reasoningEffort, "medium");
    assert.equal(nextThreshold.codex.outputTokensThreshold, 1);
  });

  it("memory extraction timeout は 1 未満を 30 に丸める", () => {
    const draft = createDefaultAppSettings();

    const nextTimeout = updateMemoryExtractionTimeoutSeconds(draft, "codex", "0");

    assert.equal(nextTimeout.codex.timeoutSeconds, 30);
  });

  it("memory extraction threshold の draft は大きい値もそのまま保持する", () => {
    const draft = createDefaultAppSettings();

    const nextThreshold = updateMemoryExtractionThreshold(draft, "codex", "300000");

    assert.equal(nextThreshold.codex.outputTokensThreshold, 300000);
  });

  it("character reflection model / reasoning を更新できる", () => {
    const draft = createDefaultAppSettings();
    draft.characterReflectionProviderSettings.codex = {
      model: "gpt-5.4",
      reasoningEffort: "high",
      timeoutSeconds: 180,
    };

    const nextModel = updateCharacterReflectionModel(draft, providerCatalog, "codex", "gpt-5.4-mini");
    const nextReasoning = updateCharacterReflectionReasoningEffort(
      { ...draft, characterReflectionProviderSettings: nextModel },
      "codex",
      "medium",
    );

    assert.equal(nextModel.codex.model, "gpt-5.4-mini");
    assert.equal(nextModel.codex.reasoningEffort, "low");
    assert.equal(nextReasoning.codex.reasoningEffort, "medium");
  });

  it("character reflection timeout を更新できる", () => {
    const draft = createDefaultAppSettings();

    const nextTimeout = updateCharacterReflectionTimeoutSeconds(draft, "codex", "240");

    assert.equal(nextTimeout.codex.timeoutSeconds, 240);
  });

  it("character reflection trigger settings を更新できる", () => {
    const draft = createDefaultAppSettings();

    const nextCooldown = updateCharacterReflectionCooldownSeconds(draft, "180");
    const nextCharDelta = updateCharacterReflectionCharDeltaThreshold(nextCooldown, "600");
    const nextMessageDelta = updateCharacterReflectionMessageDeltaThreshold(nextCharDelta, "3");

    assert.deepEqual(nextMessageDelta.characterReflectionTriggerSettings, {
      cooldownSeconds: 180,
      charDeltaThreshold: 600,
      messageDeltaThreshold: 3,
    });
  });

  it("draft wrapper は AppSettings 全体を更新する", () => {
    const draft = createDefaultAppSettings();

    const next = updateCharacterReflectionReasoningEffortDraft(
      updateCharacterReflectionModelDraft(
        updateMemoryExtractionThresholdDraft(
          updateMemoryExtractionTimeoutSecondsDraft(
          updateMemoryExtractionReasoningEffortDraft(
            updateMemoryExtractionModelDraft(
              updateCodingProviderSkillRootPathDraft(
                updateCodingProviderApiKeyDraft(
                  updateCodingProviderEnabledDraft(
                    updateAutoCollapseActionDockOnSend(
                      updateMemoryGenerationEnabled(draft, false),
                      false,
                    ),
                    "codex",
                    false,
                  ),
                  "codex",
                  "key",
                ),
                "codex",
                "C:/skills",
              ),
              providerCatalog,
              "codex",
              "gpt-5.4-mini",
            ),
            "codex",
            "medium",
          ),
          "codex",
          "240",
        ),
          "codex",
          "321",
        ),
        providerCatalog,
        "codex",
        "gpt-5.4-mini",
      ),
      "codex",
      "medium",
    );
    const nextWithTriggers = updateCharacterReflectionMessageDeltaThreshold(
      updateCharacterReflectionCharDeltaThreshold(
        updateCharacterReflectionCooldownSeconds(
          updateCharacterReflectionTimeoutSecondsDraft(next, "codex", "210"),
          "180",
        ),
        "600",
      ),
      "3",
    );

    assert.equal(nextWithTriggers.memoryGenerationEnabled, false);
    assert.equal(nextWithTriggers.autoCollapseActionDockOnSend, false);
    assert.equal(nextWithTriggers.codingProviderSettings.codex.enabled, false);
    assert.equal(nextWithTriggers.codingProviderSettings.codex.apiKey, "key");
    assert.equal(nextWithTriggers.codingProviderSettings.codex.skillRootPath, "C:/skills");
    assert.equal(nextWithTriggers.memoryExtractionProviderSettings.codex.outputTokensThreshold, 321);
    assert.equal(nextWithTriggers.memoryExtractionProviderSettings.codex.timeoutSeconds, 240);
    assert.equal(nextWithTriggers.characterReflectionProviderSettings.codex.reasoningEffort, "medium");
    assert.equal(nextWithTriggers.characterReflectionProviderSettings.codex.timeoutSeconds, 210);
    assert.equal(nextWithTriggers.characterReflectionTriggerSettings.cooldownSeconds, 180);
    assert.equal(nextWithTriggers.characterReflectionTriggerSettings.charDeltaThreshold, 600);
    assert.equal(nextWithTriggers.characterReflectionTriggerSettings.messageDeltaThreshold, 3);
  });

  it("action dock auto close を toggle できる", () => {
    const draft = createDefaultAppSettings();

    const next = updateAutoCollapseActionDockOnSend(draft, false);

    assert.equal(next.autoCollapseActionDockOnSend, false);
  });

  it("mate memory generation の priority 1 を provider / model / reasoning / timeout / interval で更新できる", () => {
    const draft = createDefaultAppSettings();

    const withProvider = updateMateMemoryGenerationPriorityProviderDraft(draft, 0, "codex");
    const withModel = updateMateMemoryGenerationPriorityModelDraft(withProvider, providerCatalog, 0, "codex", "gpt-5.4-mini");
    const withReasoning = updateMateMemoryGenerationPriorityReasoningEffortDraft(withModel, 0, "low");
    const withTimeout = updateMateMemoryGenerationPriorityTimeoutSecondsDraft(withReasoning, 0, "42");
    const withInterval = updateMateMemoryGenerationTriggerIntervalMinutesDraft(withTimeout, "90");

    assert.equal(withInterval.mateMemoryGenerationSettings.priorityList[0].provider, "codex");
    assert.equal(withInterval.mateMemoryGenerationSettings.priorityList[0].model, "gpt-5.4-mini");
    assert.equal(withInterval.mateMemoryGenerationSettings.priorityList[0].reasoningEffort, "low");
    assert.equal(withInterval.mateMemoryGenerationSettings.priorityList[0].timeoutSeconds, 42);
    assert.equal(withInterval.mateMemoryGenerationSettings.triggerIntervalMinutes, 90);
  });

  it("mate memory generation の priority list を追加 / 個別更新 / 削除できる", () => {
    const draft = createDefaultAppSettings();
    const withAdded = addMateMemoryGenerationPriorityDraft(draft, {
      provider: "copilot",
      model: "copilot-1",
      reasoningEffort: "medium",
      timeoutSeconds: 60,
    });
    const withUpdated = updateMateMemoryGenerationPriorityTimeoutSecondsDraft(withAdded, 1, "75");
    const withRemoved = removeMateMemoryGenerationPriorityDraft(withUpdated, 0);

    assert.equal(withAdded.mateMemoryGenerationSettings.priorityList.length, 2);
    assert.equal(withUpdated.mateMemoryGenerationSettings.priorityList[1]?.provider, "copilot");
    assert.equal(withUpdated.mateMemoryGenerationSettings.priorityList[1]?.timeoutSeconds, 75);
    assert.equal(withRemoved.mateMemoryGenerationSettings.priorityList.length, 1);
    assert.equal(withRemoved.mateMemoryGenerationSettings.priorityList[0]?.provider, "copilot");
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

  it("action: memory generation と auto collapse を draft 更新で反映できる", () => {
    const state = createDraftTracker();

    handleChangeMemoryGenerationEnabledAction({
      enabled: false,
      setSettingsDraft: state.setSettingsDraft,
    });
    handleChangeAutoCollapseActionDockOnSendAction({
      enabled: false,
      setSettingsDraft: state.setSettingsDraft,
    });

    assert.equal(state.draft.memoryGenerationEnabled, false);
    assert.equal(state.draft.autoCollapseActionDockOnSend, false);
  });

  it("action: catalog 不在時は memory extraction model 更新を反映しない", () => {
    const state = createDraftTracker();
    const before = structuredClone(state.draft);

    handleChangeMemoryExtractionModelAction({
      providerId: "codex",
      model: "gpt-5.4-mini",
      modelCatalog: null,
      setSettingsDraft: state.setSettingsDraft,
    });

    assert.deepEqual(state.draft, before);
  });

  it("action: memory extraction model / reasoning / threshold / timeout を更新できる", () => {
    const state = createDraftTracker();

    handleChangeMemoryExtractionModelAction({
      providerId: "codex",
      model: "gpt-5.4-mini",
      modelCatalog: modelCatalogSnapshot,
      setSettingsDraft: state.setSettingsDraft,
    });
    handleChangeMemoryExtractionReasoningEffortAction({
      providerId: "codex",
      reasoningEffort: "medium",
      setSettingsDraft: state.setSettingsDraft,
    });
    handleChangeMemoryExtractionThresholdAction({
      providerId: "codex",
      value: "42",
      setSettingsDraft: state.setSettingsDraft,
    });
    handleChangeMemoryExtractionTimeoutSecondsAction({
      providerId: "codex",
      value: "90",
      setSettingsDraft: state.setSettingsDraft,
    });

    assert.equal(state.draft.memoryExtractionProviderSettings.codex.model, "gpt-5.4-mini");
    assert.equal(state.draft.memoryExtractionProviderSettings.codex.reasoningEffort, "medium");
    assert.equal(state.draft.memoryExtractionProviderSettings.codex.outputTokensThreshold, 42);
    assert.equal(state.draft.memoryExtractionProviderSettings.codex.timeoutSeconds, 90);
  });

  it("action: character reflection model と trigger を更新できる", () => {
    const state = createDraftTracker();

    handleChangeCharacterReflectionModelAction({
      providerId: "codex",
      model: "gpt-5.4-mini",
      modelCatalog: modelCatalogSnapshot,
      setSettingsDraft: state.setSettingsDraft,
    });
    handleChangeCharacterReflectionReasoningEffortAction({
      providerId: "codex",
      reasoningEffort: "low",
      setSettingsDraft: state.setSettingsDraft,
    });
    handleChangeCharacterReflectionTimeoutSecondsAction({
      providerId: "codex",
      value: "210",
      setSettingsDraft: state.setSettingsDraft,
    });
    handleChangeCharacterReflectionCooldownSecondsAction({
      value: "120",
      setSettingsDraft: state.setSettingsDraft,
    });
    handleChangeCharacterReflectionCharDeltaThresholdAction({
      value: "99",
      setSettingsDraft: state.setSettingsDraft,
    });
    handleChangeCharacterReflectionMessageDeltaThresholdAction({
      value: "4",
      setSettingsDraft: state.setSettingsDraft,
    });

    assert.equal(state.draft.characterReflectionProviderSettings.codex.model, "gpt-5.4-mini");
    assert.equal(state.draft.characterReflectionProviderSettings.codex.reasoningEffort, "low");
    assert.equal(state.draft.characterReflectionProviderSettings.codex.timeoutSeconds, 210);
    assert.equal(state.draft.characterReflectionTriggerSettings.cooldownSeconds, 120);
    assert.equal(state.draft.characterReflectionTriggerSettings.charDeltaThreshold, 99);
    assert.equal(state.draft.characterReflectionTriggerSettings.messageDeltaThreshold, 4);
  });

  it("action: mate memory generation priority の add/update/remove/interval を更新できる", () => {
    const state = createDraftTracker();

    handleAddMateMemoryGenerationPriorityAction({
      modelCatalog: modelCatalogSnapshot,
      setSettingsDraft: state.setSettingsDraft,
    });
    handleChangeMateMemoryGenerationPriorityProviderAction({
      index: 1,
      providerId: "copilot",
      setSettingsDraft: state.setSettingsDraft,
    });
    handleChangeMateMemoryGenerationPriorityModelAction({
      index: 1,
      providerId: "copilot",
      model: "copilot-1",
      modelCatalog: modelCatalogSnapshot,
      setSettingsDraft: state.setSettingsDraft,
    });
    handleChangeMateMemoryGenerationPriorityReasoningEffortAction({
      index: 1,
      reasoningEffort: "low",
      setSettingsDraft: state.setSettingsDraft,
    });
    handleChangeMateMemoryGenerationPriorityTimeoutSecondsAction({
      index: 1,
      value: "75",
      setSettingsDraft: state.setSettingsDraft,
    });
    handleChangeMateMemoryGenerationTriggerIntervalMinutesAction({
      value: "90",
      setSettingsDraft: state.setSettingsDraft,
    });
    handleRemoveMateMemoryGenerationPriorityAction({
      index: 0,
      setSettingsDraft: state.setSettingsDraft,
    });

    assert.equal(state.draft.mateMemoryGenerationSettings.priorityList.length, 1);
    assert.equal(state.draft.mateMemoryGenerationSettings.priorityList[0].provider, "copilot");
    assert.equal(state.draft.mateMemoryGenerationSettings.priorityList[0].model, "copilot-1");
    assert.equal(state.draft.mateMemoryGenerationSettings.priorityList[0].reasoningEffort, "low");
    assert.equal(state.draft.mateMemoryGenerationSettings.priorityList[0].timeoutSeconds, 75);
    assert.equal(state.draft.mateMemoryGenerationSettings.triggerIntervalMinutes, 90);
  });
});
