import { stat } from "node:fs/promises";
import path from "node:path";

import {
  scanWorkspacePaths,
  type DirectoryRescanState,
  type IgnoreFileState,
  type ObservedMtime,
} from "./snapshot-ignore.js";
import type { WorkspacePathCandidate, WorkspacePathCandidateKind } from "../src/workspace-path-candidate.js";

const DEFAULT_SEARCH_LIMIT = 20;
export const DEFAULT_WORKSPACE_FILE_INDEX_TTL_MS = 30_000;
export const DEFAULT_WORKSPACE_QUERY_CACHE_MAX_ENTRIES = 200;
export const DEFAULT_WORKSPACE_QUERY_CACHE_MAX_MATCHED_INDICES = 512;
export const DEFAULT_UNREADABLE_IGNORE_RETRY_INTERVAL_MS = DEFAULT_WORKSPACE_FILE_INDEX_TTL_MS * 10;
export const DEFAULT_PERSISTENT_DIRECTORY_RETRY_INTERVAL_MS = DEFAULT_UNREADABLE_IGNORE_RETRY_INTERVAL_MS;
export const DEFAULT_COARSE_MTIME_GUARD_MS = 2_000;

// ---------------------------------------------------------------------------
// テスト用時刻注入
// ---------------------------------------------------------------------------

let _nowFn: (() => number) | null = null;
let _queryCacheMaxEntriesOverride: number | null = null;
let _queryCacheMaxMatchedIndicesOverride: number | null = null;
let _statOverrideForTesting:
  | ((targetPath: string) => Promise<{ mtimeMs: number }> | { mtimeMs: number })
  | null = null;

/** テスト専用: Date.now() の差し替えを設定する。null で元に戻す。 */
export function _setNowOverrideForTesting(fn: (() => number) | null): void {
  _nowFn = fn;
}

/** テスト専用: 指定 workspace の現在の contentVersion を返す。index が存在しない場合は undefined。 */
export function _getContentVersionForTesting(workspacePath: string): number | undefined {
  const normalizedPath = path.resolve(workspacePath);
  return workspaceFileIndexCache.get(normalizedPath)?.contentVersion;
}

/** テスト専用: 指定 workspace の現在の validatedAt を返す。index が存在しない場合は undefined。 */
export function _getValidatedAtForTesting(workspacePath: string): number | undefined {
  const normalizedPath = path.resolve(workspacePath);
  return workspaceFileIndexCache.get(normalizedPath)?.validatedAt;
}

/** テスト専用: 指定 workspace の query cache key 順を返す。 */
export function _getQueryCacheKeysForTesting(workspacePath: string): string[] {
  const normalizedPath = path.resolve(workspacePath);
  return Array.from(workspaceQueryCache.get(normalizedPath)?.keys() ?? []);
}

/** テスト専用: 指定 workspace の query cache サイズを返す。 */
export function _getQueryCacheSizeForTesting(workspacePath: string): number {
  const normalizedPath = path.resolve(workspacePath);
  return workspaceQueryCache.get(normalizedPath)?.size ?? 0;
}

/** テスト専用: query cache 上限の差し替え。null で既定値へ戻す。 */
export function _setQueryCacheMaxEntriesForTesting(value: number | null): void {
  _queryCacheMaxEntriesOverride = value;
}

/** テスト専用: cache 対象とする matchedIndices 件数上限の差し替え。null で既定値へ戻す。 */
export function _setQueryCacheMaxMatchedIndicesForTesting(value: number | null): void {
  _queryCacheMaxMatchedIndicesOverride = value;
}

/** テスト専用: TTL 検証で使う stat を差し替える。 */
export function _setStatOverrideForTesting(
  fn: ((targetPath: string) => Promise<{ mtimeMs: number }> | { mtimeMs: number }) | null,
): void {
  _statOverrideForTesting = fn;
}

function getNow(): number {
  return _nowFn !== null ? _nowFn() : Date.now();
}

function getWorkspaceQueryCacheMaxEntries(): number {
  return Math.max(_queryCacheMaxEntriesOverride ?? DEFAULT_WORKSPACE_QUERY_CACHE_MAX_ENTRIES, 1);
}

