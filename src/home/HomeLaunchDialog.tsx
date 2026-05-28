import { useRef } from "react";

import { focusRovingItemByKey, useDialogA11y } from "../a11y.js";
import { LaunchDialogFooter, LaunchDialogShell } from "../launch/launch-dialog-shell.js";
import { ProviderLaunchField } from "../launch/provider-launch-picker.js";
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
    <LaunchDialogShell
      onClose={onClose}
      dialogRef={dialogRef}
      onKeyDown={handleDialogKeyDown}
      footer={
        <LaunchDialogFooter
          feedback={launchFeedback}
          startButtonLabel={
            launchStarting
              ? "Starting..."
              : mode === "mate-talk"
                ? "Start MateTalk"
                : mode === "companion"
                  ? "Start Companion"
                  : "Start New Session"
          }
          startButtonDisabled={!canStartSession || launchStarting}
          startButtonAriaDisabled={!canStartSession || launchStarting}
          onStart={() => onStartSession(mode)}
        />
      }
    >
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

      <ProviderLaunchField
        fieldId="launch-provider-picker"
        providers={enabledLaunchProviders}
        selectedProviderId={selectedLaunchProviderId}
        onSelectProvider={onSelectProvider}
      />
    </LaunchDialogShell>
  );
}
