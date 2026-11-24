import { approvalModeLabel, type ApprovalMode } from "./approval-mode.js";
import type { CodexReviewer } from "./codex-reviewer.js";
import type { RuntimeSelectOption } from "./provider-runtime-options.js";
import { supportsWithMateAutoReview } from "./withmate-auto-review.js";

const approvalChoices = [
  { value: "auto-run", label: "Auto Run" },
  { value: "auto-review", label: "Auto Review" },
  { value: "user", label: "User" },
  { value: "safety-focused", label: "Safety Focused" },
] as const;

export type SessionApprovalChoice = (typeof approvalChoices)[number]["value"];

export function isSessionApprovalChoice(value: string): value is SessionApprovalChoice {
  return approvalChoices.some((option) => option.value === value);
}

type ApprovalSelection = {
  provider: string;
  approvalMode: ApprovalMode;
  codexReviewer: CodexReviewer;
  withMateReviewerExplicit?: true;
};

export function getSessionApprovalChoices(): RuntimeSelectOption<SessionApprovalChoice>[] {
  return [...approvalChoices];
}

export function getSessionApprovalDisplay(settings: ApprovalSelection): { value: SessionApprovalChoice | ""; label: string } {
  const { provider, approvalMode, codexReviewer, withMateReviewerExplicit } = settings;
  const value = approvalMode === "never" ? "auto-run" : approvalMode === "safety-focused" ? "safety-focused"
    : approvalMode === "on-request" && (!supportsWithMateAutoReview(provider) || withMateReviewerExplicit) ? codexReviewer
      : "";
  return {
    value,
    label: approvalChoices.find((option) => option.value === value)?.label
      ?? (approvalMode === "on-request" ? "Settings Default"
        : approvalMode === "untrusted" ? "Legacy Safety Focused" : approvalModeLabel(approvalMode)),
  };
}

export function resolveSessionApprovalChoice(
  provider: string,
  choice: string,
): Partial<Omit<ApprovalSelection, "provider">> | null {
  if (choice === "auto-run") return { approvalMode: "never" };
  if (choice === "safety-focused") return { approvalMode: "safety-focused" };
  if (choice !== "user" && choice !== "auto-review") return null;
  return {
    approvalMode: "on-request",
    codexReviewer: choice,
    ...(supportsWithMateAutoReview(provider) ? { withMateReviewerExplicit: true } : {}),
  };
}
