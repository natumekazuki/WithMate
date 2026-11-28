import type { ApprovalMode } from "../../src-shared/settings/approval-mode.js";
import type { CodexSandboxMode } from "../../src-shared/settings/codex-sandbox-mode.js";
import type { CodexSpeed } from "../../src-shared/settings/codex-speed.js";
import type { CodexReviewer } from "../../src-shared/settings/codex-reviewer.js";
import {
  resolveModelItemChangeSelection,
  resolveModelSelection,
  type ModelCatalogProvider,
  type ModelCatalogItem,
  type ModelReasoningEffort,
  type ResolvedModelSelection,
} from "../../src-shared/settings/model-catalog.js";

/** 承認モードの更新可否を判定するために必要なセッション情報。 */
type ApprovalModeSessionLike = {
  approvalMode: ApprovalMode;
};

/** 現在の Codex サンドボックスモードを保持するセッションの最小形。 */
type CodexSandboxModeSessionLike = {
  codexSandboxMode: CodexSandboxMode;
};

/** 現在の Codex 実行速度を保持するセッションの最小形。 */
type CodexSpeedSessionLike = {
  codexSpeed: CodexSpeed;
};

/** 現在の Codex 承認レビュー担当を保持するセッションの最小形。 */
type CodexReviewerSessionLike = {
  codexReviewer: CodexReviewer;
};

/** カタログで再解決する前のモデル ID と推論深度。 */
type ModelRuntimeSessionLike = {
  model: string;
  reasoningEffort: ModelReasoningEffort;
};

/** 選択の解決結果をセッションに反映するモデル・推論深度・更新時刻の組。 */
type ModelRuntimeSessionPatch = {
  model: string;
  reasoningEffort: ModelReasoningEffort;
  updatedAt: string;
};

/** 表示ラベルに依存せず、選択可能な値だけを照合するための候補。 */
type RuntimeOptionValueOption<TValue> = {
  value: TValue;
};

/** 承認モードが変わる場合だけ、更新時刻を付けたセッションのコピーを返す。 */
export function buildSessionWithApprovalMode<
  TSession extends ApprovalModeSessionLike,
>(
  session: TSession,
  approvalMode: ApprovalMode,
  updatedAt: string,
): (TSession & { approvalMode: ApprovalMode; updatedAt: string }) | null {
  if (approvalMode === session.approvalMode) {
    return null;
  }
  return {
    ...session,
    approvalMode,
    updatedAt,
  };
}

/** Codex のサンドボックスモードと更新時刻を差し替える。同じモードなら更新不要を示す null を返す。 */
export function buildSessionWithCodexSandboxMode<
  TSession extends CodexSandboxModeSessionLike,
>(
  session: TSession,
  codexSandboxMode: CodexSandboxMode,
  updatedAt: string,
):
  | (TSession & { codexSandboxMode: CodexSandboxMode; updatedAt: string })
  | null {
  if (codexSandboxMode === session.codexSandboxMode) {
    return null;
  }
  return {
    ...session,
    codexSandboxMode,
    updatedAt,
  };
}

/** 速度が変わったときだけ Codex の速度と更新時刻を反映し、他の設定は引き継ぐ。 */
export function buildSessionWithCodexSpeed<
  TSession extends CodexSpeedSessionLike,
>(
  session: TSession,
  codexSpeed: CodexSpeed,
  updatedAt: string,
): (TSession & { codexSpeed: CodexSpeed; updatedAt: string }) | null {
  if (codexSpeed === session.codexSpeed) {
    return null;
  }
  return {
    ...session,
    codexSpeed,
    updatedAt,
  };
}

/** Codex の承認レビュー担当を変更する。同じ担当なら更新時刻を進めず null を返す。 */
export function buildSessionWithCodexReviewer<
  TSession extends CodexReviewerSessionLike,
>(
  session: TSession,
  codexReviewer: CodexReviewer,
  updatedAt: string,
): (TSession & { codexReviewer: CodexReviewer; updatedAt: string }) | null {
  if (codexReviewer === session.codexReviewer) {
    return null;
  }
  return {
    ...session,
    codexReviewer,
    updatedAt,
  };
}

/** 解決済みのモデルと推論深度を対で差し替え、他のセッション情報を保つ。 */
function buildSessionWithResolvedModelSelection<
  TSession extends ModelRuntimeSessionLike,
>(
  session: TSession,
  selection: ResolvedModelSelection,
  updatedAt: string,
): TSession & ModelRuntimeSessionPatch {
  return {
    ...session,
    model: selection.resolvedModel,
    reasoningEffort: selection.resolvedReasoningEffort,
    updatedAt,
  };
}

/** 新しいモデルに対して従来の推論深度を再解決し、互換な組をセッションへ反映する。 */
export function buildSessionWithModelChange<
  TSession extends ModelRuntimeSessionLike,
>(
  session: TSession,
  model: ModelCatalogItem,
  updatedAt: string,
): TSession & ModelRuntimeSessionPatch {
  const selection = resolveModelItemChangeSelection(
    model,
    session.reasoningEffort,
  );
  return buildSessionWithResolvedModelSelection(session, selection, updatedAt);
}

/** 現在のモデルと指定深度をプロバイダーのカタログで解決してから更新する。 */
export function buildSessionWithReasoningEffort<
  TSession extends ModelRuntimeSessionLike,
>(
  session: TSession,
  providerCatalog: ModelCatalogProvider,
  reasoningEffort: ModelReasoningEffort,
  updatedAt: string,
): TSession & ModelRuntimeSessionPatch {
  const selection = resolveModelSelection(
    providerCatalog,
    session.model,
    reasoningEffort,
  );
  return buildSessionWithResolvedModelSelection(session, selection, updatedAt);
}

/** 現在値が候補になければ先頭の値を選び、候補が空なら呼び出し側の既定値を使う。 */
export function resolveRuntimeOptionValue<TValue>(
  selectedValue: TValue,
  options: readonly RuntimeOptionValueOption<TValue>[],
  fallbackValue: TValue,
): TValue {
  if (options.some((option) => option.value === selectedValue)) {
    return selectedValue;
  }

  return options[0]?.value ?? fallbackValue;
}
