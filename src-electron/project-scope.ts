import fs from "node:fs";
import path from "node:path";

import type { ProjectScopeType } from "../src/app-state.js";

export type ResolvedProjectScopeInput = {
  projectType: ProjectScopeType;
  projectKey: string;
  workspacePath: string;
  gitRoot: string | null;
  gitRemoteUrl: string | null;
  displayName: string;
};

function normalizeProjectPath(targetPath: string): string {
  const resolved = path.resolve(targetPath).replace(/\\/g, "/");
  if (resolved === "/" || /^[A-Za-z]:\/$/.test(resolved)) {
    return resolved;
  }

  return resolved.replace(/\/+$/, "");
}

function pathExists(targetPath: string): boolean {
  try {
    fs.statSync(targetPath);
    return true;
  } catch {
    return false;
  }
}

function readTextFile(targetPath: string): string | null {
  try {
    return fs.readFileSync(targetPath, "utf8");
  } catch {
    return null;
  }
}

export function findGitRootSync(startDirectory: string): string | null {
  let currentDirectory = path.resolve(startDirectory);

  while (true) {
    if (pathExists(path.join(currentDirectory, ".git"))) {
      return normalizeProjectPath(currentDirectory);
    }

    const parentDirectory = path.dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      return null;
    }

    currentDirectory = parentDirectory;
  }
}

function resolveGitDirSync(gitRoot: string): string | null {
  const gitEntryPath = path.join(gitRoot, ".git");
  let stats: fs.Stats | null = null;
  try {
    stats = fs.statSync(gitEntryPath);
  } catch {
    return null;
  }

  if (stats.isDirectory()) {
    return normalizeProjectPath(gitEntryPath);
  }

  if (!stats.isFile()) {
    return null;
  }

  const content = readTextFile(gitEntryPath);
  const match = content?.match(/gitdir:\s*(.+)/i);
  if (!match?.[1]) {
    return null;
  }

  return normalizeProjectPath(path.resolve(gitRoot, match[1].trim()));
}

function resolveGitCommonDirSync(gitDir: string): string {
  const normalizedGitDir = normalizeProjectPath(gitDir);
  const worktreeMatch = normalizedGitDir.match(/^(.*\/\.git)\/worktrees\/[^/]+$/);
  if (worktreeMatch?.[1]) {
    return normalizeProjectPath(worktreeMatch[1]);
  }

  return normalizedGitDir;
}

function extractRemoteUrlFromConfig(configText: string): string | null {
  let currentRemoteName: string | null = null;
  let firstRemoteUrl: string | null = null;

  for (const rawLine of configText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) {
      continue;
    }

    const sectionMatch = line.match(/^\[remote\s+"([^"]+)"\]$/i);
    if (sectionMatch) {
      currentRemoteName = sectionMatch[1] ?? null;
      continue;
    }

    if (line.startsWith("[") && line.endsWith("]")) {
      currentRemoteName = null;
      continue;
    }

    if (!currentRemoteName) {
      continue;
    }

    const urlMatch = line.match(/^url\s*=\s*(.+)$/i);
    if (!urlMatch?.[1]) {
      continue;
    }

    const remoteUrl = urlMatch[1].trim();
    if (!remoteUrl) {
      continue;
    }

    if (currentRemoteName === "origin") {
      return remoteUrl;
    }

    firstRemoteUrl ??= remoteUrl;
  }

  return firstRemoteUrl;
}

function resolveGitRemoteUrlSync(gitCommonDir: string): string | null {
  const configText = readTextFile(path.join(gitCommonDir, "config"));
  if (!configText) {
    return null;
  }

  return extractRemoteUrlFromConfig(configText);
}

function inferRepositoryName(remoteUrl: string | null, gitCommonDir: string | null, gitRoot: string): string {
  if (remoteUrl) {
    const normalizedRemoteUrl = remoteUrl.replace(/\\/g, "/").replace(/\/+$/, "");
    const lastSegment = normalizedRemoteUrl.split(/[/:]/).filter(Boolean).at(-1);
    const repoName = lastSegment?.replace(/\.git$/i, "").trim();
    if (repoName) {
      return repoName;
    }
  }

  if (gitCommonDir) {
    const baseName = path.basename(gitCommonDir);
    if (baseName.toLowerCase() === ".git") {
      const repoDirectoryName = path.basename(path.dirname(gitCommonDir));
      if (repoDirectoryName) {
        return repoDirectoryName;
      }
    }

    if (baseName) {
      return baseName;
    }
  }

  return toDisplayName(gitRoot);
}

function resolveRepositoryIdentity(gitRemoteUrl: string | null, gitCommonDir: string | null, gitRoot: string): string {
  if (gitRemoteUrl) {
    return gitRemoteUrl;
  }

  if (gitCommonDir) {
    const commonDirBaseName = path.basename(gitCommonDir);
    if (commonDirBaseName.toLowerCase() === ".git") {
      return normalizeProjectPath(path.dirname(gitCommonDir));
    }

    return gitCommonDir;
  }

  return gitRoot;
}

function toDisplayName(targetPath: string): string {
  const resolvedPath = path.resolve(targetPath);
  const baseName = path.basename(resolvedPath);
  return baseName || normalizeProjectPath(targetPath);
}

export function resolveProjectScope(workspacePath: string): ResolvedProjectScopeInput {
  const normalizedWorkspacePath = normalizeProjectPath(workspacePath);
  const gitRoot = findGitRootSync(normalizedWorkspacePath);
  const projectType: ProjectScopeType = gitRoot ? "git" : "directory";
  if (!gitRoot) {
    return {
      projectType,
      projectKey: `directory:${normalizedWorkspacePath}`,
      workspacePath: normalizedWorkspacePath,
      gitRoot: null,
      gitRemoteUrl: null,
      displayName: toDisplayName(normalizedWorkspacePath),
    };
  }

  const gitDir = resolveGitDirSync(gitRoot);
  const gitCommonDir = gitDir ? resolveGitCommonDirSync(gitDir) : null;
  const gitRemoteUrl = gitCommonDir ? resolveGitRemoteUrlSync(gitCommonDir) : null;
  const repositoryIdentity = resolveRepositoryIdentity(gitRemoteUrl, gitCommonDir, gitRoot);

  return {
    projectType,
    projectKey: `git:${repositoryIdentity}`,
    workspacePath: normalizedWorkspacePath,
    gitRoot,
    gitRemoteUrl,
    displayName: inferRepositoryName(gitRemoteUrl, gitCommonDir, gitRoot),
  };
}
