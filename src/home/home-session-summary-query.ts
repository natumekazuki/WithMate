import type {
  HomeSessionSummary,
  HomeSessionSummaryPageResult,
} from "../../src-shared/session/session-state.js";
import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";

/** 開いている Session の要約を一要求にまとめる ID 件数の上限。 */
export const HOME_SESSION_SUMMARY_OPEN_ID_CHUNK_SIZE = 100;

/** 要約の取得結果と、そのページを読み始めるのに使ったカーソル。 */
export type HomeLoadedSessionSummaryPage = {
  requestCursor: string | null;
  page: HomeSessionSummaryPageResult;
};

/** 検索条件付きの最近・ピン留めページと、条件に依存しない開いている Session の要約。 */
export type HomeSessionSummaryPageCollection = {
  recent: HomeLoadedSessionSummaryPage[];
  pinned: HomeLoadedSessionSummaryPage[];
  open: HomeSessionSummary[];
};

/** Home の要約を用途別の範囲やカーソルで読む Window API。 */
export type HomeSessionSummaryQueryApi = Pick<
  WithMateWindowApi,
  "listSessionSummaryPage"
>;

/** ID の順序を保ち、要約要求の上限を超えない件数に分割する。 */
function chunkSessionIds(sessionIds: readonly string[]): string[][] {
  const chunks: string[][] = [];
  for (
    let index = 0;
    index < sessionIds.length;
    index += HOME_SESSION_SUMMARY_OPEN_ID_CHUNK_SIZE
  ) {
    chunks.push(
      sessionIds.slice(index, index + HOME_SESSION_SUMMARY_OPEN_ID_CHUNK_SIZE),
    );
  }
  return chunks;
}

/** 取得元ごとに順に走査し、同じ Session ID は最初に現れた要約だけを残す。 */
export function mergeSessionSummaryEntries(
  ...sources: readonly HomeSessionSummary[][]
): HomeSessionSummary[] {
  const seen = new Set<string>();
  const merged: HomeSessionSummary[] = [];
  for (const source of sources) {
    for (const summary of source) {
      if (seen.has(summary.id)) {
        continue;
      }
      seen.add(summary.id);
      merged.push(summary);
    }
  }
  return merged;
}

/** ピン留め・最近・開いている Session の順序で統合し、開いているものにはその取得元の要約を優先する。 */
export function buildHomeSessionSummaryEntries(
  pages: HomeSessionSummaryPageCollection,
): HomeSessionSummary[] {
  const openById = new Map(pages.open.map((summary) => [summary.id, summary]));
  return mergeSessionSummaryEntries(
    ...pages.pinned.map(({ page }) => page.entries),
    ...pages.recent.map(({ page }) => page.entries),
    pages.open,
  ).map((summary) => openById.get(summary.id) ?? summary);
}

/** 重複を除いた ID を上限ごとに読み、取得が現行でなくなった場合は次の要求を送らない。 */
export async function listOpenSessionSummaryEntries(
  api: HomeSessionSummaryQueryApi,
  openSessionIds: readonly string[],
  isCurrent: () => boolean = () => true,
): Promise<HomeSessionSummary[]> {
  const chunks = chunkSessionIds(Array.from(new Set(openSessionIds)));
  const entries: HomeSessionSummary[][] = [];
  for (const sessionIds of chunks) {
    if (!isCurrent()) break;
    const page = await api.listSessionSummaryPage({
      scope: "open",
      sessionIds,
      searchText: "",
    });
    entries.push(page.entries);
  }
  return mergeSessionSummaryEntries(...entries);
}

/** 指定された一覧と検索語で一ページを取り、先頭取得時はカーソルを送らない。 */
export async function fetchHomeSessionSummaryPage(
  api: HomeSessionSummaryQueryApi,
  scope: "recent" | "pinned",
  cursor: string | null,
  searchText: string,
): Promise<HomeSessionSummaryPageResult> {
  return api.listSessionSummaryPage({
    scope,
    ...(cursor ? { cursor } : {}),
    searchText,
  });
}

/** 先頭から取得済みのページ数を上限に再取得し、続きがない場合や世代が変わった場合は停止する。 */
export async function fetchHomeSessionSummaryPages(
  api: HomeSessionSummaryQueryApi,
  scope: "recent" | "pinned",
  searchText: string,
  loadedPageCount: number,
  isCurrent: () => boolean = () => true,
): Promise<HomeLoadedSessionSummaryPage[]> {
  const pageCount = Math.max(
    1,
    Math.floor(Number.isFinite(loadedPageCount) ? loadedPageCount : 1),
  );
  const pages: HomeLoadedSessionSummaryPage[] = [];
  let requestCursor: string | null = null;

  for (let index = 0; index < pageCount; index += 1) {
    if (!isCurrent()) break;
    const page = await fetchHomeSessionSummaryPage(
      api,
      scope,
      requestCursor,
      searchText,
    );
    pages.push({ requestCursor, page });
    if (!page.hasMore || !page.nextCursor) {
      break;
    }
    requestCursor = page.nextCursor;
  }

  return pages;
}
