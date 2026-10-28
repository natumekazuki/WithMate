import type { ModelCatalogItem, ModelCatalogProvider, ModelReasoningEffort } from "../../src-shared/settings/model-catalog.js";
import type { ApprovalMode } from "../../src-shared/settings/approval-mode.js";
import type { CodexSandboxMode } from "../../src-shared/settings/codex-sandbox-mode.js";
import { getCodexSpeedOptions, type CodexSpeed } from "../../src-shared/settings/codex-speed.js";
import type { CodexReviewer } from "../../src-shared/settings/codex-reviewer.js";
import {
  buildModelSelectOptions,
  buildReasoningEffortSelectOptions,
  resolveModelFallbackLabel,
  type ModelSelectOption,
  type ReasoningEffortSelectOption,
} from "./model-select-options.js";
import {
  getApprovalOptionsForProvider,
  getApprovalReviewerOptionsForProvider,
  getSandboxOptionsForProviderSelection,
  type RuntimeSelectOption,
} from "../../src-shared/settings/provider-runtime-options.js";

export type RuntimeSelectionOptions = {
  approvalChoiceOptions: RuntimeSelectOption<ApprovalMode>[];
  sandboxChoiceOptions: RuntimeSelectOption<CodexSandboxMode>[];
  modelSelectOptions: ModelSelectOption[];
  selectedModelFallbackLabel: string;
  reasoningSelectOptions: ReasoningEffortSelectOption[];
  speedSelectOptions: RuntimeSelectOption<CodexSpeed>[];
  reviewerSelectOptions: RuntimeSelectOption<CodexReviewer>[];
};

export function buildRuntimeSelectionOptions({
  providerId,
  providerCatalog,
  models,
  selectedModel,
  selectedReasoningEffort,
  reasoningEfforts,
  selectedApprovalMode,
  selectedCodexSandboxMode,
  selectedCodexSpeed,
  selectedCodexReviewer,
}: {
  providerId: string | null | undefined;
  providerCatalog: ModelCatalogProvider | null | undefined;
  models: readonly ModelCatalogItem[];
  selectedModel: string;
  selectedReasoningEffort?: string;
  reasoningEfforts: readonly ModelReasoningEffort[];
  selectedApprovalMode: ApprovalMode;
  selectedCodexSandboxMode: CodexSandboxMode;
  selectedCodexSpeed: CodexSpeed;
  selectedCodexReviewer: CodexReviewer;
}): RuntimeSelectionOptions {
  const approvalChoiceOptions = (() => {
    const options = getApprovalOptionsForProvider(providerId, selectedCodexReviewer);
    if (options.some((option) => option.value === selectedApprovalMode)) {
      return options;
    }

    if (providerId === "claude" || providerId === "opencode") {
      return [{ value: selectedApprovalMode, label: `Unsupported (${selectedApprovalMode})`, disabled: true }, ...options];
    }
    return [{ value: selectedApprovalMode, label: selectedApprovalMode }, ...options];
  })();

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
  const reviewerSelectOptions = getApprovalReviewerOptionsForProvider(providerId, selectedApprovalMode);

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
    reviewerSelectOptions: reviewerSelectOptions.length === 0
      ? []
      : reviewerSelectOptions.some((option) => option.value === selectedCodexReviewer)
        ? reviewerSelectOptions
        : [{ value: selectedCodexReviewer, label: selectedCodexReviewer }, ...reviewerSelectOptions],
  };
}
