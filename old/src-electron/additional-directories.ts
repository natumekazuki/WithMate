import path from "node:path";

function normalizeForComparison(targetPath: string): string {
  const normalized = path.resolve(targetPath).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function normalizeDirectoryPath(targetPath: string): string {
  return path.resolve(targetPath);
}

export function isPathWithinDirectory(targetPath: string, directoryPath: string): boolean {
  const normalizedTargetPath = normalizeForComparison(targetPath);
  const normalizedDirectoryPath = normalizeForComparison(directoryPath);
  const relativePath = path.relative(normalizedDirectoryPath, normalizedTargetPath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

export function isPathWithinAnyDirectory(targetPath: string, directoryPaths: readonly string[]): boolean {
  return directoryPaths.some((directoryPath) => isPathWithinDirectory(targetPath, directoryPath));
}

export function normalizeAllowedAdditionalDirectories(
  workspacePath: string,
  directoryPaths: readonly string[],
): string[] {
  const normalizedWorkspacePath = normalizeDirectoryPath(workspacePath);
  const uniqueDirectories = Array.from(
    new Map(
      directoryPaths
        .map((directoryPath) => directoryPath.trim())
        .filter((directoryPath) => directoryPath.length > 0)
        .map((directoryPath) => {
          const normalizedDirectoryPath = normalizeDirectoryPath(directoryPath);
          return [normalizeForComparison(normalizedDirectoryPath), normalizedDirectoryPath] as const;
        }),
    ).values(),
  ).sort((left, right) => left.localeCompare(right));

  const normalizedDirectories: string[] = [];
  for (const directoryPath of uniqueDirectories) {
    if (isPathWithinDirectory(directoryPath, normalizedWorkspacePath)) {
      continue;
    }

    if (normalizedDirectories.some((existingDirectoryPath) => isPathWithinDirectory(directoryPath, existingDirectoryPath))) {
      continue;
    }

    const nextDirectories = normalizedDirectories.filter(
      (existingDirectoryPath) => !isPathWithinDirectory(existingDirectoryPath, directoryPath),
    );
    nextDirectories.push(directoryPath);
    nextDirectories.sort((left, right) => left.localeCompare(right));
    normalizedDirectories.splice(0, normalizedDirectories.length, ...nextDirectories);
  }

  return normalizedDirectories;
}
