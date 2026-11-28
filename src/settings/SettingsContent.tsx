import { useLayoutEffect, useRef, useState } from "react";
import type { ModelCatalogSnapshot } from "../../src-shared/settings/model-catalog.js";
import type { ModelAvailabilitySettings } from "../../src-shared/settings/model-availability.js";
import { ProviderModelSettings } from "./provider-model-settings.js";
import type { AppSettings } from "../../src-shared/settings/provider-settings-state.js";
import {
  isWithMateReviewDraftIncomplete,
  WithMateAutoReviewSettings,
} from "./WithMateAutoReviewSettings.js";
import {
  GLOSSARY_PROACTIVE_CREATE_LIMIT_MAX,
  GLOSSARY_PROACTIVE_CREATE_LIMIT_MIN,
  PREVIEW_WHEEL_ZOOM_STEP_MIN,
  PREVIEW_WHEEL_ZOOM_STEP_MAX,
  isPreviewWheelZoomStep,
} from "../../src-shared/settings/provider-settings-state.js";
import type { KeyboardShortcutSettings } from "../../src-shared/settings/keyboard-shortcut-state.js";
import { type HomeProviderSettingRow } from "./settings-view-model.js";
import {
  SETTINGS_ACTION_DOCK_AUTO_CLOSE_LABEL,
  SETTINGS_CHARACTER_DEFINITION_LABEL,
  SETTINGS_CURRENT_DATE_LABEL,
  SETTINGS_DELETE_OLD_SESSIONS_HELP,
  SETTINGS_DELETE_OLD_SESSIONS_LABEL,
  SETTINGS_DIAGNOSTICS_LABEL,
  SETTINGS_GLOSSARY_PROACTIVE_CREATE_LIMIT_HELP,
  SETTINGS_GLOSSARY_PROACTIVE_CREATE_LIMIT_LABEL,
  SETTINGS_LAUNCH_AT_LOGIN_LABEL,
  SETTINGS_OPEN_LOG_FOLDER_LABEL,
  SETTINGS_OPEN_CRASH_DUMP_FOLDER_LABEL,
  SETTINGS_PROVIDER_FILE_SETTINGS_HELP,
  SETTINGS_PROVIDER_FILE_SETTINGS_LABEL,
  SETTINGS_PROVIDER_INSTRUCTION_RELATIVE_PATH_LABEL,
  SETTINGS_PROVIDER_INSTRUCTION_RELATIVE_PATH_PLACEHOLDER,
  SETTINGS_PROVIDER_SKILL_RELATIVE_PATH_LABEL,
  SETTINGS_PROVIDER_SKILL_RELATIVE_PATH_PLACEHOLDER,
  SETTINGS_PROVIDER_ROOT_DIRECTORY_LABEL,
  SETTINGS_PROVIDER_ROOT_DIRECTORY_PLACEHOLDER,
  SETTINGS_SESSION_TURN_NOTIFICATION_LABEL,
  SETTINGS_SESSION_APPROVAL_NOTIFICATION_LABEL,
  SETTINGS_SESSION_TURN_NOTIFICATION_RESPONSE_PREVIEW_LABEL,
  SETTINGS_SCROLL_TO_LATEST_ON_SEND_LABEL,
} from "./settings-ui.js";
import { KeyboardShortcutsHelpSection } from "./KeyboardShortcutsDialog.js";
import { LoadingIndicator } from "../ui/loading-indicator.js";
import { ButtonContent } from "../ui/button-content.js";
import { LoadError } from "../ui/load-error.js";
import { SettingsActionButton } from "./SettingsActionButton.js";
import { SessionFolderCleanup } from "./SessionFolderCleanup.js";
import { AppVersion } from "./AppVersion.js";

