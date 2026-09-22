import type { ChatErrorNotice } from "../chat-window.js";
import type { SessionContextPaneProps } from "../shell/session-context-pane.js";
import {
  buildLiveSessionCommonContextPaneProps,
  buildLiveSessionErrorNotices,
  buildLiveSessionRecoveryActions,
  type LiveSessionRecoveryActionsInput,
} from "../live-session-projection.js";

type ComposerFeedback = Parameters<typeof buildLiveSessionErrorNotices>[0]["composerFeedback"];

export type SessionChatRuntimeFeatureInput = {
  recovery: LiveSessionRecoveryActionsInput;
  composerFeedback: ComposerFeedback;
  workspaceAvailabilityMessage: string;
  isWorkspaceAvailabilityCheckPending: boolean;
  onRecheckWorkspaceAvailability: () => void;
  inlinePathFeedback: string;
  onDismissInlinePathFeedback: () => void;
  contextPane: SessionContextPaneProps;
};

export type SessionChatRuntimeFeature = {
  recoveryActions: ReturnType<typeof buildLiveSessionRecoveryActions>;
  errorNotices: ChatErrorNotice[];
  rightPaneProps: ReturnType<typeof buildLiveSessionCommonContextPaneProps>;
};

/**
 * Runtime feedback, recovery, and the context rail share the live-session
 * shell but remain owned by the runtime feature. The app root only supplies
 * the owner callbacks and the current runtime view.
 */
export function buildSessionChatRuntimeFeature(
  input: SessionChatRuntimeFeatureInput,
): SessionChatRuntimeFeature {
  const additionalNotices: ChatErrorNotice[] = [
    ...(input.workspaceAvailabilityMessage.trim()
      ? [{
          id: "workspace-unavailable",
          message: input.workspaceAvailabilityMessage,
          relatedControl: "composer" as const,
          actionLabel: "Recheck",
          isActionDisabled: input.isWorkspaceAvailabilityCheckPending,
          onAction: input.onRecheckWorkspaceAvailability,
        }]
      : []),
    ...(input.inlinePathFeedback.trim()
      ? [{
          id: "inline-path-open",
          message: input.inlinePathFeedback,
          dismissLabel: "Dismiss path result",
          onDismiss: input.onDismissInlinePathFeedback,
        }]
      : []),
  ];

  return {
    recoveryActions: buildLiveSessionRecoveryActions(input.recovery),
    errorNotices: buildLiveSessionErrorNotices({
      composerFeedback: input.composerFeedback,
      additionalNotices,
    }),
    rightPaneProps: buildLiveSessionCommonContextPaneProps(input.contextPane),
  };
}
