export type ComposerSendabilityState = {
  isRunning: boolean;
  isBlankDraft: boolean;
  blockedReason: string;
  inputErrors: string[];
  primaryFeedback: string;
  secondaryFeedback: string[];
  feedbackTone: "blocked" | "helper" | null;
  shouldShowFeedback: boolean;
  isSendDisabled: boolean;
};

export const BLANK_DRAFT_FEEDBACK = "メッセージを入力してください。";

export function buildComposerSendabilityState({
  runState,
  blockedReason,
  inputErrors,
  draftText,
}: {
  runState: string | null | undefined;
  blockedReason: string;
  inputErrors: string[];
  draftText: string;
}): ComposerSendabilityState {
  const normalizedBlockedReason = blockedReason.trim();
  const normalizedInputErrors = inputErrors.map((error) => error.trim()).filter(Boolean);
  const isRunning = runState === "running";
  const isBlankDraft = draftText.trim().length === 0;

  if (isRunning) {
    return {
      isRunning,
      isBlankDraft,
      blockedReason: normalizedBlockedReason,
      inputErrors: normalizedInputErrors,
      primaryFeedback: "",
      secondaryFeedback: [],
      feedbackTone: null,
      shouldShowFeedback: false,
      isSendDisabled: true,
    };
  }

  const primaryFeedback =
    normalizedBlockedReason
    || normalizedInputErrors[0];
  const secondaryFeedback = normalizedBlockedReason ? normalizedInputErrors : normalizedInputErrors.slice(1);
  const feedbackTone = primaryFeedback
    ? normalizedBlockedReason || normalizedInputErrors.length > 0
      ? "blocked"
      : null
    : null;

  return {
    isRunning,
    isBlankDraft,
    blockedReason: normalizedBlockedReason,
    inputErrors: normalizedInputErrors,
    primaryFeedback,
    secondaryFeedback,
    feedbackTone,
    shouldShowFeedback: !!primaryFeedback || secondaryFeedback.length > 0,
    isSendDisabled: !!normalizedBlockedReason || normalizedInputErrors.length > 0 || isBlankDraft,
  };
}

export function withForcedComposerBlockedFeedback(
  state: ComposerSendabilityState,
  shouldForceBlockedFeedback: boolean,
): ComposerSendabilityState {
  if (!shouldForceBlockedFeedback || state.isRunning || !state.isSendDisabled || state.shouldShowFeedback) {
    return state;
  }

  return {
    ...state,
    primaryFeedback: BLANK_DRAFT_FEEDBACK,
    secondaryFeedback: [],
    feedbackTone: "blocked",
    shouldShowFeedback: true,
  };
}

export function getComposerSendButtonTitle(state: ComposerSendabilityState): string | undefined {
  if (state.isRunning) {
    return "実行をキャンセル";
  }

  if (!state.isSendDisabled) {
    return "メッセージを送信";
  }

  return state.primaryFeedback || (state.isBlankDraft ? BLANK_DRAFT_FEEDBACK : "送信できない状態だよ。");
}
