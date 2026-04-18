import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import ignore, { type Ignore } from "ignore";

export const DEFAULT_SNAPSHOT_MAX_FILE_BYTES = 1024 * 1024;
export const DEFAULT_SNAPSHOT_MAX_FILE_COUNT = 4000;
export const DEFAULT_SNAPSHOT_MAX_TOTAL_BYTES = 16 * 1024 * 1024;

export type WorkspaceSnapshot = Map<string, string>;

type IgnoreMatcher = {
  baseDirectory: string;
  matcher: Ignore;
};

export type SnapshotLimits = {
  maxFileBytes?: number;
  maxFileCount?: number;
  maxTotalBytes?: number;
};

export type SnapshotCaptureStats = {
  capturedFiles: number;
  capturedBytes: number;
  skippedBinaryOrOversizeFiles: number;
  skippedByLimitFiles: number;
  hitFileCountLimit: boolean;
  hitTotalBytesLimit: boolean;
};

export type SnapshotCaptureResult = {
  snapshot: WorkspaceSnapshot;
  stats: SnapshotCaptureStats;
};

export type SnapshotScanResult = {
  includedFiles: string[];
  ignoredFiles: string[];
  /** workspace root 相対ディレクトリパス（root = ""）→ mtimeMs。構造変更検知に使用 */
  visitedDirectories: Map<string, number>;
};

function normalizeSnapshotKey(rootDirectory: string, relativePath: string, useWorkspaceRelativeKey: boolean): string {
  if (useWorkspaceRelativeKey) {
    return relativePath;
  }

  return path.join(path.resolve(rootDirectory), relativePath).replace(/\\/g, "/");
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function findGitRoot(startDirectory: string): Promise<string | null> {
  let currentDirectory = path.resolve(startDirectory);

  while (true) {
    if (await pathExists(path.join(currentDirectory, ".git"))) {
      return currentDirectory;
    }

    const parentDirectory = path.dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      return null;
    }

    currentDirectory = parentDirectory;
  }
}

async function collectIgnoreSourceDirectories(rootDirectory: string): Promise<string[]> {
  const workspaceDirectory = path.resolve(rootDirectory);
  const gitRoot = await findGitRoot(workspaceDirectory);
  const directories: string[] = [];
  let currentDirectory = workspaceDirectory;
  let foundParentGitignore = false;

  while (true) {
    directories.push(currentDirectory);

    if (gitRoot && currentDirectory === gitRoot) {
      break;
    }

    const parentDirectory = path.dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      break;
    }

    if (!gitRoot) {
      const parentGitignorePath = path.join(parentDirectory, ".gitignore");
      if (await pathExists(parentGitignorePath)) {
        directories.push(parentDirectory);
        foundParentGitignore = true;
        break;
      }
    }

    currentDirectory = parentDirectory;
  }

  if (!gitRoot && !foundParentGitignore) {
    return [workspaceDirectory];
  }

  return directories.reverse();
}

async function createIgnoreMatcher(baseDirectory: string, ignoreFilePath: string): Promise<IgnoreMatcher | null> {
  try {
    const rules = await readFile(ignoreFilePath, "utf8");
    return {
      baseDirectory,
      matcher: ignore().add(rules),
    };
  } catch {
    return null;
  }
}

async function loadInitialIgnoreMatchers(rootDirectory: string): Promise<{ matchers: IgnoreMatcher[]; loadedDirectories: Set<string> }> {
  const workspaceDirectory = path.resolve(rootDirectory);
  const gitRoot = await findGitRoot(workspaceDirectory);
  const ignoreSourceDirectories = await collectIgnoreSourceDirectories(workspaceDirectory);
  const matchers: IgnoreMatcher[] = [
    {
      baseDirectory: workspaceDirectory,
      matcher: ignore().add(".git/"),
    },
  ];
  const loadedDirectories = new Set<string>();

  for (const directory of ignoreSourceDirectories) {
    const entry = await createIgnoreMatcher(directory, path.join(directory, ".gitignore"));
    if (entry) {
      matchers.push(entry);
      loadedDirectories.add(directory);
    }
  }

  if (gitRoot) {
    const excludeEntry = await createIgnoreMatcher(gitRoot, path.join(gitRoot, ".git", "info", "exclude"));
    if (excludeEntry) {
      matchers.push(excludeEntry);
    }
  }

  return { matchers, loadedDirectories };
}