/** アプリ設定の下書き、読込状態、操作別の結果と、画面から親へ通知する操作。 */
export type HomeSettingsContentProps = {
  settingsDraft: AppSettings;
  providerSettingRows: HomeProviderSettingRow[];
  modelDiscovery?: ModelCatalogSnapshot["discovery"];
  onChangeModelAvailability: (availability: ModelAvailabilitySettings) => void;
  onChangeWithMateAutoReview: (
    selection: AppSettings["withMateAutoReview"],
  ) => void;
  settingsDraftLoaded: boolean;
  appSettingsLoadStatus: "loading" | "loaded" | "error";
  appSettingsLoadError: string;
  onRetryAppSettings: () => void;
  modelCatalogLoadStatus: "loading" | "loaded" | "error";
  modelCatalogLoadError: string;
  onRetryModelCatalog: () => void;
  settingsDirty: boolean;
  settingsFeedback: string;
  settingsErrors: ReadonlyMap<string, string>;
  sessionCleanupCutoffDate: string;
  deletingOldSessions: boolean;
  onChangeAutoCollapseActionDockOnSend: (enabled: boolean) => void;
  onChangeCharacterDefinitionEnabled: (enabled: boolean) => void;
  onChangeCurrentDateEnabled: (enabled: boolean) => void;
  onChangeScrollToLatestOnSend: (enabled: boolean) => void;
  onChangePreviewWheelZoomStep: (value: number) => void;
  onChangeKeyboardShortcuts: (settings: KeyboardShortcutSettings) => void;
  onChangeLaunchAtLoginEnabled: (enabled: boolean) => void;
  onChangeSessionTurnNotificationEnabled: (enabled: boolean) => void;
  onChangeSessionApprovalNotificationEnabled: (enabled: boolean) => void;
  onChangeSessionTurnNotificationResponsePreviewEnabled: (
    enabled: boolean,
  ) => void;
  onChangeGlossaryProactiveCreateLimit: (value: string) => void;
  onChangeSessionCleanupCutoffDate: (value: string) => void;
  onChangeProviderEnabled: (providerId: string, enabled: boolean) => void;
  onChangeProviderSkillRootPath: (
    providerId: string,
    skillRootPath: string,
  ) => void;
  onChangeProviderSkillRelativePath: (
    providerId: string,
    skillRelativePath: string,
  ) => void;
  onChangeProviderInstructionRelativePath: (
    providerId: string,
    instructionRelativePath: string,
  ) => void;
  onBrowseProviderSkillRootPath: (providerId: string) => void | Promise<void>;
  onBrowseProviderSkillRelativePath: (
    providerId: string,
  ) => void | Promise<void>;
  onBrowseProviderInstructionRelativePath: (
    providerId: string,
  ) => void | Promise<void>;
  onOpenAppLogFolder: () => void | Promise<void>;
  onOpenCrashDumpFolder: () => void | Promise<void>;
  onDeleteSessionsLastActiveBefore: () => void | Promise<void>;
  onSaveSettings: () => void | Promise<void>;
};

/** 保存・削除・参照などの進行とエラーを個別に追う識別子。参照操作はプロバイダーも区別する。 */
type SettingsActionKey =
  | "open-logs"
  | "open-crash-dumps"
  | `browse-root:${string}`
  | `browse-skill:${string}`
  | `browse-instruction:${string}`
  | "delete-sessions"
  | "save-settings";

/** 同一操作の再入、保存とセッション削除の並行実行、ネイティブ選択画面の同時表示を拒む。 */
function settingsActionsConflict(
  action: SettingsActionKey,
  pending: SettingsActionKey,
): boolean {
  // 設定の保存は Session の実行設定を更新する場合があり、クリーンアップはそれらの Session を削除する。
  /** アプリ設定の保存または古いセッションの削除に当たる操作を識別する。 */
  const updatesSettingsOrSessions = (key: SettingsActionKey) =>
    key === "save-settings" || key === "delete-sessions";
  // Provider の下書き用の選択画面も含め、ネイティブのファイルダイアログは一度に一つだけ開く。
  /** 参照先の種類やプロバイダーによらず、ネイティブの選択画面を開く操作を識別する。 */
  const opensFileDialog = (key: SettingsActionKey) => key.startsWith("browse-");
  return (
    action === pending ||
    (updatesSettingsOrSessions(action) && updatesSettingsOrSessions(pending)) ||
    (opensFileDialog(action) && opensFileDialog(pending))
  );
}

/** プロンプトへの情報追加を制御するチェックボックスの表示値と変更通知。 */
type PromptContextToggleProps = {
  id: string;
  label: string;
  checked: boolean;
  onChange: (enabled: boolean) => void;
};

/** プロンプトに情報を追加するかを表示し、変更された真偽値を親に渡す。 */
function PromptContextToggle({
  id,
  label,
  checked,
  onChange,
}: PromptContextToggleProps) {
  return (
    <div className="settings-provider-toggle-row settings-section-toggle">
      <label className="settings-provider-name" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
    </div>
  );
}

