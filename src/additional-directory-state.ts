function normalizeAdditionalDirectoryPath(directoryPath: string): string {
  return directoryPath.replace(/\\/g, "/");
}

export function addAllowedAdditionalDirectory(
  directories: readonly string[] | null | undefined,
  directoryPath: string,
): string[] {
  const normalizedPath = normalizeAdditionalDirectoryPath(directoryPath);
  return Array.from(new Set([...(directories ?? []).map(normalizeAdditionalDirectoryPath), normalizedPath]));
}

export function removeAllowedAdditionalDirectory(
  directories: readonly string[] | null | undefined,
  directoryPath: string,
): string[] {
  const removablePath = normalizeAdditionalDirectoryPath(directoryPath);
  return (directories ?? []).filter((entry) => normalizeAdditionalDirectoryPath(entry) !== removablePath);
}
