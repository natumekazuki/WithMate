import { useRef } from "react";

import { useDialogA11y } from "../ui/a11y.js";
import { LaunchDialogFooter, LaunchDialogShell } from "../launch/launch-dialog-shell.js";
import { ProviderLaunchPicker, type ProviderLaunchLoadStatus } from "../launch/provider-launch-picker.js";
import {
  AUXILIARY_LAUNCH_NO_PROVIDER_FEEDBACK,
  resolveAuxiliaryLaunchProviderId,
} from "./auxiliary-launch-state.js";

type AuxiliaryLaunchProviderDialogProps = {
  open: boolean;
  providers: Array<{ id: string; label: string }>;
  selectedProviderId: string | null;
  providerLoadStatus?: ProviderLaunchLoadStatus;
  providerLoadError?: string;
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
  providerLoadStatus = "loaded",
  providerLoadError = "",
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

  const resolvedSelectedProviderId = resolveAuxiliaryLaunchProviderId(providers, selectedProviderId);
  const providerLoadReady = providerLoadStatus === "loaded";
  const visibleFeedback = providerLoadReady && feedback !== AUXILIARY_LAUNCH_NO_PROVIDER_FEEDBACK
    ? feedback
    : "";

  return (
    <LaunchDialogShell
      onClose={onClose}
      dialogRef={dialogRef}
      onKeyDown={handleDialogKeyDown}
      ariaLabel="Start Auxiliary"
      dialogClassName="auxiliary-provider-dialog"
      showDismissControl={false}
      footer={
        <LaunchDialogFooter
          feedback={visibleFeedback}
          startButtonLabel="Start Auxiliary"
          startButtonDisabled={!resolvedSelectedProviderId || !providerLoadReady || starting || creationInFlight}
          startButtonAriaDisabled={!resolvedSelectedProviderId || !providerLoadReady || starting || creationInFlight}
          startButtonBusy={starting || creationInFlight}
          startButtonLoadingText="Starting Auxiliary"
          onStart={onStart}
          startButtonRef={startButtonRef}
          cancelButtonLabel={canCancelCreation ? "Cancel Creation" : undefined}
          onCancel={canCancelCreation ? onCancelCreation : undefined}
          cancelButtonDisabled={cancelling}
        />
      }
    >
      <div className="launch-field">
        <label className="launch-field-label" htmlFor="auxiliary-provider-picker">
          Coding Provider
        </label>
        <ProviderLaunchPicker
          id="auxiliary-provider-picker"
          providers={providers}
          selectedProviderId={resolvedSelectedProviderId}
          onSelectProvider={onSelectProvider}
          loadStatus={providerLoadStatus}
          loadError={providerLoadError}
        />
      </div>
    </LaunchDialogShell>
  );
}
