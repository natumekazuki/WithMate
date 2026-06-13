import type { AppSettings } from "../app-state.js";
import { MICROCOPY_SLOTS, type MicrocopySlot } from "../microcopy-state.js";
import type { HomeProviderSettingRow } from "./settings-view-model.js";
import {
  SETTINGS_ACTION_DOCK_AUTO_CLOSE_LABEL,
  SETTINGS_MATE_RESET_HELP,
  SETTINGS_MATE_RESET_LABEL,
  SETTINGS_DIAGNOSTICS_LABEL,
  SETTINGS_OPEN_LOG_FOLDER_LABEL,
  SETTINGS_OPEN_CRASH_DUMP_FOLDER_LABEL,
} from "./settings-ui.js";

export type HomeSettingsContentProps = {
  settingsDraft: AppSettings;
  providerSettingRows: HomeProviderSettingRow[];
  modelCatalogRevisionLabel: string;
  settingsDirty: boolean;
  settingsFeedback: string;
  onChangeAutoCollapseActionDockOnSend: (enabled: boolean) => void;
  onChangeUserMicrocopySlot: (slot: MicrocopySlot, value: string) => void;
  onChangeProviderEnabled: (providerId: string, enabled: boolean) => void;
  onImportModelCatalog: () => void;
  onExportModelCatalog: () => void;
  onOpenAppLogFolder: () => void;
  onOpenCrashDumpFolder: () => void;
  onResetMate?: () => void;
  mateResetBusy?: boolean;
  canResetMate?: boolean;
  onSaveSettings: () => void;
};

const MICROCOPY_SLOT_LABEL: Record<MicrocopySlot, string> = {
  "chat.pending.response_waiting": "Chat / 応答待機",
  "dock.status.approval": "ActionDock / 承認待機",
  "dock.status.working": "ActionDock / 処理中",
  "dock.status.responding": "ActionDock / 応答生成中",
  "dock.status.preparing": "ActionDock / 応答準備中",
  "retry.interrupted.title": "Retry / 中断",
  "retry.failed.title": "Retry / 失敗",
  "retry.canceled.title": "Retry / キャンセル",
  "empty.latest_command.waiting": "Empty / command 待機",
  "empty.latest_command": "Empty / command なし",
  "empty.changed_files": "Empty / 変更なし",
  "empty.context": "Empty / context なし",
};

const microcopyTextareaValue = (value: AppSettings["userMicrocopyCatalog"][MicrocopySlot]): string => {
  if (typeof value === "string") {
    return value;
  }

  return (value ?? []).join("\n");
};

export function HomeSettingsContent({
  settingsDraft,
  providerSettingRows,
  modelCatalogRevisionLabel,
  settingsDirty,
  settingsFeedback,
  onChangeAutoCollapseActionDockOnSend,
  onChangeUserMicrocopySlot,
  onChangeProviderEnabled,
  onImportModelCatalog,
  onExportModelCatalog,
  onOpenAppLogFolder,
  onOpenCrashDumpFolder,
  onResetMate,
  mateResetBusy = false,
  canResetMate = false,
  onSaveSettings,
}: HomeSettingsContentProps) {
  return (
    <>
      <div className="settings-panel settings-panel-window">
        <div className="settings-panel-window-scroll">
          <section className="settings-section">
          <section className="settings-section-card">
            <div className="settings-field">
              <strong>Session Window</strong>
              <label className="settings-provider-toggle-row settings-section-toggle">
                <span className="settings-provider-name">{SETTINGS_ACTION_DOCK_AUTO_CLOSE_LABEL}</span>
                <input
                  type="checkbox"
                  checked={settingsDraft.autoCollapseActionDockOnSend}
                  onChange={(event) => onChangeAutoCollapseActionDockOnSend(event.target.checked)}
                />
              </label>
            </div>
          </section>

          <section className="settings-section-card">
            <div className="settings-field">
              <strong>Default Microcopy</strong>
              <p className="settings-note">1 行を 1 候補として保存する。空の slot は system default に戻る。</p>
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

          {providerSettingRows.length > 0 ? (
            <>
              <section className="settings-section-card">
                <div className="settings-field">
                  <strong>Coding Agent Providers</strong>
                  <div className="settings-provider-list">
                    {providerSettingRows.map(({ provider, settings }) => (
                      <section key={provider.id} className="settings-provider-card settings-provider-toggle-card">
                        <label className="settings-provider-toggle-row">
                          <span className="settings-provider-name">{provider.label}</span>
                          <input
                            type="checkbox"
                            checked={settings.enabled}
                            onChange={(event) => onChangeProviderEnabled(provider.id, event.target.checked)}
                          />
                        </label>
                      </section>
                    ))}
                  </div>
                </div>
              </section>
            </>
          ) : null}

          <section className="settings-section-card">
            <div className="settings-field">
              <strong>{SETTINGS_DIAGNOSTICS_LABEL}</strong>
              <div className="settings-actions">
                <button className="launch-toggle" type="button" onClick={onOpenAppLogFolder}>
                  {SETTINGS_OPEN_LOG_FOLDER_LABEL}
                </button>
                <button className="launch-toggle" type="button" onClick={onOpenCrashDumpFolder}>
                  {SETTINGS_OPEN_CRASH_DUMP_FOLDER_LABEL}
                </button>
              </div>
            </div>
          </section>

          <section className="settings-section-card danger-zone">
            <div className="settings-field">
              <strong>{SETTINGS_MATE_RESET_LABEL}</strong>
              <p className="settings-help">{SETTINGS_MATE_RESET_HELP}</p>
              <div className="settings-actions">
                <button
                  className="launch-toggle danger-button"
                  type="button"
                  onClick={() => onResetMate?.()}
                  disabled={!canResetMate || mateResetBusy}
                >
                  {mateResetBusy ? "リセット中..." : SETTINGS_MATE_RESET_LABEL}
                </button>
              </div>
            </div>
          </section>

          <section className="settings-section-card">
            <div className="settings-field">
              <strong>Model Catalog</strong>
              <p className="settings-help">active revision: {modelCatalogRevisionLabel}</p>
              <div className="settings-actions">
                <button className="launch-toggle" type="button" onClick={onImportModelCatalog}>
                  Import Models
                </button>
                <button className="launch-toggle" type="button" onClick={onExportModelCatalog}>
                  Export Models
                </button>
              </div>
            </div>
          </section>

          </section>
        </div>
      </div>
      <div className="launch-dialog-foot settings-dialog-foot">
        {settingsFeedback ? <p className="settings-feedback settings-feedback-inline">{settingsFeedback}</p> : <span aria-hidden="true" />}
        <button className="launch-toggle" type="button" onClick={onSaveSettings} disabled={!settingsDirty}>
          Save Settings
        </button>
      </div>
    </>
  );
}
