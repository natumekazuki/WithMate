import type { WithMateWindowApi } from "../../../src-shared/ipc/withmate-window-api.js";
import type { SetSessionTitleResult } from "../../../src-shared/session/session-mutation-contract.js";
import type { ConfirmedReviewerChange } from "../../../src-shared/session/session-mutation-contract.js";
import {
  applyCopilotCustomAgentSelection,
  getSessionIncarnationId,
  type Session,
} from "../../../src-shared/session/session-state.js";
import type { ApprovalMode } from "../../../src-shared/settings/approval-mode.js";
import type { CodexSandboxMode } from "../../../src-shared/settings/codex-sandbox-mode.js";
import type { CodexSpeed } from "../../../src-shared/settings/codex-speed.js";
import type { CodexReviewer } from "../../../src-shared/settings/codex-reviewer.js";
import { supportsWithMateAutoReview } from "../../../src-shared/settings/withmate-auto-review.js";
import {
  resolveSessionApprovalChoice,
  type SessionApprovalChoice,
} from "../../../src-shared/settings/session-approval-choice.js";
import type {
  ModelCatalogProvider,
  ModelCatalogItem,
  ModelReasoningEffort,
} from "../../../src-shared/settings/model-catalog.js";
import {
  buildSessionWithApprovalMode,
  buildSessionWithCodexReviewer,
  buildSessionWithCodexSandboxMode,
  buildSessionWithCodexSpeed,
  buildSessionWithModelChange,
  buildSessionWithReasoningEffort,
} from "../../settings/runtime-option-state.js";

/** メインセッションの実行設定で一度に適用する変更の種類と値。 */
export type MainRuntimeOption =
  | { kind: "custom-agent"; value: string }
  | {
      kind: "approval-mode";
      value: ApprovalMode;
      confirmedReviewerChange?: ConfirmedReviewerChange;
    }
  | { kind: "approval-choice"; value: SessionApprovalChoice }
  | { kind: "codex-sandbox-mode"; value: CodexSandboxMode }
  | { kind: "codex-speed"; value: CodexSpeed }
  | { kind: "codex-reviewer"; value: CodexReviewer }
  | { kind: "model"; value: ModelCatalogItem }
  | { kind: "reasoning-effort"; value: ModelReasoningEffort };

/** プロバイダーの対応範囲と編集可否を確認し、適用できる実行設定だけを保存する。 */
export async function runMainRuntimeOptionOperation(input: {
  session: Session | null;
  isReadOnly: boolean;
  providerCatalog: ModelCatalogProvider | null;
  option: MainRuntimeOption;
  persist: (
    session: Session,
    confirmedReviewerChange?: ConfirmedReviewerChange,
    approvalChoice?: SessionApprovalChoice,
  ) => Promise<Session>;
  createTimestampLabel: () => string;
}): Promise<Session | null> {
  const {
    session,
    isReadOnly,
    providerCatalog,
    option,
    persist,
    createTimestampLabel,
  } = input;
  if (!session || isReadOnly) return null;

  if (option.kind === "approval-choice") {
    const patch = resolveSessionApprovalChoice(session.provider, option.value);
    if (
      !patch ||
      Object.entries(patch).every(
        ([key, value]) => session[key as keyof Session] === value,
      )
    )
      return null;
    return persist(
      { ...session, ...patch, updatedAt: createTimestampLabel() },
      undefined,
      option.value,
    );
  }

  if (option.kind === "custom-agent") {
    if (
      session.provider !== "copilot" ||
      session.customAgentName === option.value
    )
      return null;
    return persist(
      applyCopilotCustomAgentSelection(
        session,
        option.value,
        createTimestampLabel(),
      ),
    );
  }

  if (option.kind === "approval-mode") {
    if (
      option.confirmedReviewerChange &&
      (session.provider !== "claude" ||
        session.codexReviewer !== "auto-review" ||
        session.approvalMode !==
          option.confirmedReviewerChange.previousApprovalMode)
    )
      return null;
    const next = buildSessionWithApprovalMode(
      session,
      option.value,
      createTimestampLabel(),
    );
    return next
      ? persist(
          option.confirmedReviewerChange
            ? { ...next, codexReviewer: "user" }
            : next,
          option.confirmedReviewerChange,
        )
      : null;
  }

  if (option.kind === "codex-sandbox-mode") {
    if (session.provider !== "codex") return null;
    const next = buildSessionWithCodexSandboxMode(
      session,
      option.value,
      createTimestampLabel(),
    );
    return next ? persist(next) : null;
  }
  if (option.kind === "codex-speed") {
    if (session.provider !== "codex") return null;
    const next = buildSessionWithCodexSpeed(
      session,
      option.value,
      createTimestampLabel(),
    );
    return next ? persist(next) : null;
  }
  if (option.kind === "codex-reviewer") {
    if (supportsWithMateAutoReview(session.provider)) {
      if (
        session.approvalMode !== "on-request" ||
        (session.withMateReviewerExplicit &&
          session.codexReviewer === option.value)
      )
        return null;
      return persist({
        ...session,
        codexReviewer: option.value,
        withMateReviewerExplicit: true,
        updatedAt: createTimestampLabel(),
      });
    }
    if (
      (session.provider !== "codex" && session.provider !== "claude") ||
      session.approvalMode === "never"
    )
      return null;
    const next = buildSessionWithCodexReviewer(
      session,
      option.value,
      createTimestampLabel(),
    );
    return next ? persist(next) : null;
  }
  if (option.kind === "model") {
    return persist(
      buildSessionWithModelChange(
        session,
        option.value,
        createTimestampLabel(),
      ),
    );
  }
  if (!providerCatalog) return null;
  return persist(
    buildSessionWithReasoningEffort(
      session,
      providerCatalog,
      option.value,
      createTimestampLabel(),
    ),
  );
}

