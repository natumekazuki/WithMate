export function addAllowedAdditionalDirectory(
  directories: readonly string[] | null | undefined,
  directoryPath: string,
): string[] {
  return Array.from(new Set([...(directories ?? []), directoryPath]));
}

export function removeAllowedAdditionalDirectory(
  directories: readonly string[] | null | undefined,
  directoryPath: string,
): string[] {
  return (directories ?? []).filter((entry) => entry !== directoryPath);
}
