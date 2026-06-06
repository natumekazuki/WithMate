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

type AdditionalDirectorySessionLike = {
  allowedAdditionalDirectories?: readonly string[] | null;
};

export function resolveAdditionalDirectoryPickerBase(
  ...directoryPaths: Array<string | null | undefined>
): string | null {
  return directoryPaths.find((directoryPath): directoryPath is string => (
    typeof directoryPath === "string" && directoryPath.length > 0
  )) ?? null;
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

export function buildSessionWithAddedAdditionalDirectory<TSession extends AdditionalDirectorySessionLike>(
  session: TSession,
  directoryPath: string,
): TSession & { allowedAdditionalDirectories: string[] } {
  return {
    ...session,
    allowedAdditionalDirectories: addAllowedAdditionalDirectory(session.allowedAdditionalDirectories, directoryPath),
  };
}

export function buildSessionWithRemovedAdditionalDirectory<TSession extends AdditionalDirectorySessionLike>(
  session: TSession,
  directoryPath: string,
): (TSession & { allowedAdditionalDirectories: string[] }) | null {
  const currentDirectories = session.allowedAdditionalDirectories ?? [];
  const nextDirectories = removeAllowedAdditionalDirectory(currentDirectories, directoryPath);
  if (nextDirectories.length === currentDirectories.length) {
    return null;
  }
  return {
    ...session,
    allowedAdditionalDirectories: nextDirectories,
  };
}
