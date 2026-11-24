import { CODEX_APPROVAL_MODE_VALUES, DEFAULT_APPROVAL_MODE, approvalModeOptions, type ApprovalMode, type CodexApprovalPolicy } from "./approval-mode.js";
import { codexSandboxModeOptions, type CodexSandboxMode } from "./codex-sandbox-mode.js";
import { codexReviewerOptions, resolveCodexReviewerUpdate, type CodexReviewer } from "./codex-reviewer.js";
import type { ConfirmedReviewerChange } from "../session/session-mutation-contract.js";
import { supportsWithMateAutoReview } from "./withmate-auto-review.js";

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
  if (approvalMode === "safety-focused") return "default";
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
  return providerId === "claude" || providerId === "opencode" ? "on-request" : DEFAULT_APPROVAL_MODE;
}

export function getApprovalOptionsForProvider(
  providerId: string | null | undefined,
): RuntimeSelectOption<ApprovalMode>[] {
  if (providerId === "opencode") {
    return approvalModeOptions
      .filter((option) => option.id === "on-request" || option.id === "never" || option.id === "safety-focused")
      .map((option) => ({ value: option.id, label: option.label }));
  }
  return approvalModeOptions
    .filter((option) => option.id === "safety-focused" || (providerId === "claude"
      ? Object.hasOwn(CLAUDE_PERMISSION_MODES, option.id)
      : CODEX_APPROVAL_MODE_VALUES.includes(option.id as CodexApprovalPolicy)))
    .map((option) => ({ value: option.id, label: option.label }));
}

export function getApprovalReviewerOptionsForProvider(
  providerId: string | null | undefined,
  approvalMode: ApprovalMode,
): RuntimeSelectOption<CodexReviewer>[] {
  if (providerId !== "codex" && providerId !== "claude" && !supportsWithMateAutoReview(providerId)) return [];
  return codexReviewerOptions.map((option) => ({
    ...option,
    ...(providerId === "claude" && approvalMode !== "on-request" && approvalMode !== "never" && approvalMode !== "safety-focused" && option.value === "auto-review"
      ? { disabled: true } : {}),
  }));
}

type ChildSessionPermissions = {
  approvalMode: ApprovalMode;
  codexReviewer: CodexReviewer;
  codexSandboxMode?: CodexSandboxMode;
  withMateReviewerExplicit?: true;
};

const CHILD_PERMISSION_PROVIDERS = new Set(["codex", "claude", "copilot", "opencode"]);

/**
 * Maps a validated parent Turn's permissions to a child provider.
 * Throws if the transfer would discard a restriction; it does not select a different provider.
 */
export function resolveChildSessionPermissions(
  sourceProviderId: string,
  source: Readonly<ChildSessionPermissions & { codexSandboxMode: CodexSandboxMode }>,
  targetProviderId: string,
): ChildSessionPermissions {
  const { approvalMode, codexSandboxMode, codexReviewer, withMateReviewerExplicit } = source;
  if (sourceProviderId === targetProviderId) {
    return { approvalMode, codexSandboxMode, codexReviewer, ...(withMateReviewerExplicit ? { withMateReviewerExplicit } : {}) };
  }

  if (!CHILD_PERMISSION_PROVIDERS.has(sourceProviderId) || !CHILD_PERMISSION_PROVIDERS.has(targetProviderId)) {
    throw new Error(`Child permission inheritance is not supported from ${sourceProviderId} to ${targetProviderId}.`);
  }
  if (sourceProviderId === "codex" && codexSandboxMode !== "danger-full-access") {
    throw new Error(`Cannot inherit the Codex sandbox mode "${codexSandboxMode}" in ${targetProviderId}.`);
  }
  // Auto Run and provider-specific modes do not have equivalent restrictions in other providers.
  if (approvalMode !== "on-request") {
    throw new Error(`Cannot inherit the ${sourceProviderId} approval mode "${approvalMode}" in ${targetProviderId}.`);
  }

  const sourceHasReviewer = getApprovalReviewerOptionsForProvider(sourceProviderId, approvalMode).length > 0;
  const targetHasReviewer = getApprovalReviewerOptionsForProvider(targetProviderId, approvalMode).length > 0;
  const inheritReviewer = sourceHasReviewer && targetHasReviewer
    && (!supportsWithMateAutoReview(sourceProviderId) || withMateReviewerExplicit === true);
  return {
    approvalMode,
    codexReviewer: inheritReviewer ? codexReviewer : "user",
    ...(inheritReviewer && supportsWithMateAutoReview(targetProviderId) ? { withMateReviewerExplicit: true } : {}),
    // Keep writes and network access outside the initial sandbox so they can require approval.
    ...(targetProviderId === "codex" ? { codexSandboxMode: "read-only" } : {}),
  };
}

/** An inactive reviewer cannot be edited while its Approval does not use it. */
export function resolveWithMateReviewerExplicitUpdate(
  current: { provider: string; approvalMode: ApprovalMode; withMateReviewerExplicit?: true },
  requested: { approvalMode: ApprovalMode; withMateReviewerExplicit?: true },
): true | undefined {
  if (!supportsWithMateAutoReview(current.provider)) return undefined;
  return current.withMateReviewerExplicit || (requested.approvalMode === "on-request" ? requested.withMateReviewerExplicit : undefined);
}

export function resolveExecutionOptionsReviewerUpdate(
  current: { provider: string; approvalMode: ApprovalMode; codexReviewer: CodexReviewer },
  requested: { approvalMode: ApprovalMode; codexReviewer: CodexReviewer },
  confirmedChange?: ConfirmedReviewerChange,
): CodexReviewer {
  if (confirmedChange === undefined) {
    if (requested.approvalMode === "on-request") return requested.codexReviewer;
    if (supportsWithMateAutoReview(current.provider)) {
      return current.codexReviewer;
    }
    return resolveCodexReviewerUpdate(current, requested.codexReviewer);
  }
  if (current.provider !== "claude"
    || current.approvalMode !== confirmedChange?.previousApprovalMode
    || current.codexReviewer !== "auto-review"
    || requested.codexReviewer !== "user"
    || !getApprovalOptionsForProvider(current.provider).some((option) => option.value === requested.approvalMode)
    || !getApprovalReviewerOptionsForProvider(current.provider, requested.approvalMode)
      .some((option) => option.value === "auto-review" && option.disabled)) {
    throw new Error("The confirmed Approval and Reviewer change is no longer valid.");
  }
  return "user";
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