/** 設定の読込・編集中の値と結果を表示し、保存や保守操作を親へ委ねる。モデル可用性の編集も同じ下書きへ反映する。 */
export function HomeSettingsContent({
  settingsDraft,
  providerSettingRows,
  modelDiscovery,
  onChangeModelAvailability,
  onChangeWithMateAutoReview,
  settingsDraftLoaded,
  appSettingsLoadStatus,
  appSettingsLoadError,
  onRetryAppSettings,
  modelCatalogLoadStatus,
  modelCatalogLoadError,
  onRetryModelCatalog,
  settingsDirty,
  settingsFeedback,
  settingsErrors,
  sessionCleanupCutoffDate,
  deletingOldSessions,
  onChangeAutoCollapseActionDockOnSend,
  onChangeCharacterDefinitionEnabled,
  onChangeCurrentDateEnabled,
  onChangeScrollToLatestOnSend,
  onChangePreviewWheelZoomStep,
  onChangeKeyboardShortcuts,
  onChangeLaunchAtLoginEnabled,
  onChangeSessionTurnNotificationEnabled,
  onChangeSessionApprovalNotificationEnabled,
  onChangeSessionTurnNotificationResponsePreviewEnabled,
  onChangeGlossaryProactiveCreateLimit,
  onChangeSessionCleanupCutoffDate,
  onChangeProviderEnabled,
  onChangeProviderSkillRootPath,
  onChangeProviderSkillRelativePath,
  onChangeProviderInstructionRelativePath,
  onBrowseProviderSkillRootPath,
  onBrowseProviderSkillRelativePath,
  onBrowseProviderInstructionRelativePath,
  onOpenAppLogFolder,
  onOpenCrashDumpFolder,
  onDeleteSessionsLastActiveBefore,
  onSaveSettings,
}: HomeSettingsContentProps) {
  const [busyActions, setBusyActions] = useState<
    ReadonlySet<SettingsActionKey>
  >(() => new Set());
  const busyActionsRef = useRef(new Set<SettingsActionKey>());
  const [invalidPreviewWheelZoomStep, setInvalidPreviewWheelZoomStep] =
    useState<string | null>(null);
  const [cleaningSessionFiles, setCleaningSessionFiles] = useState(false);
  const [modelProviderId, setModelProviderId] = useState<string | null>(null);
  const modelsTriggerRefs = useRef(new Map<string, HTMLButtonElement>());
  const restoreModelsFocusRef = useRef<string | null>(null);
  const modelProvider = providerSettingRows.find(
    (row) => row.provider.id === modelProviderId,
  );
  useLayoutEffect(() => {
    if (modelProviderId === null && restoreModelsFocusRef.current) {
      modelsTriggerRefs.current.get(restoreModelsFocusRef.current)?.focus();
      restoreModelsFocusRef.current = null;
    }
  }, [modelProviderId]);
  const previewWheelZoomStepInvalid = invalidPreviewWheelZoomStep !== null;
  const autoReviewIncomplete = isWithMateReviewDraftIncomplete(
    settingsDraft.withMateAutoReview,
    providerSettingRows,
  );
  /** 保留中の操作と競合しない場合だけ実行し、例外が起きてもその操作の実行中状態を解除する。 */
  const runAction = async (
    action: SettingsActionKey,
    callback: () => void | Promise<void>,
  ) => {
    if (
      [...busyActionsRef.current].some((pending) =>
        settingsActionsConflict(action, pending),
      )
    ) {
      return;
    }
    busyActionsRef.current.add(action);
    setBusyActions(new Set(busyActionsRef.current));
    try {
      await callback();
    } finally {
      busyActionsRef.current.delete(action);
      setBusyActions(new Set(busyActionsRef.current));
    }
  };
  /** 対象操作自身が実行中かを判定し、ボタンの進行表示に使う。 */
  const actionIsBusy = (action: SettingsActionKey) => busyActions.has(action);
  /** 自身または他の実行中操作との競合によって操作を無効にするか判定する。 */
  const actionIsBlocked = (action: SettingsActionKey) =>
    [...busyActions].some((pending) =>
      settingsActionsConflict(action, pending),
    );

  return (
    <>
      <div className="settings-panel settings-panel-window">
        <div className="settings-panel-window-scroll">
          {modelProvider ? (
            <fieldset
              className="settings-app-settings-fieldset"
              disabled={appSettingsLoadStatus !== "loaded"}
            >
              <ProviderModelSettings
                provider={modelProvider.provider}
                availability={settingsDraft.modelAvailability}
                providerEnabled={modelProvider.settings.enabled}
                discovery={modelDiscovery?.[modelProvider.provider.id]}
                onChange={onChangeModelAvailability}
                onRetry={onRetryModelCatalog}
                onBack={() => {
                  restoreModelsFocusRef.current = modelProvider.provider.id;
                  setModelProviderId(null);
                }}
              />
            </fieldset>
          ) : (
            <section className="settings-section">
              {!settingsDraftLoaded ? (
                <details className="settings-section-card" open>
                  <summary>App</summary>
                  <div className="settings-field">
                    {appSettingsLoadStatus === "loading" ? (
                      <LoadingIndicator label="Loading app settings" />
                    ) : null}
                    {appSettingsLoadStatus === "error" ? (
                      <LoadError
                        message={
                          appSettingsLoadError || "Could not load app settings."
                        }
                        onRetry={onRetryAppSettings}
                      />
                    ) : null}
                  </div>
                </details>
              ) : null}
              {!settingsDraftLoaded ? (
                <details className="settings-section-card" open>
                  <summary>Coding Agent Providers</summary>
                  <div className="settings-field">
                    {modelCatalogLoadStatus === "loading" ? (
                      <LoadingIndicator label="Loading model catalog" />
                    ) : null}
                    {modelCatalogLoadStatus === "error" ? (
                      <LoadError
                        message={
                          modelCatalogLoadError ||
                          "Could not load model catalog."
                        }
                        onRetry={onRetryModelCatalog}
                      />
                    ) : null}
                  </div>
                </details>
              ) : null}
              <fieldset
                className="settings-app-settings-fieldset"
                disabled={appSettingsLoadStatus !== "loaded"}
              >
                {settingsDraftLoaded ? (
                  <>
                    <details className="settings-section-card" open>
                      <summary>App</summary>
                      <div className="settings-field">
                        <label className="settings-provider-toggle-row settings-section-toggle">
                          <span className="settings-provider-name">
                            {SETTINGS_LAUNCH_AT_LOGIN_LABEL}
                          </span>
                          <input
                            type="checkbox"
                            checked={settingsDraft.launchAtLoginEnabled}
                            onChange={(event) =>
                              onChangeLaunchAtLoginEnabled(event.target.checked)
                            }
                          />
                        </label>
                        <details className="settings-subsection" open>
                          <summary>Notifications</summary>
                          <div className="settings-subsection-body">
                            <label className="settings-provider-toggle-row settings-section-toggle">
                              <span className="settings-provider-name">
                                {SETTINGS_SESSION_TURN_NOTIFICATION_LABEL}
                              </span>
                              <input
                                type="checkbox"
                                checked={
                                  settingsDraft.sessionTurnNotificationEnabled
                                }
                                onChange={(event) =>
                                  onChangeSessionTurnNotificationEnabled(
                                    event.target.checked,
                                  )
                                }
                              />
                            </label>
                            <label className="settings-provider-toggle-row settings-section-toggle">
                              <span className="settings-provider-name">
                                {
                                  SETTINGS_SESSION_TURN_NOTIFICATION_RESPONSE_PREVIEW_LABEL
                                }
                              </span>
                              <input
                                type="checkbox"
                                disabled={
                                  !settingsDraft.sessionTurnNotificationEnabled
                                }
                                checked={
                                  settingsDraft.sessionTurnNotificationResponsePreviewEnabled
                                }
                                onChange={(event) =>
                                  onChangeSessionTurnNotificationResponsePreviewEnabled(
                                    event.target.checked,
                                  )
                                }
                              />
                            </label>
                            <label className="settings-provider-toggle-row settings-section-toggle">
                              <span className="settings-provider-name">
                                {SETTINGS_SESSION_APPROVAL_NOTIFICATION_LABEL}
                              </span>
                              <input
                                type="checkbox"
                                checked={
                                  settingsDraft.sessionApprovalNotificationEnabled
                                }
                                onChange={(event) =>
                                  onChangeSessionApprovalNotificationEnabled(
                                    event.target.checked,
                                  )
                                }
                              />
                            </label>
                          </div>
                        </details>
                        <label className="settings-provider-toggle-row settings-section-toggle">
                          <span className="settings-provider-name">
                            {SETTINGS_ACTION_DOCK_AUTO_CLOSE_LABEL}
                          </span>
                          <input
                            type="checkbox"
                            checked={settingsDraft.autoCollapseActionDockOnSend}
                            onChange={(event) =>
                              onChangeAutoCollapseActionDockOnSend(
                                event.target.checked,
                              )
                            }
                          />
                        </label>
                        <label className="settings-provider-toggle-row settings-section-toggle">
                          <span className="settings-provider-name">
                            {SETTINGS_SCROLL_TO_LATEST_ON_SEND_LABEL}
                          </span>
                          <input
                            type="checkbox"
                            checked={settingsDraft.scrollToLatestOnSend}
                            onChange={(event) =>
                              onChangeScrollToLatestOnSend(event.target.checked)
                            }
                          />
                        </label>
                        <div className="settings-provider-input">
                          <div className="settings-inline-input-row settings-preview-zoom-row">
                            <label
                              className="settings-provider-name"
                              htmlFor="settings-preview-wheel-zoom-step"
                            >
                              Preview Wheel Zoom Step
                            </label>
                            <input
                              id="settings-preview-wheel-zoom-step"
                              type="number"
                              min={PREVIEW_WHEEL_ZOOM_STEP_MIN}
                              max={PREVIEW_WHEEL_ZOOM_STEP_MAX}
                              step={1}
                              required
                              value={
                                invalidPreviewWheelZoomStep ??
                                settingsDraft.previewWheelZoomStep
                              }
                              aria-invalid={previewWheelZoomStepInvalid}
                              aria-describedby={
                                previewWheelZoomStepInvalid
                                  ? "settings-preview-wheel-zoom-step-error"
                                  : undefined
                              }
                              onChange={(event) => {
                                const rawValue = event.target.value;
                                const value = event.target.valueAsNumber;
                                if (isPreviewWheelZoomStep(value)) {
                                  setInvalidPreviewWheelZoomStep(null);
                                  onChangePreviewWheelZoomStep(value);
                                } else {
                                  setInvalidPreviewWheelZoomStep(rawValue);
                                }
                              }}
                            />
                          </div>
                          {previewWheelZoomStepInvalid ? (
                            <p
                              id="settings-preview-wheel-zoom-step-error"
                              className="settings-help"
                              role="alert"
                            >
                              Enter a whole number from 1 to 100.
                            </p>
                          ) : null}
                        </div>
                      </div>
                    </details>

                    <details className="settings-section-card" open>
                      <summary>Prompt Context</summary>
                      <div className="settings-field">
                        <PromptContextToggle
                          id="settings-prompt-context-character-definition"
                          label={SETTINGS_CHARACTER_DEFINITION_LABEL}
                          checked={settingsDraft.characterDefinitionEnabled}
                          onChange={onChangeCharacterDefinitionEnabled}
                        />

                        <PromptContextToggle
                          id="settings-prompt-context-current-date"
                          label={SETTINGS_CURRENT_DATE_LABEL}
                          checked={settingsDraft.currentDateEnabled}
                          onChange={onChangeCurrentDateEnabled}
                        />
                      </div>
                    </details>

                    <WithMateAutoReviewSettings
                      selection={settingsDraft.withMateAutoReview}
                      rows={providerSettingRows}
                      availability={settingsDraft.modelAvailability}
                      onChange={onChangeWithMateAutoReview}
                    />

                    <details className="settings-section-card" open>
                      <summary>Coding Agent Providers</summary>
                      <div className="settings-field">
                        {modelCatalogLoadStatus === "loading" ? (
                          <LoadingIndicator label="Loading model catalog" />
                        ) : null}
                        {modelCatalogLoadStatus === "error" ? (
                          <LoadError
                            message={
                              modelCatalogLoadError ||
                              "Could not load model catalog."
                            }
                            onRetry={onRetryModelCatalog}
                          />
                        ) : null}
                        {providerSettingRows.length > 0 ? (
                          <div className="settings-provider-list">
                            {providerSettingRows.map(
                              ({ provider, settings }) => (
                                <details
                                  key={provider.id}
                                  className="settings-subsection settings-provider-card"
                                  open
                                >
                                  <summary>
                                    {provider.label}
                                    <span className="settings-provider-state">
                                      {settings.enabled
                                        ? "Enabled"
                                        : "Disabled"}
                                    </span>
                                  </summary>
                                  <div className="settings-subsection-body">
                                    <div className="settings-provider-model-entry">
                                      <label className="settings-provider-toggle-row">
                                        <span className="settings-provider-name">
                                          Enabled
                                        </span>
                                        <input
                                          type="checkbox"
                                          aria-label={`${provider.label} Enabled`}
                                          checked={settings.enabled}
                                          onChange={(event) =>
                                            onChangeProviderEnabled(
                                              provider.id,
                                              event.target.checked,
                                            )
                                          }
                                        />
                                      </label>
                                      <button
                                        ref={(element) => {
                                          if (element)
                                            modelsTriggerRefs.current.set(
                                              provider.id,
                                              element,
                                            );
                                          else
                                            modelsTriggerRefs.current.delete(
                                              provider.id,
                                            );
                                        }}
                                        type="button"
                                        className="launch-toggle"
                                        aria-label={`Manage ${provider.label} Models`}
                                        onClick={() =>
                                          setModelProviderId(provider.id)
                                        }
                                      >
                                        Models
                                      </button>
                                    </div>
                                    {provider.id === "claude" ? (
                                      <p className="settings-help">
                                        Uses local Claude Code authentication
                                        and billing settings. Sign in with the
                                        official CLI before starting a session.
                                      </p>
                                    ) : null}
                                    {provider.id === "opencode" ? (
                                      <p className="settings-help">
                                        Configure authentication in OpenCode.
                                      </p>
                                    ) : null}
                                    <details
                                      className="settings-subsection settings-provider-file-settings"
                                      open
                                    >
                                      <summary>
                                        {SETTINGS_PROVIDER_FILE_SETTINGS_LABEL}
                                      </summary>
                                      <div className="settings-subsection-body">
                                        <div>
                                          <p className="settings-help">
                                            {
                                              SETTINGS_PROVIDER_FILE_SETTINGS_HELP
                                            }
                                          </p>
                                          {provider.id === "opencode" ? (
                                            <p className="settings-help">
                                              Use the OpenCode config root with
                                              AGENTS.md and
                                              skills/&lt;name&gt;/SKILL.md.
                                              Custom paths are not registered
                                              with OpenCode automatically.
                                            </p>
                                          ) : null}
                                        </div>
                                        <label className="settings-provider-input">
                                          <span>
                                            {
                                              SETTINGS_PROVIDER_ROOT_DIRECTORY_LABEL
                                            }
                                          </span>
                                          <div className="settings-inline-input-row">
                                            <input
                                              type="text"
                                              value={settings.skillRootPath}
                                              onChange={(event) =>
                                                onChangeProviderSkillRootPath(
                                                  provider.id,
                                                  event.target.value,
                                                )
                                              }
                                              placeholder={
                                                SETTINGS_PROVIDER_ROOT_DIRECTORY_PLACEHOLDER
                                              }
                                              autoComplete="off"
                                              spellCheck={false}
                                            />
                                            <SettingsActionButton
                                              failure={settingsErrors.get(
                                                `browse-root:${provider.id}`,
                                              )}
                                              actionLabel={`Choose Root Directory for ${provider.label}`}
                                              className="launch-toggle"
                                              type="button"
                                              onClick={() =>
                                                void runAction(
                                                  `browse-root:${provider.id}`,
                                                  () =>
                                                    onBrowseProviderSkillRootPath(
                                                      provider.id,
                                                    ),
                                                )
                                              }
                                              disabled={actionIsBlocked(
                                                `browse-root:${provider.id}`,
                                              )}
                                              aria-busy={actionIsBusy(
                                                `browse-root:${provider.id}`,
                                              )}
                                              aria-label={
                                                actionIsBusy(
                                                  `browse-root:${provider.id}`,
                                                )
                                                  ? `Opening provider root directory for ${provider.label}`
                                                  : "Browse"
                                              }
                                            >
                                              <ButtonContent
                                                busy={actionIsBusy(
                                                  `browse-root:${provider.id}`,
                                                )}
                                                busyLabel={`Opening provider root directory for ${provider.label}.`}
                                              >
                                                Browse
                                              </ButtonContent>
                                            </SettingsActionButton>
                                          </div>
                                        </label>
                                        <label className="settings-provider-input">
                                          <span>
                                            {
                                              SETTINGS_PROVIDER_SKILL_RELATIVE_PATH_LABEL
                                            }
                                          </span>
                                          <div className="settings-inline-input-row">
                                            <input
                                              type="text"
                                              value={
                                                settings.skillRelativePath ?? ""
                                              }
                                              onChange={(event) =>
                                                onChangeProviderSkillRelativePath(
                                                  provider.id,
                                                  event.target.value,
                                                )
                                              }
                                              placeholder={
                                                SETTINGS_PROVIDER_SKILL_RELATIVE_PATH_PLACEHOLDER
                                              }
                                              autoComplete="off"
                                              spellCheck={false}
                                            />
                                            <SettingsActionButton
                                              failure={settingsErrors.get(
                                                `browse-skill:${provider.id}`,
                                              )}
                                              actionLabel={`Choose Skill Folder for ${provider.label}`}
                                              className="launch-toggle"
                                              type="button"
                                              onClick={() =>
                                                void runAction(
                                                  `browse-skill:${provider.id}`,
                                                  () =>
                                                    onBrowseProviderSkillRelativePath(
                                                      provider.id,
                                                    ),
                                                )
                                              }
                                              disabled={actionIsBlocked(
                                                `browse-skill:${provider.id}`,
                                              )}
                                              aria-busy={actionIsBusy(
                                                `browse-skill:${provider.id}`,
                                              )}
                                              aria-label={
                                                actionIsBusy(
                                                  `browse-skill:${provider.id}`,
                                                )
                                                  ? `Opening skill folder for ${provider.label}`
                                                  : "Browse"
                                              }
                                            >
                                              <ButtonContent
                                                busy={actionIsBusy(
                                                  `browse-skill:${provider.id}`,
                                                )}
                                                busyLabel={`Opening skill folder for ${provider.label}.`}
                                              >
                                                Browse
                                              </ButtonContent>
                                            </SettingsActionButton>
                                          </div>
                                        </label>
                                        <label className="settings-provider-input">
                                          <span>
                                            {
                                              SETTINGS_PROVIDER_INSTRUCTION_RELATIVE_PATH_LABEL
                                            }
                                          </span>
                                          <div className="settings-inline-input-row">
                                            <input
                                              type="text"
                                              value={
                                                settings.instructionRelativePath ??
                                                ""
                                              }
                                              onChange={(event) =>
                                                onChangeProviderInstructionRelativePath(
                                                  provider.id,
                                                  event.target.value,
                                                )
                                              }
                                              placeholder={
                                                SETTINGS_PROVIDER_INSTRUCTION_RELATIVE_PATH_PLACEHOLDER
                                              }
                                              autoComplete="off"
                                              spellCheck={false}
                                            />
                                            <SettingsActionButton
                                              failure={settingsErrors.get(
                                                `browse-instruction:${provider.id}`,
                                              )}
                                              actionLabel={`Choose Instruction File for ${provider.label}`}
                                              className="launch-toggle"
                                              type="button"
                                              onClick={() =>
                                                void runAction(
                                                  `browse-instruction:${provider.id}`,
                                                  () =>
                                                    onBrowseProviderInstructionRelativePath(
                                                      provider.id,
                                                    ),
                                                )
                                              }
                                              disabled={actionIsBlocked(
                                                `browse-instruction:${provider.id}`,
                                              )}
                                              aria-busy={actionIsBusy(
                                                `browse-instruction:${provider.id}`,
                                              )}
                                              aria-label={
                                                actionIsBusy(
                                                  `browse-instruction:${provider.id}`,
                                                )
                                                  ? `Opening instruction file for ${provider.label}`
                                                  : "Browse"
                                              }
                                            >
                                              <ButtonContent
                                                busy={actionIsBusy(
                                                  `browse-instruction:${provider.id}`,
                                                )}
                                                busyLabel={`Opening instruction file for ${provider.label}.`}
                                              >
                                                Browse
                                              </ButtonContent>
                                            </SettingsActionButton>
                                          </div>
                                        </label>
                                      </div>
                                    </details>
                                  </div>
                                </details>
                              ),
                            )}
                          </div>
                        ) : null}
                      </div>
                    </details>
                  </>
                ) : null}
              </fieldset>

              <details className="settings-section-card" open>
                <summary>{SETTINGS_DIAGNOSTICS_LABEL}</summary>
                <div className="settings-field">
                  <details className="settings-subsection" open>
                    <summary>Application Logs</summary>
                    <div className="settings-subsection-body settings-actions">
                      <SettingsActionButton
                        failure={settingsErrors.get("open-logs")}
                        actionLabel="Open Logs"
                        className="launch-toggle"
                        type="button"
                        onClick={() =>
                          void runAction("open-logs", onOpenAppLogFolder)
                        }
                        disabled={actionIsBlocked("open-logs")}
                        aria-busy={actionIsBusy("open-logs")}
                        aria-label={
                          actionIsBusy("open-logs")
                            ? "Opening application logs"
                            : SETTINGS_OPEN_LOG_FOLDER_LABEL
                        }
                      >
                        <ButtonContent
                          busy={actionIsBusy("open-logs")}
                          busyLabel="Opening application logs."
                        >
                          {SETTINGS_OPEN_LOG_FOLDER_LABEL}
                        </ButtonContent>
                      </SettingsActionButton>
                      <SettingsActionButton
                        failure={settingsErrors.get("open-crash-dumps")}
                        actionLabel="Open Crash Dumps"
                        className="launch-toggle"
                        type="button"
                        onClick={() =>
                          void runAction(
                            "open-crash-dumps",
                            onOpenCrashDumpFolder,
                          )
                        }
                        disabled={actionIsBlocked("open-crash-dumps")}
                        aria-busy={actionIsBusy("open-crash-dumps")}
                        aria-label={
                          actionIsBusy("open-crash-dumps")
                            ? "Opening crash dumps"
                            : SETTINGS_OPEN_CRASH_DUMP_FOLDER_LABEL
                        }
                      >
                        <ButtonContent
                          busy={actionIsBusy("open-crash-dumps")}
                          busyLabel="Opening crash dumps."
                        >
                          {SETTINGS_OPEN_CRASH_DUMP_FOLDER_LABEL}
                        </ButtonContent>
                      </SettingsActionButton>
                    </div>
                  </details>
                </div>
              </details>

              {settingsDraftLoaded ? (
                <fieldset
                  className="settings-app-settings-fieldset"
                  disabled={appSettingsLoadStatus !== "loaded"}
                >
                  <details className="settings-section-card" open>
                    <summary>Repository Glossary</summary>
                    <div className="settings-field">
                      <label className="settings-provider-input">
                        <span>
                          {SETTINGS_GLOSSARY_PROACTIVE_CREATE_LIMIT_LABEL}
                        </span>
                        <div className="settings-inline-input-row">
                          <input
                            type="number"
                            min={GLOSSARY_PROACTIVE_CREATE_LIMIT_MIN}
                            max={GLOSSARY_PROACTIVE_CREATE_LIMIT_MAX}
                            step={1}
                            value={
                              settingsDraft.glossaryProactiveCreateLimit ?? ""
                            }
                            onChange={(event) =>
                              onChangeGlossaryProactiveCreateLimit(
                                event.target.value,
                              )
                            }
                          />
                          <span className="settings-inline-unit">Terms</span>
                        </div>
                        <p className="settings-help">
                          {SETTINGS_GLOSSARY_PROACTIVE_CREATE_LIMIT_HELP}
                        </p>
                      </label>
                    </div>
                  </details>

                  <details className="settings-section-card" open>
                    <summary>Storage Maintenance</summary>
                    <div className="settings-field">
                      <details className="settings-subsection" open>
                        <summary>{SETTINGS_DELETE_OLD_SESSIONS_LABEL}</summary>
                        <div className="settings-subsection-body">
                          <label className="settings-provider-input">
                            <span>Last Active Before</span>
                            <div className="settings-inline-input-row">
                              <input
                                type="date"
                                aria-label="Delete Old Sessions Last Active Before"
                                value={sessionCleanupCutoffDate}
                                onChange={(event) =>
                                  onChangeSessionCleanupCutoffDate(
                                    event.target.value,
                                  )
                                }
                                disabled={
                                  cleaningSessionFiles ||
                                  deletingOldSessions ||
                                  actionIsBusy("delete-sessions")
                                }
                              />
                              <SettingsActionButton
                                failure={settingsErrors.get("delete-sessions")}
                                actionLabel="Delete Old Sessions"
                                className="launch-toggle"
                                type="button"
                                onClick={() =>
                                  void runAction(
                                    "delete-sessions",
                                    onDeleteSessionsLastActiveBefore,
                                  )
                                }
                                disabled={
                                  cleaningSessionFiles ||
                                  deletingOldSessions ||
                                  actionIsBlocked("delete-sessions") ||
                                  !sessionCleanupCutoffDate
                                }
                                aria-busy={actionIsBusy("delete-sessions")}
                                aria-label={
                                  actionIsBusy("delete-sessions")
                                    ? "Deleting old sessions"
                                    : "Delete"
                                }
                              >
                                <ButtonContent
                                  busy={actionIsBusy("delete-sessions")}
                                  busyLabel="Deleting old sessions."
                                >
                                  Delete
                                </ButtonContent>
                              </SettingsActionButton>
                            </div>
                            <p className="settings-help">
                              {SETTINGS_DELETE_OLD_SESSIONS_HELP}
                            </p>
                          </label>
                        </div>
                      </details>
                      <SessionFolderCleanup
                        disabled={
                          deletingOldSessions || actionIsBusy("delete-sessions")
                        }
                        onBusyChange={setCleaningSessionFiles}
                      />
                    </div>
                  </details>

                  <KeyboardShortcutsHelpSection
                    settings={settingsDraft.keyboardShortcuts}
                    onChange={onChangeKeyboardShortcuts}
                  />
                </fieldset>
              ) : null}

              <AppVersion />
            </section>
          )}
        </div>
      </div>
      <div className="launch-dialog-foot settings-dialog-foot">
        <div className="settings-footer-status" aria-live="polite">
          {settingsDirty || previewWheelZoomStepInvalid ? (
            <span className="settings-dirty-state">Unsaved Changes</span>
          ) : null}
          {settingsFeedback ? (
            <p
              className="settings-feedback settings-feedback-inline"
              role="status"
            >
              {settingsFeedback}
            </p>
          ) : null}
        </div>
        <SettingsActionButton
          failure={settingsErrors.get("save-settings")}
          actionLabel="Save Settings"
          className="launch-toggle"
          type="button"
          onClick={() => void runAction("save-settings", onSaveSettings)}
          disabled={
            !settingsDirty ||
            previewWheelZoomStepInvalid ||
            autoReviewIncomplete ||
            actionIsBlocked("save-settings") ||
            appSettingsLoadStatus !== "loaded"
          }
          aria-busy={actionIsBusy("save-settings")}
          aria-label={
            actionIsBusy("save-settings") ? "Saving settings" : "Save Settings"
          }
        >
          <ButtonContent
            busy={actionIsBusy("save-settings")}
            busyLabel="Saving settings."
          >
            Save Settings
          </ButtonContent>
        </SettingsActionButton>
      </div>
    </>
  );
}
