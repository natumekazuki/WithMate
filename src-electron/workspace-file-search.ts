import { stat } from "node:fs/promises";
import path from "node:path";

import { scanWorkspacePaths } from "./snapshot-ignore.js";

const DEFAULT_SEARCH_LIMIT = 20;
export const DEFAULT_WORKSPACE_FILE_INDEX_TTL_MS = 30_000;

// ---------------------------------------------------------------------------
// テスト用時刻注入
// ---------------------------------------------------------------------------

let _nowFn: (() => number) | null = null;

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

function getNow(): number {
  return _nowFn !== null ? _nowFn() : Date.now();
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
  /** relativePath を toLocaleLowerCase() した正規化済みパス */
  normalizedPath: string;
};

type WorkspaceFileIndex = {
  workspacePath: string;
  /** 前処理済みエントリー（正規化済みパス込み） */
  entries: FileEntry[];
  /**
   * scan 時に訪問した全ディレクトリの mtime 記録。
   * key: workspace root 相対パス（root = ""）、value: mtimeMs。
   * TTL 超過後の構造変更検知に使う。
   */
  visitedDirectories: Map<string, number>;
  /**
   * scan 時に読み込んだ ignore ファイルの絶対パス → mtimeMs。
   * .gitignore / .git/info/exclude の内容変更検知に使う。
   */
  ignoreFiles: Map<string, number>;
  /**
   * scan 時に存在しなかった外部 ignore 候補の絶対パス一覧。
   * .git/info/exclude および workspace 外の親 .gitignore が対象。
   * TTL 超過後の checkStructureUnchanged() でこれらの新規出現を検知するために使う。
   */
  absentIgnoreCandidates: string[];
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
 * index が再構築されたタイミングで同時に破棄される（メモリ効率）が、
 * contentVersion 検証により古い版のエントリーも安全に無視できる。
 */
const workspaceQueryCache = new Map<string, Map<string, QueryCacheEntry>>();

// ---------------------------------------------------------------------------
// ユーティリティ
// ---------------------------------------------------------------------------

export function isWorkspaceFileIndexFresh(index: WorkspaceFileIndex, now = getNow()): boolean {
  return now - index.validatedAt < DEFAULT_WORKSPACE_FILE_INDEX_TTL_MS;
}

/**
 * visitedDirectories の mtime、ignoreFiles の mtime、absentIgnoreCandidates の新規出現を
 * 現在のファイルシステムと照合する。
 * すべて一致・不変であれば true（変化なし）、1 つでも異なれば false（変化あり）を返す。
 */
async function checkStructureUnchanged(index: WorkspaceFileIndex): Promise<boolean> {
  for (const [relativeDir, cachedMtime] of index.visitedDirectories) {
    const absoluteDir =
      relativeDir === "" ? index.workspacePath : path.join(index.workspacePath, relativeDir);
    try {
      const s = await stat(absoluteDir);
      if (s.mtimeMs !== cachedMtime) {
        return false;
      }
    } catch {
      return false;
    }
  }
  for (const [ignoreFilePath, cachedMtime] of index.ignoreFiles) {
    try {
      const s = await stat(ignoreFilePath);
      if (s.mtimeMs !== cachedMtime) {
        return false;
      }
    } catch {
      return false;
    }
  }
  // 前回 scan 時に存在しなかった外部 ignore 候補が新規出現していないか確認する（P2 対策）
  for (const candidatePath of index.absentIgnoreCandidates) {
    try {
      await stat(candidatePath);
      // stat 成功 = ファイルが新規出現した → 構造変化あり
      return false;
    } catch {
      // 依然として存在しない → 変化なし、次の候補へ
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
    const unchanged = await checkStructureUnchanged(cached);
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
  const entries: FileEntry[] = scanned.includedFiles.map((relativePath) => ({
    relativePath,
    normalizedPath: relativePath.toLocaleLowerCase(),
  }));

  // 走査完了後の時刻で scannedAt / validatedAt を記録する
  const scannedAt = getNow();
  const nextIndex: WorkspaceFileIndex = {
    workspacePath: normalizedWorkspacePath,
    entries,
    visitedDirectories: scanned.visitedDirectories,
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
    const cached = wqCache.get(query.slice(0, len));
    if (cached !== undefined && cached.contentVersion === contentVersion) {
      return cached.matchedIndices;
    }
  }
  return undefined;
}

function sortAndSliceResults(
  entries: FileEntry[],
  matchedIndices: number[],
  normalizedQuery: string,
  limit: number,
): string[] {
  return matchedIndices
    .map((i) => ({
      entry: entries[i],
      matchIndex: entries[i].normalizedPath.indexOf(normalizedQuery),
    }))
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
    .map(({ entry }) => entry.relativePath);
}

// ---------------------------------------------------------------------------
// 公開 API
// ---------------------------------------------------------------------------

export async function searchWorkspaceFilePaths(workspacePath: string, query: string, limit = DEFAULT_SEARCH_LIMIT): Promise<string[]> {
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
  const exactCached = wqCache.get(normalizedQuery);
  if (exactCached !== undefined && exactCached.contentVersion === index.contentVersion) {
    return sortAndSliceResults(index.entries, exactCached.matchedIndices, normalizedQuery, limit);
  }

  // prefix narrowing: 最長キャッシュ済みプレフィックスを起点に絞り込む
  const baseIndices = findBestCachedBase(wqCache, normalizedQuery, index.contentVersion);
  const matchedIndices = searchEntries(index.entries, normalizedQuery, baseIndices);
  wqCache.set(normalizedQuery, { matchedIndices, contentVersion: index.contentVersion });

  return sortAndSliceResults(index.entries, matchedIndices, normalizedQuery, limit);
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