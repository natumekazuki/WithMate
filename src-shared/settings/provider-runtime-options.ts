import {
  CODEX_APPROVAL_MODE_VALUES,
  DEFAULT_APPROVAL_MODE,
  approvalModeOptions,
  type ApprovalMode,
  type CodexApprovalPolicy,
} from "./approval-mode.js";
import {
  codexSandboxModeOptions,
  type CodexSandboxMode,
} from "./codex-sandbox-mode.js";
import {
  codexReviewerOptions,
  resolveCodexReviewerUpdate,
  type CodexReviewer,
} from "./codex-reviewer.js";
import type { ConfirmedReviewerChange } from "../session/session-mutation-contract.js";
import { supportsWithMateAutoReview } from "./withmate-auto-review.js";
import {
  getSessionApprovalChoice,
  resolveSessionApprovalChoice,
  type SessionApprovalChoice,
} from "./session-approval-choice.js";

/** 実行設定のセレクトに渡す保存値・表示ラベルと、選択不可を示す任意のフラグ。 */
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

/** 共有の承認設定を Claude の権限モードに変換し、Claude が扱えない承認・審査者の組み合わせを拒否する。 */
export function mapApprovalModeToClaudePermissionMode(
  approvalMode: ApprovalMode,
  reviewer: CodexReviewer,
) {
  if (approvalMode === "safety-focused") return "default";
  if (approvalMode === "untrusted") {
    throw new Error("The selected approval mode is not supported by Claude.");
  }
  if (reviewer === "auto-review" && approvalMode !== "never") {
    if (approvalMode !== "on-request") {
      throw new Error(
        "Claude Auto Review requires Provider Controlled approval.",
      );
    }
    return "auto";
  }
  return CLAUDE_PERMISSION_MODES[approvalMode];
}

/** Claude と OpenCode は Provider 判断を既定とし、それ以外では共有の既定値を使う。 */
export function getDefaultApprovalModeForProvider(
  providerId: string | null | undefined,
): ApprovalMode {
  return providerId === "claude" || providerId === "opencode"
    ? "on-request"
    : DEFAULT_APPROVAL_MODE;
}

/** Provider ごとの承認モードに絞り、共通の safety-focused を含めた表示用選択肢を作る。 */
export function getApprovalOptionsForProvider(
  providerId: string | null | undefined,
): RuntimeSelectOption<ApprovalMode>[] {
  if (providerId === "opencode") {
    return approvalModeOptions
      .filter(
        (option) =>
          option.id === "on-request" ||
          option.id === "never" ||
          option.id === "safety-focused",
      )
      .map((option) => ({ value: option.id, label: option.label }));
  }
  return approvalModeOptions
    .filter(
      (option) =>
        option.id === "safety-focused" ||
        (providerId === "claude"
          ? Object.hasOwn(CLAUDE_PERMISSION_MODES, option.id)
          : CODEX_APPROVAL_MODE_VALUES.includes(
              option.id as CodexApprovalPolicy,
            )),
    )
    .map((option) => ({ value: option.id, label: option.label }));
}

/** Codex と Claude の審査者候補を返す。Claude の非対応モードでは自動審査を選択不可にする。 */
export function getApprovalReviewerOptionsForProvider(
  providerId: string | null | undefined,
  approvalMode: ApprovalMode,
): RuntimeSelectOption<CodexReviewer>[] {
  if (providerId !== "codex" && providerId !== "claude") return [];
  return codexReviewerOptions.map((option) => ({
    ...option,
    ...(providerId === "claude" &&
    approvalMode !== "on-request" &&
    approvalMode !== "never" &&
    approvalMode !== "safety-focused" &&
    option.value === "auto-review"
      ? { disabled: true }
      : {}),
  }));
}

/** 子 Session へ渡す承認設定。Codex 用のサンドボックスと WithMate 審査者の明示指定は必要な場合だけ付く。 */
type ChildSessionPermissions = {
  approvalMode: ApprovalMode;
  codexReviewer: CodexReviewer;
  codexSandboxMode?: CodexSandboxMode;
  withMateReviewerExplicit?: true;
};

const CHILD_PERMISSION_PROVIDERS = new Set([
  "codex",
  "claude",
  "copilot",
  "opencode",
]);

/**
 * 受付済み Turn の公開承認設定を引き継ぐ。Provider 固有の権限環境は引き継がない。
 * 取得済みの制限を引き継ぎ先で表現できなければ、子 Session の作成前に失敗する。
 */
