import { type ReactNode } from "react";

import { type MessageViewMode } from "../../ui/markdown/MessageRichText.js";

import { PendingRunIndicator } from "../runtime/pending-run-indicator.js";

export type SessionActionDockCompactRowProps = {
  isRunning: boolean;
  pendingRunIndicatorAnnouncement?: string;
  pendingRunIndicatorText?: string;
  pendingRunIndicatorTextVisible?: boolean;
  pendingRunIndicatorAnnounce?: boolean;
  targetDock?: ReactNode;
  chatNotice?: string;
  showJumpToBottom: boolean;
  showMessageViewModeControls?: boolean;
  messageViewMode?: MessageViewMode;
  cancelButtonTitle?: string;
  onExpand: () => void;
  onJumpToBottom: () => void;
  onCancel: () => void;
  onMessageViewModeChange?: (mode: MessageViewMode) => void;
};

export function SessionActionDockCompactRow({
  isRunning,
  pendingRunIndicatorAnnouncement,
  pendingRunIndicatorText,
  pendingRunIndicatorAnnounce = true,
  targetDock = null,
  chatNotice,
  showJumpToBottom,
  showMessageViewModeControls = false,
  messageViewMode = "preview",
  cancelButtonTitle,
  onExpand,
  onJumpToBottom,
  onCancel,
  onMessageViewModeChange = () => {},
}: SessionActionDockCompactRowProps) {
  return (
    <div className={`session-action-dock-compact-row${isRunning ? " running" : ""}`}>
      {isRunning ? (
        <button
          className="session-action-dock-compact-progress session-action-dock-compact-progress-button"
          type="button"
          onClick={onExpand}
          aria-label="Expand action dock"
          title="Expand action dock"
        >
          <PendingRunIndicator
            announcement={pendingRunIndicatorAnnouncement}
            text={pendingRunIndicatorText}
            showText={false}
            announce={pendingRunIndicatorAnnounce}
          />
        </button>
      ) : (
        <button
          className="session-action-dock-compact-meta session-action-dock-compact-expand-button"
          type="button"
          onClick={onExpand}
          aria-label="Expand action dock"
          title="Expand action dock"
        >
          {chatNotice ? <span className="session-action-dock-compact-badge attention">{chatNotice}</span> : null}
        </button>
      )}
      <div className="session-action-dock-compact-actions">
        <div
          className={`session-action-dock-cancel-slot${isRunning ? " is-active" : ""}`}
          aria-hidden={isRunning ? undefined : true}
        >
          {isRunning ? (
            <button
              className="danger session-send-button"
              type="button"
              onClick={onCancel}
              title={cancelButtonTitle}
            >
              Cancel
            </button>
          ) : null}
        </div>
        {targetDock ? <div className="session-action-dock-target-slot">{targetDock}</div> : null}
        {isRunning && chatNotice ? (
          <span className="session-action-dock-compact-badge attention">{chatNotice}</span>
        ) : null}
        {showJumpToBottom ? (
          <button
            className="drawer-toggle compact secondary message-jump-bottom-button"
            type="button"
            onClick={onJumpToBottom}
          >
            JumpToLatest
          </button>
        ) : null}
        {showMessageViewModeControls ? (
          <div className="composer-message-view-mode" role="group" aria-label="Message display mode">
            <button
              className="composer-message-view-mode-button"
              type="button"
              aria-pressed={messageViewMode === "preview"}
              onClick={() => onMessageViewModeChange("preview")}
            >
              Preview
            </button>
            <button
              className="composer-message-view-mode-button"
              type="button"
              aria-pressed={messageViewMode === "source"}
              onClick={() => onMessageViewModeChange("source")}
            >
              Source
            </button>
          </div>
          ) : null}
      </div>
    </div>
  );
}
