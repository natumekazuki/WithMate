import type { Dirent, Stats } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import ignore, { type Ignore } from "ignore";

// ---------------------------------------------------------------------------
// テスト専用 hook
// ---------------------------------------------------------------------------

let _afterIgnoreFileReadHook:
  ((ignoreFilePath: string) => Promise<void> | void) | null = null;
let _ignoreFileReadOverrideForTesting:
  ((ignoreFilePath: string) => Promise<string> | string) | null = null;
let _ignoreFileStatOverrideForTesting:
  ((ignoreFilePath: string) => Promise<Stats> | Stats) | null = null;
let _walkDirectoryStatOverrideForTesting:
  ((directoryPath: string) => Promise<Stats> | Stats) | null = null;
let _walkDirectoryReadOverrideForTesting:
  ((directoryPath: string) => Promise<Dirent[]> | Dirent[]) | null = null;
let _nowOverrideForTesting: (() => number) | null = null;

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

/** テスト専用: snapshot-ignore 内の現在時刻取得を差し替える。 */
export function _setNowOverrideForTesting(
  override: (() => number) | null,
): void {
  _nowOverrideForTesting = override;
}

/** 取得対象となる単一ファイルの既定の最大バイト数。 */
export const DEFAULT_SNAPSHOT_MAX_FILE_BYTES = 1024 * 1024;
/** 全ルートを通じて取得するファイルの既定の最大件数。 */
export const DEFAULT_SNAPSHOT_MAX_FILE_COUNT = 4000;
/** 全ルートを通じて保持するUTF-8本文の既定の最大合計バイト数。 */
export const DEFAULT_SNAPSHOT_MAX_TOTAL_BYTES = 16 * 1024 * 1024;

/** ワークスペース相対パスまたは追加ルートの絶対パスで引けるテキスト本文の集合。 */
export type WorkspaceSnapshot = Map<string, string>;

/** ignoreルールと、マッチングするパスの起点となるディレクトリ。 */
type IgnoreMatcher = {
  baseDirectory: string;
  matcher: Ignore;
};

/** 更新時刻・サイズと、それらを観測した時刻。 */
export type ObservedMtime = {
  mtimeMs: number;
  size: number;
  observedAt: number;
};

/** 単一ファイルのサイズ、合計件数、合計バイト数の上限。省略項目には既定値を使う。 */
export type SnapshotLimits = {
  maxFileBytes?: number;
  maxFileCount?: number;
  maxTotalBytes?: number;
};

/** 取得した本文の件数・容量と、除外件数・上限到達の内訳。 */
export type SnapshotCaptureStats = {
  capturedFiles: number;
  capturedBytes: number;
  skippedBinaryOrOversizeFiles: number;
  skippedByLimitFiles: number;
  hitFileCountLimit: boolean;
  hitTotalBytesLimit: boolean;
};

/** 取得できたテキスト本文と、今回の取得・除外の集計。 */
export type SnapshotCaptureResult = {
  snapshot: WorkspaceSnapshot;
  stats: SnapshotCaptureStats;
};

/** 本文を取得できた場合、パスがなくなった場合、取得できず見送った場合を区別する。 */
type SnapshotFileReadResult =
  | { kind: "captured"; text: string }
  | { kind: "missing" }
  | { kind: "skipped" };

/** 差分更新でファイルの変化と容量を判定するため、キーと前回の観測・取得状態を保持する。 */
type SnapshotIndexedFile = {
  key: string;
  absolutePath: string;
  relativePath: string;
  rootIndex: number;
  mtimeMs: number;
  size: number;
  state: "captured" | "skipped";
  capturedBytes: number;
};

/** ルートごとの走査結果。ignoreやディレクトリ構造の再検証に使う。 */
type SnapshotRootIndex = {
  directory: string;
  scan: SnapshotScanResult;
};

/** スナップショットと増分更新用のルート・ファイル索引、上限、世代番号を保持する。 */
export type WorkspaceSnapshotIndex = {
  rootDirectories: string[];
  limits: Required<SnapshotLimits>;
  snapshot: WorkspaceSnapshot;
  stats: SnapshotCaptureStats;
  files: Map<string, SnapshotIndexedFile>;
  roots: SnapshotRootIndex[];
  version: number;
};

/** 更新済み索引と返却用の本文・集計に、再構築の有無と更新理由を添える。 */
export type WorkspaceSnapshotIndexRefreshResult = {
  index: WorkspaceSnapshotIndex;
  snapshot: WorkspaceSnapshot;
  stats: SnapshotCaptureStats;
  usedFullRebuild: boolean;
  reason:
    | "unchanged"
    | "file-refresh"
    | "candidate-refresh"
    | "structure-change"
    | "ignore-change"
    | "limit";
};

