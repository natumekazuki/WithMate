import { useState } from "react";

import {
  type AuxiliaryLaunchProviderItem,
  applyAuxiliaryLaunchDialogState,
  resolveAuxiliaryLaunchCloseState,
  resolveAuxiliaryLaunchFeedbackResetState,
  resolveAuxiliaryLaunchOpenState,
  resolveAuxiliaryLaunchProviderSelectionState,
  resolveAuxiliaryLaunchStartErrorState,
} from "./auxiliary-launch-state.js";

type OpenAuxiliaryLaunchDialogParams = {
  providers: readonly AuxiliaryLaunchProviderItem[];
  selectedProviderId: string | null | undefined;
};

export function useAuxiliaryLaunchDialogState() {
  const [open, setOpen] = useState(false);
  const [providerId, setProviderId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState("");

  const openDialog = ({ providers, selectedProviderId }: OpenAuxiliaryLaunchDialogParams) => {
    const state = resolveAuxiliaryLaunchOpenState(providers, selectedProviderId);
    applyAuxiliaryLaunchDialogState(setOpen, setProviderId, setFeedback, state);
  };

  const closeDialog = () => {
    applyAuxiliaryLaunchDialogState(setOpen, setProviderId, setFeedback, resolveAuxiliaryLaunchCloseState());
  };

  const selectProvider = (nextProviderId: string) => {
    const state = resolveAuxiliaryLaunchProviderSelectionState(nextProviderId);
    applyAuxiliaryLaunchDialogState(setOpen, setProviderId, setFeedback, state);
  };

  const resetFeedback = () => {
    applyAuxiliaryLaunchDialogState(setOpen, setProviderId, setFeedback, resolveAuxiliaryLaunchFeedbackResetState());
  };

  const setStartError = (error: unknown) => {
    applyAuxiliaryLaunchDialogState(setOpen, setProviderId, setFeedback, resolveAuxiliaryLaunchStartErrorState(error));
  };

  return {
    auxiliaryLaunchDialogOpen: open,
    auxiliaryLaunchProviderId: providerId,
    auxiliaryLaunchFeedback: feedback,
    openAuxiliaryLaunchDialog: openDialog,
    closeAuxiliaryLaunchDialog: closeDialog,
    selectAuxiliaryLaunchProvider: selectProvider,
    resetAuxiliaryLaunchFeedback: resetFeedback,
    setAuxiliaryLaunchStartError: setStartError,
  } as const;
}

