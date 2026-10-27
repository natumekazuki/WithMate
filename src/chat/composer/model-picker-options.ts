export type ModelPickerOption = {
  value: string;
  label: string;
  sourceLabel?: string;
  disabled?: boolean;
};

const nameCollator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

export function compareModelPickerOptions(a: ModelPickerOption, b: ModelPickerOption): number {
  return nameCollator.compare(a.label, b.label)
    || nameCollator.compare(a.sourceLabel ?? "", b.sourceLabel ?? "")
    || nameCollator.compare(a.value, b.value)
    || a.value.localeCompare(b.value, "en");
}

export function searchModelPickerOptions(options: readonly ModelPickerOption[], query: string): ModelPickerOption[] {
  const term = query.trim().toLocaleLowerCase("en");
  const rank = (option: ModelPickerOption): number => {
    const names = [option.label, option.value].map((text) => text.toLocaleLowerCase("en"));
    if (!term || names.some((text) => text === term)) return 0;
    if (names.some((text) => text.startsWith(term))) return 1;
    if (names.some((text) => text.includes(term))) return 2;
    if (option.sourceLabel?.toLocaleLowerCase("en").includes(term)) return 3;
    return 4;
  };
  return options.map((option) => ({ option, rank: rank(option) }))
    .filter((entry) => entry.rank < 4)
    .sort((a, b) => a.rank - b.rank || compareModelPickerOptions(a.option, b.option))
    .map((entry) => entry.option);
}
