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

function toDisplayName(targetPath: string): string {
  const resolvedPath = path.resolve(targetPath);
  const baseName = path.basename(resolvedPath);
  return baseName || normalizeProjectPath(targetPath);
}

export function resolveProjectScope(workspacePath: string): ResolvedProjectScopeInput {
  const normalizedWorkspacePath = normalizeProjectPath(workspacePath);
  const gitRoot = findGitRootSync(normalizedWorkspacePath);
  const projectType: ProjectScopeType = gitRoot ? "git" : "directory";
  const anchorPath = gitRoot ?? normalizedWorkspacePath;

  return {
    projectType,
    projectKey: `${projectType}:${anchorPath}`,
    workspacePath: normalizedWorkspacePath,
    gitRoot,
    gitRemoteUrl: null,
    displayName: toDisplayName(anchorPath),
  };
}
