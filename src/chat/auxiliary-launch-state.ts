import type { ModelCatalogProvider } from "../model-catalog.js";

export type AuxiliaryLaunchProviderItem = {
  id: string;
  label: string;
};

export const AUXILIARY_LAUNCH_NO_PROVIDER_FEEDBACK = "有効な Coding Provider がないよ。";
export const AUXILIARY_LAUNCH_NO_SELECTION_FEEDBACK = "有効な Coding Provider を選んでね。";

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
