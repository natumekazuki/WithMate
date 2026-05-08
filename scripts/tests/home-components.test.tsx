import assert from "node:assert/strict";
import { describe, it } from "node:test";
import React, { isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  HomeLaunchDialog,
  HomeMateSetupPanel,
  HomeRecentSessionsPanel,
  HomeRightPane,
  HomeSettingsContent,
} from "../../src/home-components.js";
import { createDefaultAppSettings } from "../../src/provider-settings-state.js";
import type { ModelCatalogSnapshot } from "../../src/model-catalog.js";
import { buildHomeProviderSettingRows } from "../../src/home-settings-view-model.js";
import { DEFAULT_MATE_GROWTH_APPLY_INTERVAL_MINUTES, type MateGrowthSettings } from "../../src/mate-state.js";
import type { MateGrowthEventListItem } from "../../src/mate-growth-events-state.js";
import type { MateEmbeddingSettings } from "../../src/mate-embedding-settings.js";
import { formatTimestampLabel } from "../../src/time-state.js";
import {
  SETTINGS_MATE_GROWTH_APPLY_INTERVAL_MINUTES_LABEL,
  SETTINGS_MATE_GROWTH_AUTO_APPLY_ENABLED_LABEL,
  SETTINGS_MATE_GROWTH_EVERY_TURN_LABEL,
  SETTINGS_MATE_GROWTH_ENABLED_LABEL,
  SETTINGS_MATE_GROWTH_MANUAL_LABEL,
  SETTINGS_MATE_GROWTH_MEMORY_CANDIDATE_MODE_LABEL,
  SETTINGS_MATE_GROWTH_MODEL_PREFERENCE_ADD_LABEL,
  SETTINGS_MATE_GROWTH_MODEL_PREFERENCE_DEPTH_LABEL,
  SETTINGS_MATE_GROWTH_MODEL_PREFERENCE_ENABLED_LABEL,
  SETTINGS_MATE_GROWTH_MODEL_PREFERENCE_MODEL_LABEL,
  SETTINGS_MATE_GROWTH_MODEL_PREFERENCE_PROVIDER_LABEL,
  SETTINGS_MATE_GROWTH_MODEL_PREFERENCE_PURPOSE_LABEL,
  SETTINGS_MATE_GROWTH_MODEL_PREFERENCE_REMOVE_LABEL,
  SETTINGS_MATE_GROWTH_MODEL_PREFERENCES_LABEL,
  SETTINGS_MATE_GROWTH_SETTINGS_LABEL,
  SETTINGS_MATE_GROWTH_THRESHOLD_LABEL,
  SETTINGS_MATE_EMBEDDING_LABEL,
  SETTINGS_MATE_RESET_HELP,
  SETTINGS_MATE_RESET_LABEL,
  SETTINGS_MATE_GROWTH_HELP,
  SETTINGS_MATE_GROWTH_LABEL,
  SETTINGS_MATE_MEMORY_GENERATION_LABEL,
  SETTINGS_MATE_MEMORY_GENERATION_TRIGGER_INTERVAL_LABEL,
  SETTINGS_MATE_MEMORY_GENERATION_MODEL_LABEL,
  SETTINGS_MATE_MEMORY_GENERATION_REASONING_LABEL,
  SETTINGS_MATE_MEMORY_GENERATION_TIMEOUT_LABEL,
  SETTINGS_PROVIDER_INSTRUCTION_SECTION_LABEL,
  SETTINGS_PROVIDER_INSTRUCTION_ROOT_DIRECTORY_LABEL,
  SETTINGS_PROVIDER_INSTRUCTION_RELATIVE_PATH_LABEL,
} from "../../src/settings-ui.js";

