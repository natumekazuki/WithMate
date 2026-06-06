function normalizeAdditionalDirectoryPath(directoryPath: string): string {
  const normalizedPath = directoryPath.replace(/\\/g, "/");
  if (/^[A-Za-z]:\/+$/.test(normalizedPath)) {
    return `${normalizedPath.slice(0, 2)}/`;
  }
  return normalizedPath.replace(/\/+$/g, "") || normalizedPath;
}

function isWindowsAdditionalDirectoryPath(directoryPath: string): boolean {
  return /^[A-Za-z]:\//.test(directoryPath) || /^\/\/[^/]+\/[^/]+/.test(directoryPath);
}

function toAdditionalDirectoryComparisonKey(directoryPath: string): string {
  const normalizedPath = normalizeAdditionalDirectoryPath(directoryPath);
  if (isWindowsAdditionalDirectoryPath(normalizedPath)) {
    return normalizedPath.toLowerCase();
  }
  return normalizedPath;
}

export function addAllowedAdditionalDirectory(
  directories: readonly string[] | null | undefined,
  directoryPath: string,
): string[] {
  const nextDirectories: string[] = [];
  const seenKeys = new Set<string>();
  for (const entry of [...(directories ?? []), directoryPath]) {
    const normalizedPath = normalizeAdditionalDirectoryPath(entry);
    const comparisonKey = toAdditionalDirectoryComparisonKey(normalizedPath);
    if (seenKeys.has(comparisonKey)) {
      continue;
    }
    seenKeys.add(comparisonKey);
    nextDirectories.push(normalizedPath);
  }
  return nextDirectories;
}

export function removeAllowedAdditionalDirectory(
  directories: readonly string[] | null | undefined,
  directoryPath: string,
): string[] {
  const removableKey = toAdditionalDirectoryComparisonKey(directoryPath);
  return (directories ?? [])
    .map(normalizeAdditionalDirectoryPath)
    .filter((entry) => toAdditionalDirectoryComparisonKey(entry) !== removableKey);
}
