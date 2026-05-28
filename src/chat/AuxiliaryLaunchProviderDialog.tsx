import { useRef } from "react";

import { useDialogA11y } from "../a11y.js";
import { LaunchDialogShell } from "../launch/launch-dialog-shell.js";
import { ProviderLaunchField } from "../launch/provider-launch-picker.js";

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
    <LaunchDialogShell
      onClose={onClose}
      dialogRef={dialogRef}
      onKeyDown={handleDialogKeyDown}
      dialogClassName="auxiliary-provider-dialog"
      footer={
        <>
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
        </>
      }
    >
      <ProviderLaunchField
        fieldId="auxiliary-provider-picker"
        providers={providers}
        selectedProviderId={selectedProviderId}
        onSelectProvider={onSelectProvider}
      />
    </LaunchDialogShell>
  );
}
