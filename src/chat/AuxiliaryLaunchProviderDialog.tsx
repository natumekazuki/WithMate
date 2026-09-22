import { useRef } from "react";

import { useDialogA11y } from "../ui/a11y.js";
import { LaunchDialogFooter, LaunchDialogShell } from "../launch/launch-dialog-shell.js";
import { ProviderLaunchPicker } from "../launch/provider-launch-picker.js";

type AuxiliaryLaunchProviderDialogProps = {
  open: boolean;
  providers: Array<{ id: string; label: string }>;
  selectedProviderId: string | null;
  feedback: string;
  starting: boolean;
  creationInFlight?: boolean;
  cancelling?: boolean;
  canCancelCreation?: boolean;
  onClose: () => void;
  onCancelCreation?: () => void;
  onSelectProvider: (providerId: string) => void;
  onStart: () => void;
};

export function AuxiliaryLaunchProviderDialog({
  open,
  providers,
  selectedProviderId,
  feedback,
  starting,
  creationInFlight = false,
  cancelling = false,
  canCancelCreation = false,
  onClose,
  onCancelCreation,
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
      showDismissControl={false}
      footer={
        <LaunchDialogFooter
          feedback={feedback}
          startButtonLabel="StartAuxiliary"
          startButtonDisabled={!selectedProviderId || starting || creationInFlight}
          startButtonBusy={starting || creationInFlight}
          startButtonLoadingText="StartingAuxiliary"
          onStart={onStart}
          startButtonRef={startButtonRef}
          cancelButtonLabel={canCancelCreation ? "CancelCreation" : undefined}
          onCancel={canCancelCreation ? onCancelCreation : undefined}
          cancelButtonDisabled={cancelling}
        />
      }
    >
      <div className="launch-field">
        <label className="launch-field-label" htmlFor="auxiliary-provider-picker">
          CodingProvider
        </label>
        <ProviderLaunchPicker
          id="auxiliary-provider-picker"
          providers={providers}
          selectedProviderId={selectedProviderId}
          onSelectProvider={onSelectProvider}
        />
      </div>
    </LaunchDialogShell>
  );
}
