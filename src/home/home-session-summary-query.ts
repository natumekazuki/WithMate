import type {
  SessionCharacterUsage,
  SessionSummary,
  SessionSummaryPageResult,
} from "../session-state.js";
import type { WithMateWindowApi } from "../withmate-window-api.js";

export const HOME_SESSION_SUMMARY_OPEN_ID_CHUNK_SIZE = 100;

export type HomeSessionSummarySnapshot = {
  recent: SessionSummaryPageResult;
  pinned: SessionSummaryPageResult;
  open: SessionSummary[];
  characterUsage: SessionCharacterUsage[];
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

export function mergeSessionSummaryEntries(...sources: readonly SessionSummary[][]): SessionSummary[] {
  const seen = new Set<string>();
  const merged: SessionSummary[] = [];
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

export async function listOpenSessionSummaryEntries(
  api: HomeSessionSummaryQueryApi,
  openSessionIds: readonly string[],
): Promise<SessionSummary[]> {
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
  cursor: string,
  searchText: string,
): Promise<SessionSummaryPageResult> {
  return api.listSessionSummaryPage({ scope, cursor, searchText });
}
