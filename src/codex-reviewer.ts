import type { ApprovalMode } from "./approval-mode.js";
import type { RuntimeSelectOption } from "./provider-runtime-options.js";

export const CODEX_REVIEWER_VALUES = ["user", "auto-review"] as const;
export type CodexReviewer = (typeof CODEX_REVIEWER_VALUES)[number];

export const DEFAULT_CODEX_REVIEWER: CodexReviewer = "user";

export const codexReviewerOptions = [
  { value: "user", label: "User" },
  { value: "auto-review", label: "Auto-review" },
] as const satisfies readonly RuntimeSelectOption<CodexReviewer>[];

export type CodexApprovalsReviewer = "user" | "auto_review";

export function normalizeCodexReviewer(value: unknown): CodexReviewer {
  return value === "auto-review" ? "auto-review" : DEFAULT_CODEX_REVIEWER;
}

export function mapCodexReviewerToApprovalsReviewer(reviewer: CodexReviewer): CodexApprovalsReviewer {
  return reviewer === "auto-review" ? "auto_review" : "user";
}

export function resolveCodexReviewerUpdate(
  current: { approvalMode: ApprovalMode; codexReviewer: CodexReviewer } | null | undefined,
  requestedReviewer: unknown,
): CodexReviewer {
  if (current?.approvalMode === "never") {
    return current.codexReviewer;
  }
  return normalizeCodexReviewer(requestedReviewer);
}

export function getCodexReviewerOptions(
  providerId: string | null | undefined,
): RuntimeSelectOption<CodexReviewer>[] {
  return providerId === "codex" ? codexReviewerOptions.map((option) => ({ ...option })) : [];
}

export function isCodexReviewerControlDisabled(input: {
  approvalMode: ApprovalMode;
  isRunning: boolean;
  composerBlocked: boolean;
}): boolean {
  return input.isRunning || input.composerBlocked || input.approvalMode === "never";
}
