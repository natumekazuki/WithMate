import type { Dirent, Stats } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import ignore, { type Ignore } from "ignore";

// ---------------------------------------------------------------------------
// テスト専用 hook
// ---------------------------------------------------------------------------

let _afterIgnoreFileReadHook: ((ignoreFilePath: string) => Promise<void> | void) | null = null;
let _ignoreFileReadOverrideForTesting: ((ignoreFilePath: string) => Promise<string> | string) | null = null;
let _ignoreFileStatOverrideForTesting: ((ignoreFilePath: string) => Promise<Stats> | Stats) | null = null;
let _walkDirectoryStatOverrideForTesting: ((directoryPath: string) => Promise<Stats> | Stats) | null =
  null;
let _walkDirectoryReadOverrideForTesting:
  | ((directoryPath: string) => Promise<Dirent[]> | Dirent[])
  | null = null;

/**
 * テスト専用: createIgnoreMatcher 内の readFile 直後に割り込む hook を設定する。
 * null を渡すと無効化される。
 */
export function _setAfterIgnoreFileReadHookForTesting(
  hook: ((ignoreFilePath: string) => Promise<void> | void) | null,
): void {
  _afterIgnoreFileReadHook = hook;
}

/**
 * テスト専用: createIgnoreMatcher 内の readFile を差し替える。
 * 例外を投げると readFile 失敗のシナリオを再現できる。
 */
export function _setIgnoreFileReadOverrideForTesting(
  override: ((ignoreFilePath: string) => Promise<string> | string) | null,
): void {
  _ignoreFileReadOverrideForTesting = override;
}

/**
 * テスト専用: createIgnoreMatcher 内の stat を差し替える。
 * 例外を投げると stat 失敗のシナリオを再現できる。
 */
export function _setIgnoreFileStatOverrideForTesting(
  override: ((ignoreFilePath: string) => Promise<Stats> | Stats) | null,
): void {
  _ignoreFileStatOverrideForTesting = override;
}

/** テスト専用: walkWorkspace 内の directory stat を差し替える。 */
export function _setWalkDirectoryStatOverrideForTesting(
  override: ((directoryPath: string) => Promise<Stats> | Stats) | null,
): void {
  _walkDirectoryStatOverrideForTesting = override;
}

/** テスト専用: walkWorkspace 内の readdir を差し替える。 */
export function _setWalkDirectoryReadOverrideForTesting(
  override: ((directoryPath: string) => Promise<Dirent[]> | Dirent[]) | null,
): void {
  _walkDirectoryReadOverrideForTesting = override;
}

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
  /** stat / readdir の一時失敗があり、TTL 超過後に再走査が必要な directory 一覧 */
  directoriesNeedingRescan: Set<string>;
  /**
   * 走査時に確認した ignore ファイルの絶対パス → 状態。
   * .gitignore / .git/info/exclude 等の再検証に使用。
   */
  ignoreFiles: Map<string, IgnoreFileState>;
  /**
   * 走査時に存在しなかった外部 ignore 候補の絶対パス一覧。
   * .git/info/exclude および workspace 外の親 .gitignore が対象。
   * checkStructureUnchanged() でこれらの新規出現を検知するために使用。
   */
  absentIgnoreCandidates: string[];
};

export type IgnoreFileState =
  | { kind: "loaded"; mtimeMs: number }
  | { kind: "unreadable"; mtimeMs: number }
  | { kind: "race" };

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

/** createIgnoreMatcher の戻り値。 */
type CreateIgnoreMatcherResult =
  | { kind: "loaded"; matcher: IgnoreMatcher; mtimeMs: number }
  | { kind: "absent" } // ファイルが存在しない（最初の stat が失敗）
  | { kind: "unreadable"; mtimeMs: number } // 安定したアクセス拒否・共有違反などで読めない
  | { kind: "race" }; // 全試行で読み取り中に変更が続いた

function getNodeErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }

  const { code } = error as { code?: unknown };
  return typeof code === "string" ? code : undefined;
}

