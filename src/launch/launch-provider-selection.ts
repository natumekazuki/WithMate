/** 現在の選択が候補に残っていれば維持し、なければ先頭を、候補が空なら null を返す。 */
export function resolveSelectedLaunchProviderId<
  TProvider extends { id: string },
>(
  providers: readonly TProvider[],
  selectedProviderId: string | null | undefined,
): string | null {
  return (
    providers.find((provider) => provider.id === selectedProviderId)?.id ??
    providers.at(0)?.id ??
    null
  );
}

/** 起動時の下書きに使う選択を解決し、選べる候補がなければ空文字列にする。 */
export function resolveSelectedLaunchProviderDraftId<
  TProvider extends { id: string },
>(
  providers: readonly TProvider[],
  selectedProviderId: string | null | undefined,
): string {
  return resolveSelectedLaunchProviderId(providers, selectedProviderId) ?? "";
}
