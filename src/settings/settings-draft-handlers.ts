import type { ModelCatalogSnapshot } from "../model-catalog.js";
import type { AppSettings } from "../provider-settings-state.js";
import type { HomeSettingsContentBaseProps } from "./home-settings-content-props.js";
import {
  handleAddMateMemoryGenerationPriority,
  handleChangeAutoCollapseActionDockOnSend,
  handleChangeCharacterReflectionCharDeltaThreshold,
  handleChangeCharacterReflectionCooldownSeconds,
  handleChangeCharacterReflectionMessageDeltaThreshold,
  handleChangeCharacterReflectionModel,
  handleChangeCharacterReflectionReasoningEffort,
  handleChangeCharacterReflectionTimeoutSeconds,
  handleChangeMateMemoryGenerationPriorityModel,
  handleChangeMateMemoryGenerationPriorityProvider,
  handleChangeMateMemoryGenerationPriorityReasoningEffort,
  handleChangeMateMemoryGenerationPriorityTimeoutSeconds,
  handleChangeMateMemoryGenerationTriggerIntervalMinutes,
  handleChangeMemoryGenerationEnabled,
  handleChangeMemoryExtractionModel,
  handleChangeMemoryExtractionReasoningEffort,
  handleChangeMemoryExtractionThreshold,
  handleChangeMemoryExtractionTimeoutSeconds,
  handleChangeProviderEnabled,
  handleChangeProviderSkillRootPath,
  handleRemoveMateMemoryGenerationPriority,
} from "./settings-draft-actions.js";

type SettingsDraftHandlersContext = {
  modelCatalog: ModelCatalogSnapshot | null;
  setSettingsDraft: (updater: (current: AppSettings) => AppSettings) => void;
};

export type SettingsDraftHandlers = Pick<
  HomeSettingsContentBaseProps,
  | "onChangeMemoryGenerationEnabled"
  | "onChangeMateMemoryGenerationPriorityProvider"
  | "onChangeMateMemoryGenerationPriorityModel"
  | "onChangeMateMemoryGenerationPriorityReasoningEffort"
  | "onChangeMateMemoryGenerationPriorityTimeoutSeconds"
  | "onAddMateMemoryGenerationPriority"
  | "onRemoveMateMemoryGenerationPriority"
  | "onChangeMateMemoryGenerationTriggerIntervalMinutes"
  | "onChangeAutoCollapseActionDockOnSend"
  | "onChangeProviderEnabled"
  | "onChangeProviderSkillRootPath"
  | "onChangeMemoryExtractionModel"
  | "onChangeMemoryExtractionReasoningEffort"
  | "onChangeMemoryExtractionThreshold"
  | "onChangeMemoryExtractionTimeoutSeconds"
  | "onChangeCharacterReflectionModel"
  | "onChangeCharacterReflectionReasoningEffort"
  | "onChangeCharacterReflectionTimeoutSeconds"
  | "onChangeCharacterReflectionCooldownSeconds"
  | "onChangeCharacterReflectionCharDeltaThreshold"
  | "onChangeCharacterReflectionMessageDeltaThreshold"
>;

export function buildSettingsDraftHandlers({
  modelCatalog,
  setSettingsDraft,
}: SettingsDraftHandlersContext): SettingsDraftHandlers {
  return {
    onChangeMemoryGenerationEnabled: (enabled) => {
      handleChangeMemoryGenerationEnabled({ enabled, setSettingsDraft });
    },
    onChangeMateMemoryGenerationPriorityProvider: (index, providerId) => {
      handleChangeMateMemoryGenerationPriorityProvider({ index, providerId, setSettingsDraft });
    },
    onChangeMateMemoryGenerationPriorityModel: (index, providerId, model) => {
      handleChangeMateMemoryGenerationPriorityModel({ index, providerId, model, modelCatalog, setSettingsDraft });
    },
    onChangeMateMemoryGenerationPriorityReasoningEffort: (index, reasoningEffort) => {
      handleChangeMateMemoryGenerationPriorityReasoningEffort({ index, reasoningEffort, setSettingsDraft });
    },
    onChangeMateMemoryGenerationPriorityTimeoutSeconds: (index, value) => {
      handleChangeMateMemoryGenerationPriorityTimeoutSeconds({ index, value, setSettingsDraft });
    },
    onAddMateMemoryGenerationPriority: () => {
      handleAddMateMemoryGenerationPriority({ modelCatalog, setSettingsDraft });
    },
    onRemoveMateMemoryGenerationPriority: (index) => {
      handleRemoveMateMemoryGenerationPriority({ index, setSettingsDraft });
    },
    onChangeMateMemoryGenerationTriggerIntervalMinutes: (value) => {
      handleChangeMateMemoryGenerationTriggerIntervalMinutes({ value, setSettingsDraft });
    },
    onChangeAutoCollapseActionDockOnSend: (enabled) => {
      handleChangeAutoCollapseActionDockOnSend({ enabled, setSettingsDraft });
    },
    onChangeProviderEnabled: (providerId, enabled) => {
      handleChangeProviderEnabled({ providerId, enabled, setSettingsDraft });
    },
    onChangeProviderSkillRootPath: (providerId, skillRootPath) => {
      handleChangeProviderSkillRootPath({ providerId, skillRootPath, setSettingsDraft });
    },
    onChangeMemoryExtractionModel: (providerId, model) => {
      handleChangeMemoryExtractionModel({ providerId, model, modelCatalog, setSettingsDraft });
    },
    onChangeMemoryExtractionReasoningEffort: (providerId, reasoningEffort) => {
      handleChangeMemoryExtractionReasoningEffort({ providerId, reasoningEffort, setSettingsDraft });
    },
    onChangeMemoryExtractionThreshold: (providerId, value) => {
      handleChangeMemoryExtractionThreshold({ providerId, value, setSettingsDraft });
    },
    onChangeMemoryExtractionTimeoutSeconds: (providerId, value) => {
      handleChangeMemoryExtractionTimeoutSeconds({ providerId, value, setSettingsDraft });
    },
    onChangeCharacterReflectionModel: (providerId, model) => {
      handleChangeCharacterReflectionModel({ providerId, model, modelCatalog, setSettingsDraft });
    },
    onChangeCharacterReflectionReasoningEffort: (providerId, reasoningEffort) => {
      handleChangeCharacterReflectionReasoningEffort({ providerId, reasoningEffort, setSettingsDraft });
    },
    onChangeCharacterReflectionTimeoutSeconds: (providerId, value) => {
      handleChangeCharacterReflectionTimeoutSeconds({ providerId, value, setSettingsDraft });
    },
    onChangeCharacterReflectionCooldownSeconds: (value) => {
      handleChangeCharacterReflectionCooldownSeconds({ value, setSettingsDraft });
    },
    onChangeCharacterReflectionCharDeltaThreshold: (value) => {
      handleChangeCharacterReflectionCharDeltaThreshold({ value, setSettingsDraft });
    },
    onChangeCharacterReflectionMessageDeltaThreshold: (value) => {
      handleChangeCharacterReflectionMessageDeltaThreshold({ value, setSettingsDraft });
    },
  };
}