describe("HomeSettingsContent", () => {
  const modelCatalog: ModelCatalogSnapshot = {
    revision: 1,
    providers: [
      {
        id: "codex",
        label: "Codex",
        defaultModelId: "gpt-5.4",
        defaultReasoningEffort: "high",
        models: [
          { id: "gpt-5.4", label: "GPT-5.4", reasoningEfforts: ["medium", "high"] },
          { id: "gpt-5.4-mini", label: "GPT-5.4 Mini", reasoningEfforts: ["low", "medium"] },
        ],
      },
    ],
  };

  const settingsDraft = createDefaultAppSettings();
  const providerSettingRows = buildHomeProviderSettingRows(modelCatalog, settingsDraft);
  const noOp = (..._args: unknown[]) => undefined;
  const nextMateGrowthSettings: MateGrowthSettings = {
    enabled: true,
    autoApplyEnabled: true,
    memoryCandidateMode: "every_turn",
    applyIntervalMinutes: 5,
    modelPreferences: [
      {
        purpose: "memory_candidate",
        priority: 1,
        provider: "codex",
        model: "gpt-5.4",
        depth: "low",
        enabled: true,
      },
    ],
    updatedAt: "2026-05-01T09:00:00.000Z",
  };
  const disabledMateGrowthSettings: MateGrowthSettings = {
    ...nextMateGrowthSettings,
    enabled: false,
  };

  type RenderSettingsParams = {
    applyPendingGrowth?: boolean;
    canApplyPendingGrowth?: boolean;
    applyPendingGrowthBusy?: boolean;
    canResetMate?: boolean;
    mateResetBusy?: boolean;
    mateGrowthSettings?: MateGrowthSettings | null;
    mateGrowthBusy?: boolean;
    mateGrowthFeedback?: string;
    mateGrowthEvents?: MateGrowthEventListItem[];
    mateGrowthEventsLoading?: boolean;
    mateGrowthEventsFeedback?: string;
    mateGrowthEventBusyTarget?: string | null;
    onReloadMateGrowthEvents?: () => void;
    correctingMateGrowthEventId?: string | null;
    correctingMateGrowthEventStatement?: string;
    onBeginCorrectMateGrowthEvent?: (eventId: string, statement: string) => void;
    onChangeCorrectMateGrowthEventStatement?: (statement: string) => void;
    onCancelCorrectMateGrowthEvent?: () => void;
    onCorrectMateGrowthEvent?: (eventId: string, statement: string) => void;
    onDisableMateGrowthEvent?: (eventId: string) => void;
    onForgetMateGrowthEvent?: (eventId: string) => void;
    onUpdateMateGrowthSettings?: (input: unknown) => void;
    onResetMate?: () => void;
  };

  const collectElementsById = (node: ReactNode, predicate: (element: React.ReactElement) => boolean): React.ReactElement[] => {
    const result: React.ReactElement[] = [];
    const visitNode = (currentNode: ReactNode) => {
      if (!isValidElement(currentNode)) {
        return;
      }

      if (predicate(currentNode)) {
        result.push(currentNode);
      }

      const children = currentNode.props.children;
      if (Array.isArray(children)) {
        children.forEach((child) => visitNode(child as ReactNode));
        return;
      }

      if (children === null || children === undefined || typeof children === "boolean") {
        return;
      }

      visitNode(children as ReactNode);
    };

    visitNode(node);
    return result;
  };

  const buildSettingsContent = (params?: RenderSettingsParams) => HomeSettingsContent({
    settingsDraft,
    providerSettingRows,
    modelCatalogRevisionLabel: String(modelCatalog.revision),
    settingsDirty: false,
    settingsFeedback: "",
    memoryManagementSnapshot: null,
    memoryManagementPages: {
      session: { nextCursor: null, hasMore: false, total: 0 },
      project: { nextCursor: null, hasMore: false, total: 0 },
      character: { nextCursor: null, hasMore: false, total: 0 },
      mate_profile: { nextCursor: null, hasMore: false, total: 0 },
    },
    memoryManagementLoading: false,
    memoryManagementBusyTarget: null,
    memoryManagementFeedback: "",
    mateGrowthSettings: params && "mateGrowthSettings" in params ? params.mateGrowthSettings ?? null : nextMateGrowthSettings,
    mateGrowthFeedback: params?.mateGrowthFeedback ?? "",
    mateGrowthBusy: params?.mateGrowthBusy ?? false,
    mateGrowthEvents: params?.mateGrowthEvents ?? [],
    mateGrowthEventsLoading: params?.mateGrowthEventsLoading ?? false,
    mateGrowthEventsFeedback: params?.mateGrowthEventsFeedback ?? "",
    mateGrowthEventBusyTarget: params?.mateGrowthEventBusyTarget ?? null,
    mateEmbeddingSettings: null,
    mateEmbeddingFeedback: "",
    mateEmbeddingBusy: false,
    onChangeSystemPromptPrefix: noOp,
    onChangeMemoryGenerationEnabled: noOp,
    onChangeMateMemoryGenerationPriorityProvider: noOp,
    onChangeMateMemoryGenerationPriorityModel: noOp,
    onChangeMateMemoryGenerationPriorityReasoningEffort: noOp,
    onChangeMateMemoryGenerationPriorityTimeoutSeconds: noOp,
    onChangeMateMemoryGenerationTriggerIntervalMinutes: noOp,
    onChangeAutoCollapseActionDockOnSend: noOp,
    onChangeProviderEnabled: noOp,
    onChangeProviderInstructionEnabled: noOp,
    onChangeProviderInstructionWriteMode: noOp,
    onChangeProviderInstructionFailPolicy: noOp,
    onChangeProviderInstructionRootDirectory: noOp,
    onChangeProviderInstructionInstructionRelativePath: noOp,
    onChangeProviderSkillRootPath: noOp,
    onBrowseProviderSkillRootPath: noOp,
    onChangeMemoryExtractionModel: noOp,
    onChangeMemoryExtractionReasoningEffort: noOp,
    onChangeMemoryExtractionThreshold: noOp,
    onChangeMemoryExtractionTimeoutSeconds: noOp,
    onChangeCharacterReflectionModel: noOp,
    onChangeCharacterReflectionReasoningEffort: noOp,
    onChangeCharacterReflectionTimeoutSeconds: noOp,
    onChangeCharacterReflectionCooldownSeconds: noOp,
    onChangeCharacterReflectionCharDeltaThreshold: noOp,
    onChangeCharacterReflectionMessageDeltaThreshold: noOp,
    onImportModelCatalog: noOp,
    onExportModelCatalog: noOp,
    onOpenAppLogFolder: noOp,
    onOpenCrashDumpFolder: noOp,
    onReloadMemoryManagement: noOp,
    onChangeMemoryManagementViewFilters: noOp,
    onLoadMoreMemoryManagement: noOp,
    onDeleteSessionMemory: noOp,
    onDeleteProjectMemoryEntry: noOp,
    onDeleteCharacterMemoryEntry: noOp,
    onDeleteMateProfileItem: noOp,
    onStartMateEmbeddingDownload: noOp,
    onApplyPendingGrowth: params?.applyPendingGrowth ? noOp : undefined,
    canApplyPendingGrowth: params?.canApplyPendingGrowth,
    applyPendingGrowthBusy: params?.applyPendingGrowthBusy,
    onReloadMateGrowthEvents: params?.onReloadMateGrowthEvents ?? noOp,
    correctingMateGrowthEventId: params?.correctingMateGrowthEventId ?? null,
    correctingMateGrowthEventStatement: params?.correctingMateGrowthEventStatement ?? "",
    onBeginCorrectMateGrowthEvent: params?.onBeginCorrectMateGrowthEvent ?? noOp,
    onChangeCorrectMateGrowthEventStatement: params?.onChangeCorrectMateGrowthEventStatement ?? noOp,
    onCancelCorrectMateGrowthEvent: params?.onCancelCorrectMateGrowthEvent ?? noOp,
    onCorrectMateGrowthEvent: params?.onCorrectMateGrowthEvent ?? noOp,
    onDisableMateGrowthEvent: params?.onDisableMateGrowthEvent ?? noOp,
    onForgetMateGrowthEvent: params?.onForgetMateGrowthEvent ?? noOp,
    onUpdateMateGrowthSettings: params?.onUpdateMateGrowthSettings ?? noOp,
    onResetMate: params?.onResetMate ?? noOp,
    canResetMate: params?.canResetMate ?? false,
    mateResetBusy: params?.mateResetBusy ?? false,
    onSaveSettings: noOp,
  });

  const renderSettings = (params?: RenderSettingsParams) => renderToStaticMarkup(buildSettingsContent(params));

  const extractResetButton = (html: string) => {
    const resetLabelIndex = html.indexOf(`<strong>${SETTINGS_MATE_RESET_LABEL}</strong>`);
    const resetButtonIndex = html.indexOf('<button class="launch-toggle danger-button"', resetLabelIndex);
    const resetButtonEndIndex = html.indexOf("</button>", resetButtonIndex);
    assert.ok(resetLabelIndex >= 0 && resetButtonIndex >= 0 && resetButtonEndIndex >= 0);
    return html.slice(resetButtonIndex, resetButtonEndIndex + 9);
  };

  const extractGrowthButton = (html: string) => {
    const growthLabelIndex = html.indexOf(`<strong>${SETTINGS_MATE_GROWTH_LABEL}</strong>`);
    const growthButtonIndex = html.indexOf('<button class="launch-toggle"', growthLabelIndex);
    const growthButtonEndIndex = html.indexOf("</button>", growthButtonIndex);
    assert.ok(growthLabelIndex >= 0 && growthButtonIndex >= 0 && growthButtonEndIndex >= 0);
    return html.slice(growthButtonIndex, growthButtonEndIndex + 9);
  };

  const extractResetButtonElement = (params?: RenderSettingsParams): React.ReactElement => {
    const content = buildSettingsContent(params);
    const buttons = collectElementsById(content, (element) => element.type === "button");
    const resetButton = buttons.find((button) =>
      button.props.type === "button" &&
      button.props.className === "launch-toggle danger-button" &&
      typeof button.props.children === "string"
    );
    if (!resetButton) {
      throw new Error("Mate Reset ボタンが見つからないためテストを実行できません。");
    }

    return resetButton;
  };

  const collectGrowthInputElements = (params?: RenderSettingsParams) => {
    const content = buildSettingsContent(params);
    const byId = (id: string, type: "button" | "input" | "select") =>
      collectElementsById(content, (element) => element.type === type && element.props.id === id);

    return {
      enabled: byId("mate-growth-enabled", "input")[0],
      autoApplyEnabled: byId("mate-growth-auto-apply-enabled", "input")[0],
      memoryCandidateMode: byId("mate-growth-memory-candidate-mode", "select")[0],
      applyIntervalMinutes: byId("mate-growth-apply-interval-minutes", "input")[0],
      modelPreferencePurpose: byId("mate-growth-model-preference-purpose-0", "select")[0],
      modelPreferenceProvider: byId("mate-growth-model-preference-provider-0", "input")[0],
      modelPreferenceModel: byId("mate-growth-model-preference-model-0", "input")[0],
      modelPreferenceDepth: byId("mate-growth-model-preference-depth-0", "input")[0],
      modelPreferenceEnabled: byId("mate-growth-model-preference-enabled-0", "input")[0],
      modelPreferenceRemove: byId("mate-growth-model-preference-remove-0", "button")[0],
      modelPreferenceAdd: byId("mate-growth-model-preference-add", "button")[0],
    };
  };

  it("Mate Memory Generation のセクションが表示される", () => {
    const html = renderSettings();

    assert.ok(html.includes(`<strong>${SETTINGS_MATE_MEMORY_GENERATION_LABEL}</strong>`));
    assert.ok(html.includes("<span>Priority 1</span>"));
    assert.ok(html.includes(`<span>${SETTINGS_MATE_MEMORY_GENERATION_MODEL_LABEL}</span>`));
    assert.ok(html.includes(`<span>${SETTINGS_MATE_MEMORY_GENERATION_REASONING_LABEL}</span>`));
    assert.ok(html.includes(`<span>${SETTINGS_MATE_MEMORY_GENERATION_TIMEOUT_LABEL}</span>`));
    assert.ok(html.includes(`<span>${SETTINGS_MATE_MEMORY_GENERATION_TRIGGER_INTERVAL_LABEL}</span>`));
  });

  it("Mate Reset のラベルとヘルプが表示される", () => {
    const html = renderSettings();
    assert.ok(html.includes(`<strong>${SETTINGS_MATE_RESET_LABEL}</strong>`));
    assert.ok(html.includes(`<p class="settings-help">${SETTINGS_MATE_RESET_HELP}</p>`));
  });

  it("Mate Growth のラベルとヘルプが表示される", () => {
    const html = renderSettings({ applyPendingGrowth: true });
    assert.ok(html.includes(`<strong>${SETTINGS_MATE_GROWTH_LABEL}</strong>`));
    assert.ok(html.includes(`<p class="settings-help">${SETTINGS_MATE_GROWTH_HELP}</p>`));
  });

  it("Mate Growth 設定セクションが表示される", () => {
    const html = renderSettings();
    assert.ok(html.includes(`<strong>${SETTINGS_MATE_GROWTH_SETTINGS_LABEL}</strong>`));
    assert.ok(html.includes(`<span>${SETTINGS_MATE_GROWTH_ENABLED_LABEL}</span>`));
    assert.ok(html.includes(`<span>${SETTINGS_MATE_GROWTH_AUTO_APPLY_ENABLED_LABEL}</span>`));
    assert.ok(html.includes(`<span>${SETTINGS_MATE_GROWTH_MEMORY_CANDIDATE_MODE_LABEL}</span>`));
    assert.ok(/<option value="every_turn"[^>]*>every_turn<\/option>/.test(html));
    assert.ok(/<option value="threshold"[^>]*>threshold<\/option>/.test(html));
    assert.ok(/<option value="manual"[^>]*>manual<\/option>/.test(html));
    assert.ok(html.includes(`<span>${SETTINGS_MATE_GROWTH_APPLY_INTERVAL_MINUTES_LABEL}</span>`));
    assert.ok(html.includes(`<strong>${SETTINGS_MATE_GROWTH_MODEL_PREFERENCES_LABEL}</strong>`));
    assert.ok(html.includes(`<span>${SETTINGS_MATE_GROWTH_MODEL_PREFERENCE_PURPOSE_LABEL}</span>`));
    assert.ok(html.includes(`<span>${SETTINGS_MATE_GROWTH_MODEL_PREFERENCE_PROVIDER_LABEL}</span>`));
    assert.ok(html.includes(`<span>${SETTINGS_MATE_GROWTH_MODEL_PREFERENCE_MODEL_LABEL}</span>`));
    assert.ok(html.includes(`<span>${SETTINGS_MATE_GROWTH_MODEL_PREFERENCE_DEPTH_LABEL}</span>`));
    assert.ok(html.includes(`<span>${SETTINGS_MATE_GROWTH_MODEL_PREFERENCE_ENABLED_LABEL}</span>`));
    assert.ok(html.includes(`>${SETTINGS_MATE_GROWTH_MODEL_PREFERENCE_REMOVE_LABEL}</button>`));
    assert.ok(html.includes(`>${SETTINGS_MATE_GROWTH_MODEL_PREFERENCE_ADD_LABEL}</button>`));
  });

  it("Growth 設定の checkbox/select/input 変更で onUpdate callback が呼ばれる", () => {
    const updates: Array<Record<string, unknown>> = [];
    const { enabled, autoApplyEnabled, memoryCandidateMode, applyIntervalMinutes } = collectGrowthInputElements({
      onUpdateMateGrowthSettings: (input) => {
        updates.push(input as Record<string, unknown>);
      },
    });

    if (!enabled || !autoApplyEnabled || !memoryCandidateMode || !applyIntervalMinutes) {
      throw new Error("Growth 設定 input が取得できませんでした。");
    }

    enabled.props.onChange({ target: { checked: false } } as { target: { checked: boolean } });
    autoApplyEnabled.props.onChange({ target: { checked: true } } as { target: { checked: boolean } });
    memoryCandidateMode.props.onChange({ target: { value: "manual" } } as { target: { value: string } });
    applyIntervalMinutes.props.onChange({ target: { value: "15" } } as { target: { value: string } });

    assert.equal(updates.length, 4);
    assert.deepEqual(updates[0], { enabled: false });
    assert.deepEqual(updates[1], { autoApplyEnabled: true });
    assert.deepEqual(updates[2], { memoryCandidateMode: "manual" });
    assert.deepEqual(updates[3], { applyIntervalMinutes: 15 });
  });

  it("Growth model priority の変更で onUpdate callback が呼ばれる", () => {
    const updates: Array<Record<string, unknown>> = [];
    const {
      modelPreferencePurpose,
      modelPreferenceProvider,
      modelPreferenceModel,
      modelPreferenceDepth,
      modelPreferenceEnabled,
      modelPreferenceRemove,
      modelPreferenceAdd,
    } = collectGrowthInputElements({
      onUpdateMateGrowthSettings: (input) => {
        updates.push(input as Record<string, unknown>);
      },
    });

    if (
      !modelPreferencePurpose ||
      !modelPreferenceProvider ||
      !modelPreferenceModel ||
      !modelPreferenceDepth ||
      !modelPreferenceEnabled ||
      !modelPreferenceRemove ||
      !modelPreferenceAdd
    ) {
      throw new Error("Growth model priority input が取得できませんでした。");
    }

    modelPreferencePurpose.props.onChange({ target: { value: "profile_update" } } as { target: { value: string } });
    modelPreferenceProvider.props.onChange({ target: { value: "copilot" } } as { target: { value: string } });
    modelPreferenceModel.props.onChange({ target: { value: "model-b" } } as { target: { value: string } });
    modelPreferenceDepth.props.onChange({ target: { value: "medium" } } as { target: { value: string } });
    modelPreferenceEnabled.props.onChange({ target: { checked: false } } as { target: { checked: boolean } });
    modelPreferenceRemove.props.onClick();
    modelPreferenceAdd.props.onClick();

    assert.equal(updates.length, 7);
    assert.deepEqual(updates[0]?.modelPreferences, [{
      ...nextMateGrowthSettings.modelPreferences[0],
      purpose: "profile_update",
    }]);
    assert.deepEqual(updates[1]?.modelPreferences, [{
      ...nextMateGrowthSettings.modelPreferences[0],
      provider: "copilot",
    }]);
    assert.deepEqual(updates[2]?.modelPreferences, [{
      ...nextMateGrowthSettings.modelPreferences[0],
      model: "model-b",
    }]);
    assert.deepEqual(updates[3]?.modelPreferences, [{
      ...nextMateGrowthSettings.modelPreferences[0],
      depth: "medium",
    }]);
    assert.deepEqual(updates[4]?.modelPreferences, [{
      ...nextMateGrowthSettings.modelPreferences[0],
      enabled: false,
    }]);
    assert.deepEqual(updates[5], { modelPreferences: [] });
    assert.deepEqual(updates[6]?.modelPreferences, [
      nextMateGrowthSettings.modelPreferences[0],
      {
        purpose: "memory_candidate",
        priority: 2,
        provider: "codex",
        model: "gpt-5.4",
        depth: "high",
        enabled: true,
      },
    ]);
  });

  it("Growth 設定の interval input が空文字のとき onUpdate callback は呼ばれない", () => {
    const updates: Array<Record<string, unknown>> = [];
    const { applyIntervalMinutes } = collectGrowthInputElements({
      onUpdateMateGrowthSettings: (input) => {
        updates.push(input as Record<string, unknown>);
      },
    });

    if (!applyIntervalMinutes) {
      throw new Error("Growth 設定 interval input が取得できませんでした。");
    }

    applyIntervalMinutes.props.onChange({ target: { value: "" } } as { target: { value: string } });

    assert.deepEqual(updates, []);
  });

  it("mateGrowthSettings が null のとき成長設定コントロールは操作不可", () => {
    const elements = collectGrowthInputElements({ mateGrowthSettings: null });
    if (!elements.enabled || !elements.autoApplyEnabled || !elements.memoryCandidateMode || !elements.applyIntervalMinutes) {
      throw new Error("Growth 設定 input が見つからないためテストを実行できません。");
    }
    assert.ok(elements.enabled.props.disabled);
    assert.ok(elements.autoApplyEnabled.props.disabled);
    assert.ok(elements.memoryCandidateMode.props.disabled);
    assert.ok(elements.applyIntervalMinutes.props.disabled);
    assert.equal(elements.applyIntervalMinutes.props.value, DEFAULT_MATE_GROWTH_APPLY_INTERVAL_MINUTES);
  });

  it("mateGrowthBusy=true のとき成長設定コントロールは操作不可", () => {
    const html = renderSettings({ mateGrowthBusy: true, mateGrowthFeedback: "更新中..." });
    const elements = collectGrowthInputElements({ mateGrowthBusy: true });
    if (!elements.enabled || !elements.autoApplyEnabled || !elements.memoryCandidateMode || !elements.applyIntervalMinutes) {
      throw new Error("Growth 設定 input が見つからないためテストを実行できません。");
    }
    assert.ok(elements.enabled.props.disabled);
    assert.ok(elements.autoApplyEnabled.props.disabled);
    assert.ok(elements.memoryCandidateMode.props.disabled);
    assert.ok(elements.applyIntervalMinutes.props.disabled);
    assert.ok(html.includes("更新中..."));
  });

  it("mateGrowthSettings.enabled=false のとき有効化以外の成長設定コントロールは操作不可", () => {
    const elements = collectGrowthInputElements({ mateGrowthSettings: disabledMateGrowthSettings });
    if (!elements.enabled || !elements.autoApplyEnabled || !elements.memoryCandidateMode || !elements.applyIntervalMinutes) {
      throw new Error("Growth 設定 input が見つからないためテストを実行できません。");
    }
    assert.equal(elements.enabled.props.disabled, false);
    assert.ok(elements.autoApplyEnabled.props.disabled);
    assert.ok(elements.memoryCandidateMode.props.disabled);
    assert.ok(elements.applyIntervalMinutes.props.disabled);
  });

  it("canResetMate=false のときリセットボタンは無効化される", () => {
    const html = renderSettings({ canResetMate: false });
    const buttonHtml = extractResetButton(html);
    assert.ok(buttonHtml.includes('disabled=""'));
    assert.ok(buttonHtml.includes(SETTINGS_MATE_RESET_LABEL));
  });

  it("canResetMate=true のときリセットボタンは有効", () => {
    const html = renderSettings({ canResetMate: true });
    const buttonHtml = extractResetButton(html);
    assert.ok(!buttonHtml.includes('disabled=""'));
  });

  it("mateResetBusy=true のときリセットボタンは無効化され「リセット中...」が表示される", () => {
    const html = renderSettings({ canResetMate: true, mateResetBusy: true });
    const buttonHtml = extractResetButton(html);
    assert.ok(buttonHtml.includes('disabled=""'));
    assert.ok(buttonHtml.includes("リセット中..."));
  });

  it("Mate Reset ボタンを押すと onResetMate が呼ばれる", () => {
    let called = 0;
    const button = extractResetButtonElement({
      canResetMate: true,
      mateResetBusy: false,
      onResetMate: () => {
        called += 1;
      },
    });

    button.props.onClick?.();

    assert.equal(called, 1);
  });

  it("canApplyPendingGrowth=false のとき適用ボタンは無効化される", () => {
    const html = renderSettings({ applyPendingGrowth: true, canApplyPendingGrowth: false });
    const buttonHtml = extractGrowthButton(html);
    assert.ok(buttonHtml.includes("disabled=\"\""));
    assert.ok(buttonHtml.includes(SETTINGS_MATE_GROWTH_LABEL));
  });

  it("canApplyPendingGrowth=true のとき適用ボタンは有効", () => {
    const html = renderSettings({ applyPendingGrowth: true, canApplyPendingGrowth: true });
    const buttonHtml = extractGrowthButton(html);
    assert.ok(!buttonHtml.includes("disabled=\"\""));
  });

  it("mateGrowthSettings.enabled=false のとき適用ボタンは無効", () => {
    const html = renderSettings({
      applyPendingGrowth: true,
      canApplyPendingGrowth: true,
      mateGrowthSettings: disabledMateGrowthSettings,
    });
    const buttonHtml = extractGrowthButton(html);
    assert.ok(buttonHtml.includes("disabled=\"\""));
  });

  it("最近の Growth Event が表示される", () => {
    const html = renderSettings({
      mateGrowthEvents: [
        {
          id: "event-1",
          sourceType: "mate_talk",
          sourceSessionId: "session-1",
          growthSourceType: "memory",
          kind: "update",
          targetSection: "tone",
          statement: "一人称は「私」を優先する",
          rationalePreview: "メイトークで明示されたため",
          confidence: 0.91,
          salienceScore: 0.82,
          recurrenceCount: 2,
          projectionAllowed: true,
          state: "candidate",
          appliedAt: null,
          createdAt: "2026-05-01T09:00:00.000Z",
          updatedAt: "2026-05-01T09:30:00.000Z",
        },
      ],
    });

    assert.ok(html.includes("<strong>最近の Growth Event</strong>"));
    assert.ok(html.includes("一人称は「私」を優先する"));
    assert.ok(html.includes("候補"));
    assert.ok(html.includes("tone"));
    assert.ok(html.includes("メイトークで明示されたため"));
    assert.ok(html.includes("修正"));
    assert.ok(html.includes("無効化"));
    assert.ok(html.includes("忘れる"));
  });

  it("Growth Event の修正 / 無効化 / 忘却ボタンは対象 id を渡す", () => {
    const calls: string[] = [];
    const content = buildSettingsContent({
      mateGrowthEvents: [
        {
          id: "event-action",
          sourceType: "mate_talk",
          sourceSessionId: "session-1",
          growthSourceType: "memory",
          kind: "update",
          targetSection: "tone",
          statement: "語尾は落ち着かせる",
          rationalePreview: "",
          confidence: 0.91,
          salienceScore: 0.82,
          recurrenceCount: 2,
          projectionAllowed: true,
          state: "candidate",
          appliedAt: null,
          createdAt: "2026-05-01T09:00:00.000Z",
          updatedAt: "2026-05-01T09:30:00.000Z",
        },
      ],
      onBeginCorrectMateGrowthEvent: (eventId, statement) => calls.push(`begin:${eventId}:${statement}`),
      onDisableMateGrowthEvent: (eventId) => calls.push(`disable:${eventId}`),
      onForgetMateGrowthEvent: (eventId) => calls.push(`forget:${eventId}`),
    });

    const actionButtons = collectElementsById(content, (element) =>
      element.type === "button" &&
      (element.props.children === "修正" || element.props.children === "無効化" || element.props.children === "忘れる"),
    );
    assert.equal(actionButtons.length, 3);

    actionButtons[0]?.props.onClick();
    actionButtons[1]?.props.onClick();
    actionButtons[2]?.props.onClick();

    assert.deepEqual(calls, [
      "begin:event-action:語尾は落ち着かせる",
      "disable:event-action",
      "forget:event-action",
    ]);
  });

  it("Growth Event の修正フォームは修正内容を保存する", () => {
    const calls: string[] = [];
    const content = buildSettingsContent({
      mateGrowthEvents: [
        {
          id: "event-correct-action",
          sourceType: "mate_talk",
          sourceSessionId: "session-1",
          growthSourceType: "memory",
          kind: "update",
          targetSection: "tone",
          statement: "修正前イベント",
          rationalePreview: "",
          confidence: 0.91,
          salienceScore: 0.82,
          recurrenceCount: 2,
          projectionAllowed: true,
          state: "candidate",
          appliedAt: null,
          createdAt: "2026-05-01T09:00:00.000Z",
          updatedAt: "2026-05-01T09:30:00.000Z",
        },
      ],
      correctingMateGrowthEventId: "event-correct-action",
      correctingMateGrowthEventStatement: "修正後イベント",
      onChangeCorrectMateGrowthEventStatement: (statement) => calls.push(`change:${statement}`),
      onCancelCorrectMateGrowthEvent: () => calls.push("cancel"),
      onCorrectMateGrowthEvent: (eventId, statement) => calls.push(`correct:${eventId}:${statement}`),
    });

    const textarea = collectElementsById(content, (element) =>
      element.type === "textarea" && element.props.value === "修正後イベント",
    )[0];
    assert.equal(textarea?.props.value, "修正後イベント");
    textarea?.props.onChange({ target: { value: "さらに修正" } });

    const formButtons = collectElementsById(content, (element) =>
      element.type === "button" &&
      (element.props.children === "保存" || element.props.children === "キャンセル"),
    );
    assert.equal(formButtons.length, 2);
    formButtons[0]?.props.onClick();
    formButtons[1]?.props.onClick();

    assert.deepEqual(calls, [
      "change:さらに修正",
      "correct:event-correct-action:修正後イベント",
      "cancel",
    ]);
  });

  it("Growth Event の修正 / 無効化 / 忘却ボタンは候補以外では無効", () => {
    const content = buildSettingsContent({
      mateGrowthEvents: [
        {
          id: "event-applied-action",
          sourceType: "mate_talk",
          sourceSessionId: "session-1",
          growthSourceType: "memory",
          kind: "update",
          targetSection: "tone",
          statement: "適用済みイベント",
          rationalePreview: "",
          confidence: 0.91,
          salienceScore: 0.82,
          recurrenceCount: 2,
          projectionAllowed: true,
          state: "applied",
          appliedAt: "2026-05-01T09:10:00.000Z",
          createdAt: "2026-05-01T09:00:00.000Z",
          updatedAt: "2026-05-01T09:30:00.000Z",
        },
      ],
      onBeginCorrectMateGrowthEvent: () => {},
      onCorrectMateGrowthEvent: () => {},
      onDisableMateGrowthEvent: () => {},
      onForgetMateGrowthEvent: () => {},
    });

    const actionButtons = collectElementsById(content, (element) =>
      element.type === "button" &&
      (element.props.children === "修正" || element.props.children === "無効化" || element.props.children === "忘れる"),
    );

    assert.equal(actionButtons.length, 3);
    assert.ok(actionButtons.every((button) => button.props.disabled));
  });

  it("Growth Event の修正ボタンと保存ボタンは Growth apply 中に無効", () => {
    const content = buildSettingsContent({
      applyPendingGrowthBusy: true,
      mateGrowthEvents: [
        {
          id: "event-correct-busy",
          sourceType: "mate_talk",
          sourceSessionId: "session-1",
          growthSourceType: "memory",
          kind: "update",
          targetSection: "tone",
          statement: "修正対象イベント",
          rationalePreview: "",
          confidence: 0.91,
          salienceScore: 0.82,
          recurrenceCount: 2,
          projectionAllowed: true,
          state: "candidate",
          appliedAt: null,
          createdAt: "2026-05-01T09:00:00.000Z",
          updatedAt: "2026-05-01T09:30:00.000Z",
        },
      ],
      correctingMateGrowthEventId: "event-correct-busy",
      correctingMateGrowthEventStatement: "修正後イベント",
      onBeginCorrectMateGrowthEvent: () => {},
      onCorrectMateGrowthEvent: () => {},
    });

    const correctButton = collectElementsById(content, (element) =>
      element.type === "button" && element.props.children === "修正",
    )[0];
    const saveButton = collectElementsById(content, (element) =>
      element.type === "button" && element.props.children === "保存",
    )[0];

    assert.equal(correctButton?.props.disabled, true);
    assert.equal(saveButton?.props.disabled, true);
  });

  it("applyPendingGrowthBusy=true のとき適用ボタンは無効化され「適用中...」が表示される", () => {
    const html = renderSettings({ applyPendingGrowth: true, canApplyPendingGrowth: true, applyPendingGrowthBusy: true });
    const buttonHtml = extractGrowthButton(html);
    assert.ok(buttonHtml.includes("disabled=\"\""));
    assert.ok(buttonHtml.includes("適用中..."));
  });

  it("Mate Embedding のキャッシュ状態が拡張表示される", () => {
    const mateEmbeddingSettings: MateEmbeddingSettings = {
      mateId: "current",
      enabled: true,
      backendType: "local_transformers_js",
      modelId: "text-embedding-3-large",
      sourceModelId: "text-embedding-3-small",
      dimension: 1536,
      cachePolicy: "download_once_local_cache",
      cacheState: "ready",
      cacheDirPath: "hidden-cache-path-marker",
      cacheManifestSha256: "manifest-sha",
      modelRevision: "model-revision",
      cacheSizeBytes: 1536,
      cacheUpdatedAt: "2026-05-01T09:30:00.000Z",
      lastVerifiedAt: null,
      lastStatus: "available",
      lastErrorPreview: "",
      createdAt: "2026-05-01T09:00:00.000Z",
      updatedAt: "2026-05-01T09:00:00.000Z",
    };

    const html = renderToStaticMarkup(
      <HomeSettingsContent
        settingsDraft={settingsDraft}
        providerSettingRows={providerSettingRows}
        modelCatalogRevisionLabel={String(modelCatalog.revision)}
        settingsDirty={false}
        settingsFeedback=""
        memoryManagementSnapshot={null}
        memoryManagementPages={{
          session: { nextCursor: null, hasMore: false, total: 0 },
          project: { nextCursor: null, hasMore: false, total: 0 },
          character: { nextCursor: null, hasMore: false, total: 0 },
          mate_profile: { nextCursor: null, hasMore: false, total: 0 },
        }}
        memoryManagementLoading={false}
        memoryManagementBusyTarget={null}
        memoryManagementFeedback=""
        mateGrowthSettings={nextMateGrowthSettings}
        mateGrowthFeedback=""
        mateGrowthBusy={false}
        mateGrowthEvents={[]}
        mateGrowthEventsLoading={false}
        mateGrowthEventsFeedback=""
        mateEmbeddingSettings={mateEmbeddingSettings}
        mateEmbeddingFeedback=""
        mateEmbeddingBusy={false}
        onChangeSystemPromptPrefix={noOp}
        onChangeMemoryGenerationEnabled={noOp}
        onChangeMateMemoryGenerationPriorityProvider={noOp}
        onChangeMateMemoryGenerationPriorityModel={noOp}
        onChangeMateMemoryGenerationPriorityReasoningEffort={noOp}
        onChangeMateMemoryGenerationPriorityTimeoutSeconds={noOp}
        onChangeMateMemoryGenerationTriggerIntervalMinutes={noOp}
        onChangeAutoCollapseActionDockOnSend={noOp}
        onChangeProviderEnabled={noOp}
        onChangeProviderInstructionEnabled={noOp}
        onChangeProviderInstructionWriteMode={noOp}
        onChangeProviderInstructionFailPolicy={noOp}
        onChangeProviderInstructionRootDirectory={noOp}
        onChangeProviderInstructionInstructionRelativePath={noOp}
        onChangeProviderSkillRootPath={noOp}
        onBrowseProviderSkillRootPath={noOp}
        onChangeMemoryExtractionModel={noOp}
        onChangeMemoryExtractionReasoningEffort={noOp}
        onChangeMemoryExtractionThreshold={noOp}
        onChangeMemoryExtractionTimeoutSeconds={noOp}
        onChangeCharacterReflectionModel={noOp}
        onChangeCharacterReflectionReasoningEffort={noOp}
        onChangeCharacterReflectionTimeoutSeconds={noOp}
        onChangeCharacterReflectionCooldownSeconds={noOp}
        onChangeCharacterReflectionCharDeltaThreshold={noOp}
        onChangeCharacterReflectionMessageDeltaThreshold={noOp}
        onImportModelCatalog={noOp}
        onExportModelCatalog={noOp}
        onOpenAppLogFolder={noOp}
        onOpenCrashDumpFolder={noOp}
        onReloadMemoryManagement={noOp}
        onChangeMemoryManagementViewFilters={noOp}
        onLoadMoreMemoryManagement={noOp}
        onDeleteSessionMemory={noOp}
        onDeleteProjectMemoryEntry={noOp}
        onDeleteCharacterMemoryEntry={noOp}
        onDeleteMateProfileItem={noOp}
        onStartMateEmbeddingDownload={noOp}
        onReloadMateGrowthEvents={noOp}
        onUpdateMateGrowthSettings={noOp}
        onSaveSettings={noOp}
      />,
    );

    assert.ok(html.includes(`<strong>${SETTINGS_MATE_EMBEDDING_LABEL}</strong>`));
    assert.ok(html.includes("キャッシュサイズ"));
    assert.ok(html.includes("<dd>1.5 KB</dd>"));
    assert.ok(html.includes("<dt>最終更新</dt>"));
    assert.ok(html.includes(`<dd>${formatTimestampLabel(mateEmbeddingSettings.cacheUpdatedAt)}</dd>`));
    assert.ok(html.includes("<dt>最終確認</dt>"));
    assert.ok(html.includes("<dd>-</dd>"));
    assert.ok(html.includes("<dt>最終ステータス</dt>"));
    assert.ok(html.includes("<dd>利用可</dd>"));
    assert.ok(!html.includes("hidden-cache-path-marker"));
  });

  it("Provider Instruction Sync に rootDirectory / instructionRelativePath の入力が表示される", () => {
    const customRows = buildHomeProviderSettingRows(modelCatalog, settingsDraft, [
      {
        providerId: "codex",
        targetId: "main",
        enabled: true,
        rootDirectory: "/repo-root",
        instructionRelativePath: "docs/instructions.md",
        writeMode: "managed_block",
        projectionScope: "mate_only",
        failPolicy: "warn_continue",
        requiresRestart: false,
        lastSyncState: "never",
        lastSyncRunId: null,
        lastSyncedRevisionId: null,
        lastErrorPreview: "",
        lastSyncedAt: null,
      },
    ]);

    const html = renderToStaticMarkup(
      <HomeSettingsContent
        settingsDraft={settingsDraft}
        providerSettingRows={customRows}
        modelCatalogRevisionLabel={String(modelCatalog.revision)}
        settingsDirty={false}
        settingsFeedback=""
        memoryManagementSnapshot={null}
        memoryManagementPages={{
          session: { nextCursor: null, hasMore: false, total: 0 },
          project: { nextCursor: null, hasMore: false, total: 0 },
          character: { nextCursor: null, hasMore: false, total: 0 },
          mate_profile: { nextCursor: null, hasMore: false, total: 0 },
        }}
        memoryManagementLoading={false}
        memoryManagementBusyTarget={null}
        memoryManagementFeedback=""
        mateEmbeddingSettings={null}
        mateEmbeddingFeedback=""
        mateEmbeddingBusy={false}
        mateGrowthEvents={[]}
        mateGrowthEventsLoading={false}
        mateGrowthEventsFeedback=""
        onChangeSystemPromptPrefix={noOp}
        onChangeMemoryGenerationEnabled={noOp}
        onChangeMateMemoryGenerationPriorityProvider={noOp}
        onChangeMateMemoryGenerationPriorityModel={noOp}
        onChangeMateMemoryGenerationPriorityReasoningEffort={noOp}
        onChangeMateMemoryGenerationPriorityTimeoutSeconds={noOp}
        onChangeMateMemoryGenerationTriggerIntervalMinutes={noOp}
        onChangeAutoCollapseActionDockOnSend={noOp}
        onChangeProviderEnabled={noOp}
        onChangeProviderInstructionEnabled={noOp}
        onChangeProviderInstructionWriteMode={noOp}
        onChangeProviderInstructionFailPolicy={noOp}
        onChangeProviderInstructionRootDirectory={noOp}
        onChangeProviderInstructionInstructionRelativePath={noOp}
        onChangeProviderSkillRootPath={noOp}
        onBrowseProviderSkillRootPath={noOp}
        onChangeMemoryExtractionModel={noOp}
        onChangeMemoryExtractionReasoningEffort={noOp}
        onChangeMemoryExtractionThreshold={noOp}
        onChangeMemoryExtractionTimeoutSeconds={noOp}
        onChangeCharacterReflectionModel={noOp}
        onChangeCharacterReflectionReasoningEffort={noOp}
        onChangeCharacterReflectionTimeoutSeconds={noOp}
        onChangeCharacterReflectionCooldownSeconds={noOp}
        onChangeCharacterReflectionCharDeltaThreshold={noOp}
        onChangeCharacterReflectionMessageDeltaThreshold={noOp}
        onImportModelCatalog={noOp}
        onExportModelCatalog={noOp}
        onOpenAppLogFolder={noOp}
        onOpenCrashDumpFolder={noOp}
        onReloadMemoryManagement={noOp}
        onChangeMemoryManagementViewFilters={noOp}
        onLoadMoreMemoryManagement={noOp}
        onDeleteSessionMemory={noOp}
        onDeleteProjectMemoryEntry={noOp}
        onDeleteCharacterMemoryEntry={noOp}
        onDeleteMateProfileItem={noOp}
        onStartMateEmbeddingDownload={noOp}
        mateGrowthSettings={nextMateGrowthSettings}
        mateGrowthFeedback=""
        mateGrowthBusy={false}
        onReloadMateGrowthEvents={noOp}
        onUpdateMateGrowthSettings={noOp}
        onSaveSettings={noOp}
      />,
    );

    assert.ok(html.includes(`<strong>${SETTINGS_PROVIDER_INSTRUCTION_SECTION_LABEL}</strong>`));
    assert.ok(html.includes(`<span>${SETTINGS_PROVIDER_INSTRUCTION_ROOT_DIRECTORY_LABEL}</span>`));
    assert.ok(html.includes(`<span>${SETTINGS_PROVIDER_INSTRUCTION_RELATIVE_PATH_LABEL}</span>`));
    assert.ok(html.includes(`value=\"/repo-root\"`));
    assert.ok(html.includes("value=\"docs/instructions.md\""));
  });

  it("Provider Instruction Sync の同期状態 / 再起動 / エラープレビューが表示される", () => {
    const syncedAt = "2026-05-06T10:00:00.000Z";
    const customRows = buildHomeProviderSettingRows(modelCatalog, settingsDraft, [
      {
        providerId: "codex",
        targetId: "main",
        enabled: true,
        rootDirectory: "/repo-root",
        instructionRelativePath: "docs/instructions.md",
        writeMode: "managed_block",
        projectionScope: "mate_only",
        failPolicy: "warn_continue",
        requiresRestart: true,
        lastSyncState: "failed",
        lastSyncRunId: null,
        lastSyncedRevisionId: null,
        lastErrorPreview: "permission denied: EACCES (13): Permission denied",
        lastSyncedAt: syncedAt,
      },
    ]);

    const html = renderToStaticMarkup(
      <HomeSettingsContent
        settingsDraft={settingsDraft}
        providerSettingRows={customRows}
        modelCatalogRevisionLabel={String(modelCatalog.revision)}
        settingsDirty={false}
        settingsFeedback=""
        memoryManagementSnapshot={null}
        memoryManagementPages={{
          session: { nextCursor: null, hasMore: false, total: 0 },
          project: { nextCursor: null, hasMore: false, total: 0 },
          character: { nextCursor: null, hasMore: false, total: 0 },
          mate_profile: { nextCursor: null, hasMore: false, total: 0 },
        }}
        memoryManagementLoading={false}
        memoryManagementBusyTarget={null}
        memoryManagementFeedback=""
        mateEmbeddingSettings={null}
        mateEmbeddingFeedback=""
        mateEmbeddingBusy={false}
        mateGrowthEvents={[]}
        mateGrowthEventsLoading={false}
        mateGrowthEventsFeedback=""
        onChangeSystemPromptPrefix={noOp}
        onChangeMemoryGenerationEnabled={noOp}
        onChangeMateMemoryGenerationPriorityProvider={noOp}
        onChangeMateMemoryGenerationPriorityModel={noOp}
        onChangeMateMemoryGenerationPriorityReasoningEffort={noOp}
        onChangeMateMemoryGenerationPriorityTimeoutSeconds={noOp}
        onChangeMateMemoryGenerationTriggerIntervalMinutes={noOp}
        onChangeAutoCollapseActionDockOnSend={noOp}
        onChangeProviderEnabled={noOp}
        onChangeProviderInstructionEnabled={noOp}
        onChangeProviderInstructionWriteMode={noOp}
        onChangeProviderInstructionFailPolicy={noOp}
        onChangeProviderInstructionRootDirectory={noOp}
        onChangeProviderInstructionInstructionRelativePath={noOp}
        onChangeProviderSkillRootPath={noOp}
        onBrowseProviderSkillRootPath={noOp}
        onChangeMemoryExtractionModel={noOp}
        onChangeMemoryExtractionReasoningEffort={noOp}
        onChangeMemoryExtractionThreshold={noOp}
        onChangeMemoryExtractionTimeoutSeconds={noOp}
        onChangeCharacterReflectionModel={noOp}
        onChangeCharacterReflectionReasoningEffort={noOp}
        onChangeCharacterReflectionTimeoutSeconds={noOp}
        onChangeCharacterReflectionCooldownSeconds={noOp}
        onChangeCharacterReflectionCharDeltaThreshold={noOp}
        onChangeCharacterReflectionMessageDeltaThreshold={noOp}
        onImportModelCatalog={noOp}
        onExportModelCatalog={noOp}
        onOpenAppLogFolder={noOp}
        onOpenCrashDumpFolder={noOp}
        onReloadMemoryManagement={noOp}
        onChangeMemoryManagementViewFilters={noOp}
        onLoadMoreMemoryManagement={noOp}
        onDeleteSessionMemory={noOp}
        onDeleteProjectMemoryEntry={noOp}
        onDeleteCharacterMemoryEntry={noOp}
        onDeleteMateProfileItem={noOp}
        onStartMateEmbeddingDownload={noOp}
        mateGrowthSettings={nextMateGrowthSettings}
        mateGrowthFeedback=""
        mateGrowthBusy={false}
        onReloadMateGrowthEvents={noOp}
        onUpdateMateGrowthSettings={noOp}
        onSaveSettings={noOp}
      />,
    );

    assert.ok(html.includes("<dt>同期状態</dt>"));
    assert.ok(html.includes("<dd>失敗</dd>"));
    assert.ok(html.includes("<dt>最終同期</dt>"));
    assert.ok(html.includes(`<dd>${formatTimestampLabel(syncedAt)}</dd>`));
    assert.ok(html.includes("<p class=\"settings-feedback settings-memory-feedback\">再起動が必要</p>"));
    assert.ok(html.includes("<span>エラープレビュー</span>"));
    assert.ok(html.includes("permission denied: EACCES (13): Permission denied"));
  });
});

