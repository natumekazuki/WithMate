import { useRef } from "react";

import { useDialogA11y } from "../a11y.js";
import { ProviderLaunchPicker } from "../launch/provider-launch-picker.js";

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
              <ProviderLaunchPicker
                id="auxiliary-provider-picker"
                providers={providers}
                selectedProviderId={selectedProviderId}
                onSelectProvider={onSelectProvider}
              />
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