function isAbsentIgnoreStatError(error: unknown): boolean {
  const code = getNodeErrorCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

function isStableIgnoreAccessError(error: unknown): boolean {
  const code = getNodeErrorCode(error);
  return code === "EACCES" || code === "EPERM";
}

function isStableIgnoreReadError(error: unknown): boolean {
  return isStableIgnoreAccessError(error);
}

async function statIgnoreFile(ignoreFilePath: string): Promise<Stats> {
  if (_ignoreFileStatOverrideForTesting !== null) {
    return await _ignoreFileStatOverrideForTesting(ignoreFilePath);
  }

  return stat(ignoreFilePath);
}

async function statWalkDirectory(directoryPath: string): Promise<Stats> {
  if (_walkDirectoryStatOverrideForTesting !== null) {
    return await _walkDirectoryStatOverrideForTesting(directoryPath);
  }

  return stat(directoryPath);
}

async function readWalkDirectoryEntries(directoryPath: string): Promise<Dirent[]> {
  if (_walkDirectoryReadOverrideForTesting !== null) {
    return await _walkDirectoryReadOverrideForTesting(directoryPath);
  }

  return readdir(directoryPath, { withFileTypes: true });
}

async function readIgnoreFileText(ignoreFilePath: string): Promise<string> {
  if (_ignoreFileReadOverrideForTesting !== null) {
    return await _ignoreFileReadOverrideForTesting(ignoreFilePath);
  }

  return readFile(ignoreFilePath, "utf8");
}

/**
 * ignore ファイルを読み込み、内容と stat の整合を保証して返す。
 *
 * `stat → readFile → hook → stat` を最大 3 回試行する（= 2 回再試行）。
 * 前後の `mtimeMs` と `size` が両方一致した試行があれば即座に "loaded" を返す。
 *
 * 最初の stat 失敗は次のように扱う:
 * - `ENOENT`/`ENOTDIR` などの不存在系エラー: "absent"
 * - それ以外: "race"（アクセス拒否・共有違反を含む。監視対象からは外さない）
 *
 * 各試行の read 失敗は次の 2 種類に分類する:
 * - **stable unreadable**: `EACCES`/`EPERM` による読み取りエラー。
 *   即 return せず試行を継続し、`sawStableUnreadable` を立てる。
 * - **race-like failure**: before-stat 失敗 / 非 stable な read エラー /
 *   after-stat 失敗 / mtime・size 不一致。`sawRaceLikeFailure` を立てる。
 *
 * ループ終了後の判定:
 * - `sawStableUnreadable && !sawRaceLikeFailure` → "unreadable"（mtimeMs は最後の
 *   stable unreadable 試行の `statBefore.mtimeMs`）
 * - それ以外（race-like あり、または両フラグ未設定）→ "race"
 */
async function createIgnoreMatcher(baseDirectory: string, ignoreFilePath: string): Promise<CreateIgnoreMatcherResult> {
  // ファイルの存在確認: 不存在系だけ "absent"、それ以外は再検証可能な race として扱う。
  let firstStat: Stats;
  try {
    firstStat = await statIgnoreFile(ignoreFilePath);
  } catch (error) {
    if (isAbsentIgnoreStatError(error)) {
      return { kind: "absent" };
    }
    return { kind: "race" };
  }

  // 全試行を通じた状態追跡。
  let sawStableUnreadable = false;
  let sawRaceLikeFailure = false;
  let lastStableUnreadableMtimeMs: number | null = null;

  // 最大 3 回の試行（= 2 回再試行）。attempt 0 は firstStat を before-stat として再利用する。
  for (let attempt = 0; attempt < 3; attempt++) {
    let statBefore: Stats;
    try {
      statBefore = attempt === 0 ? firstStat : await statIgnoreFile(ignoreFilePath);
    } catch {
      // before-stat 失敗は race-like として扱い、次の試行へ
      sawRaceLikeFailure = true;
      continue;
    }

    let rules: string;
    try {
      rules = await readIgnoreFileText(ignoreFilePath);
    } catch (error) {
      if (isStableIgnoreReadError(error)) {
        // ACL / 共有違反などの安定した unreadable: 即座に確定せず retry を消費する。
        // 全試行が stable unreadable のみで終わった場合だけ "unreadable" として返す（ループ後で判定）。
        // mtimeMs は確定した最後の stable unreadable 試行の値を使う。
        sawStableUnreadable = true;
        lastStableUnreadableMtimeMs = statBefore.mtimeMs;
      } else {
        // ENOENT 等の非 stable エラーは race-like として扱い次の試行へ
        sawRaceLikeFailure = true;
      }
      continue;
    }

    try {
      // テスト用フック: readFile と確認 stat の間でファイル変更を挿入できる
      if (_afterIgnoreFileReadHook !== null) {
        await _afterIgnoreFileReadHook(ignoreFilePath);
      }
      const statAfter = await statIgnoreFile(ignoreFilePath);
      if (statBefore.mtimeMs === statAfter.mtimeMs && statBefore.size === statAfter.size) {
        // 前後の mtime と size が一致 → 読み取り内容が整合していると判断
        return {
          kind: "loaded",
          matcher: { baseDirectory, matcher: ignore().add(rules) },
          mtimeMs: statAfter.mtimeMs,
        };
      }
      // mtime・size 不一致は race-like として扱い、次の試行へ
      sawRaceLikeFailure = true;
    } catch {
      // after-stat 失敗は race-like として扱い、次の試行へ
      sawRaceLikeFailure = true;
      continue;
    }
  }

  // 全試行が stable unreadable のみで終わった場合だけ "unreadable" に確定する。
  // stable unreadable と race-like が混在した場合は "race" を優先する。
  if (sawStableUnreadable && !sawRaceLikeFailure && lastStableUnreadableMtimeMs !== null) {
    return { kind: "unreadable", mtimeMs: lastStableUnreadableMtimeMs };
  }

  // 全試行で競合したため諦める
  return { kind: "race" };
}

async function loadInitialIgnoreMatchers(rootDirectory: string): Promise<{ matchers: IgnoreMatcher[]; loadedDirectories: Set<string>; ignoreFiles: Map<string, IgnoreFileState>; absentIgnoreCandidates: string[] }> {
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
  const ignoreFiles = new Map<string, IgnoreFileState>();
  const absentIgnoreCandidates: string[] = [];

  for (const directory of ignoreSourceDirectories) {
    const gitignorePath = path.join(directory, ".gitignore");
    const result = await createIgnoreMatcher(directory, gitignorePath);
    const matcher = applyIgnoreFileResult(result, directory, gitignorePath, loadedDirectories, ignoreFiles);
    if (matcher !== null) {
      matchers.push(matcher);
    } else if (result.kind === "absent" && !isInsideDirectory(directory, workspaceDirectory)) {
      // workspace 外部のディレクトリ: visitedDirectories に含まれないため、
      // .gitignore の不在状態を明示的に記録して新規出現を検知できるようにする（P2 対策）
      absentIgnoreCandidates.push(gitignorePath);
    }
  }

  if (gitRoot) {
    const excludePath = path.join(gitRoot, ".git", "info", "exclude");
    const excludeResult = await createIgnoreMatcher(gitRoot, excludePath);
    // directory: null — exclude は per-directory の .gitignore ではないため loadedDirectories は更新しない
    const excludeMatcher = applyIgnoreFileResult(excludeResult, null, excludePath, loadedDirectories, ignoreFiles);
    if (excludeMatcher !== null) {
      matchers.push(excludeMatcher);
    } else if (excludeResult.kind === "absent") {
      // exclude ファイルが存在しない: 後から作成された場合を検知するために不在状態を記録する
      absentIgnoreCandidates.push(excludePath);
    }
  }

  // no-gitRoot: workspace 外の全祖先ディレクトリの .gitignore を不在候補として追跡する（P2 対策）。
  // collectIgnoreSourceDirectories が最初の外部親 .gitignore で停止するのと同様に、
  // すでに loaded な .gitignore または存在する .gitignore に到達した時点で停止する。
  // これにより、任意の祖先レベルに .gitignore が後から作成された場合も TTL 超過時に検知できる。
  if (!gitRoot) {
    let current = path.dirname(workspaceDirectory);
    while (true) {
      const parentGitignorePath = path.join(current, ".gitignore");
      if (ignoreFiles.has(parentGitignorePath)) {
        // この祖先の .gitignore はすでに状態追跡対象 → collectIgnoreSourceDirectories はここで停止する → 停止
        break;
      }
      if (!absentIgnoreCandidates.includes(parentGitignorePath)) {
        if (await pathExists(parentGitignorePath)) {
          // この祖先に .gitignore が存在する → collectIgnoreSourceDirectories はここで停止する → 停止
          break;
        }
        absentIgnoreCandidates.push(parentGitignorePath);
      }
      const parent = path.dirname(current);
      if (parent === current) break; // ファイルシステムのルートに到達
      current = parent;
    }
  }

  return { matchers, loadedDirectories, ignoreFiles, absentIgnoreCandidates };
}

/**
 * createIgnoreMatcher() の結果を ignoreFiles / loadedDirectories に反映する共通ヘルパー。
 *
 * - "loaded": ignoreFilePath → loaded 状態を記録し、directory が非 null であれば
 *             loadedDirectories にも追加する。result.matcher を返す。
 * - "unreadable": ignoreFilePath → unreadable 状態を記録する。null を返す。
 * - "race":   ignoreFilePath → race 状態を記録する。null を返す。
 * - "absent": 何もしない。null を返す。absentIgnoreCandidates への追加は呼び出し側で行う。
 *
 * 戻り値が非 null の場合、呼び出し側でそのマッチャーを active matchers に追加する。
 */
function applyIgnoreFileResult(
  result: CreateIgnoreMatcherResult,
  directory: string | null,
  ignoreFilePath: string,
  loadedDirectories: Set<string>,
  ignoreFiles: Map<string, IgnoreFileState>,
): IgnoreMatcher | null {
  if (result.kind === "loaded") {
    if (directory !== null) {
      loadedDirectories.add(directory);
    }
    ignoreFiles.set(ignoreFilePath, { kind: "loaded", mtimeMs: result.mtimeMs });
    return result.matcher;
  }
  if (result.kind === "unreadable") {
    ignoreFiles.set(ignoreFilePath, { kind: "unreadable", mtimeMs: result.mtimeMs });
    return null;
  }
  if (result.kind === "race") {
    ignoreFiles.set(ignoreFilePath, { kind: "race" });
  }
  return null;
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
  const { matchers: initialMatchers, loadedDirectories, ignoreFiles, absentIgnoreCandidates } = await loadInitialIgnoreMatchers(workspaceDirectory);
  const includedFiles: string[] = [];
  const ignoredFiles: string[] = [];
  const visitedDirectories = new Map<string, number>();
  const directoriesNeedingRescan = new Set<string>();

  async function walk(directory: string, activeMatchers: IgnoreMatcher[]): Promise<void> {
    const relDir = path.relative(workspaceDirectory, directory).replace(/\\/g, "/");
    try {
      const dirStat = await statWalkDirectory(directory);
      visitedDirectories.set(relDir, dirStat.mtimeMs);
    } catch {
      directoriesNeedingRescan.add(relDir);
    }

    let entries;
    try {
      entries = await readWalkDirectoryEntries(directory);
    } catch {
      directoriesNeedingRescan.add(relDir);
      return;
    }

    let nextMatchers = activeMatchers;
    if (!loadedDirectories.has(directory)) {
      const gitignorePath = path.join(directory, ".gitignore");
      const result = await createIgnoreMatcher(directory, gitignorePath);
      const matcher = applyIgnoreFileResult(result, directory, gitignorePath, loadedDirectories, ignoreFiles);
      if (matcher !== null) {
        nextMatchers = [...activeMatchers, matcher];
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
  return {
    includedFiles,
    ignoredFiles,
    visitedDirectories,
    directoriesNeedingRescan,
    ignoreFiles,
    absentIgnoreCandidates,
  };
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
