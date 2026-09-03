import type { ModelCatalogItem, ModelCatalogProvider, ModelReasoningEffort } from "./model-catalog.js";
import type { ApprovalMode } from "./approval-mode.js";
import type { CodexSandboxMode } from "./codex-sandbox-mode.js";
import { getCodexSpeedOptions, type CodexSpeed } from "./codex-speed.js";
import {
  buildModelSelectOptions,
  buildReasoningEffortSelectOptions,
  resolveModelFallbackLabel,
  type ModelSelectOption,
  type ReasoningEffortSelectOption,
} from "./model-select-options.js";
import {
  getApprovalOptionsForProvider,
  getSandboxOptionsForProviderSelection,
  type RuntimeSelectOption,
} from "./provider-runtime-options.js";

export type RuntimeSelectionOptions = {
  approvalChoiceOptions: RuntimeSelectOption<ApprovalMode>[];
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
  reasoningEfforts,
  selectedApprovalMode,
  selectedCodexSandboxMode,
  selectedCodexSpeed,
}: {
  providerId: string | null | undefined;
  providerCatalog: ModelCatalogProvider | null | undefined;
  models: readonly ModelCatalogItem[];
  selectedModel: string;
  reasoningEfforts: readonly ModelReasoningEffort[];
  selectedApprovalMode: ApprovalMode;
  selectedCodexSandboxMode: CodexSandboxMode;
  selectedCodexSpeed: CodexSpeed;
}): RuntimeSelectionOptions {
  const approvalChoiceOptions = (() => {
    const options = getApprovalOptionsForProvider(providerId);
    if (options.some((option) => option.value === selectedApprovalMode)) {
      return options;
    }

    return [{ value: selectedApprovalMode, label: selectedApprovalMode }, ...options];
  })();

  const sandboxChoiceOptions = getSandboxOptionsForProviderSelection(providerId, selectedCodexSandboxMode);
  const modelSelectOptions = buildModelSelectOptions(models, selectedModel);
  const selectedModelFallbackLabel = resolveModelFallbackLabel(providerCatalog, selectedModel);
  const reasoningSelectOptions = buildReasoningEffortSelectOptions(reasoningEfforts);
  const speedSelectOptions = getCodexSpeedOptions(providerId);

  return {
    approvalChoiceOptions,
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
