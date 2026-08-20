import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchHomeSessionSummarySnapshot,
  mergeSessionSummaryEntries,
} from "../../src/home/home-session-summary-query.js";
import type { SessionSummary } from "../../src/session-state.js";

function summary(id: string): SessionSummary {
  return { id } as SessionSummary;
}

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
