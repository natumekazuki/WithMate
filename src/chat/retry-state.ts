import type { SessionTurnRecord } from "../../src-shared/session/session-turn-state.js";
import type { Message } from "../../src-shared/session/session-state.js";
import { getMessageHistoryIndex } from "../../src-shared/session/conversation-page.js";
import { applyComposerDraftChangeCommand } from "./composer-draft-handlers.js";

/** 再試行の対象となる未完了ターンの終了理由。 */
export type RetryKind = "interrupted" | "failed" | "canceled";

/** 操作表示と下書き保護に使う再試行の理由と元の依頼文。 */
export type RetryState = {
  kind: RetryKind;
  lastRequestText: string;
};

/** 再試行元の依頼文と履歴位置、および同じ依頼に対応すると確認できた終端ターン。 */
export type RetrySource = {
  kind: RetryKind;
  lastRequestText: string;
  userMessageSeq: number;
  terminalTurn: SessionTurnRecord | null;
};

/** 元の依頼文を編集欄に復元した直後の下書き、カーソル、操作欄の状態。 */
export type RetryDraftRestoreState = {
  draft: string;
  caret: number;
  isRetryDraftReplacePending: false;
  isActionDockPinnedExpanded: true;
};

/** 元の依頼文を下書きにし、末尾へカーソルを置いて操作欄を展開する状態を作る。 */
export function buildRetryDraftRestoreState(
  messageText: string,
): RetryDraftRestoreState {
  return {
    draft: messageText,
    caret: messageText.length,
    isRetryDraftReplacePending: false,
    isActionDockPinnedExpanded: true,
  };
}

/** 再送操作が有効で元の依頼文が渡された場合だけ、編集を挟まず再送する。 */
export async function runRetryResendCommand(input: {
  isDisabled: boolean;
  messageText: string | null | undefined;
  resendMessage: (messageText: string) => Promise<void>;
}): Promise<void> {
  if (input.isDisabled || input.messageText == null) {
    return;
  }

  await input.resendMessage(input.messageText);
}

/** 元の依頼文と末尾カーソルを編集欄に反映し、置換待ちを解除して入力欄へフォーカスする。 */
export function applyRetryDraftRestoreCommand(input: {
  messageText: string;
  setActionDockPinnedExpanded: (expanded: boolean) => void;
  setDraft: (draft: string) => void;
  setCaret: (caret: number) => void;
  syncCaret?: (caret: number) => void;
  setRetryDraftReplacePending: (pending: boolean) => void;
  focusComposer: (caret: number) => void;
}): void {
  const nextState = buildRetryDraftRestoreState(input.messageText);

  input.setActionDockPinnedExpanded(nextState.isActionDockPinnedExpanded);
  applyComposerDraftChangeCommand({
    value: nextState.draft,
    selectionStart: nextState.caret,
    setDraft: input.setDraft,
    setComposerCaret: input.setCaret,
    syncMainComposerCaret: input.syncCaret,
  });
  input.setRetryDraftReplacePending(nextState.isRetryDraftReplacePending);
  input.focusComposer(nextState.caret);
}

/** 有効な再編集操作について、現在の下書きを守る確認か元の依頼文の即時復元かを選ぶ。 */
export function applyRetryEditCommand(input: {
  isDisabled: boolean;
  messageText: string | null | undefined;
  shouldProtectDraft: boolean | (() => boolean);
  requestDraftReplaceConfirmation: () => void;
  restoreDraft: (messageText: string) => void;
}): void {
  if (input.isDisabled || input.messageText == null) {
    return;
  }

  if (
    typeof input.shouldProtectDraft === "function"
      ? input.shouldProtectDraft()
      : input.shouldProtectDraft
  ) {
    input.requestDraftReplaceConfirmation();
    return;
  }

  input.restoreDraft(input.messageText);
}

/** 再編集操作を、保護要否を実行時に評価できるクリックハンドラーに束ねる。 */
export function createRetryEditHandler(input: {
  isDisabled: boolean;
  messageText: string | null | undefined;
  shouldProtectDraft: boolean | (() => boolean);
  requestDraftReplaceConfirmation: () => void;
  restoreDraft: (messageText: string) => void;
}): () => void {
  return () => applyRetryEditCommand(input);
}

/** 置換の確定時にも操作可否と元の依頼文を確認し、有効なら下書きを復元する。 */
export function applyRetryDraftReplaceConfirmation(input: {
  isDisabled: boolean;
  messageText: string | null | undefined;
  restoreDraft: (messageText: string) => void;
}): void {
  if (input.isDisabled || input.messageText == null) {
    return;
  }

  input.restoreDraft(input.messageText);
}

