export function resolveSelectedLaunchProviderId<TProvider extends { id: string }>(
  providers: readonly TProvider[],
  selectedProviderId: string | null | undefined,
): string | null {
  return providers.find((provider) => provider.id === selectedProviderId)?.id ?? providers.at(0)?.id ?? null;
}

export function resolveSelectedLaunchProviderDraftId<TProvider extends { id: string }>(
  providers: readonly TProvider[],
  selectedProviderId: string | null | undefined,
): string {
  return resolveSelectedLaunchProviderId(providers, selectedProviderId) ?? "";
}
