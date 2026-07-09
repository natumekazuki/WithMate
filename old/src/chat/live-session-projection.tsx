import type { SessionContextPaneProps, SessionRetryBannerProps } from "../session-components.js";
import {
  buildLiveSessionContextPaneProps,
  type LiveSessionComposerDockPropsInput,
  type LiveSessionMessageColumnProps,
} from "./chat-window-adapter.js";
import { buildLiveSessionRetryBanner } from "./retry-banner-adapter.js";

export type LiveSessionCommonComposerDockInput = Omit<LiveSessionComposerDockPropsInput, "retryBanner"> & {
  retryBanner: SessionRetryBannerProps["retryBanner"];
  isRetryDetailsOpen: boolean;
  isRetryActionDisabled: boolean;
  isRetryEditDisabled: boolean;
  isRetryDraftReplacePending: boolean;
  onToggleDetails: () => void;
  onResendLastMessage: () => void;
  onEditLastMessage: () => void;
  onConfirmRetryDraftReplace: () => void;
  onCancelRetryDraftReplace: () => void;
  onOpenPath: (target: string) => void;
};

export function buildLiveSessionCommonComposerDockInput(
  input: LiveSessionCommonComposerDockInput,
): LiveSessionComposerDockPropsInput {
  const {
    retryBanner,
    isRetryDetailsOpen,
    isRetryActionDisabled,
    isRetryEditDisabled,
    isRetryDraftReplacePending,
    onToggleDetails,
    onResendLastMessage,
    onEditLastMessage,
    onConfirmRetryDraftReplace,
    onCancelRetryDraftReplace,
    onOpenPath,
    ...composerInput
  } = input;

  return {
    ...composerInput,
    retryBanner: buildLiveSessionRetryBanner({
      retryBanner,
      isRetryDetailsOpen,
      isRetryActionDisabled,
      isRetryEditDisabled,
      isRetryDraftReplacePending,
      onToggleDetails,
      onResendLastMessage,
      onEditLastMessage,
      onConfirmRetryDraftReplace,
      onCancelRetryDraftReplace,
      onOpenPath,
    }),
  };
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
