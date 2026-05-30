import type { ModelCatalogProvider } from "../model-catalog.js";
import { resolveSelectedLaunchProviderId } from "../launch/launch-provider-selection.js";
import { LAUNCH_EMPTY_PROVIDER_MESSAGE, LAUNCH_NO_PROVIDER_SELECTED_MESSAGE } from "../launch/launch-feedback.js";

export type AuxiliaryLaunchProviderItem = {
  id: string;
  label: string;
};

export const AUXILIARY_LAUNCH_NO_PROVIDER_FEEDBACK = LAUNCH_EMPTY_PROVIDER_MESSAGE;
export const AUXILIARY_LAUNCH_NO_SELECTION_FEEDBACK = LAUNCH_NO_PROVIDER_SELECTED_MESSAGE;
export const AUXILIARY_LAUNCH_START_FAILED_FEEDBACK = "Auxiliary Session の開始に失敗したよ。";

export function buildAuxiliaryLaunchProviderItems(
  providers: readonly ModelCatalogProvider[],
  canUseProvider: (provider: ModelCatalogProvider) => boolean,
): AuxiliaryLaunchProviderItem[] {
  return providers.filter(canUseProvider).map((provider) => ({ id: provider.id, label: provider.label }));
}

export function resolveAuxiliaryLaunchProviderId(
  providers: readonly AuxiliaryLaunchProviderItem[],
  selectedProviderId: string | null | undefined,
): string | null {
  return resolveSelectedLaunchProviderId(providers, selectedProviderId);
}

export type AuxiliaryLaunchInitialState = {
  providerId: string | null;
  feedback: string;
};

export function resolveAuxiliaryLaunchCloseState(): { open: false; feedback: string } {
  return {
    open: false,
    feedback: "",
  };
}

export function resolveAuxiliaryLaunchProviderSelectionState(
  providerId: string | null,
): { providerId: string | null; feedback: string } {
  return {
    providerId,
    feedback: "",
  };
}

export type AuxiliaryLaunchDialogStatePatch = {
  open?: boolean;
  providerId?: string | null;
  feedback?: string;
};

export function resolveAuxiliaryLaunchOpenState(
  providers: readonly AuxiliaryLaunchProviderItem[],
  selectedProviderId: string | null | undefined,
): AuxiliaryLaunchDialogStatePatch {
  const initial = resolveAuxiliaryLaunchInitialState(providers, selectedProviderId);
  return {
    open: true,
    providerId: initial.providerId,
    feedback: initial.feedback,
  };
}

export function resolveAuxiliaryLaunchFeedbackResetState(): Pick<AuxiliaryLaunchDialogStatePatch, "feedback"> {
  return {
    feedback: "",
  };
}

export function resolveAuxiliaryLaunchStartErrorState(
  error: unknown,
): Pick<AuxiliaryLaunchDialogStatePatch, "feedback"> {
  return {
    feedback: resolveAuxiliaryLaunchStartErrorFeedback(error),
  };
}

export function applyAuxiliaryLaunchDialogState(
  setOpen: (next: boolean) => void,
  setProviderId: (next: string | null) => void,
  setFeedback: (next: string) => void,
  state: AuxiliaryLaunchDialogStatePatch,
): void {
  if (state.open !== undefined) {
    setOpen(state.open);
  }
  if (state.providerId !== undefined) {
    setProviderId(state.providerId);
  }
  if (state.feedback !== undefined) {
    setFeedback(state.feedback);
  }
}

export function resolveAuxiliaryLaunchStartErrorFeedback(error: unknown): string {
  return error instanceof Error ? error.message : AUXILIARY_LAUNCH_START_FAILED_FEEDBACK;
}

export function resolveAuxiliaryLaunchInitialState(
  providers: readonly AuxiliaryLaunchProviderItem[],
  selectedProviderId: string | null | undefined,
): AuxiliaryLaunchInitialState {
  const providerId = resolveAuxiliaryLaunchProviderId(providers, selectedProviderId);
  return {
    providerId,
    feedback: providerId ? "" : AUXILIARY_LAUNCH_NO_PROVIDER_FEEDBACK,
  };
}
