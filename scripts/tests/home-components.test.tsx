import assert from "node:assert/strict";
import { describe, it } from "node:test";
import React, { isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { HomeLaunchDialog } from "../../src/home/HomeLaunchDialog.js";
import { HomeMonitorContent } from "../../src/home/HomeMonitorContent.js";
import { HomeRecentSessionsPanel } from "../../src/home/HomeRecentSessionsPanel.js";
import { HomeRightPane } from "../../src/home/HomeRightPane.js";
import type { HomeMonitorEntry } from "../../src/home/home-session-projection.js";
import { HomeMateSetupPanel } from "../../src/mate/MateSetupPanel.js";
import { HomeSettingsContent } from "../../src/settings/SettingsContent.js";
import { createDefaultAppSettings } from "../../src/provider-settings-state.js";
import type { ModelCatalogSnapshot } from "../../src/model-catalog.js";
import { buildHomeProviderSettingRows } from "../../src/settings/settings-view-model.js";
import { DEFAULT_MATE_GROWTH_APPLY_INTERVAL_MINUTES, type MateGrowthSettings } from "../../src/mate/mate-state.js";
import type { MateGrowthEventListItem } from "../../src/mate/mate-growth-events-state.js";
import type { MateEmbeddingSettings } from "../../src/mate/mate-embedding-settings.js";
import { formatTimestampLabel } from "../../src/time-state.js";
import {
  SETTINGS_MATE_GROWTH_APPLY_INTERVAL_MINUTES_LABEL,
  SETTINGS_MATE_GROWTH_AUTO_APPLY_ENABLED_LABEL,
  SETTINGS_MATE_GROWTH_EVERY_TURN_LABEL,
  SETTINGS_MATE_GROWTH_ENABLED_LABEL,
  SETTINGS_MATE_GROWTH_MEMORY_CANDIDATE_MODE_LABEL,
  SETTINGS_MATE_GROWTH_MODEL_PREFERENCE_DEPTH_LABEL,
  SETTINGS_MATE_GROWTH_MODEL_PREFERENCE_ENABLED_LABEL,
  SETTINGS_MATE_GROWTH_MODEL_PREFERENCE_MODEL_LABEL,
  SETTINGS_MATE_GROWTH_MODEL_PREFERENCE_PROVIDER_LABEL,
  SETTINGS_MATE_GROWTH_MODEL_PREFERENCES_LABEL,
  SETTINGS_MATE_GROWTH_SETTINGS_LABEL,
  SETTINGS_MATE_EMBEDDING_LABEL,
  SETTINGS_MATE_RESET_HELP,
  SETTINGS_MATE_RESET_LABEL,
  SETTINGS_MATE_GROWTH_HELP,
  SETTINGS_MATE_GROWTH_LABEL,
  SETTINGS_MATE_MEMORY_GENERATION_LABEL,
  SETTINGS_MATE_MEMORY_GENERATION_TRIGGER_INTERVAL_LABEL,
  SETTINGS_MATE_MEMORY_GENERATION_MODEL_LABEL,
  SETTINGS_MATE_MEMORY_GENERATION_PRIORITY_ADD_LABEL,
  SETTINGS_MATE_MEMORY_GENERATION_PRIORITY_REMOVE_LABEL,
  SETTINGS_MATE_MEMORY_GENERATION_REASONING_LABEL,
  SETTINGS_MATE_MEMORY_GENERATION_TIMEOUT_LABEL,
  SETTINGS_PROVIDER_INSTRUCTION_FAIL_POLICY_LABEL,
  SETTINGS_PROVIDER_INSTRUCTION_SECTION_LABEL,
  SETTINGS_PROVIDER_INSTRUCTION_WRITE_MODE_LABEL,
  SETTINGS_PROVIDER_INSTRUCTION_ROOT_DIRECTORY_LABEL,
  SETTINGS_PROVIDER_SKILL_RELATIVE_PATH_LABEL,
  SETTINGS_PROVIDER_INSTRUCTION_RELATIVE_PATH_LABEL,
} from "../../src/settings/settings-ui.js";

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
      {
        id: "copilot",
        label: "Copilot",
        defaultModelId: "model-b",
        defaultReasoningEffort: "medium",
        models: [
          { id: "model-b", label: "Model B", reasoningEfforts: ["medium", "high"] },
          { id: "model-c", label: "Model C", reasoningEfforts: ["low"] },
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
        depth: "medium",
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
    settingsDraft?: typeof settingsDraft;
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
    mateEmbeddingSettings?: MateEmbeddingSettings | null;
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
    onAddMateMemoryGenerationPriority?: () => void;
    onBrowseProviderInstructionInstructionRelativePath?: (providerId: string) => void;
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
    settingsDraft: params?.settingsDraft ?? settingsDraft,
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
    mateEmbeddingSettings: params && "mateEmbeddingSettings" in params ? params.mateEmbeddingSettings ?? null : null,
    mateEmbeddingFeedback: "",
    mateEmbeddingBusy: false,
    onChangeMemoryGenerationEnabled: noOp,
    onChangeMateMemoryGenerationPriorityProvider: noOp,
    onChangeMateMemoryGenerationPriorityModel: noOp,
    onChangeMateMemoryGenerationPriorityReasoningEffort: noOp,
    onChangeMateMemoryGenerationPriorityTimeoutSeconds: noOp,
    onAddMateMemoryGenerationPriority: params?.onAddMateMemoryGenerationPriority ?? noOp,
    onRemoveMateMemoryGenerationPriority: noOp,
    onChangeMateMemoryGenerationTriggerIntervalMinutes: noOp,
    onChangeAutoCollapseActionDockOnSend: noOp,
    onChangeUserMicrocopySlot: noOp,
    onChangeProviderEnabled: noOp,
    onChangeProviderInstructionEnabled: noOp,
    onChangeProviderInstructionWriteMode: noOp,
    onChangeProviderInstructionFailPolicy: noOp,
    onChangeProviderInstructionInstructionRelativePath: noOp,
    onBrowseProviderInstructionInstructionRelativePath: params?.onBrowseProviderInstructionInstructionRelativePath ?? noOp,
    onChangeProviderSkillRootPath: noOp,
    onBrowseProviderSkillRootPath: noOp,
    onChangeProviderSkillRelativePath: noOp,
    onBrowseProviderSkillRelativePath: noOp,
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

  const getMateMemoryGenerationAddButton = (content: React.ReactNode) => collectElementsById(
    content,
    (element) => element.type === "button" && element.props.id === "mate-memory-generation-priority-add",
  )[0];

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
      modelPreferenceProvider: byId("mate-growth-model-preference-provider", "select")[0],
      modelPreferenceModel: byId("mate-growth-model-preference-model", "select")[0],
      modelPreferenceDepth: byId("mate-growth-model-preference-depth", "select")[0],
      modelPreferenceEnabled: byId("mate-growth-model-preference-enabled", "input")[0],
    };
  };

  it("Mate Memory Generation のセクションが表示される", () => {
    const html = renderSettings();

    assert.ok(html.includes(`<strong>${SETTINGS_MATE_MEMORY_GENERATION_LABEL}</strong>`));
    assert.ok(html.includes('<span class="settings-provider-name">Priority 1</span>'));
    assert.ok(html.includes(`>${SETTINGS_MATE_MEMORY_GENERATION_PRIORITY_ADD_LABEL}</button>`));
    assert.ok(html.includes(`>${SETTINGS_MATE_MEMORY_GENERATION_PRIORITY_REMOVE_LABEL}</button>`));
    assert.ok(html.includes(`<span>${SETTINGS_MATE_MEMORY_GENERATION_MODEL_LABEL}</span>`));
    assert.ok(html.includes(`<span>${SETTINGS_MATE_MEMORY_GENERATION_REASONING_LABEL}</span>`));
    assert.ok(html.includes(`<span>${SETTINGS_MATE_MEMORY_GENERATION_TIMEOUT_LABEL}</span>`));
    assert.ok(html.includes(`<span>${SETTINGS_MATE_MEMORY_GENERATION_TRIGGER_INTERVAL_LABEL}</span>`));
  });

  it("Mate Memory Generation の Add で onAdd callback が呼ばれる", () => {
    let added = 0;
    const content = buildSettingsContent({
      onAddMateMemoryGenerationPriority: () => {
        added += 1;
      },
    });
    const addButton = getMateMemoryGenerationAddButton(content);
    if (!addButton) {
      throw new Error("Mate Memory Generation の Add ボタンが見つからない。");
    }

    addButton.props.onClick();
    assert.equal(added, 1);
  });

  it("Priority 2 以上の設定を持つと Priority 2 が表示される", () => {
    const twoPrioritySettings = {
      ...settingsDraft,
      mateMemoryGenerationSettings: {
        ...settingsDraft.mateMemoryGenerationSettings,
        priorityList: [
          ...settingsDraft.mateMemoryGenerationSettings.priorityList,
          {
            provider: "codex",
            model: "gpt-5.4-mini",
            reasoningEffort: "low",
            timeoutSeconds: 60,
          },
        ],
      },
    };

    const html = renderSettings({ settingsDraft: twoPrioritySettings });

    assert.ok(html.includes(`<span class="settings-provider-name">Priority 1</span>`));
    assert.ok(html.includes(`<span class="settings-provider-name">Priority 2</span>`));
  });

  it("Mate Reset のラベルとヘルプが表示される", () => {
    const html = renderSettings();
    assert.ok(html.includes(`<strong>${SETTINGS_MATE_RESET_LABEL}</strong>`));
    assert.ok(html.includes(`<p class="settings-help">${SETTINGS_MATE_RESET_HELP}</p>`));
  });

  it("削除対象の Settings surface は表示しない", () => {
    const html = renderSettings({
      applyPendingGrowth: true,
      canApplyPendingGrowth: true,
      mateGrowthSettings: nextMateGrowthSettings,
      mateEmbeddingSettings: {
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
      },
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

    assert.ok(!html.includes(SETTINGS_PROVIDER_INSTRUCTION_SECTION_LABEL));
    assert.ok(!html.includes(SETTINGS_PROVIDER_INSTRUCTION_ROOT_DIRECTORY_LABEL));
    assert.ok(!html.includes(SETTINGS_PROVIDER_INSTRUCTION_RELATIVE_PATH_LABEL));
    assert.ok(!html.includes(SETTINGS_MATE_EMBEDDING_LABEL));
    assert.ok(!html.includes(SETTINGS_MATE_GROWTH_LABEL));
    assert.ok(!html.includes(SETTINGS_MATE_GROWTH_SETTINGS_LABEL));
    assert.ok(!html.includes("最近の Growth Event"));
    assert.ok(!html.includes("hidden-cache-path-marker"));
    assert.ok(!html.includes("一人称は「私」を優先する"));
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
    mateAvatarFilePath?: string | null;
    avatarUpdating?: boolean;
    onSubmit?: () => void;
    onCancel?: () => void;
    onOpenSettings?: () => void;
    onSelectAvatar?: () => void;
    onClearAvatar?: () => void;
  }) => {
    return HomeMateSetupPanel({
      mode: params?.mode,
      displayName: params?.displayName ?? "Your Mate",
      creating: params?.creating ?? false,
      avatarUpdating: params?.avatarUpdating,
      feedback: params?.feedback ?? "",
      mateDisplayName: params?.mateDisplayName ?? null,
      mateAvatarFilePath: params?.mateAvatarFilePath,
      onChangeDisplayName: () => undefined,
      onSubmit: params?.onSubmit ?? (() => undefined),
      onCancel: params?.onCancel,
      onOpenSettings: params?.onOpenSettings ?? (() => undefined),
      onSelectAvatar: params?.onSelectAvatar,
      onClearAvatar: params?.onClearAvatar,
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

  it("edit mode では Mate アイコンの選択と解除を実行できる", () => {
    let selected = 0;
    let cleared = 0;
    const panel = renderPanel({
      mode: "edit",
      displayName: "Mika",
      mateDisplayName: "Mika",
      mateAvatarFilePath: "C:/mate/avatar.png",
      onSelectAvatar: () => {
        selected += 1;
      },
      onClearAvatar: () => {
        cleared += 1;
      },
    });
    const html = renderToStaticMarkup(panel);
    const selectButton = collectElements(
      panel,
      (element) => element.type === "button" && typeof element.props.children === "string" && element.props.children === "画像を選択",
    )[0];
    const clearButton = collectElements(
      panel,
      (element) => element.type === "button" && typeof element.props.children === "string" && element.props.children === "解除",
    )[0];

    assert.ok(html.includes("アイコン"));
    assert.ok(html.includes("画像を選択できます。"));
    assert.ok(selectButton);
    assert.ok(clearButton);
    selectButton.props.onClick();
    clearButton.props.onClick();
    assert.equal(selected, 1);
    assert.equal(cleared, 1);
  });

  it("create mode では Mate アイコンの補足説明と編集操作を表示しない", () => {
    const panel = renderPanel({ mode: "create" });
    const html = renderToStaticMarkup(panel);
    const avatarButtons = collectElements(
      panel,
      (element) => element.type === "button" && ["画像を選択", "解除"].includes(String(element.props.children)),
    );

    assert.ok(html.includes("アイコン"));
    assert.ok(!html.includes("Mate 作成後に設定できます。"));
    assert.equal(avatarButtons.length, 0);
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
    assert.equal(disabledButtons?.length, 1);
  });

  it("セッションが空でも New Session は常設ボタンだけ表示される", () => {
    const html = renderHomeRecentSessions();
    const newSessionButtons = html.match(/<button class="start-session-button"/g);
    assert.equal(newSessionButtons?.length, 1);
  });
});

describe("HomeMonitorContent", () => {
  const noOp = (..._args: unknown[]) => undefined;

  it("Monitor カードは Mate アイコン画像なしでセッション情報を表示する", () => {
    const entries: HomeMonitorEntry[] = [
      {
        kind: "agent",
        session: {
          id: "session-1",
          taskTitle: "Agent task",
          workspaceLabel: "workspace",
          workspacePath: "C:/workspace",
          character: "Solo Mate",
          characterIconPath: "mate.png",
        },
        state: { kind: "running", label: "実行中" },
      } as HomeMonitorEntry,
      {
        kind: "companion",
        session: {
          id: "companion-1",
          groupId: "group-1",
          taskTitle: "Companion task",
          character: "Solo Mate",
          characterIconPath: "mate.png",
        },
        state: { kind: "neutral", label: "待機" },
        groupLabel: "demo",
      } as HomeMonitorEntry,
    ];
    const html = renderToStaticMarkup(
      <HomeMonitorContent
        runningEntries={entries}
        nonRunningEntries={[]}
        onOpenSession={noOp}
        onOpenCompanionReview={noOp}
      />,
    );

    assert.ok(html.includes("Agent task"));
    assert.ok(html.includes("workspace"));
    assert.ok(html.includes("Companion task"));
    assert.ok(html.includes("demo"));
    assert.ok(!html.includes("character-avatar"));
    assert.ok(!html.includes("<img"));
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
      mateProfile={mateProfile}
      monitorWindowIcon={<span>Monitor</span>}
      onChangeRightPaneView={noOp}
      onOpenSessionMonitorWindow={noOp}
      onOpenSettingsWindow={noOp}
      onOpenMateProfile={noOp}
      onOpenSession={noOp}
      onOpenCompanionReview={noOp}
      canUsePrimaryFeatures={canUsePrimaryFeatures}
    />,
  );

  const assertNoMateTalkChatSurface = (html: string) => {
    assert.ok(!html.includes('data-session-mode="mate-talk"'));
    assert.ok(!html.includes("session-content-grid"));
    assert.ok(!html.includes("session-work-surface"));
    assert.ok(!html.includes("session-main-grid"));
    assert.ok(!html.includes("session-message-stack"));
    assert.ok(!html.includes("session-action-dock"));
    assert.ok(!html.includes('class="composer"'));
    assert.ok(!html.includes("<textarea"));
    assert.ok(!html.includes("今日はどうする？"));
    assert.ok(!html.includes("session-message-empty"));
    assert.ok(!html.includes("session-context-pane"));
    assert.ok(!html.includes('aria-label="補助情報"'));
  };

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
    assert.ok(!html.includes("メイトーク"));
    assert.ok(html.includes("Mate を編集"));
  });

  it("mateProfile が null でも fallback で Mate 表示できる", () => {
    const html = renderHomeRightPane("mate", null);
    assert.ok(html.includes("Your Mate"));
    assert.ok(!html.includes("Mate の説明は未設定だよ。"));
  });

  it("メイトークは Home right pane のタブにも起動ボタンにも表示しない", () => {
    const monitorHtml = renderHomeRightPane("monitor", null);
    const mateHtml = renderHomeRightPane("mate", null);
    const tablistMatch = monitorHtml.match(/<div class="home-pane-toggle" role="tablist" aria-label="Home right pane">[\s\S]*?<\/div>/);

    assert.ok(tablistMatch);
    assert.ok(tablistMatch[0].includes("Monitor"));
    assert.ok(tablistMatch[0].includes("Your Mate"));
    assert.ok(!tablistMatch[0].includes("メイトーク"));
    assert.doesNotMatch(monitorHtml, /<button class="launch-toggle home-settings-button"[^>]*>メイトーク<\/button>/);
    assert.doesNotMatch(mateHtml, /<button class="launch-toggle home-settings-button"[^>]*>メイトーク<\/button>/);
    assertNoMateTalkChatSurface(monitorHtml);
    assertNoMateTalkChatSurface(mateHtml);
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
  });
});
