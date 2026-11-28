/** モデル候補の値と表示名。候補元の表示名も検索に使える。 */
export type ModelPickerOption = {
  value: string;
  label: string;
  sourceLabel?: string;
  disabled?: boolean;
};

const nameCollator = new Intl.Collator("en", {
  numeric: true,
  sensitivity: "base",
});

/** 候補を表示名・候補元・値の順で自然順に比較し、同点なら値の文字列で順序を決める。 */
export function compareModelPickerOptions(
  a: ModelPickerOption,
  b: ModelPickerOption,
): number {
  return (
    nameCollator.compare(a.label, b.label) ||
    nameCollator.compare(a.sourceLabel ?? "", b.sourceLabel ?? "") ||
    nameCollator.compare(a.value, b.value) ||
    a.value.localeCompare(b.value, "en")
  );
}

/** 検索語に一致する候補だけを返し、一致度が同じ場合は共通の候補順を使う。 */
export function searchModelPickerOptions<T extends ModelPickerOption>(
  options: readonly T[],
  query: string,
): T[] {
  const term = query.trim().toLocaleLowerCase("en");
  /** 名前・ID の完全一致、前方一致、部分一致、候補元の一致の順に優先する。 */
  const rank = (option: ModelPickerOption): number => {
    const names = [option.label, option.value].map((text) =>
      text.toLocaleLowerCase("en"),
    );
    if (!term || names.some((text) => text === term)) return 0;
    if (names.some((text) => text.startsWith(term))) return 1;
    if (names.some((text) => text.includes(term))) return 2;
    if (option.sourceLabel?.toLocaleLowerCase("en").includes(term)) return 3;
    return 4;
  };
  return options
    .map((option) => ({ option, rank: rank(option) }))
    .filter((entry) => entry.rank < 4)
    .sort(
      (a, b) =>
        a.rank - b.rank || compareModelPickerOptions(a.option, b.option),
    )
    .map((entry) => entry.option);
}
