/** 送信操作の可否と、入力欄やボタンに表示する主・補足メッセージの組。 */
export type ComposerSendabilityState = {
  isRunning: boolean;
  canSendInput: boolean;
  canQueueTurn: boolean;
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

/** テキスト入力の事前判定。送信可能なら前後の空白を除いた本文、不可ならその理由を持つ。 */
export type TextComposerSubmitPreflightResult =
  | { status: "ready"; message: string }
  | { status: "blocked"; reason: "empty"; feedback: string }
  | { status: "blocked"; reason: "running" };

/** 空の下書きで送信を試したときに提示する案内。 */
export const BLANK_DRAFT_FEEDBACK = "Message is empty.";
/** 送信不可の個別理由を表示できないときに使う既定の案内。 */
export const COMPOSER_SEND_BLOCKED_FALLBACK = "Message cannot be sent.";

/** 実行・入力・送信処理の状態から送信可否を判定し、送信を妨げる理由を表示順にまとめる。 */
export function buildComposerSendabilityState({
  runState,
  canSendInput = false,
  canQueueTurn = false,
  busyReason = "",
  blockedReason,
  inputErrors,
  draftText,
}: {
  runState: string | null | undefined;
  canSendInput?: boolean;
  canQueueTurn?: boolean;
  busyReason?: string;
  blockedReason: string;
  inputErrors: string[];
  draftText: string;
}): ComposerSendabilityState {
  const normalizedBlockedReason = blockedReason.trim();
  const normalizedBusyReason = busyReason.trim();
  const normalizedInputErrors = inputErrors
    .map((error) => error.trim())
    .filter(Boolean);
  const isRunning = runState === "running";
  const isBlankDraft = draftText.trim().length === 0;
  const isBusy = normalizedBusyReason.length > 0;

  if (isRunning && !canSendInput && !canQueueTurn) {
    return {
      isRunning,
      canSendInput: false,
      canQueueTurn: false,
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
    normalizedBlockedReason || normalizedInputErrors[0] || "";
  const secondaryFeedback = normalizedBlockedReason
    ? normalizedInputErrors
    : normalizedInputErrors.slice(1);
  const feedbackTone = primaryFeedback
    ? normalizedBlockedReason || normalizedInputErrors.length > 0
      ? "blocked"
      : null
    : null;

  return {
    isRunning,
    canSendInput: isRunning && canSendInput,
    canQueueTurn: isRunning && canQueueTurn,
    isBlankDraft,
    isBusy,
    busyReason: normalizedBusyReason,
    blockedReason: normalizedBlockedReason,
    inputErrors: normalizedInputErrors,
    primaryFeedback,
    secondaryFeedback,
    feedbackTone,
    shouldShowFeedback: !!primaryFeedback || secondaryFeedback.length > 0,
    isSendDisabled:
      isBusy ||
      !!normalizedBlockedReason ||
      normalizedInputErrors.length > 0 ||
      isBlankDraft,
  };
}

/** 送信を試した空の下書きに案内を補う。既存の理由や処理中・送信手段のない実行中の表示は変えない。 */
export function withForcedComposerBlockedFeedback(
  state: ComposerSendabilityState,
  shouldForceBlockedFeedback: boolean,
): ComposerSendabilityState {
  if (
    !shouldForceBlockedFeedback ||
    (state.isRunning && !state.canSendInput && !state.canQueueTurn) ||
    !state.isSendDisabled ||
    state.shouldShowFeedback
  ) {
    return state;
  }

  if (state.isBusy) {
    return state;
  }

  return {
    ...state,
    primaryFeedback: BLANK_DRAFT_FEEDBACK,
    secondaryFeedback: [],
    feedbackTone: "helper",
    shouldShowFeedback: true,
  };
}

/** 基本の送信可否に、送信を試した後のフィードバック表示の指定を適用する。 */
export function resolveComposerSendabilityState({
  runState,
  canSendInput,
  canQueueTurn,
  busyReason,
  blockedReason,
  inputErrors,
  draftText,
  forceBlockedFeedback,
}: {
  runState: string | null | undefined;
  canSendInput?: boolean;
  canQueueTurn?: boolean;
  busyReason?: string;
  blockedReason: string;
  inputErrors: string[];
  draftText: string;
  forceBlockedFeedback: boolean;
}): ComposerSendabilityState {
  return withForcedComposerBlockedFeedback(
    buildComposerSendabilityState({
      runState,
      canSendInput,
      canQueueTurn,
      busyReason,
      blockedReason,
      inputErrors,
      draftText,
    }),
    forceBlockedFeedback,
  );
}

/** 送信ボタンの現在の操作または無効理由を返す。処理中だけが理由ならタイトルを設定しない。 */
export function getComposerSendButtonTitle(
  state: ComposerSendabilityState,
): string | undefined {
  if (state.isRunning && !state.canSendInput && !state.canQueueTurn) {
    return "Cancel run";
  }

  if (!state.isSendDisabled) {
    return state.canQueueTurn
      ? "Save this input for the next turn"
      : state.canSendInput
        ? "Send input to the current turn"
        : "Send message";
  }

  if (
    state.isBusy &&
    !state.primaryFeedback &&
    state.inputErrors.length === 0 &&
    !state.blockedReason
  ) {
    return undefined;
  }

  return (
    state.primaryFeedback ||
    (state.isBlankDraft ? BLANK_DRAFT_FEEDBACK : COMPOSER_SEND_BLOCKED_FALLBACK)
  );
}

/** 送信不可なら主理由または呼び出し元の既定理由を返し、送信可能なら空値を返す。 */
export function getComposerSendBlockedMessage(
  state: ComposerSendabilityState,
  fallback = COMPOSER_SEND_BLOCKED_FALLBACK,
): string | null {
  if (!state.isSendDisabled) {
    return null;
  }

  return state.primaryFeedback || fallback;
}

/** 通常送信の事前判定と、送信を拒む場合に通知する理由を同じ判定結果から返す。 */
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
    blockedMessage: getComposerSendBlockedMessage(
      sendability,
      fallbackBlockedMessage,
    ),
  };
}

/** テキスト送信前に空本文、実行中の順に拒否を判定し、許可時は整形済みの本文を返す。 */
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
