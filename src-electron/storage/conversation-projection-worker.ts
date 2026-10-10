import { parentPort } from "node:worker_threads";
import { normalizeMessage } from "../../src-shared/session/session-state.js";
import { projectMessagePlainText, projectMessageRenderedSearchText } from "../../src-shared/session/message-search.js";
import { iterateTextMatches } from "../../src-shared/text/find-text-matches.js";
import { CONVERSATION_QUERY_PAGE_SIZE, type ConversationNavigatorEntry, type ConversationSearchMatch } from "../../src-shared/session/conversation-page.js";
import type { ConversationQueryRow } from "./conversation-query.js";

export type ConversationProjectionInput = {
  cacheScope: string;
  rows: ConversationQueryRow[];
  query: { kind: "search"; query: string; mode: "source" | "preview" } | { kind: "navigator"; filter: "all" | "bookmarks" };
  offset: number;
  countBefore: number;
};
export type ConversationProjectionResult = { count: number; items: Array<ConversationSearchMatch | ConversationNavigatorEntry> };

const cache = new Map<string, { value: string; bytes: number }>();
let cacheBytes = 0;
const MAX_CACHE_BYTES = 8 * 1024 * 1024;
function projection(key: string, create: () => string): string {
  const cached = cache.get(key);
  if (cached) {
    cache.delete(key);
    cache.set(key, cached);
    return cached.value;
  }
  const value = create();
  const bytes = 128 + 2 * (key.length + value.length);
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
  const items: ConversationProjectionResult["items"] = [];
  const retain = (create: () => ConversationProjectionResult["items"][number]) => {
    const index = input.countBefore + count;
    if (index >= input.offset && index < input.offset + CONVERSATION_QUERY_PAGE_SIZE) items.push(create());
    count += 1;
  };
  for (const row of input.rows) {
    const message = normalizeMessage({ ...JSON.parse(row.body), role: row.role });
    if (!message) throw new Error(`Invalid conversation message: ${row.seq}`);
    if (input.query.kind === "search") {
      const text = input.query.mode === "source" ? message.text
        : projection(`${input.cacheScope}:${row.seq}:rendered`, () => projectMessageRenderedSearchText(message.text));
      let occurrenceIndex = 0;
      for (const _match of iterateTextMatches(text, input.query.query)) {
        const occurrence = occurrenceIndex++;
        retain(() => ({ messageIndex: row.seq, occurrenceIndex: occurrence }));
      }
    } else {
      if (message.role !== "user" && message.role !== "assistant") continue;
      if (input.query.filter === "bookmarks" && message.isBookmarked !== true) continue;
      retain(() => ({ messageIndex: row.seq, role: message.role,
        preview: projection(`${input.cacheScope}:${row.seq}:plain`, () => projectMessagePlainText(message.text)),
        accent: message.accent === true, isBookmarked: message.isBookmarked === true }));
    }
  }
  return { count, items };
}

// This worker owns only CPU projections: no database or filesystem capability is imported.
parentPort?.on("message", (input: ConversationProjectionInput) => {
  try {
    parentPort!.postMessage({ result: projectConversationBatch(input) });
  } catch (error) {
    parentPort!.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
});