describe("HomeMateSetupPanel", () => {
  const collectElements = (node: ReactNode, predicate: (element: React.ReactElement) => boolean): React.ReactElement[] => {
    const result: React.ReactElement[] = [];
    const visitNode = (currentNode: ReactNode) => {
      if (!isValidElement(currentNode)) {
        return;
      }

      if (predicate(currentNode)) {
        result.push(currentNode);
      }

      const children = currentNode.props.children;
      if (Array.isArray(children)) {
        children.forEach((child) => visitNode(child as ReactNode));
        return;
      }

      if (children === null || children === undefined || typeof children === "boolean") {
        return;
      }

      visitNode(children as ReactNode);
    };

    visitNode(node);
    return result;
  };

  const renderPanel = (params?: {
    mode?: "create" | "edit";
    creating?: boolean;
    feedback?: string;
    displayName?: string;
    mateDisplayName?: string | null;
    onSubmit?: () => void;
    onCancel?: () => void;
    onOpenSettings?: () => void;
  }) => {
    return HomeMateSetupPanel({
      mode: params?.mode,
      displayName: params?.displayName ?? "Your Mate",
      creating: params?.creating ?? false,
      feedback: params?.feedback ?? "",
      mateDisplayName: params?.mateDisplayName ?? null,
      onChangeDisplayName: () => undefined,
      onSubmit: params?.onSubmit ?? (() => undefined),
      onCancel: params?.onCancel,
      onOpenSettings: params?.onOpenSettings ?? (() => undefined),
    });
  };

  it("表示名 input / Mate 作成ボタン / 設定ボタン / feedback が render される", () => {
    const panel = renderPanel({ feedback: "作成完了まで少し待ってね。" });
    const html = renderToStaticMarkup(panel);
    const input = collectElements(panel, (element) => element.type === "input" && element.props.id === "mate-display-name")[0];
    const submitButton = collectElements(panel, (element) => element.type === "button" && element.props.type === "submit")[0];
    const settingsButton = collectElements(
      panel,
      (element) => element.type === "button" && typeof element.props.children === "string" && element.props.children === "設定",
    )[0];

    assert.ok(input);
    assert.ok(submitButton);
    assert.ok(settingsButton);
    assert.ok(input.props.value === "Your Mate");
    assert.ok(submitButton.props.children === "Mate を作成");
    assert.ok(html.includes("作成完了まで少し待ってね。"));
  });

  it("form submit で onSubmit が呼ばれる", () => {
    let submitted = 0;
    const panel = renderPanel({
      onSubmit: () => {
        submitted += 1;
      },
    });
    const forms = collectElements(panel, (element) => element.type === "form");
    const form = forms[0];
    if (!form) {
      throw new Error("HomeMateSetupPanel の form が見つかりません。");
    }

    form.props.onSubmit({ preventDefault: () => undefined });

    assert.equal(submitted, 1);
  });

  it("設定ボタンで onOpenSettings が呼ばれる", () => {
    let settingsOpened = 0;
    const panel = renderPanel({
      onOpenSettings: () => {
        settingsOpened += 1;
      },
    });
    const buttons = collectElements(
      panel,
      (element) => element.type === "button" && typeof element.props.children === "string" && element.props.children === "設定",
    );
    const settingsButton = buttons.find((button) => button.props.type === "button" && button.props.onClick);
    if (!settingsButton) {
      throw new Error("HomeMateSetupPanel の設定ボタンが見つかりません。");
    }

    settingsButton.props.onClick();
    assert.equal(settingsOpened, 1);
  });

  it("creating=true で input / submit button が disabled になり、作成中表示になる", () => {
    const panel = renderPanel({ creating: true, feedback: "作成中..." });
    const input = collectElements(panel, (element) => element.type === "input" && element.props.id === "mate-display-name")[0];
    const submitButton = collectElements(panel, (element) => element.type === "button" && element.props.type === "submit")[0];
    if (!input || !submitButton) {
      throw new Error("HomeMateSetupPanel の入力 or submit button が見つかりません。");
    }

    assert.ok(input.props.disabled);
    assert.ok(submitButton.props.disabled);
    assert.equal(submitButton.props.children, "作成中...");
  });

  it("edit mode では Mate プロフィール保存と戻る導線を表示する", () => {
    let canceled = 0;
    const panel = renderPanel({
      mode: "edit",
      displayName: "Mika",
      mateDisplayName: "Mika",
      onCancel: () => {
        canceled += 1;
      },
    });
    const html = renderToStaticMarkup(panel);
    const submitButton = collectElements(panel, (element) => element.type === "button" && element.props.type === "submit")[0];
    const cancelButton = collectElements(
      panel,
      (element) => element.type === "button" && typeof element.props.children === "string" && element.props.children === "戻る",
    )[0];

    assert.ok(html.includes("Mate プロフィール"));
    assert.equal(submitButton?.props.children, "Mate を保存");
    assert.ok(cancelButton);
    cancelButton.props.onClick();
    assert.equal(canceled, 1);
  });
});

