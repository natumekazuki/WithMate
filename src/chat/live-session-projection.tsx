import type { SessionContextPaneProps, SessionRetryBannerProps } from "../session-components.js";
import {
  buildLiveSessionContextPaneProps,
  type LiveSessionComposerDockPropsInput,
  type LiveSessionMessageColumnProps,
} from "./chat-window-adapter.js";
import { buildLiveSessionRetryBanner } from "./retry-banner-adapter.js";

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
