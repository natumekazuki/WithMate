import { type ReactNode } from "react";

import { type MessageViewMode } from "../../ui/markdown/MessageRichText.js";
import { useShortcutSettings } from "../../settings/shortcut-settings-context.js";
import { appendShortcutLabel, SHORTCUT_COMMAND_IDS } from "../../settings/shortcut-registry.js";
import { ComposerIcon } from "../composer/composer-icon.js";

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
        title="Prompt"
        onClick={() => onChange("prompt")}
      >
        <ComposerIcon name="prompt" />
        <span className="visually-hidden">Prompt</span>
      </button>
      <button
        className="composer-message-view-mode-button"
        type="button"
        aria-pressed={mode === "terminal"}
        title="Terminal"
        onClick={() => onChange("terminal")}
      >
        <ComposerIcon name="terminal" />
        <span className="visually-hidden">Terminal</span>
      </button>
    </div>
  );
}

export type SessionActionDockCompactRowProps = {
  isRunning: boolean;
  isCanceling?: boolean;
  targetDock?: ReactNode;
  dockModeSwitch?: ReactNode;
  providerQuota?: ReactNode;
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
  isCanceling = false,
  targetDock = null,
  dockModeSwitch = null,
  providerQuota = null,
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
    <div className={`session-action-dock-compact-row${isRunning ? " running" : ""}${providerQuota ? " has-provider-quota" : ""}`}>
      {providerQuota ? <div className="session-provider-quota-slot" onClick={(event) => event.stopPropagation()}>{providerQuota}</div> : null}
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
              className="danger session-send-button composer-icon-button"
              type="button"
              onClick={onCancel}
              title={isCanceling ? "Canceling" : cancelButtonTitle || "Cancel"}
              disabled={isCanceling}
              aria-busy={isCanceling || undefined}
            >
              {isCanceling ? <span className="loading-indicator-spinner" aria-hidden="true" /> : <ComposerIcon name="stop" />}
              <span className="visually-hidden">{isCanceling ? "Canceling" : "Cancel"}</span>
            </button>
        ) : null}
        </div>
        {targetDock ? <div className="session-action-dock-target-slot">{targetDock}</div> : null}
        {isRunning && chatNotice ? (
          <span className="session-action-dock-compact-badge attention">{chatNotice}</span>
        ) : null}
        {showJumpToBottom ? (
          <button
            className="drawer-toggle compact secondary message-jump-bottom-button composer-icon-button"
            type="button"
            title="Jump To Latest"
            onClick={onJumpToBottom}
          >
            <ComposerIcon name="jump-bottom" />
            <span className="visually-hidden">Jump To Latest</span>
          </button>
        ) : null}
        {showMessageViewModeControls ? (
          <div className="composer-message-view-mode" role="group" aria-label="Message display mode">
            <button
              className="composer-message-view-mode-button"
              type="button"
              aria-pressed={messageViewMode === "preview"}
              title="Preview"
              onClick={() => onMessageViewModeChange("preview")}
            >
              <ComposerIcon name="preview" />
              <span className="visually-hidden">Preview</span>
            </button>
            <button
              className="composer-message-view-mode-button"
              type="button"
              aria-pressed={messageViewMode === "source"}
              title="Source"
              onClick={() => onMessageViewModeChange("source")}
            >
              <ComposerIcon name="source" />
              <span className="visually-hidden">Source</span>
            </button>
          </div>
          ) : null}
        {dockModeSwitch}
      </div>
    </div>
  );
}