/** 現在のピン状態を反転して保存し、表示更新に必要な識別子と結果だけを返す。 */
export async function toggleMainSessionPin(input: {
  api: Pick<WithMateWindowApi, "setSessionPinned"> | null;
  session: Session;
}): Promise<Pick<Session, "id" | "isPinned">> {
  if (!input.api) {
    throw new Error("Open the Session Window from Electron.");
  }
  const saved = await input.api.setSessionPinned({
    sessionId: input.session.id,
    isPinned: input.session.isPinned !== true,
  });
  return { id: saved.id, isPinned: saved.isPinned };
}

/** セッション世代を指定してタイトルを保存し、投影の未更新や保存失敗時は可能なら保存値を再取得する。 */
export async function updateMainSessionTitle(input: {
  api: Pick<WithMateWindowApi, "setSessionTitle" | "getSessionSummary">;
  session: Session;
  title: string;
  /** 非同期処理の結果を開始時と同じ対象へまだ反映できるかを返す。 */
  isCurrent(): boolean;
  /** 対象が変わっていないことを確認した後、表示中のタイトルを反映する。 */
  applyTitle(title: string): void;
}): Promise<string> {
  const { api, session, title, isCurrent, applyTitle } = input;
  const incarnationId = getSessionIncarnationId(session);
  let result: SetSessionTitleResult;
  try {
    result = await api.setSessionTitle({
      sessionId: session.id,
      incarnationId,
      title,
    });
  } catch (error) {
    if (isCurrent()) {
      try {
        const saved = await api.getSessionSummary(session.id);
        if (
          isCurrent() &&
          saved &&
          getSessionIncarnationId(saved) === incarnationId
        )
          applyTitle(saved.taskTitle);
      } catch {
        if (isCurrent()) {
          throw new Error(
            `${error instanceof Error ? error.message : String(error)} The saved title could not be reloaded. Close and reopen the session window to refresh.`,
            { cause: error },
          );
        }
      }
    }
    throw error;
  }
  if (!isCurrent()) return "";
  applyTitle(title);
  if (result.projectionUpdated) return "";

  try {
    const saved = await api.getSessionSummary(session.id);
    if (!isCurrent()) return "";
    if (!saved || getSessionIncarnationId(saved) !== incarnationId) {
      return "Title saved, but this session is no longer available. Close and reopen the session window.";
    }
    applyTitle(saved.taskTitle);
    return "Title saved and reloaded, but other windows may be out of date. Reopen them to refresh.";
  } catch {
    if (!isCurrent()) return "";
    return "Title saved, but window updates failed and the saved title could not be reloaded. Close and reopen the session window to refresh.";
  }
}
