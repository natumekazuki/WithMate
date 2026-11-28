import type { ApprovalMode } from "./approval-mode.js";
import type { RuntimeSelectOption } from "./provider-runtime-options.js";

/** 承認の判断者として設定に保存できる値。 */
export const CODEX_REVIEWER_VALUES = ["user", "auto-review"] as const;
/** ユーザー審査か自動審査かを表す WithMate の設定値。 */
export type CodexReviewer = (typeof CODEX_REVIEWER_VALUES)[number];

/** 自動審査が明示されていない場合に使う判断者。 */
export const DEFAULT_CODEX_REVIEWER: CodexReviewer = "user";

/** ユーザー審査と自動審査を切り替えるセレクトの選択肢。 */
export const codexReviewerOptions = [
  { value: "user", label: "User" },
  { value: "auto-review", label: "Auto Review" },
] as const satisfies readonly RuntimeSelectOption<CodexReviewer>[];

/** Codex に送る承認審査者の値。自動審査の表記は保存値と異なる。 */
export type CodexApprovalsReviewer = "user" | "auto_review";

/** 自動審査の ID が正確に指定された場合だけ採用し、それ以外はユーザー審査にする。 */
export function normalizeCodexReviewer(value: unknown): CodexReviewer {
  return value === "auto-review" ? "auto-review" : DEFAULT_CODEX_REVIEWER;
}

/** 自動審査の保存値を Codex が受け付けるアンダースコア表記に変換する。 */
export function mapCodexReviewerToApprovalsReviewer(
  reviewer: CodexReviewer,
): CodexApprovalsReviewer {
  return reviewer === "auto-review" ? "auto_review" : "user";
}

/** 承認を求めないモードでは現在の判断者を保持し、それ以外では要求値を正規化する。 */
export function resolveCodexReviewerUpdate(
  current:
    | { approvalMode: ApprovalMode; codexReviewer: CodexReviewer }
    | null
    | undefined,
  requestedReviewer: unknown,
): CodexReviewer {
  if (current?.approvalMode === "never") {
    return current.codexReviewer;
  }
  return normalizeCodexReviewer(requestedReviewer);
}

/** 実行中、入力操作のブロック中、または承認を求めないモードでは判断者の変更を無効にする。 */
export function isCodexReviewerControlDisabled(input: {
  approvalMode: ApprovalMode;
  isRunning: boolean;
  composerBlocked: boolean;
}): boolean {
  return (
    input.isRunning || input.composerBlocked || input.approvalMode === "never"
  );
}
