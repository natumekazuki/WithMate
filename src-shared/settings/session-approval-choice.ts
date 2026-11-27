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

/** Legacy provider modes and a Settings Default reviewer are not explicit public choices. */
export function getSessionApprovalChoice({ provider, approvalMode, codexReviewer, withMateReviewerExplicit }: ApprovalSelection): SessionApprovalChoice | null {
  if (approvalMode === "never") return "auto-run";
  if (approvalMode === "safety-focused") return "safety-focused";
  if (approvalMode !== "on-request" || (supportsWithMateAutoReview(provider) && !withMateReviewerExplicit)) return null;
  return codexReviewer === "auto-review" || codexReviewer === "user" ? codexReviewer : null;
}

export function getSessionApprovalDisplay(settings: ApprovalSelection): { value: SessionApprovalChoice | ""; label: string } {
  const { approvalMode } = settings;
  const value = getSessionApprovalChoice(settings) ?? "";
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
): (Pick<ApprovalSelection, "approvalMode"> & Partial<Omit<ApprovalSelection, "provider" | "approvalMode">>) | null {
  if (choice === "auto-run") return { approvalMode: "never" };
  if (choice === "safety-focused") return { approvalMode: "safety-focused" };
  if (choice !== "user" && choice !== "auto-review") return null;
  return {
    approvalMode: "on-request",
    codexReviewer: choice,
    ...(supportsWithMateAutoReview(provider) ? { withMateReviewerExplicit: true } : {}),
  };
}
