import type { ModelCatalogSnapshot } from "../model-catalog.js";
import type { MicrocopySlot } from "../microcopy-state.js";
import type { AppSettings } from "../provider-settings-state.js";
import {
  addMateMemoryGenerationPriorityDraft,
  removeMateMemoryGenerationPriorityDraft,
  updateAutoCollapseActionDockOnSend,
  updateCodingProviderEnabledDraft,
  updateCodingProviderSkillRelativePathDraft,
  updateCodingProviderSkillRootPathDraft,
  updateMateMemoryGenerationPriorityModelDraft,
  updateMateMemoryGenerationPriorityProviderDraft,
  updateMateMemoryGenerationPriorityReasoningEffortDraft,
  updateMateMemoryGenerationPriorityTimeoutSecondsDraft,
  updateMateMemoryGenerationTriggerIntervalMinutesDraft,
  updateMemoryExtractionModelDraft,
  updateMemoryExtractionReasoningEffortDraft,
  updateMemoryExtractionThresholdDraft,
  updateMemoryExtractionTimeoutSecondsDraft,
  updateMemoryGenerationEnabled,
  updateUserMicrocopySlotDraft,
} from "./settings-draft.js";

type SetSettingsDraft = (updater: (current: AppSettings) => AppSettings) => void;

type SettingsDraftActionInput = {
  setSettingsDraft: SetSettingsDraft;
};

type ModelCatalogActionInput = SettingsDraftActionInput & {
  modelCatalog: ModelCatalogSnapshot | null;
};

function getProviderCatalog(modelCatalog: ModelCatalogSnapshot | null, providerId: string) {
  return modelCatalog?.providers.find((provider) => provider.id === providerId) ?? null;
}

export function handleChangeProviderEnabled(input: SettingsDraftActionInput & {
  providerId: string;
  enabled: boolean;
}): void {
  input.setSettingsDraft((current) => updateCodingProviderEnabledDraft(current, input.providerId, input.enabled));
}

export function handleChangeProviderSkillRootPath(input: SettingsDraftActionInput & {
  providerId: string;
  skillRootPath: string;
}): void {
  input.setSettingsDraft((current) => updateCodingProviderSkillRootPathDraft(current, input.providerId, input.skillRootPath));
}

export function handleChangeProviderSkillRelativePath(input: SettingsDraftActionInput & {
  providerId: string;
  skillRelativePath: string;
}): void {
  input.setSettingsDraft((current) =>
    updateCodingProviderSkillRelativePathDraft(current, input.providerId, input.skillRelativePath));
}

export function handleChangeMemoryGenerationEnabled(input: SettingsDraftActionInput & {
  enabled: boolean;
}): void {
  input.setSettingsDraft((current) => updateMemoryGenerationEnabled(current, input.enabled));
}

export function handleChangeAutoCollapseActionDockOnSend(input: SettingsDraftActionInput & {
  enabled: boolean;
}): void {
  input.setSettingsDraft((current) => updateAutoCollapseActionDockOnSend(current, input.enabled));
}

export function handleChangeUserMicrocopySlot(input: SettingsDraftActionInput & {
  slot: MicrocopySlot;
  value: string;
}): void {
  input.setSettingsDraft((current) => updateUserMicrocopySlotDraft(current, input.slot, input.value));
}

export function handleChangeMemoryExtractionModel(input: ModelCatalogActionInput & {
  providerId: string;
  model: string;
}): void {
  const providerCatalog = getProviderCatalog(input.modelCatalog, input.providerId);
  if (!providerCatalog) {
    return;
  }

  input.setSettingsDraft((current) => updateMemoryExtractionModelDraft(current, providerCatalog, input.providerId, input.model));
}

export function handleChangeMemoryExtractionReasoningEffort(input: SettingsDraftActionInput & {
  providerId: string;
  reasoningEffort: AppSettings["memoryExtractionProviderSettings"][string]["reasoningEffort"];
}): void {
  input.setSettingsDraft((current) => updateMemoryExtractionReasoningEffortDraft(current, input.providerId, input.reasoningEffort));
}

export function handleChangeMemoryExtractionThreshold(input: SettingsDraftActionInput & {
  providerId: string;
  value: string;
}): void {
  input.setSettingsDraft((current) => updateMemoryExtractionThresholdDraft(current, input.providerId, input.value));
}

export function handleChangeMemoryExtractionTimeoutSeconds(input: SettingsDraftActionInput & {
  providerId: string;
  value: string;
}): void {
  input.setSettingsDraft((current) => updateMemoryExtractionTimeoutSecondsDraft(current, input.providerId, input.value));
}

export function handleChangeMateMemoryGenerationPriorityProvider(input: SettingsDraftActionInput & {
  index: number;
  providerId: string;
}): void {
  input.setSettingsDraft((current) => updateMateMemoryGenerationPriorityProviderDraft(current, input.index, input.providerId));
}

export function handleChangeMateMemoryGenerationPriorityModel(input: ModelCatalogActionInput & {
  index: number;
  providerId: string;
  model: string;
}): void {
  const providerCatalog = getProviderCatalog(input.modelCatalog, input.providerId);
  if (!providerCatalog) {
    return;
  }

  input.setSettingsDraft((current) => updateMateMemoryGenerationPriorityModelDraft(
    current,
    providerCatalog,
    input.index,
    input.providerId,
    input.model,
  ));
}

export function handleChangeMateMemoryGenerationPriorityReasoningEffort(input: SettingsDraftActionInput & {
  index: number;
  reasoningEffort: AppSettings["mateMemoryGenerationSettings"]["priorityList"][number]["reasoningEffort"];
}): void {
  input.setSettingsDraft((current) => updateMateMemoryGenerationPriorityReasoningEffortDraft(
    current,
    input.index,
    input.reasoningEffort,
  ));
}

export function handleChangeMateMemoryGenerationPriorityTimeoutSeconds(input: SettingsDraftActionInput & {
  index: number;
  value: string;
}): void {
  input.setSettingsDraft((current) => updateMateMemoryGenerationPriorityTimeoutSecondsDraft(current, input.index, input.value));
}

export function handleAddMateMemoryGenerationPriority(input: ModelCatalogActionInput): void {
  const provider = input.modelCatalog?.providers[0];
  input.setSettingsDraft((current) => addMateMemoryGenerationPriorityDraft(current, {
    provider: provider?.id ?? "codex",
    model: provider?.defaultModelId ?? "gpt-5.4",
    reasoningEffort: provider?.defaultReasoningEffort ?? "low",
    timeoutSeconds: 180,
  }));
}

export function handleRemoveMateMemoryGenerationPriority(input: SettingsDraftActionInput & {
  index: number;
}): void {
  input.setSettingsDraft((current) => removeMateMemoryGenerationPriorityDraft(current, input.index));
}

export function handleChangeMateMemoryGenerationTriggerIntervalMinutes(input: SettingsDraftActionInput & {
  value: string;
}): void {
  input.setSettingsDraft((current) => updateMateMemoryGenerationTriggerIntervalMinutesDraft(current, input.value));
}
