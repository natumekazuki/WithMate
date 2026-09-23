import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { JSDOM } from "jsdom";
import React, { act, isValidElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import { HomeLaunchDialog } from "../../src/home/HomeLaunchDialog.js";
import type { HomeLaunchWorkspaceValidationState } from "../../src/home/home-launch-state.js";
import type { ProviderLaunchLoadStatus } from "../../src/launch/provider-launch-picker.js";
import { filterCharactersByName } from "../../src/home/HomeCharactersPanel.js";
import { HomeMonitorContent } from "../../src/home/HomeMonitorContent.js";
import { formatHomeSessionUpdatedAt, HomeRecentSessionsPanel } from "../../src/home/HomeRecentSessionsPanel.js";
import { HomeRightPane } from "../../src/home/HomeRightPane.js";
import type { AuxiliarySessionSummary } from "../../src-shared/auxiliary/auxiliary-session-state.js";
import type { HomeMonitorEntry } from "../../src/home/home-session-projection.js";
import type { HomeSessionSummary, SessionSummary } from "../../src-shared/session/session-state.js";
import { HomeMateSetupPanel } from "../../src/mate/MateSetupPanel.js";
import { HomeSettingsContent } from "../../src/settings/SettingsContent.js";
import { createDefaultAppSettings } from "../../src-shared/settings/provider-settings-state.js";
import type { ModelCatalogSnapshot } from "../../src-shared/settings/model-catalog.js";
import type { MemoryV6Diagnostics } from "../../src-shared/memory/memory-diagnostics-state.js";
import { buildHomeProviderSettingRows } from "../../src/settings/settings-view-model.js";
import { formatTimestampLabel } from "../../src-shared/time-state.js";

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
    settingsFeedback?: string;
    memoryV6Diagnostics?: MemoryV6Diagnostics | null;
  };

  const buildSettingsContent = (params?: RenderSettingsParams) => (
    <HomeSettingsContent
      settingsDraft={params?.settingsDraft ?? settingsDraft}
      providerSettingRows={params?.providerSettingRows ?? providerSettingRows}
      modelCatalogRevisionLabel={String(modelCatalog.revision)}
      memoryV6Diagnostics={params?.memoryV6Diagnostics ?? null}
      settingsDirty={false}
      settingsFeedback={params?.settingsFeedback ?? ""}
      sessionCleanupCutoffDate=""
      deletingOldSessions={false}
      onChangeAutoCollapseActionDockOnSend={noOp}
      onChangeCharacterDefinitionEnabled={noOp}
      onChangeCharacterAffectContextEnabled={noOp}
      onChangeConversationTimingEnabled={noOp}
      onChangeScrollToLatestOnSend={noOp}
      onChangeLaunchAtLoginEnabled={noOp}
      onChangeSessionTurnNotificationEnabled={noOp}
      onChangeSessionTurnNotificationResponsePreviewEnabled={noOp}
      onChangeToolCallPresenceEnabled={noOp}
      onChangeKeyboardShortcuts={noOp}
      onChangeMemoryFileQuotaMegabytes={noOp}
      onChangeGlossaryProactiveCreateLimit={noOp}
      onChangeSessionCleanupCutoffDate={noOp}
      onChangeProviderEnabled={noOp}
      onChangeProviderSkillRootPath={noOp}
      onChangeProviderSkillRelativePath={noOp}
      onChangeProviderInstructionRelativePath={noOp}
      onBrowseProviderSkillRootPath={noOp}
      onBrowseProviderSkillRelativePath={noOp}
      onBrowseProviderInstructionRelativePath={noOp}
      onImportModelCatalog={noOp}
      onExportModelCatalog={noOp}
      onOpenAppLogFolder={noOp}
      onOpenCrashDumpFolder={noOp}
      onOpenMemoryV6Review={noOp}
      onInstallMemoryV6CliShim={noOp}
      onUninstallMemoryV6CliShim={noOp}
      onDeleteSessionsLastActiveBefore={noOp}
      onSaveSettings={noOp}
    />
  );

  const renderSettings = (params?: RenderSettingsParams) => renderToStaticMarkup(buildSettingsContent(params));

  // @test-value v2
  // kind = "contract"
  // claim = "App SettingsはWindows通知、response preview、action dock、latest messageの4つの表示設定名をTitle Caseで表示する"
  // oracle = { type = "contract", ref = "docs/design/settings-ui.md#layout" }
  // fault = "4つの表示設定のいずれかを欠落させるか、別の設定面やTitle Caseでないlabelを表示する"
  // observable = "HomeSettingsContentのstatic markupにある4つのlabel"
  // observation_boundary = "component-behavior"
  // scope = "home-settings-app-display-options"
  // lifecycle = "permanent"
  // @end-test-value
  it("App settings にTitle Case labelの表示設定toggleを表示する", () => {
    const html = renderSettings();

    assert.ok(html.includes("Session Turn Notification"));
    assert.ok(html.includes("Notification Response Preview"));
    assert.ok(html.includes("Close Action Dock After Send"));
    assert.ok(html.includes("Scroll To Latest On Send"));
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "Settings はPrompt ContextのTitle Case labelを個別 checkbox として表示し、既定値を checked にする"
  // oracle = { type = "contract", ref = "docs/design/settings-ui.md#layout and #current-scope" }
  // fault = "Prompt Context labelの表示、checkbox、または既定状態が契約と一致しない"
  // observable = "HomeSettingsContent の static markup にあるTitle Case label と checkbox state"
  // observation_boundary = "component-behavior"
  // scope = "home-settings-prompt-context-ui"
  // lifecycle = "permanent"
  // impact = "ユーザーが4つの foreground prompt context の設定面を見つけられないか、既定状態を判断できない"
  // distinction = "個別 state/action の保存handlerは draft test に分け、static DOMではsection labelと既定stateだけを確認する"
  // @end-test-value
  it("Prompt Context に4項目の個別 toggle を既定有効で表示する", () => {
    const html = renderSettings();
    const document = new JSDOM(html).window.document;
    const promptContextSection = Array.from(document.querySelectorAll("section.settings-section-card"))
      .find((section) => section.querySelector("strong")?.textContent === "Prompt Context");

    assert.ok(promptContextSection);
    assert.equal(promptContextSection.querySelector("strong")?.textContent, "Prompt Context");

    const promptContextLabels = [
      "Character Definition Snapshot",
      "Character Affect Context",
      "Conversation Timing",
      "Tool Call Presence",
    ];
    const promptContextRows = Array.from(promptContextSection.querySelectorAll(".settings-provider-toggle-row"));
    assert.equal(promptContextRows.length, promptContextLabels.length);
    assert.deepEqual(
      promptContextRows.map((row) => row.querySelector<HTMLLabelElement>("label.settings-provider-name")?.textContent),
      promptContextLabels,
    );

    for (const row of promptContextRows) {
      const label = row.querySelector<HTMLLabelElement>("label.settings-provider-name");
      const input = row.querySelector<HTMLInputElement>('input[type="checkbox"]');

      assert.ok(label);
      assert.ok(input);
      assert.equal(input.checked, true);
      assert.equal(label.htmlFor, input.id);
    }
    assert.equal(promptContextSection.querySelectorAll('input[type="checkbox"]').length, promptContextLabels.length);
    assert.equal(promptContextSection.querySelectorAll('input[type="checkbox"]:checked').length, promptContextLabels.length);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "Repository glossaryのproactive create limitは0から100のnumber inputとexplicit requestには影響しないhelpを表示する"
  // oracle = { type = "contract", ref = "docs/design/settings-ui.md#layout" }
  // fault = "limitの入力範囲または0の意味を表示せず、明示依頼まで無効になると誤認させる"
  // observable = "input type/min/max/valueとhelp text"
  // observation_boundary = "component-behavior"
  // scope = "home-settings-glossary-limit"
  // lifecycle = "permanent"
  // @end-test-value
  it("Repository Glossaryにproactive create上限を0から100のnumber inputで表示する", () => {
    const document = new JSDOM(renderSettings()).window.document;
    const label = Array.from(document.querySelectorAll("label"))
      .find((candidate) => candidate.textContent?.includes("Glossary Proactive Create Limit"));
    const input = label?.querySelector("input");

    assert.equal(input?.type, "number");
    assert.equal(input?.min, "0");
    assert.equal(input?.max, "100");
    assert.equal(input?.value, "5");
    assert.ok(label?.textContent?.includes("explicit requests"));
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "response preview checkboxはWindows通知が無効な間だけdisabledで、設定値のchecked stateは保持する"
  // oracle = { type = "contract", ref = "docs/design/settings-ui.md#layout" }
  // fault = "通知が無効でもpreviewを編集できるか、disabled化の際に保存値をfalseへ書き換える"
  // observable = "notification enabled/disabled両条件のpreview input disabledとchecked"
  // observation_boundary = "component-behavior"
  // scope = "home-settings-notification-preview-dependency"
  // lifecycle = "permanent"
  // @end-test-value
  it("返答 preview toggle は Session turn notification が無効な間だけ操作できない", () => {
    const disabledHtml = renderSettings({
      settingsDraft: {
        ...settingsDraft,
        sessionTurnNotificationEnabled: false,
        sessionTurnNotificationResponsePreviewEnabled: true,
      },
    });
    const enabledHtml = renderSettings({
      settingsDraft: {
        ...settingsDraft,
        sessionTurnNotificationEnabled: true,
        sessionTurnNotificationResponsePreviewEnabled: true,
      },
    });
    const findPreviewToggle = (html: string) => {
      const document = new JSDOM(html).window.document;
      const label = Array.from(document.querySelectorAll("label"))
        .find((candidate) => candidate.textContent?.includes("Notification Response Preview"));
      return label?.querySelector("input");
    };

    assert.equal(findPreviewToggle(disabledHtml)?.disabled, true);
    assert.equal(findPreviewToggle(disabledHtml)?.checked, true);
    assert.equal(findPreviewToggle(enabledHtml)?.disabled, false);
    assert.equal(findPreviewToggle(enabledHtml)?.checked, true);
  });

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

  // @test-value v2
  // kind = "contract"
  // claim = "各coding providerはTitle CaseのProvider File Settingsとしてroot、skill relative、instruction relativeの3項目を表示する"
  // oracle = { type = "contract", ref = "docs/design/settings-ui.md#layout" }
  // fault = "provider fileの基準rootまたはrelative path設定を欠落させ、pickerの対象境界を利用者に示さない"
  // observable = "provider settings sectionと3つのTitle Case label"
  // observation_boundary = "component-behavior"
  // scope = "home-settings-provider-file-settings"
  // lifecycle = "permanent"
  // @end-test-value
  it("provider ごとの file settings を表示する", () => {
    const html = renderSettings();

    assert.ok(html.includes("Provider File Settings"));
    assert.ok(html.includes("Root Directory"));
    assert.ok(html.includes("Skill Relative Path"));
    assert.ok(html.includes("Instruction Relative Path"));
  });

  // @test-value v2
  // kind = "security"
  // claim = "Storage maintenanceはDelete Old Sessionsと選択日より前を対象にするhelpを表示する"
  // oracle = { type = "contract", ref = "docs/design/settings-ui.md#current-scope" }
  // fault = "削除対象の日付境界を説明せず、任意のSessionまたは実行中Sessionを削除する操作と誤認させる"
  // observable = "delete labelとcleanup date help"
  // observation_boundary = "component-behavior"
  // scope = "home-settings-session-cleanup"
  // lifecycle = "permanent"
  // @end-test-value
  it("古い Session の削除操作を Settings に表示する", () => {
    const html = renderSettings();

    assert.match(html, /Delete Old Sessions/);
    assert.match(html, /Delete sessions last active before the selected date/);
  });

  // @test-value v2
  // kind = "security"
  // claim = "Memory diagnosticsはruntime、CLI shim、Last errorだけを表示し、managed Skill、provider instruction、secret、pathを表示しない"
  // oracle = { type = "contract", ref = "docs/design/settings-ui.md#current-scope" }
  // fault = "廃止済みのMemory Skill同期状態やprovider instruction copy導線、credential、個人pathをSettingsへ公開する"
  // observable = "diagnosticsのsafe status/codeと禁止された表示内容の不在"
  // observation_boundary = "public-boundary"
  // scope = "memory-runtime-diagnostics-projection"
  // lifecycle = "permanent"
  // @end-test-value
  it("Memory V6 diagnostics はinstance metadataだけのredacted summaryとして表示する", () => {
    const html = renderSettings({
      memoryV6Diagnostics: {
        generatedAt: "2026-06-27T00:00:00.000Z",
        runtime: {
          status: "running",
          applicationInstanceId: "11111111-1111-4111-8111-111111111111",
          runtimeGenerationId: "22222222-2222-4222-8222-222222222222",
          buildChannel: "installed",
          discoveryPublished: true,
        },
        cliShim: {
          platform: "darwin",
          commandName: "withmate-memory",
          supported: true,
          status: "installed",
          pathContainsShimDirectory: true,
        },
        lastErrors: [
          { kind: "memory-v6.runtime-api.start-failed", occurredAt: "2026-06-27T00:00:00.000Z" },
        ],
      },
    });

    assert.ok(html.includes("Memory API"));
    assert.ok(html.includes("running"));
    assert.ok(!html.includes("Active Bindings"));
    assert.ok(!html.includes("codex: env / custom: unsupported"));
    assert.ok(!html.includes("Managed Skill"));
    assert.ok(html.includes("CLI Shim"));
    assert.ok(html.includes("PATH Ready"));
    assert.ok(html.includes("memory-v6.runtime-api.start-failed"));
    assert.ok(!html.includes("Provider Instruction Sample"));
    assert.ok(!html.includes("Copy Sample"));
    assert.ok(!html.includes("apiSecret"));
    assert.ok(!html.includes("bindingReference"));
    assert.ok(!html.includes("C:/"));
    assert.ok(!html.includes("/Users/"));
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "model catalogにcoding providerがない場合もCoding Agent Providers sectionを残し、正常な空本文は表示しない"
  // oracle = { type = "contract", ref = "docs/design/settings-ui.md#layout" }
  // fault = "provider row 0件をsectionごと隠すか、正常な空状態へ失敗文言を表示する"
  // observable = "Coding Agent Providers headingとprovider row 0件時の本文不在"
  // observation_boundary = "component-behavior"
  // scope = "home-settings-provider-empty-state"
  // lifecycle = "permanent"
  // @end-test-value
  it("provider row が 0 件でも Coding Agent Providers section を残し本文を空にする", () => {
    const html = renderSettings({ providerSettingRows: [] });

    assert.ok(html.includes("Coding Agent Providers"));
    assert.ok(!html.includes("No coding agent providers found in the model catalog."));
  });

  // @test-value v2
  // kind = "contract"
  // claim = "model catalog取得失敗はCoding Agent Providers section内へ重複表示せず、Settings footerのfeedbackへ1箇所で表示する"
  // oracle = { type = "contract", ref = "docs/design/settings-ui.md#layout" }
  // fault = "catalog取得失敗をprovider sectionとfooterへ重複表示するか、Settingsから失敗理由を隠す"
  // observable = "Coding Agent Providers heading、provider section内のerror不在、Settings footerのCould not load the model catalog."
  // observation_boundary = "component-behavior"
  // scope = "home-settings-provider-catalog-error-feedback"
  // lifecycle = "permanent"
  // @end-test-value
  it("provider catalog error は Settings footer に一度だけ表示する", () => {
    const html = renderSettings({
      providerSettingRows: [],
      settingsFeedback: "Could not load the model catalog.",
    });
    const document = new JSDOM(html).window.document;

    assert.ok(html.includes("Coding Agent Providers"));
    assert.equal(document.querySelectorAll(".settings-provider-card").length, 0);
    assert.equal(document.querySelectorAll(".settings-feedback").length, 1);
    assert.equal(document.querySelector(".settings-dialog-foot .settings-feedback")?.textContent, "Could not load the model catalog.");
  });
});

describe("HomeMateSetupPanel", () => {
  const collectElements = (node: ReactNode, predicate: (element: React.ReactElement<Record<string, unknown>>) => boolean): React.ReactElement<Record<string, unknown>>[] => {
    const result: React.ReactElement<Record<string, unknown>>[] = [];
    const visitNode = (currentNode: ReactNode) => {
      if (!isValidElement<Record<string, unknown>>(currentNode)) {
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

  // @test-value v2
  // kind = "contract"
  // claim = "Home Mate setup create modeはDisplay Name入力とCreate Mate、Settingsの操作を表示する"
  // oracle = { type = "contract", ref = "HomeMateSetupPanel create mode controls" }
  // fault = "作成画面の主要入力または作成・設定操作が欠落する"
  // observable = "rendered input and button labels"
  // observation_boundary = "component-behavior"
  // scope = "HomeMateSetupPanel create mode controls"
  // lifecycle = "permanent"
  // @end-test-value
  it("display name input / create button / settings button / feedback が render される", () => {
    const panel = renderPanel({ feedback: "作成完了まで少し待ってね。" });
    const html = renderToStaticMarkup(panel);
    const input = collectElements(panel, (element) => element.type === "input" && element.props.id === "mate-display-name")[0];
    const submitButton = collectElements(panel, (element) => element.type === "button" && element.props.type === "submit")[0];
    const settingsButton = collectElements(
      panel,
      (element) => element.type === "button" && typeof element.props.children === "string" && element.props.children === "Settings",
    )[0];

    assert.ok(input);
    assert.ok(submitButton);
    assert.ok(settingsButton);
    assert.ok(input.props.value === "Your Mate");
    assert.ok(submitButton.props.children === "Create Mate");
    assert.ok(html.includes("作成完了まで少し待ってね。"));
  });

  // @test-value v2
  // kind = "contract"
  // claim = "Home Mate setup formはsubmit操作をonSubmit callbackへ転送する"
  // oracle = { type = "contract", ref = "HomeMateSetupPanel submit contract" }
  // fault = "submitがpreventDefault後にcallbackへ到達しない"
  // observable = "submitted counter"
  // observation_boundary = "component-behavior"
  // scope = "HomeMateSetupPanel form submission"
  // lifecycle = "permanent"
  // @end-test-value
  it("form submit で onSubmit が呼ばれる", () => {
    let submitted = 0;
    const events: string[] = [];
    const panel = renderPanel({
      onSubmit: () => {
        events.push("submit");
        submitted += 1;
      },
    });
    const forms = collectElements(panel, (element) => element.type === "form");
    const form = forms[0];
    if (!form) {
      throw new Error("HomeMateSetupPanel の form が見つかりません。");
    }

    (form.props.onSubmit as (event: { preventDefault(): void }) => void)({
      preventDefault: () => events.push("preventDefault"),
    });

    assert.equal(submitted, 1);
    assert.deepEqual(events, ["preventDefault", "submit"]);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "Home Mate setup panelの設定buttonはonOpenSettingsへ遷移要求を渡す"
  // oracle = { type = "contract", ref = "HomeMateSetupPanel settings navigation contract" }
  // fault = "設定導線が表示されてもcallbackが呼ばれない"
  // observable = "settingsOpened counter"
  // observation_boundary = "component-behavior"
  // scope = "HomeMateSetupPanel settings button"
  // lifecycle = "permanent"
  // @end-test-value
  it("設定ボタンで onOpenSettings が呼ばれる", () => {
    let settingsOpened = 0;
    const panel = renderPanel({
      onOpenSettings: () => {
        settingsOpened += 1;
      },
    });
    const buttons = collectElements(
      panel,
      (element) => element.type === "button" && typeof element.props.children === "string" && element.props.children === "Settings",
    );
    const settingsButton = buttons.find((button) => button.props.type === "button" && button.props.onClick);
    if (!settingsButton) {
      throw new Error("HomeMateSetupPanel の設定ボタンが見つかりません。");
    }

    (settingsButton.props.onClick as () => void)();
    assert.equal(settingsOpened, 1);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "Home Mate setupの作成中は入力を無効化しsubmitボタンをspinner表示にする"
  // oracle = { type = "contract", ref = "HomeMateSetupPanel busy state" }
  // fault = "作成中に入力を変更できるか、busy状態がテキストだけでspinnerを表示しない"
  // observable = "input and submit disabled state plus spinner element"
  // observation_boundary = "component-behavior"
  // scope = "HomeMateSetupPanel creating state"
  // lifecycle = "permanent"
  // @end-test-value
  it("creating=true で input / submit button が disabled になり、spinner 表示になる", () => {
    const panel = renderPanel({ creating: true, feedback: "CreatingMate" });
    const input = collectElements(panel, (element) => element.type === "input" && element.props.id === "mate-display-name")[0];
    const submitButton = collectElements(panel, (element) => element.type === "button" && element.props.type === "submit")[0];
    if (!input || !submitButton) {
      throw new Error("HomeMateSetupPanel の入力 or submit button が見つかりません。");
    }

    assert.ok(input.props.disabled);
    assert.ok(submitButton.props.disabled);
    assert.equal(collectElements(panel, (element) => element.type === "span" && element.props.className === "home-mate-spinner").length, 1);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "Home Mate setup edit modeは保存と戻る導線を表示する"
  // oracle = { type = "contract", ref = "HomeMateSetupPanel edit mode contract" }
  // fault = "edit modeで保存または戻る操作が欠落する"
  // observable = "rendered labelsとcancel callback"
  // observation_boundary = "component-behavior"
  // scope = "HomeMateSetupPanel edit mode controls"
  // lifecycle = "permanent"
  // @end-test-value
  it("edit mode では MateProfile の保存とキャンセル導線を表示する", () => {
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
      (element) => element.type === "button" && typeof element.props.children === "string" && element.props.children === "Cancel",
    )[0];

    assert.ok(html.includes("Mate Profile"));
    assert.equal(submitButton?.props.children, "Save");
    assert.ok(cancelButton);
    (cancelButton.props.onClick as () => void)();
    assert.equal(canceled, 1);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "MateProfile unavailable modeは編集操作を無効化し利用不可状態を表示する"
  // oracle = { type = "contract", ref = "HomeMateSetupPanel unavailable mode" }
  // fault = "利用不可状態で作成・保存操作を許可するか、利用不可理由を表示しない"
  // observable = "disabled input, absent submit button, and unavailable feedback"
  // observation_boundary = "component-behavior"
  // scope = "HomeMateSetupPanel unavailable mode"
  // lifecycle = "permanent"
  // @end-test-value
  it("unavailable mode では Mate 作成/保存ボタンを表示しない", () => {
    const panel = renderPanel({
      mode: "unavailable",
      displayName: "",
      feedback: "ignored",
    });
    const html = renderToStaticMarkup(panel);
    const input = collectElements(panel, (element) => element.type === "input" && element.props.id === "mate-display-name")[0];
    const submitButton = collectElements(panel, (element) => element.type === "button" && element.props.type === "submit")[0];

    assert.ok(html.includes("Mate profile is unavailable."));
    assert.equal(input?.props.disabled, true);
    assert.equal(submitButton, undefined);
    assert.equal(html.includes("Create Mate"), false);
    assert.equal(html.includes("Save"), false);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "Home Mate setup edit modeはiconの選択と解除操作をcallbackへ渡す"
  // oracle = { type = "contract", ref = "HomeMateSetupPanel avatar controls contract" }
  // fault = "avatar選択または解除の操作がcallbackに届かない"
  // observable = "selected/cancelled counters"
  // observation_boundary = "component-behavior"
  // scope = "HomeMateSetupPanel avatar controls"
  // lifecycle = "permanent"
  // @end-test-value
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
      (element) => element.type === "button" && typeof element.props.children === "string" && element.props.children === "Select Image",
    )[0];
    const clearButton = collectElements(
      panel,
      (element) => element.type === "button" && typeof element.props.children === "string" && element.props.children === "Clear",
    )[0];

    assert.ok(html.includes("Avatar"));
    assert.ok(selectButton);
    assert.ok(clearButton);
    (selectButton.props.onClick as () => void)();
    (clearButton.props.onClick as () => void)();
    assert.equal(selected, 1);
    assert.equal(cleared, 1);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "Mate未作成のcreate modeではアバター変更操作を表示しない"
  // oracle = { type = "contract", ref = "HomeMateSetupPanel create mode avatar controls" }
  // fault = "Mate作成前に存在しないアバターを変更または解除する操作を提供する"
  // observable = "avatar action button count"
  // observation_boundary = "component-behavior"
  // scope = "HomeMateSetupPanel create mode avatar controls"
  // lifecycle = "permanent"
  // @end-test-value
  it("create mode では Mate アイコンの補足説明と編集操作を表示しない", () => {
    const panel = renderPanel({ mode: "create" });
    const html = renderToStaticMarkup(panel);
    const avatarButtons = collectElements(
      panel,
      (element) => element.type === "button" && ["Select Image", "Clear"].includes(String(element.props.children)),
    );

    assert.ok(html.includes("Avatar"));
    assert.equal(avatarButtons.length, 0);
  });
});

describe("HomeLaunchDialog", () => {
  const noOp = (..._args: unknown[]) => undefined;

  const characterOptions = [{
    id: "mia",
    name: "Mia",
    description: "Character description",
    iconFilePath: "",
    theme: { main: "#111111", sub: "#eeeeee" },
    state: "active" as const,
    createdAt: "",
    updatedAt: "",
    archivedAt: null,
  }];

  const renderHomeLaunchDialog = (
    options = characterOptions,
    charactersLoaded = true,
    randomCharacterSelected = false,
    workspaceValidation: HomeLaunchWorkspaceValidationState = "idle",
    characterLoadStatus?: "loading" | "loaded" | "error",
    providerLoadStatus?: ProviderLaunchLoadStatus,
    providerLoadError = "",
  ) => renderToStaticMarkup(
    <HomeLaunchDialog
      open={true}
      title="demo"
      sessionFolderSelected={false}
      workspacePathInput="C:\\work space\\"
      workspaceValidation={workspaceValidation}
      workspaceValidationMessage={workspaceValidation === "invalid" ? "Path not found." : ""}
      enabledLaunchProviders={[{ id: "codex", label: "Codex" }]}
      providerLoadStatus={providerLoadStatus}
      providerLoadError={providerLoadError}
      selectedLaunchProviderId="codex"
      characterOptions={options}
      selectedCharacterId={randomCharacterSelected ? null : options[0]?.id ?? null}
      randomCharacterSelected={randomCharacterSelected}
      charactersLoaded={charactersLoaded}
      characterLoadStatus={characterLoadStatus}
      canStartSession={true}
      launchFeedback=""
      launchStarting={false}
      onClose={noOp}
      onChangeTitle={noOp}
      onChangeWorkspacePath={noOp}
      onBrowseWorkspace={noOp}
      onSelectSessionFolder={noOp}
      onSelectProvider={noOp}
      onSelectCharacter={noOp}
      onSelectRandomCharacter={noOp}
      onStartSession={noOp}
    />,
  );

  // @test-value v2
  // kind = "contract"
  // claim = "Homeの新規Sessionダイアログは開始操作とSession Folder選択を識別可能に表示する"
  // oracle = { type = "contract", ref = "docs/design/desktop-ui.md" }
  // fault = "開始ボタンのaccessible nameまたはworkspace選択肢を失いSessionを作成できない"
  // observable = "開始label、New Session accessible name、Coding Provider label、Session Folder表示"
  // observation_boundary = "component-behavior"
  // scope = "Home launch dialog entry"
  // lifecycle = "permanent"
  // @end-test-value
  it("新規作成導線は Session 専用である", () => {
    const html = renderHomeLaunchDialog();

    assert.ok(html.includes("Start New Session"));
    assert.ok(html.includes('aria-label="New Session"'));
    assert.ok(html.includes("Coding Provider"));
    assert.ok(!html.includes("Agent Mode"));
    assert.ok(html.includes("Session Folder"));
  });

  // @test-value v2
  // kind = "contract"
  // claim = "Homeの新規SessionダイアログはCharacter候補・ランダム選択・workspace選択を同じ導線で表示する"
  // oracle = { type = "contract", ref = "docs/design/desktop-ui.md" }
  // fault = "Character selectorまたはworkspace選択肢が欠落し、候補選択やSession Folderへの切り替えを利用者が識別できない"
  // observable = "Character section、Mia候補、Random候補、BrowseとSession Folderのmarkup順序"
  // observation_boundary = "component-behavior"
  // scope = "HomeLaunchDialog Character and workspace selectors"
  // lifecycle = "permanent"
  // impact = "新規Session作成時のCharacter選択とworkspace選択を同じ画面で完了できる"
  // distinction = "開始CTAだけでなく、候補の内容・順序とworkspace切り替え導線を静的描画から確認する"
  // @end-test-value
  it("ダイアログに Character selector が含まれる", () => {
    const html = renderHomeLaunchDialog();

    assert.ok(html.includes("launch-section minimal home-launch-character-section"));
    assert.ok(html.includes("Character"));
    assert.ok(html.includes("Mia"));
    assert.ok(!html.includes(">Default</span>"));
    assert.ok(html.includes("Character description"));
    assert.ok(html.includes("Random"));
    assert.ok(html.indexOf("Random") < html.indexOf("Mia"));
    assert.ok(html.indexOf("Browse") < html.indexOf("Session Folder"));
  });

  it("Workspace input と invalid 理由を field 近傍へ表示する", () => {
    const idle = renderHomeLaunchDialog();
    const html = renderHomeLaunchDialog(characterOptions, true, false, "invalid");

    assert.match(idle, /<span id="launch-workspace-path-error"[^>]*><\/span>/);
    assert.ok(html.includes("launch-workspace-path"));
    assert.ok(html.includes('value="C:'));
    assert.ok(html.includes("work space"));
    assert.ok(html.includes('aria-invalid="true"'));
    assert.ok(html.includes("Path not found."));
  });

  // @test-value v2
  // kind = "contract"
  // claim = "Homeのworkspace validationはdebounce中とfilesystem確認中の両方をbusy状態として表示する"
  // oracle = { type = "contract", ref = "Issue #731 Home/New session workspace validation" }
  // fault = "debounceまたはfilesystem確認の片方でspinnerとaria-busyを失い、入力が検証中かどうかを識別できない"
  // observable = "debouncing/pending各markupのworkspace-validation-spinner、aria-busy、Checking workspace path…"
  // observation_boundary = "component-behavior"
  // scope = "HomeLaunchDialog workspace validation feedback"
  // lifecycle = "permanent"
  // impact = "検証待ちの入力を利用者が未検証または完了済みと誤認しにくくなる"
  // distinction = "検証完了結果ではなく、debounceからpendingまで連続する局所busy表示を状態別に確認する"
  // @end-test-value
  it("Workspace validation は debounce 開始から filesystem 確認完了まで spinner を表示する", () => {
    const debouncing = renderHomeLaunchDialog(characterOptions, true, false, "debouncing");
    const pending = renderHomeLaunchDialog(characterOptions, true, false, "pending");

    assert.ok(debouncing.includes("workspace-validation-spinner"));
    assert.ok(debouncing.includes('aria-busy="true"'));
    assert.ok(debouncing.includes("Checking workspace path…"));
    assert.ok(pending.includes("workspace-validation-spinner"));
    assert.ok(pending.includes('aria-busy="true"'));
    assert.ok(pending.includes("Checking workspace path…"));
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "Homeのrandom Character選択はRandom cardだけを選択状態として公開する"
  // oracle = { type = "contract", ref = "Issue #731 Home/New session Character selection" }
  // fault = "specific Characterにもselected状態を残し、random選択の対象またはaria-checkedを誤って伝える"
  // observable = "Random/Mia各buttonのselected classとaria-checked markup"
  // observation_boundary = "component-behavior"
  // scope = "HomeLaunchDialog random character selection"
  // lifecycle = "permanent"
  // impact = "開始時に選択されるCharacterの意味を視覚表示と支援技術へ一貫して伝える"
  // distinction = "選択IDの内部値ではなく、利用者が操作するcardの公開選択状態を確認する"
  // @end-test-value
  it("random選択時は一覧先頭のランダムcardだけを選択状態にする", () => {
    const html = renderHomeLaunchDialog(characterOptions, true, true);

    assert.match(
      html,
      /<button class="launch-character-option selected"[^>]*aria-checked="true"[^>]*>(?:(?!<\/button>).)*Random/s,
    );
    assert.doesNotMatch(
      html,
      /<button class="launch-character-option selected"[^>]*>(?:(?!<\/button>).)*Mia/s,
    );
  });

  it("Character 0 件なら neutral fallback を表示する", () => {
    const html = renderHomeLaunchDialog([]);

    assert.ok(html.includes("WithMate"));
    assert.ok(html.includes("Neutral"));
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "New sessionのCharacter catalog読み込み中は既存spinnerとaccessible statusを出し、取得済み空一覧のNeutral fallbackを出さない"
  // oracle = { type = "contract", ref = "Issue #731 Home/New session data-state distinction" }
  // fault = "初期loadingをNeutralへ投影して未取得状態を空一覧と混同させる"
  // observable = "既存spinner、Loading characters…のaccessible status、およびNeutralの不在"
  // observation_boundary = "component-behavior"
  // scope = "HomeLaunchDialog character catalog loading state"
  // lifecycle = "permanent"
  // impact = "Character取得待ちと正常な空一覧を識別でき、開始可否を誤認しない"
  // distinction = "候補配列が空である事実だけでなく、明示的loading stateの表示分岐を確認する"
  // @end-test-value
  it("Character catalog 読み込み前は neutral fallback を表示しない", () => {
    const html = renderHomeLaunchDialog([], false);

    assert.ok(html.includes("home-session-list-load-spinner"));
    assert.ok(html.includes("Loading characters…"));
    assert.ok(!html.includes("Neutral"));
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "New sessionのCharacter領域はcatalog取得失敗を初期loadingや取得済み空一覧と区別して表示する"
  // oracle = { type = "contract", ref = "Issue #731 Home/New session data-state distinction" }
  // fault = "Character取得失敗をLoadingまたはNeutralへ投影し、開始可否と回復可能な失敗状態を隠す"
  // observable = "Character領域のUnavailable、失敗文言、Loading/Neutral文言の有無"
  // observation_boundary = "component-behavior"
  // scope = "HomeLaunchDialog character catalog state"
  // lifecycle = "permanent"
  // impact = "取得失敗時に利用者が空一覧と誤認せず、Session開始を継続できない理由を識別できる"
  // distinction = "単なるCharacter候補数ではなく、明示したload stateの最終表示を検証する"
  // @end-test-value
  it("Character catalog の読み込み失敗は loading と空一覧を区別する", () => {
    const html = renderHomeLaunchDialog([], false, false, "idle", "error");

    assert.ok(html.includes("Unavailable"));
    assert.ok(html.includes("Could not load characters."));
    assert.ok(!html.includes("Loading characters…"));
    assert.ok(!html.includes("Neutral"));
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "New sessionのProvider catalogは取得中・取得失敗・正常な有効provider 0件を別状態として表示し、未確定中は開始を無効化する"
  // oracle = { type = "contract", ref = "docs/design/desktop-ui.md#表示言語・操作・状態" }
  // fault = "Provider catalogの取得中または失敗をNo enabled coding providersへ投影し、開始条件と実エラーを混同する"
  // observable = "Provider pickerのspinner/aria-busy、実エラー、Start New Session disabled、No enabled coding providers.の相互排他"
  // observation_boundary = "component-behavior"
  // scope = "HomeLaunchDialog provider catalog state"
  // lifecycle = "permanent"
  // impact = "Session開始可否とcatalog取得失敗の理由を利用者が識別できる"
  // distinction = "候補配列の長さではなく、catalog request stateをpickerの表示へ投影する境界を確認する"
  // @end-test-value
  it("Provider catalog の loading と error は正常な空状態と区別する", () => {
    const loading = renderHomeLaunchDialog(
      characterOptions,
      true,
      false,
      "idle",
      "loaded",
      "loading",
    );
    const error = renderHomeLaunchDialog(
      characterOptions,
      true,
      false,
      "idle",
      "loaded",
      "error",
      "Could not load model catalog.",
    );

    assert.ok(loading.includes("chat-skill-picker-spinner"));
    assert.ok(loading.includes("Loading coding providers."));
    assert.ok(loading.includes('aria-busy="true"'));
    assert.ok(!loading.includes("No enabled coding providers."));
    assert.equal(new JSDOM(loading).window.document.querySelector(".start-session-button")?.hasAttribute("disabled"), true);
    assert.ok(error.includes("Could not load model catalog."));
    assert.ok(!error.includes("No enabled coding providers."));
    assert.equal(new JSDOM(error).window.document.querySelector(".start-session-button")?.hasAttribute("disabled"), true);
  });

});

describe("HomeRecentSessionsPanel", () => {
  const noOp = (..._args: unknown[]) => undefined;
  const createSessionSummary = (partial: Partial<SessionSummary> & Pick<SessionSummary, "id" | "taskTitle">): SessionSummary => ({
    status: "idle",
    updatedAt: "2026-06-17T00:00:00.000Z",
    isPinned: false,
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
    codexSpeed: partial.codexSpeed ?? "standard",
    codexReviewer: partial.codexReviewer ?? "auto-review",
  });
  const renderHomeRecentSessions = ({
    canUsePrimaryFeatures = true,
    filteredSessionEntries = [],
    normalizedSessionSearch = "",
    searchText = "",
    hasMore = false,
    loadingMore = false,
    onLoadMore = noOp,
  }: {
    canUsePrimaryFeatures?: boolean;
    filteredSessionEntries?: React.ComponentProps<typeof HomeRecentSessionsPanel>["filteredSessionEntries"];
    normalizedSessionSearch?: string;
    searchText?: string;
    hasMore?: boolean;
    loadingMore?: boolean;
    onLoadMore?: () => void;
  } = {}) => renderToStaticMarkup(
    <HomeRecentSessionsPanel
      filteredSessionEntries={filteredSessionEntries}
      normalizedSessionSearch={normalizedSessionSearch}
      searchText={searchText}
      searchIcon={<span />}
      onChangeSearchText={noOp}
      onOpenLaunchDialog={noOp}
      onOpenSession={noOp}
      onSetSessionPinned={noOp}
      canUsePrimaryFeatures={canUsePrimaryFeatures}
      hasMore={hasMore}
      loadingMore={loadingMore}
      onLoadMore={onLoadMore}
    />,
  );

  // @test-value v2
  // kind = "contract"
  // claim = "Homeの更新時刻はen-USの表示書式を使い、保存値のraw ISO文字列を表示しない"
  // oracle = { type = "contract", ref = "Issue #731 Home date presentation" }
  // fault = "更新時刻をraw ISOまたは別localeへ表示し、利用者のローカルtime zoneを失う"
  // observable = "formatHomeSessionUpdatedAtの戻り値とraw ISO形式の不在"
  // observation_boundary = "public-boundary"
  // scope = "HomeRecentSessionsPanel updatedAt formatter"
  // lifecycle = "permanent"
  // impact = "異なるlocale/time zoneでもHomeの日時を識別可能な英語表示で読める"
  // distinction = "日時の保存・sort値ではなく、UI表示専用formatterのlocale/time zone境界を検証する"
  // @end-test-value
  it("updatedAt は en-US のローカル時刻として表示する", () => {
    const value = "2026-08-08T05:00:00.000Z";
    const expected = new Intl.DateTimeFormat("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(value));

    assert.equal(formatHomeSessionUpdatedAt(value), expected);
    assert.doesNotMatch(formatHomeSessionUpdatedAt(value), /T\d{2}:\d{2}/);
  });

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

  it("検索行には検索欄とNew Sessionだけを表示する", () => {
    const html = renderHomeRecentSessions();

    assert.match(html, /class="toolbar-search-field"/);
    assert.match(html, /class="start-session-button"/);
    assert.doesNotMatch(html, /Restore Sessions|restore-session-windows-button/);
  });

  it("追加読み込みは一覧末尾のsentinelだけを使い、追加ボタンを表示しない", () => {
    const html = renderHomeRecentSessions({ hasMore: true });

    assert.match(html, /class="home-session-list-load-sentinel"/);
    assert.doesNotMatch(html, /Sessionをさらに読み込む|ピン留めをさらに読み込む/);
    assert.doesNotMatch(html, /class="secondary-button"/);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "Homeの履歴一覧は末尾の交差を観測してから次ページの読み込みを要求する"
  // oracle = { type = "contract", ref = "docs/design/desktop-ui.md" }
  // fault = "末尾が見える前に繰り返し読み込むか末尾到達時に次ページを読み込まない"
  // observable = "observerの監視対象と交差前後のloadMore callback回数"
  // observation_boundary = "component-behavior"
  // scope = "Home recent Session pagination"
  // lifecycle = "permanent"
  // @end-test-value
  it("一覧末尾のsentinelが交差した時だけ追加読み込みcallbackを呼ぶ", async () => {
    const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
      pretendToBeVisual: true,
    });
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    const previousHTMLElement = globalThis.HTMLElement;
    const previousIntersectionObserver = globalThis.IntersectionObserver;
    let observerCallback: IntersectionObserverCallback | null = null;
    let observedTarget: Element | null = null;
    let loadMoreCount = 0;

    class TestIntersectionObserver {
      constructor(callback: IntersectionObserverCallback) {
        observerCallback = callback;
      }

      observe(target: Element) {
        observedTarget = target;
      }

      disconnect() {}
    }

    Object.defineProperty(globalThis, "window", { value: dom.window, configurable: true });
    Object.defineProperty(globalThis, "document", { value: dom.window.document, configurable: true });
    Object.defineProperty(globalThis, "HTMLElement", { value: dom.window.HTMLElement, configurable: true });
    Object.defineProperty(globalThis, "IntersectionObserver", {
      value: TestIntersectionObserver,
      configurable: true,
    });

    const rootElement = dom.window.document.getElementById("root");
    assert.ok(rootElement);
    let root: Root | null = null;

    try {
      await act(async () => {
        root = createRoot(rootElement);
        root.render(
          <HomeRecentSessionsPanel
            filteredSessionEntries={[]}
            normalizedSessionSearch=""
            searchText=""
            searchIcon={<span />}
            onChangeSearchText={noOp}
            onOpenLaunchDialog={noOp}
            onOpenSession={noOp}
            onSetSessionPinned={noOp}
            hasMore
            onLoadMore={() => {
              loadMoreCount += 1;
            }}
          />,
        );
      });

      const sentinel = rootElement.querySelector(".home-session-list-load-sentinel");
      assert.ok(sentinel);
      assert.equal(observedTarget, sentinel);
      assert.equal(loadMoreCount, 0);

      await act(async () => {
        observerCallback?.(
          [{ isIntersecting: false } as IntersectionObserverEntry],
          {} as IntersectionObserver,
        );
      });
      assert.equal(loadMoreCount, 0);

      await act(async () => {
        observerCallback?.(
          [{ isIntersecting: true } as IntersectionObserverEntry],
          {} as IntersectionObserver,
        );
      });
      assert.equal(loadMoreCount, 1);
    } finally {
      await act(async () => {
        root?.unmount();
      });
      Object.defineProperty(globalThis, "window", { value: previousWindow, configurable: true });
      Object.defineProperty(globalThis, "document", { value: previousDocument, configurable: true });
      Object.defineProperty(globalThis, "HTMLElement", { value: previousHTMLElement, configurable: true });
      Object.defineProperty(globalThis, "IntersectionObserver", {
        value: previousIntersectionObserver,
        configurable: true,
      });
    }
  });

  // @test-value v2
  // kind = "contract"
  // claim = "Home recent sessionsはcharacter-authoring sessionをCharacter badgeで表示する"
  // oracle = { type = "contract", ref = "HomeRecentSessionsPanel session kind presentation" }
  // fault = "character-authoring sessionが通常Agentとして表示される"
  // observable = "rendered title、badge class、badge text"
  // observation_boundary = "component-behavior"
  // scope = "HomeRecentSessionsPanel character authoring card"
  // lifecycle = "permanent"
  // @end-test-value
  it("character authoring session は Character badge で表示する", () => {
    const html = renderHomeRecentSessions({
      filteredSessionEntries: [
        {
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

  // @test-value v2
  // kind = "contract"
  // claim = "Home recent sessionsはpinned Agentを先頭にし、openとpinを兄弟buttonとして表示する"
  // oracle = { type = "contract", ref = "src/home/HomeRecentSessionsPanel.tsx" }
  // fault = "pinned順序が崩れる、またはopen/pin操作が入れ子になる"
  // observable = "rendered order、card class、open class、aria-pressed、pin label"
  // observation_boundary = "component-behavior"
  // scope = "HomeRecentSessionsPanel pinned Agent card"
  // lifecycle = "permanent"
  // @end-test-value
  it("pin済みAgentを先頭にし、開く操作とpin操作を兄弟buttonで表示する", () => {
    const html = renderHomeRecentSessions({
      filteredSessionEntries: [
        {
          session: createSessionSummary({
            id: "recent",
            taskTitle: "Recent task",
            updatedAt: "2026-08-09T05:00:00.000Z",
          }),
          state: { kind: "neutral", label: "待機" },
        },
        {
          session: createSessionSummary({
            id: "pinned",
            taskTitle: "Pinned task",
            isPinned: true,
            updatedAt: "2026-08-08T05:00:00.000Z",
          }),
          state: { kind: "neutral", label: "待機" },
        },
      ],
    });

    assert.ok(html.indexOf("Pinned task") < html.indexOf("Recent task"));
    assert.match(html, /class="session-card home-session-card is-pinnable is-pinned"/);
    assert.match(html, /class="home-session-card-open"/);
    assert.match(html, /aria-pressed="true"/);
    assert.match(html, /aria-label="Unpin Pinned task"/);

    const openButtonMarkup = html.match(
      /<button class="home-session-card-open"[^>]*>([\s\S]*?)<\/button>/,
    );
    assert.ok(openButtonMarkup);
    assert.doesNotMatch(openButtonMarkup[1], /<button\b/);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "履歴カードはMate iconを表示し、V4以前のAgent Sessionを閲覧専用として開ける"
  // oracle = { type = "contract", ref = "src/home/HomeRecentSessionsPanel.tsx" }
  // fault = "legacy Agent Sessionのcharacter iconまたは閲覧専用open affordanceを欠落させる"
  // observable = "rendered avatar, read-only label, and open button accessibility"
  // observation_boundary = "component-behavior"
  // scope = "HomeRecentSessionsPanel legacy Session card"
  // lifecycle = "permanent"
  // @end-test-value
  it("履歴カードに Mate アイコンを表示し、V4 以前の Agent session は閲覧専用として開ける", () => {
    const html = renderHomeRecentSessions({
      filteredSessionEntries: [{
        session: createSessionSummary({
          id: "session-v4",
          taskTitle: "Legacy task",
          sourceSchemaVersion: 4,
          character: "Solo Mate",
          characterIconPath: "mate.png",
        }),
        state: { kind: "neutral", label: "idle" },
      }],
    });

    assert.equal((html.match(/character-avatar tiny home-session-card-avatar/g) ?? []).length, 1);
    assert.ok(html.includes("mate.png"));
    assert.ok(html.includes("Read Only"));
    assert.match(html, /class="home-session-card-open"[^>]*aria-disabled="false"/);
    assert.match(html, /class="session-card home-session-card/);
  });

});


describe("HomeMonitorContent", () => {
  const noOp = (..._args: unknown[]) => undefined;

  const createMonitorSession = (id: string, taskTitle: string): HomeSessionSummary => ({
    id,
    taskTitle,
    status: "idle",
    updatedAt: "2026-03-30T00:00:00.000Z",
    isPinned: false,
    workspaceLabel: "workspace",
    workspacePath: "C:/workspace",
    sessionKind: "default",
    accessMode: "active",
    sourceSchemaVersion: 5,
    characterId: "mate",
    character: "Solo Mate",
    characterIconPath: "mate.png",
    characterThemeColors: { main: "#223344", sub: "#88bbcc" },
    runState: "idle",
  });

  const createMonitorAuxiliary = (id: string, overrides: Record<string, unknown> = {}) => ({
    id,
    parentSessionId: "session-1",
    status: "active",
    runState: "idle",
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
    characterIconPath: "mate.png",
    preview: "Auxiliary preview",
    codexSpeed: "standard",
    codexReviewer: "auto-review",
    ...overrides,
  } as AuxiliarySessionSummary);



  // @test-value v2
  // kind = "invariant"
  // claim = "Home Monitorの親カードはavatarとtitleを1行目、Mainを独立した状態iconとして2行目へ表示し、Auxiliaryが存在する親だけ状態集約と1件からの件数を追加する"
  // oracle = { type = "contract", ref = "docs/design/desktop-ui.md#session-monitor-window" }
  // fault = "workspaceを常設する、Main/Auxiliaryの状態表示を混同する、Auxiliaryなしの親へ集約を出す、状態別件数を1件だけ省略する、またはavatar/titleが欠落する"
  // observable = "親cardごとの2行構造、Main/Auxiliary status cluster、状態iconと件数aria-label、avatar、title、未展開時のAuxiliary detail rowの不在"
  // observation_boundary = "component-behavior"
  // scope = "home-monitor-rendering"
  // lifecycle = "permanent"
  // @end-test-value
  it("Monitor カードはキャラアイコン付きでセッション情報を表示する", () => {
    const entries: HomeMonitorEntry[] = [
      {
        kind: "agent",
        session: createMonitorSession("session-1", "Agent task"),
        state: { kind: "running", label: "Running" },
        mainState: { kind: "neutral", label: "Idle" },
        auxiliarySessions: [
          createMonitorAuxiliary("aux-1", { runState: "error", preview: "Auxiliary error" }),
          createMonitorAuxiliary("aux-closed", {
            status: "closed",
            preview: "Closed auxiliary",
          }),
        ],
      },
      {
        kind: "agent",
        session: createMonitorSession("session-2", "Auxiliary task"),
        state: { kind: "running", label: "Running" },
        mainState: { kind: "running", label: "Running" },
        auxiliarySessions: [],
      },


    ];
    const html = renderToStaticMarkup(
      <HomeMonitorContent
        runningEntries={entries}
        nonRunningEntries={[]}
        onOpenSession={noOp}
        onShowContextMenu={noOp}
      />,
    );
    const document = new JSDOM(html).window.document;
    const cards = Array.from(document.querySelectorAll(".home-monitor-card"));
    const expectedMainStates = ["neutral", "running"] as const;

    assert.ok(html.includes("Agent task"));
    assert.ok(html.includes("Auxiliary task"));
    assert.equal(html.includes("workspace"), false);
    assert.equal(cards.length, 2);
    for (const [index, card] of cards.entries()) {
      const parentRow = card.querySelector(".home-monitor-parent-row");
      const summaryRow = card.querySelector(".home-monitor-summary-row");
      assert.equal(card.querySelectorAll(".home-monitor-parent-row").length, 1);
      assert.equal(card.querySelectorAll(".home-monitor-summary-row").length, 1);
      assert.equal(card.querySelectorAll(".home-monitor-auxiliary-list").length, 0);
      assert.equal(card.querySelectorAll(".home-monitor-parent-title").length, 1);
      assert.equal(card.querySelectorAll(".home-monitor-avatar").length, 1);
      assert.equal(parentRow?.querySelector(".home-monitor-avatar")?.classList.contains("home-monitor-avatar"), true);
      assert.equal(parentRow?.querySelector(".home-monitor-parent-title")?.textContent, entries[index]?.session.taskTitle);
      assert.equal(parentRow?.querySelector(".home-monitor-status-cluster"), null);
      assert.equal(summaryRow?.querySelector(".home-monitor-avatar"), null);
      assert.equal(summaryRow?.querySelector(".home-monitor-parent-title"), null);
      assert.equal(summaryRow?.querySelectorAll(".home-monitor-status-cluster").length, index === 0 ? 2 : 1);
      assert.equal(
        summaryRow?.querySelectorAll(`.home-monitor-status-icon.${expectedMainStates[index]}`).length,
        1,
      );
    }
    assert.equal(cards[0]?.querySelectorAll(".home-monitor-status-cluster").length, 2);
    assert.equal(cards[0]?.querySelectorAll(".home-monitor-auxiliary-status").length, 1);
    assert.equal(cards[0]?.querySelectorAll(".home-monitor-status-icon.neutral").length, 1);
    assert.equal(cards[0]?.querySelectorAll(".home-monitor-status-icon.error").length, 1);
    assert.equal(cards[0]?.querySelectorAll(".home-monitor-status-icon.closed").length, 1);
    assert.equal(cards[1]?.querySelectorAll(".home-monitor-status-cluster").length, 1);
    assert.equal(cards[1]?.querySelectorAll(".home-monitor-auxiliary-status").length, 0);
    assert.equal(html.match(/>Main<\/span>/g)?.length, 2);
    assert.equal(html.match(/>Aux<\/span>/g)?.length, 1);
    assert.equal(html.match(/class="home-monitor-status-icon running"/g)?.length, 1);
    assert.equal(html.match(/class="home-monitor-status-icon neutral"/g)?.length, 1);
    assert.equal(html.match(/class="home-monitor-status-icon error"/g)?.length, 1);
    assert.equal(html.match(/class="home-monitor-status-icon closed"/g)?.length, 1);
    assert.equal(html.match(/aria-label="Main Running"/g)?.length, 1);
    assert.equal(html.match(/aria-label="Main Idle"/g)?.length, 1);
    assert.ok(html.includes('aria-label="Auxiliary Error: 1"'));
    assert.ok(html.includes('aria-label="Auxiliary Closed: 1"'));
    assert.equal(html.match(/character-avatar tiny home-monitor-avatar/g)?.length, 2);
    assert.equal(html.match(/<img src="file:\/\/\/mate.png"/g)?.length, 2);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "Home Monitorは明示的に空または欠損のAuxiliary previewを空のまま表示する"
  // oracle = { type = "contract", ref = "docs/design/auxiliary-session.md: Preview contract" }
  // fault = "Home Monitorが空または欠損のAuxiliary previewを日本語の既定タイトルへ置き換える"
  // observable = "展開したAuxiliary rowのpreview要素のtextContentとaria-label"
  // observation_boundary = "component-behavior"
  // scope = "HomeMonitorContent empty auxiliary preview"
  // lifecycle = "permanent"
  // impact = "新規・旧形式Auxiliaryのpreviewを日本語fallbackなしでHome Monitorへ表示する"
  // distinction = "Auxiliary previewの保存値ではなく、Home Monitorでの最終表示値を確認する"
  // @end-test-value
  it("Home Monitorは空または欠損のAuxiliary previewを日本語fallbackへ戻さない", async () => {
    const previousGlobals = {
      window: globalThis.window,
      document: globalThis.document,
      Node: globalThis.Node,
      HTMLElement: globalThis.HTMLElement,
      Event: globalThis.Event,
      MouseEvent: globalThis.MouseEvent,
      KeyboardEvent: globalThis.KeyboardEvent,
      PointerEvent: globalThis.PointerEvent,
    };
    const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
      pretendToBeVisual: true,
    });
    const container = dom.window.document.getElementById("root") as HTMLElement;
    const root = createRoot(container);
    const entry: HomeMonitorEntry = {
      kind: "agent",
      session: createMonitorSession("session-empty-preview", "Empty preview task"),
      state: { kind: "neutral", label: "待機" },
      mainState: { kind: "neutral", label: "待機" },
      auxiliarySessions: [
        createMonitorAuxiliary("aux-empty-preview", { preview: "" }),
        createMonitorAuxiliary("aux-missing-preview", { preview: undefined }),
      ],
    };

    Object.defineProperties(globalThis, {
      window: { configurable: true, value: dom.window },
      document: { configurable: true, value: dom.window.document },
      Node: { configurable: true, value: dom.window.Node },
      HTMLElement: { configurable: true, value: dom.window.HTMLElement },
      Event: { configurable: true, value: dom.window.Event },
      MouseEvent: { configurable: true, value: dom.window.MouseEvent },
      KeyboardEvent: { configurable: true, value: dom.window.KeyboardEvent },
      PointerEvent: { configurable: true, value: dom.window.PointerEvent ?? dom.window.MouseEvent },
    });

    try {
      await act(async () => root.render(
        <HomeMonitorContent
          runningEntries={[]}
          nonRunningEntries={[entry]}
          onOpenSession={noOp}
          onShowContextMenu={noOp}
        />,
      ));

      const disclosure = container.querySelector<HTMLButtonElement>("button.home-monitor-disclosure");
      assert.ok(disclosure);
      await act(async () => disclosure.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));

      const rows = Array.from(container.querySelectorAll<HTMLButtonElement>("button.home-monitor-auxiliary-row"));
      assert.equal(rows.length, 2);
      assert.equal(rows[0]?.querySelector(".home-monitor-auxiliary-preview")?.textContent, "");
      assert.equal(rows[0]?.getAttribute("aria-label"), "Open Auxiliary 1");
      assert.equal(rows[0]?.textContent?.includes("新しい会話"), false);
      assert.equal(rows[1]?.querySelector(".home-monitor-auxiliary-preview")?.textContent, "");
      assert.equal(rows[1]?.getAttribute("aria-label"), "Open Auxiliary 2");
      assert.equal(container.textContent?.includes("新しい会話"), false);
    } finally {
      await act(async () => root.unmount());
      dom.window.close();
      Object.defineProperties(globalThis, {
        window: { configurable: true, value: previousGlobals.window },
        document: { configurable: true, value: previousGlobals.document },
        Node: { configurable: true, value: previousGlobals.Node },
        HTMLElement: { configurable: true, value: previousGlobals.HTMLElement },
        Event: { configurable: true, value: previousGlobals.Event },
        MouseEvent: { configurable: true, value: previousGlobals.MouseEvent },
        KeyboardEvent: { configurable: true, value: previousGlobals.KeyboardEvent },
        PointerEvent: { configurable: true, value: previousGlobals.PointerEvent },
      });
    }
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "閉じたHome MonitorカードはAuxiliaryの実行中と待機の件数を1件から表示し、両方を同時に読み取れる"
  // oracle = { type = "contract", ref = "docs/design/desktop-ui.md#session-monitor-window" }
  // fault = "count=1のAuxiliary状態から件数表示とaccessible nameを省略し、3件と1件の組合せで非実行中の存在を判別できない"
  // observable = "閉じた親cardのAuxiliary status iconに描画された可視件数、aria-label、Auxiliary一覧の不在"
  // observation_boundary = "component-behavior"
  // scope = "HomeMonitorContent collapsed auxiliary status summary"
  // lifecycle = "permanent"
  // impact = "親カードを展開しなくても、Auxiliaryの実行中3件と待機1件を正しく把握できる"
  // distinction = "projectionのAuxiliary全件保持ではなく、折りたたみ時のstatus iconの可視テキストとaccessible nameを直接確認する"
  // @end-test-value
  it("閉じたMonitorカードでもAuxiliaryの状態別件数を1件から表示する", () => {
    const auxiliarySessions = [
      createMonitorAuxiliary("aux-running-1", { runState: "running" }),
      createMonitorAuxiliary("aux-running-2", { runState: "running" }),
      createMonitorAuxiliary("aux-running-3", { runState: "running" }),
      createMonitorAuxiliary("aux-idle", { runState: "idle" }),
    ];
    const entry: HomeMonitorEntry = {
      kind: "agent",
      session: createMonitorSession("session-count-summary", "Count summary task"),
      state: { kind: "running", label: "Running" },
      mainState: { kind: "neutral", label: "Idle" },
      auxiliarySessions,
    };
    const html = renderToStaticMarkup(
      <HomeMonitorContent
        runningEntries={[entry]}
        nonRunningEntries={[]}
        onOpenSession={noOp}
        onShowContextMenu={noOp}
      />,
    );
    const document = new JSDOM(html).window.document;
    const card = document.querySelector(".home-monitor-card");
    const auxiliaryStatus = card?.querySelector(".home-monitor-auxiliary-status");
    const runningIcon = auxiliaryStatus?.querySelector(".home-monitor-status-icon.running");
    const idleIcon = auxiliaryStatus?.querySelector(".home-monitor-status-icon.neutral");

    assert.equal(card?.querySelectorAll(".home-monitor-auxiliary-list").length, 0);
    assert.equal(runningIcon?.querySelector(".home-monitor-status-icon-count")?.textContent, ": 3");
    assert.equal(idleIcon?.querySelector(".home-monitor-status-icon-count")?.textContent, ": 1");
    assert.equal(runningIcon?.getAttribute("aria-label"), "Auxiliary Running: 3");
    assert.equal(idleIcon?.getAttribute("aria-label"), "Auxiliary Idle: 1");
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "Auxiliary summaryが未確定でもAuxiliaryなしの親カードへ誤った集約を表示せず、loading/errorをMonitor feedbackで知らせる"
  // oracle = { type = "contract", ref = "issue-722 auxiliary summary loading feedback" }
  // fault = "loading/errorをAuxiliary存在として各親カードへ重複表示するか、未確定状態を0件・待機として隠す、またはfeedbackのaccessible statusを欠落させる"
  // observable = "loading/error各状態でのAuxiliary status clusterの不在とrole=status feedbackの文言"
  // observation_boundary = "component-behavior"
  // scope = "HomeMonitorContent auxiliary data state"
  // lifecycle = "permanent"
  // impact = "Auxiliaryの有無とsummary取得状態を混同させず、復旧可能な状態を利用者へ伝える"
  // @end-test-value
  it("Auxiliary summary未確定時は親カードへAuxiliaryを作らずMonitor feedbackを表示する", () => {
    const entries = [{
      kind: "agent" as const,
      session: createMonitorSession("loading-session", "Loading task"),
      state: { kind: "neutral" as const, label: "Idle" },
      mainState: { kind: "neutral" as const, label: "Idle" },
      auxiliarySessions: [],
    }];
    for (const [auxiliaryDataState, expectedFeedback] of [
      ["loading", "Loading Auxiliary sessions…"],
      ["error", "Could not load Auxiliary sessions."],
    ] as const) {
      const html = renderToStaticMarkup(
        <HomeMonitorContent
          runningEntries={[]}
          nonRunningEntries={entries}
          auxiliaryDataState={auxiliaryDataState}
          onOpenSession={noOp}
          onShowContextMenu={noOp}
        />,
      );
      const document = new JSDOM(html).window.document;

      assert.equal(document.querySelectorAll(".home-monitor-auxiliary-status").length, 0);
      assert.equal(document.querySelector('[role="status"]')?.textContent, expectedFeedback);
    }
  });

  // @test-value v2
  // kind = "contract"
  // claim = "Home Monitorは親カードの展開を独立に保持し、Auxiliary rowから親と安定IDを指定して対象Windowを開く"
  // oracle = { type = "contract", ref = "issue-722 monitor disclosure and auxiliary navigation" }
  // fault = "親のopen操作と展開操作が混線する、Auxiliary rowが入れ子buttonになる、または別Auxiliaryへfallbackする"
  // observable = "展開後のAuxiliary row数、button nestingの不在、親/Auxiliary navigation callbackの引数"
  // observation_boundary = "component-behavior"
  // scope = "HomeMonitorContent Auxiliary expansion"
  // lifecycle = "permanent"
  // impact = "複数Auxiliaryを一覧から正確に再開し、既存親のopen操作を壊さない"
  // distinction = "Main IPCの親子validationではなく、rendererのdisclosureとstable ID mappingを検証する"
  // @end-test-value
  it("Auxiliary一覧を独立に展開し、親とAuxiliaryを別導線で開く", async () => {
    const previousGlobals = {
      window: globalThis.window,
      document: globalThis.document,
      Node: globalThis.Node,
      HTMLElement: globalThis.HTMLElement,
      Event: globalThis.Event,
      MouseEvent: globalThis.MouseEvent,
      KeyboardEvent: globalThis.KeyboardEvent,
      PointerEvent: globalThis.PointerEvent,
    };
    const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
      pretendToBeVisual: true,
    });
    const container = dom.window.document.getElementById("root") as HTMLElement;
    const root = createRoot(container);
    const openedSessions: Array<{ sessionId: string; auxiliarySessionId?: string }> = [];
    const recordOpenedSession = (sessionId: string, auxiliarySessionId?: string) => {
      openedSessions.push({ sessionId, auxiliarySessionId });
    };
    const auxiliarySessions = [
      {
        id: "aux-a",
        parentSessionId: "session-expand",
        status: "active",
        runState: "idle",
        preview: "First auxiliary",
        createdAt: "2026-03-28T00:00:00.000Z",
      },
      {
        id: "aux-b",
        parentSessionId: "session-expand",
        status: "closed",
        runState: "error",
        preview: "Second auxiliary",
        createdAt: "2026-03-29T00:00:00.000Z",
      },
    ] as AuxiliarySessionSummary[];
    const entry: HomeMonitorEntry = {
      kind: "agent",
      session: createMonitorSession("session-expand", "Expandable task"),
      state: { kind: "neutral", label: "待機" },
      mainState: { kind: "neutral", label: "待機" },
      auxiliarySessions,
    };
    const secondEntry: HomeMonitorEntry = {
      kind: "agent",
      session: createMonitorSession("session-expand-2", "Second expandable task"),
      state: { kind: "neutral", label: "待機" },
      mainState: { kind: "neutral", label: "待機" },
      auxiliarySessions: [
        createMonitorAuxiliary("aux-c", {
          parentSessionId: "session-expand-2",
          preview: "Third auxiliary",
        }),
      ],
    };


    Object.defineProperties(globalThis, {
      window: { configurable: true, value: dom.window },
      document: { configurable: true, value: dom.window.document },
      Node: { configurable: true, value: dom.window.Node },
      HTMLElement: { configurable: true, value: dom.window.HTMLElement },
      Event: { configurable: true, value: dom.window.Event },
      MouseEvent: { configurable: true, value: dom.window.MouseEvent },
      KeyboardEvent: { configurable: true, value: dom.window.KeyboardEvent },
      PointerEvent: { configurable: true, value: dom.window.PointerEvent ?? dom.window.MouseEvent },
    });

    try {
      await act(async () => root.render(
        <HomeMonitorContent
          runningEntries={[]}
          nonRunningEntries={[entry, secondEntry]}
          onOpenSession={recordOpenedSession}
          onShowContextMenu={noOp}
        />,
      ));

      const disclosures = Array.from(container.querySelectorAll<HTMLButtonElement>("button.home-monitor-disclosure"));
      const parentButtons = Array.from(container.querySelectorAll<HTMLButtonElement>("button.home-monitor-parent-button"));
      assert.equal(disclosures.length, 2);
      assert.equal(parentButtons.length, 2);
      assert.equal(container.querySelectorAll("button.home-monitor-auxiliary-row").length, 0);

      await act(async () => disclosures[0]?.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
      let cards = Array.from(container.querySelectorAll<HTMLElement>(".home-monitor-card"));
      assert.equal(cards.length, 2);
      assert.equal(cards[0]?.querySelectorAll("button.home-monitor-auxiliary-row").length, 2);
      assert.equal(cards[1]?.querySelectorAll("button.home-monitor-auxiliary-row").length, 0);
      const auxiliaryRows = Array.from(cards[0]?.querySelectorAll<HTMLButtonElement>("button.home-monitor-auxiliary-row") ?? []);
      assert.ok(auxiliaryRows[0]?.textContent?.includes("First auxiliary"));
      assert.equal(
        Array.from(container.querySelectorAll("button")).some((button) => button.querySelector("button")),
        false,
      );

      await act(async () => auxiliaryRows[1]?.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
      assert.deepEqual(openedSessions, [{ sessionId: "session-expand", auxiliarySessionId: "aux-b" }]);

      await act(async () => parentButtons[0]?.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
      assert.deepEqual(openedSessions, [
        { sessionId: "session-expand", auxiliarySessionId: "aux-b" },
        { sessionId: "session-expand", auxiliarySessionId: undefined },
      ]);

      await act(async () => root.render(
        <HomeMonitorContent
          runningEntries={[entry]}
          nonRunningEntries={[secondEntry]}
          onOpenSession={recordOpenedSession}
          onShowContextMenu={noOp}
        />,
      ));
      cards = Array.from(container.querySelectorAll<HTMLElement>(".home-monitor-card"));
      assert.equal(cards[0]?.querySelectorAll("button.home-monitor-auxiliary-row").length, 2);
      assert.equal(cards[1]?.querySelectorAll("button.home-monitor-auxiliary-row").length, 0);

      const movedDisclosures = Array.from(container.querySelectorAll<HTMLButtonElement>("button.home-monitor-disclosure"));
      await act(async () => movedDisclosures[1]?.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
      cards = Array.from(container.querySelectorAll<HTMLElement>(".home-monitor-card"));
      assert.equal(cards[0]?.querySelectorAll("button.home-monitor-auxiliary-row").length, 2);
      assert.equal(cards[1]?.querySelectorAll("button.home-monitor-auxiliary-row").length, 1);
    } finally {
      await act(async () => root.unmount());
      dom.window.close();
      Object.defineProperties(globalThis, {
        window: { configurable: true, value: previousGlobals.window },
        document: { configurable: true, value: previousGlobals.document },
        Node: { configurable: true, value: previousGlobals.Node },
        HTMLElement: { configurable: true, value: previousGlobals.HTMLElement },
        Event: { configurable: true, value: previousGlobals.Event },
        MouseEvent: { configurable: true, value: previousGlobals.MouseEvent },
        KeyboardEvent: { configurable: true, value: previousGlobals.KeyboardEvent },
        PointerEvent: { configurable: true, value: previousGlobals.PointerEvent },
      });
    }
  });

  // @test-value v2
  // kind = "contract"
  // claim = "開いているAgentのMonitor parent buttonは右クリックとContextMenu/Shift+F10を対象Sessionと座標へ変換する"
  // oracle = { type = "contract", ref = "docs/design/desktop-ui.md#session-monitor-window" }
  // fault = "Agentの種別またはkeyboard context menuの分岐が別Sessionへ送られるか、keyboard座標が原点に固定される"
  // observable = "callbackへ渡されたkind、sessionId、point、aria-haspopup、およびcontext menu eventのdefaultPrevented"
  // observation_boundary = "component-behavior"
  // scope = "HomeMonitorContent agent context menu interaction"
  // lifecycle = "permanent"
  // @end-test-value
  it("Monitor row は右クリックとkeyboard context menuを対象entryへ渡す", async () => {
    const previousGlobals = {
      window: globalThis.window,
      document: globalThis.document,
      Node: globalThis.Node,
      HTMLElement: globalThis.HTMLElement,
      Event: globalThis.Event,
      MouseEvent: globalThis.MouseEvent,
      KeyboardEvent: globalThis.KeyboardEvent,
      PointerEvent: globalThis.PointerEvent,
    };
    const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
      pretendToBeVisual: true,
    });
    const container = dom.window.document.getElementById("root") as HTMLElement;
    const root = createRoot(container);
    const requests: unknown[] = [];
    const entry: HomeMonitorEntry = {
      kind: "agent",
      session: {
        id: "session-context-menu",
        taskTitle: "Context menu task",
        status: "idle",
        updatedAt: "2026-03-28T00:00:00.000Z",
        isPinned: false,
        workspaceLabel: "workspace",
        workspacePath: "C:/workspace",
        sessionKind: "default",
        accessMode: "active",
        sourceSchemaVersion: 5,
        characterId: "mate",
        character: "Solo Mate",
        characterIconPath: "mate.png",
        characterThemeColors: { main: "#223344", sub: "#88bbcc" },
        runState: "idle",
      },
      state: { kind: "neutral", label: "待機" },
      mainState: { kind: "neutral", label: "待機" },
      auxiliarySessions: [],
    } as HomeMonitorEntry;
    Object.defineProperties(globalThis, {
      window: { configurable: true, value: dom.window },
      document: { configurable: true, value: dom.window.document },
      Node: { configurable: true, value: dom.window.Node },
      HTMLElement: { configurable: true, value: dom.window.HTMLElement },
      Event: { configurable: true, value: dom.window.Event },
      MouseEvent: { configurable: true, value: dom.window.MouseEvent },
      KeyboardEvent: { configurable: true, value: dom.window.KeyboardEvent },
      PointerEvent: { configurable: true, value: dom.window.PointerEvent ?? dom.window.MouseEvent },
    });
    try {
      await act(async () => root.render(
        <HomeMonitorContent
          runningEntries={[entry]}
          nonRunningEntries={[]}
          onOpenSession={noOp}
          onShowContextMenu={(kind, sessionId, point) => requests.push({ kind, sessionId, point })}
        />,
      ));
      const row = container.querySelector<HTMLButtonElement>("button.home-monitor-parent-button");
      assert.ok(row);
      assert.equal(row.getAttribute("aria-haspopup"), "menu");
      Object.defineProperty(row, "getBoundingClientRect", {
        configurable: true,
        value: () => ({ left: 120.4, bottom: 240.6 }),
      });
      const contextMenuEvent = new dom.window.MouseEvent("contextmenu", {
        bubbles: true, cancelable: true, clientX: 24, clientY: 48,
      });
      await act(async () => row.dispatchEvent(contextMenuEvent));
      assert.equal(contextMenuEvent.defaultPrevented, true);
      assert.deepEqual(requests, [{ kind: "agent", sessionId: "session-context-menu", point: { x: 24, y: 48 } }]);
      const keyboardEvent = new dom.window.KeyboardEvent("keydown", {
        bubbles: true, cancelable: true, key: "ContextMenu",
      });
      await act(async () => row.dispatchEvent(keyboardEvent));
      assert.equal(keyboardEvent.defaultPrevented, true);
      assert.deepEqual(requests.at(-1), {
        kind: "agent", sessionId: "session-context-menu", point: { x: 120, y: 241 },
      });
      const shiftF10Event = new dom.window.KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "F10",
        shiftKey: true,
      });
      await act(async () => row.dispatchEvent(shiftF10Event));
      assert.equal(shiftF10Event.defaultPrevented, true);
      assert.deepEqual(requests.at(-1), {
        kind: "agent", sessionId: "session-context-menu", point: { x: 120, y: 241 },
      });
    } finally {
      await act(async () => root.unmount());
      dom.window.close();
      Object.defineProperties(globalThis, {
        window: { configurable: true, value: previousGlobals.window },
        document: { configurable: true, value: previousGlobals.document },
        Node: { configurable: true, value: previousGlobals.Node },
        HTMLElement: { configurable: true, value: previousGlobals.HTMLElement },
        Event: { configurable: true, value: previousGlobals.Event },
        MouseEvent: { configurable: true, value: previousGlobals.MouseEvent },
        KeyboardEvent: { configurable: true, value: previousGlobals.KeyboardEvent },
        PointerEvent: { configurable: true, value: previousGlobals.PointerEvent },
      });
    }
  });

  // @test-value v2
  // kind = "contract"
  // claim = "Session Monitorのcontext menu失敗feedbackはMonitor contentのpolite live statusへ表示され、空のfeedbackでは表示されない"
  // oracle = { type = "contract", ref = "HomeMonitorContent session monitor feedback" }
  // fault = "native menuやclipboardの失敗結果が利用者へ見えない、または正常系でも空でないfeedbackが残る"
  // observable = "feedback文字列のDOM表示、role=status、aria-live=polite、および空feedback時の要素不在"
  // observation_boundary = "component-behavior"
  // scope = "HomeMonitorContent context menu feedback rendering"
  // lifecycle = "permanent"
  // impact = "Session Monitor操作の失敗を利用者と支援技術へ伝える"
  // distinction = "context menuのentry mappingやnative menu resultではなく、失敗結果のvisible projectionを検証する"
  // @end-test-value
  it("Monitor feedbackは失敗時だけpoliteなlive statusを表示する", () => {
    const emptyHtml = renderToStaticMarkup(
      <HomeMonitorContent
        runningEntries={[]}
        nonRunningEntries={[]}
        onOpenSession={noOp}
        onShowContextMenu={noOp}
      />,
    );
    const failureHtml = renderToStaticMarkup(
      <HomeMonitorContent
        runningEntries={[]}
        nonRunningEntries={[]}
        feedback="Could not copy session ID."
        onOpenSession={noOp}
        onShowContextMenu={noOp}
      />,
    );

    assert.doesNotMatch(emptyHtml, /role="status"/);
    assert.match(
      failureHtml,
      /role="status" aria-live="polite">Could not copy session ID\.<\/p>/,
    );
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
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archivedAt: null,
  }],
    canUsePrimaryFeatures = true,
    characterListFeedback = "",
    sessionWindowRestoreIds: readonly string[] = [],
    sessionWindowRestorePending = false,
    sessionWindowRestoreFeedback = "",
    sessionMonitorFeedback = "",
    characterLoadStatus: "loading" | "loaded" | "error" = "loaded",
  ) => renderToStaticMarkup(
    <HomeRightPane
      rightPaneView={rightPaneView}
      runningMonitorEntries={[]}
      nonRunningMonitorEntries={[]}
      auxiliaryDataState="ready"
      characterEntries={characters}
      characterLoadStatus={characterLoadStatus}
      characterListFeedback={characterListFeedback}
      monitorWindowIcon={<span>Monitor</span>}
      onChangeRightPaneView={noOp}
      onOpenSessionMonitorWindow={noOp}
      onOpenSettingsWindow={noOp}
      onRestoreSessionWindows={noOp}
      onCreateCharacter={noOp}
      onEditCharacter={noOp}
      onOpenSession={noOp}
      onShowSessionMonitorContextMenu={noOp}
      canUsePrimaryFeatures={canUsePrimaryFeatures}
      sessionWindowRestoreIds={sessionWindowRestoreIds}
      sessionWindowRestorePending={sessionWindowRestorePending}
      sessionWindowRestoreFeedback={sessionWindowRestoreFeedback}
      sessionMonitorFeedback={sessionMonitorFeedback}
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

  // @test-value v2
  // kind = "contract"
  // claim = "Home Characters tabはcharacter情報・検索・Create導線を表示し、旧Mate talkや既定カードを表示しない"
  // oracle = { type = "contract", ref = "Issue #731 Home Characters tab surface" }
  // fault = "Character tabが旧default/Mate talk surfaceへ戻るか、検索またはCreate導線を失う"
  // observable = "Characters見出し、Mia、説明文、検索label、Create icon、旧surfaceの不在"
  // observation_boundary = "component-behavior"
  // scope = "HomeRightPane Characters tab surface"
  // lifecycle = "permanent"
  // impact = "対象Characterの識別と作成導線を維持し、廃止したMate talk画面を復活させない"
  // distinction = "表示文字列だけでなく、旧surfaceを含む情報構造と検索/Create icon affordanceを同時に確認する"
  // @end-test-value
  it("Characters タブは character list と Create を表示する", () => {
    const html = renderHomeRightPane("characters");

    assert.ok(html.includes("Characters"));
    assert.ok(html.includes("Mia"));
    assert.ok(html.includes("説明文"));
    assert.ok(html.includes("home-create-icon"));
    assert.ok(!html.includes("<h3>Characters</h3>"));
    assert.ok(html.includes('aria-label="Search characters by name"'));
    assert.ok(!html.includes(">Default</span>"));
    assert.match(html, /<button class="home-character-card"/);
    assert.ok(!html.includes("home-character-card-edit"));
    assert.ok(!html.includes("2026-01-01T00:00:00.000Z"));
    assert.ok(!html.includes("Your Mate"));
    assert.ok(!html.includes("メイトーク"));
  });

  it("Character name 検索は前後の空白と大文字小文字を無視する", () => {
    const characters = [
      {
        id: "char-mia",
        name: "Mia",
        description: "説明文",
        iconFilePath: "",
        theme: { main: "#3b82f6", sub: "#1d4ed8" },
        state: "active" as const,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        archivedAt: null,
      },
      {
        id: "char-noah",
        name: "Noah",
        description: "別の説明文",
        iconFilePath: "",
        theme: { main: "#10b981", sub: "#047857" },
        state: "active" as const,
        createdAt: "2026-01-02T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
        archivedAt: null,
      },
    ];

    assert.deepEqual(filterCharactersByName(characters, " NOA ").map((character) => character.id), ["char-noah"]);
    assert.deepEqual(filterCharactersByName(characters, "   "), characters);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "Home Characters tabは取得済みCharacterが0件でも説明文を表示せずCreate icon導線を表示する"
  // oracle = { type = "contract", ref = "Issue #731 Home Characters empty state" }
  // fault = "候補が空のときCreate導線まで隠し、Character作成を開始できない"
  // observable = "home-create-iconとCreateCharacter accessible affordance"
  // observation_boundary = "component-behavior"
  // scope = "HomeRightPane Characters empty state"
  // lifecycle = "permanent"
  // impact = "初回利用者がCharacterを作成するための入口を失わない"
  // distinction = "loading/errorの状態ではなく、取得済み空一覧でCTAを維持する境界を確認する"
  // @end-test-value
  it("Character が空でも Create Character を表示できる", () => {
    const html = renderHomeRightPane("characters", []);
    assert.ok(html.includes("home-create-icon"));
    assert.ok(html.includes('aria-label="Create character"'));
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "Home Characters panelはcatalog取得中・失敗・取得済み空を別状態として投影する"
  // oracle = { type = "contract", ref = "Issue #731 Home Characters data-state distinction" }
  // fault = "初期取得中または失敗をNo characters yetへ投影し、未取得と正常な空一覧を混同する"
  // observable = "loading spinner/status、error表示とNo characters yetの相互排他"
  // observation_boundary = "component-behavior"
  // scope = "HomeCharactersPanel character catalog state"
  // lifecycle = "permanent"
  // impact = "Character作成導線で取得待ち・取得失敗・正常空一覧を正しく識別できる"
  // distinction = "候補配列の長さだけでなく、明示load stateによる表示分岐を検証する"
  // @end-test-value
  it("Character list は初期取得中と取得失敗を空状態と区別する", () => {
    const loadingHtml = renderHomeRightPane("characters", [], true, "", [], false, "", "", "loading");
    const errorHtml = renderHomeRightPane("characters", [], true, "", [], false, "", "", "error");

    assert.ok(loadingHtml.includes("home-session-list-load-spinner"));
    assert.ok(loadingHtml.includes("Loading characters…"));
    assert.ok(!loadingHtml.includes("No characters yet."));
    assert.ok(errorHtml.includes("Could not load characters."));
    assert.ok(!errorHtml.includes("No characters yet."));
  });

  // @test-value v2
  // kind = "contract"
  // claim = "Home Characters panelは一覧取得errorをpanel内feedbackへ表示し、Create icon導線を維持する"
  // oracle = { type = "contract", ref = "Issue #731 Home Characters data-state distinction" }
  // fault = "取得失敗を無表示または空一覧として扱い、失敗理由と作成導線を利用者から隠す"
  // observable = "Could not refresh characters. とCreate iconのpanel内markup"
  // observation_boundary = "component-behavior"
  // scope = "HomeRightPane Characters error feedback"
  // lifecycle = "permanent"
  // impact = "取得失敗を空一覧と区別しつつ、Character作成へ進む操作を維持する"
  // distinction = "汎用feedback stateではなく、Characters panel内のエラー表示とCTA共存を確認する"
  // @end-test-value
  it("Characters panel は一覧読み込み error を panel 内に表示する", () => {
    const html = renderHomeRightPane("characters", [], true, "Could not refresh characters.");

    assert.ok(html.includes("Could not refresh characters."));
    assert.ok(html.includes("home-create-icon"));
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

  // @test-value v2
  // kind = "contract"
  // claim = "HomeRightPaneのRestore Sessions操作は復元対象の有無と処理中状態をdisabledおよびaria-busyへ投影する"
  // oracle = { type = "contract", ref = "Issue #731 Home restore sessions action state" }
  // fault = "対象がない状態または復元処理中に操作できて重複要求が発生するか、対象があるのにdisabledのままになる"
  // observable = "Restore Sessions buttonのdisabled属性とaria-busy属性"
  // observation_boundary = "component-behavior"
  // scope = "HomeRightPane Restore sessions control"
  // lifecycle = "permanent"
  // impact = "復元操作の対象有無と処理中状態を識別し、重複要求を防ぐ"
  // distinction = "restore helperの入力選択ではなく、利用者が押すbuttonのdisabled/busy公開状態を確認する"
  // @end-test-value
  it("一括復元操作を上部へ常設し、対象なし・処理中をdisabledにする", () => {
    const emptyHtml = renderHomeRightPane("monitor");
    const enabledHtml = renderHomeRightPane("monitor", undefined, true, "", ["session-a", "session-b"]);
    const pendingHtml = renderHomeRightPane(
      "monitor",
      undefined,
      true,
      "",
      ["session-a", "session-b"],
      true,
    );

    assert.match(emptyHtml, /Restore Sessions/);
    assert.match(emptyHtml, /class="restore-session-windows-button"[^>]*disabled=""/);
    assert.match(enabledHtml, /Restore Sessions/);
    assert.doesNotMatch(enabledHtml, /class="restore-session-windows-button"[^>]*disabled=""/);
    assert.match(pendingHtml, /class="restore-session-windows-button"[^>]*disabled=""[^>]*aria-busy="true"/);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "HomeRightPaneのrestore feedbackは成功・対象なしではstatusを描画せず、失敗時だけ対象と理由をpolite live statusへ表示する"
  // oracle = { type = "contract", ref = "Issue #731 Home restore feedback accessibility" }
  // fault = "正常終了後も空statusを残すか、復元失敗時に対象と理由を支援技術へ通知できない"
  // observable = "success/failure HTMLのfeedback要素、role=status、aria-live=polite、失敗対象と理由"
  // observation_boundary = "component-behavior"
  // scope = "HomeRightPane session restore feedback rendering"
  // lifecycle = "permanent"
  // impact = "復元結果を重複通知せず、失敗時だけ利用者へ識別可能に伝える"
  // distinction = "builderの文字列だけでなく、空文字によるDOM非表示と失敗文字列のlive status描画を確認する"
  // @end-test-value
  it("復元feedbackは正常系でstatusを描画せず、失敗時だけlive statusを描画する", () => {
    const successHtml = renderHomeRightPane("monitor", undefined, true, "", ["session-a"]);
    const failureHtml = renderHomeRightPane(
      "monitor",
      undefined,
      true,
      "",
      ["session-b"],
      false,
      "Could not restore sessions: session-b (Deleted)",
    );

    assert.doesNotMatch(successHtml, /session-window-restore-feedback/);
    assert.doesNotMatch(successHtml, /role="status"/);
    assert.match(failureHtml, /session-b \(Deleted\)/);
    assert.match(failureHtml, /role="status" aria-live="polite"/);
    assert.doesNotMatch(failureHtml, /件のSessionを開きました/);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "HomeのMonitor tabはSession Monitor context menuの失敗feedbackを利用者向けlive statusへ表示する"
  // oracle = { type = "contract", ref = "HomeRightPane Session Monitor feedback" }
  // fault = "HomeAppから渡されたcontext menu失敗messageがright paneで欠落するか、支援技術へ通知されない"
  // observable = "Monitor tab内のfeedback文字列、role=status、aria-live=polite"
  // observation_boundary = "component-behavior"
  // scope = "HomeRightPane Session Monitor feedback rendering"
  // lifecycle = "permanent"
  // impact = "HomeからのSession Monitor操作失敗を利用者へ伝える"
  // distinction = "session restore feedbackやCharacters feedbackではなく、Session Monitor context menu専用の表示経路を検証する"
  // @end-test-value
  it("Session Monitor feedbackをMonitor tab内へ表示する", () => {
    const html = renderHomeRightPane(
      "monitor",
      undefined,
      true,
      "",
      [],
      false,
      "",
      "Could not copy session ID.",
    );

    const monitorPanel = html.match(/<section class="home-monitor-panel" role="tabpanel" aria-label="Session monitor">[\s\S]*?<\/section>/);
    assert.ok(monitorPanel);
    assert.match(monitorPanel[0], /Could not copy session ID\./);
    assert.match(monitorPanel[0], /role="status" aria-live="polite"/);
  });

  it("Character icon 未設定のとき fallback がレンダリングされ、画像タグは出力されない", () => {
    const html = renderHomeRightPane("characters", [{
      id: "char-2",
      name: "テストマテ",
      description: "説明文",
      iconFilePath: "",
      theme: { main: "#10b981", sub: "#047857" },
      state: "active",
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
