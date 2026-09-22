import { useRef, useState } from "react";
import type { AppSettings } from "../../src-shared/settings/provider-settings-state.js";
import {
  GLOSSARY_PROACTIVE_CREATE_LIMIT_MAX,
  GLOSSARY_PROACTIVE_CREATE_LIMIT_MIN,
} from "../../src-shared/settings/provider-settings-state.js";
import type { KeyboardShortcutSettings } from "../../src-shared/settings/keyboard-shortcut-state.js";
import type { MemoryV6Diagnostics } from "../../src-shared/memory/memory-diagnostics-state.js";
import { MICROCOPY_SLOTS, type MicrocopySlot } from "../../src-shared/settings/microcopy-state.js";
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
  SETTINGS_PROVIDER_INSTRUCTION_RELATIVE_PATH_HELP,
  SETTINGS_PROVIDER_INSTRUCTION_RELATIVE_PATH_LABEL,
  SETTINGS_PROVIDER_INSTRUCTION_RELATIVE_PATH_PLACEHOLDER,
  SETTINGS_PROVIDER_SKILL_RELATIVE_PATH_HELP,
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
  providerCatalogLoaded: boolean;
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
  onChangeUserMicrocopySlot: (slot: MicrocopySlot, value: string) => void;
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

const MICROCOPY_SLOT_LABEL: Record<MicrocopySlot, string> = {
  "chat.pending.response_waiting": "Chat / response waiting",
  "dock.status.approval": "Action dock / approval",
  "dock.status.working": "Action dock / working",
  "dock.status.responding": "Action dock / responding",
  "dock.status.preparing": "Action dock / preparing",
  "retry.interrupted.title": "Retry / interrupted",
  "retry.failed.title": "Retry / failed",
  "retry.canceled.title": "Retry / canceled",
  "composer.error.path_not_found": "Composer / path not found",
  "empty.latest_command.waiting": "Empty / command waiting",
  "empty.latest_command": "Empty / no command",
  "empty.changed_files": "Empty / no changes",
  "empty.context": "Empty / no context",
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

const microcopyTextareaValue = (value: AppSettings["userMicrocopyCatalog"][MicrocopySlot]): string => {
  if (typeof value === "string") {
    return value;
  }

  return (value ?? []).join("\n");
};

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

export function HomeSettingsContent({
  settingsDraft,
  providerSettingRows,
  providerCatalogLoaded,
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
  onChangeUserMicrocopySlot,
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
              <strong>Prompt context</strong>
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
              <strong>Default microcopy</strong>
              <p className="settings-note">Use one line per candidate. Leave a slot empty to use the system default.</p>
              <div className="settings-provider-list">
                {MICROCOPY_SLOTS.map((slot) => (
                  <label key={slot} className="settings-provider-input">
                    <span>{MICROCOPY_SLOT_LABEL[slot]}</span>
                    <textarea
                      className="settings-microcopy-textarea"
                      value={microcopyTextareaValue(settingsDraft.userMicrocopyCatalog[slot])}
                      onChange={(event) => onChangeUserMicrocopySlot(slot, event.target.value)}
                      rows={3}
                      spellCheck={false}
                    />
                  </label>
                ))}
              </div>
            </div>
          </section>

          <section className="settings-section-card">
            <div className="settings-field">
              <strong>Coding agent providers</strong>
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
                            >
                              {actionIsBusy("browse-root") ? "Opening…" : "Browse"}
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
                            >
                              {actionIsBusy("browse-skill") ? "Opening…" : "Browse"}
                            </button>
                          </div>
                          <p className="settings-help">{SETTINGS_PROVIDER_SKILL_RELATIVE_PATH_HELP}</p>
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
                            >
                              {actionIsBusy("browse-instruction") ? "Opening…" : "Browse"}
                            </button>
                          </div>
                          <p className="settings-help">{SETTINGS_PROVIDER_INSTRUCTION_RELATIVE_PATH_HELP}</p>
                        </label>
                      </div>
                    </section>
                  ))}
                </div>
              ) : (
                <p className="settings-note">
                  {providerCatalogLoaded
                    ? "No coding agent providers found in the model catalog."
                    : "Could not load the model catalog."}
                </p>
              )}
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
                    <small>{memoryV6Diagnostics.runtime.discoveryPublished ? "Discovery published" : "Discovery unavailable"}</small>
                  </div>
                  <div className="settings-diagnostics-item">
                    <span>CLI shim</span>
                    <strong>{memoryV6Diagnostics.cliShim.status}</strong>
                    <small>{formatCliShimDetail(memoryV6Diagnostics)}</small>
                  </div>
                  <div className="settings-diagnostics-item settings-diagnostics-wide">
                    <span>Last error</span>
                    <strong>
                      {memoryV6Diagnostics.lastErrors[0]?.discoveryCode
                        ?? memoryV6Diagnostics.lastErrors[0]?.kind
                        ?? "none"}
                    </strong>
                    <small>{memoryV6Diagnostics.lastErrors.length > 0 ? "Review the application log for details." : "No recorded Memory V6 errors."}</small>
                  </div>
                </div>
              ) : (
                <p className="settings-note">Loading Memory V6 diagnostics…</p>
              )}
              <div className="settings-actions">
                <button
                  className={`launch-toggle ${actionIsBusy("review-memory") ? "settings-action-busy" : ""}`.trim()}
                  type="button"
                  onClick={() => void runAction("review-memory", onOpenMemoryV6Review)}
                  disabled={isBusy}
                  aria-busy={actionIsBusy("review-memory")}
                >
                  {actionIsBusy("review-memory") ? "Opening…" : "Review memory"}
                </button>
                <button
                  className={`launch-toggle ${actionIsBusy("install-cli-shim") ? "settings-action-busy" : ""}`.trim()}
                  type="button"
                  onClick={() => void runAction("install-cli-shim", onInstallMemoryV6CliShim)}
                  disabled={isBusy || !memoryV6Diagnostics?.cliShim.supported}
                  aria-busy={actionIsBusy("install-cli-shim")}
                >
                  {actionIsBusy("install-cli-shim") ? "Installing…" : "Install CLI shim"}
                </button>
                <button
                  className={`launch-toggle ${actionIsBusy("uninstall-cli-shim") ? "settings-action-busy" : ""}`.trim()}
                  type="button"
                  onClick={() => void runAction("uninstall-cli-shim", onUninstallMemoryV6CliShim)}
                  disabled={isBusy || !canUninstallCliShim(memoryV6Diagnostics)}
                  aria-busy={actionIsBusy("uninstall-cli-shim")}
                >
                  {actionIsBusy("uninstall-cli-shim") ? "Uninstalling…" : "Uninstall CLI shim"}
                </button>
                <button
                  className={`launch-toggle ${actionIsBusy("open-logs") ? "settings-action-busy" : ""}`.trim()}
                  type="button"
                  onClick={() => void runAction("open-logs", onOpenAppLogFolder)}
                  disabled={isBusy}
                  aria-busy={actionIsBusy("open-logs")}
                >
                  {actionIsBusy("open-logs") ? "Opening…" : SETTINGS_OPEN_LOG_FOLDER_LABEL}
                </button>
                <button
                  className={`launch-toggle ${actionIsBusy("open-crash-dumps") ? "settings-action-busy" : ""}`.trim()}
                  type="button"
                  onClick={() => void runAction("open-crash-dumps", onOpenCrashDumpFolder)}
                  disabled={isBusy}
                  aria-busy={actionIsBusy("open-crash-dumps")}
                >
                  {actionIsBusy("open-crash-dumps") ? "Opening…" : SETTINGS_OPEN_CRASH_DUMP_FOLDER_LABEL}
                </button>
              </div>
            </div>
          </section>

          <section className="settings-section-card">
            <div className="settings-field">
              <strong>Model catalog</strong>
              <p className="settings-help">Active revision: {modelCatalogRevisionLabel}</p>
              <div className="settings-actions">
                <button
                  className={`launch-toggle ${actionIsBusy("import-models") ? "settings-action-busy" : ""}`.trim()}
                  type="button"
                  onClick={() => void runAction("import-models", onImportModelCatalog)}
                  disabled={isBusy}
                  aria-busy={actionIsBusy("import-models")}
                >
                  {actionIsBusy("import-models") ? "Importing…" : "Import models"}
                </button>
                <button
                  className={`launch-toggle ${actionIsBusy("export-models") ? "settings-action-busy" : ""}`.trim()}
                  type="button"
                  onClick={() => void runAction("export-models", onExportModelCatalog)}
                  disabled={isBusy}
                  aria-busy={actionIsBusy("export-models")}
                >
                  {actionIsBusy("export-models") ? "Exporting…" : "Export models"}
                </button>
              </div>
            </div>
          </section>

          <section className="settings-section-card">
            <div className="settings-field">
              <strong>Repository glossary</strong>
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
                  <span className="settings-inline-unit">terms</span>
                </div>
                <p className="settings-help">{SETTINGS_GLOSSARY_PROACTIVE_CREATE_LIMIT_HELP}</p>
              </label>
            </div>
          </section>

          <section className="settings-section-card">
            <div className="settings-field">
              <strong>Storage maintenance</strong>
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
                  >
                    {actionIsBusy("delete-sessions") ? "Deleting…" : "Delete"}
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
          {settingsDirty ? <span className="settings-dirty-state">Unsaved changes</span> : null}
          {settingsFeedback ? <p className="settings-feedback settings-feedback-inline" role="status">{settingsFeedback}</p> : null}
        </div>
        <button
          className={`launch-toggle ${actionIsBusy("save-settings") ? "settings-action-busy" : ""}`.trim()}
          type="button"
          onClick={() => void runAction("save-settings", onSaveSettings)}
          disabled={!settingsDirty || isBusy}
          aria-busy={actionIsBusy("save-settings")}
        >
          {actionIsBusy("save-settings") ? "Saving…" : "Save settings"}
        </button>
      </div>
    </>
  );
}

function formatCliShimDetail(diagnostics: MemoryV6Diagnostics): string {
  const shim = diagnostics.cliShim;
  if (!shim.supported) {
    return shim.status === "managed-by-installer" ? "managed by installer" : "unsupported";
  }

  const pathStatus = shim.pathContainsShimDirectory ? "PATH ready" : "PATH missing";
  return `${pathStatus}: ${shim.commandName}`;
}

function canUninstallCliShim(diagnostics: MemoryV6Diagnostics | null): boolean {
  return diagnostics?.cliShim.supported === true && [
    "installed",
    "installed-path-missing",
    "stale",
  ].includes(diagnostics.cliShim.status);
}
