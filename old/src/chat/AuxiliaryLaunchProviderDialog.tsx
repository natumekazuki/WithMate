import { useRef } from "react";

import { useDialogA11y } from "../a11y.js";
import { LaunchDialogFooter, LaunchDialogShell } from "../launch/launch-dialog-shell.js";
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
        <LaunchDialogFooter
          feedback={feedback}
          startButtonLabel={starting ? "Starting..." : "Start Auxiliary"}
          startButtonDisabled={!selectedProviderId || starting}
          onStart={onStart}
          startButtonRef={startButtonRef}
        />
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
