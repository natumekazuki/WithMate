import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { JSDOM } from "jsdom";
import React, { act, isValidElement, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import { HomeLaunchDialog } from "../../src/home/HomeLaunchDialog.js";
import type { DirectoryPathValidationState } from "../../src/launch/directory-path-validation.js";
import type { ProviderLaunchLoadStatus } from "../../src/launch/provider-launch-picker.js";
import { filterCharactersByName } from "../../src/home/HomeCharactersPanel.js";
import { HomeMonitorContent } from "../../src/home/HomeMonitorContent.js";
import {
  formatHomeSessionUpdatedAt,
  HomeRecentSessionsPanel,
} from "../../src/home/HomeRecentSessionsPanel.js";
import { HomeRightPane } from "../../src/home/HomeRightPane.js";
import { HomeHeader } from "../../src/home/HomeHeader.js";
import type { AuxiliarySessionSummary } from "../../src-shared/auxiliary/auxiliary-session-state.js";
import type { HomeMonitorEntry } from "../../src/home/home-session-projection.js";
import type {
  HomeSessionSummary,
  SessionSummary,
} from "../../src-shared/session/session-state.js";
import {
  HomeMateSetupPanel,
  type MateAvatarAction,
} from "../../src/mate/MateSetupPanel.js";
import {
  HomeSettingsContent,
  type HomeSettingsContentProps,
} from "../../src/settings/SettingsContent.js";
import { createDefaultAppSettings } from "../../src-shared/settings/provider-settings-state.js";
import type { ModelCatalogSnapshot } from "../../src-shared/settings/model-catalog.js";
import { buildHomeProviderSettingRows } from "../../src/settings/settings-view-model.js";
import { buildSettingsCommandHandlers } from "../../src/settings/settings-command-handlers.js";
import { buildSettingsDraftHandlers } from "../../src/settings/settings-draft-handlers.js";
import { useSettingsFeedback } from "../../src/settings/use-settings-feedback.js";
import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";
import { formatTimestampLabel } from "../../src-shared/time-state.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/** Home 設定の下書き、保存、取得状態と各操作の表示・アクセシビリティを検査する。 */
describe("HomeSettingsContent", () => {
  const modelCatalog: ModelCatalogSnapshot = {
    providers: [
      {
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
      },
      {
        id: "copilot",
        label: "Copilot",
        defaultModelId: "model-b",
        defaultReasoningEffort: "medium",
        models: [
          {
            id: "model-b",
            label: "Model B",
            reasoningEfforts: ["medium", "high"],
          },
          { id: "model-c", label: "Model C", reasoningEfforts: ["low"] },
        ],
      },
    ],
  };

  const settingsDraft = createDefaultAppSettings();
  const providerSettingRows = buildHomeProviderSettingRows(
    modelCatalog,
    settingsDraft,
  );
  /** 表示だけを確認する設定項目に、副作用を持たない既定のハンドラーを渡す。 */
  const noOp = (..._args: unknown[]) => undefined;

  /** 設定画面を組み立てるときに差し替えられる下書き、候補一覧、各種通知をまとめる。 */
  type RenderSettingsParams = {
    settingsDraft?: typeof settingsDraft;
    providerSettingRows?: typeof providerSettingRows;
    settingsFeedback?: string;
    settingsErrors?: ReadonlyMap<string, string>;
  };

  /** 既定の読込成功状態で設定画面を組み立て、シナリオごとに値や操作を差し替えられるようにする。 */
  const buildSettingsContent = (params?: RenderSettingsParams) => (
    <HomeSettingsContent
      settingsDraft={params?.settingsDraft ?? settingsDraft}
      providerSettingRows={params?.providerSettingRows ?? providerSettingRows}
      appSettingsLoadStatus="loaded"
      settingsDraftLoaded={true}
      appSettingsLoadError=""
      onRetryAppSettings={noOp}
      modelCatalogLoadStatus="loaded"
      modelCatalogLoadError=""
      onRetryModelCatalog={noOp}
      settingsDirty={false}
      settingsFeedback={params?.settingsFeedback ?? ""}
      settingsErrors={params?.settingsErrors ?? new Map()}
      sessionCleanupCutoffDate=""
      deletingOldSessions={false}
      onChangeAutoCollapseActionDockOnSend={noOp}
      onChangeCharacterDefinitionEnabled={noOp}
      onChangeCurrentDateEnabled={noOp}
      onChangeScrollToLatestOnSend={noOp}
      onChangePreviewWheelZoomStep={noOp}
      onChangeLaunchAtLoginEnabled={noOp}
      onChangeSessionTurnNotificationEnabled={noOp}
      onChangeSessionApprovalNotificationEnabled={noOp}
      onChangeSessionTurnNotificationResponsePreviewEnabled={noOp}
      onChangeKeyboardShortcuts={noOp}
      onChangeGlossaryProactiveCreateLimit={noOp}
      onChangeSessionCleanupCutoffDate={noOp}
      onChangeProviderEnabled={noOp}
      onChangeModelAvailability={noOp}
      onChangeWithMateAutoReview={noOp}
      onChangeProviderSkillRootPath={noOp}
      onChangeProviderSkillRelativePath={noOp}
      onChangeProviderInstructionRelativePath={noOp}
      onBrowseProviderSkillRootPath={noOp}
      onBrowseProviderSkillRelativePath={noOp}
      onBrowseProviderInstructionRelativePath={noOp}
      onOpenAppLogFolder={noOp}
      onOpenCrashDumpFolder={noOp}
      onDeleteSessionsLastActiveBefore={noOp}
      onSaveSettings={noOp}
    />
  );

  /** 設定画面を静的マークアップへ変換し、入力状態やラベルを DOM として比較できるようにする。 */
  const renderSettings = (params?: RenderSettingsParams) =>
    renderToStaticMarkup(buildSettingsContent(params));

  // @test-value v2
  // kind = "contract"
  // claim = "ProviderのModels入口とBackで同じ設定draftを編集し既存Saveへ渡し、入口へfocusを戻す"
  // oracle = { type = "contract", ref = "docs/design/settings-ui.md#model-management" }
  // fault = "管理画面を別draftへ分離してBackで編集を失うか保存payloadへ含めない"
  // observable = "Model checkbox、Unsaved Changes、Back後のfocus、Save callbackの設定"
  // observation_boundary = "component-behavior"
  // scope = "Settings内Model管理の入口から保存まで"
  // lifecycle = "permanent"
  // impact = "無効化が保存されたと思っても実行設定へ反映されない"
  // distinction = "管理component単体ではSettingsの画面切替と既存Saveの結線を通らない"
  // @end-test-value
  /** モデルの無効化を Back 後も下書きに保持し、元の入口へフォーカスを戻したうえで既存の保存操作へ値を渡す。 */
  it("Modelsの編集をBack後も保持して既存Saveへ渡す", async () => {
    await withSettingsDom(async (container, root) => {
      let saved: ReturnType<typeof createDefaultAppSettings> | undefined;
      /** 編集したモデル設定を下書きとして保持し、モデル詳細と設定一覧から同じ状態を参照させる。 */
      function View() {
        const [draft, setDraft] = useState(createDefaultAppSettings());
        return React.cloneElement(buildSettingsContent(), {
          settingsDraft: draft,
          providerSettingRows: buildHomeProviderSettingRows(
            modelCatalog,
            draft,
          ),
          settingsDirty:
            JSON.stringify(draft) !==
            JSON.stringify(createDefaultAppSettings()),
          /** モデル候補の有効・無効を、他の設定値を保ったまま下書きへ反映する。 */
          onChangeModelAvailability: (
            modelAvailability: typeof draft.modelAvailability,
          ) => setDraft((current) => ({ ...current, modelAvailability })),
          /** 保存時点の下書きを複製し、後の編集とは独立に送信値を検査する。 */
          onSaveSettings: () => {
            saved = structuredClone(draft);
          },
        });
      }
      await act(async () => root.render(<View />));
      /** 画面を戻した後にフォーカスを受け取る Models の入口を取得する。 */
      const entry = () =>
        container.querySelector<HTMLButtonElement>(
          '[aria-label="Manage Codex Models"]',
        )!;
      await act(async () => entry().click());
      assert.equal(container.querySelector("h2")?.textContent, "Codex Models");
      const model = container.querySelector<HTMLInputElement>(
        '.provider-model-row[title="gpt-5.4"] input',
      )!;
      await act(async () => model.click());
      assert.equal(model.checked, false);
      await act(async () =>
        [...container.querySelectorAll<HTMLButtonElement>("button")]
          .find((button) => button.textContent === "Back")!
          .click(),
      );
      assert.equal(document.activeElement, entry());
      assert.ok(container.textContent?.includes("Unsaved Changes"));
      await act(async () =>
        container
          .querySelector<HTMLButtonElement>('[aria-label="Save Settings"]')!
          .click(),
      );
      assert.deepEqual(saved?.modelAvailability.codex?.disabledModelIds, [
        "gpt-5.4",
      ]);
      await act(async () => entry().click());
      assert.equal(
        container.querySelector<HTMLInputElement>(
          '.provider-model-row[title="gpt-5.4"] input',
        )!.checked,
        false,
      );
    });
  });

  /** 設定コンポーネントを操作できる DOM と React root を用意し、終了後にテスト環境を復元する。 */
  async function withSettingsDom(
    check: (container: HTMLElement, root: Root) => Promise<void>,
  ) {
    const dom = new JSDOM(
      '<!doctype html><html><body><div id="root"></div></body></html>',
    );
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    const previousHTMLElement = globalThis.HTMLElement;
    Object.defineProperty(globalThis, "window", {
      value: dom.window,
      configurable: true,
    });
    Object.defineProperty(globalThis, "document", {
      value: dom.window.document,
      configurable: true,
    });
    Object.defineProperty(globalThis, "HTMLElement", {
      value: dom.window.HTMLElement,
      configurable: true,
    });
    const container = dom.window.document.getElementById("root")!;
    const root = createRoot(container);
    try {
      await check(container, root);
    } finally {
      await act(async () => root.unmount());
      Object.defineProperty(globalThis, "window", {
        value: previousWindow,
        configurable: true,
      });
      Object.defineProperty(globalThis, "document", {
        value: previousDocument,
        configurable: true,
      });
      Object.defineProperty(globalThis, "HTMLElement", {
        value: previousHTMLElement,
        configurable: true,
      });
      dom.window.close();
    }
  }

  // @test-value v2
  // kind = "contract"
  // claim = "承認審査は既定Offで、Codexの明示的なProvider・Model・Depthの選択が揃うまで保存できない"
  // oracle = { type = "contract", ref = "docs/design/withmate-auto-review.md#設定と適用範囲" }
  // fault = "初期状態で審査が選択済みになる、不完全な設定で保存できる、または明示した選択がSaveに渡らない"
  // observable = "Provider初期値、各選択後のSaveボタン、Save callbackが捕捉した設定"
  // observation_boundary = "component-behavior"
  // scope = "SettingsのWithMate Auto Review設定と既存Save"
  // lifecycle = "permanent"
  // distinction = "永続化testでは選択途中のSave抑止と明示した選択の受け渡しを扱えない"
  // @end-test-value
  /** 自動審査を初期状態では無効にし、Provider・モデル・推論深度の選択をすべて揃えた後にだけ保存可能とする。 */
  it("keeps approval review off until a complete selection is saved", async () => {
    await withSettingsDom(async (container, root) => {
      const initial = createDefaultAppSettings();
      initial.codingProviderSettings.codex = {
        enabled: true,
        apiKey: "",
        skillRootPath: "",
      };
      initial.codingProviderSettings.claude = {
        enabled: true,
        apiKey: "",
        skillRootPath: "",
      };
      const catalog: ModelCatalogSnapshot = {
        providers: [
          {
            id: "codex",
            label: "Codex",
            defaultModelId: "other",
            defaultReasoningEffort: "low",
            models: [
              {
                id: "gpt-6-luna",
                label: "GPT-6 Luna",
                reasoningEfforts: ["low", "high"],
              },
            ],
          },
          {
            id: "claude",
            label: "Claude",
            defaultModelId: "sonnet",
            defaultReasoningEffort: "",
            models: [{ id: "sonnet", label: "Sonnet", reasoningEfforts: [] }],
          },
        ],
      };
      let saved: typeof initial.withMateAutoReview | undefined;
      /** 承認審査の選択を制御された下書きで保持し、保存操作で初めて確定値を記録する。 */
      function View() {
        const [draft, setDraft] = useState(initial);
        return React.cloneElement(buildSettingsContent(), {
          settingsDraft: draft,
          providerSettingRows: buildHomeProviderSettingRows(catalog, draft),
          settingsDirty: draft !== initial,
          /** 審査設定の更新を、他の設定を変えず draft へ反映する。 */
          onChangeWithMateAutoReview: (
            withMateAutoReview: typeof initial.withMateAutoReview,
          ) => setDraft((current) => ({ ...current, withMateAutoReview })),
          /** Save を押した時点の審査設定を検査用に保存する。 */
          onSaveSettings: () => {
            saved = draft.withMateAutoReview;
          },
        });
      }
      await act(async () => root.render(<View />));
      const area = [...container.querySelectorAll("details")].find(
        (element) =>
          element.querySelector("summary")?.textContent ===
          "WithMate Auto Review",
      )!;
      /** 審査設定の Provider、モデル、推論深度の各選択欄を現在の DOM から取り出す。 */
      const controls = () => area.querySelectorAll("select");
      /** 選択に応じて操作可否が変わる Save Settings を取得する。 */
      const save = () =>
        container.querySelector<HTMLButtonElement>(
          '[aria-label="Save Settings"]',
        )!;
      /** 指定の選択欄へ値を入れて変更イベントを送り、設定画面を更新する。 */
      const choose = async (index: number, value: string) => {
        const control = controls()[index];
        await act(async () => {
          control.value = value;
          control.dispatchEvent(new window.Event("change", { bubbles: true }));
        });
      };
      assert.equal(controls()[0].value, "");
      assert.ok(
        controls()[0].querySelector('option[value="claude"]:not(:disabled)'),
      );
      await choose(0, "codex");
      assert.equal(save().disabled, true);
      await choose(1, "gpt-6-luna");
      assert.equal(save().disabled, true);
      await choose(2, "high");
      assert.equal(save().disabled, false);
      assert.equal(saved, undefined);
      await act(async () => save().click());
      assert.deepEqual(saved, {
        providerId: "codex",
        model: "gpt-6-luna",
        reasoningEffort: "high",
      });
    });
  });

  // @test-value v2
  // kind = "contract"
  // claim = "Settingsは設定読込失敗時にもversion取得失敗を再試行し取得値を本文末尾に表示する"
  // oracle = { type = "contract", ref = "docs/design/settings-ui.md#layout; docs/design/settings-ui.md#settings-runtime" }
  // fault = "設定読込失敗がversion表示や再試行を隠すか取得値を表示しない"
  // observable = "本文末尾の取得失敗、Retry後のversionとSave Settingsのdisabled状態"
  // observation_boundary = "component-behavior"
  // scope = "Settings app version"
  // lifecycle = "permanent"
  // distinction = "IPC testは設定読込失敗との独立性と利用者に見える再試行を検証しない"
  // @end-test-value
  /** 設定の読込に失敗して保存が無効でも、別に取得するアプリ版はエラー後に再試行し、設定本文の末尾に表示できる。 */
  it("設定読込失敗時もApp versionを再試行して表示する", async () => {
    await withSettingsDom(async (container, root) => {
      let calls = 0;
      window.withmate = {
        /** 版の取得を一度失敗させ、再試行時には表示用の版を返す。 */
        getAppVersion: async () => {
          calls++;
          if (calls === 1) throw new Error("unavailable");
          return "7.0.1-preview.2";
        },
      } as WithMateWindowApi;
      await act(async () =>
        root.render(
          React.cloneElement(buildSettingsContent(), {
            settingsDraftLoaded: false,
            appSettingsLoadStatus: "error",
            appSettingsLoadError: "Settings unavailable",
          }),
        ),
      );
      const version = container.querySelector<HTMLElement>(
        ".settings-app-version",
      )!;
      assert.equal(version.parentElement?.lastElementChild, version);
      assert.match(version.textContent!, /Could not load app version/);
      const retry = version.querySelector<HTMLButtonElement>("button")!;
      await act(async () => retry.click());
      assert.match(version.textContent!, /7\.0\.1-preview\.2/);
      assert.equal(
        container.querySelector<HTMLButtonElement>(
          '[aria-label="Save Settings"]',
        )?.disabled,
        true,
      );
      assert.equal(calls, 2);
      await act(async () => root.render(buildSettingsContent()));
      assert.equal(
        container.querySelector(".settings-section")?.lastElementChild,
        version,
      );
      assert.match(version.textContent!, /7\.0\.1-preview\.2/);
    });
  });

  // @test-value v2
  // kind = "contract"
  // claim = "Settingsの親section開閉と別sectionのdraft更新を挟んでも、子disclosure状態とprovider入力DOM・選択・draftを保持し、開閉だけでは保存しない"
  // oracle = { type = "contract", ref = "docs/design/settings-ui.md#decision" }
  // fault = "親を閉じて子を再生成し入力や選択・開閉を失うか、別section更新でdraftを巻き戻すか、開閉時に保存する"
  // observable = "Provider File SettingsとNotificationsのopen、provider入力のDOM同一性・選択範囲・値、Save回数とpayload"
  // observation_boundary = "component-behavior"
  // scope = "Settings disclosureをまたぐprovider入力とPrompt Context draft保持"
  // lifecycle = "permanent"
  // distinction = "provider入力値を持つdraftから開始し、enable編集と別section更新を挟んだ保持を確認する。テキスト入力event自体の再現ではない"
  // @end-test-value
  /** 親セクションの開閉や別項目の変更を挟んでも、Provider 入力欄の値と選択範囲、入れ子の開閉状態を維持し、明示保存時にまとめて渡す。 */
  it("section開閉と別section編集を挟んでもprovider入力と子disclosureを保持してSaveへ渡す", async () => {
    await withSettingsDom(async (container, root) => {
      let saved: ReturnType<typeof createDefaultAppSettings> | undefined;
      let saves = 0;
      /** 複数セクションでひとつの draft を編集し、開閉と保存回数を観測できるようにする。 */
      function View() {
        const [draft, setDraft] = useState<
          ReturnType<typeof createDefaultAppSettings>
        >(() => {
          const defaults = createDefaultAppSettings();
          return {
            ...defaults,
            codingProviderSettings: {
              ...defaults.codingProviderSettings,
              codex: {
                ...defaults.codingProviderSettings.codex,
                skillRootPath: "C:/provider-config",
              },
            },
          };
        });
        const handlers = buildSettingsDraftHandlers({
          setSettingsDraft: setDraft,
        });
        return React.cloneElement(buildSettingsContent(), {
          ...handlers,
          settingsDraft: draft,
          providerSettingRows: buildHomeProviderSettingRows(
            modelCatalog,
            draft,
          ),
          settingsDirty:
            JSON.stringify(draft) !==
            JSON.stringify(createDefaultAppSettings()),
          /** 明示保存の回数を数え、最後のイベント時に送られた設定を保持する。 */
          onSaveSettings: () => {
            saves++;
            saved = structuredClone(draft);
          },
        });
      }
      await act(async () => root.render(<View />));
      const sections = [
        ...container.querySelectorAll<HTMLDetailsElement>(
          "details.settings-section-card",
        ),
      ];
      /** 見出しタイトルから実際の折りたたみ要素を特定し、存在しない場合は検査を失敗させる。 */
      const section = (title: string) => {
        const found = sections.find(
          (entry) => entry.querySelector("summary")?.textContent === title,
        );
        assert.ok(found);
        return found;
      };
      const providers = section("Coding Agent Providers");
      const codex = providers.querySelector<HTMLDetailsElement>(
        "details.settings-provider-card",
      )!;
      const fileSettings = codex.querySelector<HTMLDetailsElement>(
        "details.settings-provider-file-settings",
      )!;
      const notifications = section("App").querySelector<HTMLDetailsElement>(
        "details.settings-subsection",
      )!;
      const input =
        fileSettings.querySelector<HTMLInputElement>('input[type="text"]')!;
      assert.ok(input);
      await act(async () =>
        codex
          .querySelector<HTMLInputElement>('input[type="checkbox"]')!
          .click(),
      );
      input.setSelectionRange(3, 9);
      await act(async () => {
        fileSettings.querySelector("summary")!.click();
        codex.querySelector("summary")!.click();
        providers.querySelector("summary")!.click();
        notifications.querySelector("summary")!.click();
        section("App").querySelector("summary")!.click();
      });
      await act(async () =>
        container
          .querySelector<HTMLInputElement>(
            "#settings-prompt-context-current-date",
          )!
          .click(),
      );
      assert.equal(providers.open, false);
      assert.equal(section("App").open, false);
      assert.equal(section("Prompt Context").open, true);
      await act(async () => {
        providers.querySelector("summary")!.click();
        section("App").querySelector("summary")!.click();
      });
      assert.equal(codex.open, false);
      assert.equal(fileSettings.open, false);
      assert.equal(notifications.open, false);
      await act(async () => {
        codex.querySelector("summary")!.click();
        fileSettings.querySelector("summary")!.click();
      });
      assert.equal(fileSettings.querySelector('input[type="text"]'), input);
      assert.equal(input.value, "C:/provider-config");
      assert.equal(input.selectionStart, 3);
      assert.equal(input.selectionEnd, 9);
      assert.equal(saves, 0);
      await act(async () =>
        container
          .querySelector<HTMLButtonElement>('[aria-label="Save Settings"]')!
          .click(),
      );
      assert.equal(saves, 1);
      assert.equal(
        saved?.codingProviderSettings.codex.skillRootPath,
        "C:/provider-config",
      );
      assert.equal(saved?.codingProviderSettings.codex.enabled, false);
      assert.equal(saved?.currentDateEnabled, false);
    });
  });

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
  /** 通知と送信後の表示を制御する四つの設定名が、App 設定で規定の大文字表記になることを確認する。 */
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
  // impact = "ユーザーが2つの prompt context の設定面を見つけられないか、既定状態を判断できない"
  // distinction = "個別 state/action の保存handlerは draft test に分け、static DOMではsection labelと既定stateだけを確認する"
  // @end-test-value
  /** Prompt Context の二つの機能を別々のチェックボックスにし、各ラベルが対応する入力と結び付き、既定では両方とも有効とする。 */
  it("Prompt Context に2項目の個別 toggle を既定有効で表示する", () => {
    const html = renderSettings();
    const document = new JSDOM(html).window.document;
    const promptContextSection = Array.from(
      document.querySelectorAll("details.settings-section-card"),
    ).find(
      (section) =>
        section.querySelector("summary")?.textContent === "Prompt Context",
    );

    assert.ok(promptContextSection);
    assert.equal(
      promptContextSection.querySelector("summary")?.textContent,
      "Prompt Context",
    );

    const promptContextLabels = [
      "Character Definition Snapshot",
      "Current Date",
    ];
    const promptContextRows = Array.from(
      promptContextSection.querySelectorAll(".settings-provider-toggle-row"),
    );
    assert.equal(promptContextRows.length, promptContextLabels.length);
    assert.deepEqual(
      promptContextRows.map(
        (row) =>
          row.querySelector<HTMLLabelElement>("label.settings-provider-name")
            ?.textContent,
      ),
      promptContextLabels,
    );

    for (const row of promptContextRows) {
      const label = row.querySelector<HTMLLabelElement>(
        "label.settings-provider-name",
      );
      const input = row.querySelector<HTMLInputElement>(
        'input[type="checkbox"]',
      );

      assert.ok(label);
      assert.ok(input);
      assert.equal(input.checked, true);
      assert.equal(label.htmlFor, input.id);
    }
    assert.equal(
      promptContextSection.querySelectorAll('input[type="checkbox"]').length,
      promptContextLabels.length,
    );
    assert.equal(
      promptContextSection.querySelectorAll('input[type="checkbox"]:checked')
        .length,
      promptContextLabels.length,
    );
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
  /** Glossary の自動作成上限を現在値と 0〜100 の範囲を持つ数値欄で公開し、明示的な作成要求には適用しないと案内する。 */
  it("Repository Glossaryにproactive create上限を0から100のnumber inputで表示する", () => {
    const document = new JSDOM(renderSettings()).window.document;
    const label = Array.from(document.querySelectorAll("label")).find(
      (candidate) =>
        candidate.textContent?.includes("Glossary Proactive Create Limit"),
    );
    const input = label?.querySelector("input");

    assert.equal(input?.type, "number");
    assert.equal(input?.min, "0");
    assert.equal(input?.max, "100");
    assert.equal(input?.value, "5");
    assert.ok(label?.textContent?.includes("explicit requests"));
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "response previewはturn通知無効時だけdisabledで値を保持し、承認通知checkboxはturn通知と独立して有効な状態で値を表示する"
  // oracle = { type = "contract", ref = "docs/design/settings-ui.md#layout" }
  // fault = "turn通知無効でもpreviewを編集できるかpreviewの値を失うか承認通知がturn通知へ従属する"
  // observable = "turn通知enabled/disabled両条件でのpreviewと承認通知inputのdisabledとchecked"
  // observation_boundary = "component-behavior"
  // scope = "home-settings-notification-preview-dependency"
  // lifecycle = "permanent"
  // @end-test-value
  /** 実行通知を無効にした間も返答プレビューの値を保持して操作だけを止める。承認通知は親設定から独立して操作できる。 */
  it("返答 preview toggle は Session turn notification が無効な間だけ操作できない", () => {
    const disabledHtml = renderSettings({
      settingsDraft: {
        ...settingsDraft,
        sessionTurnNotificationEnabled: false,
        sessionTurnNotificationResponsePreviewEnabled: true,
        sessionApprovalNotificationEnabled: true,
      },
    });
    const enabledHtml = renderSettings({
      settingsDraft: {
        ...settingsDraft,
        sessionTurnNotificationEnabled: true,
        sessionTurnNotificationResponsePreviewEnabled: true,
        sessionApprovalNotificationEnabled: false,
      },
    });
    /** 描画結果のラベルから返答プレビュー用のチェックボックスを特定する。 */
    const findPreviewToggle = (html: string) => {
      const document = new JSDOM(html).window.document;
      const label = Array.from(document.querySelectorAll("label")).find(
        (candidate) =>
          candidate.textContent?.includes("Notification Response Preview"),
      );
      return label?.querySelector("input");
    };

    assert.equal(findPreviewToggle(disabledHtml)?.disabled, true);
    assert.equal(findPreviewToggle(disabledHtml)?.checked, true);
    assert.equal(findPreviewToggle(enabledHtml)?.disabled, false);
    assert.equal(findPreviewToggle(enabledHtml)?.checked, true);
    /** 承認通知のチェックボックスを、実行通知やプレビューと混同せず取得する。 */
    const findApprovalToggle = (html: string) => {
      const document = new JSDOM(html).window.document;
      const label = Array.from(document.querySelectorAll("label")).find(
        (candidate) =>
          candidate.textContent?.includes("Session Approval Notification"),
      );
      return label?.querySelector("input");
    };
    assert.equal(findApprovalToggle(disabledHtml)?.disabled, false);
    assert.equal(findApprovalToggle(disabledHtml)?.checked, true);
    assert.equal(findApprovalToggle(enabledHtml)?.disabled, false);
    assert.equal(findApprovalToggle(enabledHtml)?.checked, false);
  });

  /** 保存済み Mate の破壊的な初期化を、この設定画面から操作できないことを検査する。 */
  it("Mate Reset の危険操作は Settings に表示されない", () => {
    const html = renderSettings();
    assert.ok(!html.includes("Mate を初期化"));
    assert.ok(!html.includes("保存済みの Mate の状態を破壊的に初期化する"));
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
  /** Provider ごとのファイル設定に、ルートと Skill・Instruction の二つの相対パス欄を表示する。 */
  it("provider ごとの file settings を表示する", () => {
    const html = renderSettings();

    assert.ok(html.includes("Provider File Settings"));
    assert.ok(html.includes("Root Directory"));
    assert.ok(html.includes("Skill Relative Path"));
    assert.ok(html.includes("Instruction Relative Path"));
  });

  // @test-value v2
  // kind = "contract"
  // claim = "OpenCodeのprovider rowはOpenCode側の認証設定とnative file設定先を案内する"
  // oracle = { type = "contract", ref = "docs/design/settings-ui.md#current-scope" }
  // fault = "WithMateが管理しない認証やnative file設定の場所を案内しない"
  // observable = "OpenCode rowの認証設定先とnative path案内"
  // observation_boundary = "component-behavior"
  // scope = "settings-opencode-provider-card"
  // lifecycle = "permanent"
  // impact = "利用者が必要な認証設定とfile設定の場所を判断できない"
  // distinction = "設定型とdraft単体testではprovider rowに表示される案内を確認できない"
  // @end-test-value
  /** OpenCode の行に、認証は OpenCode 側で設定することと、ネイティブの構成・Skill の配置場所を案内する。 */
  it("OpenCodeの認証設定先とnative読込先をprovider rowに表示する", () => {
    const draft = createDefaultAppSettings();
    draft.codingProviderSettings.opencode = {
      enabled: true,
      apiKey: "",
      skillRootPath: "",
    };
    const catalog: ModelCatalogSnapshot = {
      providers: [
        {
          id: "opencode",
          label: "OpenCode",
          defaultModelId: "opencode-go/glm-5.3",
          defaultReasoningEffort: "high",
          models: [
            {
              id: "opencode-go/glm-5.3",
              label: "GLM-5.3",
              reasoningEfforts: ["low", "high", "max"],
            },
          ],
        },
      ],
    };
    const html = renderSettings({
      settingsDraft: draft,
      providerSettingRows: buildHomeProviderSettingRows(catalog, draft),
    });
    const dom = new JSDOM(html);
    try {
      const card = dom.window.document.querySelector(
        ".settings-provider-card",
      )!;
      assert.match(
        card.textContent ?? "",
        /Configure authentication in OpenCode\./,
      );
      assert.match(
        card.textContent ?? "",
        /OpenCode config root with AGENTS\.md and skills\/<name>\/SKILL\.md/,
      );
    } finally {
      dom.window.close();
    }
  });

  // @test-value v2
  // kind = "contract"
  // claim = "Providerの各Browseはクリックした対象だけをbusyとして通知し、応答待ちの重複実行を抑止して完了後に操作を戻す"
  // oracle = { type = "contract", ref = "docs/design/ui-design-guidelines.md#ボタン" }
  // fault = "同じ種類の別Providerボタンへbusyを表示する、異なるBrowseを重複実行する、または応答後も操作を無効にする"
  // observable = "各ProviderのRoot/Skill/Instruction Browse callback引数と回数、buttonのaria-busy/disabled/accessible name/spinner、完了後の操作可否"
  // observation_boundary = "component-behavior"
  // scope = "HomeSettingsContent provider browse actions"
  // lifecycle = "permanent"
  // impact = "利用者と支援技術が実際に実行中のProvider操作を識別でき、pickerの二重起動を防ぐ"
  // distinction = "型やstatic markupでは検出できない複数Providerを同時表示した非同期操作中と完了後の投影を、既存componentで検証する"
  // @end-test-value
  /** Browse 待機中は競合するボタンを無効にするが、実際に押した Provider と操作だけを busy にして完了後に戻す。 */
  it("Browseのbusyは実行したProviderと操作に限定し、完了後に解除する", async () => {
    const dom = new JSDOM(
      '<!doctype html><html><body><div id="root"></div></body></html>',
    );
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    const previousHTMLElement = globalThis.HTMLElement;
    Object.defineProperty(globalThis, "window", {
      value: dom.window,
      configurable: true,
    });
    Object.defineProperty(globalThis, "document", {
      value: dom.window.document,
      configurable: true,
    });
    Object.defineProperty(globalThis, "HTMLElement", {
      value: dom.window.HTMLElement,
      configurable: true,
    });
    const container = dom.window.document.getElementById("root")!;
    const root = createRoot(container);
    const calls: Array<{ kind: string; providerId: string }> = [];
    let release!: () => void;
    /** Browse の種別と Provider を記録し、ボタン状態を確認するまで選択結果を保留する。 */
    const browse = (kind: string, providerId: string) => {
      calls.push({ kind, providerId });
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    };
    try {
      await act(async () =>
        root.render(
          React.cloneElement(buildSettingsContent(), {
            /** ルート選択を、その操作の種別と対象 Provider で記録する。 */
            onBrowseProviderSkillRootPath: (id: string) => browse("root", id),
            /** Skill 相対パスの選択を、同じ Provider の他の Browse 操作と区別する。 */
            onBrowseProviderSkillRelativePath: (id: string) =>
              browse("skill", id),
            /** Instruction 相対パスの選択が、正しい Provider に渡るか観測する。 */
            onBrowseProviderInstructionRelativePath: (id: string) =>
              browse("instruction", id),
          }),
        ),
      );
      const buttons = [
        ...container.querySelectorAll<HTMLButtonElement>(
          ".settings-provider-card .settings-provider-input button",
        ),
      ];
      assert.equal(buttons.length, 6);
      for (const [providerIndex, providerId] of [
        "codex",
        "copilot",
      ].entries()) {
        for (const [actionIndex, kind] of [
          "root",
          "skill",
          "instruction",
        ].entries()) {
          const selected = buttons[providerIndex * 3 + actionIndex]!;
          const previousCalls = calls.length;
          await act(async () => selected.click());
          assert.deepEqual(calls.at(-1), { kind, providerId });
          assert.equal(calls.length, previousCalls + 1);
          for (const button of buttons) {
            assert.equal(button.disabled, true);
            assert.equal(
              button.getAttribute("aria-busy"),
              String(button === selected),
            );
            assert.equal(
              button.querySelectorAll(".loading-indicator-spinner").length,
              button === selected ? 1 : 0,
            );
          }
          assert.ok(
            selected
              .getAttribute("aria-label")
              ?.includes(providerSettingRows[providerIndex]!.provider.label),
          );
          await act(async () => {
            for (const button of buttons) button.click();
          });
          assert.equal(calls.length, previousCalls + 1);
          await act(async () => release());
          for (const button of buttons) {
            assert.equal(button.disabled, false);
            assert.equal(button.getAttribute("aria-busy"), "false");
            assert.equal(
              button.querySelectorAll(".loading-indicator-spinner").length,
              0,
            );
          }
        }
      }
    } finally {
      await act(async () => root.unmount());
      Object.defineProperty(globalThis, "window", {
        value: previousWindow,
        configurable: true,
      });
      Object.defineProperty(globalThis, "document", {
        value: previousDocument,
        configurable: true,
      });
      Object.defineProperty(globalThis, "HTMLElement", {
        value: previousHTMLElement,
        configurable: true,
      });
      dom.window.close();
    }
  });

  // @test-value v2
  // kind = "contract"
  // claim = "Settings操作は設定・Session更新、native pickerの実際の競合だけを排他し、独立した導線と日付編集を維持する"
  // oracle = { type = "contract", ref = "docs/design/ui-design-guidelines.md#操作とアクセシビリティ; docs/design/settings-ui.md#runtime-policy" }
  // fault = "保存とSession削除の競合を許可する、独立操作を停止する、重複要求を受け付ける、または競合待ちbuttonを実行中として通知する"
  // observable = "設定保存・picker・Session削除の各操作buttonのdisabled/aria-busy/spinner、同一tickのcallback回数、Session削除日付の編集可否、完了後の解除"
  // observation_boundary = "component-behavior"
  // scope = "HomeSettingsContent action conflicts"
  // lifecycle = "permanent"
  // impact = "Settings・Session更新とpickerの競合を防ぎ、診断や回復の入口を利用できる状態に保つ"
  // distinction = "型・static markup・Main単体testでは分からない非同期callbackとbutton制御の接続を、少数の競合群で確認する"
  // @end-test-value
  /** 保存と削除、または picker の競合だけを排他し、実行した操作に限って進行中を公開する。削除時だけ対象日も編集不可とする。 */
  it("操作の競合範囲だけをdisabledにし、実行したbuttonだけをbusyにする", async () => {
    const updates = ["Save Settings", "Delete"];
    const dialogs = ["Browse"];
    const cases = [
      { label: "Save Settings", blocked: updates },
      { label: "Delete", blocked: updates },
      { label: "Browse", blocked: dialogs },
    ];
    for (const scenario of cases) {
      await withSettingsDom(async (container, root) => {
        let calls = 0;
        let release!: () => void;
        /** 同一タイミングの多重実行を数えられるように、操作を手動で解除するまで待機させる。 */
        const pending = () => {
          calls += 1;
          return new Promise<void>((resolve) => {
            release = resolve;
          });
        };
        await act(async () =>
          root.render(
            React.cloneElement(buildSettingsContent({}), {
              settingsDirty: true,
              sessionCleanupCutoffDate: "2026-01-01",
              onSaveSettings: pending,
              onDeleteSessionsLastActiveBefore: pending,
              onBrowseProviderSkillRootPath: pending,
              onBrowseProviderSkillRelativePath: pending,
              onBrowseProviderInstructionRelativePath: pending,
            }),
          ),
        );
        const buttons = [
          ...container.querySelectorAll<HTMLButtonElement>(
            "button[aria-busy][aria-label]",
          ),
        ];
        const labels = new Map(
          buttons.map((button) => [button, button.getAttribute("aria-label")!]),
        );
        const selected = buttons.find(
          (button) => labels.get(button) === scenario.label,
        )!;
        await act(async () => {
          selected.click();
          selected.click();
        });
        assert.equal(calls, 1, `${scenario.label}: duplicate request`);
        for (const button of buttons) {
          const label = labels.get(button)!;
          assert.equal(
            button.disabled,
            scenario.blocked.includes(label),
            `${scenario.label}: ${label}`,
          );
          assert.equal(
            button.getAttribute("aria-busy"),
            String(button === selected),
          );
          assert.equal(
            button.querySelectorAll(".loading-indicator-spinner").length,
            button === selected ? 1 : 0,
          );
        }
        assert.notEqual(
          container.querySelector(".settings-panel")!.getAttribute("aria-busy"),
          "true",
        );
        assert.equal(
          container.querySelector<HTMLInputElement>('input[type="date"]')!
            .disabled,
          scenario.label === "Delete",
        );
        await act(async () => release());
        for (const button of buttons) {
          assert.equal(button.disabled, false);
          assert.equal(button.getAttribute("aria-busy"), "false");
        }
      });
    }
  });

  // @test-value v2
  // kind = "contract"
  // claim = "Settingsの入力修正案内は診断詳細へ隠さず、別操作の成功後も残り、明示的なdraft編集で通知を解除する"
  // oracle = { type = "contract", ref = "docs/design/ui-design-guidelines.md#読込・空・失敗; docs/design/settings-ui.md#interaction" }
  // fault = "未設定のroot directoryの修正案内を診断popoverへ隠す、別操作の成功で案内を消す、または編集後にも失敗通知が残る"
  // observable = "実handler接続後のroot directory修正feedback、別操作の診断詳細、編集後の通知解除とcheckbox"
  // observation_boundary = "component-behavior"
  // scope = "Settings actionable validation feedback"
  // lifecycle = "permanent"
  // impact = "folder選択に必要な入力を利用者がその場で判断でき、古い失敗を新しい編集へ持ち越さない"
  // distinction = "handler単体の文字列確認や型では分からない、診断と修正案内のUI投影および並行通知の保持を確認する"
  // @end-test-value
  /** 入力修正の案内は診断詳細と分けて直接表示し、別の操作に成功しても保持して、実際の設定変更で解除する。 */
  it("入力修正の案内は直接表示し、無関係な成功で消さない", async () => {
    await withSettingsDom(async (container, root) => {
      const api = {
        /** ログを開く操作で診断詳細に表示すべきエラーを返す。 */
        openAppLogFolder: async (): Promise<void> => {
          throw new Error("Log folder diagnostic");
        },
        /** 別操作の成功が入力修正の案内を消さないか調べるため、ダンプを開く操作だけ成功させる。 */
        openCrashDumpFolder: async (): Promise<void> => undefined,
      } as WithMateWindowApi;
      /** 実際の設定通知状態と、設定操作・入力変更の本番ハンドラーを描画へ接続する。 */
      function Harness() {
        const [draft, setDraft] = useState(settingsDraft);
        const {
          settingsFeedback,
          settingsErrors,
          setSettingsFeedback,
          clearSettingsFeedback,
        } = useSettingsFeedback();
        return React.cloneElement(
          buildSettingsContent({
            settingsDraft: draft,
            settingsFeedback,
            settingsErrors,
          }),
          {
            ...buildSettingsCommandHandlers({
              /** ログとダンプを開くテスト用 API を、実際の設定操作へ供給する。 */
              getApi: () => api,
              persistedSettingsDraft: draft,
              setAppSettings: noOp,
              setSettingsDraft: setDraft,
              setSettingsFeedback,
            }),
            ...buildSettingsDraftHandlers({
              setSettingsDraft: setDraft,
              clearSettingsFeedback,
            }),
          },
        );
      }
      await act(async () => root.render(<Harness />));
      /** 操作名に一致する Settings のボタンをその場の DOM から選ぶ。 */
      const button = (name: string) =>
        container.querySelector<HTMLButtonElement>(
          `button[aria-label="${name}"]`,
        )!;
      await act(async () => button("Open Logs").click());
      const skillField = [
        ...container.querySelectorAll(".settings-provider-input"),
      ].find((element) =>
        element.textContent?.startsWith("Skill Relative Path"),
      )!;
      await act(async () =>
        skillField
          .querySelector<HTMLButtonElement>('button[aria-label="Browse"]')!
          .click(),
      );
      /** 診断ポップアップとは別に、直接表示された修正案内の本文を読む。 */
      const guidance = () =>
        container.querySelector(".settings-feedback")?.textContent;
      assert.equal(
        guidance(),
        "Set a root directory before choosing a skill folder.",
      );
      assert.equal(
        container.querySelector('[aria-label="Open Logs error details"] p')
          ?.textContent,
        "Log folder diagnostic",
      );
      await act(async () => button("Open Crash Dumps").click());
      assert.equal(
        guidance(),
        "Set a root directory before choosing a skill folder.",
      );
      const launch = container.querySelector<HTMLInputElement>(
        '.settings-section-toggle input[type="checkbox"]',
      )!;
      await act(async () => launch.click());
      assert.equal(launch.checked, !settingsDraft.launchAtLoginEnabled);
      assert.equal(guidance(), undefined);
      assert.equal(container.querySelector("[popover]"), null);
    });
  });

  // @test-value v2
  // kind = "security"
  // claim = "Storage maintenanceはDelete Old Sessionsと選択日より前を対象にし実行中Sessionを保持するhelpを表示する"
  // oracle = { type = "contract", ref = "docs/design/settings-ui.md#current-scope" }
  // fault = "削除対象の日付境界を説明せず、任意のSessionまたは実行中Sessionを削除する操作と誤認させる"
  // observable = "delete labelとcleanup date・Running sessions are keptのhelp"
  // observation_boundary = "component-behavior"
  // scope = "home-settings-session-cleanup"
  // lifecycle = "permanent"
  // @end-test-value
  /** 指定日より前に最終利用した Session を対象にする削除操作と、実行中 Session は保持する旨を表示する。 */
  it("古い Session の削除操作を Settings に表示する", () => {
    const html = renderSettings();

    assert.match(html, /Delete Old Sessions/);
    assert.match(html, /Delete sessions last active before the selected date/);
    assert.match(html, /Running sessions are kept\./);
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
  /** Provider が正常にゼロ件でも設定セクションの見出しを残し、空一覧をエラーのようには案内しない。 */
  it("provider row が 0 件でも Coding Agent Providers section を残し本文を空にする", () => {
    const html = renderSettings({ providerSettingRows: [] });

    assert.ok(html.includes("Coding Agent Providers"));
    assert.ok(
      !html.includes("No coding agent providers found in the model catalog."),
    );
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
  /** カタログ取得エラーは Provider 一覧に重複表示せず、Settings フッターの通知だけに出す。 */
  it("provider catalog error は Settings footer に一度だけ表示する", () => {
    const html = renderSettings({
      providerSettingRows: [],
      settingsFeedback: "Could not load the model catalog.",
    });
    const document = new JSDOM(html).window.document;

    assert.ok(html.includes("Coding Agent Providers"));
    assert.equal(
      document.querySelectorAll(".settings-provider-card").length,
      0,
    );
    assert.equal(document.querySelectorAll(".settings-feedback").length, 1);
    assert.equal(
      document.querySelector(".settings-dialog-foot .settings-feedback")
        ?.textContent,
      "Could not load the model catalog.",
    );
  });
});

/** Mate の作成・編集・利用不可モードについて、操作と表示の違いを検証する。 */
describe("HomeMateSetupPanel", () => {
  /** React 要素ツリーを走査して、条件に合う入力や操作要素を収集する。 */
  const collectElements = (
    node: ReactNode,
    predicate: (
      element: React.ReactElement<Record<string, unknown>>,
    ) => boolean,
  ): React.ReactElement<Record<string, unknown>>[] => {
    const result: React.ReactElement<Record<string, unknown>>[] = [];
    /** 有効な要素だけを対象に条件を照合し、単一または複数の子要素へたどる。 */
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

      if (
        children === null ||
        children === undefined ||
        typeof children === "boolean"
      ) {
        return;
      }

      visitNode(children as ReactNode);
    };

    visitNode(node);
    return result;
  };

  /** 作成・編集状態、表示情報と操作を差し替え、Mate セットアップの要素を取得する。 */
  const renderPanel = (params?: {
    mode?: "create" | "edit" | "unavailable";
    creating?: boolean;
    feedback?: string;
    displayName?: string;
    mateDisplayName?: string | null;
    mateAvatarFilePath?: string | null;
    avatarAction?: MateAvatarAction;
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
      avatarAction: params?.avatarAction,
      feedback: params?.feedback ?? "",
      mateDisplayName: params?.mateDisplayName ?? null,
      mateAvatarFilePath: params?.mateAvatarFilePath,
      /** 入力の描画を検査する場合、名前変更を永続状態へは適用しない。 */
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
  /** 新規作成画面に表示名の初期入力、Mate 作成ボタン、設定への入口とフィードバックがあることを検査する。 */
  it("display name input / create button / settings button / feedback が render される", () => {
    const panel = renderPanel({ feedback: "作成完了まで少し待ってね。" });
    const html = renderToStaticMarkup(panel);
    const input = collectElements(
      panel,
      (element) =>
        element.type === "input" && element.props.id === "mate-display-name",
    )[0];
    const submitButton = collectElements(
      panel,
      (element) => element.type === "button" && element.props.type === "submit",
    )[0];
    const settingsButton = collectElements(
      panel,
      (element) =>
        element.type === "button" &&
        typeof element.props.children === "string" &&
        element.props.children === "Settings",
    )[0];

    assert.ok(input);
    assert.ok(submitButton);
    assert.ok(settingsButton);
    assert.ok(input.props.value === "Your Mate");
    assert.equal(
      new JSDOM(html).window.document.querySelector("button[type='submit']")
        ?.textContent,
      "Create Mate",
    );
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
  /** 作成フォームはブラウザーの既定 submit を止めてから、指定した作成処理を一度呼ぶ。 */
  it("form submit で onSubmit が呼ばれる", () => {
    let submitted = 0;
    const events: string[] = [];
    const panel = renderPanel({
      /** フォームから作成処理が呼ばれた順序と回数を記録する。 */
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

    (
      form.props.onSubmit as (event: {
        /** フォームの既定動作が抑止される順序を観測する。 */
        preventDefault(): void;
      }) => void
    )({
      /** ハンドラーが既定の送信を抑止したことを、作成処理の順序と比較できるよう記録する。 */
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
  /** 設定ボタンを操作すると、設定画面への遷移を要求するコールバックが一度呼ばれる。 */
  it("設定ボタンで onOpenSettings が呼ばれる", () => {
    let settingsOpened = 0;
    const panel = renderPanel({
      /** 設定画面への遷移要求を回数だけで観測する。 */
      onOpenSettings: () => {
        settingsOpened += 1;
      },
    });
    const buttons = collectElements(
      panel,
      (element) =>
        element.type === "button" &&
        typeof element.props.children === "string" &&
        element.props.children === "Settings",
    );
    const settingsButton = buttons.find(
      (button) => button.props.type === "button" && button.props.onClick,
    );
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
  /** 作成中は表示名と送信を無効化し、作成ラベルを維持して装飾用スピナーを添える。 */
  it("creating=true で input / submit button が disabled になり、spinner 表示になる", () => {
    const panel = renderPanel({ creating: true, feedback: "CreatingMate" });
    const input = collectElements(
      panel,
      (element) =>
        element.type === "input" && element.props.id === "mate-display-name",
    )[0];
    const submitButton = collectElements(
      panel,
      (element) => element.type === "button" && element.props.type === "submit",
    )[0];
    if (!input || !submitButton) {
      throw new Error(
        "HomeMateSetupPanel の入力 or submit button が見つかりません。",
      );
    }

    assert.ok(input.props.disabled);
    assert.ok(submitButton.props.disabled);
    const document = new JSDOM(renderToStaticMarkup(panel)).window.document;
    assert.ok(
      document.querySelector(
        "button[type='submit'] .button-content-spinner[aria-hidden='true']",
      ),
    );
    assert.equal(
      document.querySelector("button[type='submit'] .button-content-label")
        ?.textContent,
      "Create Mate",
    );
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
  /** 編集画面に Mate Profile と Save を表示し、戻る操作で指定した取消処理を起動する。 */
  it("edit mode では MateProfile の保存とキャンセル導線を表示する", () => {
    let canceled = 0;
    const panel = renderPanel({
      mode: "edit",
      displayName: "Mika",
      mateDisplayName: "Mika",
      /** 編集画面から戻ったことを、呼出回数で検査できるようにする。 */
      onCancel: () => {
        canceled += 1;
      },
    });
    const html = renderToStaticMarkup(panel);
    const submitButton = collectElements(
      panel,
      (element) => element.type === "button" && element.props.type === "submit",
    )[0];
    const cancelButton = collectElements(
      panel,
      (element) =>
        element.type === "button" &&
        typeof element.props.children === "string" &&
        element.props.children === "Cancel",
    )[0];

    assert.ok(html.includes("Mate Profile"));
    assert.ok(submitButton);
    assert.equal(
      new JSDOM(html).window.document.querySelector("button[type='submit']")
        ?.textContent,
      "Save",
    );
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
  /** プロフィールが利用できない場合はその理由を表示し、入力を無効化して作成・保存の両方を隠す。 */
  it("unavailable mode では Mate 作成/保存ボタンを表示しない", () => {
    const panel = renderPanel({
      mode: "unavailable",
      displayName: "",
      feedback: "ignored",
    });
    const html = renderToStaticMarkup(panel);
    const input = collectElements(
      panel,
      (element) =>
        element.type === "input" && element.props.id === "mate-display-name",
    )[0];
    const submitButton = collectElements(
      panel,
      (element) => element.type === "button" && element.props.type === "submit",
    )[0];

    assert.ok(html.includes("Mate profile is unavailable."));
    assert.equal(input?.props.disabled, true);
    assert.equal(submitButton, undefined);
    assert.equal(html.includes("Create Mate"), false);
    assert.equal(html.includes("Save"), false);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "Home Mate setup edit modeはiconの選択と解除操作をcallbackへ渡す"
  // oracle = { type = "contract", ref = "docs/design/desktop-ui.md Home Window" }
  // fault = "avatar選択または解除の操作がcallbackに届かない"
  // observable = "selected/cancelled counters"
  // observation_boundary = "component-behavior"
  // scope = "HomeMateSetupPanel avatar controls"
  // lifecycle = "permanent"
  // @end-test-value
  /** Mate の編集時にアバター選択と解除を別操作として公開し、それぞれ対応する処理を呼ぶ。 */
  it("edit mode では Mate アイコンの選択と解除を実行できる", () => {
    let selected = 0;
    let cleared = 0;
    const panel = renderPanel({
      mode: "edit",
      displayName: "Mika",
      mateDisplayName: "Mika",
      mateAvatarFilePath: "C:/mate/avatar.png",
      /** ファイル選択を実際に開かず、アバター選択要求を記録する。 */
      onSelectAvatar: () => {
        selected += 1;
      },
      /** アバターの解除要求を選択要求と別に数える。 */
      onClearAvatar: () => {
        cleared += 1;
      },
    });
    const html = renderToStaticMarkup(panel);
    const selectButton = collectElements(
      panel,
      (element) =>
        element.type === "button" &&
        element.props["aria-label"] === "Select Image",
    )[0];
    const clearButton = collectElements(
      panel,
      (element) =>
        element.type === "button" &&
        element.props["aria-label"] === "Clear Avatar",
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
  /** Mate の新規作成時はアバター欄を描画しても、編集用の選択・解除ボタンを出さない。 */
  it("create mode では Mate アイコンの補足説明と編集操作を表示しない", () => {
    const panel = renderPanel({ mode: "create" });
    const html = renderToStaticMarkup(panel);
    const avatarButtons = collectElements(
      panel,
      (element) =>
        element.type === "button" &&
        ["Select Image", "Clear"].includes(String(element.props.children)),
    );

    assert.ok(html.includes("Avatar"));
    assert.equal(avatarButtons.length, 0);
  });
});

/** New Session の選択・読込状態、パス検証の案内と明示的な取消操作を検査する。 */
describe("HomeLaunchDialog", () => {
  /** 静的描画に必要な操作を揃え、入力や Session 作成には副作用を持たせない。 */
  const noOp = (..._args: unknown[]) => undefined;

  const characterOptions = [
    {
      id: "mia",
      name: "Mia",
      description: "Character description",
      iconFilePath: "",
      theme: { main: "#111111", sub: "#eeeeee" },
      state: "active" as const,
      createdAt: "",
      updatedAt: "",
      archivedAt: null,
    },
  ];

  /** Character や Provider の取得状態、Workspace の検証状態を切り替えて同じ起動ダイアログを描画する。 */
  const renderHomeLaunchDialog = (
    options = characterOptions,
    charactersLoaded = true,
    randomCharacterSelected = false,
    workspaceValidation: DirectoryPathValidationState = "idle",
    characterLoadStatus?: "loading" | "loaded" | "error",
    providerLoadStatus?: ProviderLaunchLoadStatus,
    providerLoadError = "",
  ) =>
    renderToStaticMarkup(
      <HomeLaunchDialog
        open={true}
        title="demo"
        sessionRole="standalone"
        sessionFolderSelected={false}
        workspacePathInput="C:\\work space\\"
        workspaceValidation={workspaceValidation}
        workspaceValidationMessage={
          workspaceValidation === "invalid" ? "Path not found." : ""
        }
        enabledLaunchProviders={[{ id: "codex", label: "Codex" }]}
        providerLoadStatus={providerLoadStatus}
        providerLoadError={providerLoadError}
        selectedLaunchProviderId="codex"
        characterOptions={options}
        selectedCharacterId={
          randomCharacterSelected ? null : (options[0]?.id ?? null)
        }
        randomCharacterSelected={randomCharacterSelected}
        charactersLoaded={charactersLoaded}
        characterLoadStatus={characterLoadStatus}
        canStartSession={true}
        launchFeedback=""
        launchStarting={false}
        onClose={noOp}
        onChangeTitle={noOp}
        onSelectRole={noOp}
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
  // claim = "New Sessionは入力中のwindow切替・paste・backdrop click・Escapeでは閉じず、Start不可でもvisibleなCancelから作成せず閉じて起点へfocusを戻す"
  // oracle = { type = "contract", ref = "Issue #558 New Session dismiss acceptance criteria" }
  // fault = "暗黙のdismissで入力が失われる、またはStart不可時にCancelで戻れずSession作成が呼ばれる"
  // observable = "dialogと入力値の維持、Cancelの有効状態とsecondary表示、close/start callback回数、close後のactiveElement"
  // observation_boundary = "component-behavior"
  // scope = "HomeLaunchDialog dismiss and focus flow"
  // lifecycle = "permanent"
  // impact = "他Windowからworkspace pathを持ち帰る途中の入力消失を防ぎ、作成不可時も安全にHomeへ戻れる"
  // distinction = "静的markup検査と異なり、window event・暗黙dismiss・Cancel後のcallbackとfocusをmounted componentで確認する"
  // @end-test-value
  /** ウィンドウ切替・貼り付け・背景クリック・Escape で入力を失わず、開始不可でも Cancel から作成せず閉じて起点へ戻る。 */
  it("New Session は暗黙に閉じず、Cancel は作成せずに focus を戻す", async () => {
    const dom = new JSDOM(
      '<!doctype html><html><body><div id="root"></div></body></html>',
      {
        pretendToBeVisual: true,
      },
    );
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    const previousHTMLElement = globalThis.HTMLElement;
    Object.defineProperty(dom.window.HTMLElement.prototype, "attachEvent", {
      configurable: true,
      /** JSDOM で React の入力イベント互換経路を通しても、実イベント登録は行わない。 */
      value() {},
    });
    Object.defineProperty(dom.window.HTMLElement.prototype, "detachEvent", {
      configurable: true,
      /** 入力フォーカスを戻す際、互換 API の解除も実際の DOM 操作を行わない。 */
      value() {},
    });
    Object.defineProperty(globalThis, "window", {
      value: dom.window,
      configurable: true,
    });
    Object.defineProperty(globalThis, "document", {
      value: dom.window.document,
      configurable: true,
    });
    Object.defineProperty(globalThis, "HTMLElement", {
      value: dom.window.HTMLElement,
      configurable: true,
    });

    const rootElement = dom.window.document.getElementById("root");
    assert.ok(rootElement);
    const root = createRoot(rootElement);
    let closeCount = 0;
    let startCount = 0;

    /** 背景のボタンから実ダイアログを開き、入力値、取消、開始要求を独立に観測する。 */
    function LaunchHarness() {
      const [open, setOpen] = useState(false);
      const [workspacePathInput, setWorkspacePathInput] =
        useState("C:\\draft\\");
      return (
        <>
          <button
            id="open-new-session"
            type="button"
            onClick={() => setOpen(true)}
          >
            New Session
          </button>
          <HomeLaunchDialog
            open={open}
            title="Draft title"
            sessionRole="standalone"
            sessionFolderSelected={false}
            workspacePathInput={workspacePathInput}
            workspaceValidation="invalid"
            workspaceValidationMessage="Path not found."
            enabledLaunchProviders={[{ id: "codex", label: "Codex" }]}
            selectedLaunchProviderId="codex"
            characterOptions={characterOptions}
            selectedCharacterId="mia"
            randomCharacterSelected={false}
            charactersLoaded={true}
            canStartSession={false}
            launchFeedback=""
            launchStarting={false}
            onClose={() => {
              closeCount += 1;
              setOpen(false);
            }}
            onChangeTitle={noOp}
            onSelectRole={noOp}
            onChangeWorkspacePath={setWorkspacePathInput}
            onBrowseWorkspace={noOp}
            onSelectSessionFolder={noOp}
            onSelectProvider={noOp}
            onSelectCharacter={noOp}
            onSelectRandomCharacter={noOp}
            onStartSession={() => {
              startCount += 1;
            }}
          />
        </>
      );
    }

    try {
      await act(async () => root.render(<LaunchHarness />));
      const opener =
        rootElement.querySelector<HTMLButtonElement>("#open-new-session");
      assert.ok(opener);
      opener.focus();
      await act(async () => opener.click());
      await act(
        async () =>
          new Promise<void>((resolve) => dom.window.setTimeout(resolve, 0)),
      );

      const dialog = rootElement.querySelector<HTMLElement>(
        '[aria-label="New Session"]',
      );
      const workspace = rootElement.querySelector<HTMLInputElement>(
        "#launch-workspace-path",
      );
      const title = rootElement.querySelector<HTMLInputElement>(
        "#launch-session-title",
      );
      const cancel = Array.from(
        dialog?.querySelectorAll<HTMLButtonElement>("button") ?? [],
      ).find((button) => button.textContent === "Cancel");
      const start = Array.from(
        dialog?.querySelectorAll<HTMLButtonElement>("button") ?? [],
      ).find((button) => button.textContent === "Start");
      assert.ok(dialog && workspace && title && cancel && start);
      assert.equal(dom.window.document.activeElement, title);
      assert.equal(start.disabled, true);
      assert.equal(cancel.disabled, false);
      assert.ok(cancel.classList.contains("secondary"));

      await act(async () => {
        dom.window.dispatchEvent(new dom.window.Event("blur"));
        dom.window.dispatchEvent(new dom.window.Event("focus"));
        workspace.dispatchEvent(
          new dom.window.Event("paste", { bubbles: true }),
        );
        dialog.click();
        workspace.dispatchEvent(
          new dom.window.KeyboardEvent("keydown", {
            key: "Escape",
            bubbles: true,
          }),
        );
      });
      assert.equal(closeCount, 0);
      assert.equal(workspace.value, "C:\\draft\\");
      assert.equal(title.value, "Draft title");
      assert.ok(rootElement.querySelector('[aria-label="New Session"]'));

      await act(async () => cancel.click());
      assert.equal(closeCount, 1);
      assert.equal(startCount, 0);
      assert.equal(
        rootElement.querySelector('[aria-label="New Session"]'),
        null,
      );
      assert.equal(dom.window.document.activeElement, opener);
    } finally {
      await act(async () => root.unmount());
      Object.defineProperty(globalThis, "window", {
        value: previousWindow,
        configurable: true,
      });
      Object.defineProperty(globalThis, "document", {
        value: previousDocument,
        configurable: true,
      });
      Object.defineProperty(globalThis, "HTMLElement", {
        value: previousHTMLElement,
        configurable: true,
      });
    }
  });

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
  /** 新規作成画面にアクセシブル名、開始、Provider と Session Folder の選択を持たせ、別の Agent Mode 操作を入れない。 */
  it("新規作成導線は Session 専用である", () => {
    const html = renderHomeLaunchDialog();

    assert.equal(
      new JSDOM(html).window.document.querySelector(
        "button.start-session-button",
      )?.textContent,
      "Start",
    );
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
  /** 個別 Character と説明、先頭の Random を表示し、Workspace の Browse を Session Folder より先に置く。 */
  it("ダイアログに Character selector が含まれる", () => {
    const html = renderHomeLaunchDialog();

    assert.ok(
      html.includes("launch-section minimal home-launch-character-section"),
    );
    assert.ok(html.includes("Character"));
    assert.ok(html.includes("Mia"));
    assert.ok(!html.includes(">Default</span>"));
    assert.ok(html.includes("Character description"));
    assert.ok(html.includes("Random"));
    assert.ok(html.indexOf("Random") < html.indexOf("Mia"));
    assert.ok(html.indexOf("Browse") < html.indexOf("Session Folder"));
  });

  // @test-value v2
  // kind = "contract"
  // claim = "Homeの無効Workspace入力は値を保持し、labelと関連付いたinputから現在のerror statusを参照できる"
  // oracle = { type = "contract", ref = "docs/design/desktop-ui.md#home-window New Sessionパス検証" }
  // fault = "無効理由がinputの説明から切り離される、invalid状態が公開されない、または入力値が失われる"
  // observable = "生成DOMのlabel.control、input.value/aria-invalid/aria-describedbyと参照先statusの本文・aria-live"
  // observation_boundary = "component-behavior"
  // scope = "HomeLaunchDialogの共有パス入力とerrorのDOM・accessibility関係"
  // lifecycle = "permanent"
  // distinction = "単なる文字列包含やCSS宣言と異なりinputとerrorの実DOM関係を検査する。検証controllerや型検査では失われたaccessible descriptionを検出できず、安価な静的renderで保持する価値がある。pixel配置は実描画確認の対象とする"
  // @end-test-value
  /** Workspace が無効でも入力値とラベルの対応を維持し、入力の説明参照が現在のパスエラーとそのステータスを指すようにする。 */
  it("Workspace input は値とlabelを保ち、invalid理由のstatusを参照する", () => {
    const idle = new JSDOM(renderHomeLaunchDialog());
    const invalid = new JSDOM(
      renderHomeLaunchDialog(characterOptions, true, false, "invalid"),
    );
    try {
      const idleInput = idle.window.document.getElementById(
        "launch-workspace-path",
      )!;
      assert.equal(idleInput.getAttribute("aria-invalid"), "false");
      assert.equal(idleInput.hasAttribute("aria-describedby"), false);
      const document = invalid.window.document;
      const input = document.getElementById(
        "launch-workspace-path",
      ) as HTMLInputElement;
      const label = Array.from(document.querySelectorAll("label")).find(
        (candidate) => candidate.control === input,
      );
      assert.equal(label?.textContent, "Workspace");
      assert.equal(input.value, "C:\\\\work space\\\\");
      assert.equal(input.getAttribute("aria-invalid"), "true");
      const error = document.getElementById(
        input.getAttribute("aria-describedby")!,
      );
      assert.ok(error);
      assert.equal(error.textContent, "Path not found.");
      assert.equal(error.getAttribute("role"), "status");
      assert.equal(error.getAttribute("aria-live"), "polite");
    } finally {
      idle.window.close();
      invalid.window.close();
    }
  });

  // @test-value v2
  // kind = "contract"
  // claim = "Homeのworkspace validationはdebounce中とfilesystem確認中の両方で入力のbusy、decorative indicator、検証中statusをDOMへ公開する"
  // oracle = { type = "contract", ref = "docs/design/desktop-ui.md#home-window New Sessionパス検証" }
  // fault = "debounceまたはfilesystem確認の片方でspinnerとaria-busyを失い、入力が検証中かどうかを識別できない"
  // observable = "debouncing/pending/validのDOMでWorkspace入力のaria-busy所有領域、その中のaria-hidden indicator、Checking workspace path… statusの有無"
  // observation_boundary = "component-behavior"
  // scope = "HomeLaunchDialog workspace validation feedback"
  // lifecycle = "permanent"
  // impact = "検証待ちの入力を利用者が未検証または完了済みと誤認しにくくなる"
  // distinction = "CSS宣言やcontroller単体では観測しない入力とbusy/statusのDOM接続を確認する。animation名・時間は固定せず、可視性やpixel配置は実描画確認と区別する"
  // @end-test-value
  /** パス検証の待ち時間と実照会の双方で busy とステータスを公開し、成功後はどちらの待機表示も消す。 */
  it("Workspace validation は検証中のbusyとstatusを公開し、完了後に解除する", () => {
    for (const state of ["debouncing", "pending", "valid"] as const) {
      const dom = new JSDOM(
        renderHomeLaunchDialog(characterOptions, true, false, state),
      );
      try {
        const document = dom.window.document;
        const input = document.getElementById("launch-workspace-path")!;
        const region = input.closest("[aria-busy]");
        assert.ok(region);
        const checking = state !== "valid";
        assert.equal(region.getAttribute("aria-busy"), String(checking));
        assert.equal(!!region.querySelector('[aria-hidden="true"]'), checking);
        const statuses = Array.from(
          document.querySelectorAll('[role="status"]'),
        );
        const checkingStatus = statuses.find(
          (status) => status.textContent === "Checking workspace path…",
        );
        assert.equal(!!checkingStatus, checking);
        if (checkingStatus)
          assert.equal(checkingStatus.getAttribute("aria-live"), "polite");
      } finally {
        dom.window.close();
      }
    }
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
  /** Random を選んだときは、個別カードへ選択表示を残さず Random だけを選択済みとして公開する。 */
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

  /** 取得済みの Character がゼロ件なら、WithMate の Neutral を起動候補として表示する。 */
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
  // observable = "共通spinner、Loading charactersのaccessible status、およびNeutralの不在"
  // observation_boundary = "component-behavior"
  // scope = "HomeLaunchDialog character catalog loading state"
  // lifecycle = "permanent"
  // impact = "Character取得待ちと正常な空一覧を識別でき、開始可否を誤認しない"
  // distinction = "候補配列が空である事実だけでなく、明示的loading stateの表示分岐を確認する"
  // @end-test-value
  /** Character の初期読込中はスピナーと状態名だけを出し、確定した空一覧向けの Neutral を表示しない。 */
  it("Character catalog 読み込み前は neutral fallback を表示しない", () => {
    const html = renderHomeLaunchDialog([], false);

    assert.ok(html.includes("loading-indicator-spinner"));
    assert.ok(html.includes('aria-label="Loading characters"'));
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
  /** Character の取得失敗を Unavailable と理由で示し、読込中や取得済みゼロ件の表示で覆わない。 */
  it("Character catalog の読み込み失敗は loading と空一覧を区別する", () => {
    const html = renderHomeLaunchDialog([], false, false, "idle", "error");

    assert.ok(html.includes("Unavailable"));
    assert.ok(html.includes("Could not load characters."));
    assert.ok(!html.includes('aria-label="Loading characters"'));
    assert.ok(!html.includes("Neutral"));
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "New sessionのProvider catalogは取得中・取得失敗・正常な有効provider 0件を別状態として表示し、未確定中は開始を無効化する"
  // oracle = { type = "contract", ref = "docs/design/ui-design-guidelines.md#読込・空・失敗" }
  // fault = "Provider catalogの取得中または失敗をNo enabled coding providersへ投影し、開始条件と実エラーを混同する"
  // observable = "Provider pickerのspinner/aria-busy、実エラー、Start disabled、No enabled coding providers.の相互排他"
  // observation_boundary = "component-behavior"
  // scope = "HomeLaunchDialog provider catalog state"
  // lifecycle = "permanent"
  // impact = "Session開始可否とcatalog取得失敗の理由を利用者が識別できる"
  // distinction = "候補配列の長さではなく、catalog request stateをpickerの表示へ投影する境界を確認する"
  // @end-test-value
  /** Provider の読込中は busy、取得失敗は理由で通知し、通常の空一覧の文言とは分けて開始を止める。 */
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

    assert.ok(loading.includes("loading-indicator-spinner"));
    assert.ok(loading.includes('aria-label="Loading coding providers"'));
    assert.ok(loading.includes('aria-busy="true"'));
    assert.ok(!loading.includes("No enabled coding providers."));
    assert.equal(
      new JSDOM(loading).window.document
        .querySelector(".start-session-button")
        ?.hasAttribute("disabled"),
      true,
    );
    assert.ok(error.includes("Could not load model catalog."));
    assert.ok(!error.includes("No enabled coding providers."));
    assert.equal(
      new JSDOM(error).window.document
        .querySelector(".start-session-button")
        ?.hasAttribute("disabled"),
      true,
    );
  });
});

/** Recent Sessions の履歴カード、ページ追加、準備状態と開く操作の表示を確認する。 */
describe("HomeRecentSessionsPanel", () => {
  /** 履歴やページングを表示するだけのケースでは、開く操作やピン更新は行わない。 */
  const noOp = (..._args: unknown[]) => undefined;
  /** ID・タイトルを必須にした履歴用 Summary を組み立て、時刻、ピン、形式など検査対象を上書き可能にする。 */
  const createSessionSummary = (
    partial: Partial<SessionSummary> & Pick<SessionSummary, "id" | "taskTitle">,
  ): SessionSummary => ({
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
  /** 履歴一覧の候補とページング状態を差し替えて、パネルの静的マークアップを返す。 */
  const renderHomeRecentSessions = ({
    filteredSessionEntries = [],
    hasMore = false,
    loadingMore = false,
    onLoadMore = noOp,
  }: {
    filteredSessionEntries?: React.ComponentProps<
      typeof HomeRecentSessionsPanel
    >["filteredSessionEntries"];
    hasMore?: boolean;
    loadingMore?: boolean;
    onLoadMore?: () => void;
  } = {}) =>
    renderToStaticMarkup(
      <HomeRecentSessionsPanel
        filteredSessionEntries={filteredSessionEntries}
        onOpenSession={noOp}
        onSetSessionPinned={noOp}
        hasMore={hasMore}
        loadingMore={loadingMore}
        onLoadMore={onLoadMore}
      />,
    );

  // @test-value v2
  // kind = "contract"
  // claim = "Homeの更新時刻はローカルのyyyy-MM-dd(英語曜日3文字) HH:mmで表示する"
  // oracle = { type = "contract", ref = "Issue #666 acceptance criteria" }
  // fault = "UTCのまま表示する、曜日と日付がずれる、または指定形式から外れる"
  // observable = "固定timezone下のformatHomeSessionUpdatedAtの戻り値"
  // observation_boundary = "public-boundary"
  // scope = "HomeRecentSessionsPanel updatedAt formatter"
  // lifecycle = "permanent"
  // impact = "ユーザーがSessionを開かずにローカルの更新日と時刻を比較できる"
  // distinction = "保存・sort値やcomponent配置ではなく、UI表示専用formatterのtimezoneと曜日を検証する"
  // @end-test-value
  /** UTC の保存時刻を指定タイムゾーンの時刻へ変換し、英語の曜日略称を含む所定の形式にする。 */
  it("updatedAt は固定timezoneでローカル日時と英語曜日を表示する", () => {
    const previousTimezone = process.env.TZ;
    process.env.TZ = "Asia/Tokyo";
    try {
      assert.equal(
        formatHomeSessionUpdatedAt("2026-09-10T05:31:00.000Z"),
        "2026-09-10(Thu) 14:31",
      );
    } finally {
      if (previousTimezone === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = previousTimezone;
      }
    }
  });

  // @test-value v2
  // kind = "contract"
  // claim = "Recent Sessions cardは更新日時をユーザー向けlabelと指定形式で表示し、parse不能値はそのまま読める"
  // oracle = { type = "contract", ref = "Issue #666 acceptance criteria" }
  // fault = "cardが保存値のISOを露出するか、parse不能値をInvalid Dateに変える"
  // observable = "HomeRecentSessionsPanelが描画するcardの更新日時metadata"
  // observation_boundary = "component-behavior"
  // scope = "HomeRecentSessionsPanel Agent card timestamp"
  // lifecycle = "permanent"
  // impact = "一覧でSessionの更新時刻を比較できず、legacy値を誤った日時と誤認する"
  // distinction = "formatter単体testでは検出できないcardへの表示接続とfallbackを確認する"
  // @end-test-value
  /** 履歴カードに整形した日時を出し、解釈できない既存時刻は失わず元の値を表示する。 */
  it("Agent cardに整形済み更新日時とparse不能値のfallbackを表示する", () => {
    const previousTimezone = process.env.TZ;
    process.env.TZ = "Asia/Tokyo";
    try {
      const html = renderHomeRecentSessions({
        filteredSessionEntries: [
          {
            session: createSessionSummary({
              id: "recent",
              taskTitle: "Recent task",
              updatedAt: "2026-09-10T05:31:00.000Z",
            }),
            state: { kind: "neutral", label: "idle" },
          },
          {
            session: createSessionSummary({
              id: "legacy",
              taskTitle: "Legacy task",
              updatedAt: "legacy-value",
            }),
            state: { kind: "neutral", label: "idle" },
          },
        ],
      });
      const document = new JSDOM(html).window.document;
      const timestampLabels = Array.from(
        document.querySelectorAll(".home-session-card-meta span:nth-child(2)"),
      ).map((element) => element.textContent);

      assert.deepEqual(timestampLabels, [
        "Updated 2026-09-10(Thu) 14:31",
        "Updated legacy-value",
      ]);
    } finally {
      if (previousTimezone === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = previousTimezone;
      }
    }
  });

  // @test-value v2
  // kind = "contract"
  // claim = "Session作成の準備が未完了の間はNew Session操作を無効化する"
  // oracle = { type = "contract", ref = "docs/design/desktop-ui.md" }
  // fault = "Session作成に必要な状態を取得する前に作成操作を許可する"
  // observable = "New Session buttonのdisabled属性"
  // observation_boundary = "component-behavior"
  // scope = "HomeHeader creation readiness"
  // lifecycle = "permanent"
  // @end-test-value
  /** 起動準備が未完了なら、表示された New Session ボタンを無効にする。 */
  it("Session作成の準備が未完了の時は New Session が無効化される", () => {
    const html = renderToStaticMarkup(
      <HomeHeader
        searchInputText=""
        onChangeSearchText={noOp}
        onOpenLaunchDialog={noOp}
        canCreateSession={false}
        rightPaneView="monitor"
        onChangeRightPaneView={noOp}
        monitorWindowIcon={null}
        onOpenSessionMonitorWindow={noOp}
        onOpenSettingsWindow={noOp}
        onRestoreSessionWindows={noOp}
      />,
    );
    const disabledButtons = html.match(
      /<button class="start-session-button"[^>]*disabled=""/g,
    );
    assert.equal(disabledButtons?.length, 1);
  });

  /** 追加ページがある一覧は末尾の監視要素を出し、手動の追加読込ボタンは設けない。 */
  it("追加読み込みは一覧末尾のsentinelだけを使い、追加ボタンを表示しない", () => {
    const html = renderHomeRecentSessions({ hasMore: true });

    assert.match(html, /class="home-session-list-load-sentinel"/);
    assert.doesNotMatch(
      html,
      /Sessionをさらに読み込む|ピン留めをさらに読み込む/,
    );
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
  /** ページの読込処理が登録時や非交差時には動かず、一覧末尾が表示範囲に入ったときだけ呼ばれる。 */
  it("一覧末尾のsentinelが交差した時だけ追加読み込みcallbackを呼ぶ", async () => {
    const dom = new JSDOM(
      '<!doctype html><html><body><div id="root"></div></body></html>',
      {
        pretendToBeVisual: true,
      },
    );
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    const previousHTMLElement = globalThis.HTMLElement;
    const previousIntersectionObserver = globalThis.IntersectionObserver;
    let observerCallback: IntersectionObserverCallback | null = null;
    let observedTarget: Element | null = null;
    let loadMoreCount = 0;

    /** 交差通知のコールバックと実際の監視対象を保持する、レイアウトに依存しない監視スタブ。 */
    class TestIntersectionObserver {
      /** 交差の有無をテストから送信できるよう、登録されたコールバックを保存する。 */
      constructor(callback: IntersectionObserverCallback) {
        observerCallback = callback;
      }

      /** 一覧がどの要素を追加読込の境界として登録するか記録する。 */
      observe(target: Element) {
        observedTarget = target;
      }

      /** 実際の交差観測は開始しないため、切断時に解放する対象はない。 */
      disconnect() {}
    }

    Object.defineProperty(globalThis, "window", {
      value: dom.window,
      configurable: true,
    });
    Object.defineProperty(globalThis, "document", {
      value: dom.window.document,
      configurable: true,
    });
    Object.defineProperty(globalThis, "HTMLElement", {
      value: dom.window.HTMLElement,
      configurable: true,
    });
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
            onOpenSession={noOp}
            onSetSessionPinned={noOp}
            hasMore
            onLoadMore={() => {
              loadMoreCount += 1;
            }}
          />,
        );
      });

      const sentinel = rootElement.querySelector(
        ".home-session-list-load-sentinel",
      );
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
      Object.defineProperty(globalThis, "window", {
        value: previousWindow,
        configurable: true,
      });
      Object.defineProperty(globalThis, "document", {
        value: previousDocument,
        configurable: true,
      });
      Object.defineProperty(globalThis, "HTMLElement", {
        value: previousHTMLElement,
        configurable: true,
      });
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
  /** Character 作成用 Session の履歴を、タイトルと Character バッジの組で識別できるようにする。 */
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
  /** ピン留めした Agent を履歴の先頭にし、開く操作へボタンを入れ子にせず、独立した解除操作を表示する。 */
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
    assert.match(
      html,
      /class="session-card home-session-card is-pinnable is-pinned"/,
    );
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
  /** 旧形式の Agent 履歴に Mate アイコンと読み取り専用表示を付け、内容を開く操作まで無効にはしない。 */
  it("履歴カードに Mate アイコンを表示し、V4 以前の Agent session は閲覧専用として開ける", () => {
    const html = renderHomeRecentSessions({
      filteredSessionEntries: [
        {
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
    });

    assert.equal(
      (html.match(/character-avatar tiny home-session-card-avatar/g) ?? [])
        .length,
      1,
    );
    assert.ok(html.includes("mate.png"));
    assert.ok(html.includes("Read Only"));
    const openButton = new JSDOM(html).window.document.querySelector(
      ".home-session-card-open",
    );
    assert.ok(openButton);
    assert.equal(openButton.hasAttribute("disabled"), false);
    assert.notEqual(openButton.getAttribute("aria-disabled"), "true");
    assert.match(html, /class="session-card home-session-card/);
  });
});

/** Monitor の親・Auxiliary の状態表示、展開、ナビゲーションとエラー通知を検証する。 */
describe("HomeMonitorContent", () => {
  /** 表示専用の Monitor では別画面を開いたりコンテキスト操作を実行したりしない。 */
  const noOp = (..._args: unknown[]) => undefined;

  /** 指定 ID と題名で Monitor の親行を作り、アイコンなどの表示比較に固定値を使う。 */
  const createMonitorSession = (
    id: string,
    taskTitle: string,
  ): HomeSessionSummary => ({
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

  /** Monitor 用の Auxiliary Summary を作り、親、状態、プレビューを検証条件に合わせて差し替える。 */
  const createMonitorAuxiliary = (
    id: string,
    overrides: Record<string, unknown> = {},
  ) =>
    ({
      id,
      parentSessionId: "session-1",
      runState: "idle",
      title: "Auxiliary",
      provider: "codex",
      catalogRevision: 1,
      model: "gpt-5.4",
      reasoningEffort: "high",
      approvalMode: "untrusted",
      codexSandboxMode: "danger-full-access",
      customAgentName: "",
      threadId: "",
      displayAfterMessageIndex: null,
      createdAt: "2026-03-28T00:00:00.000Z",
      updatedAt: "2026-03-30T00:00:00.000Z",
      characterIconPath: "mate.png",
      preview: "Auxiliary preview",
      codexSpeed: "standard",
      codexReviewer: "auto-review",
      ...overrides,
    }) as AuxiliarySessionSummary;

  // @test-value v2
  // kind = "invariant"
  // claim = "Home Monitorの親行はavatar、titleとaccessible nameを持つMain状態iconを同じまとまりに表示し、Auxiliaryの状態別件数を配下一覧の展開操作へまとめる"
  // oracle = { type = "contract", ref = "docs/design/desktop-ui.md#session-monitor-window" }
  // fault = "Main状態iconのaccessible nameを表示しない、Main状態を親名と分離する、Auxiliaryの集約と展開操作を分離する、Main/Aux状態を混同する、状態別件数を1件だけ省略する、またはavatar/titleが欠落する"
  // observable = "Main session group内の状態iconとaccessible name、親を開くbutton、Auxiliary展開button内の状態別件数とicon、aria-expanded、avatarとtitle"
  // observation_boundary = "component-behavior"
  // scope = "home-monitor-rendering"
  // lifecycle = "permanent"
  // impact = "列名を読まずに親の状態と配下の状態・展開先を区別し、誤った対象を開くことを防ぐ"
  // distinction = "projectionや型検査では確認できない最終DOMの意味的なまとまりと操作対象を既存の表示testで検証し、新しいtest環境は増やさない"
  // @end-test-value
  /** 親行のアイコンとタイトル、ラベル付き状態を同じまとまりにし、Auxiliary の件数は一覧を開く操作にまとめる。 */
  it("Monitor カードはキャラアイコン付きでセッション情報を表示する", () => {
    const entries: HomeMonitorEntry[] = [
      {
        kind: "agent",
        session: createMonitorSession("session-1", "Agent task"),
        state: { kind: "running", label: "Running" },
        mainState: { kind: "neutral", label: "Idle" },
        auxiliarySessions: [
          createMonitorAuxiliary("aux-1", {
            runState: "error",
            preview: "Auxiliary error",
          }),
          createMonitorAuxiliary("aux-idle", {
            preview: "Idle auxiliary",
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
        approvalEntries={[]}
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
    assert.equal(cards.length, 2);
    for (const [index, card] of cards.entries()) {
      const parentRow = card.querySelector(".home-monitor-parent-row");
      const mainGroup = parentRow?.querySelector(
        `[role="group"][aria-label="Main session: ${entries[index]?.session.taskTitle}"]`,
      );
      assert.ok(mainGroup);
      assert.ok(
        mainGroup.querySelector(
          `button[aria-label="Open session: ${entries[index]?.session.taskTitle}"]`,
        ),
      );
      assert.ok(
        mainGroup.querySelector(
          `.home-monitor-status-icon.${expectedMainStates[index]}`,
        ),
      );
      assert.ok(
        mainGroup.querySelector(
          `[aria-label="Main ${entries[index]?.mainState.label}"]`,
        ),
      );
      assert.equal(card.querySelectorAll(".home-monitor-parent-row").length, 1);
      assert.equal(
        card.querySelectorAll(".home-monitor-auxiliary-list").length,
        0,
      );
      assert.equal(
        card.querySelectorAll(".home-monitor-parent-title").length,
        1,
      );
      assert.equal(card.querySelectorAll(".home-monitor-avatar").length, 1);
      assert.equal(
        parentRow
          ?.querySelector(".home-monitor-avatar")
          ?.classList.contains("home-monitor-avatar"),
        true,
      );
      assert.equal(
        parentRow?.querySelector(".home-monitor-parent-title")?.textContent,
        entries[index]?.session.taskTitle,
      );
      assert.equal(
        parentRow?.querySelectorAll(".home-monitor-status-cluster").length,
        index === 0 ? 2 : 1,
      );
      assert.equal(
        mainGroup.querySelectorAll(
          `.home-monitor-status-icon.${expectedMainStates[index]}`,
        ).length,
        1,
      );
    }
    assert.equal(
      cards[0]?.querySelectorAll(".home-monitor-status-cluster").length,
      2,
    );
    assert.equal(
      cards[0]?.querySelectorAll(".home-monitor-auxiliary-status").length,
      1,
    );
    const auxiliaryDisclosure = cards[0]?.querySelector(
      'button[aria-label="Show Auxiliary sessions for Agent task"]',
    );
    assert.ok(auxiliaryDisclosure);
    assert.equal(auxiliaryDisclosure.getAttribute("aria-expanded"), "false");
    assert.ok(auxiliaryDisclosure.querySelector('svg[aria-hidden="true"]'));
    assert.ok(
      auxiliaryDisclosure.querySelector('[aria-label="Auxiliary Failed: 1"]'),
    );
    assert.ok(
      auxiliaryDisclosure.querySelector('[aria-label="Auxiliary Idle: 1"]'),
    );
    assert.equal(
      cards[0]?.querySelectorAll(".home-monitor-status-icon.neutral").length,
      2,
    );
    assert.equal(
      cards[0]?.querySelectorAll(".home-monitor-status-icon.error").length,
      1,
    );
    assert.equal(
      cards[1]?.querySelectorAll(".home-monitor-status-cluster").length,
      1,
    );
    assert.equal(
      cards[1]?.querySelectorAll(".home-monitor-auxiliary-status").length,
      0,
    );
    assert.equal(
      html.match(/class="home-monitor-status-icon running"/g)?.length,
      1,
    );
    assert.equal(
      html.match(/class="home-monitor-status-icon neutral"/g)?.length,
      2,
    );
    assert.equal(
      html.match(/class="home-monitor-status-icon error"/g)?.length,
      1,
    );
    assert.equal(html.match(/aria-label="Main Running"/g)?.length, 1);
    assert.equal(html.match(/aria-label="Main Idle"/g)?.length, 1);
    assert.ok(html.includes('aria-label="Auxiliary Failed: 1"'));
    assert.ok(html.includes('aria-label="Auxiliary Idle: 1"'));
    assert.equal(
      html.match(/character-avatar tiny home-monitor-avatar/g)?.length,
      2,
    );
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
  /** Auxiliary のプレビューが明示的に空か欠損ならそのまま空で表示し、開く操作のラベルに別途既定名を残す。 */
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
    const dom = new JSDOM(
      '<!doctype html><html><body><div id="root"></div></body></html>',
      {
        pretendToBeVisual: true,
      },
    );
    const container = dom.window.document.getElementById("root") as HTMLElement;
    const root = createRoot(container);
    const entry: HomeMonitorEntry = {
      kind: "agent",
      session: createMonitorSession(
        "session-empty-preview",
        "Empty preview task",
      ),
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
      PointerEvent: {
        configurable: true,
        value: dom.window.PointerEvent ?? dom.window.MouseEvent,
      },
    });

    try {
      await act(async () =>
        root.render(
          <HomeMonitorContent
            approvalEntries={[]}
            runningEntries={[]}
            nonRunningEntries={[entry]}
            onOpenSession={noOp}
            onShowContextMenu={noOp}
          />,
        ),
      );

      const disclosure = container.querySelector<HTMLButtonElement>(
        "button.home-monitor-disclosure",
      );
      assert.ok(disclosure);
      await act(async () =>
        disclosure.dispatchEvent(
          new dom.window.MouseEvent("click", { bubbles: true }),
        ),
      );

      const rows = Array.from(
        container.querySelectorAll<HTMLButtonElement>(
          "button.home-monitor-auxiliary-row",
        ),
      );
      assert.equal(rows.length, 2);
      assert.equal(
        rows[0]?.querySelector(".home-monitor-auxiliary-preview")?.textContent,
        "",
      );
      assert.equal(rows[0]?.getAttribute("aria-label"), "Open Auxiliary 1");
      assert.equal(rows[0]?.textContent?.includes("新しい会話"), false);
      assert.equal(
        rows[1]?.querySelector(".home-monitor-auxiliary-preview")?.textContent,
        "",
      );
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
        KeyboardEvent: {
          configurable: true,
          value: previousGlobals.KeyboardEvent,
        },
        PointerEvent: {
          configurable: true,
          value: previousGlobals.PointerEvent,
        },
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
  /** 一覧を閉じた親カードでも複数の状態の件数を同時に公開し、待機一件を省略しない。 */
  it("閉じたMonitorカードでもAuxiliaryの状態別件数を1件から表示する", () => {
    const auxiliarySessions = [
      createMonitorAuxiliary("aux-running-1", { runState: "running" }),
      createMonitorAuxiliary("aux-running-2", { runState: "running" }),
      createMonitorAuxiliary("aux-running-3", { runState: "running" }),
      createMonitorAuxiliary("aux-idle", { runState: "idle" }),
    ];
    const entry: HomeMonitorEntry = {
      kind: "agent",
      session: createMonitorSession(
        "session-count-summary",
        "Count summary task",
      ),
      state: { kind: "running", label: "Running" },
      mainState: { kind: "neutral", label: "Idle" },
      auxiliarySessions,
    };
    const html = renderToStaticMarkup(
      <HomeMonitorContent
        approvalEntries={[]}
        runningEntries={[entry]}
        nonRunningEntries={[]}
        onOpenSession={noOp}
        onShowContextMenu={noOp}
      />,
    );
    const document = new JSDOM(html).window.document;
    const card = document.querySelector(".home-monitor-card");
    const auxiliaryStatus = card?.querySelector(
      ".home-monitor-auxiliary-status",
    );
    const runningIcon = auxiliaryStatus?.querySelector(
      ".home-monitor-status-icon.running",
    );
    const idleIcon = auxiliaryStatus?.querySelector(
      ".home-monitor-status-icon.neutral",
    );

    assert.equal(
      card?.querySelectorAll(".home-monitor-auxiliary-list").length,
      0,
    );
    assert.equal(
      runningIcon?.querySelector(".home-monitor-status-icon-count")
        ?.textContent,
      ": 3",
    );
    assert.equal(
      idleIcon?.querySelector(".home-monitor-status-icon-count")?.textContent,
      ": 1",
    );
    assert.equal(
      runningIcon?.getAttribute("aria-label"),
      "Auxiliary Running: 3",
    );
    assert.equal(idleIcon?.getAttribute("aria-label"), "Auxiliary Idle: 1");
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "Auxiliary summaryが未確定でもAuxiliaryなしの親カードへ誤った集約を表示せず、loading/errorをMonitor feedbackで知らせる"
  // oracle = { type = "contract", ref = "issue-722 auxiliary summary loading feedback" }
  // fault = "loading/errorをAuxiliary存在として各親カードへ重複表示するか、未確定状態を0件・待機として隠す、またはfeedbackのaccessible statusを欠落させる"
  // observable = "loading/error各状態でのAuxiliary status clusterの不在とloading statusのaccessible nameまたはerror alertの文言"
  // observation_boundary = "component-behavior"
  // scope = "HomeMonitorContent auxiliary data state"
  // lifecycle = "permanent"
  // impact = "Auxiliaryの有無とsummary取得状態を混同させず、復旧可能な状態を利用者へ伝える"
  // @end-test-value
  /** Auxiliary 一覧が取得中やエラーのときは親行に未確定の集計を出さず、Monitor に対応する待機またはエラーを示す。 */
  it("Auxiliary summary未確定時は親カードへAuxiliaryを作らずMonitor feedbackを表示する", () => {
    const entries = [
      {
        kind: "agent" as const,
        session: createMonitorSession("loading-session", "Loading task"),
        state: { kind: "neutral" as const, label: "Idle" },
        mainState: { kind: "neutral" as const, label: "Idle" },
        auxiliarySessions: [],
      },
    ];
    for (const [auxiliaryDataState, expectedFeedback] of [
      ["loading", "Loading Auxiliary sessions"],
      ["error", "Could not load Auxiliary sessions."],
    ] as const) {
      const html = renderToStaticMarkup(
        <HomeMonitorContent
          approvalEntries={[]}
          runningEntries={[]}
          nonRunningEntries={entries}
          auxiliaryDataState={auxiliaryDataState}
          onOpenSession={noOp}
          onShowContextMenu={noOp}
        />,
      );
      const document = new JSDOM(html).window.document;

      assert.equal(
        document.querySelectorAll(".home-monitor-auxiliary-status").length,
        0,
      );
      if (auxiliaryDataState === "loading") {
        assert.equal(
          document
            .querySelector(
              '.home-session-list-load-status [role="status"], .home-session-list-load-status[role="status"]',
            )
            ?.getAttribute("aria-label"),
          expectedFeedback,
        );
        assert.equal(document.querySelector('[role="alert"]'), null);
      } else {
        assert.equal(
          document.querySelector('[role="alert"]')?.textContent,
          expectedFeedback,
        );
        assert.equal(
          document.querySelector(".home-session-list-load-status"),
          null,
        );
      }
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
  /** 親ごとの一覧を個別に展開し、親と Auxiliary を独立したボタンと正しい識別子で開く。 */
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
    const dom = new JSDOM(
      '<!doctype html><html><body><div id="root"></div></body></html>',
      {
        pretendToBeVisual: true,
      },
    );
    const container = dom.window.document.getElementById("root") as HTMLElement;
    const root = createRoot(container);
    const openedSessions: Array<{
      sessionId: string;
      auxiliarySessionId?: string;
    }> = [];
    /** 開く操作が渡した親 Session と、Auxiliary の場合だけ付く対象 ID を記録する。 */
    const recordOpenedSession = (
      sessionId: string,
      auxiliarySessionId?: string,
    ) => {
      openedSessions.push({ sessionId, auxiliarySessionId });
    };
    const auxiliarySessions = [
      {
        id: "aux-a",
        parentSessionId: "session-expand",
        runState: "idle",
        preview: "First auxiliary",
        createdAt: "2026-03-28T00:00:00.000Z",
      },
      {
        id: "aux-b",
        parentSessionId: "session-expand",
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
      session: createMonitorSession(
        "session-expand-2",
        "Second expandable task",
      ),
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
      PointerEvent: {
        configurable: true,
        value: dom.window.PointerEvent ?? dom.window.MouseEvent,
      },
    });

    try {
      await act(async () =>
        root.render(
          <HomeMonitorContent
            approvalEntries={[]}
            runningEntries={[]}
            nonRunningEntries={[entry, secondEntry]}
            onOpenSession={recordOpenedSession}
            onShowContextMenu={noOp}
          />,
        ),
      );

      const disclosures = Array.from(
        container.querySelectorAll<HTMLButtonElement>(
          "button.home-monitor-disclosure",
        ),
      );
      const parentButtons = Array.from(
        container.querySelectorAll<HTMLButtonElement>(
          "button.home-monitor-parent-button",
        ),
      );
      assert.equal(disclosures.length, 2);
      assert.equal(parentButtons.length, 2);
      assert.equal(
        container.querySelectorAll("button.home-monitor-auxiliary-row").length,
        0,
      );

      await act(async () =>
        disclosures[0]?.dispatchEvent(
          new dom.window.MouseEvent("click", { bubbles: true }),
        ),
      );
      let cards = Array.from(
        container.querySelectorAll<HTMLElement>(".home-monitor-card"),
      );
      assert.equal(cards.length, 2);
      assert.equal(
        cards[0]?.querySelectorAll("button.home-monitor-auxiliary-row").length,
        2,
      );
      assert.equal(
        cards[1]?.querySelectorAll("button.home-monitor-auxiliary-row").length,
        0,
      );
      const auxiliaryRows = Array.from(
        cards[0]?.querySelectorAll<HTMLButtonElement>(
          "button.home-monitor-auxiliary-row",
        ) ?? [],
      );
      assert.ok(auxiliaryRows[0]?.textContent?.includes("First auxiliary"));
      assert.equal(
        Array.from(container.querySelectorAll("button")).some((button) =>
          button.querySelector("button"),
        ),
        false,
      );

      await act(async () =>
        auxiliaryRows[1]?.dispatchEvent(
          new dom.window.MouseEvent("click", { bubbles: true }),
        ),
      );
      assert.deepEqual(openedSessions, [
        { sessionId: "session-expand", auxiliarySessionId: "aux-b" },
      ]);

      await act(async () =>
        parentButtons[0]?.dispatchEvent(
          new dom.window.MouseEvent("click", { bubbles: true }),
        ),
      );
      assert.deepEqual(openedSessions, [
        { sessionId: "session-expand", auxiliarySessionId: "aux-b" },
        { sessionId: "session-expand", auxiliarySessionId: undefined },
      ]);

      await act(async () =>
        root.render(
          <HomeMonitorContent
            approvalEntries={[]}
            runningEntries={[entry]}
            nonRunningEntries={[secondEntry]}
            onOpenSession={recordOpenedSession}
            onShowContextMenu={noOp}
          />,
        ),
      );
      cards = Array.from(
        container.querySelectorAll<HTMLElement>(".home-monitor-card"),
      );
      assert.equal(
        cards[0]?.querySelectorAll("button.home-monitor-auxiliary-row").length,
        2,
      );
      assert.equal(
        cards[1]?.querySelectorAll("button.home-monitor-auxiliary-row").length,
        0,
      );

      const movedDisclosures = Array.from(
        container.querySelectorAll<HTMLButtonElement>(
          "button.home-monitor-disclosure",
        ),
      );
      await act(async () =>
        movedDisclosures[1]?.dispatchEvent(
          new dom.window.MouseEvent("click", { bubbles: true }),
        ),
      );
      cards = Array.from(
        container.querySelectorAll<HTMLElement>(".home-monitor-card"),
      );
      assert.equal(
        cards[0]?.querySelectorAll("button.home-monitor-auxiliary-row").length,
        2,
      );
      assert.equal(
        cards[1]?.querySelectorAll("button.home-monitor-auxiliary-row").length,
        1,
      );
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
        KeyboardEvent: {
          configurable: true,
          value: previousGlobals.KeyboardEvent,
        },
        PointerEvent: {
          configurable: true,
          value: previousGlobals.PointerEvent,
        },
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
  /** 対象 Agent の右クリックとキーボードのメニュー操作を抑止し、正しい Session と入力手段に対応した座標でメニューを要求する。 */
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
    const dom = new JSDOM(
      '<!doctype html><html><body><div id="root"></div></body></html>',
      {
        pretendToBeVisual: true,
      },
    );
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
      PointerEvent: {
        configurable: true,
        value: dom.window.PointerEvent ?? dom.window.MouseEvent,
      },
    });
    try {
      await act(async () =>
        root.render(
          <HomeMonitorContent
            approvalEntries={[]}
            runningEntries={[entry]}
            nonRunningEntries={[]}
            onOpenSession={noOp}
            onShowContextMenu={(kind, sessionId, point) =>
              requests.push({ kind, sessionId, point })
            }
          />,
        ),
      );
      const row = container.querySelector<HTMLButtonElement>(
        "button.home-monitor-parent-button",
      );
      assert.ok(row);
      assert.equal(row.getAttribute("aria-haspopup"), "menu");
      Object.defineProperty(row, "getBoundingClientRect", {
        configurable: true,
        /** キー操作時のメニュー基準となる行位置を固定し、座標の丸めも観測できるようにする。 */
        value: () => ({ left: 120.4, bottom: 240.6 }),
      });
      const contextMenuEvent = new dom.window.MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 24,
        clientY: 48,
      });
      await act(async () => row.dispatchEvent(contextMenuEvent));
      assert.equal(contextMenuEvent.defaultPrevented, true);
      assert.deepEqual(requests, [
        {
          kind: "agent",
          sessionId: "session-context-menu",
          point: { x: 24, y: 48 },
        },
      ]);
      const keyboardEvent = new dom.window.KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "ContextMenu",
      });
      await act(async () => row.dispatchEvent(keyboardEvent));
      assert.equal(keyboardEvent.defaultPrevented, true);
      assert.deepEqual(requests.at(-1), {
        kind: "agent",
        sessionId: "session-context-menu",
        point: { x: 120, y: 241 },
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
        kind: "agent",
        sessionId: "session-context-menu",
        point: { x: 120, y: 241 },
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
        KeyboardEvent: {
          configurable: true,
          value: previousGlobals.KeyboardEvent,
        },
        PointerEvent: {
          configurable: true,
          value: previousGlobals.PointerEvent,
        },
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
  /** Monitor の操作失敗を polite なステータスで伝え、フィードバックが空ならライブ通知自体を出さない。 */
  it("Monitor feedbackは失敗時だけpoliteなlive statusを表示する", () => {
    const emptyHtml = renderToStaticMarkup(
      <HomeMonitorContent
        approvalEntries={[]}
        runningEntries={[]}
        nonRunningEntries={[]}
        onOpenSession={noOp}
        onShowContextMenu={noOp}
      />,
    );
    const failureHtml = renderToStaticMarkup(
      <HomeMonitorContent
        approvalEntries={[]}
        runningEntries={[]}
        nonRunningEntries={[]}
        feedback="Could not copy session ID."
        onOpenSession={noOp}
        onShowContextMenu={noOp}
      />,
    );

    assert.equal(
      new JSDOM(emptyHtml).window.document.querySelector(
        '.home-session-list-feedback [role="status"]',
      ),
      null,
    );
    assert.match(
      failureHtml,
      /role="status" aria-live="polite">Could not copy session ID\.<\/p>/,
    );
  });
});

/** Home の共通ヘッダーと右ペインで、タブ・Character 一覧・監視と復元操作を検証する。 */
describe("HomeRightPane", () => {
  /** 右ペインの描画確認用に、選択通知や外部ウィンドウを開かない既定の操作を渡す。 */
  const noOp = (..._args: unknown[]) => undefined;

  /** 選択中のタブと読込・復元・監視の各通知を切り替え、ヘッダーと右ペインを一緒に描画する。 */
  const renderHomeRightPane = (
    rightPaneView: "monitor" | "characters",
    characters = [
      {
        id: "char-1",
        name: "Mia",
        description: "説明文",
        iconFilePath: "",
        theme: { main: "#3b82f6", sub: "#1d4ed8" },
        state: "active" as const,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        archivedAt: null,
      },
    ],
    characterListFeedback = "",
    sessionWindowRestoreIds: readonly string[] = [],
    sessionWindowRestorePending = false,
    sessionWindowRestoreFeedback = "",
    sessionMonitorFeedback = "",
    characterLoadStatus: "loading" | "loaded" | "error" = "loaded",
  ) =>
    renderToStaticMarkup(
      <>
        <HomeHeader
          searchInputText=""
          onChangeSearchText={noOp}
          onOpenLaunchDialog={noOp}
          canCreateSession
          rightPaneView={rightPaneView}
          monitorWindowIcon={<span>Monitor</span>}
          onChangeRightPaneView={noOp}
          onOpenSessionMonitorWindow={noOp}
          onOpenSettingsWindow={noOp}
          onRestoreSessionWindows={noOp}
          sessionWindowRestoreIds={sessionWindowRestoreIds}
          sessionWindowRestorePending={sessionWindowRestorePending}
          sessionWindowRestoreFeedback={sessionWindowRestoreFeedback}
        />
        <HomeRightPane
          searchText=""
          rightPaneView={rightPaneView}
          approvalMonitorEntries={[]}
          runningMonitorEntries={[]}
          nonRunningMonitorEntries={[]}
          auxiliaryDataState="ready"
          characterEntries={characters}
          characterLoadStatus={characterLoadStatus}
          characterListFeedback={characterListFeedback}
          onCreateCharacter={noOp}
          onEditCharacter={noOp}
          onOpenSession={noOp}
          onShowSessionMonitorContextMenu={noOp}
          sessionMonitorFeedback={sessionMonitorFeedback}
        />
      </>,
    );

  /** Home の右ペインへ旧メイトークの入力・メッセージ・補助表示が戻っていないことを確認する。 */
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
  // claim = "Home Characters tabはcharacter情報・共通header検索・Create導線を表示し、旧Mate talkや既定カードを表示しない"
  // oracle = { type = "contract", ref = "docs/design/desktop-ui.md Home Window" }
  // fault = "Character tabが旧default/Mate talk surfaceへ戻るか、検索またはCreate導線を失う"
  // observable = "Characters見出し、Mia、説明文、検索label、Create icon、旧surfaceの不在"
  // observation_boundary = "component-behavior"
  // scope = "HomeRightPane Characters tab surface"
  // lifecycle = "permanent"
  // impact = "対象Characterの識別と作成導線を維持し、廃止したMate talk画面を復活させない"
  // distinction = "表示文字列だけでなく、旧surfaceを含む情報構造と検索/Create icon affordanceを同時に確認する"
  // @end-test-value
  /** Characters タブに候補、説明、検索と作成入口を表示し、旧メイトークや既定カード、独立編集ボタンは出さない。 */
  it("Characters タブは character list と Create を表示する", () => {
    const html = renderHomeRightPane("characters");

    assert.ok(html.includes("Characters"));
    assert.ok(html.includes("Mia"));
    assert.ok(html.includes("説明文"));
    assert.ok(html.includes("home-create-icon"));
    assert.ok(!html.includes("<h3>Characters</h3>"));
    assert.ok(html.includes('aria-label="Search Sessions And Characters"'));
    assert.ok(!html.includes(">Default</span>"));
    assert.match(html, /<button class="home-character-card"/);
    assert.ok(!html.includes("home-character-card-edit"));
    assert.ok(!html.includes("2026-01-01T00:00:00.000Z"));
    assert.ok(!html.includes("Your Mate"));
    assert.ok(!html.includes("メイトーク"));
  });

  /** Character 名を検索するときは前後の空白と大小文字を無視し、空白だけなら一覧を絞らない。 */
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

    assert.deepEqual(
      filterCharactersByName(characters, " NOA ").map(
        (character) => character.id,
      ),
      ["char-noah"],
    );
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
  /** Character がゼロ件の画面にも、アクセシブル名付きの作成操作を残す。 */
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
  /** 初期取得はスピナー、失敗は説明として表示し、どちらも取得完了の空一覧とは混同しない。 */
  it("Character list は初期取得中と取得失敗を空状態と区別する", () => {
    const loadingHtml = renderHomeRightPane(
      "characters",
      [],
      "",
      [],
      false,
      "",
      "",
      "loading",
    );
    const errorHtml = renderHomeRightPane(
      "characters",
      [],
      "",
      [],
      false,
      "",
      "",
      "error",
    );

    assert.ok(loadingHtml.includes("loading-indicator-spinner"));
    assert.ok(loadingHtml.includes('aria-label="Loading characters"'));
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
  /** Character 一覧を再取得できなかった通知をタブ内に表示し、作成の入口は保持する。 */
  it("Characters panel は一覧読み込み error を panel 内に表示する", () => {
    const html = renderHomeRightPane(
      "characters",
      [],
      "Could not refresh characters.",
    );

    assert.ok(html.includes("Could not refresh characters."));
    assert.ok(html.includes("home-create-icon"));
  });

  /** Monitor と Characters の双方で、メイトークをタブにも起動ボタンにも表示しない。 */
  it("メイトークは Home right pane のタブにも起動ボタンにも表示しない", () => {
    const monitorHtml = renderHomeRightPane("monitor");
    const characterHtml = renderHomeRightPane("characters");
    const tablistMatch = monitorHtml.match(
      /<div class="home-pane-toggle" role="tablist" aria-label="Home right pane">[\s\S]*?<\/div>/,
    );

    assert.ok(tablistMatch);
    assert.ok(tablistMatch[0].includes("Monitor"));
    assert.ok(tablistMatch[0].includes("Characters"));
    assert.ok(!tablistMatch[0].includes("Your Mate"));
    assert.ok(!tablistMatch[0].includes("メイトーク"));
    assert.doesNotMatch(
      monitorHtml,
      /<button class="launch-toggle home-settings-button"[^>]*>メイトーク<\/button>/,
    );
    assert.doesNotMatch(
      characterHtml,
      /<button class="launch-toggle home-settings-button"[^>]*>メイトーク<\/button>/,
    );
    assertNoMateTalkChatSurface(monitorHtml);
    assertNoMateTalkChatSurface(characterHtml);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "HomeHeaderのRestore Sessions操作は復元対象の有無と処理中状態をdisabledおよびaria-busyへ投影する"
  // oracle = { type = "contract", ref = "docs/features/session-window-restore.md#復元操作; docs/design/ui-design-guidelines.md#ボタン" }
  // fault = "対象がない状態または復元処理中に操作できて重複要求が発生するか、対象があるのにdisabledのままになる"
  // observable = "Restore Sessions buttonのdisabled属性とaria-busy属性"
  // observation_boundary = "component-behavior"
  // scope = "HomeHeader Restore sessions control"
  // lifecycle = "permanent"
  // impact = "復元操作の対象有無と処理中状態を識別し、重複要求を防ぐ"
  // distinction = "restore helperの入力選択ではなく、利用者が押すbuttonのdisabled/busy公開状態を確認する"
  // @end-test-value
  /** 一括復元の入口を常に置き、復元対象がないときと復元中は無効にし、処理中だけ busy を付ける。 */
  it("一括復元操作を上部へ常設し、対象なし・処理中をdisabledにする", () => {
    const emptyHtml = renderHomeRightPane("monitor");
    const enabledHtml = renderHomeRightPane("monitor", undefined, "", [
      "session-a",
      "session-b",
    ]);
    const pendingHtml = renderHomeRightPane(
      "monitor",
      undefined,
      "",
      ["session-a", "session-b"],
      true,
    );

    assert.match(emptyHtml, /Restore Sessions/);
    assert.match(
      emptyHtml,
      /class="restore-session-windows-button"[^>]*disabled=""/,
    );
    assert.match(enabledHtml, /Restore Sessions/);
    assert.doesNotMatch(
      enabledHtml,
      /class="restore-session-windows-button"[^>]*disabled=""/,
    );
    assert.match(
      pendingHtml,
      /class="restore-session-windows-button"[^>]*disabled=""[^>]*aria-busy="true"/,
    );
  });

  // @test-value v2
  // kind = "contract"
  // claim = "HomeHeaderのrestore feedbackは成功・対象なしではstatusを描画せず、失敗時だけ対象と理由をpolite live statusへ表示する"
  // oracle = { type = "contract", ref = "docs/features/session-window-restore.md#復元操作; docs/design/ui-design-guidelines.md#操作とアクセシビリティ" }
  // fault = "正常終了後も空statusを残すか、復元失敗時に対象と理由を支援技術へ通知できない"
  // observable = "success/failure HTMLのfeedback要素、role=status、aria-live=polite、失敗対象と理由"
  // observation_boundary = "component-behavior"
  // scope = "HomeHeader session restore feedback rendering"
  // lifecycle = "permanent"
  // impact = "復元結果を重複通知せず、失敗時だけ利用者へ識別可能に伝える"
  // distinction = "builderの文字列だけでなく、空文字によるDOM非表示と失敗文字列のlive status描画を確認する"
  // @end-test-value
  /** 復元成功では追加の状態通知を出さず、失敗した対象と理由だけを polite なライブステータスで伝える。 */
  it("復元feedbackは正常系でstatusを描画せず、失敗時だけlive statusを描画する", () => {
    const successHtml = renderHomeRightPane("monitor", undefined, "", [
      "session-a",
    ]);
    const failureHtml = renderHomeRightPane(
      "monitor",
      undefined,
      "",
      ["session-b"],
      false,
      "Could not restore sessions: session-b (Deleted)",
    );

    assert.doesNotMatch(successHtml, /session-window-restore-feedback/);
    assert.equal(
      new JSDOM(successHtml).window.document.querySelector(
        '.session-window-restore-feedback [role="status"], .session-window-restore-feedback[role="status"]',
      ),
      null,
    );
    assert.match(failureHtml, /session-b \(Deleted\)/);
    assert.match(failureHtml, /role="status" aria-live="polite"/);
    assert.doesNotMatch(failureHtml, /件のSessionを開きました/);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "HomeのMonitor tabはSession Monitor context menuの失敗feedbackを利用者向けlive statusへ表示する"
  // oracle = { type = "contract", ref = "docs/design/desktop-ui.md#home-window の Monitor（親行context menuの失敗表示）" }
  // fault = "HomeAppから渡されたcontext menu失敗messageがright paneで欠落するか、支援技術へ通知されない"
  // observable = "Monitor tab内のfeedback文字列、role=status、aria-live=polite"
  // observation_boundary = "component-behavior"
  // scope = "HomeRightPane Session Monitor feedback rendering"
  // lifecycle = "permanent"
  // impact = "HomeからのSession Monitor操作失敗を利用者へ伝える"
  // distinction = "session restore feedbackやCharacters feedbackではなく、Session Monitor context menu専用の表示経路を検証する"
  // @end-test-value
  /** Monitor のメニュー操作失敗を、選択された Monitor タブ内のライブステータスとして表示する。 */
  it("Session Monitor feedbackをMonitor tab内へ表示する", () => {
    const html = renderHomeRightPane(
      "monitor",
      undefined,
      "",
      [],
      false,
      "",
      "Could not copy session ID.",
    );

    const monitorPanel = JSDOM.fragment(html).querySelector(
      '[role="tabpanel"][aria-label="Session monitor"]',
    );
    assert.ok(monitorPanel);
    const status = monitorPanel.querySelector(
      '[role="status"][aria-live="polite"]',
    );
    assert.match(status?.textContent ?? "", /Could not copy session ID\./);
  });

  /** アイコン未設定の Character は名前から作った代替表示を使い、画像タグは出力しない。 */
  it("Character icon 未設定のとき fallback がレンダリングされ、画像タグは出力されない", () => {
    const html = renderHomeRightPane("characters", [
      {
        id: "char-2",
        name: "テストマテ",
        description: "説明文",
        iconFilePath: "",
        theme: { main: "#10b981", sub: "#047857" },
        state: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        archivedAt: null,
      },
    ]);

    assert.ok(html.includes('<span class="avatar-fallback">テ</span>'));
    assert.ok(!html.includes("<img"));
  });
});
