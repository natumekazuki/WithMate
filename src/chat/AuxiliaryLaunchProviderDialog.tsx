import { useEffect, useRef } from "react";

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
  checkingCreationResult?: boolean;
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
  checkingCreationResult = false,
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
  const creationBusy = starting || creationInFlight || cancelling;
  const showCancelCreation = canCancelCreation || cancelling;

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    const active = document.activeElement;
    if (dialog && (active === document.body || (active && dialog.contains(active) && active.matches(":disabled")))) {
      dialog.focus();
    }
  }, [open, creationBusy, cancelling, showCancelCreation, providerLoadStatus, dialogRef]);

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
      dialogClassName="auxiliary-provider-dialog auxiliary-launch-dialog"
      dialogTabIndex={-1}
      showDismissControl={false}
      footer={
        <LaunchDialogFooter
          feedback={visibleFeedback}
          reserveFeedbackSpace
          startButtonLabel="Start Auxiliary"
          startButtonDisabled={!resolvedSelectedProviderId || !providerLoadReady || creationBusy}
          startButtonAriaDisabled={!resolvedSelectedProviderId || !providerLoadReady || creationBusy}
          startButtonBusy={creationBusy && !cancelling}
          startButtonLoadingText={checkingCreationResult ? "Checking Auxiliary Creation Result" : "Starting Auxiliary"}
          onStart={onStart}
          startButtonRef={startButtonRef}
          cancelButtonLabel={showCancelCreation ? "Cancel Creation" : undefined}
          onCancel={showCancelCreation ? onCancelCreation : undefined}
          cancelButtonDisabled={cancelling}
          cancelButtonBusy={cancelling}
          cancelButtonLoadingText="Canceling Auxiliary Creation"
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
          disabled={creationBusy}
        />
      </div>
    </LaunchDialogShell>
  );
}
