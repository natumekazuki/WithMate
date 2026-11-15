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

export function resolveAdditionalDirectoryPickerBase(
  ...directoryPaths: Array<string | null | undefined>
): string | null {
  return directoryPaths.find((directoryPath): directoryPath is string => (
    typeof directoryPath === "string" && directoryPath.length > 0
  )) ?? null;
}

export async function runPickedAdditionalDirectoryOperation(input: {
  canPickDirectory: () => boolean;
  getPickerBaseDirectory: () => string | null;
  pickDirectory: (baseDirectory: string | null) => Promise<string | null>;
  applyPickedDirectory: (selectedPath: string) => void | Promise<void>;
}): Promise<string | null> {
  if (!input.canPickDirectory()) {
    return null;
  }

  const selectedPath = await input.pickDirectory(input.getPickerBaseDirectory());
  if (!selectedPath) {
    return null;
  }

  await input.applyPickedDirectory(selectedPath);
  return selectedPath;
}

export async function runAdditionalDirectoryRemovalOperation(input: {
  directoryPath: string;
  canRemoveDirectory?: () => boolean;
  removeDirectory: (directoryPath: string) => boolean | Promise<boolean>;
}): Promise<boolean> {
  if (input.canRemoveDirectory && !input.canRemoveDirectory()) {
    return false;
  }
  return input.removeDirectory(input.directoryPath);
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
