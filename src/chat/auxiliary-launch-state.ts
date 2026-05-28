import type { ModelCatalogProvider } from "../model-catalog.js";
import { LAUNCH_EMPTY_PROVIDER_MESSAGE, LAUNCH_NO_PROVIDER_SELECTED_MESSAGE } from "../launch/launch-feedback.js";

export type AuxiliaryLaunchProviderItem = {
  id: string;
  label: string;
};

export const AUXILIARY_LAUNCH_NO_PROVIDER_FEEDBACK = LAUNCH_EMPTY_PROVIDER_MESSAGE;
export const AUXILIARY_LAUNCH_NO_SELECTION_FEEDBACK = LAUNCH_NO_PROVIDER_SELECTED_MESSAGE;

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
  if (!providers.length) {
    return null;
  }

  return providers.find((provider) => provider.id === selectedProviderId)?.id ?? providers[0]!.id;
}
