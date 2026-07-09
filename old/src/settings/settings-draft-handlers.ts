import type { MicrocopySlot } from "../microcopy-state.js";
import type { AppSettings } from "../provider-settings-state.js";
import type { HomeSettingsContentBaseProps } from "./home-settings-content-props.js";
import {
  handleChangeAutoCollapseActionDockOnSend,
  handleChangeLaunchAtLoginEnabled,
  handleChangeMemoryFileQuotaMegabytes,
  handleChangeProviderInstructionRelativePath,
  handleChangeProviderEnabled,
  handleChangeProviderSkillRelativePath,
  handleChangeProviderSkillRootPath,
  handleChangeUserMicrocopySlot,
} from "./settings-draft-actions.js";

type SettingsDraftHandlersContext = {
  setSettingsDraft: (updater: (current: AppSettings) => AppSettings) => void;
};

export type SettingsDraftHandlers = Pick<
  HomeSettingsContentBaseProps,
  | "onChangeAutoCollapseActionDockOnSend"
  | "onChangeLaunchAtLoginEnabled"
  | "onChangeMemoryFileQuotaMegabytes"
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
    onChangeLaunchAtLoginEnabled: (enabled) => {
      handleChangeLaunchAtLoginEnabled({ enabled, setSettingsDraft });
    },
    onChangeMemoryFileQuotaMegabytes: (value) => {
      handleChangeMemoryFileQuotaMegabytes({ value, setSettingsDraft });
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
