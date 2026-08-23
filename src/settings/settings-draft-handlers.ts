import type { MicrocopySlot } from "../microcopy-state.js";
import type { KeyboardShortcutSettings } from "../keyboard-shortcut-state.js";
import type { AppSettings } from "../provider-settings-state.js";
import type { HomeSettingsContentBaseProps } from "./home-settings-content-props.js";
import {
  handleChangeAutoCollapseActionDockOnSend,
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
  handleChangeUserMicrocopySlot,
} from "./settings-draft-actions.js";

type SettingsDraftHandlersContext = {
  setSettingsDraft: (updater: (current: AppSettings) => AppSettings) => void;
};

export type SettingsDraftHandlers = Pick<
  HomeSettingsContentBaseProps,
  | "onChangeAutoCollapseActionDockOnSend"
  | "onChangeScrollToLatestOnSend"
  | "onChangeKeyboardShortcuts"
  | "onChangeLaunchAtLoginEnabled"
  | "onChangeSessionTurnNotificationEnabled"
  | "onChangeSessionTurnNotificationResponsePreviewEnabled"
  | "onChangeMemoryFileQuotaMegabytes"
  | "onChangeGlossaryProactiveCreateLimit"
  | "onChangeUserMicrocopySlot"
  | "onChangeProviderEnabled"
  | "onChangeProviderInstructionRelativePath"
  | "onChangeProviderSkillRootPath"
  | "onChangeProviderSkillRelativePath"
>;

export function buildSettingsDraftHandlers({
  setSettingsDraft,
}: SettingsDraftHandlersContext): SettingsDraftHandlers {
  return {
    onChangeAutoCollapseActionDockOnSend: (enabled) => {
      handleChangeAutoCollapseActionDockOnSend({ enabled, setSettingsDraft });
    },
    onChangeScrollToLatestOnSend: (enabled) => {
      handleChangeScrollToLatestOnSend({ enabled, setSettingsDraft });
    },
    onChangeKeyboardShortcuts: (keyboardShortcuts: KeyboardShortcutSettings) => {
      handleChangeKeyboardShortcuts({ keyboardShortcuts, setSettingsDraft });
    },
    onChangeLaunchAtLoginEnabled: (enabled) => {
      handleChangeLaunchAtLoginEnabled({ enabled, setSettingsDraft });
    },
    onChangeSessionTurnNotificationEnabled: (enabled) => {
      handleChangeSessionTurnNotificationEnabled({ enabled, setSettingsDraft });
    },
    onChangeSessionTurnNotificationResponsePreviewEnabled: (enabled) => {
      handleChangeSessionTurnNotificationResponsePreviewEnabled({ enabled, setSettingsDraft });
    },
    onChangeMemoryFileQuotaMegabytes: (value) => {
      handleChangeMemoryFileQuotaMegabytes({ value, setSettingsDraft });
    },
    onChangeGlossaryProactiveCreateLimit: (value) => {
      handleChangeGlossaryProactiveCreateLimit({ value, setSettingsDraft });
    },
    onChangeUserMicrocopySlot: (slot: MicrocopySlot, value: string) => {
      handleChangeUserMicrocopySlot({ slot, value, setSettingsDraft });
    },
    onChangeProviderEnabled: (providerId, enabled) => {
      handleChangeProviderEnabled({ providerId, enabled, setSettingsDraft });
    },
    onChangeProviderSkillRootPath: (providerId, skillRootPath) => {
      handleChangeProviderSkillRootPath({ providerId, skillRootPath, setSettingsDraft });
    },
    onChangeProviderSkillRelativePath: (providerId, skillRelativePath) => {
      handleChangeProviderSkillRelativePath({ providerId, skillRelativePath, setSettingsDraft });
    },
    onChangeProviderInstructionRelativePath: (providerId, instructionRelativePath) => {
      handleChangeProviderInstructionRelativePath({ providerId, instructionRelativePath, setSettingsDraft });
    },
  };
}
