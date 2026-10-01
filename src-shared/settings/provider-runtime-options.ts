import { DEFAULT_APPROVAL_MODE, approvalModeOptions, type ApprovalMode } from "./approval-mode.js";
import { codexSandboxModeOptions, type CodexSandboxMode } from "./codex-sandbox-mode.js";

export type RuntimeSelectOption<T extends string = string> = {
  value: T;
  label: string;
};

const COPILOT_APPROVAL_VALUES = new Set<ApprovalMode>(["never", "on-request", "untrusted"]);

export function getDefaultApprovalModeForProvider(providerId: string | null | undefined): ApprovalMode {
  return providerId === "claude" ? "on-request" : DEFAULT_APPROVAL_MODE;
}

export function getApprovalOptionsForProvider(providerId: string | null | undefined): RuntimeSelectOption<ApprovalMode>[] {
  if (providerId === "claude") {
    return approvalModeOptions
      .filter((option) => option.id === "on-request")
      .map((option) => ({ value: option.id, label: option.label }));
  }
  if (providerId === "copilot") {
    return approvalModeOptions
      .filter((option) => COPILOT_APPROVAL_VALUES.has(option.id))
      .map((option) => ({ value: option.id, label: option.label }));
  }

  return approvalModeOptions.map((option) => ({ value: option.id, label: option.label }));
}

export function getSandboxOptionsForProvider(
  providerId: string | null | undefined,
): RuntimeSelectOption<CodexSandboxMode>[] {
  if (providerId !== "codex") {
    return [];
  }

  return codexSandboxModeOptions.map((option) => ({ value: option.id, label: option.label }));
}

export function getSandboxOptionsForProviderSelection(
  providerId: string | null | undefined,
  selectedValue: CodexSandboxMode,
): RuntimeSelectOption<CodexSandboxMode>[] {
  const options = getSandboxOptionsForProvider(providerId);
  if (options.length === 0 || options.some((option) => option.value === selectedValue)) {
    return options;
  }

  return [{ value: selectedValue, label: selectedValue }, ...options];
}
