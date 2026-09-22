import type { KeyboardShortcutSettings } from "../../src-shared/settings/keyboard-shortcut-state.js";
import type { AppSettings } from "../../src-shared/settings/provider-settings-state.js";
import type { HomeSettingsContentBaseProps } from "./home-settings-content-props.js";
import {
  handleChangeAutoCollapseActionDockOnSend,
  handleChangeCharacterAffectContextEnabled,
  handleChangeCharacterDefinitionEnabled,
  handleChangeConversationTimingEnabled,
  handleChangeGlossaryProactiveCreateLimit,
  handleChangeKeyboardShortcuts,
  handleChangeLaunchAtLoginEnabled,
  handleChangeMemoryFileQuotaMegabytes,
  handleChangeScrollToLatestOnSend,
  handleChangeProviderInstructionRelativePath,
  handleChangeProviderEnabled,
  handleChangeProviderSkillRelativePath,
  handleChangeProviderSkillRootPath,
  handleChangeSessionTurnNotificationEnabled,
  handleChangeSessionTurnNotificationResponsePreviewEnabled,
  handleChangeToolCallPresenceEnabled,
} from "./settings-draft-actions.js";

type SettingsDraftHandlersContext = {
  setSettingsDraft: (updater: (current: AppSettings) => AppSettings) => void;
  clearSettingsFeedback?: () => void;
};

export type SettingsDraftHandlers = Pick<
  HomeSettingsContentBaseProps,
  | "onChangeAutoCollapseActionDockOnSend"
  | "onChangeCharacterAffectContextEnabled"
  | "onChangeCharacterDefinitionEnabled"
  | "onChangeConversationTimingEnabled"
  | "onChangeScrollToLatestOnSend"
  | "onChangeKeyboardShortcuts"
  | "onChangeLaunchAtLoginEnabled"
  | "onChangeSessionTurnNotificationEnabled"
  | "onChangeSessionTurnNotificationResponsePreviewEnabled"
  | "onChangeToolCallPresenceEnabled"
  | "onChangeMemoryFileQuotaMegabytes"
  | "onChangeGlossaryProactiveCreateLimit"
  | "onChangeProviderEnabled"
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
    onChangeAutoCollapseActionDockOnSend: (enabled) => {
      handleChangeAutoCollapseActionDockOnSend({ enabled, setSettingsDraft: updateSettingsDraft });
    },
    onChangeCharacterDefinitionEnabled: (enabled) => {
      handleChangeCharacterDefinitionEnabled({ enabled, setSettingsDraft: updateSettingsDraft });
    },
    onChangeCharacterAffectContextEnabled: (enabled) => {
      handleChangeCharacterAffectContextEnabled({ enabled, setSettingsDraft: updateSettingsDraft });
    },
    onChangeConversationTimingEnabled: (enabled) => {
      handleChangeConversationTimingEnabled({ enabled, setSettingsDraft: updateSettingsDraft });
    },
    onChangeScrollToLatestOnSend: (enabled) => {
      handleChangeScrollToLatestOnSend({ enabled, setSettingsDraft: updateSettingsDraft });
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
    onChangeSessionTurnNotificationResponsePreviewEnabled: (enabled) => {
      handleChangeSessionTurnNotificationResponsePreviewEnabled({ enabled, setSettingsDraft: updateSettingsDraft });
    },
    onChangeToolCallPresenceEnabled: (enabled) => {
      handleChangeToolCallPresenceEnabled({ enabled, setSettingsDraft: updateSettingsDraft });
    },
    onChangeMemoryFileQuotaMegabytes: (value) => {
      handleChangeMemoryFileQuotaMegabytes({ value, setSettingsDraft: updateSettingsDraft });
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
