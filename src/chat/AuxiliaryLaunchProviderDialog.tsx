import { useRef } from "react";

import { focusRovingItemByKey, useDialogA11y } from "../a11y.js";

type AuxiliaryLaunchProviderDialogProps = {
  open: boolean;
  providers: Array<{ id: string; label: string }>;
  selectedProviderId: string | null;
  feedback: string;
  starting: boolean;
  onClose: () => void;
  onSelectProvider: (providerId: string) => void;
  onStart: () => void;
};

export function AuxiliaryLaunchProviderDialog({
  open,
  providers,
  selectedProviderId,
  feedback,
  starting,
  onClose,
  onSelectProvider,
  onStart,
}: AuxiliaryLaunchProviderDialogProps) {
  const startButtonRef = useRef<HTMLButtonElement | null>(null);
  const { dialogRef, handleDialogKeyDown } = useDialogA11y<HTMLElement>({
    open,
    onClose,
    initialFocusRef: startButtonRef,
  });

  if (!open) {
    return null;
  }

  return (
    <div className="launch-modal" role="dialog" aria-modal="true" onClick={onClose}>
      <section
        ref={dialogRef}
        className="launch-dialog panel auxiliary-provider-dialog"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={handleDialogKeyDown}
      >
        <div className="launch-dialog-head minimal">
          <button className="diff-close" type="button" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="launch-panel minimal">
          <section className="launch-section minimal">
            <div className="launch-field">
              <label className="launch-field-label" htmlFor="auxiliary-provider-picker">
                Coding Provider
              </label>
              {providers.length > 0 ? (
                <div
                  id="auxiliary-provider-picker"
                  className="choice-list launch-provider-list"
                  role="listbox"
                  aria-label="Coding Provider"
                  aria-orientation="horizontal"
                  onKeyDown={(event) => {
                    focusRovingItemByKey(event, { orientation: "horizontal", activateOnFocus: true });
                  }}
                >
                  {providers.map((provider) => (
                    <button
                      key={provider.id}
                      className={`choice-chip${provider.id === selectedProviderId ? " active" : ""}`}
                      type="button"
                      role="option"
                      aria-selected={provider.id === selectedProviderId}
                      tabIndex={provider.id === selectedProviderId ? 0 : -1}
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
          {feedback ? <p className="launch-feedback">{feedback}</p> : null}
          <button
            ref={startButtonRef}
            className="start-session-button"
            type="button"
            disabled={!selectedProviderId || starting}
            onClick={onStart}
          >
            {starting ? "Starting..." : "Start Auxiliary"}
          </button>
        </div>
      </section>
    </div>
  );
}
