import type { ChatWindowProps } from "./chat-window.js";
import { buildLiveSessionWindowShellProps } from "./live-session-window-props.js";
import type { SessionComposerFeatureSurface } from "./composer/use-session-composer-feature.js";
import type { SessionChatConversationFeature } from "./conversation/session-chat-conversation-feature.js";
import type { SessionChatRuntimeFeature } from "./runtime/session-chat-runtime-feature.js";
import type { SessionChatShellFeature } from "./shell/session-chat-shell-feature.js";
import type { SessionHeaderProps } from "./shell/session-header.js";

export type SessionChatWindowFeatures = {
  shell: SessionChatShellFeature;
  header: SessionHeaderProps;
  composer: SessionComposerFeatureSurface;
  conversation: SessionChatConversationFeature;
  runtime: SessionChatRuntimeFeature;
};

/**
 * Thin wiring entry for the shared chat shell. Each feature has already
 * projected its own state and operations before reaching this function.
 */
export function composeAgentSessionChatWindow(
  features: SessionChatWindowFeatures,
): ChatWindowProps {
  return buildLiveSessionWindowShellProps({
    ...features.shell,
    headerProps: features.header,
    messageColumnProps: features.conversation,
    errorNotices: features.runtime.errorNotices,
    recoveryActions: features.runtime.recoveryActions,
    composerProps: features.composer.composer,
    compactActionDockProps: features.composer.compactActionDock,
    additionalDirectoryListProps: features.composer.additionalDirectoryListProps,
    skillPickerProps: features.composer.skillPickerProps,
    rightPaneProps: features.runtime.rightPaneProps,
  });
}