describe("HomeLaunchDialog", () => {
  const noOp = (..._args: unknown[]) => undefined;

  const renderHomeLaunchDialog = (mode: "session" | "companion") => renderToStaticMarkup(
    <HomeLaunchDialog
      open={true}
      mode={mode}
      title="demo"
      workspace={null}
      launchWorkspacePathLabel="workspace"
      enabledLaunchProviders={[{ id: "codex", label: "Codex" }]}
      selectedLaunchProviderId="codex"
      canStartSession={true}
      launchFeedback=""
      launchStarting={false}
      onClose={noOp}
      onSelectMode={noOp}
      onChangeTitle={noOp}
      onBrowseWorkspace={noOp}
      onSelectProvider={noOp}
      onStartSession={noOp}
    />,
  );

  it("session mode でダイアログにキャラ選択 UI が含まれない", () => {
    const html = renderHomeLaunchDialog("session");

    assert.ok(!html.includes("launch-search-row"));
    assert.ok(!html.includes("キャラクターを選ぶ"));
    assert.ok(!html.includes("キャラを選んでね"));
    assert.ok(!html.includes("Add Character"));
  });

  it("companion mode でもダイアログにキャラ選択 UI が含まれない", () => {
    const html = renderHomeLaunchDialog("companion");

    assert.ok(!html.includes("launch-search-row"));
    assert.ok(!html.includes("キャラクターを選ぶ"));
    assert.ok(!html.includes("キャラを選んでね"));
    assert.ok(!html.includes("Add Character"));
  });
});

