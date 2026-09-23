import { useRef, useState } from "react";
import type { AppSettings } from "../../src-shared/settings/provider-settings-state.js";
import {
  GLOSSARY_PROACTIVE_CREATE_LIMIT_MAX,
  GLOSSARY_PROACTIVE_CREATE_LIMIT_MIN,
} from "../../src-shared/settings/provider-settings-state.js";
import type { KeyboardShortcutSettings } from "../../src-shared/settings/keyboard-shortcut-state.js";
import type { MemoryV6Diagnostics } from "../../src-shared/memory/memory-diagnostics-state.js";
import {
  getMemoryFileQuotaMegabytes,
  getMemoryFileQuotaMegabytesInputBounds,
  type HomeProviderSettingRow,
} from "./settings-view-model.js";
import {
  SETTINGS_ACTION_DOCK_AUTO_CLOSE_LABEL,
  SETTINGS_CHARACTER_AFFECT_CONTEXT_LABEL,
  SETTINGS_CHARACTER_DEFINITION_LABEL,
  SETTINGS_CONVERSATION_TIMING_LABEL,
  SETTINGS_DELETE_OLD_SESSIONS_HELP,
  SETTINGS_DELETE_OLD_SESSIONS_LABEL,
  SETTINGS_DIAGNOSTICS_LABEL,
  SETTINGS_GLOSSARY_PROACTIVE_CREATE_LIMIT_HELP,
  SETTINGS_GLOSSARY_PROACTIVE_CREATE_LIMIT_LABEL,
  SETTINGS_LAUNCH_AT_LOGIN_LABEL,
  SETTINGS_MEMORY_FILE_QUOTA_HELP,
  SETTINGS_MEMORY_FILE_QUOTA_LABEL,
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
  SETTINGS_SESSION_TURN_NOTIFICATION_RESPONSE_PREVIEW_LABEL,
  SETTINGS_SCROLL_TO_LATEST_ON_SEND_LABEL,
  SETTINGS_TOOL_CALL_PRESENCE_LABEL,
} from "./settings-ui.js";
import { KeyboardShortcutsHelpSection } from "./KeyboardShortcutsDialog.js";

export type HomeSettingsContentProps = {
  settingsDraft: AppSettings;
  providerSettingRows: HomeProviderSettingRow[];
  modelCatalogRevisionLabel: string;
  memoryV6Diagnostics: MemoryV6Diagnostics | null;
  settingsDirty: boolean;
  settingsFeedback: string;
  sessionCleanupCutoffDate: string;
  deletingOldSessions: boolean;
  onChangeAutoCollapseActionDockOnSend: (enabled: boolean) => void;
  onChangeCharacterDefinitionEnabled: (enabled: boolean) => void;
  onChangeCharacterAffectContextEnabled: (enabled: boolean) => void;
  onChangeConversationTimingEnabled: (enabled: boolean) => void;
  onChangeScrollToLatestOnSend: (enabled: boolean) => void;
  onChangeKeyboardShortcuts: (settings: KeyboardShortcutSettings) => void;
  onChangeLaunchAtLoginEnabled: (enabled: boolean) => void;
  onChangeSessionTurnNotificationEnabled: (enabled: boolean) => void;
  onChangeSessionTurnNotificationResponsePreviewEnabled: (enabled: boolean) => void;
  onChangeToolCallPresenceEnabled: (enabled: boolean) => void;
  onChangeMemoryFileQuotaMegabytes: (value: string) => void;
  onChangeGlossaryProactiveCreateLimit: (value: string) => void;
  onChangeSessionCleanupCutoffDate: (value: string) => void;
  onChangeProviderEnabled: (providerId: string, enabled: boolean) => void;
  onChangeProviderSkillRootPath: (providerId: string, skillRootPath: string) => void;
  onChangeProviderSkillRelativePath: (providerId: string, skillRelativePath: string) => void;
  onChangeProviderInstructionRelativePath: (providerId: string, instructionRelativePath: string) => void;
  onBrowseProviderSkillRootPath: (providerId: string) => void;
  onBrowseProviderSkillRelativePath: (providerId: string) => void;
  onBrowseProviderInstructionRelativePath: (providerId: string) => void;
  onImportModelCatalog: () => void | Promise<void>;
  onExportModelCatalog: () => void | Promise<void>;
  onOpenAppLogFolder: () => void | Promise<void>;
  onOpenCrashDumpFolder: () => void | Promise<void>;
  onOpenMemoryV6Review: () => void | Promise<void>;
  onInstallMemoryV6CliShim: () => void | Promise<void>;
  onUninstallMemoryV6CliShim: () => void | Promise<void>;
  onDeleteSessionsLastActiveBefore: () => void | Promise<void>;
  onSaveSettings: () => void | Promise<void>;
};

