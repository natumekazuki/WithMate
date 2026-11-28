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

/** Sessionの設定画面で選択できる承認方式の値。内部の承認モードとは区別する。 */
export type SessionApprovalChoice = (typeof approvalChoices)[number]["value"];

/** 入力文字列が公開されている承認の選択値と一致するか調べる。 */
export function isSessionApprovalChoice(
  value: string,
): value is SessionApprovalChoice {
  return approvalChoices.some((option) => option.value === value);
}

/** 表示方式の解決に使うProvider・承認設定と、判断役を明示したかどうか。 */
type ApprovalSelection = {
  provider: string;
  approvalMode: ApprovalMode;
  codexReviewer: CodexReviewer;
  withMateReviewerExplicit?: true;
};

/** 表示順と固定ラベルを保ち、呼び出し側で並べ替えられる別の配列を返す。 */
export function getSessionApprovalChoices(): RuntimeSelectOption<SessionApprovalChoice>[] {
  return [...approvalChoices];
}

/** 旧形式の Provider モードと Settings の Default reviewer は、明示的な公開設定として扱わない。 */
export function getSessionApprovalChoice({
  provider,
  approvalMode,
  codexReviewer,
  withMateReviewerExplicit,
}: ApprovalSelection): SessionApprovalChoice | null {
  if (approvalMode === "never") return "auto-run";
  if (approvalMode === "safety-focused") return "safety-focused";
  if (
    approvalMode !== "on-request" ||
    (supportsWithMateAutoReview(provider) && !withMateReviewerExplicit)
  )
    return null;
  return codexReviewer === "auto-review" || codexReviewer === "user"
    ? codexReviewer
    : null;
}

/** 明示的な選択がない場合も、設定の既定値や旧方式を空の選択値と説明ラベルで表示する。 */
export function getSessionApprovalDisplay(settings: ApprovalSelection): {
  value: SessionApprovalChoice | "";
  label: string;
} {
  const { approvalMode } = settings;
  const value = getSessionApprovalChoice(settings) ?? "";
  return {
    value,
    label:
      approvalChoices.find((option) => option.value === value)?.label ??
      (approvalMode === "on-request"
        ? "Settings Default"
        : approvalMode === "untrusted"
          ? "Legacy Safety Focused"
          : approvalModeLabel(approvalMode)),
  };
}

/** 選択値を保存用の承認設定へ変換し、対応Providerでは判断役の明示も記録する。 */
export function resolveSessionApprovalChoice(
  provider: string,
  choice: string,
):
  | (Pick<ApprovalSelection, "approvalMode"> &
      Partial<Omit<ApprovalSelection, "provider" | "approvalMode">>)
  | null {
  if (choice === "auto-run") return { approvalMode: "never" };
  if (choice === "safety-focused") return { approvalMode: "safety-focused" };
  if (choice !== "user" && choice !== "auto-review") return null;
  return {
    approvalMode: "on-request",
    codexReviewer: choice,
    ...(supportsWithMateAutoReview(provider)
      ? { withMateReviewerExplicit: true }
      : {}),
  };
}
