import type { MicrocopySlot } from "../microcopy-state.js";
import type { AppSettings } from "../provider-settings-state.js";
import type { HomeSettingsContentBaseProps } from "./home-settings-content-props.js";
import {
  handleChangeAutoCollapseActionDockOnSend,
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
