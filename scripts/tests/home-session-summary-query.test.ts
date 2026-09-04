import assert from "node:assert/strict";
import test from "node:test";

import {
  buildHomeSessionSummaryEntries,
  fetchHomeSessionSummaryPages,
  fetchHomeSessionSummarySnapshot,
  mergeSessionSummaryEntries,
} from "../../src/home/home-session-summary-query.js";
import type { SessionSummary } from "../../src/session-state.js";

function summary(id: string): SessionSummary {
  return { id } as SessionSummary;
}

// @test-value v1
// kind = "contract"
// claim = "open Session summaryはIDを100件単位で取得し重複IDを一件へ統合する"
// oracle = { type = "contract", ref = "docs/features/home-session-pagination.md" }
// failure_mode = "IPC上限超過または重複Session cardを生成する"
// scope = "Home open Session summary query"
// lifecycle = "permanent"
// @end-test-value
test("Home summary query は open Session ID を100件ずつ取得し、重複を除く", async () => {
  const openRequests: string[][] = [];
  const openSearchTexts: Array<string | undefined> = [];
  const api = {
    listSessionSummaryPage: async (request?: {
      scope?: string;
      sessionIds?: readonly string[] | null;
      searchText?: string;
    }) => {
      if (request?.scope === "open") {
        const sessionIds = [...(request.sessionIds ?? [])];
        openRequests.push(sessionIds);
        openSearchTexts.push(request.searchText);
        return {
          entries: sessionIds.map((id) => summary(id)),
          nextCursor: null,
          hasMore: false,
        };
      }
      return {
        entries: [summary(request?.scope === "pinned" ? "pinned" : "recent")],
        nextCursor: null,
        hasMore: false,
      };
    },
    listSessionCharacterUsage: async () => [{ characterId: "char-1", sessionKind: "default" as const }],
  };
  const openSessionIds = Array.from({ length: 101 }, (_, index) => `session-${index}`);

  const snapshot = await fetchHomeSessionSummarySnapshot(api, "Task", openSessionIds);

  assert.deepEqual(openRequests.map((request) => request.length), [100, 1]);
  assert.deepEqual(openSearchTexts, ["", ""]);
  assert.equal(snapshot.open.length, 101);
  assert.deepEqual(snapshot.characterUsage, [{ characterId: "char-1", sessionKind: "default" }]);
});

test("Home summary merge は pinned を先に置き、Session IDでdedupeする", () => {
  assert.deepEqual(
    mergeSessionSummaryEntries([summary("pinned"), summary("shared")], [summary("recent"), summary("shared")]),
    [summary("pinned"), summary("shared"), summary("recent")],
  );
});

// @test-value v1
// kind = "invariant"
// claim = "background refreshは表示済みpage数に対応するcursor chainを先頭から再取得する"
// oracle = { type = "contract", ref = "docs/features/home-session-pagination.md" }
// failure_mode = "追加読込済みSessionがrefresh後に欠落する"
// scope = "Home Session background refresh pagination"
// lifecycle = "permanent"
// @end-test-value
test("Home summary background refresh はloaded page数ぶんcursor chainを再取得する", async () => {
  const requests: Array<string | undefined> = [];
  const api = {
    listSessionSummaryPage: async (request?: {
      scope?: string;
      cursor?: string | null;
      searchText?: string;
    }) => {
      if (request?.scope !== "recent") {
        return { entries: [], nextCursor: null, hasMore: false };
      }

      requests.push(request.cursor ?? undefined);
      const pageIndex = request.cursor === undefined ? 0 : Number(request.cursor.split("-")[1]);
      return {
        entries: [summary(`recent-${pageIndex}`)],
        nextCursor: pageIndex < 2 ? `cursor-${pageIndex + 1}` : null,
        hasMore: pageIndex < 2,
      };
    },
    listSessionCharacterUsage: async () => [],
  };

  const pages = await fetchHomeSessionSummaryPages(api, "recent", "", 3);

  assert.deepEqual(requests, [undefined, "cursor-1", "cursor-2"]);
  assert.deepEqual(pages.map(({ requestCursor, page }) => [requestCursor, page.entries[0]?.id]), [
    [null, "recent-0"],
    ["cursor-1", "recent-1"],
    ["cursor-2", "recent-2"],
  ]);
});

// @test-value v1
// kind = "contract"
// claim = "Home summary合成はpinned、recent、open-onlyの順で全表示対象を保持する"
// oracle = { type = "contract", ref = "docs/features/home-session-pagination.md" }
// failure_mode = "page間またはopen-only Sessionが一覧合成時に欠落する"
// scope = "Home Session summary collection projection"
// lifecycle = "permanent"
// @end-test-value
test("Home summary page collection はloaded recent/pinned pageとopen special entryを保持して表示順へ合成する", () => {
  const pages = {
    pinned: [
      { requestCursor: null, page: { entries: [summary("pinned-1")], nextCursor: "pinned-2", hasMore: true } },
      { requestCursor: "pinned-2", page: { entries: [summary("pinned-2")], nextCursor: null, hasMore: false } },
    ],
    recent: [
      { requestCursor: null, page: { entries: [summary("recent-1")], nextCursor: "recent-2", hasMore: true } },
      { requestCursor: "recent-2", page: { entries: [summary("recent-2")], nextCursor: null, hasMore: false } },
    ],
    open: [summary("open-not-in-page")],
  };

  assert.deepEqual(buildHomeSessionSummaryEntries(pages).map(({ id }) => id), [
    "pinned-1",
    "pinned-2",
    "recent-1",
    "recent-2",
    "open-not-in-page",
  ]);
});
