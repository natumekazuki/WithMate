import { parentPort } from "node:worker_threads";
import { normalizeMessage } from "../../src-shared/session/session-state.js";
import { withMessageRunFailure } from "../../src-shared/session/message-run-failure.js";
import { projectMessagePlainText } from "../../src-shared/session/message-search.js";
import { createMessageSearchProjection, getMessageSearchMatchSourceRange, iterateMessageSearchMatches, messageSearchSourceRangesCorrespond, type MessageSearchProjection } from "../../src-shared/session/message-find.js";
import { CONVERSATION_QUERY_PAGE_SIZE, type ConversationNavigatorEntry, type ConversationSearchMatch, type ConversationSearchAnchor } from "../../src-shared/session/conversation-page.js";
import type { ConversationQueryRow } from "./conversation-query.js";

export type ConversationProjectionInput = {
  cacheScope: string;
  provider: string;
  rows: ConversationQueryRow[];
  query: { kind: "search"; query: string; mode: "source" | "preview" } | { kind: "navigator"; filter: "all" | "bookmarks" };
  offset: number;
  countBefore: number;
  anchor?: ConversationSearchAnchor;
};
export type ConversationProjectionResult = { count: number; items: Array<ConversationSearchMatch | ConversationNavigatorEntry>; anchorOrdinal?: number };

const cache = new Map<string, { value: string | MessageSearchProjection; bytes: number }>();
let cacheBytes = 0;
const MAX_CACHE_BYTES = 8 * 1024 * 1024;
function projection<T extends string | MessageSearchProjection>(key: string, create: () => T): T {
  const cached = cache.get(key);
  if (cached) {
    cache.delete(key);
    cache.set(key, cached);
    return cached.value as T;
  }
  const value = create();
  const bytes = 128 + 2 * key.length + (typeof value === "string" ? 2 * value.length
    : 2 * (value.sourceText.length + value.renderedText.length) + value.sourceRuns.length * 64);
  if (bytes <= MAX_CACHE_BYTES) {
    while (cacheBytes + bytes > MAX_CACHE_BYTES) {
      const oldest = cache.keys().next().value!;
      cacheBytes -= cache.get(oldest)!.bytes;
      cache.delete(oldest);
    }
    cache.set(key, { value, bytes });
    cacheBytes += bytes;
  }
  return value;
}

export function projectConversationBatch(input: ConversationProjectionInput): ConversationProjectionResult {
  let count = 0;
  let anchorOrdinal: number | undefined;
  const items: ConversationProjectionResult["items"] = [];
  const retain = (create: () => ConversationProjectionResult["items"][number]) => {
    const index = input.countBefore + count;
    if (index >= input.offset && index < input.offset + CONVERSATION_QUERY_PAGE_SIZE) items.push(create());
    count += 1;
  };
  for (const row of input.rows) {
    const normalized = normalizeMessage({ ...JSON.parse(row.body), role: row.role });
    if (!normalized) throw new Error(`Invalid conversation message: ${row.seq}`);
    const message = withMessageRunFailure(normalized, row.runFailure);
    const responseProvider = message.role === "assistant" ? input.provider : undefined;
    if (input.query.kind === "search") {
      const search = input.query.mode === "source" ? createMessageSearchProjection(message.text, responseProvider, "source")
        : projection(`${input.cacheScope}:${input.provider}:${row.seq}:search`, () => createMessageSearchProjection(message.text, responseProvider));
      let occurrenceIndex = 0;
      for (const match of iterateMessageSearchMatches(search, input.query.query, input.query.mode)) {
        if (input.anchor?.messageIndex === row.seq && anchorOrdinal === undefined) {
          const range = getMessageSearchMatchSourceRange(search, match);
          if (range && messageSearchSourceRangesCorrespond(range, input.anchor)) anchorOrdinal = input.countBefore + count;
        }
        const occurrence = occurrenceIndex++;
        retain(() => ({ messageIndex: row.seq, occurrenceIndex: occurrence }));
      }
    } else {
      if (message.role !== "user" && message.role !== "assistant") continue;
      if (input.query.filter === "bookmarks" && message.isBookmarked !== true) continue;
      retain(() => ({ messageIndex: row.seq, role: message.role,
        preview: projection(`${input.cacheScope}:${input.provider}:${row.seq}:plain`, () => projectMessagePlainText(message.text, responseProvider)),
        accent: message.accent === true, isBookmarked: message.isBookmarked === true }));
    }
  }
  return { count, items, ...(anchorOrdinal === undefined ? {} : { anchorOrdinal }) };
}

// This worker owns only CPU projections: no database or filesystem capability is imported.
parentPort?.on("message", (input: ConversationProjectionInput) => {
  try {
    parentPort!.postMessage({ result: projectConversationBatch(input) });
  } catch (error) {
    parentPort!.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
});
