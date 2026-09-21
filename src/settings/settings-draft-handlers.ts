import type { MicrocopySlot } from "../../src-shared/settings/microcopy-state.js";
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
  handleChangeUserMicrocopySlot,
} from "./settings-draft-actions.js";

type SettingsDraftHandlersContext = {
  setSettingsDraft: (updater: (current: AppSettings) => AppSettings) => void;
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
    onChangeCharacterDefinitionEnabled: (enabled) => {
      handleChangeCharacterDefinitionEnabled({ enabled, setSettingsDraft });
    },
    onChangeCharacterAffectContextEnabled: (enabled) => {
      handleChangeCharacterAffectContextEnabled({ enabled, setSettingsDraft });
    },
    onChangeConversationTimingEnabled: (enabled) => {
      handleChangeConversationTimingEnabled({ enabled, setSettingsDraft });
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
    onChangeToolCallPresenceEnabled: (enabled) => {
      handleChangeToolCallPresenceEnabled({ enabled, setSettingsDraft });
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
