import type { ModelCatalogItem, ModelCatalogProvider, ModelReasoningEffort } from "../../src-shared/settings/model-catalog.js";
import type { CodexSandboxMode } from "../../src-shared/settings/codex-sandbox-mode.js";
import { getCodexSpeedOptions, type CodexSpeed } from "../../src-shared/settings/codex-speed.js";
import {
  buildModelSelectOptions,
  buildReasoningEffortSelectOptions,
  resolveModelFallbackLabel,
  type ModelSelectOption,
  type ReasoningEffortSelectOption,
} from "./model-select-options.js";
import {
  getSandboxOptionsForProviderSelection,
  type RuntimeSelectOption,
} from "../../src-shared/settings/provider-runtime-options.js";

export type RuntimeSelectionOptions = {
  sandboxChoiceOptions: RuntimeSelectOption<CodexSandboxMode>[];
  modelSelectOptions: ModelSelectOption[];
  selectedModelFallbackLabel: string;
  reasoningSelectOptions: ReasoningEffortSelectOption[];
  speedSelectOptions: RuntimeSelectOption<CodexSpeed>[];
};

export function buildRuntimeSelectionOptions({
  providerId,
  providerCatalog,
  models,
  selectedModel,
  selectedReasoningEffort,
  reasoningEfforts,
  selectedCodexSandboxMode,
  selectedCodexSpeed,
}: {
  providerId: string | null | undefined;
  providerCatalog: ModelCatalogProvider | null | undefined;
  models: readonly ModelCatalogItem[];
  selectedModel: string;
  selectedReasoningEffort?: string;
  reasoningEfforts: readonly ModelReasoningEffort[];
  selectedCodexSandboxMode: CodexSandboxMode;
  selectedCodexSpeed: CodexSpeed;
}): RuntimeSelectionOptions {
  const sandboxChoiceOptions = getSandboxOptionsForProviderSelection(providerId, selectedCodexSandboxMode);
  const modelSelectOptions = buildModelSelectOptions(models, selectedModel);
  const selectedModelFallbackLabel = resolveModelFallbackLabel(providerCatalog, selectedModel);
  const reasoningSelectOptions = buildReasoningEffortSelectOptions(reasoningEfforts);
  if (reasoningSelectOptions.length > 0 && !reasoningSelectOptions.some((option) => option.value === "")) {
    reasoningSelectOptions.unshift({ value: "", label: "Default" });
  }
  if (reasoningSelectOptions.length > 0 && selectedReasoningEffort && !reasoningSelectOptions.some((option) => option.value === selectedReasoningEffort)) {
    reasoningSelectOptions.unshift({ value: selectedReasoningEffort, label: selectedReasoningEffort });
  }
  const speedSelectOptions = getCodexSpeedOptions(providerId);

  return {
    sandboxChoiceOptions,
    modelSelectOptions,
    selectedModelFallbackLabel,
    reasoningSelectOptions,
    speedSelectOptions: speedSelectOptions.length === 0
      ? []
      : speedSelectOptions.some((option) => option.value === selectedCodexSpeed)
        ? speedSelectOptions
        : [{ value: selectedCodexSpeed, label: selectedCodexSpeed }, ...speedSelectOptions],
  };
}
