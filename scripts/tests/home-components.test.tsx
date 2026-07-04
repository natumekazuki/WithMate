import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { JSDOM } from "jsdom";
import React, { act, isValidElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import { HomeLaunchDialog } from "../../src/home/HomeLaunchDialog.js";
import { HomeMonitorContent } from "../../src/home/HomeMonitorContent.js";
import { HomeRecentSessionsPanel } from "../../src/home/HomeRecentSessionsPanel.js";
import { HomeRightPane } from "../../src/home/HomeRightPane.js";
import type { HomeMonitorEntry } from "../../src/home/home-session-projection.js";
import type { SessionSummary } from "../../src/session-state.js";
import type { CompanionSessionSummary } from "../../src/companion-state.js";
import { HomeMateSetupPanel } from "../../src/mate/MateSetupPanel.js";
import { HomeSettingsContent } from "../../src/settings/SettingsContent.js";
import { createDefaultAppSettings } from "../../src/provider-settings-state.js";
import type { ModelCatalogSnapshot } from "../../src/model-catalog.js";
import type { MemoryV6Diagnostics } from "../../src/memory-v6/memory-diagnostics-state.js";
import { WITHMATE_MEMORY_PROVIDER_INSTRUCTION_SAMPLE } from "../../src/memory-v6/provider-instruction-sample.js";
import { buildHomeProviderSettingRows } from "../../src/settings/settings-view-model.js";
import { formatTimestampLabel } from "../../src/time-state.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
    providerSettingRows?: typeof providerSettingRows;
    providerCatalogLoaded?: boolean;
    memoryV6Diagnostics?: MemoryV6Diagnostics | null;
    onCopyMemoryProviderInstructionSample?: () => void;
  };

  const buildSettingsContent = (params?: RenderSettingsParams) => HomeSettingsContent({
    settingsDraft: params?.settingsDraft ?? settingsDraft,
    providerSettingRows: params?.providerSettingRows ?? providerSettingRows,
    providerCatalogLoaded: params?.providerCatalogLoaded ?? true,
    modelCatalogRevisionLabel: String(modelCatalog.revision),
    memoryV6Diagnostics: params?.memoryV6Diagnostics ?? null,
    settingsDirty: false,
    settingsFeedback: "",
    sessionCleanupCutoffDate: "",
    deletingOldSessions: false,
    onChangeAutoCollapseActionDockOnSend: noOp,
    onChangeLaunchAtLoginEnabled: noOp,
    onChangeSessionCleanupCutoffDate: noOp,
    onChangeUserMicrocopySlot: noOp,
    onChangeProviderEnabled: noOp,
    onChangeProviderSkillRootPath: noOp,
    onChangeProviderSkillRelativePath: noOp,
    onChangeProviderInstructionRelativePath: noOp,
    onBrowseProviderSkillRootPath: noOp,
    onBrowseProviderSkillRelativePath: noOp,
    onBrowseProviderInstructionRelativePath: noOp,
    onImportModelCatalog: noOp,
    onExportModelCatalog: noOp,
    onOpenAppLogFolder: noOp,
    onOpenCrashDumpFolder: noOp,
    onOpenMemoryV6Review: noOp,
    onInstallMemoryV6CliShim: noOp,
    onUninstallMemoryV6CliShim: noOp,
    onCopyMemoryProviderInstructionSample: params?.onCopyMemoryProviderInstructionSample ?? noOp,
    onDeleteSessionsLastActiveBefore: noOp,
    onSaveSettings: noOp,
  });

  const renderSettings = (params?: RenderSettingsParams) => renderToStaticMarkup(buildSettingsContent(params));

  it("Mate Reset の危険操作は Settings に表示されない", () => {
    const html = renderSettings();
    assert.ok(!html.includes("Mate を初期化"));
    assert.ok(!html.includes("保存済みの Mate の状態を破壊的に初期化する"));
  });

  it("削除対象の Settings surface は表示しない", () => {
    const html = renderSettings();

    assert.ok(!html.includes("Provider Instruction Sync"));
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

  it("provider ごとの file settings を表示する", () => {
    const html = renderSettings();

    assert.ok(html.includes("Provider File Settings"));
    assert.ok(html.includes("Root Directory"));
    assert.ok(html.includes("Skill Relative Path"));
    assert.ok(html.includes("Instruction Relative Path"));
  });

  it("古い Session の削除操作を Settings に表示する", () => {
    const html = renderSettings();

    assert.match(html, /古い Session を削除/);
    assert.match(html, /指定日より前に最後に使われた Session を削除する/);
  });

  it("Memory V6 diagnostics はredacted summaryとして表示する", () => {
    const html = renderSettings({
      memoryV6Diagnostics: {
        generatedAt: "2026-06-27T00:00:00.000Z",
        runtime: {
          status: "running",
          baseUrl: "http://127.0.0.1:12345",
          dbPath: "C:/userdata/withmate-v6.db",
          discoveryFilePath: "C:/runtime/memory-v6-api.json",
          hasApiSecret: true,
        },
        providers: [
          { providerId: "codex", providerSupported: true },
          { providerId: "custom", providerSupported: false },
        ],
        skillSync: [
          { providerId: "codex", skillRootConfigured: true, skillPath: "C:/skills/withmate-memory", status: "unchanged" },
          { providerId: "custom", skillRootConfigured: true, skillPath: null, status: "skipped-collision" },
        ],
        cliShim: {
          platform: "darwin",
          commandName: "withmate-memory",
          supported: true,
          status: "installed",
          shimDirectory: "/Users/test/.local/bin",
          shimPath: "/Users/test/.local/bin/withmate-memory",
          pathContainsShimDirectory: true,
          message: "withmate-memory is available from the configured shim directory.",
        },
        lastErrors: [
          { kind: "memory-v6.runtime-api.start-failed", message: "startup failed", occurredAt: "2026-06-27T00:00:00.000Z" },
        ],
      },
    });

    assert.ok(html.includes("Memory API"));
    assert.ok(html.includes("running"));
    assert.ok(!html.includes("Active Bindings"));
    assert.ok(!html.includes("codex: env / custom: unsupported"));
    assert.ok(html.includes("codex: unchanged / custom: skipped-collision"));
    assert.ok(html.includes("CLI Shim"));
    assert.ok(html.includes("PATH ready"));
    assert.ok(html.includes("memory-v6.runtime-api.start-failed"));
    assert.ok(html.includes("Provider Instruction Sample"));
    assert.ok(html.includes("Copy Sample"));
    assert.ok(html.includes("WithMate Memory Usage"));
    assert.ok(html.includes("Do not read or write WithMate database files directly."));
    assert.ok(!html.includes("apiSecret"));
    assert.ok(!html.includes("bindingReference"));
    assert.ok(!WITHMATE_MEMORY_PROVIDER_INSTRUCTION_SAMPLE.includes("WITHMATE_MEMORY_BINDING_REFERENCE"));
    assert.ok(!WITHMATE_MEMORY_PROVIDER_INSTRUCTION_SAMPLE.includes("WITHMATE_MEMORY_API_SECRET"));
    assert.doesNotMatch(WITHMATE_MEMORY_PROVIDER_INSTRUCTION_SAMPLE, /binding reference/i);
    assert.doesNotMatch(WITHMATE_MEMORY_PROVIDER_INSTRUCTION_SAMPLE, /api secret/i);
    assert.doesNotMatch(WITHMATE_MEMORY_PROVIDER_INSTRUCTION_SAMPLE, /discovery file path/i);
    assert.doesNotMatch(WITHMATE_MEMORY_PROVIDER_INSTRUCTION_SAMPLE, /internal header/i);
    assert.doesNotMatch(WITHMATE_MEMORY_PROVIDER_INSTRUCTION_SAMPLE, /local runtime identifier/i);
  });

  it("Provider Instruction Sample の copy button は handler を呼ぶ", async () => {
    const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>");
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    const previousHTMLElement = globalThis.HTMLElement;

    Object.defineProperty(globalThis, "window", { value: dom.window, configurable: true });
    Object.defineProperty(globalThis, "document", { value: dom.window.document, configurable: true });
    Object.defineProperty(globalThis, "HTMLElement", { value: dom.window.HTMLElement, configurable: true });

    const rootElement = dom.window.document.getElementById("root");
    assert.ok(rootElement);
    let root: Root | null = null;
    let copyCount = 0;

    try {
      await act(async () => {
        root = createRoot(rootElement);
        root.render(buildSettingsContent({
          onCopyMemoryProviderInstructionSample: () => {
            copyCount += 1;
          },
          memoryV6Diagnostics: {
            generatedAt: "2026-06-27T00:00:00.000Z",
            runtime: {
              status: "running",
              baseUrl: "http://127.0.0.1:12345",
              dbPath: "C:/userdata/withmate-v6.db",
              discoveryFilePath: "C:/runtime/memory-v6-api.json",
              hasApiSecret: true,
            },
            binding: { activeBindingCount: 0 },
            providers: [],
            skillSync: [],
            cliShim: {
              platform: "win32",
              commandName: "withmate-memory",
              supported: false,
              status: "managed-by-installer",
              shimDirectory: null,
              shimPath: null,
              pathContainsShimDirectory: true,
              message: "Windows installer manages the withmate-memory command alias.",
            },
            lastErrors: [],
          },
        }));
      });

      const copyButton = Array.from(rootElement.querySelectorAll("button")).find((button) =>
        button.textContent?.trim() === "Copy Sample"
      );
      assert.ok(copyButton);

      await act(async () => {
        copyButton.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
      });

      assert.equal(copyCount, 1);
    } finally {
      await act(async () => {
        root?.unmount();
      });
      Object.defineProperty(globalThis, "window", { value: previousWindow, configurable: true });
      Object.defineProperty(globalThis, "document", { value: previousDocument, configurable: true });
      Object.defineProperty(globalThis, "HTMLElement", { value: previousHTMLElement, configurable: true });
    }
  });

  it("provider row が 0 件でも Coding Agent Providers section と empty state を表示する", () => {
    const html = renderSettings({ providerSettingRows: [] });

    assert.ok(html.includes("Coding Agent Providers"));
    assert.ok(html.includes("model catalog に coding provider がありません。"));
  });

  it("provider catalog 読み込み前は catalog unavailable empty state を表示する", () => {
    const html = renderSettings({ providerSettingRows: [], providerCatalogLoaded: false });

    assert.ok(html.includes("Coding Agent Providers"));
    assert.ok(html.includes("model catalog を読み込めないため"));
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
    mode?: "create" | "edit" | "unavailable";
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

  it("unavailable mode では Mate 作成/保存ボタンを表示しない", () => {
    const panel = renderPanel({
      mode: "unavailable",
      displayName: "",
      feedback: "ignored",
    });
    const html = renderToStaticMarkup(panel);
    const input = collectElements(panel, (element) => element.type === "input" && element.props.id === "mate-display-name")[0];
    const submitButton = collectElements(panel, (element) => element.type === "button" && element.props.type === "submit")[0];

    assert.ok(html.includes("V6 Memory foundation では Mate Profile はまだ利用できません。"));
    assert.equal(input?.props.disabled, true);
    assert.equal(submitButton, undefined);
    assert.equal(html.includes("Mate を作成"), false);
    assert.equal(html.includes("Mate を保存"), false);
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
  const createSessionSummary = (partial: Partial<SessionSummary> & Pick<SessionSummary, "id" | "taskTitle">): SessionSummary => ({
    status: "idle",
    updatedAt: "2026-06-17T00:00:00.000Z",
    provider: "codex",
    catalogRevision: 1,
    workspaceLabel: "workspace",
    workspacePath: "C:/workspace",
    branch: "main",
    sessionKind: "default",
    accessMode: "active",
    sourceSchemaVersion: 5,
    characterId: "char-1",
    character: "Mia",
    characterIconPath: "",
    characterThemeColors: { main: "#223344", sub: "#88bbcc" },
    runState: "idle",
    approvalMode: "untrusted",
    codexSandboxMode: "danger-full-access",
    model: "gpt-5.4",
    reasoningEffort: "high",
    customAgentName: "",
    allowedAdditionalDirectories: [],
    threadId: "",
    ...partial,
  });
  const createCompanionSummary = (
    partial: Partial<CompanionSessionSummary> & Pick<CompanionSessionSummary, "id" | "taskTitle">,
  ): CompanionSessionSummary => ({
    status: "active",
    updatedAt: "2026-06-17T00:00:00.000Z",
    groupId: "group-1",
    repoRoot: "C:/workspace/repo",
    focusPath: "",
    targetBranch: "main",
    baseSnapshotRef: "refs/withmate/base/1",
    baseSnapshotCommit: "base-1",
    selectedPaths: [],
    changedFiles: [],
    siblingWarnings: [],
    allowedAdditionalDirectories: [],
    runState: "idle",
    threadId: "",
    provider: "codex",
    model: "gpt-5.4",
    reasoningEffort: "high",
    approvalMode: "untrusted",
    codexSandboxMode: "danger-full-access",
    character: "Mia",
    characterRoleMarkdown: "",
    characterIconPath: "",
    characterThemeColors: { main: "#223344", sub: "#88bbcc" },
    latestMergeRun: null,
    ...partial,
  });

  const renderHomeRecentSessions = ({
    canUsePrimaryFeatures = true,
    filteredSessionEntries = [],
    companionSessions = [],
    normalizedSessionSearch = "",
    searchText = "",
  }: {
    canUsePrimaryFeatures?: boolean;
    filteredSessionEntries?: React.ComponentProps<typeof HomeRecentSessionsPanel>["filteredSessionEntries"];
    companionSessions?: CompanionSessionSummary[];
    normalizedSessionSearch?: string;
    searchText?: string;
  } = {}) => renderToStaticMarkup(
    <HomeRecentSessionsPanel
      filteredSessionEntries={filteredSessionEntries}
      companionSessions={companionSessions}
      normalizedSessionSearch={normalizedSessionSearch}
      searchText={searchText}
      searchIcon={<span />}
      onChangeSearchText={noOp}
      onOpenLaunchDialog={noOp}
      onOpenSession={noOp}
      onOpenCompanionReview={noOp}
      canUsePrimaryFeatures={canUsePrimaryFeatures}
    />,
  );

  it("canUsePrimaryFeatures false の時は New Session が無効化される", () => {
    const html = renderHomeRecentSessions({ canUsePrimaryFeatures: false });
    const disabledButtons = html.match(/<button class="start-session-button"[^>]*disabled=""/g);
    assert.equal(disabledButtons?.length, 1);
  });

  it("セッションが空でも New Session は常設ボタンだけ表示される", () => {
    const html = renderHomeRecentSessions();
    const newSessionButtons = html.match(/<button class="start-session-button"/g);
    assert.equal(newSessionButtons?.length, 1);
  });

  it("character authoring session は Character badge で表示する", () => {
    const html = renderHomeRecentSessions({
      filteredSessionEntries: [
        {
          kind: "agent",
          session: createSessionSummary({
            id: "authoring",
            taskTitle: "Mia の character.md 改善",
            sessionKind: "character-authoring",
          }),
          state: { kind: "neutral", label: "idle" },
        },
      ],
    });

    assert.ok(html.includes("Mia の character.md 改善"));
    assert.ok(html.includes("session-mode-badge character"));
    assert.ok(html.includes(">Character<"));
  });

  it("companion kind label で Companion session を検索できる", () => {
    const html = renderHomeRecentSessions({
      companionSessions: [
        createCompanionSummary({ id: "companion-1", taskTitle: "Review task" }),
      ],
      normalizedSessionSearch: "companion",
      searchText: "companion",
    });

    assert.ok(html.includes("Review task"));
    assert.ok(html.includes(">Companion<"));
  });

  it("履歴カードに Mate アイコンを表示し、V4 以前の Agent session は閲覧専用として開ける", () => {
    const html = renderHomeRecentSessions({
      filteredSessionEntries: [
        {
          kind: "agent",
          session: createSessionSummary({
            id: "session-v4",
            taskTitle: "Legacy task",
            sourceSchemaVersion: 4,
            character: "Solo Mate",
            characterIconPath: "mate.png",
          }),
          state: { kind: "neutral", label: "idle" },
        },
      ],
      companionSessions: [
        createCompanionSummary({
          id: "companion-1",
          taskTitle: "Companion task",
          character: "Solo Mate",
          characterIconPath: "mate.png",
        }),
      ],
    });

    assert.equal((html.match(/character-avatar tiny home-session-card-avatar/g) ?? []).length, 2);
    assert.ok(html.includes("mate.png"));
    assert.ok(html.includes("閲覧専用"));
    assert.ok(!html.includes("disabled=\"\""));
  });
});

describe("HomeMonitorContent", () => {
  const noOp = (..._args: unknown[]) => undefined;

  it("Monitor カードはキャラアイコン付きでセッション情報を表示する", () => {
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
        kind: "agent",
        session: {
          id: "session-2",
          taskTitle: "Auxiliary task",
          workspaceLabel: "workspace",
          workspacePath: "C:/workspace",
          character: "Solo Mate",
          characterIconPath: "mate.png",
        },
        activeAuxiliarySession: {
          id: "aux-1",
          parentSessionId: "session-2",
          status: "active",
          runState: "running",
          title: "Auxiliary",
          provider: "codex",
          catalogRevision: 1,
          model: "gpt-5.4",
          reasoningEffort: "high",
          approvalMode: "untrusted",
          codexSandboxMode: "danger-full-access",
          customAgentName: "",
          allowedAdditionalDirectories: [],
          threadId: "",
          displayAfterMessageIndex: null,
          createdAt: "2026-03-28T00:00:00.000Z",
          updatedAt: "2026-03-30T00:00:00.000Z",
          closedAt: "",
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
      {
        kind: "companion",
        session: {
          id: "companion-2",
          groupId: "group-1",
          taskTitle: "Companion Auxiliary task",
          character: "Solo Mate",
          characterIconPath: "mate.png",
        },
        activeAuxiliarySession: {
          id: "aux-companion",
          parentSessionId: "companion-2",
          status: "active",
          runState: "running",
          title: "Auxiliary",
          provider: "codex",
          catalogRevision: 1,
          model: "gpt-5.4",
          reasoningEffort: "high",
          approvalMode: "untrusted",
          codexSandboxMode: "danger-full-access",
          customAgentName: "",
          allowedAdditionalDirectories: [],
          threadId: "",
          displayAfterMessageIndex: null,
          createdAt: "2026-03-28T00:00:00.000Z",
          updatedAt: "2026-03-30T00:00:00.000Z",
          closedAt: "",
        },
        state: { kind: "running", label: "実行中" },
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
    assert.ok(html.includes("Auxiliary task"));
    assert.ok(html.includes("workspace"));
    assert.ok(html.includes("Companion task"));
    assert.ok(html.includes("Companion Auxiliary task"));
    assert.ok(html.includes("demo"));
    assert.ok(html.includes(">Agent</span>"));
    assert.equal(html.match(/>Auxiliary<\/span>/g)?.length, 2);
    assert.ok(html.includes(">Companion</span>"));
    assert.equal(html.match(/class="session-status home-monitor-status running"/g)?.length, 3);
    assert.equal(html.match(/class="session-status home-monitor-status neutral"/g)?.length, 1);
    assert.equal(html.match(/>実行中<\/span>/g)?.length, 3);
    assert.ok(html.includes(">待機</span>"));
    assert.equal(html.match(/character-avatar tiny home-monitor-avatar/g)?.length, 4);
    assert.equal(html.match(/<img src="file:\/\/\/mate.png"/g)?.length, 4);
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
