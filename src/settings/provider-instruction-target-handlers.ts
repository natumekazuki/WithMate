import type { AppSettings } from "../provider-settings-state.js";
import type { HomeProviderInstructionTargetApi } from "./provider-instruction-target-actions.js";
import {
  handleBrowseProviderInstructionInstructionRelativePath,
  handleChangeProviderInstructionEnabled,
  handleChangeProviderInstructionFailPolicy,
  handleChangeProviderInstructionInstructionRelativePath,
  handleChangeProviderInstructionWriteMode,
} from "./provider-instruction-target-actions.js";
import type { HomeProviderInstructionTargetDraft } from "./provider-instruction-target-draft.js";

type ProviderInstructionTargetHandlersContext = {
  providerInstructionTargets: readonly HomeProviderInstructionTargetDraft[];
  settingsDraft: AppSettings;
  setProviderInstructionTargets: (
    updater: (current: HomeProviderInstructionTargetDraft[]) => HomeProviderInstructionTargetDraft[],
  ) => void;
  setSettingsFeedback: (feedback: string) => void;
  getApi: () => HomeProviderInstructionTargetApi | null;
};

export type ProviderInstructionTargetHandlers = {
  onChangeProviderInstructionEnabled: (providerId: string, enabled: boolean) => void;
  onChangeProviderInstructionWriteMode: (providerId: string, writeMode: string) => void;
  onChangeProviderInstructionFailPolicy: (providerId: string, failPolicy: string) => void;
  onChangeProviderInstructionInstructionRelativePath: (
    providerId: string,
    instructionRelativePath: string,
  ) => void;
  onBrowseProviderInstructionInstructionRelativePath: (providerId: string) => void;
};

export function buildProviderInstructionTargetHandlers({
  providerInstructionTargets,
  settingsDraft,
  setProviderInstructionTargets,
  setSettingsFeedback,
  getApi,
}: ProviderInstructionTargetHandlersContext): ProviderInstructionTargetHandlers {
  const buildContext = () => ({
    providerInstructionTargets,
    settingsDraft,
    setProviderInstructionTargets,
    setSettingsFeedback,
    api: getApi(),
  });

  return {
    onChangeProviderInstructionEnabled: (providerId, enabled) => {
      handleChangeProviderInstructionEnabled({
        ...buildContext(),
        providerId,
        enabled,
      });
    },
    onChangeProviderInstructionWriteMode: (providerId, writeMode) => {
      handleChangeProviderInstructionWriteMode({
        ...buildContext(),
        providerId,
        writeMode,
      });
    },
    onChangeProviderInstructionFailPolicy: (providerId, failPolicy) => {
      handleChangeProviderInstructionFailPolicy({
        ...buildContext(),
        providerId,
        failPolicy,
      });
    },
    onChangeProviderInstructionInstructionRelativePath: (providerId, instructionRelativePath) => {
      handleChangeProviderInstructionInstructionRelativePath({
        ...buildContext(),
        providerId,
        instructionRelativePath,
      });
    },
    onBrowseProviderInstructionInstructionRelativePath: (providerId) => {
      void handleBrowseProviderInstructionInstructionRelativePath({
        ...buildContext(),
        providerId,
      });
    },
  };
}
