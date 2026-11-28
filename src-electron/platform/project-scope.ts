import fs from "node:fs";
import path from "node:path";

import type { ProjectScopeType } from "../../src-shared/memory/session-memory-state.js";

/** ワークスペースをプロジェクトへ関連付けるキーと、表示・Git参照に用いる情報。 */
export type ResolvedProjectScopeInput = {
  projectType: ProjectScopeType;
  projectKey: string;
  workspacePath: string;
  gitRoot: string | null;
  gitRemoteUrl: string | null;
  displayName: string;
};

/** 実行OSによらず、ドライブ付きの絶対パスまたはUNCパスの表記を判別する。 */
function isWindowsAbsolutePath(targetPath: string): boolean {
  return (
    /^[A-Za-z]:[\\/]/.test(targetPath) || /^\\\\[^\\]+\\[^\\]+/.test(targetPath)
  );
}

/** パスを絶対表記とスラッシュ区切りに揃え、ルート以外の末尾区切りを除く。 */
function normalizeProjectPath(targetPath: string): string {
  if (isWindowsAbsolutePath(targetPath)) {
    const normalizedWindowsPath = path.win32
      .normalize(targetPath)
      .replace(/\\/g, "/");
    if (/^[A-Za-z]:\/$/.test(normalizedWindowsPath)) {
      return normalizedWindowsPath;
    }
    return normalizedWindowsPath.replace(/\/+$/, "");
  }

  const resolved = path.resolve(targetPath).replace(/\\/g, "/");
  if (resolved === "/" || /^[A-Za-z]:\/$/.test(resolved)) {
    return resolved;
  }

  return resolved.replace(/\/+$/, "");
}

/** statが成功する項目だけを存在するとみなす。アクセス失敗も未検出として扱う。 */
function pathExists(targetPath: string): boolean {
  try {
    fs.statSync(targetPath);
    return true;
  } catch {
    return false;
  }
}

/** Gitの管理ファイルをUTF-8で読み、開けない場合は後続が代替できるようにnullを返す。 */
function readTextFile(targetPath: string): string | null {
  try {
    return fs.readFileSync(targetPath, "utf8");
  } catch {
    return null;
  }
}

/** 開始ディレクトリから親をたどり、最寄りの.gitを持つディレクトリを返す。見つからなければnullを返す。 */
export function findGitRootSync(startDirectory: string): string | null {
  let currentDirectory = normalizeProjectPath(startDirectory);

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

/** .gitディレクトリまたは.gitファイルのgitdir参照から管理ディレクトリを解決する。 */
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

/** 標準の.git/worktrees配下なら共有.gitを返し、それ以外は指定の管理ディレクトリを使う。 */
function resolveGitCommonDirSync(gitDir: string): string {
  const normalizedGitDir = normalizeProjectPath(gitDir);
  const worktreeMatch = normalizedGitDir.match(
    /^(.*\/\.git)\/worktrees\/[^/]+$/,
  );
  if (worktreeMatch?.[1]) {
    return normalizeProjectPath(worktreeMatch[1]);
  }

  return normalizedGitDir;
}

/** 設定テキストのremote節からURLを取り出す。originを優先し、なければ最初に見つけたURLを返す。 */
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

/** 共有のGit設定から代表remoteのURLを取得し、設定やURLが得られない場合はnullを返す。 */
function resolveGitRemoteUrlSync(gitCommonDir: string): string | null {
  const configText = readTextFile(path.join(gitCommonDir, "config"));
  if (!configText) {
    return null;
  }

  return extractRemoteUrlFromConfig(configText);
}

/** remoteの末尾名、共有管理ディレクトリ由来の名前、作業ツリーの表示名の順に候補を採用する。 */
function inferRepositoryName(
  remoteUrl: string | null,
  gitCommonDir: string | null,
  gitRoot: string,
): string {
  if (remoteUrl) {
    const normalizedRemoteUrl = remoteUrl
      .replace(/\\/g, "/")
      .replace(/\/+$/, "");
    const lastSegment = normalizedRemoteUrl
      .split(/[/:]/)
      .filter(Boolean)
      .at(-1);
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

/** remote URLを優先し、なければ共有管理ディレクトリ由来のパス、次に作業ツリーのルートを識別子に使う。 */
function resolveRepositoryIdentity(
  gitRemoteUrl: string | null,
  gitCommonDir: string | null,
  gitRoot: string,
): string {
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

/** パスの末尾名を表示用に取り出し、名前が空なら正規化したパスそのものを使う。 */
function toDisplayName(targetPath: string): string {
  const resolvedPath = isWindowsAbsolutePath(targetPath)
    ? path.win32.normalize(targetPath)
    : path.resolve(targetPath);
  const baseName = path.basename(resolvedPath);
  return baseName || normalizeProjectPath(targetPath);
}

/** Gitが検出できればリポジトリ単位、検出できなければディレクトリ単位でプロジェクトを識別する。 */
export function resolveProjectScope(
  workspacePath: string,
): ResolvedProjectScopeInput {
  const normalizedWorkspacePath = normalizeProjectPath(workspacePath);
  if (
    isWindowsAbsolutePath(normalizedWorkspacePath) &&
    process.platform !== "win32"
  ) {
    return {
      projectType: "directory",
      projectKey: `directory:${normalizedWorkspacePath}`,
      workspacePath: normalizedWorkspacePath,
      gitRoot: null,
      gitRemoteUrl: null,
      displayName: toDisplayName(normalizedWorkspacePath),
    };
  }
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
  const gitRemoteUrl = gitCommonDir
    ? resolveGitRemoteUrlSync(gitCommonDir)
    : null;
  const repositoryIdentity = resolveRepositoryIdentity(
    gitRemoteUrl,
    gitCommonDir,
    gitRoot,
  );

  return {
    projectType,
    projectKey: `git:${repositoryIdentity}`,
    workspacePath: normalizedWorkspacePath,
    gitRoot,
    gitRemoteUrl,
    displayName: inferRepositoryName(gitRemoteUrl, gitCommonDir, gitRoot),
  };
}
