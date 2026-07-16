import path from "node:path";

export function normalizeAllowedAdditionalDirectories(directories: readonly string[]): readonly string[] | undefined {
  const normalized = directories.map((value) => {
    if (!isHostFullyQualifiedPath(value)) return undefined;
    const normalizedValue = stripTrailingSeparators(path.normalize(value));
    const comparisonKey = process.platform === "win32" ? normalizedValue.toLocaleLowerCase("en-US") : normalizedValue;
    return { value: normalizedValue, comparisonKey };
  });
  if (normalized.some((value) => value === undefined)) return undefined;

  const candidates = normalized as { value: string; comparisonKey: string }[];
  candidates.sort(
    (left, right) =>
      left.comparisonKey.length - right.comparisonKey.length || left.comparisonKey.localeCompare(right.comparisonKey),
  );
  const retained: typeof candidates = [];
  for (const candidate of candidates) {
    const redundant = retained.some((parent) => {
      const relative = path.relative(parent.comparisonKey, candidate.comparisonKey);
      return (
        relative === "" || (!path.isAbsolute(relative) && !relative.startsWith(`..${path.sep}`) && relative !== "..")
      );
    });
    if (!redundant) retained.push(candidate);
  }
  return retained.map(({ value }) => value);
}

function stripTrailingSeparators(value: string): string {
  const root = path.parse(value).root;
  let end = value.length;
  while (end > root.length && (value[end - 1] === "/" || value[end - 1] === "\\")) end -= 1;
  return value.slice(0, end);
}

function isHostFullyQualifiedPath(value: string): boolean {
  if (process.platform !== "win32") return path.isAbsolute(value);

  const windowsPath = value.replaceAll("/", "\\");
  if (/^[A-Za-z]:\\/.test(windowsPath)) return true;
  if (/^\\\\\?\\[A-Za-z]:\\/.test(windowsPath)) return true;
  if (/^\\\\\?\\UNC\\[^\\]+\\[^\\]+(?:\\|$)/i.test(windowsPath)) return true;
  if (/^\\\\[.?]\\/.test(windowsPath)) return false;
  return /^\\\\[^\\]+\\[^\\]+(?:\\|$)/.test(windowsPath);
}
