export type ComposerSendabilityState = {
  isRunning: boolean;
  allowSendWhileRunning: boolean;
  isBlankDraft: boolean;
  isBusy: boolean;
  busyReason: string;
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

export const BLANK_DRAFT_FEEDBACK = "Message is empty.";
export const COMPOSER_SEND_BLOCKED_FALLBACK = "Message cannot be sent.";

export function buildComposerSendabilityState({
  runState,
  allowSendWhileRunning = false,
  busyReason = "",
  blockedReason,
  inputErrors,
  draftText,
}: {
  runState: string | null | undefined;
  allowSendWhileRunning?: boolean;
  busyReason?: string;
  blockedReason: string;
  inputErrors: string[];
  draftText: string;
}): ComposerSendabilityState {
  const normalizedBlockedReason = blockedReason.trim();
  const normalizedBusyReason = busyReason.trim();
  const normalizedInputErrors = inputErrors.map((error) => error.trim()).filter(Boolean);
  const isRunning = runState === "running";
  const isBlankDraft = draftText.trim().length === 0;
  const isBusy = normalizedBusyReason.length > 0;

  if (isRunning && !allowSendWhileRunning) {
    return {
      isRunning,
      allowSendWhileRunning,
      isBlankDraft,
      isBusy,
      busyReason: normalizedBusyReason,
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
    allowSendWhileRunning,
    isBlankDraft,
    isBusy,
    busyReason: normalizedBusyReason,
    blockedReason: normalizedBlockedReason,
    inputErrors: normalizedInputErrors,
    primaryFeedback,
    secondaryFeedback,
    feedbackTone,
    shouldShowFeedback: !!primaryFeedback || secondaryFeedback.length > 0,
    isSendDisabled: isBusy || !!normalizedBlockedReason || normalizedInputErrors.length > 0 || isBlankDraft,
  };
}

export function withForcedComposerBlockedFeedback(
  state: ComposerSendabilityState,
  shouldForceBlockedFeedback: boolean,
): ComposerSendabilityState {
  if (!shouldForceBlockedFeedback || state.isRunning || !state.isSendDisabled || state.shouldShowFeedback) {
    return state;
  }

  if (state.isBusy) {
    return {
      ...state,
      primaryFeedback: state.busyReason,
      secondaryFeedback: [],
      feedbackTone: "helper",
      shouldShowFeedback: true,
    };
  }

  return {
    ...state,
    primaryFeedback: BLANK_DRAFT_FEEDBACK,
    secondaryFeedback: [],
    feedbackTone: "helper",
    shouldShowFeedback: true,
  };
}

export function resolveComposerSendabilityState({
  runState,
  allowSendWhileRunning = false,
  busyReason,
  blockedReason,
  inputErrors,
  draftText,
  forceBlockedFeedback,
}: {
  runState: string | null | undefined;
  allowSendWhileRunning?: boolean;
  busyReason?: string;
  blockedReason: string;
  inputErrors: string[];
  draftText: string;
  forceBlockedFeedback: boolean;
}): ComposerSendabilityState {
  return withForcedComposerBlockedFeedback(
    buildComposerSendabilityState({
      runState,
      allowSendWhileRunning,
      busyReason,
      blockedReason,
      inputErrors,
      draftText,
    }),
    forceBlockedFeedback,
  );
}

export function getComposerSendButtonTitle(state: ComposerSendabilityState): string | undefined {
  if (!state.isSendDisabled) {
    return "メッセージを送信";
  }

  if (state.isRunning && !state.allowSendWhileRunning) {
    return "実行をキャンセル";
  }

  return state.primaryFeedback
    || state.busyReason
    || (state.isBlankDraft ? BLANK_DRAFT_FEEDBACK : COMPOSER_SEND_BLOCKED_FALLBACK);
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
  allowSendWhileRunning = false,
  blockedReason,
  inputErrors,
  draftText,
  fallbackBlockedMessage,
}: {
  runState: string | null | undefined;
  allowSendWhileRunning?: boolean;
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
    allowSendWhileRunning,
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