/** ファイルの採否と、次回に構造やignore設定を再検証するための観測情報。 */
export type SnapshotScanResult = {
  includedFiles: string[];
  ignoredFiles: string[];
  /** workspace root 相対ディレクトリパス（root = ""）→ mtime と観測時刻。構造変更検知に使用 */
  visitedDirectories: Map<string, ObservedMtime>;
  /**
   * stat / readdir 失敗があった directory 一覧。
   * transient failure は次回 TTL 超過時、persistent failure は backoff 超過後に再走査する。
   */
  directoriesNeedingRescan: Map<string, DirectoryRescanState>;
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

/** ignoreファイルの読み込み済み、安定した読み込み失敗、読み込み時の競合を区別する観測状態。 */
export type IgnoreFileState =
  | { kind: "loaded"; mtimeMs: number; size: number; observedAt: number }
  | { kind: "unreadable"; mtimeMs: number | null; observedAt: number | null }
  | { kind: "race" };

/** ディレクトリの再走査が必要な失敗を、一時的か持続的かに分類する。 */
export type DirectoryRescanState = {
  kind: "transient" | "persistent";
};

/** 主ルートには相対パス、追加ルートにはスラッシュ区切りの絶対パスをキーとして使う。 */
function normalizeSnapshotKey(
  rootDirectory: string,
  relativePath: string,
  useWorkspaceRelativeKey: boolean,
): string {
  if (useWorkspaceRelativeKey) {
    return relativePath;
  }

  return path
    .join(path.resolve(rootDirectory), relativePath)
    .replace(/\\/g, "/");
}

/** statに成功した項目だけを存在するとみなし、失敗は未検出として扱う。 */
async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

/** 開始ディレクトリから親をたどり、最寄りの.gitを持つディレクトリを探す。 */
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

/** ignoreルールの読み込み元を親から子の順に返す。Git外では不在と確定できない最寄りの親の.gitignoreまでを対象とする。 */
async function collectIgnoreSourceDirectories(
  rootDirectory: string,
): Promise<string[]> {
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
      const parentGitignorePresence =
        await probeIgnoreFilePresence(parentGitignorePath);
      if (parentGitignorePresence !== "absent") {
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
  | {
      kind: "loaded";
      matcher: IgnoreMatcher;
      mtimeMs: number;
      size: number;
      observedAt: number;
    }
  | { kind: "absent" } // ファイルが存在しない（最初の stat が失敗）
  | { kind: "unreadable"; mtimeMs: number | null; observedAt: number | null } // 安定したアクセス拒否・型不整合などで読めない
  | { kind: "race" }; // 全試行で読み取り中に変更が続いた

/** 捕捉した値から文字列のエラーコードだけを取り出す。 */
function getNodeErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }

  const { code } = error as { code?: unknown };
  return typeof code === "string" ? code : undefined;
}

/** ignore候補が存在しないとみなすstatエラーを識別する。 */
function isAbsentIgnoreStatError(error: unknown): boolean {
  const code = getNodeErrorCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

/** 権限によるアクセス失敗を、一時的な競合と区別する。 */
function isStableIgnoreAccessError(error: unknown): boolean {
  const code = getNodeErrorCode(error);
  return code === "EACCES" || code === "EPERM";
}

/** 観測時刻をミリ秒で返す。テストで時計が指定されていればそちらを使う。 */
function getNow(): number {
  return _nowOverrideForTesting !== null
    ? _nowOverrideForTesting()
    : Date.now();
}

/** アクセス拒否、非ディレクトリ、リンクループを安定したstat失敗に分類する。 */
function isStableIgnoreStatError(error: unknown): boolean {
  const code = getNodeErrorCode(error);
  return (
    isStableIgnoreAccessError(error) || code === "ENOTDIR" || code === "ELOOP"
  );
}

/** アクセス拒否やファイル種別の不一致を安定した読み取り失敗に分類する。 */
function isStableIgnoreReadError(error: unknown): boolean {
  const code = getNodeErrorCode(error);
  return (
    isStableIgnoreAccessError(error) || code === "EISDIR" || code === "ENOTDIR"
  );
}

/** アクセス拒否、非ディレクトリ、リンクループを持続的なディレクトリ読み取り失敗とみなす。 */
function isPersistentDirectoryReadError(error: unknown): boolean {
  const code = getNodeErrorCode(error);
  return (
    code === "EACCES" ||
    code === "EPERM" ||
    code === "ENOTDIR" ||
    code === "ELOOP"
  );
}

/** ディレクトリ列挙の失敗を、次回の再走査判定に使う状態へ変換する。 */
function classifyDirectoryRescanState(error: unknown): DirectoryRescanState {
  return {
    kind: isPersistentDirectoryReadError(error) ? "persistent" : "transient",
  };
}

/** ignoreファイルの状態を取得する。設定されている場合はテスト用の差し替えを使う。 */
async function statIgnoreFile(ignoreFilePath: string): Promise<Stats> {
  if (_ignoreFileStatOverrideForTesting !== null) {
    return await _ignoreFileStatOverrideForTesting(ignoreFilePath);
  }

  return stat(ignoreFilePath);
}

/** ignoreファイルのstat結果と、その取得直後の観測時刻を組にして返す。 */
async function statIgnoreFileWithObservedAt(
  ignoreFilePath: string,
): Promise<{ stats: Stats; observedAt: number }> {
  const stats = await statIgnoreFile(ignoreFilePath);
  return { stats, observedAt: getNow() };
}

/** 走査・再検証するディレクトリの状態を取得する。テストではstatを差し替えられる。 */
async function statWalkDirectory(directoryPath: string): Promise<Stats> {
  if (_walkDirectoryStatOverrideForTesting !== null) {
    return await _walkDirectoryStatOverrideForTesting(directoryPath);
  }

  return stat(directoryPath);
}

/** 走査ディレクトリのstat結果と、その取得直後の観測時刻を返す。 */
async function statWalkDirectoryWithObservedAt(
  directoryPath: string,
): Promise<{ stats: Stats; observedAt: number }> {
  const stats = await statWalkDirectory(directoryPath);
  return { stats, observedAt: getNow() };
}

/** 取得候補のstatを返す。失敗した候補は索引に保持しないようnullを返す。 */
async function statSnapshotFile(filePath: string): Promise<Stats | null> {
  try {
    return await stat(filePath);
  } catch {
    return null;
  }
}

/** ignore候補の存在・不在と、エラーで確定できない状態を区別する。 */
type IgnoreFilePresence = "present" | "absent" | "unknown";

/** ignore候補をstatし、不在と判明した場合だけ不在とする。権限エラーなどは不明のまま返す。 */
async function probeIgnoreFilePresence(
  ignoreFilePath: string,
): Promise<IgnoreFilePresence> {
  try {
    await statIgnoreFile(ignoreFilePath);
    return "present";
  } catch (error) {
    if (isAbsentIgnoreStatError(error)) {
      return "absent";
    }
    return "unknown";
  }
}

/** 再帰先と取得候補を判定できるよう、項目の種別付きでディレクトリを列挙する。 */
async function readWalkDirectoryEntries(
  directoryPath: string,
): Promise<Dirent[]> {
  if (_walkDirectoryReadOverrideForTesting !== null) {
    return await _walkDirectoryReadOverrideForTesting(directoryPath);
  }

  return readdir(directoryPath, { withFileTypes: true });
}

/** ignoreルールのテキストをUTF-8で読む。テストでは読み取り結果や失敗を差し替えられる。 */
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
 * - `EACCES`/`EPERM`/`ELOOP` などの安定失敗: "unreadable"
 * - それ以外: "race"（一時競合・不確定な失敗）
 *
 * 各試行の read 失敗は次の 2 種類に分類する:
 * - **stable unreadable**: `EACCES`/`EPERM`/`EISDIR` などの安定した読み取りエラー。
 *   即 return せず試行を継続し、`sawStableUnreadable` を立てる。
 * - **race-like failure**: before-stat 失敗 / 非 stable な read エラー /
 *   after-stat 失敗 / mtime・size 不一致。`sawRaceLikeFailure` を立てる。
 *
 * ループ終了後の判定:
 * - `sawStableUnreadable && !sawRaceLikeFailure` → "unreadable"（mtimeMs は最後の
 *   stable unreadable 試行の `statBefore.mtimeMs`）
 * - それ以外（race-like あり、または両フラグ未設定）→ "race"
 */
async function createIgnoreMatcher(
  baseDirectory: string,
  ignoreFilePath: string,
): Promise<CreateIgnoreMatcherResult> {
  // ファイルの存在確認: 不存在系だけ "absent"、安定失敗は "unreadable"、
  // それ以外は再検証可能な race として扱う。
  let firstStat: Stats;
  let firstObservedAt: number;
  try {
    const observed = await statIgnoreFileWithObservedAt(ignoreFilePath);
    firstStat = observed.stats;
    firstObservedAt = observed.observedAt;
  } catch (error) {
    if (isAbsentIgnoreStatError(error)) {
      return { kind: "absent" };
    }
    if (isStableIgnoreStatError(error)) {
      return { kind: "unreadable", mtimeMs: null, observedAt: null };
    }
    return { kind: "race" };
  }

  // 全試行を通じた状態追跡。
  let sawStableUnreadable = false;
  let sawRaceLikeFailure = false;
  let lastStableUnreadableMtimeMs: number | null = null;
  let lastStableUnreadableObservedAt: number | null = null;

  // 最大 3 回の試行（= 2 回再試行）。attempt 0 は firstStat を before-stat として再利用する。
  for (let attempt = 0; attempt < 3; attempt++) {
    let statBefore: Stats;
    let statBeforeObservedAt: number;
    try {
      if (attempt === 0) {
        statBefore = firstStat;
        statBeforeObservedAt = firstObservedAt;
      } else {
        const observed = await statIgnoreFileWithObservedAt(ignoreFilePath);
        statBefore = observed.stats;
        statBeforeObservedAt = observed.observedAt;
      }
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
        lastStableUnreadableObservedAt = statBeforeObservedAt;
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
      const statAfterObserved =
        await statIgnoreFileWithObservedAt(ignoreFilePath);
      const statAfter = statAfterObserved.stats;
      if (
        statBefore.mtimeMs === statAfter.mtimeMs &&
        statBefore.size === statAfter.size
      ) {
        // 前後の mtime と size が一致 → 読み取り内容が整合していると判断
        return {
          kind: "loaded",
          matcher: { baseDirectory, matcher: ignore().add(rules) },
          mtimeMs: statAfter.mtimeMs,
          size: statAfter.size,
          observedAt: statAfterObserved.observedAt,
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
  if (
    sawStableUnreadable &&
    !sawRaceLikeFailure &&
    lastStableUnreadableMtimeMs !== null &&
    lastStableUnreadableObservedAt !== null
  ) {
    return {
      kind: "unreadable",
      mtimeMs: lastStableUnreadableMtimeMs,
      observedAt: lastStableUnreadableObservedAt,
    };
  }

  // 全試行で競合したため諦める
  return { kind: "race" };
}

/** .gitの既定除外とルートまでのignoreルールを読み込み、再検証に必要な失敗・不在情報も集める。 */
async function loadInitialIgnoreMatchers(rootDirectory: string): Promise<{
  matchers: IgnoreMatcher[];
  loadedDirectories: Set<string>;
  ignoreFiles: Map<string, IgnoreFileState>;
  absentIgnoreCandidates: string[];
}> {
  const workspaceDirectory = path.resolve(rootDirectory);
  const gitRoot = await findGitRoot(workspaceDirectory);
  const ignoreSourceDirectories =
    await collectIgnoreSourceDirectories(workspaceDirectory);
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
    const matcher = applyIgnoreFileResult(
      result,
      directory,
      gitignorePath,
      loadedDirectories,
      ignoreFiles,
    );
    if (matcher !== null) {
      matchers.push(matcher);
    } else if (
      result.kind === "absent" &&
      !isInsideDirectory(directory, workspaceDirectory)
    ) {
      // workspace 外部のディレクトリ: visitedDirectories に含まれないため、
      // .gitignore の不在状態を明示的に記録して新規出現を検知できるようにする（P2 対策）
      absentIgnoreCandidates.push(gitignorePath);
    }
  }

  if (gitRoot) {
    const excludePath = path.join(gitRoot, ".git", "info", "exclude");
    const excludeResult = await createIgnoreMatcher(gitRoot, excludePath);
    // directory: null — exclude は per-directory の .gitignore ではないため loadedDirectories は更新しない
    const excludeMatcher = applyIgnoreFileResult(
      excludeResult,
      null,
      excludePath,
      loadedDirectories,
      ignoreFiles,
    );
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
        const parentGitignorePresence =
          await probeIgnoreFilePresence(parentGitignorePath);
        if (parentGitignorePresence === "present") {
          // この祖先に .gitignore が存在する → collectIgnoreSourceDirectories はここで停止する → 停止
          break;
        }
        if (parentGitignorePresence === "unknown") {
          // 権限エラーや race で存在確認が不確定な場合は absent 扱いしない。
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
    ignoreFiles.set(ignoreFilePath, {
      kind: "loaded",
      mtimeMs: result.mtimeMs,
      size: result.size,
      observedAt: result.observedAt,
    });
    return result.matcher;
  }
  if (result.kind === "unreadable") {
    ignoreFiles.set(ignoreFilePath, {
      kind: "unreadable",
      mtimeMs: result.mtimeMs,
      observedAt: result.observedAt,
    });
    return null;
  }
  if (result.kind === "race") {
    ignoreFiles.set(ignoreFilePath, { kind: "race" });
  }
  return null;
}

/** 相対パスの表記から同一または配下とみなせるか判定する。リンク先の実パスは解決しない。 */
function isInsideDirectory(targetPath: string, baseDirectory: string): boolean {
  const relativePath = path.relative(baseDirectory, targetPath);
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  );
}

/** ignore判定向けの相対パスを作り、ディレクトリの場合は末尾にスラッシュを付ける。 */
function toMatcherPath(
  baseDirectory: string,
  targetPath: string,
  directoryHint = false,
): string {
  const relativePath = path
    .relative(baseDirectory, targetPath)
    .replace(/\\/g, "/");
  return directoryHint ? `${relativePath}/` : relativePath;
}

/** 対象パスに適用できるルールを順に評価し、除外と除外解除の両方を反映する。 */
function isIgnoredByMatchers(
  targetPath: string,
  isDirectory: boolean,
  matchers: IgnoreMatcher[],
): boolean {
  let ignored = false;

  for (const entry of matchers) {
    if (!isInsideDirectory(targetPath, entry.baseDirectory)) {
      continue;
    }

    const result = entry.matcher.test(
      toMatcherPath(entry.baseDirectory, targetPath, isDirectory),
    );
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

/** 取得できた本文だけを返し、不在と取得見送りを区別しない呼び出し元にはnullを返す。 */
async function readSnapshotTextFile(
  filePath: string,
  maxFileBytes: number,
): Promise<string | null> {
  const result = await readSnapshotTextFileResult(filePath, maxFileBytes);
  return result.kind === "captured" ? result.text : null;
}

/** 取得した本文はUTF-8で返す。不在を別扱いにし、上限超過・NULを含む内容・その他の読み取り失敗は見送る。 */
async function readSnapshotTextFileResult(
  filePath: string,
  maxFileBytes: number,
): Promise<SnapshotFileReadResult> {
  try {
    const content = await readFile(filePath);
    if (content.byteLength > maxFileBytes || content.includes(0)) {
      return { kind: "skipped" };
    }

    return { kind: "captured", text: content.toString("utf8") };
  } catch (error) {
    const code = getNodeErrorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { kind: "missing" };
    }
    return { kind: "skipped" };
  }
}

/** 入力を絶対パスのルート一覧にし、順序を保って重複を除く。Windowsでは大文字小文字を区別しない。 */
function normalizeSnapshotRootDirectories(
  rootDirectory: string | readonly string[],
): string[] {
  return Array.from(
    new Map(
      (Array.isArray(rootDirectory) ? rootDirectory : [rootDirectory])
        .map((entry) => path.resolve(entry))
        .map(
          (entry) =>
            [
              process.platform === "win32" ? entry.toLowerCase() : entry,
              entry,
            ] as const,
        ),
    ).values(),
  );
}

/** 相対パスは主ルート、絶対パスは最初に該当するルートに割り当て、対象外ならnullを返す。 */
function resolveSnapshotFileTarget(
  rootDirectories: readonly string[],
  filePath: string,
): {
  absolutePath: string;
  relativePath: string;
  rootIndex: number;
} | null {
  if (!path.isAbsolute(filePath)) {
    const absolutePath = path.resolve(rootDirectories[0], filePath);
    if (!isInsideDirectory(absolutePath, rootDirectories[0])) {
      return null;
    }

    return {
      absolutePath,
      relativePath: path
        .relative(rootDirectories[0], absolutePath)
        .replace(/\\/g, "/"),
      rootIndex: 0,
    };
  }

  const absolutePath = path.resolve(filePath);
  const rootIndex = rootDirectories.findIndex((rootDirectory) =>
    isInsideDirectory(absolutePath, rootDirectory),
  );
  if (rootIndex < 0) {
    return null;
  }

  return {
    absolutePath,
    relativePath: path
      .relative(rootDirectories[rootIndex], absolutePath)
      .replace(/\\/g, "/"),
    rootIndex,
  };
}

/** 取得・除外件数と容量がゼロで、上限未到達の初期集計を作る。 */
function createEmptySnapshotCaptureStats(): SnapshotCaptureStats {
  return {
    capturedFiles: 0,
    capturedBytes: 0,
    skippedBinaryOrOversizeFiles: 0,
    skippedByLimitFiles: 0,
    hitFileCountLimit: false,
    hitTotalBytesLimit: false,
  };
}

/** 指定済みの上限は保持し、省略された項目だけを既定値で埋める。 */
function normalizeSnapshotLimits(
  limits: SnapshotLimits = {},
): Required<SnapshotLimits> {
  return {
    maxFileBytes: limits.maxFileBytes ?? DEFAULT_SNAPSHOT_MAX_FILE_BYTES,
    maxFileCount: limits.maxFileCount ?? DEFAULT_SNAPSHOT_MAX_FILE_COUNT,
    maxTotalBytes: limits.maxTotalBytes ?? DEFAULT_SNAPSHOT_MAX_TOTAL_BYTES,
  };
}

/** 索引が保持する本文マップと独立して変更できるコピーを作る。 */
function cloneWorkspaceSnapshot(
  snapshot: WorkspaceSnapshot,
): WorkspaceSnapshot {
  return new Map(snapshot);
}

/** 索引が保持する集計を共有しないよう、返却用のコピーを作る。 */
function cloneSnapshotCaptureStats(
  stats: SnapshotCaptureStats,
): SnapshotCaptureStats {
  return { ...stats };
}

/** 増分更新後の索引に残るファイルから、取得・見送り件数と本文容量を数え直す。 */
function buildSnapshotStatsFromFiles(
  files: Iterable<SnapshotIndexedFile>,
): SnapshotCaptureStats {
  const stats = createEmptySnapshotCaptureStats();

  for (const file of files) {
    if (file.state === "captured") {
      stats.capturedFiles += 1;
      stats.capturedBytes += file.capturedBytes;
    } else {
      stats.skippedBinaryOrOversizeFiles += 1;
    }
  }

  return stats;
}

/** 指定ファイルの判定に必要な、ルートの除外ルールと親ディレクトリまでの追加ルールを集める。 */
async function loadIgnoreMatchersForTarget(
  rootDirectory: string,
  absolutePath: string,
): Promise<IgnoreMatcher[]> {
  const workspaceDirectory = path.resolve(rootDirectory);
  const { matchers, loadedDirectories, ignoreFiles } =
    await loadInitialIgnoreMatchers(workspaceDirectory);
  const targetDirectory = path.dirname(absolutePath);
  const relativeTargetDirectory = path.relative(
    workspaceDirectory,
    targetDirectory,
  );
  const nestedDirectories: string[] = [];

  if (
    relativeTargetDirectory &&
    !relativeTargetDirectory.startsWith("..") &&
    !path.isAbsolute(relativeTargetDirectory)
  ) {
    const segments = relativeTargetDirectory.split(path.sep).filter(Boolean);
    let currentDirectory = workspaceDirectory;

    for (const segment of segments) {
      currentDirectory = path.join(currentDirectory, segment);
      nestedDirectories.push(currentDirectory);
    }
  }

  let activeMatchers = matchers;
  for (const directory of nestedDirectories) {
    if (loadedDirectories.has(directory)) {
      continue;
    }

    const gitignorePath = path.join(directory, ".gitignore");
    const result = await createIgnoreMatcher(directory, gitignorePath);
    const matcher = applyIgnoreFileResult(
      result,
      directory,
      gitignorePath,
      loadedDirectories,
      ignoreFiles,
    );
    if (matcher !== null) {
      activeMatchers = [...activeMatchers, matcher];
    }
  }

  return activeMatchers;
}

/** 除外されたディレクトリには入らず、採用した通常ファイルごとに処理を呼び、再検証情報を返す。 */
async function walkWorkspace(
  rootDirectory: string,
  onFile: (filePath: string, relativePath: string) => Promise<void>,
): Promise<SnapshotScanResult> {
  const workspaceDirectory = path.resolve(rootDirectory);
  const {
    matchers: initialMatchers,
    loadedDirectories,
    ignoreFiles,
    absentIgnoreCandidates,
  } = await loadInitialIgnoreMatchers(workspaceDirectory);
  const includedFiles: string[] = [];
  const ignoredFiles: string[] = [];
  const visitedDirectories = new Map<string, ObservedMtime>();
  const directoriesNeedingRescan = new Map<string, DirectoryRescanState>();

  /** 観測と列挙の失敗を再走査用に記録し、現在のignoreルールを引き継いで配下を走査する。 */
  async function walk(
    directory: string,
    activeMatchers: IgnoreMatcher[],
  ): Promise<void> {
    const relDir = path
      .relative(workspaceDirectory, directory)
      .replace(/\\/g, "/");
    let needsStatRetry = false;
    try {
      const dirObserved = await statWalkDirectoryWithObservedAt(directory);
      visitedDirectories.set(relDir, {
        mtimeMs: dirObserved.stats.mtimeMs,
        size: dirObserved.stats.size,
        observedAt: dirObserved.observedAt,
      });
    } catch {
      // stat だけ失敗しても readdir が成功すれば subtree 自体は index できている。
      // このケースは次回 TTL で mtime 監視を復旧したいため transient 扱いにする。
      needsStatRetry = true;
    }

    let entries;
    try {
      entries = await readWalkDirectoryEntries(directory);
    } catch (error) {
      directoriesNeedingRescan.set(relDir, classifyDirectoryRescanState(error));
      return;
    }

    if (needsStatRetry) {
      directoriesNeedingRescan.set(relDir, { kind: "transient" });
    }

    let nextMatchers = activeMatchers;
    if (!loadedDirectories.has(directory)) {
      const gitignorePath = path.join(directory, ".gitignore");
      const result = await createIgnoreMatcher(directory, gitignorePath);
      const matcher = applyIgnoreFileResult(
        result,
        directory,
        gitignorePath,
        loadedDirectories,
        ignoreFiles,
      );
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

      const relativePath = path
        .relative(workspaceDirectory, absolutePath)
        .replace(/\\/g, "/");
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

/** テキスト本文を取得せず、ルート配下のファイルの採否と走査で得た観測情報を返す。 */
export async function scanWorkspacePaths(
  rootDirectory: string,
): Promise<SnapshotScanResult> {
  return walkWorkspace(rootDirectory, async () => {
    // 処理なし。
  });
}

/** 各ルートを走査して、除外ルールと全ルート共通の上限を満たすテキスト本文を取得する。 */
export async function captureWorkspaceSnapshot(
  rootDirectory: string | readonly string[],
  limits: SnapshotLimits = {},
): Promise<SnapshotCaptureResult> {
  const normalizedLimits = normalizeSnapshotLimits(limits);
  const { maxFileBytes, maxFileCount, maxTotalBytes } = normalizedLimits;
  const rootDirectories = normalizeSnapshotRootDirectories(rootDirectory);
  const snapshot: WorkspaceSnapshot = new Map();
  const stats = createEmptySnapshotCaptureStats();

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

      snapshot.set(
        normalizeSnapshotKey(directory, relativePath, index === 0),
        text,
      );
      stats.capturedFiles += 1;
      stats.capturedBytes += nextBytes;
    });
  }

  return { snapshot, stats };
}

/** 各ルートの本文・集計に加え、増分更新で再利用する走査結果とファイル状態を保持する初期索引を作る。 */
export async function createWorkspaceSnapshotIndex(
  rootDirectory: string | readonly string[],
  limits: SnapshotLimits = {},
): Promise<WorkspaceSnapshotIndex> {
  const normalizedLimits = normalizeSnapshotLimits(limits);
  const rootDirectories = normalizeSnapshotRootDirectories(rootDirectory);
  const snapshot: WorkspaceSnapshot = new Map();
  const stats = createEmptySnapshotCaptureStats();
  const files = new Map<string, SnapshotIndexedFile>();
  const roots: SnapshotRootIndex[] = [];

  for (const [index, directory] of rootDirectories.entries()) {
    const scan = await walkWorkspace(
      directory,
      async (absolutePath, relativePath) => {
        const key = normalizeSnapshotKey(directory, relativePath, index === 0);
        const fileStats = await statSnapshotFile(absolutePath);
        if (fileStats === null || !fileStats.isFile()) {
          return;
        }

        if (stats.hitFileCountLimit || stats.hitTotalBytesLimit) {
          stats.skippedByLimitFiles += 1;
          return;
        }

        const result = await readSnapshotTextFileResult(
          absolutePath,
          normalizedLimits.maxFileBytes,
        );
        if (result.kind === "missing") {
          return;
        }
        if (result.kind === "skipped") {
          stats.skippedBinaryOrOversizeFiles += 1;
          files.set(key, {
            key,
            absolutePath,
            relativePath,
            rootIndex: index,
            mtimeMs: fileStats.mtimeMs,
            size: fileStats.size,
            state: "skipped",
            capturedBytes: 0,
          });
          return;
        }

        const nextBytes = Buffer.byteLength(result.text, "utf8");
        if (stats.capturedFiles >= normalizedLimits.maxFileCount) {
          stats.hitFileCountLimit = true;
          stats.skippedByLimitFiles += 1;
          return;
        }

        if (stats.capturedBytes + nextBytes > normalizedLimits.maxTotalBytes) {
          stats.hitTotalBytesLimit = true;
          stats.skippedByLimitFiles += 1;
          return;
        }

        snapshot.set(key, result.text);
        stats.capturedFiles += 1;
        stats.capturedBytes += nextBytes;
        files.set(key, {
          key,
          absolutePath,
          relativePath,
          rootIndex: index,
          mtimeMs: fileStats.mtimeMs,
          size: fileStats.size,
          state: "captured",
          capturedBytes: nextBytes,
        });
      },
    );
    roots.push({ directory, scan });
  }

  return {
    rootDirectories,
    limits: normalizedLimits,
    snapshot,
    stats,
    files,
    roots,
    version: 1,
  };
}

/** 読み込み済みルールの変更や以前はなかったルールの出現を調べ、状態を確認できない場合も再構築を求める。 */
async function hasIgnoreStateChanged(
  root: SnapshotRootIndex,
): Promise<boolean> {
  for (const [ignoreFilePath, state] of root.scan.ignoreFiles) {
    if (state.kind !== "loaded") {
      return true;
    }

    try {
      const current = await statIgnoreFile(ignoreFilePath);
      if (current.mtimeMs !== state.mtimeMs || current.size !== state.size) {
        return true;
      }
    } catch {
      return true;
    }
  }

  for (const candidatePath of root.scan.absentIgnoreCandidates) {
    const presence = await probeIgnoreFilePresence(candidatePath);
    if (presence !== "absent") {
      return true;
    }
  }

  return false;
}

/** 再走査が必要な記録、または前回と異なる・比較できないディレクトリ状態がないか調べる。 */
async function hasDirectoryStructureChanged(
  root: SnapshotRootIndex,
): Promise<boolean> {
  if (root.scan.directoriesNeedingRescan.size > 0) {
    return true;
  }

  for (const [relativePath, observed] of root.scan.visitedDirectories) {
    const directoryPath = relativePath
      ? path.join(root.directory, relativePath)
      : root.directory;
    try {
      const current = await statWalkDirectory(directoryPath);
      if (
        current.mtimeMs !== observed.mtimeMs ||
        current.size !== observed.size
      ) {
        return true;
      }
    } catch {
      return true;
    }
  }

  return false;
}

/** 指定ファイルを読み直して本文マップと索引を更新し、不在や通常ファイルでなくなった項目を取り除く。 */
async function refreshIndexedFile(
  file: SnapshotIndexedFile,
  snapshot: WorkspaceSnapshot,
  files: Map<string, SnapshotIndexedFile>,
  limits: Required<SnapshotLimits>,
): Promise<void> {
  const fileStats = await statSnapshotFile(file.absolutePath);
  if (fileStats === null || !fileStats.isFile()) {
    snapshot.delete(file.key);
    files.delete(file.key);
    return;
  }

  const result = await readSnapshotTextFileResult(
    file.absolutePath,
    limits.maxFileBytes,
  );
  if (result.kind === "missing") {
    snapshot.delete(file.key);
    files.delete(file.key);
    return;
  }
  if (result.kind === "skipped") {
    snapshot.delete(file.key);
    files.set(file.key, {
      ...file,
      mtimeMs: fileStats.mtimeMs,
      size: fileStats.size,
      state: "skipped",
      capturedBytes: 0,
    });
    return;
  }

  const capturedBytes = Buffer.byteLength(result.text, "utf8");
  snapshot.set(file.key, result.text);
  files.set(file.key, {
    ...file,
    mtimeMs: fileStats.mtimeMs,
    size: fileStats.size,
    state: "captured",
    capturedBytes,
  });
}

/** 候補パスをルートに割り当て、重複とignore対象を除いた増分更新用の項目に変換する。 */
async function resolveIndexTargets(
  index: WorkspaceSnapshotIndex,
  filePaths: readonly string[],
): Promise<SnapshotIndexedFile[]> {
  const targets: SnapshotIndexedFile[] = [];
  const seen = new Set<string>();

  for (const filePath of filePaths) {
    const target = resolveSnapshotFileTarget(index.rootDirectories, filePath);
    if (target === null) {
      continue;
    }

    const key = normalizeSnapshotKey(
      index.rootDirectories[target.rootIndex],
      target.relativePath,
      target.rootIndex === 0,
    );
    const dedupeKey =
      process.platform === "win32"
        ? target.absolutePath.toLowerCase()
        : target.absolutePath;
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);

    const ignoreMatchers = await loadIgnoreMatchersForTarget(
      index.rootDirectories[target.rootIndex],
      target.absolutePath,
    );
    if (isIgnoredByMatchers(target.absolutePath, false, ignoreMatchers)) {
      continue;
    }

    targets.push({
      key,
      absolutePath: target.absolutePath,
      relativePath: target.relativePath,
      rootIndex: target.rootIndex,
      mtimeMs: -1,
      size: -1,
      state: "captured",
      capturedBytes: 0,
    });
  }

  return targets;
}

/**
 * 前回の索引から候補か変更のあったファイルを更新する。ignoreの状態や上限に応じて全体を再構築し、
 * 候補を信頼する指定がない場合はディレクトリ構造の変化でも再構築する。
 */
export async function refreshWorkspaceSnapshotIndex(
  index: WorkspaceSnapshotIndex,
  options: {
    candidatePaths?: readonly string[];
    trustCandidatePaths?: boolean;
  } = {},
): Promise<WorkspaceSnapshotIndexRefreshResult> {
  if (index.stats.hitFileCountLimit || index.stats.hitTotalBytesLimit) {
    const rebuilt = await createWorkspaceSnapshotIndex(
      index.rootDirectories,
      index.limits,
    );
    return {
      index: rebuilt,
      snapshot: cloneWorkspaceSnapshot(rebuilt.snapshot),
      stats: cloneSnapshotCaptureStats(rebuilt.stats),
      usedFullRebuild: true,
      reason: "limit",
    };
  }

  for (const root of index.roots) {
    if (await hasIgnoreStateChanged(root)) {
      const rebuilt = await createWorkspaceSnapshotIndex(
        index.rootDirectories,
        index.limits,
      );
      return {
        index: rebuilt,
        snapshot: cloneWorkspaceSnapshot(rebuilt.snapshot),
        stats: cloneSnapshotCaptureStats(rebuilt.stats),
        usedFullRebuild: true,
        reason: "ignore-change",
      };
    }
  }

  if (!options.trustCandidatePaths) {
    for (const root of index.roots) {
      if (await hasDirectoryStructureChanged(root)) {
        const rebuilt = await createWorkspaceSnapshotIndex(
          index.rootDirectories,
          index.limits,
        );
        return {
          index: rebuilt,
          snapshot: cloneWorkspaceSnapshot(rebuilt.snapshot),
          stats: cloneSnapshotCaptureStats(rebuilt.stats),
          usedFullRebuild: true,
          reason: "structure-change",
        };
      }
    }
  }

  const snapshot = cloneWorkspaceSnapshot(index.snapshot);
  const files = new Map(index.files);
  const changedFiles: SnapshotIndexedFile[] = [];

  if (options.candidatePaths && options.candidatePaths.length > 0) {
    changedFiles.push(
      ...(await resolveIndexTargets(index, options.candidatePaths)),
    );
  } else {
    for (const file of index.files.values()) {
      const fileStats = await statSnapshotFile(file.absolutePath);
      if (fileStats === null || !fileStats.isFile()) {
        changedFiles.push(file);
        continue;
      }
      if (fileStats.mtimeMs !== file.mtimeMs || fileStats.size !== file.size) {
        changedFiles.push(file);
      }
    }
  }

  for (const file of changedFiles) {
    await refreshIndexedFile(file, snapshot, files, index.limits);
  }

  const stats = buildSnapshotStatsFromFiles(files.values());
  if (
    stats.capturedFiles > index.limits.maxFileCount ||
    stats.capturedBytes > index.limits.maxTotalBytes
  ) {
    const rebuilt = await createWorkspaceSnapshotIndex(
      index.rootDirectories,
      index.limits,
    );
    return {
      index: rebuilt,
      snapshot: cloneWorkspaceSnapshot(rebuilt.snapshot),
      stats: cloneSnapshotCaptureStats(rebuilt.stats),
      usedFullRebuild: true,
      reason: "limit",
    };
  }

  const nextIndex: WorkspaceSnapshotIndex = {
    ...index,
    snapshot,
    stats,
    files,
    version: index.version + 1,
  };

  return {
    index: nextIndex,
    snapshot: cloneWorkspaceSnapshot(snapshot),
    stats: cloneSnapshotCaptureStats(stats),
    usedFullRebuild: false,
    reason:
      changedFiles.length === 0
        ? "unchanged"
        : options.candidatePaths && options.candidatePaths.length > 0
          ? "candidate-refresh"
          : "file-refresh",
  };
}

/** 全体走査は行わず、指定された候補パスから除外ルールと取得上限を満たす本文だけを取得する。 */
export async function captureWorkspaceSnapshotPaths(
  rootDirectory: string | readonly string[],
  filePaths: readonly string[],
  limits: SnapshotLimits = {},
): Promise<SnapshotCaptureResult> {
  const maxFileBytes = limits.maxFileBytes ?? DEFAULT_SNAPSHOT_MAX_FILE_BYTES;
  const maxFileCount = limits.maxFileCount ?? DEFAULT_SNAPSHOT_MAX_FILE_COUNT;
  const maxTotalBytes =
    limits.maxTotalBytes ?? DEFAULT_SNAPSHOT_MAX_TOTAL_BYTES;
  const rootDirectories = normalizeSnapshotRootDirectories(rootDirectory);
  const snapshot: WorkspaceSnapshot = new Map();
  const stats = createEmptySnapshotCaptureStats();
  const targets = new Map<
    string,
    NonNullable<ReturnType<typeof resolveSnapshotFileTarget>>
  >();
  const ignoreMatcherCache = new Map<string, IgnoreMatcher[]>();

  for (const filePath of filePaths) {
    const target = resolveSnapshotFileTarget(rootDirectories, filePath);
    if (target === null) {
      continue;
    }

    const dedupeKey =
      process.platform === "win32"
        ? target.absolutePath.toLowerCase()
        : target.absolutePath;
    targets.set(dedupeKey, target);
  }

  for (const target of targets.values()) {
    if (stats.hitFileCountLimit || stats.hitTotalBytesLimit) {
      stats.skippedByLimitFiles += 1;
      continue;
    }

    const ignoreCacheKey = `${target.rootIndex}:${path.dirname(target.absolutePath)}`;
    let matchers = ignoreMatcherCache.get(ignoreCacheKey);
    if (!matchers) {
      matchers = await loadIgnoreMatchersForTarget(
        rootDirectories[target.rootIndex],
        target.absolutePath,
      );
      ignoreMatcherCache.set(ignoreCacheKey, matchers);
    }

    if (isIgnoredByMatchers(target.absolutePath, false, matchers)) {
      continue;
    }

    const result = await readSnapshotTextFileResult(
      target.absolutePath,
      maxFileBytes,
    );
    if (result.kind === "missing") {
      continue;
    }
    if (result.kind === "skipped") {
      stats.skippedBinaryOrOversizeFiles += 1;
      continue;
    }

    const nextBytes = Buffer.byteLength(result.text, "utf8");
    if (stats.capturedFiles >= maxFileCount) {
      stats.hitFileCountLimit = true;
      stats.skippedByLimitFiles += 1;
      continue;
    }

    if (stats.capturedBytes + nextBytes > maxTotalBytes) {
      stats.hitTotalBytesLimit = true;
      stats.skippedByLimitFiles += 1;
      continue;
    }

    snapshot.set(
      normalizeSnapshotKey(
        rootDirectories[target.rootIndex],
        target.relativePath,
        target.rootIndex === 0,
      ),
      result.text,
    );
    stats.capturedFiles += 1;
    stats.capturedBytes += nextBytes;
  }

  return { snapshot, stats };
}
