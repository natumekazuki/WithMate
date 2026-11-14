import type { KeyboardShortcutSettings } from "../../src-shared/settings/keyboard-shortcut-state.js";
import type { AppSettings } from "../../src-shared/settings/provider-settings-state.js";
import type { HomeSettingsContentBaseProps } from "./home-settings-content-props.js";
import {
  handleChangeAutoCollapseActionDockOnSend,
  handleChangeCharacterDefinitionEnabled,
  handleChangeCurrentDateEnabled,
  handleChangeGlossaryProactiveCreateLimit,
  handleChangeKeyboardShortcuts,
  handleChangeLaunchAtLoginEnabled,
  handleChangeScrollToLatestOnSend,
  handleChangePreviewWheelZoomStep,
  handleChangeProviderInstructionRelativePath,
  handleChangeProviderEnabled,
  handleChangeProviderSkillRelativePath,
  handleChangeProviderSkillRootPath,
  handleChangeSessionTurnNotificationEnabled,
  handleChangeSessionApprovalNotificationEnabled,
  handleChangeSessionTurnNotificationResponsePreviewEnabled,
} from "./settings-draft-actions.js";

type SettingsDraftHandlersContext = {
  setSettingsDraft: (updater: (current: AppSettings) => AppSettings) => void;
  clearSettingsFeedback?: () => void;
};

export type SettingsDraftHandlers = Pick<
  HomeSettingsContentBaseProps,
  | "onChangeAutoCollapseActionDockOnSend"
  | "onChangeCharacterDefinitionEnabled"
  | "onChangeCurrentDateEnabled"
  | "onChangeScrollToLatestOnSend"
  | "onChangePreviewWheelZoomStep"
  | "onChangeKeyboardShortcuts"
  | "onChangeLaunchAtLoginEnabled"
  | "onChangeSessionTurnNotificationEnabled"
  | "onChangeSessionApprovalNotificationEnabled"
  | "onChangeSessionTurnNotificationResponsePreviewEnabled"
  | "onChangeGlossaryProactiveCreateLimit"
  | "onChangeProviderEnabled"
  | "onChangeModelAvailability"
  | "onChangeProviderInstructionRelativePath"
  | "onChangeProviderSkillRootPath"
  | "onChangeProviderSkillRelativePath"
>;

export function buildSettingsDraftHandlers({
  setSettingsDraft,
  clearSettingsFeedback,
}: SettingsDraftHandlersContext): SettingsDraftHandlers {
  const updateSettingsDraft = (updater: (current: AppSettings) => AppSettings) => {
    clearSettingsFeedback?.();
    setSettingsDraft(updater);
  };

  return {
    onChangeModelAvailability: (modelAvailability) => {
      updateSettingsDraft((current) => ({ ...current, modelAvailability }));
    },
    onChangeAutoCollapseActionDockOnSend: (enabled) => {
      handleChangeAutoCollapseActionDockOnSend({ enabled, setSettingsDraft: updateSettingsDraft });
    },
    onChangeCharacterDefinitionEnabled: (enabled) => {
      handleChangeCharacterDefinitionEnabled({ enabled, setSettingsDraft: updateSettingsDraft });
    },
    onChangeCurrentDateEnabled: (enabled) => {
      handleChangeCurrentDateEnabled({ enabled, setSettingsDraft: updateSettingsDraft });
    },
    onChangeScrollToLatestOnSend: (enabled) => {
      handleChangeScrollToLatestOnSend({ enabled, setSettingsDraft: updateSettingsDraft });
    },
    onChangePreviewWheelZoomStep: (value) => {
      handleChangePreviewWheelZoomStep({ value, setSettingsDraft: updateSettingsDraft });
    },
    onChangeKeyboardShortcuts: (keyboardShortcuts: KeyboardShortcutSettings) => {
      handleChangeKeyboardShortcuts({ keyboardShortcuts, setSettingsDraft: updateSettingsDraft });
    },
    onChangeLaunchAtLoginEnabled: (enabled) => {
      handleChangeLaunchAtLoginEnabled({ enabled, setSettingsDraft: updateSettingsDraft });
    },
    onChangeSessionTurnNotificationEnabled: (enabled) => {
      handleChangeSessionTurnNotificationEnabled({ enabled, setSettingsDraft: updateSettingsDraft });
    },
    onChangeSessionApprovalNotificationEnabled: (enabled) => {
      handleChangeSessionApprovalNotificationEnabled({ enabled, setSettingsDraft: updateSettingsDraft });
    },
    onChangeSessionTurnNotificationResponsePreviewEnabled: (enabled) => {
      handleChangeSessionTurnNotificationResponsePreviewEnabled({ enabled, setSettingsDraft: updateSettingsDraft });
    },
    onChangeGlossaryProactiveCreateLimit: (value) => {
      handleChangeGlossaryProactiveCreateLimit({ value, setSettingsDraft: updateSettingsDraft });
    },
    onChangeProviderEnabled: (providerId, enabled) => {
      handleChangeProviderEnabled({ providerId, enabled, setSettingsDraft: updateSettingsDraft });
    },
    onChangeProviderSkillRootPath: (providerId, skillRootPath) => {
      handleChangeProviderSkillRootPath({ providerId, skillRootPath, setSettingsDraft: updateSettingsDraft });
    },
    onChangeProviderSkillRelativePath: (providerId, skillRelativePath) => {
      handleChangeProviderSkillRelativePath({ providerId, skillRelativePath, setSettingsDraft: updateSettingsDraft });
    },
    onChangeProviderInstructionRelativePath: (providerId, instructionRelativePath) => {
      handleChangeProviderInstructionRelativePath({ providerId, instructionRelativePath, setSettingsDraft: updateSettingsDraft });
    },
  };
}
