import { useRef } from "react";

import { focusRovingItemByKey, useDialogA11y } from "../a11y.js";
import type { LaunchWorkspace } from "./home-launch-projection.js";

export type HomeLaunchDialogProps = {
  open: boolean;
  mode: "session" | "companion" | "mate-talk";
  title: string;
  workspace: LaunchWorkspace | null;
  launchWorkspacePathLabel: string;
  enabledLaunchProviders: Array<{ id: string; label: string }>;
  selectedLaunchProviderId: string | null;
  canStartSession: boolean;
  launchFeedback: string;
  launchStarting: boolean;
  onClose: () => void;
  onSelectMode: (mode: "session" | "companion" | "mate-talk") => void;
  onChangeTitle: (value: string) => void;
  onBrowseWorkspace: () => void;
  onSelectProvider: (providerId: string) => void;
  onStartSession: (mode: "session" | "companion" | "mate-talk") => void;
};

export function HomeLaunchDialog({
  open,
  mode,
  title,
  workspace,
  launchWorkspacePathLabel,
  enabledLaunchProviders,
  selectedLaunchProviderId,
  canStartSession,
  launchFeedback,
  launchStarting,
  onClose,
  onSelectMode,
  onChangeTitle,
  onBrowseWorkspace,
  onSelectProvider,
  onStartSession,
}: HomeLaunchDialogProps) {
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const { dialogRef, handleDialogKeyDown } = useDialogA11y<HTMLElement>({
    open,
    onClose,
    initialFocusRef: titleInputRef,
  });

  if (!open) {
    return null;
  }
  const isMateTalkMode = mode === "mate-talk";

  return (
    <div className="launch-modal" role="dialog" aria-modal="true" onClick={onClose}>
      <section
        ref={dialogRef}
        className="launch-dialog panel"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={handleDialogKeyDown}
      >
        <div className="launch-dialog-head minimal">
          <button className="diff-close" type="button" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="launch-panel minimal">
          {!isMateTalkMode ? (
          <section className="launch-section minimal">
            <div
              className="choice-list launch-provider-list"
              role="tablist"
              aria-label="Session mode"
              onKeyDown={(event) => {
                focusRovingItemByKey(event, { orientation: "horizontal", activateOnFocus: true });
              }}
            >
              {[
                { value: "session" as const, label: "Agent Mode" },
                { value: "companion" as const, label: "Companion Mode" },
              ].map((option) => (
                <button
                  key={option.value}
                  className={`choice-chip${mode === option.value ? " active" : ""}`}
                  type="button"
                  role="tab"
                  aria-selected={mode === option.value}
                  tabIndex={mode === option.value ? 0 : -1}
                  onClick={() => onSelectMode(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </section>
          ) : null}

          {!isMateTalkMode ? (
          <section className="launch-section minimal">
            <div className="launch-field">
              <label className="launch-field-label" htmlFor="launch-session-title">
                セッションタイトル
              </label>
              <input
                id="launch-session-title"
                ref={titleInputRef}
                className="launch-field-input"
                type="text"
                value={title}
                onChange={(event) => onChangeTitle(event.target.value)}
              />
            </div>
          </section>
          ) : null}

          {!isMateTalkMode ? (
          <section className="launch-section workspace-picker minimal">
            <div className="section-head compact-actions">
              <button className="browse-button" type="button" onClick={onBrowseWorkspace}>
                Browse
              </button>
            </div>
            <p className={`launch-path${workspace ? " selected" : ""}`}>{launchWorkspacePathLabel}</p>
          </section>
          ) : null}

          <section className="launch-section minimal">
            <div className="launch-field">
              <label className="launch-field-label" htmlFor="launch-provider-picker">
                Coding Provider
              </label>
              {enabledLaunchProviders.length > 0 ? (
                <div
                  id="launch-provider-picker"
                  className="choice-list launch-provider-list"
                  role="listbox"
                  aria-label="Coding Provider"
                  aria-orientation="horizontal"
                  onKeyDown={(event) => {
                    focusRovingItemByKey(event, { orientation: "horizontal", activateOnFocus: true });
                  }}
                >
                  {enabledLaunchProviders.map((provider) => (
                    <button
                      key={provider.id}
                      className={`choice-chip${provider.id === selectedLaunchProviderId ? " active" : ""}`}
                      type="button"
                      role="option"
                      aria-selected={provider.id === selectedLaunchProviderId}
                      tabIndex={provider.id === selectedLaunchProviderId ? 0 : -1}
                      onClick={() => onSelectProvider(provider.id)}
                    >
                      {provider.label}
                    </button>
                  ))}
                </div>
              ) : (
                <article className="empty-list-card compact">
                  <p>有効な Coding Provider がないよ。</p>
                </article>
              )}
            </div>
          </section>
        </div>

        <div className="launch-dialog-foot minimal">
          {launchFeedback ? <p className="launch-feedback">{launchFeedback}</p> : null}
          <button
            className="start-session-button"
            type="button"
            aria-disabled={!canStartSession || launchStarting}
            disabled={!canStartSession || launchStarting}
            onClick={() => onStartSession(mode)}
          >
            {launchStarting ? "Starting..." : mode === "mate-talk" ? "Start MateTalk" : mode === "companion" ? "Start Companion" : "Start New Session"}
          </button>
        </div>
      </section>
    </div>
  );
}