function isInsideDirectory(targetPath: string, baseDirectory: string): boolean {
  const relativePath = path.relative(baseDirectory, targetPath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function toMatcherPath(baseDirectory: string, targetPath: string, directoryHint = false): string {
  const relativePath = path.relative(baseDirectory, targetPath).replace(/\\/g, "/");
  return directoryHint ? `${relativePath}/` : relativePath;
}

function isIgnoredByMatchers(targetPath: string, isDirectory: boolean, matchers: IgnoreMatcher[]): boolean {
  let ignored = false;

  for (const entry of matchers) {
    if (!isInsideDirectory(targetPath, entry.baseDirectory)) {
      continue;
    }

    const result = entry.matcher.test(toMatcherPath(entry.baseDirectory, targetPath, isDirectory));
    if (result.ignored) {
      ignored = true;
      continue;
    }

    if (result.unignored) {
      ignored = false;
    }
  }

  return ignored;
}

async function readSnapshotTextFile(filePath: string, maxFileBytes: number): Promise<string | null> {
  try {
    const content = await readFile(filePath);
    if (content.byteLength > maxFileBytes || content.includes(0)) {
      return null;
    }

    return content.toString("utf8");
  } catch {
    return null;
  }
}

async function walkWorkspace(
  rootDirectory: string,
  onFile: (filePath: string, relativePath: string) => Promise<void>,
): Promise<SnapshotScanResult> {
  const workspaceDirectory = path.resolve(rootDirectory);
  const { matchers: initialMatchers, loadedDirectories } = await loadInitialIgnoreMatchers(workspaceDirectory);
  const includedFiles: string[] = [];
  const ignoredFiles: string[] = [];
  const visitedDirectories = new Map<string, number>();

  async function walk(directory: string, activeMatchers: IgnoreMatcher[]): Promise<void> {
    try {
      const dirStat = await stat(directory);
      const relDir = path.relative(workspaceDirectory, directory).replace(/\\/g, "/");
      visitedDirectories.set(relDir, dirStat.mtimeMs);
    } catch {
      // mtime 取得失敗時は記録をスキップ
    }

    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    let nextMatchers = activeMatchers;
    if (!loadedDirectories.has(directory)) {
      const localMatcher = await createIgnoreMatcher(directory, path.join(directory, ".gitignore"));
      if (localMatcher) {
        nextMatchers = [...activeMatchers, localMatcher];
        loadedDirectories.add(directory);
      }
    }

    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        if (isIgnoredByMatchers(absolutePath, true, nextMatchers)) {
          continue;
        }

        await walk(absolutePath, nextMatchers);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const relativePath = path.relative(workspaceDirectory, absolutePath).replace(/\\/g, "/");
      if (isIgnoredByMatchers(absolutePath, false, nextMatchers)) {
        ignoredFiles.push(relativePath);
        continue;
      }

      includedFiles.push(relativePath);
      await onFile(absolutePath, relativePath);
    }
  }

  await walk(workspaceDirectory, initialMatchers);
  return { includedFiles, ignoredFiles, visitedDirectories };
}

export async function scanWorkspacePaths(rootDirectory: string): Promise<SnapshotScanResult> {
  return walkWorkspace(rootDirectory, async () => {
    // no-op
  });
}

export async function captureWorkspaceSnapshot(
  rootDirectory: string | readonly string[],
  limits: SnapshotLimits = {},
): Promise<SnapshotCaptureResult> {
  const maxFileBytes = limits.maxFileBytes ?? DEFAULT_SNAPSHOT_MAX_FILE_BYTES;
  const maxFileCount = limits.maxFileCount ?? DEFAULT_SNAPSHOT_MAX_FILE_COUNT;
  const maxTotalBytes = limits.maxTotalBytes ?? DEFAULT_SNAPSHOT_MAX_TOTAL_BYTES;
  const rootDirectories = Array.from(
    new Map(
      (Array.isArray(rootDirectory) ? rootDirectory : [rootDirectory])
        .map((entry) => path.resolve(entry))
        .map((entry) => [process.platform === "win32" ? entry.toLowerCase() : entry, entry] as const),
    ).values(),
  );
  const snapshot: WorkspaceSnapshot = new Map();
  const stats: SnapshotCaptureStats = {
    capturedFiles: 0,
    capturedBytes: 0,
    skippedBinaryOrOversizeFiles: 0,
    skippedByLimitFiles: 0,
    hitFileCountLimit: false,
    hitTotalBytesLimit: false,
  };

  for (const [index, directory] of rootDirectories.entries()) {
    await walkWorkspace(directory, async (absolutePath, relativePath) => {
      if (stats.hitFileCountLimit || stats.hitTotalBytesLimit) {
        stats.skippedByLimitFiles += 1;
        return;
      }

      const text = await readSnapshotTextFile(absolutePath, maxFileBytes);
      if (text === null) {
        stats.skippedBinaryOrOversizeFiles += 1;
        return;
      }

      const nextBytes = Buffer.byteLength(text, "utf8");
      if (stats.capturedFiles >= maxFileCount) {
        stats.hitFileCountLimit = true;
        stats.skippedByLimitFiles += 1;
        return;
      }

      if (stats.capturedBytes + nextBytes > maxTotalBytes) {
        stats.hitTotalBytesLimit = true;
        stats.skippedByLimitFiles += 1;
        return;
      }

      snapshot.set(normalizeSnapshotKey(directory, relativePath, index === 0), text);
      stats.capturedFiles += 1;
      stats.capturedBytes += nextBytes;
    });
  }

  return { snapshot, stats };
}
