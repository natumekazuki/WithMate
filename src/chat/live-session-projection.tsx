import type { SessionContextPaneProps, SessionRetryBannerProps } from "../session-components.js";
import {
  buildLiveSessionContextPaneProps,
  type LiveSessionComposerDockPropsInput,
  type LiveSessionMessageColumnProps,
} from "./chat-window-adapter.js";
import { buildLiveSessionRetryBanner } from "./retry-banner-adapter.js";
import type { ChatErrorNotice } from "./chat-window.js";

export type LiveSessionRecoveryActionsInput = {
  retryBanner: SessionRetryBannerProps["retryBanner"];
  isRetryActionDisabled: boolean;
  isRetryEditDisabled: boolean;
  isRetryDraftReplacePending: boolean;
  onResendLastMessage: () => void;
  onEditLastMessage: () => void;
  onConfirmRetryDraftReplace: () => void;
  onCancelRetryDraftReplace: () => void;
};

export function buildLiveSessionRecoveryActions(input: LiveSessionRecoveryActionsInput) {
  return buildLiveSessionRetryBanner(input);
}

export function buildLiveSessionErrorNotices(input: {
  composerFeedback: {
    primaryFeedback: string;
    secondaryFeedback: readonly string[];
    shouldShowFeedback: boolean;
  };
  additionalNotices?: readonly ChatErrorNotice[];
}): ChatErrorNotice[] {
  const feedbackMessages = input.composerFeedback.shouldShowFeedback
    ? [input.composerFeedback.primaryFeedback, ...input.composerFeedback.secondaryFeedback]
      .map((message) => message.trim())
      .filter(Boolean)
    : [];
  const composerNotice: ChatErrorNotice[] = feedbackMessages.length > 0
    ? [{
        id: "composer-sendability",
        message: feedbackMessages[0],
        details: feedbackMessages.slice(1),
        relatedControl: "composer",
      }]
    : [];

  return [...composerNotice, ...(input.additionalNotices ?? [])];
}

export function buildLiveSessionCommonComposerDockInput(
  input: LiveSessionComposerDockPropsInput,
): LiveSessionComposerDockPropsInput {
  return input;
}

export type LiveSessionCommonMessageColumnInput = Omit<
  LiveSessionMessageColumnProps,
  "hasLiveRunAssistantText"
> & {
  hasLiveRunAssistantText?: LiveSessionMessageColumnProps["hasLiveRunAssistantText"];
};

export function buildLiveSessionCommonMessageColumnProps(
  input: LiveSessionCommonMessageColumnInput,
): LiveSessionMessageColumnProps {
  return {
    ...input,
    hasLiveRunAssistantText: input.hasLiveRunAssistantText ?? input.liveRunAssistantText.length > 0,
  };
}

export function buildLiveSessionCommonContextPaneProps(
  input: SessionContextPaneProps,
): ReturnType<typeof buildLiveSessionContextPaneProps> {
  return buildLiveSessionContextPaneProps(input);
}