export function resolveChildSessionPermissions(
  sourceProviderId: string,
  source: Readonly<
    ChildSessionPermissions & {
      codexSandboxMode: CodexSandboxMode;
      customAgentName: string;
    }
  >,
  targetProviderId: string,
): ChildSessionPermissions {
  const {
    approvalMode,
    codexSandboxMode,
    codexReviewer,
    withMateReviewerExplicit,
  } = source;
  if (sourceProviderId === targetProviderId) {
    return {
      approvalMode,
      codexSandboxMode,
      codexReviewer,
      ...(withMateReviewerExplicit ? { withMateReviewerExplicit } : {}),
    };
  }

  if (
    !CHILD_PERMISSION_PROVIDERS.has(sourceProviderId) ||
    !CHILD_PERMISSION_PROVIDERS.has(targetProviderId)
  ) {
    throw new Error(
      `Child permission inheritance is not supported from ${sourceProviderId} to ${targetProviderId}.`,
    );
  }
  if (
    sourceProviderId === "codex" &&
    codexSandboxMode !== "danger-full-access"
  ) {
    throw new Error(
      `Cannot inherit the Codex sandbox mode "${codexSandboxMode}" in ${targetProviderId}.`,
    );
  }
  if (sourceProviderId === "copilot" && source.customAgentName.trim()) {
    throw new Error(
      `Cannot verify that the selected Copilot agent's tool restrictions can be preserved in ${targetProviderId}.`,
    );
  }
  const choice = getSessionApprovalChoice({
    ...source,
    provider: sourceProviderId,
  });
  const sandbox =
    targetProviderId === "codex"
      ? { codexSandboxMode: "read-only" as const }
      : {};
  // 仲介型のレビュー担当を未指定の場合、従来どおり仲介型の子は Settings に従い、
  // それ以外ではネイティブの User を使う。グローバル設定からネイティブの Auto Review を推定しない。
  if (
    choice === null &&
    approvalMode === "on-request" &&
    supportsWithMateAutoReview(sourceProviderId) &&
    !withMateReviewerExplicit
  ) {
    return { approvalMode, codexReviewer: "user", ...sandbox };
  }
  const mapped =
    choice === null
      ? null
      : resolveSessionApprovalChoice(targetProviderId, choice);
  if (!mapped) {
    throw new Error(
      `Cannot inherit the ${sourceProviderId} approval mode "${approvalMode}" in ${targetProviderId}. It is a provider-specific setting, not a shared Approval choice.`,
    );
  }
  const hasReviewer =
    !supportsWithMateAutoReview(sourceProviderId) ||
    withMateReviewerExplicit === true;
  return {
    approvalMode: mapped.approvalMode,
    codexReviewer:
      mapped.codexReviewer ?? (hasReviewer ? codexReviewer : "user"),
    ...(hasReviewer && supportsWithMateAutoReview(targetProviderId)
      ? { withMateReviewerExplicit: true }
      : {}),
    ...sandbox,
  };
}

/** 共有承認選択や確認済みの変更を現在値と照合し、条件に合う審査者だけを反映する。明示的な承認選択なしでは、仲介審査の現在値を保つ。 */
export function resolveExecutionOptionsReviewerUpdate(
  current: {
    provider: string;
    approvalMode: ApprovalMode;
    codexReviewer: CodexReviewer;
    withMateReviewerExplicit?: true;
  },
  requested: {
    approvalMode: ApprovalMode;
    codexReviewer: CodexReviewer;
    withMateReviewerExplicit?: true;
  },
  confirmedChange?: ConfirmedReviewerChange,
  approvalChoice?: SessionApprovalChoice,
): { codexReviewer: CodexReviewer; withMateReviewerExplicit?: true } {
  if (approvalChoice !== undefined) {
    const patch = resolveSessionApprovalChoice(
      current.provider,
      approvalChoice,
    );
    if (
      confirmedChange ||
      !patch ||
      patch.approvalMode !== requested.approvalMode ||
      (patch.codexReviewer !== undefined &&
        patch.codexReviewer !== requested.codexReviewer)
    ) {
      throw new Error(
        "The Approval choice does not match the requested settings.",
      );
    }
    return {
      codexReviewer: patch.codexReviewer ?? current.codexReviewer,
      ...(patch.withMateReviewerExplicit || current.withMateReviewerExplicit
        ? { withMateReviewerExplicit: true }
        : {}),
    };
  }
  if (confirmedChange === undefined) {
    if (supportsWithMateAutoReview(current.provider)) {
      return {
        codexReviewer: current.codexReviewer,
        ...(current.withMateReviewerExplicit
          ? { withMateReviewerExplicit: true }
          : {}),
      };
    }
    return {
      codexReviewer: resolveCodexReviewerUpdate(
        current,
        requested.codexReviewer,
      ),
    };
  }
  if (
    current.provider !== "claude" ||
    current.approvalMode !== confirmedChange?.previousApprovalMode ||
    current.codexReviewer !== "auto-review" ||
    requested.codexReviewer !== "user" ||
    !getApprovalOptionsForProvider(current.provider).some(
      (option) => option.value === requested.approvalMode,
    ) ||
    !getApprovalReviewerOptionsForProvider(
      current.provider,
      requested.approvalMode,
    ).some((option) => option.value === "auto-review" && option.disabled)
  ) {
    throw new Error(
      "The confirmed Approval and Reviewer change is no longer valid.",
    );
  }
  return { codexReviewer: "user" };
}

/** サンドボックス設定を選べる Codex にだけ、保存 ID と表示ラベルの組を返す。 */
export function getSandboxOptionsForProvider(
  providerId: string | null | undefined,
): RuntimeSelectOption<CodexSandboxMode>[] {
  if (providerId !== "codex") {
    return [];
  }

  return codexSandboxModeOptions.map((option) => ({
    value: option.id,
    label: option.label,
  }));
}

/** 利用できる選択肢がある場合は、一覧にない現在値もそのまま表示できるよう先頭に補う。 */
export function getSandboxOptionsForProviderSelection(
  providerId: string | null | undefined,
  selectedValue: CodexSandboxMode,
): RuntimeSelectOption<CodexSandboxMode>[] {
  const options = getSandboxOptionsForProvider(providerId);
  if (
    options.length === 0 ||
    options.some((option) => option.value === selectedValue)
  ) {
    return options;
  }

  return [{ value: selectedValue, label: selectedValue }, ...options];
}