describe("HomeRecentSessionsPanel", () => {
  const noOp = (..._args: unknown[]) => undefined;

  const renderHomeRecentSessions = (canUsePrimaryFeatures = true) => renderToStaticMarkup(
    <HomeRecentSessionsPanel
      filteredSessionEntries={[]}
      companionSessions={[]}
      normalizedSessionSearch=""
      searchText=""
      searchIcon={<span />}
      onChangeSearchText={noOp}
      onOpenLaunchDialog={noOp}
      onOpenSession={noOp}
      onOpenCompanionReview={noOp}
      canUsePrimaryFeatures={canUsePrimaryFeatures}
    />,
  );

  it("canUsePrimaryFeatures false の時は New Session が無効化される", () => {
    const html = renderHomeRecentSessions(false);
    const disabledButtons = html.match(/<button class="start-session-button"[^>]*disabled=""/g);
    assert.ok(disabledButtons && disabledButtons.length >= 2);
  });
});

describe("HomeRightPane", () => {
  const noOp = (..._args: unknown[]) => undefined;

  const renderHomeRightPane = (rightPaneView: "monitor" | "mate", mateProfile: null | {
    id: string;
    state: "draft" | "active" | "deleted";
    displayName: string;
    description: string;
    themeMain: string;
    themeSub: string;
    avatarFilePath: string;
    avatarSha256: string;
    avatarByteSize: number;
    activeRevisionId: string | null;
    profileGeneration: number;
    createdAt: string;
    updatedAt: string;
    deletedAt: string | null;
    sections: {
      sectionKey: "core" | "bond" | "work_style" | "notes";
      filePath: string;
      sha256: string;
      byteSize: number;
      updatedByRevisionId: string;
    }[];
    },
    canUsePrimaryFeatures = true,
  ) => renderToStaticMarkup(
    <HomeRightPane
      rightPaneView={rightPaneView}
      runningMonitorEntries={[]}
      nonRunningMonitorEntries={[]}
      monitorRunningEmptyMessage="running"
      monitorCompletedEmptyMessage="completed"
      mateProfile={mateProfile}
      monitorWindowIcon={<span>Monitor</span>}
      onChangeRightPaneView={noOp}
      onOpenSessionMonitorWindow={noOp}
      onOpenMemoryManagementWindow={noOp}
      onOpenSettingsWindow={noOp}
      onOpenMateProfile={noOp}
      onOpenMateTalk={noOp}
      onOpenSession={noOp}
      onOpenCompanionReview={noOp}
      canUsePrimaryFeatures={canUsePrimaryFeatures}
    />,
  );

  it("Your Mate タブは character list ではなく Your Mate を表示し Characters / Add Character を含まない", () => {
    const html = renderHomeRightPane("mate", {
      id: "mate-1",
      state: "active",
      displayName: "Your Mate",
      description: "説明文",
      themeMain: "#3b82f6",
      themeSub: "#1d4ed8",
      avatarFilePath: "",
      avatarSha256: "",
      avatarByteSize: 0,
      activeRevisionId: null,
      profileGeneration: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      deletedAt: null,
      sections: [],
    });

    assert.ok(html.includes("Your Mate"));
    assert.ok(html.includes("説明文"));
    assert.ok(!html.includes("Characters"));
    assert.ok(!html.includes("Add Character"));
    assert.ok(html.includes("メイトーク"));
    assert.ok(html.includes("Mate を編集"));
  });

  it("mateProfile が null でも fallback で Mate 表示できる", () => {
    const html = renderHomeRightPane("mate", null);
    assert.ok(html.includes("Your Mate"));
    assert.ok(html.includes("Mate の説明は未設定だよ。"));
  });

  it("active mateProfile で avatar 未設定のとき fallback がレンダリングされ、画像タグは出力されない", () => {
    const html = renderHomeRightPane("mate", {
      id: "mate-2",
      state: "active",
      displayName: "テストマテ",
      description: "説明文",
      themeMain: "#10b981",
      themeSub: "#047857",
      avatarFilePath: "",
      avatarSha256: "",
      avatarByteSize: 0,
      activeRevisionId: null,
      profileGeneration: 2,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      deletedAt: null,
      sections: [],
    });

    assert.ok(html.includes('<span class="avatar-fallback">テ</span>'));
    assert.ok(!html.includes("<img"));
  });

  it("canUsePrimaryFeatures false の時は主要アクションを無効化する", () => {
    const html = renderHomeRightPane("monitor", null, false);
    assert.match(html, /<button class="launch-toggle home-monitor-window-button"[^>]*disabled=""/);
    assert.match(html, /<button class="launch-toggle home-settings-button"[^>]*aria-disabled="true"[^>]*disabled=""/);
  });
});
