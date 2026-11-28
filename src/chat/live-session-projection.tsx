import type { SessionContextPaneProps } from "./shell/session-context-pane.js";
import type { SessionRecoveryActionsProps } from "./runtime/session-recovery-actions.js";
import {
  buildLiveSessionContextPaneProps,
  type LiveSessionComposerDockPropsInput,
  type LiveSessionMessageColumnProps,
} from "./chat-window-adapter.js";
import type { ChatErrorNotice } from "./chat-window.js";

/** 実行中の会話に復旧操作を渡すための入力。復旧コンポーネントと同じ契約を使う。 */
export type LiveSessionRecoveryActionsInput = SessionRecoveryActionsProps;

/** 復旧操作の状態とコールバックを加工せず表示側に渡す。 */
export function buildLiveSessionRecoveryActions(
  input: LiveSessionRecoveryActionsInput,
) {
  return input;
}

/** 表示対象の送信阻害理由をエラー通知の先頭に載せ、同じ主文の追加通知があれば重複させない。 */
export function buildLiveSessionErrorNotices(input: {
  composerFeedback: {
    primaryFeedback: string;
    secondaryFeedback: readonly string[];
    feedbackTone: "blocked" | "helper" | null;
    shouldShowFeedback: boolean;
  };
  additionalNotices?: readonly ChatErrorNotice[];
}): ChatErrorNotice[] {
  const additionalNotices = input.additionalNotices ?? [];
  const feedbackMessages =
    input.composerFeedback.shouldShowFeedback &&
    input.composerFeedback.feedbackTone === "blocked"
      ? [
          input.composerFeedback.primaryFeedback,
          ...input.composerFeedback.secondaryFeedback,
        ]
          .map((message) => message.trim())
          .filter(Boolean)
      : [];
  const composerNotice: ChatErrorNotice[] =
    feedbackMessages.length > 0 &&
    !additionalNotices.some(
      (notice) => notice.message.trim() === feedbackMessages[0],
    )
      ? [
          {
            id: "composer-sendability",
            message: feedbackMessages[0],
            details: feedbackMessages.slice(1),
            relatedControl: "composer",
          },
        ]
      : [];

  return [...composerNotice, ...additionalNotices];
}

/** 実行中の会話の Composer Dock 入力を共通の表示側へ変更せずに渡す。 */
export function buildLiveSessionCommonComposerDockInput(
  input: LiveSessionComposerDockPropsInput,
): LiveSessionComposerDockPropsInput {
  return input;
}

/** 実行中の応答の有無を呼び出し側で指定でき、省略時は本文から判断するメッセージ列入力。 */
export type LiveSessionCommonMessageColumnInput = Omit<
  LiveSessionMessageColumnProps,
  "hasLiveRunAssistantText"
> & {
  hasLiveRunAssistantText?: LiveSessionMessageColumnProps["hasLiveRunAssistantText"];
};

/** 応答本文の有無に明示値があれば優先し、省略時だけ実行中の本文の長さで補う。 */
export function buildLiveSessionCommonMessageColumnProps(
  input: LiveSessionCommonMessageColumnInput,
): LiveSessionMessageColumnProps {
  return {
    ...input,
    hasLiveRunAssistantText:
      input.hasLiveRunAssistantText ?? input.liveRunAssistantText.length > 0,
  };
}

/** セッションのコンテキスト入力を、実行中の会話に共通の表示用プロパティへ変換する。 */
export function buildLiveSessionCommonContextPaneProps(
  input: SessionContextPaneProps,
): ReturnType<typeof buildLiveSessionContextPaneProps> {
  return buildLiveSessionContextPaneProps(input);
}
