import type {
  HomeSessionSummary,
  SessionCharacterUsage,
  HomeSessionSummaryPageResult,
} from "../session-state.js";
import type { WithMateWindowApi } from "../withmate-window-api.js";

export const HOME_SESSION_SUMMARY_OPEN_ID_CHUNK_SIZE = 100;

export type HomeSessionSummarySnapshot = {
  recent: HomeSessionSummaryPageResult;
  pinned: HomeSessionSummaryPageResult;
  open: HomeSessionSummary[];
  characterUsage: SessionCharacterUsage[];
};

export type HomeLoadedSessionSummaryPage = {
  requestCursor: string | null;
  page: HomeSessionSummaryPageResult;
};

export type HomeSessionSummaryPageCollection = {
  recent: HomeLoadedSessionSummaryPage[];
  pinned: HomeLoadedSessionSummaryPage[];
  open: HomeSessionSummary[];
};

export type HomeSessionSummaryQueryApi = Pick<
  WithMateWindowApi,
  "listSessionSummaryPage" | "listSessionCharacterUsage"
>;

function chunkSessionIds(sessionIds: readonly string[]): string[][] {
  const chunks: string[][] = [];
  for (let index = 0; index < sessionIds.length; index += HOME_SESSION_SUMMARY_OPEN_ID_CHUNK_SIZE) {
    chunks.push(sessionIds.slice(index, index + HOME_SESSION_SUMMARY_OPEN_ID_CHUNK_SIZE));
  }
  return chunks;
}

export function mergeSessionSummaryEntries(...sources: readonly HomeSessionSummary[][]): HomeSessionSummary[] {
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

export function buildHomeSessionSummaryEntries(
  pages: HomeSessionSummaryPageCollection,
): HomeSessionSummary[] {
  return mergeSessionSummaryEntries(
    ...pages.pinned.map(({ page }) => page.entries),
    ...pages.recent.map(({ page }) => page.entries),
    pages.open,
  );
}

export async function listOpenSessionSummaryEntries(
  api: HomeSessionSummaryQueryApi,
  openSessionIds: readonly string[],
): Promise<HomeSessionSummary[]> {
  const chunks = chunkSessionIds(Array.from(new Set(openSessionIds)));
  if (chunks.length === 0) {
    return [];
  }

  const pages = await Promise.all(chunks.map((sessionIds) => api.listSessionSummaryPage({
    scope: "open",
    sessionIds,
    searchText: "",
  })));
  return mergeSessionSummaryEntries(...pages.map((page) => page.entries));
}

export async function fetchHomeSessionSummarySnapshot(
  api: HomeSessionSummaryQueryApi,
  searchText: string,
  openSessionIds: readonly string[],
  options: { includeCharacterUsage?: boolean } = {},
): Promise<HomeSessionSummarySnapshot> {
  const [recent, pinned, open, characterUsage] = await Promise.all([
    api.listSessionSummaryPage({ scope: "recent", searchText }),
    api.listSessionSummaryPage({ scope: "pinned", searchText }),
    listOpenSessionSummaryEntries(api, openSessionIds),
    options.includeCharacterUsage === false ? Promise.resolve([]) : api.listSessionCharacterUsage(),
  ]);
  return { recent, pinned, open, characterUsage };
}

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

export async function fetchHomeSessionSummaryPages(
  api: HomeSessionSummaryQueryApi,
  scope: "recent" | "pinned",
  searchText: string,
  loadedPageCount: number,
): Promise<HomeLoadedSessionSummaryPage[]> {
  const pageCount = Math.max(1, Math.floor(Number.isFinite(loadedPageCount) ? loadedPageCount : 1));
  const pages: HomeLoadedSessionSummaryPage[] = [];
  let requestCursor: string | null = null;

  for (let index = 0; index < pageCount; index += 1) {
    const page = await fetchHomeSessionSummaryPage(api, scope, requestCursor, searchText);
    pages.push({ requestCursor, page });
    if (!page.hasMore || !page.nextCursor) {
      break;
    }
    requestCursor = page.nextCursor;
  }

  return pages;
}
