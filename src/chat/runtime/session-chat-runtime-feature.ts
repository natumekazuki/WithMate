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
  executionOptionsFeedback?: string;
  onDismissExecutionOptionsFeedback?: () => void;
  contextPane?: SessionContextPaneProps;
};

export type SessionChatRuntimeFeature = {
  recoveryActions: ReturnType<typeof buildLiveSessionRecoveryActions>;
  errorNotices: ChatErrorNotice[];
  rightPaneProps?: ReturnType<typeof buildLiveSessionCommonContextPaneProps>;
};

/**
 * 実行時の通知、復旧操作、コンテキスト欄は実行中の Session 用シェルを共有するが、
 * 引き続き実行時機能が管理する。アプリのルートが渡すのは
 * 所有元のコールバックと現在の実行時ビューだけ。
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
    ...(input.executionOptionsFeedback?.trim()
      ? [{
          id: "execution-options",
          message: input.executionOptionsFeedback,
          relatedControl: "composer" as const,
          dismissLabel: "Dismiss execution options error",
          onDismiss: input.onDismissExecutionOptionsFeedback,
        }]
      : []),
  ];

  return {
    recoveryActions: buildLiveSessionRecoveryActions(input.recovery),
    errorNotices: buildLiveSessionErrorNotices({
      composerFeedback: input.composerFeedback,
      additionalNotices,
    }),
    rightPaneProps: input.contextPane ? buildLiveSessionCommonContextPaneProps(input.contextPane) : undefined,
  };
}