type SettingsActionKey =
  | "import-models"
  | "export-models"
  | "open-logs"
  | "open-crash-dumps"
  | "review-memory"
  | "install-cli-shim"
  | "uninstall-cli-shim"
  | "browse-root"
  | "browse-skill"
  | "browse-instruction"
  | "delete-sessions"
  | "save-settings";

type PromptContextToggleProps = {
  id: string;
  label: string;
  checked: boolean;
  onChange: (enabled: boolean) => void;
};

function PromptContextToggle({ id, label, checked, onChange }: PromptContextToggleProps) {
  return (
    <div className="settings-provider-toggle-row settings-section-toggle">
      <label className="settings-provider-name" htmlFor={id}>{label}</label>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
    </div>
  );
}

type SettingsActionContentProps = {
  busy: boolean;
  label: string;
  busyLabel: string;
};

function SettingsActionContent({ busy, label, busyLabel }: SettingsActionContentProps) {
  if (!busy) {
    return label;
  }

  return (
    <>
      <span className="settings-action-spinner" aria-hidden="true" />
      <span>{label}</span>
      <span className="visually-hidden">{busyLabel}</span>
    </>
  );
}

export function HomeSettingsContent({
  settingsDraft,
  providerSettingRows,
  modelCatalogRevisionLabel,
  memoryV6Diagnostics,
  settingsDirty,
  settingsFeedback,
  sessionCleanupCutoffDate,
  deletingOldSessions,
  onChangeAutoCollapseActionDockOnSend,
  onChangeCharacterDefinitionEnabled,
  onChangeCharacterAffectContextEnabled,
  onChangeConversationTimingEnabled,
  onChangeScrollToLatestOnSend,
  onChangeKeyboardShortcuts,
  onChangeLaunchAtLoginEnabled,
  onChangeSessionTurnNotificationEnabled,
  onChangeSessionTurnNotificationResponsePreviewEnabled,
  onChangeToolCallPresenceEnabled,
  onChangeMemoryFileQuotaMegabytes,
  onChangeGlossaryProactiveCreateLimit,
  onChangeSessionCleanupCutoffDate,
  onChangeProviderEnabled,
  onChangeProviderSkillRootPath,
  onChangeProviderSkillRelativePath,
  onChangeProviderInstructionRelativePath,
  onBrowseProviderSkillRootPath,
  onBrowseProviderSkillRelativePath,
  onBrowseProviderInstructionRelativePath,
  onImportModelCatalog,
  onExportModelCatalog,
  onOpenAppLogFolder,
  onOpenCrashDumpFolder,
  onOpenMemoryV6Review,
  onInstallMemoryV6CliShim,
  onUninstallMemoryV6CliShim,
  onDeleteSessionsLastActiveBefore,
  onSaveSettings,
}: HomeSettingsContentProps) {
  const [busyAction, setBusyAction] = useState<SettingsActionKey | null>(null);
  const busyActionRef = useRef<SettingsActionKey | null>(null);
  const memoryFileQuotaMegabytes = getMemoryFileQuotaMegabytes(settingsDraft);
  const memoryFileQuotaBounds = getMemoryFileQuotaMegabytesInputBounds();
  const runAction = async (action: SettingsActionKey, callback: () => void | Promise<void>) => {
    if (busyActionRef.current) {
      return;
    }
    busyActionRef.current = action;
    setBusyAction(action);
    try {
      await callback();
    } finally {
      busyActionRef.current = null;
      setBusyAction(null);
    }
  };
  const isBusy = busyAction !== null;
  const actionIsBusy = (action: SettingsActionKey) => busyAction === action;

  return (
    <>
      <div className="settings-panel settings-panel-window" aria-busy={isBusy}>
        <div className="settings-panel-window-scroll">
          <section className="settings-section">
          <section className="settings-section-card">
            <div className="settings-field">
              <strong>App</strong>
              <label className="settings-provider-toggle-row settings-section-toggle">
                <span className="settings-provider-name">{SETTINGS_LAUNCH_AT_LOGIN_LABEL}</span>
                <input
                  type="checkbox"
                  checked={settingsDraft.launchAtLoginEnabled}
                  onChange={(event) => onChangeLaunchAtLoginEnabled(event.target.checked)}
                />
              </label>
              <label className="settings-provider-toggle-row settings-section-toggle">
                <span className="settings-provider-name">{SETTINGS_SESSION_TURN_NOTIFICATION_LABEL}</span>
                <input
                  type="checkbox"
                  checked={settingsDraft.sessionTurnNotificationEnabled}
                  onChange={(event) => onChangeSessionTurnNotificationEnabled(event.target.checked)}
                />
              </label>
              <label className="settings-provider-toggle-row settings-section-toggle">
                <span className="settings-provider-name">
                  {SETTINGS_SESSION_TURN_NOTIFICATION_RESPONSE_PREVIEW_LABEL}
                </span>
                <input
                  type="checkbox"
                  disabled={!settingsDraft.sessionTurnNotificationEnabled}
                  checked={settingsDraft.sessionTurnNotificationResponsePreviewEnabled}
                  onChange={(event) =>
                    onChangeSessionTurnNotificationResponsePreviewEnabled(event.target.checked)}
                />
              </label>
              <label className="settings-provider-toggle-row settings-section-toggle">
                <span className="settings-provider-name">{SETTINGS_ACTION_DOCK_AUTO_CLOSE_LABEL}</span>
                <input
                  type="checkbox"
                  checked={settingsDraft.autoCollapseActionDockOnSend}
                  onChange={(event) => onChangeAutoCollapseActionDockOnSend(event.target.checked)}
                />
              </label>
              <label className="settings-provider-toggle-row settings-section-toggle">
                <span className="settings-provider-name">{SETTINGS_SCROLL_TO_LATEST_ON_SEND_LABEL}</span>
                <input
                  type="checkbox"
                  checked={settingsDraft.scrollToLatestOnSend}
                  onChange={(event) => onChangeScrollToLatestOnSend(event.target.checked)}
                />
              </label>
            </div>
          </section>

          <section className="settings-section-card">
            <div className="settings-field">
              <strong>Prompt Context</strong>
              <PromptContextToggle
                id="settings-prompt-context-character-definition"
                label={SETTINGS_CHARACTER_DEFINITION_LABEL}
                checked={settingsDraft.characterDefinitionEnabled}
                onChange={onChangeCharacterDefinitionEnabled}
              />
              <PromptContextToggle
                id="settings-prompt-context-character-affect"
                label={SETTINGS_CHARACTER_AFFECT_CONTEXT_LABEL}
                checked={settingsDraft.characterAffectContextEnabled}
                onChange={onChangeCharacterAffectContextEnabled}
              />
              <PromptContextToggle
                id="settings-prompt-context-conversation-timing"
                label={SETTINGS_CONVERSATION_TIMING_LABEL}
                checked={settingsDraft.conversationTimingEnabled}
                onChange={onChangeConversationTimingEnabled}
              />
              <PromptContextToggle
                id="settings-prompt-context-tool-call-presence"
                label={SETTINGS_TOOL_CALL_PRESENCE_LABEL}
                checked={settingsDraft.toolCallPresenceEnabled}
                onChange={onChangeToolCallPresenceEnabled}
              />
            </div>
          </section>

          <section className="settings-section-card">
            <div className="settings-field">
              <strong>Coding Agent Providers</strong>
              {providerSettingRows.length > 0 ? (
                <div className="settings-provider-list">
                  {providerSettingRows.map(({ provider, settings }) => (
                    <section key={provider.id} className="settings-provider-card">
                      <label className="settings-provider-toggle-row">
                        <span className="settings-provider-name">{provider.label}</span>
                        <input
                          type="checkbox"
                          checked={settings.enabled}
                          onChange={(event) => onChangeProviderEnabled(provider.id, event.target.checked)}
                        />
                      </label>
                      <div className="settings-provider-file-settings">
                        <div>
                          <strong>{SETTINGS_PROVIDER_FILE_SETTINGS_LABEL}</strong>
                          <p className="settings-help">{SETTINGS_PROVIDER_FILE_SETTINGS_HELP}</p>
                        </div>
                        <label className="settings-provider-input">
                          <span>{SETTINGS_PROVIDER_ROOT_DIRECTORY_LABEL}</span>
                          <div className="settings-inline-input-row">
                            <input
                              type="text"
                              value={settings.skillRootPath}
                              onChange={(event) => onChangeProviderSkillRootPath(provider.id, event.target.value)}
                              placeholder={SETTINGS_PROVIDER_ROOT_DIRECTORY_PLACEHOLDER}
                              autoComplete="off"
                              spellCheck={false}
                            />
                            <button
                              className={`launch-toggle ${actionIsBusy("browse-root") ? "settings-action-busy" : ""}`.trim()}
                              type="button"
                              onClick={() => void runAction("browse-root", () => onBrowseProviderSkillRootPath(provider.id))}
                              disabled={isBusy}
                              aria-busy={actionIsBusy("browse-root")}
                              aria-label={actionIsBusy("browse-root") ? "Opening provider root directory" : "Browse"}
                            >
                              <SettingsActionContent
                                busy={actionIsBusy("browse-root")}
                                label="Browse"
                                busyLabel="Opening provider root directory."
                              />
                            </button>
                          </div>
                        </label>
                        <label className="settings-provider-input">
                          <span>{SETTINGS_PROVIDER_SKILL_RELATIVE_PATH_LABEL}</span>
                          <div className="settings-inline-input-row">
                            <input
                              type="text"
                              value={settings.skillRelativePath ?? ""}
                              onChange={(event) => onChangeProviderSkillRelativePath(provider.id, event.target.value)}
                              placeholder={SETTINGS_PROVIDER_SKILL_RELATIVE_PATH_PLACEHOLDER}
                              autoComplete="off"
                              spellCheck={false}
                            />
                            <button
                              className={`launch-toggle ${actionIsBusy("browse-skill") ? "settings-action-busy" : ""}`.trim()}
                              type="button"
                              onClick={() => void runAction("browse-skill", () => onBrowseProviderSkillRelativePath(provider.id))}
                              disabled={isBusy}
                              aria-busy={actionIsBusy("browse-skill")}
                              aria-label={actionIsBusy("browse-skill") ? "Opening skill folder" : "Browse"}
                            >
                              <SettingsActionContent
                                busy={actionIsBusy("browse-skill")}
                                label="Browse"
                                busyLabel="Opening skill folder."
                              />
                            </button>
                          </div>
                        </label>
                        <label className="settings-provider-input">
                          <span>{SETTINGS_PROVIDER_INSTRUCTION_RELATIVE_PATH_LABEL}</span>
                          <div className="settings-inline-input-row">
                            <input
                              type="text"
                              value={settings.instructionRelativePath ?? ""}
                              onChange={(event) => onChangeProviderInstructionRelativePath(provider.id, event.target.value)}
                              placeholder={SETTINGS_PROVIDER_INSTRUCTION_RELATIVE_PATH_PLACEHOLDER}
                              autoComplete="off"
                              spellCheck={false}
                            />
                            <button
                              className={`launch-toggle ${actionIsBusy("browse-instruction") ? "settings-action-busy" : ""}`.trim()}
                              type="button"
                              onClick={() => void runAction("browse-instruction", () => onBrowseProviderInstructionRelativePath(provider.id))}
                              disabled={isBusy}
                              aria-busy={actionIsBusy("browse-instruction")}
                              aria-label={actionIsBusy("browse-instruction") ? "Opening instruction file" : "Browse"}
                            >
                              <SettingsActionContent
                                busy={actionIsBusy("browse-instruction")}
                                label="Browse"
                                busyLabel="Opening instruction file."
                              />
                            </button>
                          </div>
                        </label>
                      </div>
                    </section>
                  ))}
                </div>
              ) : null}
            </div>
          </section>

          <section className="settings-section-card">
            <div className="settings-field">
              <strong>{SETTINGS_DIAGNOSTICS_LABEL}</strong>
              {memoryV6Diagnostics ? (
                <div className="settings-diagnostics-grid">
                  <div className="settings-diagnostics-item">
                    <span>Memory API</span>
                    <strong>{memoryV6Diagnostics.runtime.status}</strong>
                    <small>{memoryV6Diagnostics.runtime.discoveryPublished ? "Discovery Published" : "Discovery Unavailable"}</small>
                  </div>
                  <div className="settings-diagnostics-item">
                    <span>CLI Shim</span>
                    <strong>{memoryV6Diagnostics.cliShim.status}</strong>
                    <small>{formatCliShimDetail(memoryV6Diagnostics)}</small>
                  </div>
                  <div className="settings-diagnostics-item settings-diagnostics-wide">
                    <span>Last Error</span>
                    <strong>
                      {memoryV6Diagnostics.lastErrors[0]?.discoveryCode
                        ?? memoryV6Diagnostics.lastErrors[0]?.kind
                        ?? "None"}
                    </strong>
                    <small>{memoryV6Diagnostics.lastErrors.length > 0 ? "Review the application log for details." : "No recorded Memory V6 errors."}</small>
                  </div>
                </div>
              ) : (
                <div className="settings-loading-inline" role="status" aria-label="Loading Memory V6 diagnostics">
                  <span className="settings-action-spinner" aria-hidden="true" />
                </div>
              )}
              <div className="settings-actions">
                <button
                  className={`launch-toggle ${actionIsBusy("review-memory") ? "settings-action-busy" : ""}`.trim()}
                  type="button"
                  onClick={() => void runAction("review-memory", onOpenMemoryV6Review)}
                  disabled={isBusy}
                  aria-busy={actionIsBusy("review-memory")}
                  aria-label={actionIsBusy("review-memory") ? "Opening Memory review" : "Review Memory"}
                >
                  <SettingsActionContent
                    busy={actionIsBusy("review-memory")}
                    label="Review Memory"
                    busyLabel="Opening Memory review."
                  />
                </button>
                <button
                  className={`launch-toggle ${actionIsBusy("install-cli-shim") ? "settings-action-busy" : ""}`.trim()}
                  type="button"
                  onClick={() => void runAction("install-cli-shim", onInstallMemoryV6CliShim)}
                  disabled={isBusy || !memoryV6Diagnostics?.cliShim.supported}
                  aria-busy={actionIsBusy("install-cli-shim")}
                  aria-label={actionIsBusy("install-cli-shim") ? "Installing CLI shim" : "Install CLI Shim"}
                >
                  <SettingsActionContent
                    busy={actionIsBusy("install-cli-shim")}
                    label="Install CLI Shim"
                    busyLabel="Installing CLI shim."
                  />
                </button>
                <button
                  className={`launch-toggle ${actionIsBusy("uninstall-cli-shim") ? "settings-action-busy" : ""}`.trim()}
                  type="button"
                  onClick={() => void runAction("uninstall-cli-shim", onUninstallMemoryV6CliShim)}
                  disabled={isBusy || !canUninstallCliShim(memoryV6Diagnostics)}
                  aria-busy={actionIsBusy("uninstall-cli-shim")}
                  aria-label={actionIsBusy("uninstall-cli-shim") ? "Uninstalling CLI shim" : "Uninstall CLI Shim"}
                >
                  <SettingsActionContent
                    busy={actionIsBusy("uninstall-cli-shim")}
                    label="Uninstall CLI Shim"
                    busyLabel="Uninstalling CLI shim."
                  />
                </button>
                <button
                  className={`launch-toggle ${actionIsBusy("open-logs") ? "settings-action-busy" : ""}`.trim()}
                  type="button"
                  onClick={() => void runAction("open-logs", onOpenAppLogFolder)}
                  disabled={isBusy}
                  aria-busy={actionIsBusy("open-logs")}
                  aria-label={actionIsBusy("open-logs") ? "Opening application logs" : SETTINGS_OPEN_LOG_FOLDER_LABEL}
                >
                  <SettingsActionContent
                    busy={actionIsBusy("open-logs")}
                    label={SETTINGS_OPEN_LOG_FOLDER_LABEL}
                    busyLabel="Opening application logs."
                  />
                </button>
                <button
                  className={`launch-toggle ${actionIsBusy("open-crash-dumps") ? "settings-action-busy" : ""}`.trim()}
                  type="button"
                  onClick={() => void runAction("open-crash-dumps", onOpenCrashDumpFolder)}
                  disabled={isBusy}
                  aria-busy={actionIsBusy("open-crash-dumps")}
                  aria-label={actionIsBusy("open-crash-dumps") ? "Opening crash dumps" : SETTINGS_OPEN_CRASH_DUMP_FOLDER_LABEL}
                >
                  <SettingsActionContent
                    busy={actionIsBusy("open-crash-dumps")}
                    label={SETTINGS_OPEN_CRASH_DUMP_FOLDER_LABEL}
                    busyLabel="Opening crash dumps."
                  />
                </button>
              </div>
            </div>
          </section>

          <section className="settings-section-card">
            <div className="settings-field">
              <strong>Model Catalog</strong>
              <p className="settings-help">ActiveRevision: {modelCatalogRevisionLabel}</p>
              <div className="settings-actions">
                <button
                  className={`launch-toggle ${actionIsBusy("import-models") ? "settings-action-busy" : ""}`.trim()}
                  type="button"
                  onClick={() => void runAction("import-models", onImportModelCatalog)}
                  disabled={isBusy}
                  aria-busy={actionIsBusy("import-models")}
                  aria-label={actionIsBusy("import-models") ? "Importing models" : "Import Models"}
                >
                  <SettingsActionContent
                    busy={actionIsBusy("import-models")}
                    label="Import Models"
                    busyLabel="Importing models."
                  />
                </button>
                <button
                  className={`launch-toggle ${actionIsBusy("export-models") ? "settings-action-busy" : ""}`.trim()}
                  type="button"
                  onClick={() => void runAction("export-models", onExportModelCatalog)}
                  disabled={isBusy}
                  aria-busy={actionIsBusy("export-models")}
                  aria-label={actionIsBusy("export-models") ? "Exporting models" : "Export Models"}
                >
                  <SettingsActionContent
                    busy={actionIsBusy("export-models")}
                    label="Export Models"
                    busyLabel="Exporting models."
                  />
                </button>
              </div>
            </div>
          </section>

          <section className="settings-section-card">
            <div className="settings-field">
              <strong>Repository Glossary</strong>
              <label className="settings-provider-input">
                <span>{SETTINGS_GLOSSARY_PROACTIVE_CREATE_LIMIT_LABEL}</span>
                <div className="settings-inline-input-row">
                  <input
                    type="number"
                    min={GLOSSARY_PROACTIVE_CREATE_LIMIT_MIN}
                    max={GLOSSARY_PROACTIVE_CREATE_LIMIT_MAX}
                    step={1}
                    value={settingsDraft.glossaryProactiveCreateLimit ?? ""}
                    onChange={(event) => onChangeGlossaryProactiveCreateLimit(event.target.value)}
                  />
                  <span className="settings-inline-unit">Terms</span>
                </div>
                <p className="settings-help">{SETTINGS_GLOSSARY_PROACTIVE_CREATE_LIMIT_HELP}</p>
              </label>
            </div>
          </section>

          <section className="settings-section-card">
            <div className="settings-field">
              <strong>Storage Maintenance</strong>
              <label className="settings-provider-input">
                <span>{SETTINGS_MEMORY_FILE_QUOTA_LABEL}</span>
                <div className="settings-inline-input-row">
                  <input
                    type="number"
                    min={memoryFileQuotaBounds.min}
                    max={memoryFileQuotaBounds.max}
                    step={64}
                    value={memoryFileQuotaMegabytes}
                    onChange={(event) => onChangeMemoryFileQuotaMegabytes(event.target.value)}
                  />
                  <span className="settings-inline-unit">MB</span>
                </div>
                <p className="settings-help">{SETTINGS_MEMORY_FILE_QUOTA_HELP}</p>
              </label>
              <label className="settings-provider-input">
                <span>{SETTINGS_DELETE_OLD_SESSIONS_LABEL}</span>
                <div className="settings-inline-input-row">
                  <input
                    type="date"
                    value={sessionCleanupCutoffDate}
                    onChange={(event) => onChangeSessionCleanupCutoffDate(event.target.value)}
                    disabled={deletingOldSessions || isBusy}
                  />
                  <button
                    className="launch-toggle"
                    type="button"
                    onClick={() => void runAction("delete-sessions", onDeleteSessionsLastActiveBefore)}
                    disabled={deletingOldSessions || isBusy || !sessionCleanupCutoffDate}
                    aria-busy={actionIsBusy("delete-sessions")}
                    aria-label={actionIsBusy("delete-sessions") ? "Deleting old sessions" : "Delete"}
                  >
                    <SettingsActionContent
                      busy={actionIsBusy("delete-sessions")}
                      label="Delete"
                      busyLabel="Deleting old sessions."
                    />
                  </button>
                </div>
                <p className="settings-help">{SETTINGS_DELETE_OLD_SESSIONS_HELP}</p>
              </label>
            </div>
          </section>

          <KeyboardShortcutsHelpSection
            settings={settingsDraft.keyboardShortcuts}
            onChange={onChangeKeyboardShortcuts}
          />

          </section>
        </div>
      </div>
      <div className="launch-dialog-foot settings-dialog-foot">
        <div className="settings-footer-status" aria-live="polite">
          {settingsDirty ? <span className="settings-dirty-state">Unsaved Changes</span> : null}
          {settingsFeedback ? <p className="settings-feedback settings-feedback-inline" role="status">{settingsFeedback}</p> : null}
        </div>
        <button
          className={`launch-toggle ${actionIsBusy("save-settings") ? "settings-action-busy" : ""}`.trim()}
          type="button"
          onClick={() => void runAction("save-settings", onSaveSettings)}
          disabled={!settingsDirty || isBusy}
          aria-busy={actionIsBusy("save-settings")}
          aria-label={actionIsBusy("save-settings") ? "Saving settings" : "Save Settings"}
        >
          <SettingsActionContent
            busy={actionIsBusy("save-settings")}
            label="Save Settings"
            busyLabel="Saving settings."
          />
        </button>
      </div>
    </>
  );
}

function formatCliShimDetail(diagnostics: MemoryV6Diagnostics): string {
  const shim = diagnostics.cliShim;
  if (!shim.supported) {
    return shim.status === "managed-by-installer" ? "Managed By Installer" : "Unsupported";
  }

  const pathStatus = shim.pathContainsShimDirectory ? "PATH Ready" : "PATH Missing";
  return `${pathStatus}: ${shim.commandName}`;
}

function canUninstallCliShim(diagnostics: MemoryV6Diagnostics | null): boolean {
  return diagnostics?.cliShim.supported === true && [
    "installed",
    "installed-path-missing",
    "stale",
  ].includes(diagnostics.cliShim.status);
}