/** 下書き置換の確定操作から呼ぶ引数なしのハンドラーを作る。 */
export function createRetryDraftReplaceConfirmationHandler(input: {
  isDisabled: boolean;
  messageText: string | null | undefined;
  restoreDraft: (messageText: string) => void;
}): () => void {
  return () => applyRetryDraftReplaceConfirmation(input);
}

/** 下書きを変更せず、置換確認の待ち状態だけを解除する。 */
export function applyCancelRetryDraftReplace(input: {
  setRetryDraftReplacePending: (pending: boolean) => void;
}): void {
  input.setRetryDraftReplacePending(false);
}

/** 下書き置換の取り消し操作から呼ぶ引数なしのハンドラーを作る。 */
export function createCancelRetryDraftReplaceHandler(input: {
  setRetryDraftReplacePending: (pending: boolean) => void;
}): () => void {
  return () => applyCancelRetryDraftReplace(input);
}

/** 実行中・完了済みを除外し、セッション状態と対応する終端ターンから再試行理由を判定する。 */
export function resolveRetryKind(input: {
  runState: string | null | undefined;
  latestTurnPhase?: SessionTurnRecord["phase"] | null;
}): RetryKind | null {
  if (input.runState === "running" || input.latestTurnPhase === "completed")
    return null;
  if (input.runState === "interrupted") {
    return input.latestTurnPhase === "failed" ? "failed" : "interrupted";
  }

  if (input.runState === "error") {
    return "failed";
  }

  if (input.runState === "idle" && input.latestTurnPhase === "canceled") {
    return "canceled";
  }

  return null;
}

/** 追加のターン入力を除いた最後のユーザー依頼を特定し、同じセッションと履歴位置の終端ターンだけを関連付ける。 */
export function resolveRetrySource(input: {
  sessionId: string | null | undefined;
  messages: readonly Message[];
  latestUserMessage?: Message | null;
  latestTurn: SessionTurnRecord | null;
  runState: string | null | undefined;
}): RetrySource | null {
  if (!input.sessionId || input.runState === "running") {
    return null;
  }

  let lastUserMessageSeq = -1;
  let lastUserMessage: Message | null = null;
  for (let index = input.messages.length - 1; index >= 0; index -= 1) {
    if (
      input.messages[index]?.role === "user" &&
      !input.messages[index].turnInput
    ) {
      lastUserMessageSeq = getMessageHistoryIndex(input.messages[index], index);
      lastUserMessage = input.messages[index];
      break;
    }
  }
  if (
    !lastUserMessage &&
    input.latestUserMessage?.role === "user" &&
    !input.latestUserMessage.turnInput
  ) {
    lastUserMessage = input.latestUserMessage;
    lastUserMessageSeq = input.latestUserMessage.historyIndex ?? -1;
  }
  if (lastUserMessageSeq < 0) {
    return null;
  }

  const terminalTurn =
    input.latestTurn?.sessionId === input.sessionId &&
    input.latestTurn.userMessageSeq === lastUserMessageSeq &&
    input.latestTurn.phase !== "running"
      ? input.latestTurn
      : null;
  const kind = resolveRetryKind({
    runState: input.runState,
    latestTurnPhase: terminalTurn?.phase,
  });

  return kind
    ? {
        kind,
        lastRequestText: lastUserMessage?.text ?? "",
        userMessageSeq: lastUserMessageSeq,
        terminalTurn,
      }
    : null;
}

/** 空白だけではなく、再試行元の依頼文とも異なる下書きを上書き確認の対象にする。 */
export function shouldProtectRetryEditDraft(input: {
  retryState: Pick<RetryState, "lastRequestText"> | null;
  draft: string;
}): boolean {
  return (
    !!input.retryState &&
    input.draft.trim().length > 0 &&
    input.draft !== input.retryState.lastRequestText
  );
}

/** 元のユーザー依頼があり、読み取り専用でも実行中でもない場合に再試行操作の表示を許可する。 */
export function shouldShowRetryActions(input: {
  hasLastUserMessage: boolean;
  isReadOnly: boolean;
  runState: string | null | undefined;
}): boolean {
  return (
    input.hasLastUserMessage &&
    !input.isReadOnly &&
    input.runState !== "running"
  );
}

/** 表示条件に加えて、再試行元の確定と入力欄の操作可否を確認する。 */
export function isRetryActionDisabled(input: {
  retryState: RetryState | null;
  hasLastUserMessage: boolean;
  composerBlocked: boolean;
  isReadOnly: boolean;
  runState: string | null | undefined;
}): boolean {
  return (
    !input.retryState ||
    !input.hasLastUserMessage ||
    input.composerBlocked ||
    input.isReadOnly ||
    input.runState === "running"
  );
}