function getWorkspaceQueryCacheMaxMatchedIndices(): number {
  return Math.max(_queryCacheMaxMatchedIndicesOverride ?? DEFAULT_WORKSPACE_QUERY_CACHE_MAX_MATCHED_INDICES, 1);
}

async function statPath(targetPath: string): Promise<{ mtimeMs: number }> {
  if (_statOverrideForTesting !== null) {
    return await _statOverrideForTesting(targetPath);
  }
  return stat(targetPath);
}

function getNodeErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }

  const { code } = error as { code?: unknown };
  return typeof code === "string" ? code : undefined;
}

function isAbsentStatError(error: unknown): boolean {
  const code = getNodeErrorCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

// ---------------------------------------------------------------------------
// 内部カウンター
// ---------------------------------------------------------------------------

/** 実際の再走査（entries 更新）ごとにインクリメントされる単調増加カウンター。 */
let _contentVersionCounter = 0;

// ---------------------------------------------------------------------------
// 内部型
// ---------------------------------------------------------------------------

type FileEntry = {
  relativePath: string;
  kind: WorkspacePathCandidateKind;
  /** relativePath を toLocaleLowerCase() した正規化済みパス */
  normalizedPath: string;
};

type WorkspaceFileIndex = {
  workspacePath: string;
  /** 前処理済みエントリー（正規化済みパス込み） */
  entries: FileEntry[];
  /**
   * scan 時に訪問した全ディレクトリの mtime 記録。
   * key: workspace root 相対パス（root = ""）、value: mtime とその観測時刻。
   * TTL 超過後の構造変更検知に使う。
   */
  visitedDirectories: Map<string, ObservedMtime>;
  /**
   * scan 中の directory stat / readdir 失敗一覧。
   * transient は次回 TTL 超過時、persistent は backoff 超過時に再走査する。
   */
  directoriesNeedingRescan: Map<string, DirectoryRescanState>;
  /**
   * scan 時に確認した ignore ファイルの絶対パス → 状態。
   * .gitignore / .git/info/exclude の再検証に使う。
   */
  ignoreFiles: Map<string, IgnoreFileState>;
  /**
   * scan 時に存在しなかった外部 ignore 候補の絶対パス一覧。
   * .git/info/exclude および workspace 外の親 .gitignore が対象。
   * TTL 超過後の checkStructureUnchanged() でこれらの新規出現を検知するために使う。
   */
  absentIgnoreCandidates: string[];
  /** scan 完了時刻。retry/backoff 判定の基点として使う。 */
  scannedAt: number;
  /** TTL の基点。構造変化なしで延命された場合も更新される。 */
  validatedAt: number;
  /**
   * 実際の再走査（entries 更新）ごとにインクリメントされるバージョントークン。
   * TTL のみの延命では変化しないため、query cache エントリーの有効性確認に使う。
   */
  contentVersion: number;
};

/** query cache の 1 エントリー。contentVersion が現 index と一致する間だけ有効。 */
type QueryCacheEntry = {
  matchedIndices: number[];
  contentVersion: number;
};

// ---------------------------------------------------------------------------
// キャッシュストア
// ---------------------------------------------------------------------------

const workspaceFileIndexCache = new Map<string, WorkspaceFileIndex>();

/**
 * workspacePath（正規化済み）→ normalizedQuery → QueryCacheEntry。
 * index が再構築されたタイミングで同時に破棄される recent cache。
 * workspace ごとに件数上限を持ち、古い query エントリーを排出する。
 */
const workspaceQueryCache = new Map<string, Map<string, QueryCacheEntry>>();

// ---------------------------------------------------------------------------
// ユーティリティ
// ---------------------------------------------------------------------------

export function isWorkspaceFileIndexFresh(index: WorkspaceFileIndex, now = getNow()): boolean {
  return now - index.validatedAt < DEFAULT_WORKSPACE_FILE_INDEX_TTL_MS;
}

function touchQueryCacheEntry(
  wqCache: Map<string, QueryCacheEntry>,
  query: string,
  entry: QueryCacheEntry,
): void {
  wqCache.delete(query);
  wqCache.set(query, entry);
}

function trimWorkspaceQueryCache(wqCache: Map<string, QueryCacheEntry>): void {
  const maxEntries = getWorkspaceQueryCacheMaxEntries();
  while (wqCache.size > maxEntries) {
    const oldestQuery = wqCache.keys().next().value;
    if (oldestQuery === undefined) {
      break;
    }
    wqCache.delete(oldestQuery);
  }
}

function cacheQueryResult(
  wqCache: Map<string, QueryCacheEntry>,
  query: string,
  entry: QueryCacheEntry,
): void {
  touchQueryCacheEntry(wqCache, query, entry);
  trimWorkspaceQueryCache(wqCache);
}

function getCachedQueryEntry(
  wqCache: Map<string, QueryCacheEntry>,
  query: string,
  contentVersion: number,
): QueryCacheEntry | undefined {
  const cached = wqCache.get(query);
  if (cached !== undefined && cached.contentVersion === contentVersion) {
    touchQueryCacheEntry(wqCache, query, cached);
    return cached;
  }
  return undefined;
}

function isWithinCoarseMtimeGuardWindow(recordedMtimeMs: number, observedAt: number): boolean {
  if (!Number.isInteger(recordedMtimeMs)) {
    return false;
  }
  if (recordedMtimeMs % 1_000 !== 0) {
    return false;
  }
  return Math.abs(observedAt - recordedMtimeMs) < DEFAULT_COARSE_MTIME_GUARD_MS;
}

/**
 * visitedDirectories の mtime、ignoreFiles の mtime、absentIgnoreCandidates の新規出現を
 * 現在のファイルシステムと照合する。
 * すべて一致・不変であれば true（変化なし）、1 つでも異なれば false（変化あり）を返す。
 */
async function checkStructureUnchanged(index: WorkspaceFileIndex, now = getNow()): Promise<boolean> {
  for (const directoryState of index.directoriesNeedingRescan.values()) {
    if (directoryState.kind === "transient") {
      return false;
    }
    if (now - index.scannedAt >= DEFAULT_PERSISTENT_DIRECTORY_RETRY_INTERVAL_MS) {
      // 恒常 failure は毎 TTL では再走査せず、一定間隔ごとにのみ再試行する。
      return false;
    }
  }
  for (const [relativeDir, directoryState] of index.visitedDirectories) {
    if (isWithinCoarseMtimeGuardWindow(directoryState.mtimeMs, directoryState.observedAt)) {
      // coarse mtime な FS では、scan と同一タイムスライス内の追加・削除を見逃し得る。
      // 直近 bucket の mtime は 1 回だけ保守的に再走査して stale index を解消する。
      return false;
    }
    const absoluteDir =
      relativeDir === "" ? index.workspacePath : path.join(index.workspacePath, relativeDir);
    try {
      const s = await statPath(absoluteDir);
      if (s.mtimeMs !== directoryState.mtimeMs) {
        return false;
      }
    } catch {
      return false;
    }
  }
  for (const [ignoreFilePath, ignoreFileState] of index.ignoreFiles) {
    if (ignoreFileState.kind === "race") {
      // race は「前回 scan で整合した版を取得できなかった」一時 failure。
      // 次の TTL 検証では必ず再走査して、競合解消後の安定版を取り直す。
      return false;
    }
    if (ignoreFileState.kind === "unreadable") {
      if (now - index.scannedAt >= DEFAULT_UNREADABLE_IGNORE_RETRY_INTERVAL_MS) {
        // stable unreadable は毎 TTL では再走査しないが、一定間隔ごとには再試行する。
        return false;
      }
      continue;
    }
    if (isWithinCoarseMtimeGuardWindow(ignoreFileState.mtimeMs, ignoreFileState.observedAt)) {
      // .gitignore 内容更新が coarse mtime の同一タイムスライスに入ると mtime 比較だけでは見逃す。
      return false;
    }
    try {
      const s = await statPath(ignoreFilePath);
      if (s.mtimeMs !== ignoreFileState.mtimeMs) {
        return false;
      }
    } catch {
      return false;
    }
  }
  // 前回 scan 時に存在しなかった外部 ignore 候補が新規出現していないか確認する（P2 対策）
  for (const candidatePath of index.absentIgnoreCandidates) {
    try {
      await statPath(candidatePath);
      // stat 成功 = ファイルが新規出現した → 構造変化あり
      return false;
    } catch (error) {
      if (isAbsentStatError(error)) {
        // 依然として存在しない → 変化なし、次の候補へ
        continue;
      }
      // 権限エラーやループなど、不存在以外は安全側に倒して再走査する
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// インデックス取得（メイン処理）
// ---------------------------------------------------------------------------

async function getWorkspaceFileIndex(workspacePath: string): Promise<WorkspaceFileIndex> {
  const normalizedWorkspacePath = path.resolve(workspacePath);
  const cached = workspaceFileIndexCache.get(normalizedWorkspacePath);
  const now = getNow();

  if (cached) {
    if (isWorkspaceFileIndexFresh(cached, now)) {
      return cached;
    }

    // TTL 超過: 訪問済みディレクトリと ignore ファイルの mtime で変化を確認
    const unchanged = await checkStructureUnchanged(cached, now);
    if (unchanged) {
      // 構造変化なし: check 完了後の時刻で validatedAt を更新してキャッシュを延命（再走査スキップ）
      // contentVersion は変えないため、既存の query cache エントリーは引き続き有効
      cached.validatedAt = getNow();
      return cached;
    }

    // 構造変化あり: query cache を破棄してから再走査
    workspaceQueryCache.delete(normalizedWorkspacePath);
  }

  const scanned = await scanWorkspacePaths(normalizedWorkspacePath);
  const entries: FileEntry[] = [
    ...Array.from(scanned.visitedDirectories.keys())
      .filter((relativePath) => relativePath.length > 0)
      .map((relativePath) => ({
        relativePath,
        kind: "folder" as const,
        normalizedPath: relativePath.toLocaleLowerCase(),
      })),
    ...scanned.includedFiles.map((relativePath) => ({
      relativePath,
      kind: "file" as const,
      normalizedPath: relativePath.toLocaleLowerCase(),
    })),
  ];

  // 走査完了後の時刻で scannedAt / validatedAt を記録する
  const scannedAt = getNow();
  const nextIndex: WorkspaceFileIndex = {
    workspacePath: normalizedWorkspacePath,
    entries,
    visitedDirectories: scanned.visitedDirectories,
    directoriesNeedingRescan: scanned.directoriesNeedingRescan,
    ignoreFiles: scanned.ignoreFiles,
    absentIgnoreCandidates: scanned.absentIgnoreCandidates,
    scannedAt,
    validatedAt: scannedAt,
    contentVersion: ++_contentVersionCounter,
  };

  workspaceFileIndexCache.set(normalizedWorkspacePath, nextIndex);
  return nextIndex;
}

// ---------------------------------------------------------------------------
// 検索ヘルパー
// ---------------------------------------------------------------------------

function searchEntries(entries: FileEntry[], normalizedQuery: string, candidateIndices?: number[]): number[] {
  const result: number[] = [];
  if (candidateIndices !== undefined) {
    for (const i of candidateIndices) {
      if (entries[i].normalizedPath.includes(normalizedQuery)) {
        result.push(i);
      }
    }
  } else {
    for (let i = 0; i < entries.length; i++) {
      if (entries[i].normalizedPath.includes(normalizedQuery)) {
        result.push(i);
      }
    }
  }
  return result;
}

/**
 * query のプレフィックスとしてキャッシュに存在する最長クエリを探し、
 * そのマッチ済みインデックスを返す。prefix narrowing の起点として使う。
 * contentVersion が一致するエントリーのみ有効と見なす。
 */
function findBestCachedBase(wqCache: Map<string, QueryCacheEntry>, query: string, contentVersion: number): number[] | undefined {
  for (let len = query.length - 1; len >= 1; len--) {
    const cached = getCachedQueryEntry(wqCache, query.slice(0, len), contentVersion);
    if (cached !== undefined) {
      return cached.matchedIndices;
    }
  }
  return undefined;
}

function shouldCacheMatchedIndices(matchedIndices: number[]): boolean {
  return matchedIndices.length <= getWorkspaceQueryCacheMaxMatchedIndices();
}

function sortAndSliceResults(
  entries: FileEntry[],
  matchedIndices: number[],
  normalizedQuery: string,
  limit: number,
  kindFilter?: WorkspacePathCandidateKind,
): WorkspacePathCandidate[] {
  return matchedIndices
    .map((i) => ({
      entry: entries[i],
      matchIndex: entries[i].normalizedPath.indexOf(normalizedQuery),
    }))
    .filter(({ entry }) => kindFilter === undefined || entry.kind === kindFilter)
    .sort((left, right) => {
      if (left.matchIndex !== right.matchIndex) {
        return left.matchIndex - right.matchIndex;
      }
      if (left.entry.relativePath.length !== right.entry.relativePath.length) {
        return left.entry.relativePath.length - right.entry.relativePath.length;
      }
      return left.entry.relativePath.localeCompare(right.entry.relativePath);
    })
    .slice(0, limit)
    .map(({ entry }) => ({
      path: entry.relativePath,
      kind: entry.kind,
    }));
}

// ---------------------------------------------------------------------------
// 公開 API
// ---------------------------------------------------------------------------

async function searchWorkspacePathCandidatesInternal(
  workspacePath: string,
  query: string,
  limit = DEFAULT_SEARCH_LIMIT,
  kindFilter?: WorkspacePathCandidateKind,
): Promise<WorkspacePathCandidate[]> {
  const normalizedQuery = query.trim().replace(/\\/g, "/").toLocaleLowerCase();
  if (!normalizedQuery) {
    return [];
  }

  const index = await getWorkspaceFileIndex(workspacePath);
  const normalizedWorkspacePath = path.resolve(workspacePath);

  let wqCache = workspaceQueryCache.get(normalizedWorkspacePath);
  if (wqCache === undefined) {
    wqCache = new Map();
    workspaceQueryCache.set(normalizedWorkspacePath, wqCache);
  }

  // キャッシュヒット: 同一クエリかつ contentVersion が一致すれば再計算をスキップ
  const exactCached = getCachedQueryEntry(wqCache, normalizedQuery, index.contentVersion);
  if (exactCached !== undefined) {
    return sortAndSliceResults(index.entries, exactCached.matchedIndices, normalizedQuery, limit, kindFilter);
  }

  // prefix narrowing: 最長キャッシュ済みプレフィックスを起点に絞り込む
  const baseIndices = findBestCachedBase(wqCache, normalizedQuery, index.contentVersion);
  const matchedIndices = searchEntries(index.entries, normalizedQuery, baseIndices);
  if (shouldCacheMatchedIndices(matchedIndices)) {
    cacheQueryResult(wqCache, normalizedQuery, { matchedIndices, contentVersion: index.contentVersion });
  }

  return sortAndSliceResults(index.entries, matchedIndices, normalizedQuery, limit, kindFilter);
}

export async function searchWorkspacePathCandidates(
  workspacePath: string,
  query: string,
  limit = DEFAULT_SEARCH_LIMIT,
): Promise<WorkspacePathCandidate[]> {
  return searchWorkspacePathCandidatesInternal(workspacePath, query, limit);
}

export async function searchWorkspaceFilePaths(
  workspacePath: string,
  query: string,
  limit = DEFAULT_SEARCH_LIMIT,
): Promise<string[]> {
  const candidates = await searchWorkspacePathCandidatesInternal(workspacePath, query, limit, "file");
  return candidates.map((candidate) => candidate.path);
}

export function clearWorkspaceFileIndex(workspacePath?: string): void {
  if (!workspacePath) {
    workspaceFileIndexCache.clear();
    workspaceQueryCache.clear();
    return;
  }

  const normalizedPath = path.resolve(workspacePath);
  workspaceFileIndexCache.delete(normalizedPath);
  workspaceQueryCache.delete(normalizedPath);
}
