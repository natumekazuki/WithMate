import { type ReactNode } from "react";

import { type MessageViewMode } from "../../ui/markdown/MessageRichText.js";
import { useShortcutSettings } from "../../settings/shortcut-settings-context.js";
import { appendShortcutLabel, SHORTCUT_COMMAND_IDS } from "../../settings/shortcut-registry.js";

export type SessionActionDockMode = "prompt" | "terminal";

export function SessionActionDockModeSwitch({ mode, onChange }: {
  mode: SessionActionDockMode;
  onChange(mode: SessionActionDockMode): void;
}) {
  const settings = useShortcutSettings();
  return (
    <div
      className="composer-message-view-mode"
      role="group"
      aria-label="Action dock mode"
      title={appendShortcutLabel("Switch Prompt / Terminal", SHORTCUT_COMMAND_IDS.actionDockToggleMode, undefined, settings)}
    >
      <button
        className="composer-message-view-mode-button"
        type="button"
        aria-pressed={mode === "prompt"}
        onClick={() => onChange("prompt")}
      >
        Prompt
      </button>
      <button
        className="composer-message-view-mode-button"
        type="button"
        aria-pressed={mode === "terminal"}
        onClick={() => onChange("terminal")}
      >
        Terminal
      </button>
    </div>
  );
}

export type SessionActionDockCompactRowProps = {
  isRunning: boolean;
  targetDock?: ReactNode;
  dockModeSwitch?: ReactNode;
  showExpandControl?: boolean;
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
  targetDock = null,
  dockModeSwitch = null,
  showExpandControl = true,
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
      {showExpandControl ? <button
        className="session-action-dock-compact-meta session-action-dock-compact-expand-button"
        type="button"
        onClick={onExpand}
        aria-label="Expand action dock"
        title="Expand action dock"
      >
        {!isRunning && chatNotice ? (
          <span className="session-action-dock-compact-badge attention">{chatNotice}</span>
        ) : null}
      </button> : <span className="session-action-dock-compact-meta" aria-hidden="true" />}
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
            Jump To Latest
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
        {dockModeSwitch}
      </div>
    </div>
  );
}
