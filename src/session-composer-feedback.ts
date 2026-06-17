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

export type TextComposerSubmitPreflightResult =
  | { status: "ready"; message: string }
  | { status: "blocked"; reason: "empty"; feedback: string }
  | { status: "blocked"; reason: "running" };

export const BLANK_DRAFT_FEEDBACK = "メッセージを入力してください。";
export const COMPOSER_SEND_BLOCKED_FALLBACK = "送信できない状態だよ。";

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

export function resolveComposerSendabilityState({
  runState,
  blockedReason,
  inputErrors,
  draftText,
  forceBlockedFeedback,
}: {
  runState: string | null | undefined;
  blockedReason: string;
  inputErrors: string[];
  draftText: string;
  forceBlockedFeedback: boolean;
}): ComposerSendabilityState {
  return withForcedComposerBlockedFeedback(
    buildComposerSendabilityState({
      runState,
      blockedReason,
      inputErrors,
      draftText,
    }),
    forceBlockedFeedback,
  );
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

export function getComposerSendBlockedMessage(
  state: ComposerSendabilityState,
  fallback = COMPOSER_SEND_BLOCKED_FALLBACK,
): string | null {
  if (!state.isSendDisabled) {
    return null;
  }

  return state.primaryFeedback || fallback;
}

export function resolveComposerSendPreflight({
  runState,
  blockedReason,
  inputErrors,
  draftText,
  fallbackBlockedMessage,
}: {
  runState: string | null | undefined;
  blockedReason: string;
  inputErrors: string[];
  draftText: string;
  fallbackBlockedMessage?: string;
}): {
  sendability: ComposerSendabilityState;
  blockedMessage: string | null;
} {
  const sendability = buildComposerSendabilityState({
    runState,
    blockedReason,
    inputErrors,
    draftText,
  });

  return {
    sendability,
    blockedMessage: getComposerSendBlockedMessage(sendability, fallbackBlockedMessage),
  };
}

export function resolveTextComposerSubmitPreflight({
  draftText,
  isRunning,
  emptyFeedback = BLANK_DRAFT_FEEDBACK,
}: {
  draftText: string;
  isRunning: boolean;
  emptyFeedback?: string;
}): TextComposerSubmitPreflightResult {
  const message = draftText.trim();
  if (!message) {
    return {
      status: "blocked",
      reason: "empty",
      feedback: emptyFeedback,
    };
  }

  if (isRunning) {
    return { status: "blocked", reason: "running" };
  }

  return { status: "ready", message };
}
