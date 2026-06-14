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
import { formatTimestampLabel } from "../../src/time-state.js";
import {
  SETTINGS_MATE_RESET_HELP,
  SETTINGS_MATE_RESET_LABEL,
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

  type RenderSettingsParams = {
    settingsDraft?: typeof settingsDraft;
    canResetMate?: boolean;
    mateResetBusy?: boolean;
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
    settingsDraft: params?.settingsDraft ?? settingsDraft,
    providerSettingRows,
    modelCatalogRevisionLabel: String(modelCatalog.revision),
    settingsDirty: false,
    settingsFeedback: "",
    onChangeAutoCollapseActionDockOnSend: noOp,
    onChangeUserMicrocopySlot: noOp,
    onChangeProviderEnabled: noOp,
    onImportModelCatalog: noOp,
    onExportModelCatalog: noOp,
    onOpenAppLogFolder: noOp,
    onOpenCrashDumpFolder: noOp,
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

  it("Mate Reset のラベルとヘルプが表示される", () => {
    const html = renderSettings();
    assert.ok(html.includes(`<strong>${SETTINGS_MATE_RESET_LABEL}</strong>`));
    assert.ok(html.includes(`<p class="settings-help">${SETTINGS_MATE_RESET_HELP}</p>`));
  });

  it("削除対象の Settings surface は表示しない", () => {
    const html = renderSettings();

    assert.ok(!html.includes("Provider Instruction Sync"));
    assert.ok(!html.includes("Root Directory"));
    assert.ok(!html.includes("Instruction Relative Path"));
    assert.ok(!html.includes("Write Mode"));
    assert.ok(!html.includes("Fail Policy"));
    assert.ok(!html.includes("Mate Embedding"));
    assert.ok(!html.includes("Mate Memory Generation"));
    assert.ok(!html.includes("Mate Growth を手動適用"));
    assert.ok(!html.includes("Mate Growth Settings"));
    assert.ok(!html.includes("最近の Growth Event"));
    assert.ok(!html.includes("settings-character-section"));
    assert.ok(!html.includes("Save Character"));
    assert.ok(!html.includes("character-notes.md"));
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

  const characterOptions = [{
    id: "mia",
    name: "Mia",
    description: "Default character",
    iconFilePath: "",
    theme: { main: "#111111", sub: "#eeeeee" },
    state: "active" as const,
    isDefault: true,
    createdAt: "",
    updatedAt: "",
    archivedAt: null,
  }];

  const renderHomeLaunchDialog = (
    mode: "session" | "companion",
    options = characterOptions,
    charactersLoaded = true,
  ) => renderToStaticMarkup(
    <HomeLaunchDialog
      open={true}
      mode={mode}
      title="demo"
      workspace={null}
      launchWorkspacePathLabel="workspace"
      enabledLaunchProviders={[{ id: "codex", label: "Codex" }]}
      selectedLaunchProviderId="codex"
      characterOptions={options}
      selectedCharacterId={options[0]?.id ?? null}
      charactersLoaded={charactersLoaded}
      canStartSession={true}
      launchFeedback=""
      launchStarting={false}
      onClose={noOp}
      onSelectMode={noOp}
      onChangeTitle={noOp}
      onBrowseWorkspace={noOp}
      onSelectProvider={noOp}
      onSelectCharacter={noOp}
      onStartSession={noOp}
    />,
  );

  it("session mode でダイアログに Character selector が含まれる", () => {
    const html = renderHomeLaunchDialog("session");

    assert.ok(html.includes("Character"));
    assert.ok(html.includes("Mia"));
    assert.ok(html.includes("Default"));
    assert.ok(html.includes("Default character"));
  });

  it("companion mode でも Character selector が含まれる", () => {
    const html = renderHomeLaunchDialog("companion");

    assert.ok(html.includes("Character"));
    assert.ok(html.includes("Mia"));
  });

  it("Character 0 件なら neutral fallback を表示する", () => {
    const html = renderHomeLaunchDialog("session", []);

    assert.ok(html.includes("WithMate"));
    assert.ok(html.includes("Neutral"));
  });

  it("Character catalog 読み込み前は neutral fallback を表示しない", () => {
    const html = renderHomeLaunchDialog("session", [], false);

    assert.ok(html.includes("読み込み中"));
    assert.ok(html.includes("Character を読み込んでるよ..."));
    assert.ok(!html.includes("Neutral"));
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

  const renderHomeRightPane = (rightPaneView: "monitor" | "characters", characters = [{
    id: "char-1",
    name: "Mia",
    description: "説明文",
    iconFilePath: "",
    theme: { main: "#3b82f6", sub: "#1d4ed8" },
    state: "active" as const,
    isDefault: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archivedAt: null,
  }],
    canUsePrimaryFeatures = true,
    characterListFeedback = "",
  ) => renderToStaticMarkup(
    <HomeRightPane
      rightPaneView={rightPaneView}
      runningMonitorEntries={[]}
      nonRunningMonitorEntries={[]}
      characterEntries={characters}
      characterListFeedback={characterListFeedback}
      monitorWindowIcon={<span>Monitor</span>}
      onChangeRightPaneView={noOp}
      onOpenSessionMonitorWindow={noOp}
      onOpenSettingsWindow={noOp}
      onCreateCharacter={noOp}
      onEditCharacter={noOp}
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

  it("Characters タブは character list と Create を表示する", () => {
    const html = renderHomeRightPane("characters");

    assert.ok(html.includes("Characters"));
    assert.ok(html.includes("Mia"));
    assert.ok(html.includes("説明文"));
    assert.ok(html.includes("Create"));
    assert.ok(html.includes("Edit"));
    assert.ok(html.includes("Default"));
    assert.ok(!html.includes("Your Mate"));
    assert.ok(!html.includes("メイトーク"));
  });

  it("Character が空でも Create Character を表示できる", () => {
    const html = renderHomeRightPane("characters", []);
    assert.ok(html.includes("Character はまだありません。"));
    assert.ok(html.includes("Create Character"));
  });

  it("Characters panel は一覧読み込み error を panel 内に表示する", () => {
    const html = renderHomeRightPane("characters", [], true, "Character 一覧の再読み込みに失敗したよ。");

    assert.ok(html.includes("Character 一覧の再読み込みに失敗したよ。"));
    assert.ok(html.includes("Create Character"));
  });

  it("メイトークは Home right pane のタブにも起動ボタンにも表示しない", () => {
    const monitorHtml = renderHomeRightPane("monitor");
    const characterHtml = renderHomeRightPane("characters");
    const tablistMatch = monitorHtml.match(/<div class="home-pane-toggle" role="tablist" aria-label="Home right pane">[\s\S]*?<\/div>/);

    assert.ok(tablistMatch);
    assert.ok(tablistMatch[0].includes("Monitor"));
    assert.ok(tablistMatch[0].includes("Characters"));
    assert.ok(!tablistMatch[0].includes("Your Mate"));
    assert.ok(!tablistMatch[0].includes("メイトーク"));
    assert.doesNotMatch(monitorHtml, /<button class="launch-toggle home-settings-button"[^>]*>メイトーク<\/button>/);
    assert.doesNotMatch(characterHtml, /<button class="launch-toggle home-settings-button"[^>]*>メイトーク<\/button>/);
    assertNoMateTalkChatSurface(monitorHtml);
    assertNoMateTalkChatSurface(characterHtml);
  });

  it("Character icon 未設定のとき fallback がレンダリングされ、画像タグは出力されない", () => {
    const html = renderHomeRightPane("characters", [{
      id: "char-2",
      name: "テストマテ",
      description: "説明文",
      iconFilePath: "",
      theme: { main: "#10b981", sub: "#047857" },
      state: "active",
      isDefault: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      archivedAt: null,
    }]);

    assert.ok(html.includes('<span class="avatar-fallback">テ</span>'));
    assert.ok(!html.includes("<img"));
  });

  it("canUsePrimaryFeatures false の時は主要アクションを無効化する", () => {
    const html = renderHomeRightPane("monitor", undefined, false);
    assert.match(html, /<button class="launch-toggle home-monitor-window-button"[^>]*disabled=""/);
  });
});
