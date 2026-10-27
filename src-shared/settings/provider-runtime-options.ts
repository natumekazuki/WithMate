import { CODEX_APPROVAL_MODE_VALUES, DEFAULT_APPROVAL_MODE, approvalModeOptions, type ApprovalMode, type CodexApprovalPolicy } from "./approval-mode.js";
import { codexSandboxModeOptions, type CodexSandboxMode } from "./codex-sandbox-mode.js";
import { codexReviewerOptions, type CodexReviewer } from "./codex-reviewer.js";

export type RuntimeSelectOption<T extends string = string> = {
  value: T;
  label: string;
  disabled?: boolean;
};

const CLAUDE_PERMISSION_MODES = {
  never: "bypassPermissions",
  "on-request": "default",
  "accept-edits": "acceptEdits",
  "dont-ask": "dontAsk",
  plan: "plan",
} as const;

export function mapApprovalModeToClaudePermissionMode(approvalMode: ApprovalMode, reviewer: CodexReviewer) {
  if (approvalMode === "untrusted") {
    throw new Error("The selected approval mode is not supported by Claude.");
  }
  if (reviewer === "auto-review" && approvalMode !== "never") {
    if (approvalMode !== "on-request") {
      throw new Error("Claude Auto Review requires Provider Controlled approval.");
    }
    return "auto";
  }
  return CLAUDE_PERMISSION_MODES[approvalMode];
}

export function getDefaultApprovalModeForProvider(providerId: string | null | undefined): ApprovalMode {
  return providerId === "claude" ? "on-request" : DEFAULT_APPROVAL_MODE;
}

export function getApprovalOptionsForProvider(
  providerId: string | null | undefined,
  reviewer: CodexReviewer = "user",
): RuntimeSelectOption<ApprovalMode>[] {
  return approvalModeOptions
    .filter((option) => providerId === "claude"
      ? Object.hasOwn(CLAUDE_PERMISSION_MODES, option.id)
      : CODEX_APPROVAL_MODE_VALUES.includes(option.id as CodexApprovalPolicy))
    .map((option) => ({
      value: option.id,
      label: option.label,
      ...(providerId === "claude" && reviewer === "auto-review" && option.id !== "never" && option.id !== "on-request"
        ? { disabled: true } : {}),
    }));
}

export function getApprovalReviewerOptionsForProvider(
  providerId: string | null | undefined,
  approvalMode: ApprovalMode,
): RuntimeSelectOption<CodexReviewer>[] {
  if (providerId !== "codex" && providerId !== "claude") return [];
  return codexReviewerOptions.map((option) => ({
    ...option,
    ...(providerId === "claude" && approvalMode !== "on-request" && approvalMode !== "never" && option.value === "auto-review"
      ? { disabled: true } : {}),
  }));
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
